import { resolve } from 'node:path';
import { type Database, runMigrations } from '@liame/database';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { BudgetService } from '../../src/actions/budget.service.js';
import { currentStep, totpCode } from '../../src/auth/totp.js';
import { DATABASE } from '../../src/database/database.module.js';
import { FlagService } from '../../src/flags/flag.service.js';
import { KillSwitchService } from '../../src/kill-switch/kill-switch.service.js';
import { ActionExecutor } from '../../src/worker/action-executor.js';
import { enableMfa, ownerQuery, resetIpRateLimits, signupAndLogin, startApi, type TestApi } from '../helpers/api.js';
import { hasDb, OWNER_URL } from './env.js';

const REAL = 1_000_000;

describe.skipIf(!hasDb)('execução de ações no worker e workflow durável (A1-9)', () => {
  let api: TestApi;
  let database: Database;
  let executor: ActionExecutor;

  type Owner = { cookie: string; userId: string; secret: string; tenantId: string };

  async function owner(company = 'Pizzaria da Execução'): Promise<Owner> {
    const s = await signupAndLogin(api, undefined, company);
    const { secret } = await enableMfa(api, s.cookie);
    await api.call('POST', '/v1/policies', { cookie: s.cookie, body: { document: { rules: [{ type: 'autonomy', mode: 'APPROVAL' }] } } });
    return { cookie: s.cookie, userId: s.me.user.id, secret, tenantId: s.me.active_organization_id };
  }

  async function sandbox(dono: Owner, id = 'camp_1', budget = 100 * REAL) {
    const r = await api.call('PUT', '/v1/sandbox/resources', {
      cookie: dono.cookie,
      body: { account_id: 'act_1', resource_id: id, state: { name: `Campanha ${id}`, status: 'ativa', daily_budget_micros: budget } },
    });
    return r.body as { state: Record<string, unknown>; version: number };
  }

  async function requestAndApprove(dono: Owner, value: number, resourceId = 'camp_1') {
    const pedido = await api.call('POST', '/v1/actions', {
      cookie: dono.cookie,
      body: { tool: 'orcamento_ajustar', provider: 'sandbox', account_id: 'act_1', resource_id: resourceId, params: { daily_budget_micros: value } },
    });
    expect(pedido.status).toBe(201);
    await ownerQuery(`update liame.app_user set totp_last_step = null where id = $1`, [dono.userId]);
    const ok = await api.call('POST', `/v1/actions/${pedido.body.id}/approve`, {
      cookie: dono.cookie,
      body: { plan_hash: pedido.body.plan_hash, code: totpCode(dono.secret, currentStep()) },
    });
    expect(ok.body.status).toBe('aprovada');
    return pedido.body as { id: string; plan_hash: string };
  }

  const getAction = (dono: Owner, id: string) => api.call('GET', `/v1/actions/${id}`, { cookie: dono.cookie });
  const cycle = (dono: Owner) => executor.runCycle(20, { tenantIds: [dono.tenantId] });

  beforeAll(async () => {
    await runMigrations({ connectionString: OWNER_URL, dir: resolve(process.cwd(), '../../packages/database/migrations') });
    api = await startApi();
    database = api.app.get(DATABASE);
    executor = new ActionExecutor(database, api.app.get(BudgetService), api.app.get(KillSwitchService), api.app.get(FlagService));
  });
  beforeEach(resetIpRateLimits);
  afterAll(async () => {
    await api?.close();
  });

  it('A1-9 ponta a ponta: política → orçamento (reserva) → aprovação amarrada ao hash → execução no sandbox → auditoria', async () => {
    const dono = await owner();
    await sandbox(dono);
    await api.call('PUT', '/v1/budget/policies', { cookie: dono.cookie, body: { limit_micros: 50 * REAL } });
    const acao = await requestAndApprove(dono, 130 * REAL);

    expect(await cycle(dono)).toBe(1);
    const final = await getAction(dono, acao.id);
    expect(final.body).toMatchObject({
      status: 'executada',
      status_reason: null,
      workflow: {
        status: 'concluido',
        steps: [
          { name: 'politica', status: 'concluido' },
          { name: 'orcamento', status: 'concluido' },
          { name: 'aprovacao', status: 'concluido' },
          { name: 'execucao', status: 'concluido' },
        ],
      },
    });
    // O provedor (sandbox) mudou de verdade, uma versão a mais.
    const [res] = await ownerQuery<{ state: Record<string, unknown>; version: number }>(
      `select state, version from liame.sandbox_resource where tenant_id = $1 and resource_id = 'camp_1'`,
      [dono.tenantId],
    );
    expect(res).toMatchObject({ state: { daily_budget_micros: 130 * REAL, status: 'ativa' }, version: 2 });
    const [exec] = await ownerQuery<{ status: string; plan_hash: string; provider_version: number }>(
      `select status, plan_hash, provider_version from liame.action_execution where action_request_id = $1`,
      [acao.id],
    );
    expect(exec).toEqual({ status: 'executada', plan_hash: acao.plan_hash, provider_version: 2 });
    // Orçamento: reservado e executado.
    const budget = await api.call('GET', '/v1/budget', { cookie: dono.cookie });
    expect(budget.body.envelopes[0]).toMatchObject({ committed_micros: 30 * REAL, executed_micros: 30 * REAL, available_micros: 20 * REAL });
    // Auditoria: quem pediu, quem aprovou e o sistema executando em nome da aprovação.
    const audit = await ownerQuery<{ action: string; actor_type: string; approval_id: string | null; origin: string }>(
      `select action, actor_type, approval_id, origin from liame.audit_event where chain_key = $1 and resource_id = $2 order by chain_seq`,
      [dono.tenantId, acao.id],
    );
    expect(audit.map((a) => [a.action, a.actor_type, a.origin])).toEqual([
      ['acao.pedir', 'human', 'api'],
      ['acao.aprovar', 'human', 'api'],
      ['acao.executar', 'system', 'worker'],
    ]);
    expect(audit[2]!.approval_id).not.toBeNull();
    expect((await api.call('GET', '/v1/audit/verify', { cookie: dono.cookie })).body.ok).toBe(true);
    const events = await ownerQuery<{ type: string }>(`select type from liame.outbox_event where subject = $1 order by created_at`, [acao.id]);
    expect(events.map((e) => e.type)).toEqual(['liame.action.requested', 'liame.action.approved', 'liame.action.executed']);
  });

  it('estado mudou depois do pedido: não sobrescreve, falha com o motivo e devolve a reserva', async () => {
    const dono = await owner();
    await sandbox(dono);
    const acao = await requestAndApprove(dono, 130 * REAL);
    // Alguém mexeu no recurso pelo gerenciador da plataforma.
    await sandbox(dono, 'camp_1', 90 * REAL);
    await cycle(dono);
    const final = await getAction(dono, acao.id);
    expect(final.body).toMatchObject({ status: 'falhou', status_reason: 'o recurso mudou desde o pedido; nada foi sobrescrito', workflow: { status: 'falhou' } });
    const [res] = await ownerQuery<{ state: { daily_budget_micros: number } }>(`select state from liame.sandbox_resource where tenant_id = $1`, [dono.tenantId]);
    expect(res!.state.daily_budget_micros).toBe(90 * REAL);
    const [ledger] = await ownerQuery<{ open: string }>(
      `select sum(case kind when 'reserva' then amount_micros when 'liberacao' then -amount_micros else 0 end)::text as open
         from liame.budget_ledger_entry where action_request_id = $1`,
      [acao.id],
    );
    expect(Number(ledger!.open)).toBe(0);
    const [ex] = await ownerQuery<{ status: string }>(`select status from liame.action_execution where action_request_id = $1`, [acao.id]);
    expect(ex?.status).toBe('estado_mudou');
  });

  it('trava acionada depois da aprovação barra a execução; aprovação que não é do plano atual não executa', async () => {
    const dono = await owner();
    await sandbox(dono, 'c1');
    await sandbox(dono, 'c2');
    const a = await requestAndApprove(dono, 120 * REAL, 'c1');
    const stop = await api.call('POST', '/v1/kill-switches', { cookie: dono.cookie, body: { level: 'tenant', reason: 'pausa de segurança' } });
    await cycle(dono);
    expect((await getAction(dono, a.id)).body).toMatchObject({ status: 'falhou', status_reason: 'trava ativa (tenant): pausa de segurança' });
    await api.call('DELETE', `/v1/kill-switches/${stop.body.id}`, { cookie: dono.cookie });

    // Alguém força o status no banco com o plano trocado: sem aprovação para o hash atual, não executa.
    const b = await requestAndApprove(dono, 120 * REAL, 'c2');
    await ownerQuery(`update liame.action_request set plan_hash = repeat('f', 64) where id = $1`, [b.id]);
    await cycle(dono);
    expect((await getAction(dono, b.id)).body).toMatchObject({ status: 'falhou', status_reason: 'sem aprovação válida para o plano atual' });
    const [res] = await ownerQuery<{ state: { daily_budget_micros: number } }>(`select state from liame.sandbox_resource where tenant_id = $1 and resource_id = 'c2'`, [dono.tenantId]);
    expect(res!.state.daily_budget_micros).toBe(100 * REAL);
  });

  it('pedido sem aprovação no prazo expira e devolve a reserva; execução travada volta para a fila', async () => {
    const dono = await owner();
    await sandbox(dono, 'x1');
    await sandbox(dono, 'x2');
    const pedido = await api.call('POST', '/v1/actions', {
      cookie: dono.cookie,
      body: { tool: 'orcamento_ajustar', provider: 'sandbox', account_id: 'act_1', resource_id: 'x1', params: { daily_budget_micros: 150 * REAL } },
    });
    await ownerQuery(`update liame.action_request set expires_at = now() - interval '1 second' where id = $1`, [pedido.body.id]);
    await cycle(dono);
    expect((await getAction(dono, pedido.body.id)).body).toMatchObject({ status: 'expirada', workflow: { status: 'falhou' } });
    const [audit] = await ownerQuery<{ action: string }>(`select action from liame.audit_event where resource_id = $1 order by chain_seq desc limit 1`, [pedido.body.id]);
    expect(audit?.action).toBe('acao.expirar');

    const travada = await requestAndApprove(dono, 110 * REAL, 'x2');
    await ownerQuery(`update liame.action_request set status = 'executando', updated_at = now() - interval '11 minutes' where id = $1`, [travada.id]);
    await cycle(dono);
    expect((await getAction(dono, travada.id)).body.status).toBe('executada');
  });

  it('dois workers ao mesmo tempo executam a ação uma vez só (SKIP LOCKED)', async () => {
    const dono = await owner();
    await sandbox(dono);
    const acao = await requestAndApprove(dono, 115 * REAL);
    const other = new ActionExecutor(database, api.app.get(BudgetService), api.app.get(KillSwitchService), api.app.get(FlagService));
    const [n1, n2] = await Promise.all([executor.executeBatch(20, { tenantIds: [dono.tenantId] }), other.executeBatch(20, { tenantIds: [dono.tenantId] })]);
    expect(n1 + n2).toBe(1);
    const execs = await ownerQuery(`select 1 from liame.action_execution where action_request_id = $1`, [acao.id]);
    expect(execs).toHaveLength(1);
    const [res] = await ownerQuery<{ version: number }>(`select version from liame.sandbox_resource where tenant_id = $1`, [dono.tenantId]);
    expect(res!.version).toBe(2);
  });
});
