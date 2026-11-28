import type { ContentProductsResponse } from '@liame/contracts';
import { Injectable } from '@nestjs/common';
import { type SQL, sql } from 'drizzle-orm';
import { contaConectada } from '../connections/conectada.js';
import { type AuthContext, currentTx } from '../context/request-context.js';
import { AppProblem } from '../errors/problems.js';
import { FlagService } from '../flags/flag.service.js';
import { diaNoFuso } from '../results/fora-do-normal.js';
import { type Aparicoes, janelasDoRanking, type LinhaDoProduto, type LinhaSemCodigo, NOMES_SEM_CODIGO, type NomeDoProduto, rankingDeProdutos } from './produtos.js';

// O plano de conteúdo (`docs/plano-conteudo.md`, aprovado em 28/11/2026). PC4, parte 1: o ranking dos produtos do
// cardápio do Regem pelo código do produto (seção 6.2). Só leitura, na transação da requisição; a função
// `plano_conteudo` nasce desligada.

/** A função do plano de conteúdo (migration 0171): desligada até o dono ligar, por empresa. */
export const FLAG_DO_PLANO_DE_CONTEUDO = 'plano_conteudo';
/** Quantas legendas do Instagram e fotos de Fotos a procura dos produtos lê (a leitura do Instagram guarda até 50 hoje). */
const LEGENDAS_LIDAS = 300;
const FOTOS_LIDAS = 500;

function marcaNaoEncontrada(): AppProblem {
  return new AppProblem(404, 'nao-encontrado', 'Não encontramos', 'Marca não encontrada nesta empresa.');
}

function lojaNaoEncontrada(): AppProblem {
  return new AppProblem(404, 'nao-encontrado', 'Não encontramos', 'Loja não encontrada nesta marca.');
}

@Injectable()
export class ConteudoService {
  constructor(private readonly flags: FlagService) {}

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
    // cliente no fuso da loja (V34). O item sem código ganha o código pelo nome quando o nome só aparece com um código
    // na janela inteira (as duas janelas).
    const itens: SQL = sql`
      with itens as (
        select case when (coalesce(o.placed_at, o.confirmed_at) at time zone ${fuso})::date >= ${j.de}::date then 'atual' else 'anterior' end as janela,
               o.id as pedido, o.channel_group, i.product_external_id as codigo, i.name, i.quantity, i.revenue_micros, i.cost_micros
          from liame.order_item_fact i join liame.order_fact o on o.id = i.order_id
         where o.brand_id = ${brandId} ${daLoja} and o.status = 'confirmado' and i.removed_at is null
           and o.confirmed_at >= (${j.deAnterior}::date - 2)::timestamp at time zone ${fuso}
           and o.confirmed_at < (${j.ate}::date + 3)::timestamp at time zone ${fuso}
           and (coalesce(o.placed_at, o.confirmed_at) at time zone ${fuso})::date between ${j.deAnterior}::date and ${j.ate}::date
      ),
      mapa as (
        select name, min(codigo) as codigo from itens where codigo is not null group by name having count(distinct codigo) = 1
      ),
      efetivo as (
        select it.*, coalesce(it.codigo, m.codigo) as cod from itens it left join mapa m on it.codigo is null and m.name = it.name
      )`;
    const linhas = (
      await tx.execute<LinhaDoProduto>(sql`${itens}
        select janela, cod as codigo, count(distinct pedido)::int as pedidos, sum(quantity)::text as quantidade,
               sum(revenue_micros)::text as receita, sum(cost_micros)::text as custo, bool_and(cost_micros is not null) as custo_conhecido
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
}
