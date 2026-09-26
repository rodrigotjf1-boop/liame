import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import { type Database, runMigrations, withContext } from '@liame/database';
import { sql } from 'drizzle-orm';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { APP_CONFIG, type AppConfig } from '../../src/config.js';
import { DATABASE } from '../../src/database/database.module.js';
import { emitEvent } from '../../src/events/outbox.js';
import { verifyWebhook, webhookHeaders } from '../../src/events/standard-webhooks.js';
import { VaultService } from '../../src/vault/vault.service.js';
import { type InboxHandler, InboxProcessor } from '../../src/worker/inbox-processor.js';
import { OutboxPublisher } from '../../src/worker/outbox-publisher.js';
import { MAX_ATTEMPTS, WebhookDeliverer } from '../../src/worker/webhook-deliverer.js';
import { enableMfa, ownerQuery, resetIpRateLimits, signupAndLogin, startApi, type TestApi } from '../helpers/api.js';
import { hasDb, OWNER_URL } from './env.js';

/** Receptor de referência: verifica a assinatura Standard Webhooks de tudo o que chega. */
function referenceReceiver() {
  const received: Array<{ headers: IncomingHttpHeaders; body: string; valid: boolean; event: any }> = [];
  const state = { secret: '', status: 200 };
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      const valid = verifyWebhook(state.secret, req.headers, body).ok;
      received.push({ headers: req.headers, body, valid, event: JSON.parse(body) });
      res.statusCode = valid ? state.status : 401;
      res.end();
    });
  });
  return {
    received,
    state,
    start: () => new Promise<string>((ok) => server.listen(0, '127.0.0.1', () => ok(`http://127.0.0.1:${(server.address() as AddressInfo).port}/hook`))),
    stop: () => new Promise<void>((ok) => server.close(() => ok())),
  };
}

