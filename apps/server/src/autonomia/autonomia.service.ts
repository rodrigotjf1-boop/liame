import {
  type AutonomyItem,
  type AutonomyMode,
  type AutonomyProposalSummary,
  type AutonomyResponse,
  type RejectAutonomyRequest,
  SHADOW_TOOLS,
  type UndoAutonomyRequest,
} from '@liame/contracts';
import type { Tx } from '@liame/database';
import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { CONNECTORS } from '../actions/connectors.js';
import { motivoSemDadoPessoal } from '../ai/sanitizar.js';
import { type AuthContext, auditDetail, currentTx } from '../context/request-context.js';
import { AppProblem } from '../errors/problems.js';
import { FlagService } from '../flags/flag.service.js';
import type { PolicySource } from '../policy/engine.js';
import { PolicyService } from '../policy/policy.service.js';
import {
  ACAO_DA_FERRAMENTA,
  AMOSTRA_DEPOIS_DA_RECUSA,
  LIMIARES_DA_AUTONOMIA,
  modoDaAcao,
  PEDIDOS_DEPOIS_DA_RECUSA,
  portoesQuePassaram,
  prontidaoDaAprovacao,
  umPassoAtras,
} from '../sombra/autonomia.js';
import type { AcaoSombra } from '../sombra/regras.js';
import { chaveDoPar, pedidosDecididos } from './pedidos-decididos.js';

// Autonomia por conta e ação (A3, I13; protótipo P7, aguardando aprovação; sem tela ainda). Na requisição, sob a RLS
// da empresa. Ver mostra, por conta e ação com sombra registrada, o modo (pelo motor de políticas), o último retrato
// da prontidão e a proposta. Aprovar e voltar um passo publicam a versão seguinte da política da marca; recusar só
// fecha a proposta. Nada é executado em plataforma nenhuma.
//
// Desde a A4 (X3) são dois passos: de Sombra para Sugerir (os cinco portões da sombra) e de Sugerir para Aprovação (os
// mesmos cinco e os dos pedidos que nasceram de recomendação; propostas D-A4-25 e D-A4-27). O segundo só existe para a
// empresa com a flag `modo_aprovacao`, numa plataforma que o Liame escreve e com a escrita ligada para a conta.

const NOME_DA_POLITICA: Record<PolicySource, string> = { platform: 'plataforma', tenant: 'empresa', brand: 'marca' };
const ORDEM_DA_ACAO = new Map<string, number>(SHADOW_TOOLS.map((t, i) => [t, i]));

type Linha = {
  connected_account_id: string;
  tool: AcaoSombra;
  provider: string;
  account_name: string;
  computed_on: string | null;
  rule_version: number | null;
  sample_size: number | null;
  agreement_pct: string | null;
  worse_pct: string | null;
  regret: string | null;
  confidence_pct: string | null;
  missing: string[] | null;
};

/** A proposta mais recente de um passo, numa conta e ação, com o nome de quem decidiu e de quem desfez. */
type LinhaDaProposta = {
  connected_account_id: string;
  tool: string;
  id: string;
  status: string;
  sample_size: number;
  created_at: Date | string;
  decided_by: string | null;
  decider: string | null;
  decided_at: Date | string | null;
  policy_version: number | null;
  undone_by: string | null;
  undoer: string | null;
  undone_at: Date | string | null;
  reason: string | null;
  next_sample_size: number | null;
  next_request_count: number | null;
  from_mode: AutonomyMode;
  to_mode: AutonomyMode;
};
/** As duas propostas possíveis de uma conta e ação: a do passo para Sugerir e a do passo para Aprovação. */
type PropostasDoPar = { sugerir?: LinhaDaProposta; aprovacao?: LinhaDaProposta };

type Proposta = {
  id: string;
  brand_id: string;
  connected_account_id: string;
  tool: AcaoSombra;
  action: string;
  status: string;
  sample_size: number;
  from_mode: 'SHADOW' | 'SUGGEST';
  to_mode: 'SUGGEST' | 'APPROVAL';
};

type Aprovacao = NonNullable<AutonomyItem['approval']>;

/** O nome de cada modo na frase de um problema. */
const NOME_DO_MODO: Record<string, string> = { SHADOW: 'Sombra', SUGGEST: 'Sugerir', APPROVAL: 'Aprovação' };

