import { randomInt } from 'node:crypto';
import type { Database } from '@liame/database';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { ComoPedir, MotivoDaMensagem } from '../ai/crm/mensagem.js';
import { CRM } from '../ai/crm/prompt.js';
import { naTransacaoDaEmpresa } from '../ai/na-empresa.js';
import { funcionarioAtivo } from '../ai/registro/ativacao.js';
import { activeTraceId, writeAudit } from '../audit/audit.js';
import { pessoaPode } from '../auth/pessoa-pode.js';
import { APP_CONFIG, type AppConfig } from '../config.js';
import { contaConectada } from '../connections/conectada.js';
import { ClienteConector, ErroConector } from '../connectors/cliente-http.js';
import { enderecosDasPlataformas } from '../connectors/enderecos.js';
import { lerOrcamentoDeMensagens, lerPublicos } from '../connectors/regemcast/conector-regemcast.js';
import { currentTx } from '../context/request-context.js';
import { marcaDoCriativo } from '../criativo/base.js';
import { DATABASE } from '../database/database.module.js';
import { FlagService } from '../flags/flag.service.js';
import { lerContaDoRegemcast } from '../mensageria/conta-do-regemcast.js';
import { cupomDoDesconto, type DescontoGuardado } from '../mensageria/desconto.js';
import { FLAG_MENSAGERIA } from '../mensageria/mensageria.service.js';
import { FLAG_DO_CUPOM, FLAG_DO_ENVIO } from '../mensageria/pedido-de-mensagem.service.js';
import type { CupomDaMensagem } from '../mensageria/proposta-de-mensagem.js';
import { abrirProposta } from '../mensageria/proposta-do-crm.js';
import {
  codigoDoCupom,
  DIAS_PARA_REPETIR_A_OFERTA,
  fimDoIntervalo,
  LETRAS_DO_CODIGO,
  ofertaDaVez,
  passouOIntervalo,
  publicoDoMotivo,
  type ResultadoDoOlhar,
  tetoCheio,
} from '../mensageria/rotina-do-crm.js';
import { ResultsService } from '../results/results.service.js';
import { VaultService } from '../vault/vault.service.js';

// A rotina do funcionário de CRM e mensageria, primeiro passo: olhar uma marca e decidir se há uma mensagem a propor
// (A5, Y6; `plano-a5.md` D-A5-14; protótipo P16). Fica na pasta do worker: quem chama é o laço, em escopo de sistema.
// Daqui sai, no máximo, uma proposta em `preparando` (a fila `message_proposal`): nada é escrito por IA aqui, nada
// vai para o RegemCast e nenhuma mensagem sai. As regras de para quem, quando e com qual oferta são as de
// `mensageria/rotina-do-crm.ts`.
//
// Três tempos, para não segurar uma transação enquanto o RegemCast responde:
// 1. banco (transação curta da empresa): a marca, o funcionário, o que já existe, o desconto, o responsável, a conta
//    do RegemCast com o token, o dossiê e a oferta da vez;
// 2. RegemCast (sem transação): o teto de gasto de mensagens e quantas pessoas há em cada perfil;
// 3. banco (transação da empresa): o código do cupom e a proposta, com a auditoria.

/** A flag do funcionário de CRM e mensageria (migration 0061): nasce desligada para todos. */
export const FLAG_DO_CRM = 'crm';
const ROTULO_DO_CRM = 'CRM e mensageria';
/** Quem define o desconto das mensagens responde pelas propostas: é a permissão de quem define os limites da Verba do mês. */
const PODE_RESPONDER = 'orcamento.gerenciar';
/** A rotina tem este tempo para cada chamada ao RegemCast: ninguém espera na tela, mas uma marca não trava a fila. */
const TEMPO_DO_REGEMCAST_MS = 20_000;
/** Um código de cupom sorteado que já existe na loja é sorteado de novo; depois disto, algo está errado. */
const SORTEIOS_DO_CODIGO = 6;

/** As quatro chaves, na ordem em que são conferidas, e o que a olhada diz quando uma está desligada. */
const CHAVES: ReadonlyArray<readonly [string, ResultadoDoOlhar]> = [
  ['ia', 'ia_desligada'],
  [FLAG_DO_CRM, 'crm_desligado'],
  [FLAG_MENSAGERIA, 'mensageria_desligada'],
  [FLAG_DO_ENVIO, 'envio_desligado'],
];

