import { createHash, createPublicKey, generateKeyPairSync, verify } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import { type Database, runMigrations, withContext } from '@liame/database';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { anchorStatement, RekorPublisher, TsaPublisher } from '../../src/audit/anchor.js';
import { listRoutes } from '../../src/auth/routes.js';
import { APP_CONFIG, type AppConfig } from '../../src/config.js';
import { DATABASE } from '../../src/database/database.module.js';
import { AuditAnchorService, utcDay } from '../../src/worker/audit-anchor.service.js';
import {
  enableMfa,
  ownerQuery,
  PASSWORD,
  resetIpRateLimits,
  signupAndLogin,
  startApi,
  type TestApi,
  tokenFrom,
  uniqueEmail,
} from '../helpers/api.js';
import { hasDb, OWNER_URL } from './env.js';

const MUTATIONS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
/** Mutações sem auditoria, com motivo revisado: rota nova aqui é decisão consciente. */
const WITHOUT_AUDIT = [
  'POST /v1/auth/password/forgot',
  'POST /v1/inbox/:provider',
  'POST /v1/invitations/preview',
  'POST /v1/ofrep/v1/evaluate/flags',
  'POST /v1/ofrep/v1/evaluate/flags/:key',
  'POST /v1/policies/evaluate',
];

function mockServer(handler: (body: Buffer, contentType: string) => { status: number; body: Buffer | string }) {
  let server: Server;
  const calls: Array<{ body: Buffer; contentType: string }> = [];
  return {
    calls,
    start: () =>
      new Promise<string>((ok) => {
        server = createServer((req, res) => {
          const chunks: Buffer[] = [];
          req.on('data', (c: Buffer) => chunks.push(c));
          req.on('end', () => {
            const body = Buffer.concat(chunks);
            const contentType = String(req.headers['content-type']);
            calls.push({ body, contentType });
            const out = handler(body, contentType);
            res.statusCode = out.status;
            res.end(out.body);
          });
        });
        server.listen(0, '127.0.0.1', () => ok(`http://127.0.0.1:${(server.address() as AddressInfo).port}`));
      }),
    stop: () => new Promise<void>((ok) => server.close(() => ok())),
  };
}