const iso = (v: Date | string | null) => (v === null ? null : new Date(v).toISOString());
const quem = (id: string | null, nome: string | null) => (id ? { id, name: nome ?? 'Pessoa removida' } : null);

@Injectable()
export class AutonomiaService {
  constructor(
    private readonly policies: PolicyService,
    private readonly flags: FlagService,
  ) {}

  async ver(auth: AuthContext, brandId: string): Promise<AutonomyResponse> {
    const tenantId = this.empresa(auth);
    await this.exigirMarca(brandId);
    return {
      brand_id: brandId,
      items: await this.itens(tenantId, brandId),
      thresholds: LIMIARES_DA_AUTONOMIA,
      can_decide: auth.permissions.has('politicas.gerenciar'),
      generated_at: new Date().toISOString(),
    };
  }

  /**
   * Aprova a promoção, no passo da proposta (de Sombra para Sugerir, ou de Sugerir para Aprovação): confere que ela
   * segue pendente, a conta conectada, os portões passando e a ação no modo de onde a proposta sai; publica a versão
   * seguinte da política da marca com a ação no modo novo e confere que o motor passou a dizer isso (uma regra mais
   * específica, ou um ESCALATE, venceria). No passo para a Aprovação, o modo precisa estar ligado para a empresa e
   * disponível na conta, e os portões dos pedidos são conferidos de novo.
   */
  async aprovar(auth: AuthContext, id: string): Promise<AutonomyItem> {
    const tenantId = this.empresa(auth);
    const tx = currentTx();
    const p = await this.pendente(tx, id);
    const conta = await this.conta(tx, p.connected_account_id);
    const retrato = await this.ultimoRetrato(tx, p.connected_account_id, p.tool);
    if (!retrato || retrato.missing.length) {
      throw new AppProblem(409, 'prontidao-mudou', 'A prontidão mudou', 'Os portões deixaram de passar desde a proposta. O sistema propõe de novo quando passarem.');
    }
    let dosPedidos: Aprovacao | null = null;
    if (p.to_mode === 'APPROVAL') {
      if (!(await this.modoAprovacaoLigado(tenantId, p.brand_id))) {
        throw new AppProblem(409, 'modo-aprovacao-desligado', 'Modo Aprovação desligado', 'O modo Aprovação não está liberado para esta empresa. A proposta deixa de valer.');
      }
      dosPedidos = await this.aprovacaoDoPar(tx, tenantId, p.brand_id, { conta: p.connected_account_id, provider: conta.provider, tool: p.tool });
      if (dosPedidos.blocked_by) {
        throw new AppProblem(409, 'aprovacao-indisponivel', 'Aprovação não disponível nesta conta', 'O Liame não muda anúncios nesta conta (a plataforma não é escrita por aqui, ou a escrita não está ligada). A proposta deixa de valer.');
      }
      if (dosPedidos.missing.length) {
        throw new AppProblem(409, 'prontidao-mudou', 'A prontidão mudou', 'Os pedidos mais recentes deixaram de passar nos portões da Aprovação. O sistema propõe de novo quando passarem.');
      }
    }
    const alvo = { tool: p.tool, brandId: p.brand_id, provider: conta.provider, accountId: p.connected_account_id };
    const antes = modoDaAcao((await this.policies.load(tx, tenantId, p.brand_id)).policies, alvo);
    if (antes.mode !== p.from_mode) {
      throw new AppProblem(409, 'modo-mudou', 'O modo já mudou', `Esta ação já está em ${antes.mode} por outro caminho. A proposta deixa de valer.`);
    }
    const politica = await this.policies.publicarRegraDaConta(tx, { tenantId, brandId: p.brand_id, userId: auth.userId, action: p.action, account: p.connected_account_id, mode: p.to_mode });
    const depois = modoDaAcao((await this.policies.load(tx, tenantId, p.brand_id)).policies, alvo);
    if (depois.mode !== p.to_mode) {
      throw new AppProblem(
        409,
        'politica-mais-especifica',
        'Outra regra decide esta ação',
        `Uma regra mais específica (ou uma que sempre escala) da política da ${depois.source ? NOME_DA_POLITICA[depois.source] : 'distribuição'} mantém a ação em ${depois.mode}. Ajuste a política antes de promover.`,
      );
    }
    await tx.execute(sql`
      update liame.autonomy_proposal
         set status = 'aprovada', decided_by = ${auth.userId}, decided_at = now(), policy_version = ${politica.version}, updated_at = now()
       where id = ${id}`);
    auditDetail({
      resourceId: id,
      before: { mode: p.from_mode },
      after: {
        mode: p.to_mode,
        connected_account_id: p.connected_account_id,
        tool: p.tool,
        action: p.action,
        policy_version: politica.version,
        sample_size: retrato.sample_size,
        ...(dosPedidos ? { requests: { sample_size: dosPedidos.sample_size, approved: dosPedidos.approved, failed: dosPedidos.failed } } : {}),
      },
    });
    return this.item(tenantId, p.brand_id, p.connected_account_id, p.tool);
  }