export type AlvoDoOlhar = { tenantId: string; brandId: string; motivo: MotivoDaMensagem };
/** O que ele decidiu: o código, quando o intervalo acaba (só em `intervalo`) e a proposta aberta (só em `proposta_aberta`). */
export type Olhada = { resultado: ResultadoDoOlhar; ate?: Date; proposta?: string };

type Lido = {
  conta: { id: string; external_id: string };
  token: string;
  apiUrl: string;
  responsavel: string;
  desconto: DescontoGuardado;
  comoPedir: ComoPedir;
  oferta: { texto: string; versaoDoDossie: number } | null;
  /** O dia de hoje no fuso da marca (AAAA-MM-DD). */
  hoje: string;
};

type LinhaDoDesconto = {
  kind: DescontoGuardado['kind'];
  percent: number | null;
  value_cents: number | null;
  min_order_cents: number | null;
  valid_days: number;
  coupon_account_id: string;
  updated_by: string | null;
  loja_ligada: boolean;
  pode_criar: boolean;
  cardapio: string | null;
};

@Injectable()
export class RotinaDoCrmService {
  private readonly logger = new Logger('rotina-do-crm');

  constructor(
    @Inject(DATABASE) private readonly database: Database | null,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly flags: FlagService,
    private readonly vault: VaultService,
    private readonly resultados: ResultsService,
  ) {}

  /**
   * Olha uma marca, para um tipo de mensagem, e abre a proposta se há motivo. Devolve o que decidiu. O relógio
   * injetado vale para a operação inteira (V34). Erro fora do previsto sobe: quem chama registra e marca a olhada.
   */
  async olhar(alvo: AlvoDoOlhar, agora = new Date()): Promise<Olhada> {
    if (!this.database) throw new Error('rotina do CRM: sem banco');
    const database = this.database;
    const quem = { tenantId: alvo.tenantId, userId: null };

    // ---- 0. As chaves: com uma desligada, ele nem olha.
    const contexto = this.flags.context({ tenantId: alvo.tenantId, brandId: alvo.brandId });
    for (const [flag, resultado] of CHAVES) if (!(await this.flags.isEnabled(flag, contexto))) return { resultado };

    // ---- 1. O banco.
    const lido = await naTransacaoDaEmpresa<Lido | Olhada>(database, quem, () => this.ler(alvo, agora));
    if ('resultado' in lido) return lido;

    // ---- 2. O RegemCast: o teto de gasto de mensagens e os perfis, só com a contagem.
    const ctx = { cliente: this.cliente(database), apiUrl: lido.apiUrl };
    const acesso = { token: lido.token, contaChave: `rotina:${lido.conta.external_id}` };
    let publicos: Awaited<ReturnType<typeof lerPublicos>>;
    let orcamento: Awaited<ReturnType<typeof lerOrcamentoDeMensagens>>;
    try {
      [publicos, orcamento] = await Promise.all([lerPublicos(ctx, acesso), lerOrcamentoDeMensagens(ctx, acesso)]);
    } catch (err) {
      if (!(err instanceof ErroConector)) throw err;
      // O motivo fica no log (sem token e sem dado pessoal: a mensagem do conector traz só a ferramenta e o campo).
      this.logger.warn(`marca ${alvo.brandId}: o RegemCast não foi lido (conta ${lido.conta.id}): ${err.tipo}: ${err.message}`);
      return { resultado: err.tipo === 'autenticacao' ? 'sem_autorizacao' : err.tipo === 'permissao' ? 'sem_permissao' : 'regemcast_fora' };
    }
    if (tetoCheio(orcamento)) return { resultado: 'teto_cheio' };
    const publico = publicoDoMotivo(publicos, alvo.motivo);
    if (!publico) return { resultado: 'sem_publico' };

    // ---- 3. O banco: o código do cupom e a proposta, juntos.
    return naTransacaoDaEmpresa<Olhada>(database, quem, async () => {
      const tx = currentTx();
      const cupom = await this.cupomNovo(alvo, lido.desconto, lido.hoje);
      const id = await abrirProposta(tx, {
        tenantId: alvo.tenantId,
        brandId: alvo.brandId,
        conta: lido.conta.id,
        funcionario: CRM.key,
        emNomeDe: lido.responsavel,
        motivo: alvo.motivo,
        comoPedir: lido.comoPedir,
        oferta: lido.oferta,
        publico,
        cupom,
      });
      // Outra volta da rotina abriu a proposta deste tipo no meio: a marca tem uma de cada vez.
      if (!id) return { resultado: 'em_andamento' };
      await writeAudit(tx, {
        tenantId: alvo.tenantId,
        actorType: 'agent',
        actorId: null,
        actorLabel: ROTULO_DO_CRM,
        action: 'mensagem.preparar',
        resourceType: 'message_proposal',
        resourceId: id,
        // Só o que identifica a proposta e números: a oferta e o público ficam na proposta, não na trilha.
        after: {
          motive: alvo.motivo,
          destination: lido.comoPedir,
          dossier_version: lido.oferta?.versaoDoDossie ?? null,
          audience: publico.origem.id,
          people: publico.pessoas,
          coupon_code: cupom.codigo,
          agent_key: CRM.key,
          on_behalf_of: lido.responsavel,
        },
        traceId: activeTraceId(),
        origin: 'worker',
        agent: CRM.key,
      });
      return { resultado: 'proposta_aberta', proposta: id };
    });
  }

