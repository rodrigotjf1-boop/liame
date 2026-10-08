import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { applyContext, type Database, runMigrations, withContext, withSystem } from '@liame/database';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DATABASE } from '../../src/database/database.module.js';
import { FlagService } from '../../src/flags/flag.service.js';
import { type ActionTarget, KillSwitchService } from '../../src/kill-switch/kill-switch.service.js';
import { enableMfa, ownerQuery, resetIpRateLimits, signupAndLogin, startApi, type TestApi } from '../helpers/api.js';
import { hasDb, OWNER_URL } from './env.js';

describe.skipIf(!hasDb)('feature flags (A1-12) e kill switch (A1-10)', () => {
  let api: TestApi;
  let database: Database;
  let flags: FlagService;
  let switches: KillSwitchService;

  async function owner(company = 'Empresa das Travas') {
    const s = await signupAndLogin(api, undefined, company);
    await enableMfa(api, s.cookie);
    return { ...s, tenantId: s.me.active_organization_id as string, userId: s.me.user.id as string };
  }

  /** Flag só desta execução (o banco de testes é compartilhado). */
  async function newFlag(isWrite = false) {
    const key = `teste_${randomBytes(4).toString('hex')}`;
    await ownerQuery(
      `insert into liame.feature_flag (key, kind, default_value, description, owner, is_write) values ($1, 'boolean', 'false', 'teste', 'testes', $2)`,
      [key, isWrite],
    );
    flags.invalidate();
    return key;
  }
  async function addRule(key: string, scopeType: string, scopeId: string, value: boolean, rollout: number | null = null) {
    await ownerQuery(
      `insert into liame.feature_flag_rule (id, flag_key, scope_type, scope_id, value, rollout_percent, created_by)
       values (gen_random_uuid(), $1, $2, $3, $4::jsonb, $5, 'testes')`,
      [key, scopeType, scopeId, JSON.stringify(value), rollout],
    );
    flags.invalidate();
  }

  beforeAll(async () => {
    await runMigrations({ connectionString: OWNER_URL, dir: resolve(process.cwd(), '../../packages/database/migrations') });
    api = await startApi();
    database = api.app.get(DATABASE);
    flags = api.app.get(FlagService);
    switches = api.app.get(KillSwitchService);
  });
  beforeEach(resetIpRateLimits);
  afterAll(async () => {
    await api?.close();
  });

  it('A1-12: as flags de escrita nascem desligadas, e o banco não aceita uma de escrita ligada por padrão', async () => {
    const seeded = await ownerQuery<{ key: string; default_value: boolean }>(
      `select key, default_value from liame.feature_flag where is_write and key not like 'teste_%' order by key`,
    );
    // `conversoes_google` (A5, Y1): informar venda ao Google também é mandar dado para uma plataforma.
    expect(seeded.map((f) => f.key)).toEqual(['autopilot', 'conversoes_google', 'creative_generation', 'google_write', 'mcp_write', 'meta_write', 'regem_write', 'whatsapp_campaign']);
    expect(seeded.every((f) => f.default_value === false)).toBe(true);
    await expect(
      ownerQuery(`insert into liame.feature_flag (key, kind, default_value, description, owner, is_write) values ('ligada_errada', 'boolean', 'true', 'x', 'x', true)`),
    ).rejects.toThrow(/feature_flag_check/);
    const dono = await owner();
    expect(await flags.isEnabled('meta_write', flags.context({ tenantId: dono.tenantId, userId: dono.userId }))).toBe(false);
  });

  it('A1-12: avaliada por ambiente, empresa, marca, conta e pessoa, pelo OpenFeature', async () => {
    const [a, b] = [await owner('Empresa A'), await owner('Empresa B')];
    const key = await newFlag(true);
    const ctxA = flags.context({ tenantId: a.tenantId, userId: a.userId });
    const ctxB = flags.context({ tenantId: b.tenantId, userId: b.userId });
    expect(await flags.isEnabled(key, ctxA)).toBe(false);

    await addRule(key, 'environment', 'test', true);
    expect([await flags.isEnabled(key, ctxA), await flags.isEnabled(key, ctxB)]).toEqual([true, true]);
    await addRule(key, 'tenant', b.tenantId, false);
    expect([await flags.isEnabled(key, ctxA), await flags.isEnabled(key, ctxB)]).toEqual([true, false]);
    await addRule(key, 'brand', 'marca-x', false);
    expect(await flags.isEnabled(key, { ...ctxA, brandId: 'marca-x' })).toBe(false);
    await addRule(key, 'account', 'conta-meta-1', true);
    expect(await flags.isEnabled(key, { ...ctxB, accountId: 'conta-meta-1' })).toBe(true);
    await addRule(key, 'user', b.userId, true);
    expect(await flags.isEnabled(key, ctxB)).toBe(true);
    // Flag que não existe cai no padrão do código (desligada), sem erro.
    expect(await flags.isEnabled('nao_existe', ctxA)).toBe(false);
  });

  it('OFREP: o front recebe só valores avaliados para a sessão, com ETag; marca de outra empresa é recusada', async () => {
    const [a, b] = [await owner('Empresa A'), await owner('Empresa B')];
    const key = await newFlag();
    await addRule(key, 'tenant', a.tenantId, true);
    const bulk = await api.call('POST', '/v1/ofrep/v1/evaluate/flags', { cookie: a.cookie, body: { context: { targetingKey: 'qualquer', tenantId: b.tenantId } } });
    expect(bulk.status).toBe(200);
    // O tenant do contexto enviado é ignorado: vale a sessão.
    expect(bulk.body.flags.find((f: { key: string }) => f.key === key)).toEqual({ key, value: true, reason: 'TARGETING_MATCH', variant: 'tenant' });
    expect(bulk.body.flags.find((f: { key: string }) => f.key === 'meta_write')).toMatchObject({ value: false, reason: 'STATIC' });
    expect(JSON.stringify(bulk.body)).not.toContain(b.tenantId);

    const etag = bulk.headers.get('etag')!;
    const again = await api.call('POST', '/v1/ofrep/v1/evaluate/flags', { cookie: a.cookie, body: { context: { targetingKey: 'x' } }, headers: { 'If-None-Match': etag } });
    expect(again.status).toBe(304);
    const other = await api.call('POST', '/v1/ofrep/v1/evaluate/flags', { cookie: b.cookie, body: { context: { targetingKey: 'x' } }, headers: { 'If-None-Match': etag } });
    expect(other.status).toBe(200);
    expect(other.body.flags.find((f: { key: string }) => f.key === key).value).toBe(false);

    const one = await api.call('POST', `/v1/ofrep/v1/evaluate/flags/${key}`, { cookie: a.cookie, body: { context: { targetingKey: 'x' } } });
    expect(one.body).toEqual({ key, value: true, reason: 'TARGETING_MATCH', variant: 'tenant' });
    const missing = await api.call('POST', '/v1/ofrep/v1/evaluate/flags/nao_existe', { cookie: a.cookie, body: { context: { targetingKey: 'x' } } });
    expect(missing).toMatchObject({ status: 404, body: { key: 'nao_existe', errorCode: 'FLAG_NOT_FOUND' } });

    const brandB = await api.call('GET', '/v1/brands', { cookie: b.cookie });
    const probe = await api.call('POST', '/v1/ofrep/v1/evaluate/flags', { cookie: a.cookie, body: { context: { targetingKey: 'x', brandId: brandB.body.items[0].id } } });
    expect(probe.body.code).toBe('marca-invalida');
  });

  it('A1-10: cada nível trava a execução; outra empresa não é afetada; desligar libera', async () => {
    const [a, b] = [await owner('Empresa A'), await owner('Empresa B')];
    const brandA = (await api.call('GET', '/v1/brands', { cookie: a.cookie })).body.items[0].id as string;
    const target: ActionTarget = { tenantId: a.tenantId, provider: 'meta', brandId: brandA, accountId: 'act_123', tool: 'campanha_orcamento_ajustar' };
    const check = (t = target, who = a) => withContext(database.db, { tenantId: who.tenantId, userId: who.userId }, (tx) => switches.check(tx, t));
    expect(await check()).toBeNull();

    const levels: Array<[string, Record<string, unknown>]> = [
      ['tenant', {}],
      ['brand', { brand_id: brandA }],
      ['account', { provider: 'meta', account_id: 'act_123' }],
      ['tool', { tool: 'campanha_orcamento_ajustar' }],
    ];
    for (const [level, extra] of levels) {
      const on = await api.call('POST', '/v1/kill-switches', { cookie: a.cookie, body: { level, reason: `teste ${level}`, ...extra } });
      expect(on.status).toBe(201);
      expect(await check()).toMatchObject({ level, reason: `teste ${level}` });
      // A trava da empresa A não pega a empresa B.
      expect(await check({ ...target, tenantId: b.tenantId, brandId: null }, b)).toBeNull();
      expect((await api.call('DELETE', `/v1/kill-switches/${on.body.id}`, { cookie: a.cookie })).status).toBe(204);
      expect(await check()).toBeNull();
    }
    // Conta e ferramenta diferentes não são pegas pela trava de outra conta/ferramenta.
    const acc = await api.call('POST', '/v1/kill-switches', { cookie: a.cookie, body: { level: 'account', provider: 'meta', account_id: 'act_999', reason: 'outra conta' } });
    expect(await check()).toBeNull();
    await api.call('DELETE', `/v1/kill-switches/${acc.body.id}`, { cookie: a.cookie });

    // Global e provedor são da distribuição: pegam todas as empresas. A global roda numa transação que
    // se desfaz no fim: confirmada, ela travaria as ações dos outros arquivos de teste que rodam ao mesmo
    // tempo no banco compartilhado (actions.spec recebia 423 "teste global").
    const DESFAZER = new Error('desfazer');
    await expect(
      withSystem(database.db, async (tx) => {
        await switches.activateSystem(tx, { level: 'global', reason: 'teste global' });
        await applyContext(tx, { tenantId: a.tenantId, userId: a.userId });
        expect(await switches.check(tx, target)).toMatchObject({ level: 'global' });
        await applyContext(tx, { tenantId: b.tenantId, userId: b.userId });
        expect(await switches.check(tx, { ...target, tenantId: b.tenantId, brandId: null })).toMatchObject({ level: 'global' });
        throw DESFAZER;
      }),
    ).rejects.toBe(DESFAZER);
    // Provedor (a Meta; os outros testes de ação usam o sandbox): confirmada, para a empresa tentar desligar pela API.
    const id = await withSystem(database.db, (tx) => switches.activateSystem(tx, { level: 'provider', provider: 'meta', reason: 'teste provider' }));
    try {
      expect(await check()).toMatchObject({ level: 'provider' });
      expect(await check({ ...target, tenantId: b.tenantId, brandId: null }, b)).toMatchObject({ level: 'provider' });
      expect(await check({ ...target, provider: 'google' })).toBeNull();
      // A empresa vê, mas não desliga a trava da distribuição.
      expect((await api.call('DELETE', `/v1/kill-switches/${id}`, { cookie: a.cookie })).status).toBe(404);
    } finally {
      await ownerQuery(`update liame.kill_switch set deactivated_at = now() where id = $1`, [id]);
    }
  });

  it('acionar a parada é auditado, gera evento e exige a permissão', async () => {
    const dono = await owner();
    const on = await api.call('POST', '/v1/kill-switches', { cookie: dono.cookie, body: { level: 'tenant', reason: 'suspeita de gasto errado' } });
    const [audit] = await ownerQuery<{ action: string; after: Record<string, unknown> }>(
      `select action, after from liame.audit_event where chain_key = $1 and action = 'parada.acionar'`,
      [dono.tenantId],
    );
    expect(audit).toMatchObject({ after: { level: 'tenant', reason: 'suspeita de gasto errado' } });
    const [event] = await ownerQuery<{ type: string }>(`select type from liame.outbox_event where subject = $1`, [on.body.id]);
    expect(event?.type).toBe('liame.kill_switch.activated');
    const lista = await api.call('GET', '/v1/kill-switches', { cookie: dono.cookie });
    expect(lista.body.items[0]).toMatchObject({ id: on.body.id, level: 'tenant', deactivated_at: null });

    // Marca de outra empresa não entra.
    const outra = await owner('Outra');
    const brandOutra = (await api.call('GET', '/v1/brands', { cookie: outra.cookie })).body.items[0].id;
    expect((await api.call('POST', '/v1/kill-switches', { cookie: dono.cookie, body: { level: 'brand', brand_id: brandOutra, reason: 'x y z' } })).status).toBe(404);
    // Nível da distribuição não é aceito pela API da empresa.
    expect((await api.call('POST', '/v1/kill-switches', { cookie: dono.cookie, body: { level: 'global', reason: 'tentativa' } })).status).toBe(400);
  });
});
