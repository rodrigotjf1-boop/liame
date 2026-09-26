import type {
  ActionProposal,
  ActionResponse,
  ActionStatus,
  ApproveActionRequest,
  AutonomyMode,
  CreateActionRequest,
  PolicyDecision,
  SandboxResourceRequest,
  SandboxResourceResponse,
  UpdateActionRequest,
} from '@liame/contracts';
import { type Tx, uuidv7 } from '@liame/database';
import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { canonicalJson, sha256 } from '../audit/audit.js';
import { MfaService } from '../auth/mfa.service.js';
import { APP_CONFIG, type AppConfig } from '../config.js';
import { afterCommit, type AuthContext, auditDetail, currentTx } from '../context/request-context.js';
import { AppProblem, issuesToErrors, ValidationProblem } from '../errors/problems.js';
import { emitEvent } from '../events/outbox.js';
import { FlagService } from '../flags/flag.service.js';
import { KillSwitchService } from '../kill-switch/kill-switch.service.js';
import { Mailer } from '../mail/mailer.js';
import { actionMatches, evaluatePolicy } from '../policy/engine.js';
import { PolicyService } from '../policy/policy.service.js';
import { BudgetService } from './budget.service.js';
import { CONNECTORS, type Connector } from './connectors.js';
import { TOOLS, type ToolDefinition, type ToolPlan } from './tools.js';

/** Pedido que ninguém aprova expira (e devolve a reserva). */
export const ACTION_TTL_HOURS = 72;
const ACTIVE: ActionStatus[] = ['aguardando_aprovacao', 'aprovada', 'executando'];

export type ActionRow = {
  id: string;
  tenant_id: string;
  brand_id: string | null;
  tool: string;
  action: string;
  provider: string;
  account_id: string;
  resource_id: string;
  params: Record<string, unknown>;
  risk_level: ActionResponse['risk_level'];
  budget_impact: ActionResponse['budget_impact'];
  value_micros: string | null;
  current_value_micros: string | null;
  reserved_micros: string;
  before_state: Record<string, unknown> | null;
  before_version: number | null;
  desired_state: Record<string, unknown>;
  plan_hash: string;
  action_fingerprint: string;
  mode: AutonomyMode;
  policy_decision: PolicyDecision;
  status: ActionStatus;
  status_reason: string | null;
  requested_by: string;
  expires_at: Date | string;
  created_at: Date | string;
};

type ApprovalRow = {
  action_request_id: string;
  approved_by: string;
  approver_name: string;
  approver_role: string;
  sufficient: boolean;
  plan_hash: string;
  created_at: Date | string;
};

const notFound = () => new AppProblem(404, 'nao-encontrado', 'Não encontramos', 'Ação não encontrada nesta empresa.');
const micros = (v: string | null) => (v === null ? null : Number(v));
const brl = (m: number) => (m / 1_000_000).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

/**
 * Action Service, lado do pedido (ADR-007): ferramenta → trava → estado no provedor → política →
 * orçamento (reserva) → aprovação amarrada ao hash do plano. A execução fica no worker (E6d).
 */
