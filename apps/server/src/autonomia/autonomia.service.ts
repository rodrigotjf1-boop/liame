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
import { motivoSemDadoPessoal } from '../ai/sanitizar.js';
import { type AuthContext, auditDetail, currentTx } from '../context/request-context.js';
import { AppProblem } from '../errors/problems.js';
import type { PolicySource } from '../policy/engine.js';
import { PolicyService } from '../policy/policy.service.js';
import { ACAO_DA_FERRAMENTA, AMOSTRA_DEPOIS_DA_RECUSA, LIMIARES_DA_AUTONOMIA, modoDaAcao, portoesQuePassaram } from '../sombra/autonomia.js';
import type { AcaoSombra } from '../sombra/regras.js';

// Autonomia por conta e ação (A3, I13; protótipo P7, aguardando aprovação; sem tela ainda). Na requisição, sob a RLS
// da empresa. Ver mostra, por conta e ação com sombra registrada, o modo (pelo motor de políticas), o último retrato
// da prontidão e a proposta. Aprovar e voltar para Sombra publicam a versão seguinte da política da marca; recusar
// só fecha a proposta. Nada é executado em plataforma nenhuma.

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
  p_id: string | null;
  p_status: string | null;
  p_sample_size: number | null;
  p_created_at: Date | string | null;
  p_decided_by: string | null;
  p_decider: string | null;
  p_decided_at: Date | string | null;
  p_policy_version: number | null;
  p_undone_by: string | null;
  p_undoer: string | null;
  p_undone_at: Date | string | null;
  p_reason: string | null;
  p_next_sample_size: number | null;
};

type Proposta = { id: string; brand_id: string; connected_account_id: string; tool: AcaoSombra; action: string; status: string; sample_size: number };

const iso = (v: Date | string | null) => (v === null ? null : new Date(v).toISOString());
const quem = (id: string | null, nome: string | null) => (id ? { id, name: nome ?? 'Pessoa removida' } : null);

