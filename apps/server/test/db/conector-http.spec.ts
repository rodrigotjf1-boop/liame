import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import { createDatabase, type Database, runMigrations } from '@liame/database';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ClienteConector, ErroConector } from '../../src/connectors/cliente-http.js';
import { ownerQuery } from '../helpers/api.js';
import { APP_URL, hasDb, OWNER_URL } from './env.js';

// A2 · G2: o cliente dos conectores contra uma "plataforma" local que imita as respostas da Meta.
describe.skipIf(!hasDb)('cliente dos conectores', () => {
  let database: Database;
  let servidor: Server;
  let base = '';
  const contagem = new Map<string, number>();

  beforeAll(async () => {
    await runMigrations({ connectionString: OWNER_URL, dir: resolve(process.cwd(), '../../packages/database/migrations') });
    database = createDatabase({ connectionString: APP_URL, max: 2, applicationName: 'liame-test' });
    servidor = createServer((req, res) => {
      const caminho = (req.url ?? '').split('?')[0]!;
      const n = (contagem.get(caminho) ?? 0) + 1;
      contagem.set(caminho, n);
      const json = (status: number, corpo: unknown, cab: Record<string, string> = {}) => {
        res.writeHead(status, { 'content-type': 'application/json', ...cab });
        res.end(JSON.stringify(corpo));
      };
      if (caminho === '/ok') {
        return json(200, { data: [{ id: 'act_1' }] }, {
          'x-business-use-case-usage': JSON.stringify({ '1': [{ call_count: 42, total_cputime: 10, total_time: 12, estimated_time_to_regain_access: 0 }] }),
          deprecation: '@1788220800',
          sunset: 'Wed, 30 Dec 2026 23:59:59 GMT',
        });
      }
      if (caminho === '/instavel') return n <= 2 ? json(500, { error: { code: 2, message: 'Service temporarily unavailable' } }) : json(200, { ok: true });
      if (caminho === '/limite') {
        return json(400, { error: { code: 17, message: 'User request limit reached' } }, {
          'x-business-use-case-usage': JSON.stringify({ '1': [{ call_count: 100, estimated_time_to_regain_access: 5 }] }),
        });
      }
      if (caminho === '/token') return json(400, { error: { code: 190, message: 'Error validating access token' } });
      if (caminho === '/fora') return json(503, { error: { code: 2, message: 'down' } });
      return json(404, { error: { code: 100, message: 'Unknown path' } });
    });
    await new Promise<void>((ok) => servidor.listen(0, '127.0.0.1', ok));
    base = `http://127.0.0.1:${(servidor.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    await new Promise((ok) => servidor?.close(ok));
    await database?.close();
  });

  const cliente = (extra: Partial<ConstructorParameters<typeof ClienteConector>[1]> = {}) =>
    new ClienteConector(database.db, { enderecos: { meta_ads: [base] }, tentativas: 3, esperaMaximaMs: 2_000, ...extra });
  const pedido = (caminho: string, conta = randomUUID()) => ({
    provider: 'meta_ads',
    conta,
    url: `${base}${caminho}`,
    endpoint: caminho.slice(1),
    apiVersion: 'v26.0',
  });

  it('resposta boa: corpo, uso de cota e o aviso de depreciação guardado para o Vigia', async () => {
    const r = await cliente().requisitar<{ data: { id: string }[] }>(pedido('/ok'));
    expect(r.corpo.data[0]?.id).toBe('act_1');
    expect(r.uso).toEqual({ maiorPct: 42, esperarMs: 0 });
    await new Promise((ok) => setTimeout(ok, 200));
    const [aviso] = await ownerQuery<{ deprecation: string; sunset: string }>(
      `select deprecation, sunset from liame.api_deprecation_notice where provider = 'meta_ads' and endpoint = 'ok' and api_version = 'v26.0'`,
    );
    expect(aviso).toEqual({ deprecation: '2026-09-01T00:00:00.000Z', sunset: '2026-12-30T23:59:59.000Z' });
  });

  it('falha passageira: tenta de novo com espera e passa', async () => {
    const r = await cliente().requisitar<{ ok: boolean }>(pedido('/instavel'));
    expect(r.corpo.ok).toBe(true);
    expect(contagem.get('/instavel')).toBe(3);
  });

  it('limite da plataforma com espera longa volta para o job (sem prender o worker); token vencido pede reconexão', async () => {
    await expect(cliente().requisitar(pedido('/limite'))).rejects.toMatchObject({ tipo: 'limite', esperarMs: 300_000, codigoProvider: '17' });
    expect(contagem.get('/limite')).toBe(1);
    await expect(cliente().requisitar(pedido('/token'))).rejects.toMatchObject({ tipo: 'autenticacao', codigoProvider: '190' });
  });

  it('endereço fora da lista do provider nem sai', async () => {
    await expect(cliente().requisitar({ ...pedido('/ok'), url: 'https://example.com/ok' })).rejects.toMatchObject({ tipo: 'definitivo' });
  });

  it('muitas falhas seguidas abrem o disjuntor: a próxima chamada nem sai', async () => {
    const conta = randomUUID();
    await expect(cliente().requisitar(pedido('/fora', conta))).rejects.toBeInstanceOf(ErroConector);
    await expect(cliente().requisitar(pedido('/fora', conta))).rejects.toMatchObject({ tipo: expect.stringMatching(/transitorio|circuito_aberto/) });
    const antes = contagem.get('/fora');
    await expect(cliente().requisitar(pedido('/fora', conta))).rejects.toMatchObject({ tipo: 'circuito_aberto' });
    expect(contagem.get('/fora')).toBe(antes);
    // Outra conta não é afetada pelo disjuntor desta.
    await expect(cliente().requisitar(pedido('/ok'))).resolves.toMatchObject({ status: 200 });
  }, 30_000);

  it('balde de cota por conta: sem ficha e sem tempo de esperar, devolve "limite" sem chamar', async () => {
    const conta = randomUUID();
    const c = cliente({ balde: { capacidade: 2, porSegundo: 0.1 }, esperaMaximaMs: 100 });
    await c.requisitar(pedido('/ok', conta));
    await c.requisitar(pedido('/ok', conta));
    const antes = contagem.get('/ok');
    await expect(c.requisitar(pedido('/ok', conta))).rejects.toMatchObject({ tipo: 'limite', status: 429 });
    expect(contagem.get('/ok')).toBe(antes);
  });
});