describe.skipIf(!hasDb)('auditoria com hash encadeado e âncora diária', () => {
  let api: TestApi;
  let database: Database;
  let config: AppConfig;

  async function owner(company = 'Empresa Auditada') {
    const s = await signupAndLogin(api, undefined, company);
    await enableMfa(api, s.cookie);
    return { ...s, tenantId: s.me.active_organization_id as string, userId: s.me.user.id as string };
  }

  const actionsOf = async (chainKey: string) =>
    (await ownerQuery<{ action: string }>(`select action from liame.audit_event where chain_key = $1 order by chain_seq`, [chainKey])).map(
      (r) => r.action,
    );

  beforeAll(async () => {
    await runMigrations({ connectionString: OWNER_URL, dir: resolve(process.cwd(), '../../packages/database/migrations') });
    api = await startApi();
    database = api.app.get(DATABASE);
    config = api.app.get<AppConfig>(APP_CONFIG);
  });
  beforeEach(resetIpRateLimits);
  afterAll(async () => {
    await api?.close();
  });

  it('A1-6: toda rota que muda dado declara a auditoria; as exceções são exatamente as revisadas', () => {
    const mutations = listRoutes(api.app).filter((r) => MUTATIONS.has(r.method));
    expect(mutations.filter((r) => !r.audit).map((r) => `${r.method} ${r.path}`)).toEqual([]);
    expect(
      mutations
        .filter((r) => r.audit?.kind === 'sem-auditoria')
        .map((r) => `${r.method} ${r.path}`)
        .sort(),
    ).toEqual(WITHOUT_AUDIT);
  });

  it('A1-6: cada mutação vira um evento na cadeia certa, com quem fez, sem segredo nem e-mail, e a cadeia confere', async () => {
    const dono = await owner('Pizzaria Auditada');
    const brand = await api.call('POST', '/v1/brands', { cookie: dono.cookie, body: { name: 'Filial Centro' } });
    const email = uniqueEmail('adm');
    await api.call('POST', '/v1/invitations', { cookie: dono.cookie, body: { email, role: 'administrador', approve_limit_micros: 50_000_000 } });
    const adm = await api.call('POST', '/v1/invitations/signup', { body: { token: tokenFrom(api.mailer, email), name: 'Juliana', password: PASSWORD } });
    const people = await api.call('GET', '/v1/people', { cookie: dono.cookie });
    const memberId = people.body.members.find((m: { email: string }) => m.email === email).id;
    await api.call('PATCH', `/v1/members/${memberId}`, { cookie: dono.cookie, body: { approve_limit_micros: 80_000_000 } });

    // Cadeia da empresa, na ordem.
    expect(await actionsOf(dono.tenantId)).toEqual(['conta.criar', 'marca.criar', 'convite.criar', 'convite.aceitar', 'acesso.alterar']);
    // Cadeia da pessoa: confirmar e-mail, entrar, segundo fator.
    expect(await actionsOf(dono.userId)).toEqual(['email.confirmar', 'sessao.abrir', 'segundo_fator.iniciar', 'segundo_fator.ativar']);

    const lista = await api.call('GET', '/v1/audit/events', { cookie: dono.cookie });
    expect(lista.status).toBe(200);
    const [alterar, aceitar, convidar, marca] = lista.body.items;
    expect(alterar).toMatchObject({
      action: 'acesso.alterar',
      actor_type: 'human',
      actor_label: 'Pessoa de Teste, Dono',
      resource_type: 'membership',
      resource_id: memberId,
      before: { role: 'administrador', approve_limit_micros: 50_000_000, dual_approval: true, billing_access: false },
      after: { role: 'administrador', approve_limit_micros: 80_000_000, dual_approval: true, billing_access: false },
    });
    expect(aceitar).toMatchObject({ action: 'convite.aceitar', actor_label: 'Juliana, Administrador', resource_id: memberId });
    expect(convidar).toMatchObject({ action: 'convite.criar', after: { role: 'administrador', approve_limit_micros: 50_000_000 } });
    expect(marca).toMatchObject({ action: 'marca.criar', resource_id: brand.body.id, after: { name: 'Filial Centro' } });
    // Nada de e-mail do convidado, senha, token ou código de recuperação na auditoria.
    const everything = JSON.stringify(await ownerQuery(`select * from liame.audit_event where chain_key in ($1, $2)`, [dono.tenantId, dono.userId]));
    expect(everything).not.toContain(email);
    expect(everything).not.toContain(PASSWORD);
    expect(everything).not.toMatch(/recovery|whsec_/);

    const check = await api.call('GET', '/v1/audit/verify', { cookie: dono.cookie });
    expect(check.body).toEqual({ ok: true, events_checked: 5, head_seq: 5, broken_at_seq: null, reason: null });
    // Quem só administra também lê (permissão auditoria.ver), mas não vê a cadeia pessoal do dono.
    await enableMfa(api, adm.cookie!);
    const doAdm = await api.call('GET', '/v1/audit/events', { cookie: adm.cookie });
    expect(doAdm.body.items.map((e: { action: string }) => e.action)).not.toContain('sessao.abrir');
  });

  it('o que desfaz não deixa auditoria, e a repetição idempotente não duplica o evento', async () => {
    const dono = await owner();
    const antes = (await actionsOf(dono.tenantId)).length;
    const recusado = await api.call('POST', '/v1/invitations', { cookie: dono.cookie, body: { email: uniqueEmail('x'), role: 'gestor' } });
    expect(recusado.status).toBe(400);
    expect((await actionsOf(dono.tenantId)).length).toBe(antes);
    const post = () => api.call('POST', '/v1/brands', { cookie: dono.cookie, body: { name: 'Uma vez só' }, headers: { 'Idempotency-Key': 'aud-1' } });
    await post();
    await post();
    expect((await actionsOf(dono.tenantId)).filter((a) => a === 'marca.criar')).toHaveLength(1);
  });

  it('só de inserção: a aplicação não altera nem apaga, o dono das tabelas também não; e a verificação acha a adulteração', async () => {
    const a = await owner('Empresa Adulterada');
    const b = await owner('Empresa Encurtada');
    await api.call('POST', '/v1/brands', { cookie: a.cookie, body: { name: 'Original' } });
    await api.call('POST', '/v1/brands', { cookie: b.cookie, body: { name: 'Última' } });

    await expect(
      withContext(database.db, { tenantId: a.tenantId, userId: a.userId }, (tx) =>
        tx.execute(sql`update liame.audit_event set reason = 'mudei' where tenant_id = ${a.tenantId}`),
      ),
    ).rejects.toMatchObject({ cause: expect.objectContaining({ code: '42501' }) });
    await expect(ownerQuery(`delete from liame.audit_event where chain_key = $1`, [a.tenantId])).rejects.toThrow(/só de inserção/);

    // Quem controla o banco desliga a trava e mexe: a verificação mostra onde.
    await ownerQuery(`alter table liame.audit_event disable trigger audit_event_imutavel`);
    try {
      await ownerQuery(`update liame.audit_event set after = '{"name":"Trocada"}' where chain_key = $1 and chain_seq = 2`, [a.tenantId]);
      await ownerQuery(`delete from liame.audit_event where chain_key = $1 and chain_seq = 2`, [b.tenantId]);
    } finally {
      await ownerQuery(`alter table liame.audit_event enable trigger audit_event_imutavel`);
    }
    expect((await api.call('GET', '/v1/audit/verify', { cookie: a.cookie })).body).toMatchObject({ ok: false, broken_at_seq: 2, reason: 'conteúdo alterado' });
    expect((await api.call('GET', '/v1/audit/verify', { cookie: b.cookie })).body).toMatchObject({
      ok: false,
      broken_at_seq: 2,
      reason: 'eventos apagados no fim da cadeia',
    });
  });

  it('A1-6: âncora diária encadeada, publicada no Rekor e carimbada (RFC 3161); a verificação acha raiz trocada', async () => {
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const pem = privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
    let tsaStatus = 500;
    const rekor = mockServer(() => ({ status: 201, body: JSON.stringify({ logIndex: String(1000 + rekor.calls.length), integratedTime: '0' }) }));
    // TimeStampResp mínimo: status 0 e um token vazio.
    const tsa = mockServer(() => ({ status: tsaStatus, body: Buffer.from('300730030201003000', 'hex') }));
    const [rekorUrl, tsaUrl] = [await rekor.start(), await tsa.start()];
    const service = new AuditAnchorService(database, config, [new RekorPublisher(rekorUrl, pem), new TsaPublisher(`${tsaUrl}/api/v1/timestamp`)]);

    try {
      // Só esta spec mexe nas âncoras (banco de testes compartilhado): começa do zero.
      await ownerQuery(`delete from liame.audit_anchor`);
      const now = new Date();
      const day = (n: number) => utcDay(new Date(now.getTime() - n * 86_400_000));
      expect(await service.anchorPending(now, { from: day(3) })).toBe(3);
      expect(await service.anchorPending(now)).toBe(0);
      const anchors = await ownerQuery<{ day: string; root_hash: string; prev_root_hash: string }>(
        `select day::text, root_hash, prev_root_hash from liame.audit_anchor order by day`,
      );
      expect(anchors.map((x) => x.day)).toEqual([day(3), day(2), day(1)]);
      expect(anchors[1]!.prev_root_hash).toBe(anchors[0]!.root_hash);
      expect(anchors[2]!.prev_root_hash).toBe(anchors[1]!.root_hash);
      expect(await service.verifyAnchors()).toEqual({ ok: true, days: 3, brokenDay: null, reason: null });

      // Publicação: a TSA falha, o Rekor passa; na volta, só a TSA é chamada de novo.
      expect(await service.publishPending()).toBe(0);
      expect(rekor.calls).toHaveLength(3);
      tsaStatus = 200;
      expect(await service.publishPending()).toBe(3);
      expect(rekor.calls).toHaveLength(3);
      const published = await ownerQuery<{ rekor_log_index: string; tsa_response: string; published_at: string | null }>(
        `select rekor_log_index, tsa_response, published_at from liame.audit_anchor order by day`,
      );
      const token = Buffer.from('300730030201003000', 'hex').toString('base64');
      expect(published.map((p) => [Number(p.rekor_log_index) >= 1000, p.tsa_response, p.published_at !== null])).toEqual([
        [true, token, true],
        [true, token, true],
        [true, token, true],
      ]);

      // O Rekor recebeu o hashedrekord v0.0.2 da declaração, com assinatura que confere com a chave pública enviada.
      const request = JSON.parse(rekor.calls[0]!.body.toString()).hashedRekordRequestV002;
      const statement = anchorStatement(anchors[0]!.day, anchors[0]!.root_hash, anchors[0]!.prev_root_hash);
      expect(request.digest).toBe(createHash('sha256').update(statement).digest('base64'));
      expect(request.signature.verifier.keyDetails).toBe('PKIX_ECDSA_P256_SHA_256');
      const publicKey = createPublicKey({ key: Buffer.from(request.signature.verifier.publicKey.rawBytes, 'base64'), format: 'der', type: 'spki' });
      expect(verify('sha256', statement, publicKey, Buffer.from(request.signature.content, 'base64'))).toBe(true);
      expect(tsa.calls.at(-1)!.contentType).toBe('application/timestamp-query');

      // Raiz trocada no banco: a verificação aponta o dia.
      await ownerQuery(`update liame.audit_anchor set root_hash = repeat('0', 64) where day = $1::date`, [day(2)]);
      expect(await service.verifyAnchors()).toMatchObject({ ok: false, brokenDay: day(2) });
      // Dia faltando também.
      await ownerQuery(`delete from liame.audit_anchor where day = $1::date`, [day(2)]);
      expect(await service.verifyAnchors()).toMatchObject({ ok: false, brokenDay: day(1), reason: `falta a âncora de ${day(2)}` });
    } finally {
      await ownerQuery(`delete from liame.audit_anchor`);
      await rekor.stop();
      await tsa.stop();
    }
  });
});