  /**
   * Recusa a promoção: a ação segue no modo em que está. O sistema só propõe de novo com mais 30 decisões comparáveis
   * (para Sugerir) ou com mais 10 pedidos decididos (para Aprovação).
   */
  async recusar(auth: AuthContext, id: string, body: RejectAutonomyRequest): Promise<AutonomyItem> {
    const tenantId = this.empresa(auth);
    const tx = currentTx();
    const p = await this.pendente(tx, id);
    const motivo = body.reason ? motivoSemDadoPessoal(body.reason) : null;
    if (p.to_mode === 'APPROVAL') {
      const decididos = (await pedidosDecididos(tx, { tenantId, brandId: p.brand_id })).get(chaveDoPar(p.connected_account_id, p.tool))?.length ?? 0;
      const proxima = decididos + PEDIDOS_DEPOIS_DA_RECUSA;
      await tx.execute(sql`
        update liame.autonomy_proposal
           set status = 'recusada', decided_by = ${auth.userId}, decided_at = now(), reason = ${motivo}, next_request_count = ${proxima}, updated_at = now()
         where id = ${id}`);
      auditDetail({ resourceId: id, after: { status: 'recusada', connected_account_id: p.connected_account_id, tool: p.tool, to_mode: 'APPROVAL', next_request_count: proxima } });
      return this.item(tenantId, p.brand_id, p.connected_account_id, p.tool);
    }
    const retrato = await this.ultimoRetrato(tx, p.connected_account_id, p.tool);
    const proxima = Math.max(p.sample_size, retrato?.sample_size ?? 0) + AMOSTRA_DEPOIS_DA_RECUSA;
    await tx.execute(sql`
      update liame.autonomy_proposal
         set status = 'recusada', decided_by = ${auth.userId}, decided_at = now(), reason = ${motivo}, next_sample_size = ${proxima}, updated_at = now()
       where id = ${id}`);
    auditDetail({ resourceId: id, after: { status: 'recusada', connected_account_id: p.connected_account_id, tool: p.tool, next_sample_size: proxima } });
    return this.item(tenantId, p.brand_id, p.connected_account_id, p.tool);
  }

