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
  'POST /v1/inbox/:provider',
  'POST /v1/inbox/:provider/:connectionId',
  'POST /v1/invitations/preview',
  'POST /v1/invitations/signup',
  'GET /v1/legal/terms',
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

  it('fora da transação da requisição só rodam as rotas revisadas: as que esperam um modelo de IA (A3, I4 e I10), a que lê o objeto na plataforma de anúncio (A4, X8), as duas que leem as conversões da conta no Google (A5, Y1), o começo de uma conexão (o pedido empurrado do RegemCast, Hub DMS B1), o envio de uma foto (A6, Z4) e o PIX de uma fatura (A7, W2a)', () => {
    const semTransacao = listRoutes(api.app)
      .filter((r) => r.semTransacao)
      .map((r) => `${r.method} ${r.path}`)
      .sort();
    // `GET /v1/actions/options` só lê: o banco numa transação curta e a plataforma depois, sem transação aberta.
    // As duas das conversões leem a lista de conversões no Google: `actions` só lê; `destination` confere o id
    // escolhido no Google e só então grava, noutra transação curta, com o evento de auditoria junto (manual).
    // As duas da mensageria só leem do RegemCast, na hora, e não gravam nada.
    // `GET /v1/reviews/authors` (A6, Z1) lê do Google o nome de quem avaliou, só para a tela: o banco numa transação
    // curta, o Google depois, e nada gravado (nem o nome, nem auditoria).
    // `POST /v1/connections` (Hub DMS, B1): no RegemCast, o pedido empurrado (RFC 9126) sai antes de a pessoa ir; o
    // banco lê numa transação curta, o pedido vem depois, sem transação aberta, e a conexão entra com o evento de
    // auditoria (manual) noutra transação curta. Nas outras plataformas, nada sai entre as duas.
    // `POST /v1/brand-photos` (A6, Z4): a foto é conferida e regravada sem transação; a linha nasce `enviando` numa
    // transação curta, o arquivo vai ao armazenamento (S3) sem transação aberta, e a foto fica `pronta` com o evento de
    // auditoria (manual) noutra transação curta.
    // `GET /v1/billing/invoices/:id/pix` (A7, W2a): lê e reserva a fatura numa transação curta, com a empresa no contexto
    // da RLS; procura e cria no Asaas o cliente e a cobrança, e lê o QR Code, sem transação aberta; e grava a referência
    // da cobrança noutra transação curta. Sem auditoria: só lê e liga a fatura à cobrança dela (nenhum dinheiro muda).
    expect(semTransacao).toEqual([
      'GET /v1/actions/options',
      'GET /v1/billing/invoices/:id/pix',
      'GET /v1/conversions/google/actions',
      'GET /v1/messaging',
      'GET /v1/messaging/campaigns/:id',
      'GET /v1/reviews/authors',
      'POST /v1/ai/explain/attention',
      'POST /v1/ai/explain/results',
      'POST /v1/brand-photos',
      'POST /v1/connections',
      'POST /v1/conversations/messages',
      'PUT /v1/conversions/google/destination',
    ]);
  });

  it('cookie inválido também é 401', async () => {
    const res = await api.call('GET', '/v1/me', { cookie: 'liame_sessao=token-que-nao-existe' });
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('nao-autenticado');
  });
});