  /** O primeiro tempo: tudo o que o banco sabe. Devolve o que impede a proposta, ou o que os outros tempos usam. */
  private async ler(alvo: AlvoDoOlhar, agora: Date): Promise<Lido | Olhada> {
    const tx = currentTx();
    const { tenantId, brandId, motivo } = alvo;
    const marcaViva = await tx.execute(sql`select 1 from liame.brand where id = ${brandId} and tenant_id = ${tenantId} and archived_at is null`);
    if (!marcaViva.rows[0]) return { resultado: 'marca_arquivada' };
    if (!(await funcionarioAtivo(tx, { tenantId, brandId, agentKey: CRM.key, ativoPorPadrao: CRM.ativoPorPadrao }))) return { resultado: 'funcionario_desligado' };

    // O que já existe: uma proposta deste tipo no caminho, e quando a última nasceu (qualquer que tenha sido o fim).
    const jaFeito = (
      await tx.execute<{ em_andamento: boolean | null; ultima: Date | string | null }>(sql`
        select bool_or(status in ('preparando', 'rascunho')) as em_andamento, max(created_at) as ultima
          from liame.message_proposal
         where tenant_id = ${tenantId} and brand_id = ${brandId} and motive = ${motivo}`)
    ).rows[0];
    if (jaFeito?.em_andamento) return { resultado: 'em_andamento' };
    const ultima = jaFeito?.ultima ? new Date(jaFeito.ultima) : null;
    if (ultima && !passouOIntervalo(motivo, ultima, agora)) return { resultado: 'intervalo', ate: fimDoIntervalo(motivo, ultima) };

    // O desconto padrão do cupom e a loja do Regem onde o cupom nasce: a loja conectada (a que o Regem recusou não
    // recebe cupom; achado A2 do Hub DMS).
    const d = (
      await tx.execute<LinhaDoDesconto>(sql`
        select d.kind, d.percent, d.value_cents, d.min_order_cents, d.valid_days, d.coupon_account_id, d.updated_by,
               (a.id is not null) as loja_ligada,
               coalesce(a.provider_attributes -> 'escopos' @> '["cupons.criar"]'::jsonb, false) as pode_criar,
               a.provider_attributes ->> 'cardapio_url' as cardapio
          from liame.message_discount d
          left join liame.connected_account a
                 on a.id = d.coupon_account_id and a.tenant_id = d.tenant_id and a.brand_id = d.brand_id and a.provider = 'regem' and ${contaConectada('a')}
         where d.tenant_id = ${tenantId} and d.brand_id = ${brandId}`)
    ).rows[0];
    if (!d) return { resultado: 'sem_desconto' };
    // O cupom nasce junto com o envio, pela escrita no Regem: sem a loja, sem a permissão dela ou sem essa escrita
    // ligada, a mensagem com cupom nunca sairia.
    if (!d.loja_ligada || !d.pode_criar) return { resultado: 'sem_loja_do_cupom' };
    if (!(await this.flags.isEnabled(FLAG_DO_CUPOM, this.flags.context({ tenantId, brandId, accountId: d.coupon_account_id })))) return { resultado: 'sem_loja_do_cupom' };
    // Quem responde pela proposta: quem definiu o desconto, se segue na empresa e podendo defini-lo. O funcionário
    // nunca pode mais do que quem o deixou propor (ADR-017).
    if (!d.updated_by || !(await pessoaPode(tx, { tenantId, userId: d.updated_by, permissao: PODE_RESPONDER }))) return { resultado: 'sem_responsavel' };

    // A conta do RegemCast da marca, com o token do cofre. Uma marca tem, na prática, uma conta.
    const conta = await lerContaDoRegemcast(tx, this.vault, { tenantId, brandId });
    if (!conta) return { resultado: 'sem_regemcast' };
    if (!conta.token) return { resultado: 'sem_autorizacao' };
    // Sem poder gravar o rascunho do modelo, montar a campanha e pedir o disparo, a proposta pararia no meio (e a IA
    // já teria sido gasta no texto).
    if (!conta.escreve) return { resultado: 'sem_permissao' };
    const token = conta.token;
    const apiUrl = this.config.produtos.regemcastApiUrl;
    if (!apiUrl) return { resultado: 'regemcast_fora' };

    // Minha marca: o dossiê e, na promoção, a oferta da vez. O "volte a pedir" não leva oferta: o benefício é o cupom.
    const fuso = await this.resultados.fusoDaMarca(brandId);
    const marca = await marcaDoCriativo(brandId, fuso, agora);
    if (!marca) return { resultado: 'sem_dossie' };
    let oferta: Lido['oferta'] = null;
    if (motivo === 'promocao') {
      const usadas = (
        await tx.execute<{ offer: string; created_at: Date | string }>(sql`
          select offer, created_at from liame.message_proposal
           where tenant_id = ${tenantId} and brand_id = ${brandId} and offer is not null
             and created_at > ${agora.toISOString()}::timestamptz - make_interval(days => ${DIAS_PARA_REPETIR_A_OFERTA})`)
      ).rows.map((u) => ({ oferta: u.offer, em: new Date(u.created_at) }));
      const texto = ofertaDaVez(marca.conteudo.offers.items, usadas, agora);
      if (!texto) return { resultado: 'sem_oferta' };
      oferta = { texto, versaoDoDossie: marca.versao };
    }
    const hoje = (await tx.execute<{ dia: string }>(sql`select (${agora.toISOString()}::timestamptz at time zone ${fuso})::date::text as dia`)).rows[0]!.dia;
    const desconto: DescontoGuardado = { kind: d.kind, percent: d.percent, value_cents: d.value_cents, min_order_cents: d.min_order_cents, valid_days: d.valid_days, coupon_account_id: d.coupon_account_id };
    return { conta: { id: conta.id, external_id: conta.external_id }, token, apiUrl, responsavel: d.updated_by, desconto, comoPedir: d.cardapio ? 'cardapio' : 'whatsapp', oferta, hoje };
  }