@Injectable()
export class ActionService {
  constructor(
    private readonly policies: PolicyService,
    private readonly budget: BudgetService,
    private readonly switches: KillSwitchService,
    private readonly flags: FlagService,
    private readonly mfa: MfaService,
    private readonly mailer: Mailer,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async create(auth: AuthContext, input: CreateActionRequest): Promise<ActionResponse> {
    const tx = currentTx();
    const tenantId = tenantOf(auth);
    const { tool, connector } = this.resolve(input.tool, input.provider);
    if (input.brand_id) await this.assertBrand(tx, tenantId, input.brand_id);
    const target = { tenantId, provider: input.provider, brandId: input.brand_id ?? null, accountId: input.account_id, tool: tool.name };
    await this.assertNotStopped(tx, target);
    await this.assertWriteEnabled(auth, connector, input.brand_id ?? null, input.account_id);

    const params = this.parseParams(tool, input.params);
    const read = await connector.read(tx, { tenantId, accountId: input.account_id, resourceId: input.resource_id });
    if (!read) throw new AppProblem(404, 'recurso-nao-encontrado', 'Recurso não encontrado', 'A conta ou o recurso não existe no provedor.');
    const plan = tool.plan(read.state, params);
    const decision = await this.decide(tx, tenantId, input.brand_id ?? null, tool, input, plan);

    const id = uuidv7();
    const { mode, status, reason } = await this.statusFor(decision.mode, auth, input.brand_id ?? null);
    const fingerprint = sha256(canonicalJson({ tenantId, tool: tool.name, provider: input.provider, account: input.account_id, resource: input.resource_id }));
    const planHash = planHashOf({ ...input, tool: tool.name, params }, plan, read.version);
    try {
      await tx.execute(sql`
        insert into liame.action_request (id, tenant_id, brand_id, tool, action, provider, account_id, resource_id, params, risk_level,
                                          budget_impact, value_micros, current_value_micros, reserved_micros, before_state, before_version,
                                          desired_state, plan_hash, action_fingerprint, mode, policy_decision, status, status_reason,
                                          requested_by, expires_at)
        values (${id}, ${tenantId}, ${input.brand_id ?? null}, ${tool.name}, ${plan.action}, ${input.provider}, ${input.account_id},
                ${input.resource_id}, ${JSON.stringify(params)}::jsonb, ${tool.risk}, ${plan.budgetImpact}, ${plan.valueMicros},
                ${plan.currentValueMicros}, ${status === 'sombra' ? 0 : plan.reserveMicros}, ${JSON.stringify(read.state)}::jsonb,
                ${read.version}, ${JSON.stringify(plan.desiredState)}::jsonb, ${planHash}, ${fingerprint}, ${mode},
                ${JSON.stringify(decision)}::jsonb, ${status}, ${reason}, ${auth.userId},
                now() + make_interval(hours => ${ACTION_TTL_HOURS}))`);
    } catch (err) {
      // Outro pedido ativo para a mesma ferramenta no mesmo recurso (A1-8): inclusive dois ao mesmo tempo.
      if ((err as { cause?: { code?: string } }).cause?.code === '23505') {
        throw new AppProblem(409, 'acao-duplicada', 'Já existe um pedido igual', 'Já há um pedido ativo desta ferramenta para este recurso. Aprove, altere ou cancele o que existe.');
      }
      throw err;
    }
    if (status !== 'sombra') {
      await this.budget.reserve(tx, { tenantId, brandId: input.brand_id ?? null, actionId: id, amountMicros: plan.reserveMicros });
    }
    await emitEvent(tx, { tenantId, type: 'liame.action.requested', subject: id, data: { action_id: id, tool: tool.name, action: plan.action, mode, status } });
    auditDetail({ resourceId: id, after: { tool: tool.name, action: plan.action, mode, status, plan_hash: planHash, reserved_micros: plan.reserveMicros } });
    return this.get(auth, id);
  }

  /** Mudar os parâmetros gera plano novo: a aprovação dada ao plano anterior deixa de valer. */
  async update(auth: AuthContext, id: string, input: UpdateActionRequest): Promise<ActionResponse> {
    const tx = currentTx();
    const tenantId = tenantOf(auth);
    const row = await this.lock(tx, tenantId, id);
    if (row.status !== 'aguardando_aprovacao' && row.status !== 'sombra') {
      throw new AppProblem(409, 'acao-nao-altera', 'Não dá para alterar', 'Só se altera um pedido que ainda espera aprovação.');
    }
    const { tool, connector } = this.resolve(row.tool, row.provider);
    const params = this.parseParams(tool, input.params);
    const read = await connector.read(tx, { tenantId, accountId: row.account_id, resourceId: row.resource_id });
    if (!read) throw new AppProblem(404, 'recurso-nao-encontrado', 'Recurso não encontrado', 'A conta ou o recurso não existe no provedor.');
    const plan = tool.plan(read.state, params);
    const request = { brand_id: row.brand_id, provider: row.provider, account_id: row.account_id, resource_id: row.resource_id, tool: row.tool, params };
    const decision = await this.decide(tx, tenantId, row.brand_id, tool, request, plan);
    const { mode, status, reason } = await this.statusFor(decision.mode, auth, row.brand_id);
    const planHash = planHashOf(request, plan, read.version);

    await this.budget.release(tx, tenantId, id);
    await tx.execute(sql`
      update liame.action_request
         set params = ${JSON.stringify(params)}::jsonb, action = ${plan.action}, budget_impact = ${plan.budgetImpact},
             value_micros = ${plan.valueMicros}, current_value_micros = ${plan.currentValueMicros},
             reserved_micros = ${status === 'sombra' ? 0 : plan.reserveMicros}, before_state = ${JSON.stringify(read.state)}::jsonb,
             before_version = ${read.version}, desired_state = ${JSON.stringify(plan.desiredState)}::jsonb, plan_hash = ${planHash},
             mode = ${mode}, policy_decision = ${JSON.stringify(decision)}::jsonb, status = ${status}, status_reason = ${reason},
             updated_at = now()
       where id = ${id} and tenant_id = ${tenantId}`);
    if (status !== 'sombra') await this.budget.reserve(tx, { tenantId, brandId: row.brand_id, actionId: id, amountMicros: plan.reserveMicros });
    auditDetail({ before: { plan_hash: row.plan_hash, params: row.params }, after: { plan_hash: planHash, params, mode, status } });
    return this.get(auth, id);
  }

  /**
   * Aprovar (ADR-007, ADR-017): código do app agora, para o plano que a pessoa viu. Basta sozinha quando o
   * limite dela cobre o valor; acima disso (ou se o modo é ESCALATE), falta o dono.
   */
  async approve(auth: AuthContext, id: string, input: ApproveActionRequest): Promise<ActionResponse> {
    const tx = currentTx();
    const tenantId = tenantOf(auth);
    const row = await this.lock(tx, tenantId, id);
    if (row.status !== 'aguardando_aprovacao') {
      throw new AppProblem(409, 'acao-nao-aguarda', 'Não espera aprovação', 'Este pedido não está esperando aprovação.');
    }
    if (row.plan_hash !== input.plan_hash) {
      throw new AppProblem(409, 'plano-mudou', 'O plano mudou', 'O pedido foi alterado depois que você abriu. Confira o plano novo e aprove de novo.');
    }
    await this.mfa.verifyStepUp(tx, auth.userId, input.code);

    const m = await tx.execute<{ role_key: string; approve_limit_micros: string | null }>(sql`
      select role_key, approve_limit_micros from liame.membership
       where tenant_id = ${tenantId} and user_id = ${auth.userId} and revoked_at is null`);
    const role = m.rows[0]?.role_key ?? auth.roleKey ?? '';
    const limit = micros(m.rows[0]?.approve_limit_micros ?? null);
    const amount = Number(row.reserved_micros);
    const sufficient = role === 'dono' || (row.mode !== 'ESCALATE' && (limit === null || amount <= limit));
    try {
      await tx.execute(sql`
        insert into liame.approval (id, tenant_id, action_request_id, plan_hash, approved_by, approver_role, approver_limit_micros, sufficient, method)
        values (${uuidv7()}, ${tenantId}, ${id}, ${row.plan_hash}, ${auth.userId}, ${role}, ${limit}, ${sufficient}, 'totp')`);
    } catch (err) {
      if ((err as { cause?: { code?: string } }).cause?.code === '23505') {
        throw new AppProblem(409, 'ja-aprovou', 'Você já aprovou', 'Sua aprovação para este plano já está registrada.');
      }
      throw err;
    }
    if (sufficient) {
      await tx.execute(sql`update liame.action_request set status = 'aprovada', status_reason = null, updated_at = now() where id = ${id}`);
      await emitEvent(tx, { tenantId, type: 'liame.action.approved', subject: id, data: { action_id: id, plan_hash: row.plan_hash } });
    } else {
      await this.notifyOwners(tx, tenantId, row, auth.name);
    }
    auditDetail({ after: { plan_hash: row.plan_hash, sufficient, amount_micros: amount } });
    return this.get(auth, id);
  }

  async cancel(auth: AuthContext, id: string): Promise<ActionResponse> {
    const tx = currentTx();
    const tenantId = tenantOf(auth);
    const row = await this.lock(tx, tenantId, id);
    if (!['sombra', 'aguardando_aprovacao', 'aprovada'].includes(row.status)) {
      throw new AppProblem(409, 'acao-nao-cancela', 'Não dá para cancelar', 'A ação já está em execução ou terminou.');
    }
    await tx.execute(sql`update liame.action_request set status = 'cancelada', status_reason = 'cancelada por quem opera', updated_at = now() where id = ${id}`);
    const released = await this.budget.release(tx, tenantId, id);
    await emitEvent(tx, { tenantId, type: 'liame.action.cancelled', subject: id, data: { action_id: id } });
    auditDetail({ before: { status: row.status }, after: { status: 'cancelada', released_micros: released } });
    return this.get(auth, id);
  }

  async list(auth: AuthContext, status?: ActionStatus): Promise<ActionResponse[]> {
    const tx = currentTx();
    const r = await tx.execute<ActionRow>(sql`
      select * from liame.action_request where tenant_id = ${tenantOf(auth)} ${status ? sql`and status = ${status}` : sql``}
       order by created_at desc limit 100`);
    const approvals = await this.approvalsOf(tx, r.rows.map((x) => x.id));
    return r.rows.map((row) => toResponse(row, approvals));
  }

  async get(auth: AuthContext, id: string): Promise<ActionResponse> {
    const tx = currentTx();
    const r = await tx.execute<ActionRow>(sql`select * from liame.action_request where id = ${id} and tenant_id = ${tenantOf(auth)}`);
    const row = r.rows[0];
    if (!row) throw notFound();
    return toResponse(row, await this.approvalsOf(tx, [id]));
  }

  // ------------------------------------------------------------------ sandbox

  async putSandbox(auth: AuthContext, input: SandboxResourceRequest): Promise<SandboxResourceResponse> {
    const tenantId = tenantOf(auth);
    const r = await currentTx().execute<{ state: Record<string, unknown>; version: number }>(sql`
      insert into liame.sandbox_resource (tenant_id, account_id, resource_id, state)
      values (${tenantId}, ${input.account_id}, ${input.resource_id}, ${JSON.stringify(input.state)}::jsonb)
      on conflict (tenant_id, account_id, resource_id)
        do update set state = excluded.state, version = liame.sandbox_resource.version + 1, updated_at = now()
      returning state, version`);
    auditDetail({ resourceId: `${input.account_id}/${input.resource_id}` });
    return { account_id: input.account_id, resource_id: input.resource_id, state: r.rows[0]!.state, version: r.rows[0]!.version };
  }

  // ------------------------------------------------------------------ apoio

  private resolve(toolName: string, provider: string): { tool: ToolDefinition; connector: Connector } {
    const tool = TOOLS[toolName];
    if (!tool) throw new AppProblem(400, 'ferramenta-desconhecida', 'Ferramenta desconhecida', `Não existe a ferramenta "${toolName}".`);
    const connector = CONNECTORS[provider];
    if (!connector || !tool.providers.includes(provider)) {
      throw new AppProblem(400, 'provedor-nao-suportado', 'Provedor não suportado', `A ferramenta ${tool.name} não atende o provedor "${provider}".`);
    }
    return { tool, connector };
  }

  private parseParams(tool: ToolDefinition, params: Record<string, unknown>): Record<string, unknown> {
    const parsed = tool.params.safeParse(params);
    if (!parsed.success) {
      throw new ValidationProblem(issuesToErrors(parsed.error.issues).map((e) => ({ ...e, path: `params.${e.path}` })));
    }
    return parsed.data;
  }

  private async assertNotStopped(tx: Tx, target: Parameters<KillSwitchService['check']>[1]): Promise<void> {
    const stop = await this.switches.check(tx, target);
    if (stop) {
      throw new AppProblem(423, 'parada-acionada', 'Execução parada', `Há uma trava ativa (nível ${stop.level}): ${stop.reason}`);
    }
  }

  private async assertWriteEnabled(auth: AuthContext, connector: Connector, brandId: string | null, accountId: string): Promise<void> {
    if (!connector.writeFlag) return;
    const on = await this.flags.isEnabled(connector.writeFlag, this.flags.context({ tenantId: auth.tenantId, userId: auth.userId, brandId, accountId }));
    if (!on) throw new AppProblem(403, 'escrita-desligada', 'Escrita desligada', `A escrita em ${connector.provider} não está liberada para esta conta.`);
  }

  /** Política (plataforma + empresa + marca) com a contagem recente para os limites de frequência. */
  private async decide(
    tx: Tx,
    tenantId: string,
    brandId: string | null,
    tool: ToolDefinition,
    input: { provider: string; account_id: string },
    plan: ToolPlan,
  ): Promise<PolicyDecision> {
    const { policies, timezone } = await this.policies.load(tx, tenantId, brandId);
    // Conta na maior janela entre as regras que casam (lado seguro para as janelas menores).
    const windows = policies
      .flatMap((p) => p.document.rules)
      .filter((r) => r.type === 'rate_limit' && actionMatches(r.action, plan.action) && (!r.provider || r.provider === input.provider))
      .map((r) => (r.type === 'rate_limit' ? r.window_minutes : 0));
    const window = windows.length ? Math.max(...windows) : 0;
    const recent = window
      ? await tx.execute<{ n: number }>(sql`
          select count(*)::int as n from liame.action_request
           where tenant_id = ${tenantId} and action = ${plan.action} and provider = ${input.provider} and account_id = ${input.account_id}
             and status in ('executada', 'executando', 'aprovada') and updated_at > now() - make_interval(mins => ${window})`)
      : null;
    const proposal: ActionProposal = {
      tool: tool.name,
      action: plan.action,
      brand_id: brandId,
      provider: input.provider,
      account_id: input.account_id,
      risk_level: tool.risk,
      budget_impact: plan.budgetImpact,
      value_micros: plan.valueMicros,
      current_value_micros: plan.currentValueMicros,
      categories: [],
      text: null,
      recent_count: recent?.rows[0]?.n ?? 0,
    };
    const decision = evaluatePolicy(policies, proposal, { at: new Date(), timezone });
    if (!decision.allowed) {
      throw new AppProblem(
        422,
        'politica-negou',
        'A política não permite',
        'Esta ação fere uma regra da política da empresa ou da plataforma.',
        {},
        decision.violations.map((v) => ({ path: `politica.${v.source}.${v.rule_index}`, message: v.message })),
      );
    }
    return decision;
  }

  /** Autonomia sem o autopilot ligado volta para aprovação (ADR-012: flag de escrita nasce desligada). */
  private async statusFor(mode: AutonomyMode, auth: AuthContext, brandId: string | null): Promise<{ mode: AutonomyMode; status: ActionStatus; reason: string | null }> {
    if (mode === 'SHADOW') return { mode, status: 'sombra', reason: 'modo sombra: registra, não executa' };
    if (mode === 'LIMITED_AUTO' || mode === 'AUTO') {
      const autopilot = await this.flags.isEnabled('autopilot', this.flags.context({ tenantId: auth.tenantId, userId: auth.userId, brandId }));
      if (autopilot) return { mode, status: 'aprovada', reason: 'aprovada pela política (autonomia)' };
      return { mode: 'APPROVAL', status: 'aguardando_aprovacao', reason: `autonomia ${mode} pedida, mas o autopilot está desligado` };
    }
    return { mode, status: 'aguardando_aprovacao', reason: mode === 'ESCALATE' ? 'precisa do dono' : null };
  }

  private async lock(tx: Tx, tenantId: string, id: string): Promise<ActionRow> {
    const r = await tx.execute<ActionRow>(sql`select * from liame.action_request where id = ${id} and tenant_id = ${tenantId} for update`);
    const row = r.rows[0];
    if (!row) throw notFound();
    return row;
  }

  private async assertBrand(tx: Tx, tenantId: string, brandId: string): Promise<void> {
    const b = await tx.execute(sql`select 1 from liame.brand where id = ${brandId} and tenant_id = ${tenantId}`);
    if (!b.rows[0]) throw new AppProblem(404, 'nao-encontrado', 'Não encontramos', 'Marca não encontrada nesta empresa.');
  }

  private async approvalsOf(tx: Tx, ids: string[]): Promise<ApprovalRow[]> {
    if (!ids.length) return [];
    const r = await tx.execute<ApprovalRow>(sql`
      select a.action_request_id, a.approved_by, u.name as approver_name, a.approver_role, a.sufficient, a.plan_hash, a.created_at
        from liame.approval a join liame.app_user u on u.id = a.approved_by
       where a.action_request_id in ${ids} order by a.created_at`);
    return r.rows;
  }

  private async notifyOwners(tx: Tx, tenantId: string, row: ActionRow, approverName: string): Promise<void> {
    const owners = await tx.execute<{ email: string }>(sql`
      select u.email from liame.membership m join liame.app_user u on u.id = m.user_id
       where m.tenant_id = ${tenantId} and m.role_key = 'dono' and m.revoked_at is null`);
    const text =
      `${approverName} aprovou a ação ${row.action} (${row.tool}), mas o valor de ${brl(Number(row.reserved_micros))} passa do limite dela` +
      `${row.mode === 'ESCALATE' ? ' ou a política pede a sua decisão' : ''}. Falta a sua aprovação:\n\n${this.config.appUrl}/aprovacoes/${row.id}`;
    for (const { email } of owners.rows) afterCommit(() => this.mailer.send({ to: email, subject: 'Liame: uma ação espera a sua aprovação', text }));
  }
}

export function planHashOf(
  input: { tool: string; brand_id?: string | null; provider: string; account_id: string; resource_id: string; params: Record<string, unknown> },
  plan: ToolPlan,
  beforeVersion: number,
): string {
  return sha256(
    canonicalJson({
      tool: input.tool,
      action: plan.action,
      brand_id: input.brand_id ?? null,
      provider: input.provider,
      account_id: input.account_id,
      resource_id: input.resource_id,
      params: input.params,
      value_micros: plan.valueMicros,
      current_value_micros: plan.currentValueMicros,
      desired_state: plan.desiredState,
      before_version: beforeVersion,
    }),
  );
}

function tenantOf(auth: AuthContext): string {
  if (!auth.tenantId) throw new AppProblem(403, 'sem-empresa-ativa', 'Escolha uma empresa', 'Selecione uma empresa com acesso ativo.');
  return auth.tenantId;
}

function toResponse(row: ActionRow, approvals: ApprovalRow[]): ActionResponse {
  return {
    id: row.id,
    tool: row.tool,
    action: row.action,
    brand_id: row.brand_id,
    provider: row.provider,
    account_id: row.account_id,
    resource_id: row.resource_id,
    params: row.params,
    risk_level: row.risk_level,
    budget_impact: row.budget_impact,
    value_micros: micros(row.value_micros),
    current_value_micros: micros(row.current_value_micros),
    reserved_micros: Number(row.reserved_micros),
    plan_hash: row.plan_hash,
    mode: row.mode,
    status: row.status,
    status_reason: row.status_reason,
    policy: row.policy_decision,
    approvals: approvals
      .filter((a) => a.action_request_id === row.id)
      .map((a) => ({
        approved_by: a.approved_by,
        approver_name: a.approver_name,
        approver_role: a.approver_role,
        sufficient: a.sufficient,
        current_plan: a.plan_hash === row.plan_hash,
        created_at: new Date(a.created_at).toISOString(),
      })),
    expires_at: new Date(row.expires_at).toISOString(),
    created_at: new Date(row.created_at).toISOString(),
  };
}

export { ACTIVE as ACTIVE_ACTION_STATUSES };
