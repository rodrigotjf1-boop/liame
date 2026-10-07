import { resolve } from 'node:path';
import { type Database, runMigrations, withContext, withSystem } from '@liame/database';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { verifyChain } from '../../src/audit/audit.js';
import { currentStep, totpCode } from '../../src/auth/totp.js';
import { DATABASE } from '../../src/database/database.module.js';
import { DATA_CLASSES } from '../../src/lifecycle/data-classes.js';
import { Mailer, type MemoryMailer } from '../../src/mail/mailer.js';
import { VaultService } from '../../src/vault/vault.service.js';
import { LifecyclePurgeService } from '../../src/worker/lifecycle-purge.service.js';
import { codigoErrado, enableMfa, ownerQuery, PASSWORD, resetIpRateLimits, signupAndLogin, startApi, type TestApi, tokenFrom, uniqueEmail, TERMOS } from '../helpers/api.js';
import { hasDb, OWNER_URL } from './env.js';

describe.skipIf(!hasDb)('ciclo de vida: arquivar, reter, encerrar e expurgar (ADR-014)', () => {
  let api: TestApi;
  let database: Database;
  let purge: LifecyclePurgeService;

  type Owner = { cookie: string; email: string; userId: string; secret: string; tenantId: string; brandId: string };

  async function owner(company = 'Pizzaria do Ciclo'): Promise<Owner> {
    const s = await signupAndLogin(api, undefined, company);
    const { secret } = await enableMfa(api, s.cookie);
    const brands = await api.call('GET', '/v1/brands', { cookie: s.cookie });
    return { cookie: s.cookie, email: s.email, userId: s.me.user.id, secret, tenantId: s.me.active_organization_id, brandId: brands.body.items[0].id };
  }
  async function code(p: { userId: string; secret: string }) {
    await ownerQuery(`update liame.app_user set totp_last_step = null where id = $1`, [p.userId]);
    return totpCode(p.secret, currentStep());
  }

  beforeAll(async () => {
    await runMigrations({ connectionString: OWNER_URL, dir: resolve(process.cwd(), '../../packages/database/migrations') });
    api = await startApi();
    database = api.app.get(DATABASE);
    purge = new LifecyclePurgeService(database, api.app.get(VaultService), api.app.get(Mailer));
  });
  beforeEach(resetIpRateLimits);
  afterAll(async () => {
    await api?.close();
  });

  it('toda tabela tem classe de dado e prazo (tabela nova sem classificação reprova)', async () => {
    const tables = await ownerQuery<{ relname: string }>(
      `select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'liame' and c.relkind in ('r', 'p') order by 1`,
    );
    expect(tables.map((t) => t.relname).filter((t) => !DATA_CLASSES[t])).toEqual([]);
    expect(Object.keys(DATA_CLASSES).filter((t) => !tables.some((x) => x.relname === t))).toEqual([]);
  });

  it('marca arquivada sai das telas, reativa, e é expurgada no prazo; legal_hold segura', async () => {
    const dono = await owner();
    const nova = await api.call('POST', '/v1/brands', { cookie: dono.cookie, body: { name: 'Filial que fechou' } });
    const arq = await api.call('POST', `/v1/brands/${nova.body.id}/archive`, { cookie: dono.cookie });
    expect(arq.body.archived_at).not.toBeNull();
    expect(new Date(arq.body.purge_after).getTime() - Date.now()).toBeGreaterThan(360 * 86_400_000);
    expect((await api.call('GET', '/v1/brands', { cookie: dono.cookie })).body.items.map((b: { id: string }) => b.id)).toEqual([dono.brandId]);
    expect((await api.call('GET', '/v1/brands?include_archived=true', { cookie: dono.cookie })).body.items).toHaveLength(2);
    expect((await api.call('POST', `/v1/brands/${nova.body.id}/reactivate`, { cookie: dono.cookie })).body.archived_at).toBeNull();
    await api.call('POST', `/v1/brands/${nova.body.id}/archive`, { cookie: dono.cookie });

    await ownerQuery(`update liame.brand set purge_after = now() - interval '1 second' where id = $1`, [nova.body.id]);
    await ownerQuery(`update liame.organization set legal_hold_at = now(), legal_hold_reason = 'ofício judicial' where id = $1`, [dono.tenantId]);
    expect(await purge.purgeArchivedBrands({ tenantIds: [dono.tenantId] })).toBe(0);
    await ownerQuery(`update liame.organization set legal_hold_at = null, legal_hold_reason = null where id = $1`, [dono.tenantId]);
    expect(await purge.purgeArchivedBrands({ tenantIds: [dono.tenantId] })).toBe(1);
    expect(await ownerQuery(`select 1 from liame.brand where id = $1`, [nova.body.id])).toHaveLength(0);
    const [audit] = await ownerQuery<{ after: Record<string, number> }>(
      `select after from liame.audit_event where chain_key = $1 and action = 'dados.expurgar' order by chain_seq desc limit 1`,
      [dono.tenantId],
    );
    expect(audit?.after).toEqual({ marca_arquivada: 1 });
  });

  it('prazos por classe apagam só o vencido, e a auditoria registra as contagens', async () => {
    const dono = await owner();
    await api.call('POST', '/v1/brands', { cookie: dono.cookie, body: { name: 'Gera evento' } });
    await ownerQuery(`update liame.outbox_event set published_at = now() - interval '31 days' where tenant_id = $1`, [dono.tenantId]);
    await api.call('POST', '/v1/brands', { cookie: dono.cookie, body: { name: 'Evento recente' } });
    await ownerQuery(`update liame.outbox_event set published_at = now() where tenant_id = $1 and data->>'name' = 'Evento recente'`, [dono.tenantId]);
    await api.call('POST', '/v1/brands', { cookie: dono.cookie, body: { name: 'Com chave' }, headers: { 'Idempotency-Key': 'ciclo-1' } });
    await ownerQuery(`update liame.idempotency_key set expires_at = now() - interval '1 second' where tenant_id = $1`, [dono.tenantId]);
    await ownerQuery(`update liame.user_token set expires_at = now() - interval '31 days' where user_id = $1`, [dono.userId]);
    await ownerQuery(
      `update liame.session set revoked_at = now() - interval '181 days' where user_id = $1 and id = (select id from liame.session where user_id = $1 order by created_at limit 1)`,
      [dono.userId],
    );

    const counts = await purge.purgeRetention({ tenantIds: [dono.tenantId], userIds: [dono.userId] });
    expect(counts).toMatchObject({ outbox: 1, idempotencia: 1, sessao: 1 });
    expect(counts.token).toBeGreaterThanOrEqual(1);
    const left = await ownerQuery<{ n: string }>(`select count(*)::text as n from liame.outbox_event where tenant_id = $1`, [dono.tenantId]);
    expect(Number(left[0]!.n)).toBeGreaterThanOrEqual(2);
    const [audit] = await ownerQuery<{ after: Record<string, number>; actor_label: string }>(
      `select after, actor_label from liame.audit_event where chain_key = $1 and action = 'dados.expurgar' order by chain_seq desc limit 1`,
      [dono.tenantId],
    );
    expect(audit).toEqual({ after: { outbox: 1, idempotencia: 1 }, actor_label: 'Liame (expurgo)' });
  });

  it('só o expurgo apaga: a transação da empresa não apaga a própria organização nem os eventos', async () => {
    const dono = await owner();
    const r = await withContext(database.db, { tenantId: dono.tenantId, userId: dono.userId }, async (tx) => ({
      org: (await tx.execute(sql`delete from liame.organization where id = ${dono.tenantId}`)).rowCount,
      outbox: (await tx.execute(sql`delete from liame.outbox_event where tenant_id = ${dono.tenantId}`)).rowCount,
    }));
    expect(r).toEqual({ org: 0, outbox: 0 });
  });

  it('encerrar: nome e código do app; 30 dias de graça só para ver, exportar e reativar; pedidos cancelados', async () => {
    const dono = await owner('Hamburgueria Encerrando');
    const email = uniqueEmail('adm');
    await api.call('POST', '/v1/invitations', { cookie: dono.cookie, body: { email, role: 'administrador', approve_limit_micros: 1_000_000 } });
    await api.call('POST', '/v1/invitations/signup', { body: { token: tokenFrom(api.mailer, email), name: 'Admin', password: PASSWORD, terms_version: TERMOS } });
    await api.call('POST', '/v1/invitations', { cookie: dono.cookie, body: { email: uniqueEmail('pendente'), role: 'somente_leitura' } });
    await api.call('PUT', '/v1/sandbox/resources', { cookie: dono.cookie, body: { account_id: 'a', resource_id: 'r', state: { daily_budget_micros: 100_000_000 } } });
    await api.call('POST', '/v1/policies', { cookie: dono.cookie, body: { document: { rules: [{ type: 'autonomy', mode: 'APPROVAL' }] } } });
    const acao = await api.call('POST', '/v1/actions', {
      cookie: dono.cookie,
      body: { tool: 'orcamento_ajustar', provider: 'sandbox', account_id: 'a', resource_id: 'r', params: { daily_budget_micros: 120_000_000 } },
    });

    const close = (body: Record<string, unknown>) => api.call('POST', '/v1/organization/close', { cookie: dono.cookie, body });
    expect((await close({ confirm_name: 'Outra', code: await code(dono) })).status).toBe(400);
    expect((await close({ confirm_name: 'Hamburgueria Encerrando', code: codigoErrado(dono.secret) })).status).toBe(401);
    expect((await close({ confirm_name: 'hamburgueria encerrando', code: await code(dono) })).status).toBe(204);

    const org = await api.call('GET', '/v1/organization', { cookie: dono.cookie });
    expect(org.body.status).toBe('suspensa');
    expect(Math.round((new Date(org.body.purge_after).getTime() - Date.now()) / 86_400_000)).toBe(30);
    expect((await api.call('GET', `/v1/actions/${acao.body.id}`, { cookie: dono.cookie })).body).toMatchObject({ status: 'cancelada', status_reason: 'conta em encerramento' });
    expect((await api.call('GET', '/v1/people', { cookie: dono.cookie })).body.invitations).toEqual([]);
    expect(api.mailer.lastTo(email)?.subject).toMatch(/vai ser encerrada/);

    const mudar = await api.call('POST', '/v1/brands', { cookie: dono.cookie, body: { name: 'Não pode' } });
    expect(mudar).toMatchObject({ status: 403, body: { code: 'empresa-em-encerramento' } });
    const exp = await api.call('GET', '/v1/export', { cookie: dono.cookie });
    expect(exp.status).toBe(200);
    expect(exp.body).toMatchObject({ format: 'liame-export', version: 1, organization: { name: 'Hamburgueria Encerrando' } });
    expect(exp.body.data.members.map((m: { role: string }) => m.role).sort()).toEqual(['administrador', 'dono']);
    expect(exp.body.data.actions).toHaveLength(1);
    const text = JSON.stringify(exp.body);
    expect(text).not.toMatch(/password_hash|token_hash|wrapped_dek|ciphertext|whsec_|totp/);
    const [audit] = await ownerQuery<{ action: string }>(`select action from liame.audit_event where chain_key = $1 order by chain_seq desc limit 1`, [dono.tenantId]);
    expect(audit?.action).toBe('dados.exportar');

    expect((await api.call('POST', '/v1/organization/reactivate', { cookie: dono.cookie })).status).toBe(204);
    expect((await api.call('POST', '/v1/brands', { cookie: dono.cookie, body: { name: 'Voltou' } })).status).toBe(201);
  });

  it('fim da graça: chave destruída, tudo apagado, certificado ao dono; a auditoria fica e confere; legal_hold segura', async () => {
    const dono = await owner('Doceria Expurgada');
    const vault = api.app.get(VaultService);
    const cifrado = await withSystem(database.db, (tx) => vault.encryptForTenant(tx, dono.tenantId, 'telefone', '+5521999990000'));
    await api.call('POST', '/v1/organization/close', { cookie: dono.cookie, body: { confirm_name: 'Doceria Expurgada', code: await code(dono) } });
    await ownerQuery(`update liame.organization set purge_after = now() - interval '1 second' where id = $1`, [dono.tenantId]);

    await ownerQuery(`update liame.organization set legal_hold_at = now(), legal_hold_reason = 'investigação' where id = $1`, [dono.tenantId]);
    expect(await purge.purgeTenants({ tenantIds: [dono.tenantId] })).toEqual([]);
    await ownerQuery(`update liame.organization set legal_hold_at = null, legal_hold_reason = null where id = $1`, [dono.tenantId]);

    const [cert] = await purge.purgeTenants({ tenantIds: [dono.tenantId] });
    expect(cert).toMatchObject({ tenantId: dono.tenantId, organizationName: 'Doceria Expurgada', summary: { brand: 1, membership: 1 } });
    for (const table of ['organization', 'membership', 'brand', 'tenant_key', 'secret', 'outbox_event']) {
      const col = table === 'organization' ? 'id' : 'tenant_id';
      expect({ table, rows: (await ownerQuery(`select 1 from liame.${table} where ${col} = $1`, [dono.tenantId])).length }).toEqual({ table, rows: 0 });
    }
    // O dado pessoal cifrado não abre mais (chave destruída).
    await expect(withSystem(database.db, (tx) => vault.decryptForTenant(tx, dono.tenantId, 'telefone', cifrado))).rejects.toThrow();
    const [stored] = await ownerQuery<{ certificate_hash: string; organization_name: string }>(`select certificate_hash, organization_name from liame.purge_certificate where purged_tenant_id = $1`, [dono.tenantId]);
    expect(stored).toEqual({ certificate_hash: cert!.hash, organization_name: 'Doceria Expurgada' });
    expect((api.mailer as MemoryMailer).lastTo(dono.email)?.subject).toBe('Liame: certificado de expurgo de Doceria Expurgada');

    const chain = await withSystem(database.db, (tx) => verifyChain(tx, dono.tenantId));
    expect(chain.ok).toBe(true);
    const [last] = await ownerQuery<{ action: string }>(`select action from liame.audit_event where chain_key = $1 order by chain_seq desc limit 1`, [dono.tenantId]);
    expect(last?.action).toBe('empresa.expurgar');
    // A pessoa continua com a conta dela (sem a empresa).
    const login = await api.call('POST', '/v1/auth/login', { body: { email: dono.email, password: PASSWORD } });
    expect(login.body).toMatchObject({ organizations: [], active_organization_id: null });
  });

  it('relatório mensal ao dono do que foi expurgado', async () => {
    const dono = await owner('Padaria do Relatório');
    await api.call('POST', '/v1/brands', { cookie: dono.cookie, body: { name: 'Evento velho' } });
    await ownerQuery(`update liame.outbox_event set published_at = now() - interval '31 days' where tenant_id = $1`, [dono.tenantId]);
    await purge.purgeRetention({ tenantIds: [dono.tenantId], userIds: [dono.userId] });
    const now = new Date();
    const nextMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1, 12));
    expect(await purge.monthlyReport(nextMonth, { tenantIds: [dono.tenantId] })).toBe(1);
    const mail = api.mailer.lastTo(dono.email)!;
    expect(mail.subject).toBe('Liame: o que foi expurgado de Padaria do Relatório no último mês');
    expect(mail.text).toMatch(/- outbox: 1/);
  });
});
