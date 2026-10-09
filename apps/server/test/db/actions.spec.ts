import { resolve } from 'node:path';
import { runMigrations } from '@liame/database';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { planHashOf } from '../../src/actions/action.service.js';
import { TOOLS } from '../../src/actions/tools.js';
import { currentStep, totpCode } from '../../src/auth/totp.js';
import { FlagService } from '../../src/flags/flag.service.js';
import { codigoErrado, enableMfa, ownerQuery, PASSWORD, resetIpRateLimits, signupAndLogin, startApi, type TestApi, tokenFrom, uniqueEmail, TERMOS } from '../helpers/api.js';
import { hasDb, OWNER_URL } from './env.js';

const REAL = 1_000_000;

describe.skipIf(!hasDb)('pedido de ação: política, orçamento, fingerprint e aprovação amarrada ao plano', () => {
  let api: TestApi;

  type Person = { cookie: string; userId: string; secret: string; email: string };
  type Owner = Person & { tenantId: string; brandId: string };

  async function owner(company = 'Pizzaria das Ações'): Promise<Owner> {
    const s = await signupAndLogin(api, undefined, company);
    const { secret } = await enableMfa(api, s.cookie);
    const brands = await api.call('GET', '/v1/brands', { cookie: s.cookie });
    return { cookie: s.cookie, email: s.email, userId: s.me.user.id, secret, tenantId: s.me.active_organization_id, brandId: brands.body.items[0].id };
  }

  async function member(dono: Owner, role: string, limit: number | null): Promise<Person> {
    const email = uniqueEmail(role);
    await api.call('POST', '/v1/invitations', { cookie: dono.cookie, body: { email, role, approve_limit_micros: limit } });
    const s = await api.call('POST', '/v1/invitations/signup', { body: { token: tokenFrom(api.mailer, email), name: `Pessoa ${role}`, password: PASSWORD, terms_version: TERMOS } });
    const { secret } = await enableMfa(api, s.cookie!);
    return { cookie: s.cookie!, userId: s.body.user.id, secret, email };
  }

  /** Código do app para aprovar: o mesmo passo não vale duas vezes, então "o relógio anda" entre aprovações. */
  async function code(p: Person): Promise<string> {
    await ownerQuery(`update liame.app_user set totp_last_step = null where id = $1`, [p.userId]);
    return totpCode(p.secret, currentStep());
  }

  async function resource(dono: Owner, id = 'camp_1', budget = 100 * REAL) {
    const r = await api.call('PUT', '/v1/sandbox/resources', {
      cookie: dono.cookie,
      body: { account_id: 'act_1', resource_id: id, state: { name: `Campanha ${id}`, status: 'ativa', daily_budget_micros: budget } },
    });
    expect(r.status).toBe(200);
  }

  async function policy(dono: Owner, rules: unknown[]) {
    expect((await api.call('POST', '/v1/policies', { cookie: dono.cookie, body: { document: { rules } } })).status).toBe(201);
  }

  const request = (dono: { cookie: string }, params: Record<string, unknown>, resourceId = 'camp_1', tool = 'orcamento_ajustar') =>
    api.call('POST', '/v1/actions', { cookie: dono.cookie, body: { tool, provider: 'sandbox', account_id: 'act_1', resource_id: resourceId, params } });

  beforeAll(async () => {
    await runMigrations({ connectionString: OWNER_URL, dir: resolve(process.cwd(), '../../packages/database/migrations') });
    api = await startApi();
  });
  beforeEach(resetIpRateLimits);
  afterAll(async () => {
    await api?.close();
  });

  it('registro de ferramentas: o plano vem do estado e dos parâmetros; o hash muda com eles', () => {
    const tool = TOOLS.orcamento_ajustar!;
    const before = { daily_budget_micros: 100 * REAL, status: 'ativa' };
    const up = tool.plan(before, { daily_budget_micros: 130 * REAL });
    expect(up).toEqual({
      action: 'orcamento.aumentar',
      budgetImpact: 'increase',
      valueMicros: 130 * REAL,
      currentValueMicros: 100 * REAL,
      reserveMicros: 30 * REAL,
      desiredState: { daily_budget_micros: 130 * REAL, status: 'ativa' },
    });
    expect(tool.plan(before, { daily_budget_micros: 80 * REAL })).toMatchObject({ action: 'orcamento.reduzir', budgetImpact: 'decrease', reserveMicros: 0 });
    const input = { tool: 'orcamento_ajustar', provider: 'sandbox', account_id: 'a', resource_id: 'r', params: { daily_budget_micros: 130 * REAL } };
    expect(planHashOf(input, up, 1)).toBe(planHashOf(input, up, 1));
    expect(planHashOf(input, up, 1)).not.toBe(planHashOf(input, up, 2));
    expect(planHashOf({ ...input, params: { daily_budget_micros: 131 * REAL } }, tool.plan(before, { daily_budget_micros: 131 * REAL }), 1)).not.toBe(planHashOf(input, up, 1));
  });

  it('sem regra de autonomia, o pedido fica em sombra: registra, não reserva e não espera aprovação', async () => {
    const dono = await owner();
    await resource(dono);
    const r = await request(dono, { daily_budget_micros: 120 * REAL });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ mode: 'SHADOW', status: 'sombra', reserved_micros: 0, risk_level: 'R3', value_micros: 120 * REAL, current_value_micros: 100 * REAL });
  });

  it('pedido com política: modo, reserva, plano e evento; ferramenta, parâmetro e provedor inválidos são recusados', async () => {
    const dono = await owner();
    await resource(dono);
    await policy(dono, [{ type: 'autonomy', action: 'orcamento.*', mode: 'APPROVAL' }]);
    const r = await request(dono, { daily_budget_micros: 120 * REAL });
    expect(r.body).toMatchObject({
      tool: 'orcamento_ajustar',
      action: 'orcamento.aumentar',
      mode: 'APPROVAL',
      status: 'aguardando_aprovacao',
      reserved_micros: 20 * REAL,
      policy: { allowed: true, versions: ['plataforma@6', 'empresa@1'] },
      approvals: [],
    });
    expect(r.body.plan_hash).toMatch(/^[0-9a-f]{64}$/);
    const [ev] = await ownerQuery<{ type: string }>(`select type from liame.outbox_event where subject = $1`, [r.body.id]);
    expect(ev?.type).toBe('liame.action.requested');

    expect((await request(dono, {}, 'camp_1', 'ferramenta_x')).body.code).toBe('ferramenta-desconhecida');
    expect((await request(dono, { daily_budget_micros: 'muito' }, 'camp_2')).status).toBe(400);
    expect((await request(dono, { daily_budget_micros: 120 * REAL }, 'nao_existe')).body.code).toBe('recurso-nao-encontrado');
    const meta = await api.call('POST', '/v1/actions', {
      cookie: dono.cookie,
      body: { tool: 'orcamento_ajustar', provider: 'meta', account_id: 'act_1', resource_id: 'camp_1', params: { daily_budget_micros: 120 * REAL } },
    });
    expect(meta.body.code).toBe('provedor-nao-suportado');
  });

  it('trava ativa (423) e política que nega (422) barram o pedido', async () => {
    const dono = await owner();
    await resource(dono);
    await policy(dono, [{ type: 'max_value', max_micros: 110 * REAL }, { type: 'autonomy', mode: 'APPROVAL' }]);
    const negado = await request(dono, { daily_budget_micros: 120 * REAL });
    expect(negado).toMatchObject({ status: 422, body: { code: 'politica-negou' } });
    const stop = await api.call('POST', '/v1/kill-switches', { cookie: dono.cookie, body: { level: 'tool', tool: 'orcamento_ajustar', reason: 'revisão' } });
    const parado = await request(dono, { daily_budget_micros: 105 * REAL });
    expect(parado).toMatchObject({ status: 423, body: { code: 'parada-acionada' } });
    await api.call('DELETE', `/v1/kill-switches/${stop.body.id}`, { cookie: dono.cookie });
    expect((await request(dono, { daily_budget_micros: 105 * REAL })).status).toBe(201);
  });

  it('A1-8: action_fingerprint — um pedido ativo por ferramenta e recurso, inclusive ao mesmo tempo', async () => {
    const dono = await owner();
    await resource(dono, 'camp_a');
    await resource(dono, 'camp_b');
    await policy(dono, [{ type: 'autonomy', mode: 'APPROVAL' }]);
    const first = await request(dono, { daily_budget_micros: 110 * REAL }, 'camp_a');
    expect((await request(dono, { daily_budget_micros: 115 * REAL }, 'camp_a')).body.code).toBe('acao-duplicada');
    // Cancelado libera o recurso para um pedido novo.
    await api.call('POST', `/v1/actions/${first.body.id}/cancel`, { cookie: dono.cookie });
    expect((await request(dono, { daily_budget_micros: 115 * REAL }, 'camp_a')).status).toBe(201);

    const results = await Promise.all([1, 2, 3].map(() => request(dono, { daily_budget_micros: 110 * REAL }, 'camp_b')));
    expect(results.map((r) => r.status).sort()).toEqual([201, 409, 409]);
    const ativos = await ownerQuery(`select 1 from liame.action_request where tenant_id = $1 and resource_id = 'camp_b' and status = 'aguardando_aprovacao'`, [dono.tenantId]);
    expect(ativos).toHaveLength(1);
  });

  it('orçamento com reserva: o envelope do mês não passa do teto, nem com pedidos ao mesmo tempo; cancelar devolve', async () => {
    const dono = await owner();
    for (const id of ['c1', 'c2', 'c3', 'c4']) await resource(dono, id);
    await policy(dono, [{ type: 'autonomy', mode: 'APPROVAL' }]);
    expect((await api.call('PUT', '/v1/budget/policies', { cookie: dono.cookie, body: { limit_micros: 30 * REAL } })).status).toBe(204);

    const a = await request(dono, { daily_budget_micros: 120 * REAL }, 'c1');
    expect(a.body.reserved_micros).toBe(20 * REAL);
    const b = await request(dono, { daily_budget_micros: 120 * REAL }, 'c2');
    expect(b).toMatchObject({ status: 422, body: { code: 'orcamento-insuficiente' } });
    expect(b.body.detail).toMatch(/R\$\s?10,00 livres de R\$\s?30,00/);
    let summary = await api.call('GET', '/v1/budget', { cookie: dono.cookie });
    expect(summary.body.envelopes).toEqual([{ brand_id: null, limit_micros: 30 * REAL, committed_micros: 20 * REAL, executed_micros: 0, available_micros: 10 * REAL }]);

    await api.call('POST', `/v1/actions/${a.body.id}/cancel`, { cookie: dono.cookie });
    summary = await api.call('GET', '/v1/budget', { cookie: dono.cookie });
    expect(summary.body.envelopes[0].committed_micros).toBe(0);

    // Dois pedidos de 20 ao mesmo tempo num envelope de 30: só um passa (a linha do envelope trava).
    const both = await Promise.all([request(dono, { daily_budget_micros: 120 * REAL }, 'c3'), request(dono, { daily_budget_micros: 120 * REAL }, 'c4')]);
    expect(both.map((r) => r.status).sort()).toEqual([201, 422]);
  });

  it('A1-9 (parte do pedido): aprovação com o código do app, amarrada ao hash; plano alterado invalida; acima do limite falta o dono', async () => {
    const dono = await owner();
    await resource(dono);
    await policy(dono, [{ type: 'autonomy', mode: 'APPROVAL' }]);
    const adm = await member(dono, 'administrador', 5 * REAL);
    const pedido = await request(dono, { daily_budget_micros: 120 * REAL });
    // Falhou uma vez sob a suíte inteira com "validacao" na aprovação: o pedido não tinha id: era a trava global de outro teste (ERR-030). A conferência fica, para a causa aparecer.
    expect(pedido.status, JSON.stringify(pedido.body)).toBe(201);
    const approve = (p: Person, planHash: string, c: string) =>
      api.call('POST', `/v1/actions/${pedido.body.id}/approve`, { cookie: p.cookie, body: { plan_hash: planHash, code: c } });

    expect((await approve(adm, 'a'.repeat(64), await code(adm))).body.code).toBe('plano-mudou');
    // Falhou uma vez no CI (07/10/2026) com a resposta sem `code`, usando "000000" como código errado (ERR-114): o
    // código errado passa a ser um que o app não mostraria, e o status e o corpo ficam na mensagem.
    const recusado = await approve(adm, pedido.body.plan_hash, codigoErrado(adm.secret));
    expect(recusado.status, JSON.stringify(recusado.body)).toBe(401);
    expect(recusado.body.code).toBe('codigo-invalido');

    // "Conferir de novo" é só do pedido cujo plano muda sozinho na plataforma (a mensagem de WhatsApp): aqui, não há o
    // que conferir, e nada impede a aprovação.
    const semConferir = await api.call('POST', `/v1/actions/${pedido.body.id}/recheck`, { cookie: dono.cookie });
    expect([semConferir.status, semConferir.body.code], JSON.stringify(semConferir.body)).toEqual([409, 'acao-nao-confere']);
    expect(pedido.body.blocked_reason).toBeNull();

    // Administradora com limite de R$ 5 aprova R$ 20: registra, mas falta o dono (ADR-017).
    const parcial = await approve(adm, pedido.body.plan_hash, await code(adm));
    expect(parcial.body).toMatchObject({ status: 'aguardando_aprovacao', approvals: [{ approver_role: 'administrador', sufficient: false, current_plan: true }] });
    expect(api.mailer.lastTo(dono.email)?.subject).toBe('Liame: uma ação espera a sua aprovação');
    // O link do e-mail abre a tela Aprovações já no pedido.
    expect(api.mailer.lastTo(dono.email)?.text).toContain(`/aprovacoes?pedido=${pedido.body.id}`);

    // O plano muda: a aprovação antiga não vale para o novo.
    const alterado = await api.call('PATCH', `/v1/actions/${pedido.body.id}`, { cookie: dono.cookie, body: { params: { daily_budget_micros: 125 * REAL } } });
    expect(alterado.body.plan_hash).not.toBe(pedido.body.plan_hash);
    expect(alterado.body).toMatchObject({ reserved_micros: 25 * REAL, approvals: [{ current_plan: false }] });
    expect((await approve(dono, pedido.body.plan_hash, await code(dono))).body.code).toBe('plano-mudou');

    const ok = await approve(dono, alterado.body.plan_hash, await code(dono));
    expect(ok.body).toMatchObject({ status: 'aprovada', approvals: [{ current_plan: false }, { approver_role: 'dono', sufficient: true, current_plan: true }] });
    expect((await approve(dono, alterado.body.plan_hash, await code(dono))).body.code).toBe('acao-nao-aguarda');
    const [ev] = await ownerQuery<{ type: string }>(`select type from liame.outbox_event where subject = $1 and type = 'liame.action.approved'`, [pedido.body.id]);
    expect(ev?.type).toBe('liame.action.approved');
    const audit = await ownerQuery<{ action: string }>(`select action from liame.audit_event where chain_key = $1 and resource_id = $2 order by chain_seq`, [dono.tenantId, pedido.body.id]);
    expect(audit.map((x) => x.action)).toEqual(['acao.pedir', 'acao.aprovar', 'acao.alterar', 'acao.aprovar']);
  });

  it('ESCALATE só o dono aprova; LIMITED_AUTO sem autopilot vira aprovação, com autopilot já sai aprovada', async () => {
    const dono = await owner();
    await resource(dono, 'e1');
    await resource(dono, 'e2');
    await policy(dono, [
      { type: 'autonomy', action: 'orcamento.aumentar', up_to_percent: 10, mode: 'LIMITED_AUTO' },
      { type: 'autonomy', action: 'orcamento.aumentar', above_micros: 150 * REAL, mode: 'ESCALATE' },
    ]);
    const adm = await member(dono, 'administrador', null);
    const alto = await request(dono, { daily_budget_micros: 200 * REAL }, 'e1');
    expect(alto.body).toMatchObject({ mode: 'ESCALATE', status: 'aguardando_aprovacao', status_reason: 'precisa do dono' });
    const doAdm = await api.call('POST', `/v1/actions/${alto.body.id}/approve`, { cookie: adm.cookie, body: { plan_hash: alto.body.plan_hash, code: await code(adm) } });
    expect(doAdm.body).toMatchObject({ status: 'aguardando_aprovacao', approvals: [{ sufficient: false }] });

    const pouco = await request(dono, { daily_budget_micros: 105 * REAL }, 'e2');
    expect(pouco.body).toMatchObject({ mode: 'APPROVAL', status: 'aguardando_aprovacao', status_reason: 'autonomia LIMITED_AUTO pedida, mas o autopilot está desligado' });
    await api.call('POST', `/v1/actions/${pouco.body.id}/cancel`, { cookie: dono.cookie });

    await ownerQuery(
      `insert into liame.feature_flag_rule (id, flag_key, scope_type, scope_id, value, created_by) values (gen_random_uuid(), 'autopilot', 'tenant', $1, 'true', 'testes')`,
      [dono.tenantId],
    );
    api.app.get(FlagService).invalidate();
    const auto = await request(dono, { daily_budget_micros: 105 * REAL }, 'e2');
    expect(auto.body).toMatchObject({ mode: 'LIMITED_AUTO', status: 'aprovada' });
  });

  it('outra empresa não vê, não aprova, não altera e não cancela a ação', async () => {
    const a = await owner('Empresa A');
    const b = await owner('Empresa B');
    await resource(a);
    await policy(a, [{ type: 'autonomy', mode: 'APPROVAL' }]);
    const pedido = await request(a, { daily_budget_micros: 110 * REAL });
    const id = pedido.body.id;
    expect((await api.call('GET', `/v1/actions/${id}`, { cookie: b.cookie })).status).toBe(404);
    expect((await api.call('POST', `/v1/actions/${id}/approve`, { cookie: b.cookie, body: { plan_hash: pedido.body.plan_hash, code: await code(b) } })).status).toBe(404);
    expect((await api.call('PATCH', `/v1/actions/${id}`, { cookie: b.cookie, body: { params: { daily_budget_micros: 1 * REAL } } })).status).toBe(404);
    expect((await api.call('POST', `/v1/actions/${id}/cancel`, { cookie: b.cookie })).status).toBe(404);
    expect((await api.call('GET', '/v1/actions', { cookie: b.cookie })).body.items).toEqual([]);
  });
});