  /**
   * Volta a ação um passo, a qualquer momento (proposta D-A4-27): de Aprovação para Sugerir, e de Sugerir (ou de outro
   * modo que a política diga) para Sombra. Publica a versão seguinte da política da marca com a ação no modo de
   * destino; a promoção aprovada desse passo (se houver) vira `desfeita`, e o sistema só propõe de novo com mais 30
   * decisões comparáveis (para Sugerir) ou mais 10 pedidos decididos (para Aprovação). Os pedidos que o funcionário
   * já fez continuam esperando a decisão de uma pessoa.
   */
  async voltarUmPasso(auth: AuthContext, body: UndoAutonomyRequest): Promise<AutonomyItem> {
    const tenantId = this.empresa(auth);
    const tx = currentTx();
    const conta = await this.conta(tx, body.connected_account_id);
    const alvo = { tool: body.tool, brandId: conta.brand_id, provider: conta.provider, accountId: body.connected_account_id };
    const antes = modoDaAcao((await this.policies.load(tx, tenantId, conta.brand_id)).policies, alvo);
    if (antes.mode === 'SHADOW') throw new AppProblem(409, 'ja-em-sombra', 'Já está em Sombra', 'Esta ação já está em Sombra nesta conta.');
    const destino = umPassoAtras(antes.mode);
    const action = ACAO_DA_FERRAMENTA[body.tool];
    const politica = await this.policies.publicarRegraDaConta(tx, { tenantId, brandId: conta.brand_id, userId: auth.userId, action, account: body.connected_account_id, mode: destino });
    const depois = modoDaAcao((await this.policies.load(tx, tenantId, conta.brand_id)).policies, alvo);
    if (depois.mode !== destino) {
      throw new AppProblem(
        409,
        'politica-mais-especifica',
        'Outra regra decide esta ação',
        `Uma regra mais específica (ou uma que sempre escala) da política da ${depois.source ? NOME_DA_POLITICA[depois.source] : 'distribuição'} mantém a ação em ${depois.mode}. Ajuste a política para voltar para ${NOME_DO_MODO[destino]}.`,
      );
    }
    const motivo = body.reason ? motivoSemDadoPessoal(body.reason) : null;
    // O passo que se desfaz é o que levou ao modo de antes: sair de Aprovação desfaz a proposta de Aprovação, e a de
    // Sugerir segue aprovada.
    const promocaoDesfeita = antes.mode === 'APPROVAL' ? 'APPROVAL' : 'SUGGEST';
    let proximaAmostra: number | null = null;
    let proximosPedidos: number | null = null;
    if (promocaoDesfeita === 'APPROVAL') {
      proximosPedidos = ((await pedidosDecididos(tx, { tenantId, brandId: conta.brand_id })).get(chaveDoPar(body.connected_account_id, body.tool))?.length ?? 0) + PEDIDOS_DEPOIS_DA_RECUSA;
    } else {
      proximaAmostra = ((await this.ultimoRetrato(tx, body.connected_account_id, body.tool))?.sample_size ?? 0) + AMOSTRA_DEPOIS_DA_RECUSA;
    }
    const desfeita = await tx.execute<{ id: string }>(sql`
      update liame.autonomy_proposal
         set status = 'desfeita', undone_by = ${auth.userId}, undone_at = now(), undone_policy_version = ${politica.version}, reason = ${motivo},
             next_sample_size = coalesce(${proximaAmostra}::integer, next_sample_size), next_request_count = coalesce(${proximosPedidos}::integer, next_request_count),
             updated_at = now()
       where connected_account_id = ${body.connected_account_id} and tool = ${body.tool} and status = 'aprovada' and to_mode = ${promocaoDesfeita}
       returning id`);
    // Saindo de Sugerir, a proposta de Aprovação que esperava decisão deixa de valer na hora (não espera a rotina).
    if (promocaoDesfeita === 'SUGGEST') {
      await tx.execute(sql`
        update liame.autonomy_proposal
           set status = 'retirada', decided_at = now(), reason = 'O modo da ação mudou por outro caminho.', updated_at = now()
         where connected_account_id = ${body.connected_account_id} and tool = ${body.tool} and status = 'pendente' and to_mode = 'APPROVAL'`);
    }
    auditDetail({
      ...(desfeita.rows[0] ? { resourceId: desfeita.rows[0].id } : {}),
      before: { mode: antes.mode },
      after: { mode: destino, connected_account_id: body.connected_account_id, tool: body.tool, action, policy_version: politica.version },
    });
    return this.item(tenantId, conta.brand_id, body.connected_account_id, body.tool);
  }

  // ------------------------------------------------------------ leitura

  private async item(tenantId: string, brandId: string, conta: string, tool: string): Promise<AutonomyItem> {
    const [item] = await this.itens(tenantId, brandId, { conta, tool });
    if (!item) throw new Error('autonomia: o item da decisão sumiu na mesma transação');
    return item;
  }

