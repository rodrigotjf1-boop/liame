import type { ContentDatesQuery, ContentDatesResponse, ContentProductsResponse } from '@liame/contracts';
import type { Database } from '@liame/database';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { type SQL, sql } from 'drizzle-orm';
import { naTransacaoDaEmpresa } from '../ai/na-empresa.js';
import { APP_CONFIG, type AppConfig } from '../config.js';
import { contaConectada } from '../connections/conectada.js';
import { leitorDoPulso, type LeitorDoPulso } from '../connectors/dms/pulso.js';
import { type AuthContext, currentTx } from '../context/request-context.js';
import { DATABASE } from '../database/database.module.js';
import { AppProblem } from '../errors/problems.js';
import { FlagService } from '../flags/flag.service.js';
import { diasAntes } from '../regiao/demanda.js';
import { diaNoFuso } from '../results/fora-do-normal.js';
import { assuntosEmAlta, type DataComercial, datasDoPeriodo, DIAS_NO_PERIODO_MAXIMO } from './datas.js';
import { type Aparicoes, janelasDoRanking, type LinhaDoProduto, type LinhaSemCodigo, NOMES_SEM_CODIGO, type NomeDoProduto, rankingDeProdutos } from './produtos.js';

// O plano de conteúdo (`docs/plano-conteudo.md`, aprovado em 28/11/2026). PC4, parte 1: o ranking dos produtos do
// cardápio do Regem pelo código do produto (seção 6.2), só leitura, na transação da requisição. PC4, parte 2: as datas e
// as tendências do período (seção 6.3), com o calendário comercial do Liame e o Pulso (o banco numa transação curta, o
// Pulso sem transação aberta). A função `plano_conteudo` nasce desligada.

/** A função do plano de conteúdo (migration 0171): desligada até o dono ligar, por empresa. */
export const FLAG_DO_PLANO_DE_CONTEUDO = 'plano_conteudo';
/** Quantas legendas do Instagram e fotos de Fotos a procura dos produtos lê (a leitura do Instagram guarda até 50 hoje). */
const LEGENDAS_LIDAS = 300;
const FOTOS_LIDAS = 500;
/** Quantos nomes de produto o "combina com o seu cardápio" lê (os vendidos nos últimos 60 dias). */
const NOMES_DO_CARDAPIO = 500;
const DIA_MS = 24 * 60 * 60 * 1000;
/** O que o Pulso respondeu fica na memória do processo por uma hora (dado público, igual para todas as empresas). */
const MEMORIA_DO_PULSO_MS = 60 * 60 * 1000;
const MEMORIA_DO_PULSO_TETO = 500;

function marcaNaoEncontrada(): AppProblem {
  return new AppProblem(404, 'nao-encontrado', 'Não encontramos', 'Marca não encontrada nesta empresa.');
}

function lojaNaoEncontrada(): AppProblem {
  return new AppProblem(404, 'nao-encontrado', 'Não encontramos', 'Loja não encontrada nesta marca.');
}

function periodoInvalido(detalhe: string): AppProblem {
  return new AppProblem(422, 'periodo-invalido', 'Período fora do limite', detalhe);
}

/** Quantos dias de `de` até `ate` (conta de calendário). */
function diasEntre(de: string, ate: string): number {
  return Math.round((Date.parse(`${ate}T12:00:00Z`) - Date.parse(`${de}T12:00:00Z`)) / DIA_MS);
}