@Injectable()
export class AutonomiaService {
  constructor(private readonly policies: PolicyService) {}

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
   * Aprova a promoção: confere que a proposta segue pendente, a conta conectada, os portões passando e a ação em
   * Sombra; publica a versão seguinte da política da marca com a ação em Sugerir e confere que o motor passou a dizer
   * Sugerir (uma regra mais específica, ou um ESCALATE, venceria).
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
    const alvo = { tool: p.tool, brandId: p.brand_id, provider: conta.provider, accountId: p.connected_account_id };
    const antes = modoDaAcao((await this.policies.load(tx, tenantId, p.brand_id)).policies, alvo);
    if (antes.mode !== 'SHADOW') {
      throw new AppProblem(409, 'modo-mudou', 'O modo já mudou', `Esta ação já está em ${antes.mode} por outro caminho. A proposta deixa de valer.`);
    }
    const politica = await this.policies.publicarRegraDaConta(tx, { tenantId, brandId: p.brand_id, userId: auth.userId, action: p.action, account: p.connected_account_id, mode: 'SUGGEST' });
    const depois = modoDaAcao((await this.policies.load(tx, tenantId, p.brand_id)).policies, alvo);
    if (depois.mode !== 'SUGGEST') {
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
      before: { mode: 'SHADOW' },
      after: { mode: 'SUGGEST', connected_account_id: p.connected_account_id, tool: p.tool, action: p.action, policy_version: politica.version, sample_size: retrato.sample_size },
    });
    return this.item(tenantId, p.brand_id, p.connected_account_id, p.tool);
  }

  /** Recusa a promoção: a ação segue em Sombra, e o sistema só propõe de novo com mais 30 decisões comparáveis. */
  async recusar(auth: AuthContext, id: string, body: RejectAutonomyRequest): Promise<AutonomyItem> {
    const tenantId = this.empresa(auth);
    const tx = currentTx();
    const p = await this.pendente(tx, id);
    const retrato = await this.ultimoRetrato(tx, p.connected_account_id, p.tool);
    const proxima = Math.max(p.sample_size, retrato?.sample_size ?? 0) + AMOSTRA_DEPOIS_DA_RECUSA;
    const motivo = body.reason ? motivoSemDadoPessoal(body.reason) : null;
    await tx.execute(sql`
      update liame.autonomy_proposal
         set status = 'recusada', decided_by = ${auth.userId}, decided_at = now(), reason = ${motivo}, next_sample_size = ${proxima}, updated_at = now()
       where id = ${id}`);
    auditDetail({ resourceId: id, after: { status: 'recusada', connected_account_id: p.connected_account_id, tool: p.tool, next_sample_size: proxima } });
    return this.item(tenantId, p.brand_id, p.connected_account_id, p.tool);
  }

  /**
   * Volta a ação para Sombra, a qualquer momento: publica a versão seguinte da política da marca com a ação em
   * Sombra; a promoção aprovada (se houver) vira `desfeita`, e o sistema só propõe de novo com mais 30 decisões.
   */
  async voltarParaSombra(auth: AuthContext, body: UndoAutonomyRequest): Promise<AutonomyItem> {
    const tenantId = this.empresa(auth);
    const tx = currentTx();
    const conta = await this.conta(tx, body.connected_account_id);
    const alvo = { tool: body.tool, brandId: conta.brand_id, provider: conta.provider, accountId: body.connected_account_id };
    const antes = modoDaAcao((await this.policies.load(tx, tenantId, conta.brand_id)).policies, alvo);
    if (antes.mode === 'SHADOW') throw new AppProblem(409, 'ja-em-sombra', 'Já está em Sombra', 'Esta ação já está em Sombra nesta conta.');
    const action = ACAO_DA_FERRAMENTA[body.tool];
    const politica = await this.policies.publicarRegraDaConta(tx, { tenantId, brandId: conta.brand_id, userId: auth.userId, action, account: body.connected_account_id, mode: 'SHADOW' });
    const depois = modoDaAcao((await this.policies.load(tx, tenantId, conta.brand_id)).policies, alvo);
    if (depois.mode !== 'SHADOW') {
      throw new AppProblem(
        409,
        'politica-mais-especifica',
        'Outra regra decide esta ação',
        `Uma regra mais específica (ou uma que sempre escala) da política da ${depois.source ? NOME_DA_POLITICA[depois.source] : 'distribuição'} mantém a ação em ${depois.mode}. Ajuste a política para voltar para Sombra.`,
      );
    }
    const retrato = await this.ultimoRetrato(tx, body.connected_account_id, body.tool);
    const motivo = body.reason ? motivoSemDadoPessoal(body.reason) : null;
    const desfeita = await tx.execute<{ id: string }>(sql`
      update liame.autonomy_proposal
         set status = 'desfeita', undone_by = ${auth.userId}, undone_at = now(), undone_policy_version = ${politica.version}, reason = ${motivo},
             next_sample_size = ${(retrato?.sample_size ?? 0) + AMOSTRA_DEPOIS_DA_RECUSA}, updated_at = now()
       where connected_account_id = ${body.connected_account_id} and tool = ${body.tool} and status = 'aprovada'
       returning id`);
    auditDetail({
      ...(desfeita.rows[0] ? { resourceId: desfeita.rows[0].id } : {}),
      before: { mode: antes.mode },
      after: { mode: 'SHADOW', connected_account_id: body.connected_account_id, tool: body.tool, action, policy_version: politica.version },
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
             r.regret_sum_micros::text as regret, round(r.confidence_avg * 100, 1)::text as confidence_pct, r.missing,
             x.id as p_id, x.status as p_status, x.sample_size as p_sample_size, x.created_at as p_created_at,
             x.decided_by as p_decided_by, ud.name as p_decider, x.decided_at as p_decided_at, x.policy_version as p_policy_version,
             x.undone_by as p_undone_by, uu.name as p_undoer, x.undone_at as p_undone_at, x.reason as p_reason, x.next_sample_size as p_next_sample_size
        from pares p
        join liame.connected_account a on a.id = p.connected_account_id and a.disconnected_at is null
        left join lateral (
          select computed_on, rule_version, sample_size, agreement_rate, worse_rate, regret_sum_micros, confidence_avg, missing
            from liame.readiness_snapshot s
           where s.connected_account_id = p.connected_account_id and s.tool = p.tool
           order by s.computed_on desc limit 1
        ) r on true
        left join lateral (
          select * from liame.autonomy_proposal y
           where y.connected_account_id = p.connected_account_id and y.tool = p.tool
           order by (y.status = 'pendente') desc, y.created_at desc, y.id desc limit 1
        ) x on true
        left join liame.app_user ud on ud.id = x.decided_by
        left join liame.app_user uu on uu.id = x.undone_by`);
    if (!r.rows.length) return [];
    const { policies } = await this.policies.load(tx, tenantId, brandId);
    const itens = r.rows.map((l): AutonomyItem => {
      const modo = modoDaAcao(policies, { tool: l.tool, brandId, provider: l.provider, accountId: l.connected_account_id });
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
        proposal: propostaDaLinha(l, modo.mode, readiness?.missing ?? null),
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

  private async pendente(tx: Tx, id: string): Promise<Proposta> {
    const p = (
      await tx.execute<Proposta>(sql`
        select id, brand_id, connected_account_id, tool, action, status, sample_size from liame.autonomy_proposal where id = ${id} for update`)
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
function propostaDaLinha(l: Linha, modo: AutonomyMode, missing: string[] | null): AutonomyProposalSummary | null {
  if (!l.p_id || !l.p_status || l.p_created_at === null) return null;
  let status = l.p_status;
  let reason = l.p_reason;
  if (status === 'pendente' && (modo !== 'SHADOW' || !missing || missing.length > 0)) {
    status = 'retirada';
    reason = modo !== 'SHADOW' ? 'O modo da ação mudou por outro caminho.' : 'Os portões da prontidão deixaram de passar.';
  }
  return {
    id: l.p_id,
    status,
    from_mode: 'SHADOW',
    to_mode: 'SUGGEST',
    sample_size: Number(l.p_sample_size),
    proposed_at: iso(l.p_created_at)!,
    decided_by: quem(l.p_decided_by, l.p_decider),
    decided_at: iso(l.p_decided_at),
    policy_version: l.p_policy_version,
    undone_by: quem(l.p_undone_by, l.p_undoer),
    undone_at: iso(l.p_undone_at),
    reason,
    next_sample_size: l.p_next_sample_size,
  };
}