  /** Cada conta e ação com sombra registrada (decisão, retrato ou proposta), com o modo, o último retrato e a proposta que vale. */
  private async itens(tenantId: string, brandId: string, so?: { conta: string; tool: string }): Promise<AutonomyItem[]> {
    const tx = currentTx();
    const filtro = so ? sql`and connected_account_id = ${so.conta} and tool = ${so.tool}` : sql``;
    const r = await tx.execute<Linha>(sql`
      with pares as (
        select connected_account_id, tool from liame.shadow_decision where brand_id = ${brandId} and tool in ${SHADOW_TOOLS} ${filtro}
        union
        select connected_account_id, tool from liame.readiness_snapshot where brand_id = ${brandId} and tool in ${SHADOW_TOOLS} ${filtro}
        union
        select connected_account_id, tool from liame.autonomy_proposal where brand_id = ${brandId} and tool in ${SHADOW_TOOLS} ${filtro}
      )
      select p.connected_account_id, p.tool, a.provider, a.name as account_name,
             r.computed_on::text as computed_on, r.rule_version, r.sample_size,
             round(r.agreement_rate * 100, 1)::text as agreement_pct, round(r.worse_rate * 100, 1)::text as worse_pct,
             r.regret_sum_micros::text as regret, round(r.confidence_avg * 100, 1)::text as confidence_pct, r.missing
        from pares p
        join liame.connected_account a on a.id = p.connected_account_id and a.disconnected_at is null
        left join lateral (
          select computed_on, rule_version, sample_size, agreement_rate, worse_rate, regret_sum_micros, confidence_avg, missing
            from liame.readiness_snapshot s
           where s.connected_account_id = p.connected_account_id and s.tool = p.tool
           order by s.computed_on desc limit 1
        ) r on true`);
    if (!r.rows.length) return [];
    // A proposta mais recente de cada passo (para Sugerir e para Aprovação), a pendente primeiro; qual delas a tela
    // mostra depende do modo de agora (`propostaDoModo`).
    const filtroDaProposta = so ? sql`and y.connected_account_id = ${so.conta} and y.tool = ${so.tool}` : sql``;
    const dasPropostas = await tx.execute<LinhaDaProposta>(sql`
      select distinct on (y.connected_account_id, y.tool, y.to_mode)
             y.connected_account_id, y.tool, y.id, y.status, y.sample_size, y.created_at, y.decided_by, ud.name as decider, y.decided_at, y.policy_version,
             y.undone_by, uu.name as undoer, y.undone_at, y.reason, y.next_sample_size, y.next_request_count, y.from_mode, y.to_mode
        from liame.autonomy_proposal y
        left join liame.app_user ud on ud.id = y.decided_by
        left join liame.app_user uu on uu.id = y.undone_by
       where y.brand_id = ${brandId} and y.tool in ${SHADOW_TOOLS} ${filtroDaProposta}
       order by y.connected_account_id, y.tool, y.to_mode, (y.status = 'pendente') desc, y.created_at desc, y.id desc`);
    const propostas = new Map<string, PropostasDoPar>();
    for (const p of dasPropostas.rows) {
      const chave = chaveDoPar(p.connected_account_id, p.tool);
      const doPar = propostas.get(chave) ?? {};
      if (p.to_mode === 'APPROVAL') doPar.aprovacao = p;
      else doPar.sugerir = p;
      propostas.set(chave, doPar);
    }
    const { policies } = await this.policies.load(tx, tenantId, brandId);
    // Os portões da Aprovação de cada conta e ação, só para a empresa com esse modo ligado (uma leitura para a página).
    const aprovacoes = new Map<string, Aprovacao>();
    if (await this.modoAprovacaoLigado(tenantId, brandId)) {
      const pedidos = await pedidosDecididos(tx, { tenantId, brandId });
      for (const l of r.rows) {
        const chave = chaveDoPar(l.connected_account_id, l.tool);
        aprovacoes.set(chave, await this.aprovacaoDe(tenantId, brandId, { conta: l.connected_account_id, provider: l.provider }, pedidos.get(chave) ?? []));
      }
    }
    const itens = r.rows.map((l): AutonomyItem => {
      const modo = modoDaAcao(policies, { tool: l.tool, brandId, provider: l.provider, accountId: l.connected_account_id });
      const aprovacao = aprovacoes.get(chaveDoPar(l.connected_account_id, l.tool));
      const readiness =
        l.computed_on === null
          ? null
          : {
              computed_on: l.computed_on,
              rule_version: Number(l.rule_version),
              sample_size: Number(l.sample_size),
              agreement_pct: l.agreement_pct,
              worse_pct: l.worse_pct,
              regret_sum_micros: l.regret ?? '0',
              confidence_avg_pct: l.confidence_pct,
              missing: l.missing ?? [],
            };
      return {
        connected_account_id: l.connected_account_id,
        provider: l.provider,
        account_name: l.account_name,
        tool: l.tool,
        action: ACAO_DA_FERRAMENTA[l.tool],
        mode: modo.mode,
        mode_source: { policy: modo.source ? NOME_DA_POLITICA[modo.source] : 'padrao', version: modo.version },
        readiness,
        proposal: propostaComo(propostaDoModo(propostas.get(chaveDoPar(l.connected_account_id, l.tool)) ?? {}, modo.mode), modo.mode, readiness?.missing ?? null, aprovacao ?? null),
        ...(aprovacao ? { approval: aprovacao } : {}),
      };
    });
    // A pendente primeiro; depois as que já mostram na Atenção; depois a mais perto dos portões.
    const peso = (i: AutonomyItem) => (i.proposal?.status === 'pendente' ? 0 : i.mode !== 'SHADOW' ? 1 : 2);
    return itens.sort(
      (a, b) =>
        peso(a) - peso(b) ||
        portoesQuePassaram(b.readiness?.missing ?? ['amostra', 'concordancia', 'piora', 'arrependimento', 'confianca']) -
          portoesQuePassaram(a.readiness?.missing ?? ['amostra', 'concordancia', 'piora', 'arrependimento', 'confianca']) ||
        (b.readiness?.sample_size ?? 0) - (a.readiness?.sample_size ?? 0) ||
        a.account_name.localeCompare(b.account_name, 'pt-BR') ||
        (ORDEM_DA_ACAO.get(a.tool) ?? 9) - (ORDEM_DA_ACAO.get(b.tool) ?? 9),
    );
  }