@Injectable()
export class ConteudoService {
  private readonly logger = new Logger('conteudo');
  private readonly memoria = new Map<string, { vence: number; valor: unknown }>();

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(DATABASE) private readonly database: Database | null,
    private readonly flags: FlagService,
  ) {}

  private banco(): Database {
    if (!this.database) throw new Error('conteúdo: sem banco');
    return this.database;
  }

  private quem(auth: AuthContext): { tenantId: string; userId: string } {
    if (!auth.tenantId) throw new AppProblem(403, 'sem-empresa-ativa', 'Escolha uma empresa', 'Selecione uma empresa com acesso ativo.');
    return { tenantId: auth.tenantId, userId: auth.userId };
  }

  private ligada(auth: AuthContext, brandId: string): Promise<boolean> {
    return this.flags.isEnabled(FLAG_DO_PLANO_DE_CONTEUDO, this.flags.context({ tenantId: auth.tenantId, userId: auth.userId, brandId }));
  }

  private async temRegem(brandId: string): Promise<boolean> {
    const r = await currentTx().execute<{ tem: boolean }>(sql`
      select exists (
        select 1 from liame.connected_account a where a.provider = 'regem' and a.brand_id = ${brandId} and ${contaConectada('a')}
      ) as tem`);
    return r.rows[0]?.tem === true;
  }

  /** O leitor do Pulso (nulo sem a ligação: desligado). Os testes trocam por um de mentira. */
  protected leitorDoPulso(): LeitorDoPulso | null {
    return leitorDoPulso(this.config);
  }

  /** O valor guardado por uma hora; a falha não fica guardada (a próxima pergunta tenta de novo). */
  private async lembrar<T>(chave: string, agora: Date, ler: () => Promise<T>): Promise<T> {
    const guardado = this.memoria.get(chave);
    if (guardado && guardado.vence > agora.getTime()) return guardado.valor as T;
    const valor = await ler();
    if (this.memoria.size >= MEMORIA_DO_PULSO_TETO) this.memoria.clear();
    this.memoria.set(chave, { vence: agora.getTime() + MEMORIA_DO_PULSO_MS, valor });
    return valor;
  }

  /**
   * O ranking dos produtos da marca (ou de uma loja dela) nas 4 semanas completas até ontem, contra as 4 antes. Sem a
   * função, sem o Regem ou sem `vendas.ver`, só a disponibilidade (o ranking nulo).
   */
  async produtos(auth: AuthContext, brandId: string, unitId: string | undefined, agora = new Date()): Promise<ContentProductsResponse> {
    this.quem(auth);
    const tx = currentTx();
    const marca = await tx.execute<{ id: string }>(sql`select id from liame.brand where id = ${brandId} and archived_at is null`);
    if (!marca.rows[0]) throw marcaNaoEncontrada();
    const loja = unitId
      ? (await tx.execute<{ timezone: string | null }>(sql`select timezone from liame.unit where id = ${unitId} and brand_id = ${brandId}`)).rows[0]
      : undefined;
    if (unitId && !loja) throw lojaNaoEncontrada();
    const base = { brand_id: brandId, unit_id: unitId ?? null, generated_at: agora.toISOString() };
    const vazio = (status: string): ContentProductsResponse => ({ ...base, availability: { status }, ranking: null });
    if (!(await this.ligada(auth, brandId))) return vazio('desligado_pela_liame');
    if (!auth.permissions.has('vendas.ver')) return vazio('sem_permissao');
    if (!(await this.temRegem(brandId))) return vazio('sem_regem');

    // O fuso da loja pedida; na marca inteira, o da primeira loja (as lojas de uma marca ficam no mesmo fuso).
    const fuso =
      loja?.timezone ??
      (await tx.execute<{ timezone: string | null }>(sql`select timezone from liame.unit where brand_id = ${brandId} order by created_at, id limit 1`)).rows[0]?.timezone ??
      'America/Sao_Paulo';
    const hoje = diaNoFuso(agora, fuso);
    const j = janelasDoRanking(hoje);
    const daLoja = unitId ? sql`and o.unit_id = ${unitId}` : sql``;
    // O índice (tenant_id, brand_id, confirmed_at) recorta pela confirmação, com folga; o dia exato é o do pedido do
    // cliente no fuso da loja (V34). Só o código do produto do Regem agrupa (D-PC-35): o item que chega sem ele fica fora
    // do ranking, só na contagem de "sem código", mesmo que o nome se pareça com o de um produto. O custo zero conta como
    // desconhecido: o Regem manda zero quando o produto não tem custo cadastrado (na Mister Burgers, 6.684 dos 6.855 itens
    // com custo em 28/11/2026), e a margem sairia 100% (ERR-250).
    const itens: SQL = sql`
      with efetivo as (
        select case when (coalesce(o.placed_at, o.confirmed_at) at time zone ${fuso})::date >= ${j.de}::date then 'atual' else 'anterior' end as janela,
               o.id as pedido, o.channel_group, i.product_external_id as cod, i.name, i.quantity, i.revenue_micros, i.cost_micros
          from liame.order_item_fact i join liame.order_fact o on o.id = i.order_id
         where o.brand_id = ${brandId} ${daLoja} and o.status = 'confirmado' and i.removed_at is null
           and o.confirmed_at >= (${j.deAnterior}::date - 2)::timestamp at time zone ${fuso}
           and o.confirmed_at < (${j.ate}::date + 3)::timestamp at time zone ${fuso}
           and (coalesce(o.placed_at, o.confirmed_at) at time zone ${fuso})::date between ${j.deAnterior}::date and ${j.ate}::date
      )`;
    const linhas = (
      await tx.execute<LinhaDoProduto>(sql`${itens}
        select janela, cod as codigo, count(distinct pedido)::int as pedidos, sum(quantity)::text as quantidade,
               sum(revenue_micros)::text as receita, sum(cost_micros)::text as custo, bool_and(coalesce(cost_micros, 0) > 0) as custo_conhecido
          from efetivo where cod is not null group by 1, 2`)
    ).rows;
    const nomes = (
      await tx.execute<NomeDoProduto>(sql`${itens}
        select cod as codigo, name as nome, channel_group = 'marketplace' as de_canal, count(*)::int as linhas
          from efetivo where cod is not null and janela = 'atual' group by 1, 2, 3`)
    ).rows;
    const semCodigo = (
      await tx.execute<LinhaSemCodigo>(sql`${itens}
        select name as nome, count(distinct pedido)::int as pedidos, sum(revenue_micros)::text as receita
          from efetivo where cod is null and janela = 'atual' group by 1 order by 2 desc, 1 limit ${NOMES_SEM_CODIGO}`)
    ).rows;
    const totalSemCodigo = (
      await tx.execute<{ pedidos: number; receita: string }>(sql`${itens}
        select count(distinct pedido)::int as pedidos, coalesce(sum(revenue_micros), 0)::text as receita from efetivo where cod is null and janela = 'atual'`)
    ).rows[0] ?? { pedidos: 0, receita: '0' };
    const pedidos =
      (
        await tx.execute<{ n: number }>(sql`
          select count(*)::int as n from liame.order_fact o
           where o.brand_id = ${brandId} ${daLoja} and o.status = 'confirmado'
             and o.confirmed_at >= (${j.de}::date - 2)::timestamp at time zone ${fuso}
             and o.confirmed_at < (${j.ate}::date + 3)::timestamp at time zone ${fuso}
             and (coalesce(o.placed_at, o.confirmed_at) at time zone ${fuso})::date between ${j.de}::date and ${j.ate}::date`)
      ).rows[0]?.n ?? 0;
    const aparicoes: Aparicoes = {
      legendas: (
        await tx.execute<{ texto: string; publicado_em: string }>(sql`
          select m.caption as texto, to_char(m.published_at at time zone ${fuso}, 'YYYY-MM-DD') as publicado_em
            from liame.instagram_media m
           where m.brand_id = ${brandId} and m.caption <> ''
           order by m.published_at desc limit ${LEGENDAS_LIDAS}`)
      ).rows,
      // As fotos de Fotos com o produto escrito: só informação (`seen.photos`), sem contar como aparição (D-PC-35: a foto
      // conta quando estiver etiquetada e tiver saído em post, o que vem com a biblioteca inteligente, PC3).
      fotos: (
        await tx.execute<{ texto: string }>(sql`
          select concat_ws(' ', p.product, p.description) as texto
            from liame.brand_photo p
           where p.brand_id = ${brandId} and p.removed_at is null and (p.product is not null or p.description <> '')
           order by p.created_at desc limit ${FOTOS_LIDAS}`)
      ).rows,
    };
    return { ...base, availability: { status: 'disponivel' }, ranking: rankingDeProdutos(linhas, nomes, semCodigo, totalSemCodigo, pedidos, aparicoes, hoje) };
  }

  /**
   * As datas e as tendências do período para o plano (PC4, parte 2). O banco numa transação curta (a marca, a função, a
   * loja e o município, o calendário comercial e os nomes do cardápio); o Pulso depois, sem transação aberta. Sem o Pulso
   * (desligado, sem município ou fora do ar), as datas do Liame valem e `pulse_status` diz por quê.
   */
  async datas(auth: AuthContext, q: ContentDatesQuery, agora = new Date()): Promise<ContentDatesResponse> {
    const lido = await naTransacaoDaEmpresa(this.banco(), this.quem(auth), async () => {
      const tx = currentTx();
      const marca = await tx.execute<{ id: string }>(sql`select id from liame.brand where id = ${q.brand_id} and archived_at is null`);
      if (!marca.rows[0]) throw marcaNaoEncontrada();
      const loja = (
        await tx.execute<{ timezone: string | null; ibge_city_code: string | null; address_city: string | null; address_state: string | null }>(sql`
          select timezone, ibge_city_code, address_city, address_state from liame.unit
           where brand_id = ${q.brand_id} ${q.unit_id ? sql`and id = ${q.unit_id}` : sql``}
           order by (ibge_city_code is null), created_at, id limit 1`)
      ).rows[0];
      if (q.unit_id && !loja) throw lojaNaoEncontrada();
      const hoje = diaNoFuso(agora, loja?.timezone ?? 'America/Sao_Paulo');
      const de = q.from ?? hoje;
      const ate = q.to ?? diasAntes(de, -30);
      if (ate < de) throw periodoInvalido('O último dia não pode ser antes do primeiro.');
      if (diasEntre(de, ate) + 1 > DIAS_NO_PERIODO_MAXIMO) throw periodoInvalido(`O período vai até ${DIAS_NO_PERIODO_MAXIMO} dias.`);
      const ligada = await this.ligada(auth, q.brand_id);
      if (!ligada) return { ligada, loja, de, ate, comerciais: [] as DataComercial[], cardapio: '' };
      const comerciais = (
        await tx.execute<DataComercial>(sql`
          select to_char(day, 'YYYY-MM-DD') as day, name, kind, source from liame.commercial_date
           where day between ${de}::date and ${ate}::date order by day, name`)
      ).rows;
      // O cardápio do "combina com o seu cardápio": os nomes vendidos nos últimos 60 dias e a parte Produtos de Minha marca.
      const nomes = (
        await tx.execute<{ name: string }>(sql`
          select distinct i.name from liame.order_item_fact i join liame.order_fact o on o.id = i.order_id
           where o.brand_id = ${q.brand_id} and o.status = 'confirmado' and i.removed_at is null
             and o.confirmed_at >= ${new Date(agora.getTime() - 60 * DIA_MS)}
           limit ${NOMES_DO_CARDAPIO}`)
      ).rows.map((r) => r.name);
      const produtosDaMarca = (
        await tx.execute<{ produtos: unknown }>(sql`
          select content -> 'produtos' as produtos from liame.brand_dossier_version where brand_id = ${q.brand_id} order by version desc limit 1`)
      ).rows[0]?.produtos;
      return { ligada, loja, de, ate, comerciais, cardapio: [...nomes, JSON.stringify(produtosDaMarca ?? '')].join(' \n ') };
    });

    const base = { brand_id: q.brand_id, unit_id: q.unit_id ?? null, from: lido.de, to: lido.ate, generated_at: agora.toISOString() };
    const municipio = lido.loja?.ibge_city_code ?? null;
    const municipality = municipio ? { ibge_code: municipio, name: lido.loja?.address_city ?? null, state: lido.loja?.address_state ?? null } : null;
    if (!lido.ligada) return { ...base, availability: { status: 'desligado_pela_liame' }, municipality, pulse_status: 'desligado', dates: [], trends: [] };
    const sohDoLiame = (pulse_status: string): ContentDatesResponse => ({
      ...base,
      availability: { status: 'disponivel' },
      municipality,
      pulse_status,
      dates: datasDoPeriodo(lido.comerciais, [], lido.de, lido.ate, lido.cardapio),
      trends: [],
    });
    const leitor = this.leitorDoPulso();
    if (!leitor) return sohDoLiame('desligado');
    if (!municipio) return sohDoLiame('sem_municipio');
    try {
      const [eventos, assuntos] = await Promise.all([
        this.lembrar(`eventos|${municipio}|${lido.de}|${lido.ate}`, agora, () => leitor.eventos(municipio, lido.de, lido.ate)),
        this.lembrar(`em-alta|${municipio}`, agora, () => leitor.emAlta(municipio)),
      ]);
      return {
        ...base,
        availability: { status: 'disponivel' },
        municipality,
        pulse_status: 'em_dia',
        dates: datasDoPeriodo(lido.comerciais, eventos, lido.de, lido.ate, lido.cardapio),
        trends: assuntosEmAlta(assuntos),
      };
    } catch (e) {
      this.logger.warn(`pulso: a leitura falhou (${e instanceof Error ? e.message : String(e)})`);
      return sohDoLiame('falhou');
    }
  }
}