  /**
   * O cupom da proposta: o desconto padrão, com um código sorteado que a loja ainda não tem (nem como cupom, nem em
   * outra mensagem, nem em outra proposta). As datas guardadas dizem por quantos dias ele vale; as de verdade são as
   * do dia do envio.
   */
  private async cupomNovo(alvo: AlvoDoOlhar, desconto: DescontoGuardado, hoje: string): Promise<CupomDaMensagem> {
    const tx = currentTx();
    const sorteio = () => randomInt(LETRAS_DO_CODIGO.length) / LETRAS_DO_CODIGO.length;
    for (let vez = 0; vez < SORTEIOS_DO_CODIGO; vez++) {
      const codigo = codigoDoCupom(alvo.motivo, sorteio);
      const existe = await tx.execute(sql`
        select 1 from liame.coupon where connected_account_id = ${desconto.coupon_account_id} and code = ${codigo}
        union all
        select 1 from liame.message_request where tenant_id = ${alvo.tenantId} and coupon_account_id = ${desconto.coupon_account_id} and coupon_code = ${codigo}
        union all
        select 1 from liame.message_proposal where tenant_id = ${alvo.tenantId} and coupon ->> 'loja' = ${desconto.coupon_account_id} and coupon ->> 'codigo' = ${codigo}
        limit 1`);
      if (!existe.rows[0]) return cupomDoDesconto(desconto, hoje, codigo);
    }
    throw new Error(`rotina do CRM: ${SORTEIOS_DO_CODIGO} códigos de cupom sorteados já existiam na loja`);
  }

  private cliente(database: Database): ClienteConector {
    return new ClienteConector(database.db, { enderecos: enderecosDasPlataformas(this.config.plataformas, this.config.produtos), tentativas: 1, tempoLimiteMs: TEMPO_DO_REGEMCAST_MS });
  }
}
