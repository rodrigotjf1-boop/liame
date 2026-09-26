import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { listRoutes } from '../src/auth/routes.js';
import { startApi, type TestApi } from './helpers/api.js';

// A1-4: guard global que nega por padrão. Toda rota declara o acesso; sem sessão, só as públicas respondem.
const PUBLIC_ROUTES = [
  'GET /health',
  'GET /health/ready',
  'POST /v1/auth/signup',
  'POST /v1/auth/verify-email',
  'POST /v1/auth/login',
  'POST /v1/auth/password/forgot',
  'POST /v1/auth/password/reset',
  'POST /v1/invitations/preview',
  'POST /v1/invitations/signup',
  'POST /v1/spike/echo',
  'GET /v1/spike/falha',
].sort();

describe('A1-4: toda rota declara o acesso e nega sem sessão', () => {
  let api: TestApi;

  beforeAll(async () => {
    api = await startApi();
  });
  afterAll(async () => {
    await api?.close();
  });

  it('a lista de rotas públicas é exatamente a esperada (rota pública nova é decisão consciente)', () => {
    const publicas = listRoutes(api.app)
      .filter((r) => r.access?.kind === 'publico')
      .map((r) => `${r.method} ${r.path}`)
      .sort();
    expect(publicas).toEqual(PUBLIC_ROUTES);
  });

  it('toda rota não pública responde 401 sem cookie', async () => {
    const privadas = listRoutes(api.app).filter((r) => r.access?.kind !== 'publico');
    expect(privadas.length).toBeGreaterThan(0);
    for (const route of privadas) {
      const path = route.path.replace(/:[a-zA-Z_]+/g, '0192f1d4-3c1a-7b2e-9a10-5f1e2d3c4b5a');
      const res = await api.call(route.method, path, route.method === 'GET' ? {} : { body: {} });
      expect({ rota: `${route.method} ${route.path}`, status: res.status }).toEqual({ rota: `${route.method} ${route.path}`, status: 401 });
    }
  });

  it('cookie inválido também é 401', async () => {
    const res = await api.call('GET', '/v1/me', { cookie: 'liame_sessao=token-que-nao-existe' });
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('nao-autenticado');
  });
});
