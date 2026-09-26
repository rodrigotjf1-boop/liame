import { type Database, type Tx, uuidv7, withSystem, withTenant } from '@liame/database';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { ActionRow } from '../actions/action.service.js';
import { BudgetService } from '../actions/budget.service.js';
import { CONNECTORS } from '../actions/connectors.js';
import { writeAudit } from '../audit/audit.js';
import { DATABASE } from '../database/database.module.js';
import { emitEvent } from '../events/outbox.js';
import { FlagService } from '../flags/flag.service.js';
import { KillSwitchService } from '../kill-switch/kill-switch.service.js';
import { advance } from '../workflow/workflow.js';
import { type JobScope, tenantFilter } from './outbox-publisher.js';

/** Execução travada por mais que isto (worker caiu no meio) volta para a fila. */
const STUCK_MINUTES = 10;

type Outcome = { status: 'executada' | 'falhou' | 'estado_mudou' | 'bloqueada'; reason: string | null; result?: Record<string, unknown>; version?: number };

/**
 * Action Service, lado da execução (ADR-007): pega as ações aprovadas (SKIP LOCKED) e, na hora de
 * executar, confere tudo de novo: trava, flag de escrita, aprovação válida para o plano atual e o
 * estado no provedor. Se o estado mudou desde o pedido, alguém mexeu: não sobrescreve.
 */
@Injectable()
export class ActionExecutor {
  private readonly logger = new Logger('acoes');

  constructor(
    @Inject(DATABASE) private readonly database: Database | null,
    private readonly budget: BudgetService,
    private readonly switches: KillSwitchService,
    private readonly flags: FlagService,
  ) {}

  private get db() {
    if (!this.database) throw new Error('acoes: sem banco');
    return this.database.db;
  }

  /** Um ciclo: devolve à fila as travadas, expira as vencidas e executa um lote. */
  async runCycle(limit = 20, scope: JobScope = {}): Promise<number> {
    if (!this.database) return 0;
    await this.requeueStuck(scope);
    await this.expirePending(scope);
    return this.executeBatch(limit, scope);
  }

