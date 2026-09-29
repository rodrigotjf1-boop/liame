import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startWorkerHealth } from '../src/worker/health-server.js';

// O HEALTHCHECK da imagem vale também para o worker (mesma imagem): ele precisa responder /health.
describe('sonda de vida do worker', () => {
  let base = '';
  let fechar: () => void = () => {};
  beforeAll(async () => {
    const server = await startWorkerHealth(0, 'teste-1');
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    fechar = () => server.close();
  });
  afterAll(() => fechar());

  it('GET /health responde 200 com o serviço e a versão', async () => {
    const r = await fetch(`${base}/health`);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ status: 'ok', service: 'liame-worker', version: 'teste-1' });
  });

  it('qualquer outro caminho ou método: 404', async () => {
    expect((await fetch(`${base}/`)).status).toBe(404);
    expect((await fetch(`${base}/health`, { method: 'POST' })).status).toBe(404);
  });
});