describe.skipIf(!hasDb)('eventos: outbox, webhooks de saída, inbox e idempotência', () => {
  let api: TestApi;
  let database: Database;
  let publisher: OutboxPublisher;
  let deliverer: WebhookDeliverer;
  const receiver = referenceReceiver();
  let hookUrl = '';

  async function owner(company = 'Empresa dos Eventos') {
    const s = await signupAndLogin(api, undefined, company);
    await enableMfa(api, s.cookie);
    return { ...s, tenantId: s.me.active_organization_id as string };
  }

  async function endpoint(cookie: string, body: Record<string, unknown> = {}) {
    const r = await api.call('POST', '/v1/webhooks/endpoints', { cookie, body: { url: hookUrl, ...body } });
    expect(r.status).toBe(201);
    receiver.state.secret = r.body.secret;
    return r.body as { id: string; secret: string };
  }

  const drain = async (tenantId: string) => {
    await publisher.publishBatch(100, { tenantIds: [tenantId] });
    await deliverer.deliverBatch(20, { tenantIds: [tenantId] });
  };

  beforeAll(async () => {
    await runMigrations({ connectionString: OWNER_URL, dir: resolve(process.cwd(), '../../packages/database/migrations') });
    api = await startApi();
    database = api.app.get(DATABASE);
    publisher = new OutboxPublisher(database);
    deliverer = new WebhookDeliverer(database, api.app.get(VaultService), api.app.get<AppConfig>(APP_CONFIG));
    hookUrl = await receiver.start();
  });
  beforeEach(async () => {
    await resetIpRateLimits();
    receiver.received.length = 0;
    receiver.state.status = 200;
  });
  afterAll(async () => {
    await receiver.stop();
    await api?.close();
  });

  it('A1-7: mutação e evento na mesma transação — o rollback leva os dois', async () => {
    const dono = await owner();
    await expect(
      withContext(database.db, { tenantId: dono.tenantId, userId: dono.me.user.id }, async (tx) => {
        await tx.execute(sql`insert into liame.brand (id, tenant_id, name) values (gen_random_uuid(), ${dono.tenantId}, 'Marca desfeita')`);
        await emitEvent(tx, { tenantId: dono.tenantId, type: 'liame.brand.created', data: { name: 'Marca desfeita' } });
        throw new Error('falha no meio da mutação');
      }),
    ).rejects.toThrow('falha no meio');
    expect(await ownerQuery(`select 1 from liame.brand where tenant_id = $1 and name = 'Marca desfeita'`, [dono.tenantId])).toHaveLength(0);
    expect(await ownerQuery(`select 1 from liame.outbox_event where tenant_id = $1`, [dono.tenantId])).toHaveLength(0);
  });

  it('A1-7: com o commit feito, o publicador que cai no meio não perde o evento', async () => {
    const dono = await owner();
    await endpoint(dono.cookie);
    expect((await api.call('POST', '/v1/brands', { cookie: dono.cookie, body: { name: 'Pizzaria Nova' } })).status).toBe(201);
    const [ev] = await ownerQuery<{ id: string; published_at: string | null }>(
      `select id, published_at from liame.outbox_event where tenant_id = $1 and type = 'liame.brand.created'`,
      [dono.tenantId],
    );
    expect(ev?.published_at).toBeNull();

    // Um publicador pega o evento e "cai" antes de terminar (a transação dele desfaz).
    const crashed = new pg.Client({ connectionString: OWNER_URL });
    await crashed.connect();
    await crashed.query('begin');
    await crashed.query(`select set_config('app.scope', 'sistema', true)`);
    await crashed.query(`select id from liame.outbox_event where id = $1 for update`, [ev!.id]);
    // Enquanto isso, outro publicador pula o evento travado (SKIP LOCKED) em vez de esperar ou duplicar.
    expect(await publisher.publishBatch(100, { tenantIds: [dono.tenantId] })).toBe(0);
    await crashed.query('rollback');
    await crashed.end();

    // O próximo publicador entrega: pelo menos uma vez.
    await drain(dono.tenantId);
    expect(receiver.received).toHaveLength(1);
    const [got] = receiver.received;
    expect(got!.valid).toBe(true);
    expect(got!.headers['webhook-id']).toBe(ev!.id);
    expect(got!.event).toMatchObject({
      specversion: '1.0',
      id: ev!.id,
      source: 'urn:liame',
      type: 'liame.brand.created',
      tenantid: dono.tenantId,
      data: { name: 'Pizzaria Nova' },
    });
    const entregas = await api.call('GET', '/v1/webhooks/deliveries', { cookie: dono.cookie });
    expect(entregas.body.items).toEqual([expect.objectContaining({ event_type: 'liame.brand.created', status: 'entregue', attempts: 1 })]);
  });

  it('A1-7: falha do receptor → nova tentativa com espera; esgotou → fila de mortos; reenvio manual entrega', async () => {
    const dono = await owner();
    await endpoint(dono.cookie);
    await api.call('POST', '/v1/brands', { cookie: dono.cookie, body: { name: 'Marca instável' } });
    receiver.state.status = 500;
    await drain(dono.tenantId);
    let [d] = await ownerQuery<{ id: string; attempts: number; status: string; last_status_code: number; wait: number }>(
      `select id, attempts, status, last_status_code, extract(epoch from next_attempt_at - now())::int as wait
         from liame.webhook_delivery where tenant_id = $1`,
      [dono.tenantId],
    );
    expect(d).toMatchObject({ attempts: 1, status: 'pendente', last_status_code: 500 });
    expect(d!.wait).toBeGreaterThan(0);

    // Adianta o relógio de cada espera até esgotar as tentativas.
    for (let i = 1; i < MAX_ATTEMPTS; i++) {
      await ownerQuery(`update liame.webhook_delivery set next_attempt_at = now() where id = $1`, [d!.id]);
      await deliverer.deliverBatch(20, { tenantIds: [dono.tenantId] });
    }
    [d] = await ownerQuery(`select id, attempts, status, last_status_code, 0 as wait from liame.webhook_delivery where id = $1`, [d!.id]);
    expect(d).toMatchObject({ attempts: MAX_ATTEMPTS, status: 'morta' });
    expect(receiver.received).toHaveLength(MAX_ATTEMPTS);
    // Todas as tentativas levam o mesmo webhook-id: quem recebe deduplica.
    expect(new Set(receiver.received.map((r) => r.headers['webhook-id'])).size).toBe(1);

    const mortas = await api.call('GET', '/v1/webhooks/deliveries?status=morta', { cookie: dono.cookie });
    expect(mortas.body.items).toEqual([expect.objectContaining({ id: d!.id, status: 'morta', last_error: 'HTTP 500' })]);
    receiver.state.status = 200;
    expect((await api.call('POST', `/v1/webhooks/deliveries/${d!.id}/retry`, { cookie: dono.cookie })).status).toBe(202);
    await deliverer.deliverBatch(20, { tenantIds: [dono.tenantId] });
    const [final] = await ownerQuery<{ status: string }>(`select status from liame.webhook_delivery where id = $1`, [d!.id]);
    expect(final?.status).toBe('entregue');
  });

  it('filtro por tipo, evento de teste só para o endpoint pedido e endpoint desativado para de receber', async () => {
    const dono = await owner();
    const soMarcas = await endpoint(dono.cookie, { event_types: ['liame.brand.created'] });
    const soPessoas = await api.call('POST', '/v1/webhooks/endpoints', {
      cookie: dono.cookie,
      body: { url: `${hookUrl}?pessoas`, event_types: ['liame.invitation.created'] },
    });
    receiver.state.secret = soMarcas.secret;
    await api.call('POST', '/v1/brands', { cookie: dono.cookie, body: { name: 'Só para o primeiro' } });
    expect((await api.call('POST', `/v1/webhooks/endpoints/${soMarcas.id}/test`, { cookie: dono.cookie })).status).toBe(202);
    await drain(dono.tenantId);
    expect(receiver.received.map((r) => r.event.type).sort()).toEqual(['liame.brand.created', 'liame.webhook.test']);
    expect(receiver.received.every((r) => r.valid)).toBe(true);

    expect((await api.call('DELETE', `/v1/webhooks/endpoints/${soMarcas.id}`, { cookie: dono.cookie })).status).toBe(204);
    receiver.received.length = 0;
    await api.call('POST', '/v1/brands', { cookie: dono.cookie, body: { name: 'Depois de desativar' } });
    await drain(dono.tenantId);
    expect(receiver.received).toHaveLength(0);
    const lista = await api.call('GET', '/v1/webhooks/endpoints', { cookie: dono.cookie });
    expect(lista.body.items.map((e: { id: string; disabled_at: string | null }) => [e.id, e.disabled_at !== null])).toEqual([
      [soPessoas.body.id, false],
      [soMarcas.id, true],
    ]);
    // O segredo nunca volta numa listagem.
    expect(JSON.stringify(lista.body)).not.toContain('whsec_');
  });

  it('outra empresa não vê nem reenvia entregas de outra', async () => {
    const a = await owner('Empresa A');
    const b = await owner('Empresa B');
    await endpoint(a.cookie);
    await api.call('POST', '/v1/brands', { cookie: a.cookie, body: { name: 'Marca de A' } });
    await drain(a.tenantId);
    const [d] = await ownerQuery<{ id: string }>(`select id from liame.webhook_delivery where tenant_id = $1`, [a.tenantId]);
    expect((await api.call('GET', '/v1/webhooks/deliveries', { cookie: b.cookie })).body.items).toEqual([]);
    expect((await api.call('POST', `/v1/webhooks/deliveries/${d!.id}/retry`, { cookie: b.cookie })).status).toBe(404);
  });

  it('inbox: assinatura → grava cru → deduplica → 202; processa depois, e a falha não perde o evento', async () => {
    const secret = process.env.INBOX_SECRETS!.split(':').slice(1).join(':');
    const body = JSON.stringify({ type: 'parceiro.pedido.criado', data: { pedido: 42 } });
    const id = `msg_${Date.now()}`;
    const send = (headers: Record<string, string>, provider = 'teste') =>
      api.call('POST', `/v1/inbox/${provider}`, { body: JSON.parse(body), headers });
    // O corpo precisa chegar byte a byte igual ao assinado: o cliente de teste manda JSON.stringify(JSON.parse(body)).
    const headers = { ...webhookHeaders(secret, id, body) };

    const primeiro = await send(headers);
    expect(primeiro).toMatchObject({ status: 202, body: { status: 'accepted', message: 'Evento recebido.' } });
    expect((await send(headers)).body.message).toBe('Evento já recebido.');
    const rows = await ownerQuery<{ id: string; type: string; body: string; headers: Record<string, string> }>(
      `select id, type, body, headers from liame.inbox_event where provider = 'teste' and external_event_id = $1`,
      [id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ type: 'parceiro.pedido.criado', body });
    expect(rows[0]!.headers).not.toHaveProperty('webhook-signature');

    expect((await send({ ...headers, 'webhook-signature': 'v1,AAAA' })).body.code).toBe('assinatura-invalida');
    expect((await send(headers, 'desconhecido')).status).toBe(404);

    // Processamento assíncrono: primeiro falha (fica pendente, com o motivo), depois passa.
    let fail = true;
    const seen: string[] = [];
    const handler: InboxHandler = async (_tx, ev) => {
      if (fail) throw new Error('parceiro fora do ar');
      seen.push(ev.external_event_id);
    };
    const processor = new InboxProcessor(database, new Map([['teste', handler]]));
    expect(await processor.processBatch(10, { ids: [rows[0]!.id] })).toBe(1);
    let [st] = await ownerQuery<{ processed_at: string | null; attempts: number; last_error: string | null }>(
      `select processed_at, attempts, last_error from liame.inbox_event where id = $1`,
      [rows[0]!.id],
    );
    expect(st).toMatchObject({ processed_at: null, attempts: 1, last_error: 'parceiro fora do ar' });
    fail = false;
    await processor.processBatch(10, { ids: [rows[0]!.id] });
    [st] = await ownerQuery(`select processed_at, attempts, last_error from liame.inbox_event where id = $1`, [rows[0]!.id]);
    expect(st!.processed_at).not.toBeNull();
    expect(seen).toEqual([id]);
  });

  it('A1-8: mesma chave e mesmo corpo → mesma resposta; corpo diferente → 422; simultâneos criam uma vez só', async () => {
    const dono = await owner();
    const post = (key: string, name: string, cookie = dono.cookie) =>
      api.call('POST', '/v1/brands', { cookie, body: { name }, headers: { 'Idempotency-Key': key } });

    const a = await post('chave-1', 'Marca idempotente');
    expect(a.status).toBe(201);
    expect(a.headers.get('idempotent-replayed')).toBeNull();
    const b = await post('chave-1', 'Marca idempotente');
    expect(b.status).toBe(201);
    expect(b.body).toEqual(a.body);
    expect(b.headers.get('idempotent-replayed')).toBe('true');
    const c = await post('chave-1', 'Outro nome');
    expect(c.status).toBe(422);
    expect(c.body.code).toBe('idempotency-key-reutilizada');

    const [x, y, z] = await Promise.all([post('chave-2', 'Ao mesmo tempo'), post('chave-2', 'Ao mesmo tempo'), post('chave-2', 'Ao mesmo tempo')]);
    expect(new Set([x!.body.id, y!.body.id, z!.body.id]).size).toBe(1);
    const marcas = await ownerQuery(`select 1 from liame.brand where tenant_id = $1 and name = 'Ao mesmo tempo'`, [dono.tenantId]);
    expect(marcas).toHaveLength(1);
    // O evento também sai uma vez só.
    const eventos = await ownerQuery(
      `select 1 from liame.outbox_event where tenant_id = $1 and type = 'liame.brand.created' and data->>'name' = 'Ao mesmo tempo'`,
      [dono.tenantId],
    );
    expect(eventos).toHaveLength(1);

    // Erro não fica gravado: corrigir o corpo com a mesma chave funciona.
    expect((await post('chave-3', '')).status).toBe(400);
    expect((await post('chave-3', 'Corrigida')).status).toBe(201);

    // Chave inválida.
    expect((await post('com espaço', 'X')).body.code).toBe('idempotency-key-invalida');

    // A chave é de cada pessoa: outra pessoa com a mesma chave faz o próprio pedido.
    const outra = await owner('Outra empresa');
    const d = await post('chave-1', 'Marca idempotente', outra.cookie);
    expect(d.status).toBe(201);
    expect(d.body.id).not.toBe(a.body.id);
  });
});