  /** A flag do modo Aprovação para a empresa e a marca (nasce desligada). */
  private modoAprovacaoLigado(tenantId: string, brandId: string): Promise<boolean> {
    return this.flags.isEnabled('modo_aprovacao', this.flags.context({ tenantId, brandId }));
  }

  /**
   * Os portões da Aprovação de uma conta, com o que impede o modo ali: a plataforma que o Liame não escreve, ou a
   * escrita desligada para a conta (a flag do conector, como no pedido).
   */
  private async aprovacaoDe(tenantId: string, brandId: string, alvo: { conta: string; provider: string }, desfechos: Parameters<typeof prontidaoDaAprovacao>[0]): Promise<Aprovacao> {
    const p = prontidaoDaAprovacao(desfechos);
    const flag = CONNECTORS[alvo.provider]?.writeFlag;
    const bloqueio = !flag ? 'plataforma_sem_escrita' : (await this.flags.isEnabled(flag, this.flags.context({ tenantId, brandId, accountId: alvo.conta }))) ? null : 'escrita_desligada';
    return { sample_size: p.sampleSize, approved: p.approved, failed: p.failed, missing: p.missing, blocked_by: bloqueio };
  }

  /** O mesmo, para uma conta e ação só (a decisão sobre uma proposta). */
  private async aprovacaoDoPar(tx: Tx, tenantId: string, brandId: string, alvo: { conta: string; provider: string; tool: string }): Promise<Aprovacao> {
    const pedidos = await pedidosDecididos(tx, { tenantId, brandId });
    return this.aprovacaoDe(tenantId, brandId, alvo, pedidos.get(chaveDoPar(alvo.conta, alvo.tool)) ?? []);
  }

  private async pendente(tx: Tx, id: string): Promise<Proposta> {
    const p = (
      await tx.execute<Proposta>(sql`
        select id, brand_id, connected_account_id, tool, action, status, sample_size, from_mode, to_mode from liame.autonomy_proposal where id = ${id} for update`)
    ).rows[0];
    if (!p) throw new AppProblem(404, 'nao-encontrado', 'Não encontramos', 'Proposta não encontrada nesta empresa.');
    if (p.status !== 'pendente') throw new AppProblem(409, 'proposta-decidida', 'Esta proposta já foi decidida', `A proposta está ${p.status}.`);
    return p;
  }

