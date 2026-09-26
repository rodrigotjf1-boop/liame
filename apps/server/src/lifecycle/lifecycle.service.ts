import type { CloseOrganizationRequest, ExportResponse, OrganizationResponse } from '@liame/contracts';
import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { activeTraceId, writeAudit } from '../audit/audit.js';
import { MfaService } from '../auth/mfa.service.js';
import { APP_CONFIG, type AppConfig } from '../config.js';
import { actorLabel } from '../context/unit-of-work.interceptor.js';
import { afterCommit, auditDetail, type AuthContext, currentTx } from '../context/request-context.js';
import { AppProblem, ValidationProblem } from '../errors/problems.js';
import { emitEvent } from '../events/outbox.js';
import { Mailer } from '../mail/mailer.js';
import { BudgetService } from '../actions/budget.service.js';

/** Dias de graça entre o pedido de encerramento e o expurgo (ADR-014). */
export const GRACE_DAYS = 30;
/** Limite por lista na exportação (a A1 não tem volume; acima disso, a exportação vira job com arquivo). */
const EXPORT_LIMIT = 50_000;

/** Encerramento da conta pelo dono, reativação e exportação (ADR-014, ADR-017). */
@Injectable()
export class LifecycleService {
  constructor(
    private readonly mfa: MfaService,
    private readonly budget: BudgetService,
    private readonly mailer: Mailer,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /** Começa os 30 dias de graça: só leitura, exportação e reativação; depois, o expurgo. */
  async close(auth: AuthContext, input: CloseOrganizationRequest): Promise<void> {
    const tx = currentTx();
    const tenantId = tenantOf(auth);
    const r = await tx.execute<{ name: string; status: OrganizationResponse['status'] }>(sql`
      select name, status from liame.organization where id = ${tenantId} for update`);
    const org = r.rows[0]!;
    if (org.status !== 'ativa') throw new AppProblem(409, 'empresa-ja-encerrando', 'Já está encerrando', 'A conta já está em encerramento.');
    if (input.confirm_name.toLocaleLowerCase('pt-BR') !== org.name.trim().toLocaleLowerCase('pt-BR')) {
      throw new ValidationProblem([{ path: 'confirm_name', message: 'Digite o nome da empresa exatamente como aparece.' }]);
    }
    await this.mfa.verifyStepUp(tx, auth.userId, input.code);
    await tx.execute(sql`
      update liame.organization
         set status = 'suspensa', suspended_at = now(), purge_after = now() + make_interval(days => ${GRACE_DAYS}),
             purge_reason = 'encerramento pedido pelo dono', updated_at = now()
       where id = ${tenantId}`);
    // Nada novo acontece durante a graça: convites em aberto caem e pedidos de ação são cancelados.
    await tx.execute(sql`update liame.invitation set revoked_at = now() where tenant_id = ${tenantId} and accepted_at is null and revoked_at is null`);
    const pending = await tx.execute<{ id: string }>(sql`
      update liame.action_request set status = 'cancelada', status_reason = 'conta em encerramento', updated_at = now()
       where tenant_id = ${tenantId} and status in ('aguardando_aprovacao', 'aprovada')
       returning id`);
    for (const a of pending.rows) await this.budget.release(tx, tenantId, a.id);
    await emitEvent(tx, { tenantId, type: 'liame.organization.closing', subject: tenantId, data: { grace_days: GRACE_DAYS } });
    auditDetail({ resourceId: tenantId, after: { status: 'suspensa', grace_days: GRACE_DAYS, cancelled_actions: pending.rows.length } });
    await this.notify(tenantId, `Liame: a conta de ${org.name} vai ser encerrada`, [
      `${auth.name} pediu o encerramento da conta de ${org.name}.`,
      `Nos próximos ${GRACE_DAYS} dias dá para ver e exportar os dados, e o dono pode reativar a conta. Depois disso, os dados são apagados de vez e a chave que os protege é destruída.`,
    ]);
  }

  async reactivate(auth: AuthContext): Promise<void> {
    const tx = currentTx();
    const tenantId = tenantOf(auth);
    const r = await tx.execute<{ name: string }>(sql`
      update liame.organization set status = 'ativa', suspended_at = null, purge_after = null, purge_reason = null, updated_at = now()
       where id = ${tenantId} and status = 'suspensa'
       returning name`);
    if (!r.rows[0]) throw new AppProblem(409, 'empresa-nao-encerrando', 'Não está encerrando', 'A conta não está em encerramento.');
    await emitEvent(tx, { tenantId, type: 'liame.organization.reactivated', subject: tenantId, data: {} });
    auditDetail({ resourceId: tenantId, after: { status: 'ativa' } });
    await this.notify(tenantId, `Liame: a conta de ${r.rows[0].name} foi reativada`, [`${auth.name} reativou a conta. O encerramento foi cancelado.`]);
  }

  /** Tudo o que é da empresa, em JSON, sem segredo, senha, token ou sessão. */
  async export(auth: AuthContext): Promise<ExportResponse> {
    const tx = currentTx();
    const tenantId = tenantOf(auth);
    const rows = async (query: ReturnType<typeof sql>) => (await tx.execute<Record<string, unknown>>(query)).rows;
    const [organization] = await rows(sql`
      select id, name, cnpj, timezone, status, suspended_at, purge_after, created_at from liame.organization where id = ${tenantId}`);
    const data: ExportResponse['data'] = {
      brands: await rows(sql`select id, name, archived_at, purge_after, created_at from liame.brand where tenant_id = ${tenantId} limit ${EXPORT_LIMIT}`),
      members: await rows(sql`
        select m.id, u.name, u.email, m.role_key as role, m.approve_limit_micros, m.dual_approval, m.billing_access, m.expires_at,
               m.created_at, m.revoked_at
          from liame.membership m join liame.app_user u on u.id = m.user_id where m.tenant_id = ${tenantId} limit ${EXPORT_LIMIT}`),
      invitations: await rows(sql`
        select id, email, role_key as role, approve_limit_micros, expires_at, accepted_at, revoked_at, created_at
          from liame.invitation where tenant_id = ${tenantId} limit ${EXPORT_LIMIT}`),
      policies: await rows(sql`select id, brand_id, version, status, document, created_at from liame.policy where tenant_id = ${tenantId} limit ${EXPORT_LIMIT}`),
      budget_policies: await rows(sql`select brand_id, limit_micros, updated_at from liame.budget_policy where tenant_id = ${tenantId}`),
      budget_ledger: await rows(sql`
        select period, brand_id, action_request_id, kind, amount_micros, created_at
          from liame.budget_ledger_entry where tenant_id = ${tenantId} order by created_at limit ${EXPORT_LIMIT}`),
      actions: await rows(sql`
        select id, brand_id, tool, action, provider, account_id, resource_id, params, risk_level, budget_impact, value_micros,
               current_value_micros, reserved_micros, plan_hash, mode, status, status_reason, created_at, updated_at
          from liame.action_request where tenant_id = ${tenantId} order by created_at limit ${EXPORT_LIMIT}`),
      approvals: await rows(sql`
        select action_request_id, approved_by, approver_role, sufficient, plan_hash, created_at
          from liame.approval where tenant_id = ${tenantId} limit ${EXPORT_LIMIT}`),
      executions: await rows(sql`
        select action_request_id, status, error, provider_version, started_at, finished_at
          from liame.action_execution where tenant_id = ${tenantId} limit ${EXPORT_LIMIT}`),
      webhook_endpoints: await rows(sql`select id, url, description, event_types, created_at, disabled_at from liame.webhook_endpoint where tenant_id = ${tenantId}`),
      kill_switches: await rows(sql`
        select id, level, provider, brand_id, account_id, tool, reason, activated_at, deactivated_at from liame.kill_switch where tenant_id = ${tenantId}`),
      audit_events: await rows(sql`
        select chain_seq as seq, occurred_at, actor_type, actor_label, action, resource_type, resource_id, before, after, reason, hash
          from liame.audit_event where chain_key = ${tenantId} and tenant_id = ${tenantId} order by chain_seq limit ${EXPORT_LIMIT}`),
    };
    // Exportar tudo é sensível: fica na auditoria, na mesma transação.
    await writeAudit(tx, {
      tenantId,
      actorType: 'human',
      actorId: auth.userId,
      actorLabel: actorLabel(auth),
      actorRole: auth.roleKey,
      action: 'dados.exportar',
      resourceType: 'organization',
      resourceId: tenantId,
      after: Object.fromEntries(Object.entries(data).map(([k, v]) => [k, v.length])),
      traceId: activeTraceId(),
      origin: 'api',
    });
    return { format: 'liame-export', version: 1, generated_at: new Date().toISOString(), organization: organization ?? {}, data };
  }

  private async notify(tenantId: string, subject: string, lines: string[]): Promise<void> {
    const people = await currentTx().execute<{ email: string }>(sql`
      select u.email from liame.membership m join liame.app_user u on u.id = m.user_id
       where m.tenant_id = ${tenantId} and m.role_key in ('dono', 'administrador') and m.revoked_at is null`);
    const text = `${lines.join('\n\n')}\n\n${this.config.appUrl}`;
    for (const { email } of people.rows) afterCommit(() => this.mailer.send({ to: email, subject, text }));
  }
}

function tenantOf(auth: AuthContext): string {
  if (!auth.tenantId) throw new AppProblem(403, 'sem-empresa-ativa', 'Escolha uma empresa', 'Selecione uma empresa com acesso ativo.');
  return auth.tenantId;
}