  async executeBatch(limit = 20, scope: JobScope = {}): Promise<number> {
    const claimed = await withSystem(this.db, async (tx) => {
      const r = await tx.execute<{ id: string; tenant_id: string }>(sql`
        select id, tenant_id from liame.action_request
         where status = 'aprovada' ${tenantFilter(scope, sql`tenant_id`)}
         order by updated_at limit ${limit}
         for update skip locked`);
      if (r.rows.length) {
        await tx.execute(sql`update liame.action_request set status = 'executando', updated_at = now() where id in ${r.rows.map((x) => x.id)}`);
      }
      return r.rows;
    });
    for (const c of claimed) {
      try {
        await this.executeOne(c.tenant_id, c.id);
      } catch (err) {
        // Erro inesperado: a ação volta para 'aprovada' pelo requeue depois do prazo; o motivo fica no log.
        this.logger.error(`ação ${c.id} falhou ao executar: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return claimed.length;
  }

  /** Executa uma ação sob o contexto da empresa dela (RLS), numa transação só com o registro. */
  private async executeOne(tenantId: string, id: string): Promise<void> {
    await withTenant(this.db, tenantId, async (tx) => {
      const r = await tx.execute<ActionRow>(sql`select * from liame.action_request where id = ${id} and status = 'executando' for update`);
      const row = r.rows[0];
      if (!row) return;
      const startedAt = new Date().toISOString();
      const approval = await this.validApproval(tx, row);
      const outcome = await this.run(tx, row, approval);

      await tx.execute(sql`
        insert into liame.action_execution (id, tenant_id, action_request_id, plan_hash, expected_state, expected_version, observed_state,
                                            desired_state, result_state, provider_version, status, error, started_at)
        values (${uuidv7()}, ${tenantId}, ${id}, ${row.plan_hash}, ${JSON.stringify(row.before_state)}::jsonb, ${row.before_version},
                ${outcome.status === 'estado_mudou' ? JSON.stringify(outcome.result ?? null) : null}::jsonb,
                ${JSON.stringify(row.desired_state)}::jsonb,
                ${outcome.status === 'executada' ? JSON.stringify(outcome.result ?? null) : null}::jsonb,
                ${outcome.version ?? null}, ${outcome.status}, ${outcome.reason}, ${startedAt})`);

      const ok = outcome.status === 'executada';
      await tx.execute(sql`
        update liame.action_request set status = ${ok ? 'executada' : 'falhou'}, status_reason = ${outcome.reason}, updated_at = now()
         where id = ${id}`);
      if (ok) {
        await this.budget.executed(tx, { tenantId, brandId: row.brand_id, actionId: id, amountMicros: Number(row.reserved_micros) });
      } else {
        await this.budget.release(tx, tenantId, id);
      }
      await advance(tx, {
        tenantId,
        kind: 'acao',
        subjectId: id,
        steps: [{ name: 'execucao', status: ok ? 'concluido' : 'falhou', output: { status: outcome.status, reason: outcome.reason } }],
        run: ok ? 'concluido' : 'falhou',
      });
      await emitEvent(tx, {
        tenantId,
        type: ok ? 'liame.action.executed' : 'liame.action.failed',
        subject: id,
        data: { action_id: id, status: outcome.status, reason: outcome.reason },
      });
      // Quem executou foi o sistema, em nome da aprovação registrada (ADR-017: o ator real fica na aprovação).
      await writeAudit(tx, {
        tenantId,
        actorType: 'system',
        actorId: null,
        actorLabel: 'Liame (execução)',
        action: ok ? 'acao.executar' : 'acao.falhar',
        resourceType: 'action_request',
        resourceId: id,
        before: row.before_state,
        after: ok ? (outcome.result ?? null) : { status: outcome.status, reason: outcome.reason },
        approvalId: approval,
        tool: row.tool,
        origin: 'worker',
      });
    });
  }

  /** As checagens da hora e a escrita no provedor. */
  private async run(tx: Tx, row: ActionRow, approvalId: string | null): Promise<Outcome> {
    const stop = await this.switches.check(tx, {
      tenantId: row.tenant_id,
      provider: row.provider,
      brandId: row.brand_id,
      accountId: row.account_id,
      tool: row.tool,
    });
    if (stop) return { status: 'bloqueada', reason: `trava ativa (${stop.level}): ${stop.reason}` };
    if (!approvalId && !(await this.autoApproved(row))) return { status: 'bloqueada', reason: 'sem aprovação válida para o plano atual' };
    const connector = CONNECTORS[row.provider];
    if (!connector) return { status: 'falhou', reason: `provedor ${row.provider} sem connector` };
    if (connector.writeFlag) {
      const on = await this.flags.isEnabled(connector.writeFlag, this.flags.context({ tenantId: row.tenant_id, brandId: row.brand_id, accountId: row.account_id }));
      if (!on) return { status: 'bloqueada', reason: `escrita em ${row.provider} desligada` };
    }
    const ref = { tenantId: row.tenant_id, accountId: row.account_id, resourceId: row.resource_id };
    const expected = row.before_version ?? 0;
    // Primeiro valida (quando o provedor oferece), depois aplica.
    const check = await connector.apply(tx, ref, row.desired_state, expected, { validateOnly: true });
    if (!check.ok) return { status: 'estado_mudou', reason: 'o recurso mudou desde o pedido; nada foi sobrescrito', result: check.current.state };
    const applied = await connector.apply(tx, ref, row.desired_state, expected);
    if (!applied.ok) return { status: 'estado_mudou', reason: 'o recurso mudou desde o pedido; nada foi sobrescrito', result: applied.current.state };
    return { status: 'executada', reason: null, result: applied.state, version: applied.version };
  }

  /** Aprovação suficiente para o hash atual do plano, ou nula. */
  private async validApproval(tx: Tx, row: ActionRow): Promise<string | null> {
    const r = await tx.execute<{ id: string }>(sql`
      select id from liame.approval
       where action_request_id = ${row.id} and plan_hash = ${row.plan_hash} and sufficient
       order by created_at desc limit 1`);
    return r.rows[0]?.id ?? null;
  }

  /** Aprovada pela política (autonomia) e o autopilot continua ligado agora. */
  private async autoApproved(row: ActionRow): Promise<boolean> {
    if (row.mode !== 'LIMITED_AUTO' && row.mode !== 'AUTO') return false;
    return this.flags.isEnabled('autopilot', this.flags.context({ tenantId: row.tenant_id, brandId: row.brand_id }));
  }

  /** Pedido que ninguém aprovou no prazo expira e devolve a reserva. */
  async expirePending(scope: JobScope = {}): Promise<number> {
    const expired = await withSystem(this.db, (tx) =>
      tx.execute<{ id: string; tenant_id: string }>(sql`
        update liame.action_request set status = 'expirada', status_reason = 'ninguém aprovou no prazo', updated_at = now()
         where status = 'aguardando_aprovacao' and expires_at <= now() ${tenantFilter(scope, sql`tenant_id`)}
         returning id, tenant_id`),
    );
    for (const e of expired.rows) {
      await withTenant(this.db, e.tenant_id, async (tx) => {
        await this.budget.release(tx, e.tenant_id, e.id);
        await advance(tx, { tenantId: e.tenant_id, kind: 'acao', subjectId: e.id, steps: [{ name: 'aprovacao', status: 'falhou', output: { motivo: 'expirou' } }], run: 'falhou' });
        await writeAudit(tx, {
          tenantId: e.tenant_id,
          actorType: 'system',
          actorId: null,
          actorLabel: 'Liame (prazo)',
          action: 'acao.expirar',
          resourceType: 'action_request',
          resourceId: e.id,
          origin: 'worker',
        });
      });
    }
    return expired.rows.length;
  }

  /** Execução que ficou travada (worker caiu antes do commit) volta para a fila. */
  async requeueStuck(scope: JobScope = {}): Promise<number> {
    const r = await withSystem(this.db, (tx) =>
      tx.execute(sql`
        update liame.action_request set status = 'aprovada', updated_at = now()
         where status = 'executando' and updated_at < now() - make_interval(mins => ${STUCK_MINUTES}) ${tenantFilter(scope, sql`tenant_id`)}`),
    );
    return r.rowCount ?? 0;
  }
}