  private async conta(tx: Tx, id: string): Promise<{ brand_id: string; provider: string }> {
    const c = (
      await tx.execute<{ brand_id: string; provider: string; disconnected_at: Date | string | null }>(sql`
        select brand_id, provider, disconnected_at from liame.connected_account where id = ${id} and provider in ('meta_ads', 'google_ads')`)
    ).rows[0];
    if (!c) throw new AppProblem(404, 'nao-encontrado', 'Não encontramos', 'Conta de anúncio não encontrada nesta empresa.');
    if (c.disconnected_at !== null) throw new AppProblem(409, 'conta-desconectada', 'Conta desconectada', 'Conecte a conta de novo para mudar a autonomia dela.');
    return c;
  }

  private async ultimoRetrato(tx: Tx, conta: string, tool: string): Promise<{ sample_size: number; missing: string[] } | null> {
    const r = await tx.execute<{ sample_size: number; missing: string[] }>(sql`
      select sample_size, missing from liame.readiness_snapshot
       where connected_account_id = ${conta} and tool = ${tool} order by computed_on desc limit 1`);
    return r.rows[0] ?? null;
  }

  private async exigirMarca(brandId: string): Promise<void> {
    const b = await currentTx().execute(sql`select 1 from liame.brand where id = ${brandId} and archived_at is null`);
    if (!b.rows[0]) throw new AppProblem(404, 'nao-encontrado', 'Não encontramos', 'Marca não encontrada nesta empresa.');
  }

  private empresa(auth: AuthContext): string {
    if (!auth.tenantId) throw new AppProblem(403, 'sem-empresa-ativa', 'Escolha uma empresa', 'Selecione uma empresa com acesso ativo.');
    return auth.tenantId;
  }
}

/**
 * A proposta como a tela mostra. A pendente que já não vale (os portões deixaram de passar, ou o modo mudou por
 * outro caminho) aparece como `retirada` antes de a rotina gravar isso, como o plano que passou do prazo.
 */
function propostaComo(p: LinhaDaProposta | null, modo: AutonomyMode, missing: string[] | null, aprovacao: Aprovacao | null): AutonomyProposalSummary | null {
  if (!p) return null;
  const de = p.from_mode;
  const para = p.to_mode;
  let status = p.status;
  let reason = p.reason;
  if (status === 'pendente') {
    const cincoPassam = missing !== null && missing.length === 0;
    if (modo !== de) {
      status = 'retirada';
      reason = 'O modo da ação mudou por outro caminho.';
    } else if (para === 'APPROVAL' && (!aprovacao || aprovacao.blocked_by !== null)) {
      // O modo Aprovação foi desligado para a empresa, ou a escrita para a conta, depois da proposta.
      status = 'retirada';
      reason = 'O modo Aprovação deixou de estar disponível nesta conta.';
    } else if (!cincoPassam) {
      status = 'retirada';
      reason = 'Os portões da prontidão deixaram de passar.';
    } else if (para === 'APPROVAL' && aprovacao && aprovacao.missing.length > 0) {
      status = 'retirada';
      reason = 'Os portões da Aprovação deixaram de passar.';
    }
  }
  return {
    id: p.id,
    status,
    from_mode: de,
    to_mode: para,
    sample_size: Number(p.sample_size),
    proposed_at: iso(p.created_at)!,
    decided_by: quem(p.decided_by, p.decider),
    decided_at: iso(p.decided_at),
    policy_version: p.policy_version,
    undone_by: quem(p.undone_by, p.undoer),
    undone_at: iso(p.undone_at),
    reason,
    next_sample_size: p.next_sample_size,
    next_request_count: p.next_request_count,
  };
}

/**
 * A proposta que a tela mostra para uma conta e ação: a pendente (há no máximo uma, de um passo ou do outro); sem
 * pendente, a do passo em que a ação está. Em Sugerir e em Aprovação, a história do segundo passo (aprovada, recusada,
 * retirada, desfeita), quando há; em Sombra (e em qualquer outro modo), a do primeiro.
 */
function propostaDoModo(doPar: PropostasDoPar, modo: AutonomyMode): LinhaDaProposta | null {
  const pendente = [doPar.aprovacao, doPar.sugerir].find((p) => p?.status === 'pendente');
  if (pendente) return pendente;
  if (modo === 'APPROVAL' || modo === 'SUGGEST') return doPar.aprovacao ?? doPar.sugerir ?? null;
  return doPar.sugerir ?? null;
}
