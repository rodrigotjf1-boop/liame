import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { listRoutes } from '../src/auth/routes.js';
import { startApi, type TestApi } from './helpers/api.js';

// A1-4: guard global que nega por padrão. Toda rota declara o acesso; sem sessão, só as públicas respondem.
// O aviso do Asaas (A7, W2a, parte 2): pública porque quem prova a origem é o token do aviso, conferido em tempo
// constante; grava só o evento cru (deduplicado) e responde 200, como o Asaas espera; o resto é do worker.
// O link de confirmação do e-mail de resposta da agência (A7, W7, parte 3): público porque quem o abre lê aquele
// endereço e pode nem ter conta; o token de uso único (24 horas) é a prova, como no e-mail do cadastro.
// O logo da agência (A7, W7, parte 4a): público porque o programa de e-mail o busca sem login, no alto do relatório
// que a agência manda; só a imagem de agora, em JPEG, lida no contexto da agência do endereço.
const PUBLIC_ROUTES = [
  'GET /health',
  'GET /health/ready',
  'POST /v1/auth/signup',
  'POST /v1/auth/verify-email',
  'POST /v1/auth/login',
  // Entrar sem senha com a chave de acesso (A7, W9, parte 9b): a chave vale pela senha e pelo código do app.
  'POST /v1/auth/passkey-options',
  'POST /v1/auth/passkey',
  'POST /v1/auth/password/forgot',
  'POST /v1/auth/password/reset',
  'POST /v1/agency-reply-to/confirm',
  'GET /v1/agency-logos/:arquivo',
  'POST /v1/billing/asaas/webhook',
  'POST /v1/inbox/:provider',
  'POST /v1/inbox/:provider/:connectionId',
  'POST /v1/invitations/preview',
  'POST /v1/invitations/signup',
  'GET /v1/legal/terms',
].sort();

// As rotas que valem com a sessão que só passou pela senha (ADR-013): ler quem entrou, sair, provar o segundo fator e,
// para o Dono sem o celular e sem os códigos, a recuperação da conta (A7, W8, parte 4a; D-A7-62). Rota nova aqui é
// decisão consciente: ela fica ao alcance de quem só tem a senha.
const ANTES_DO_SEGUNDO_FATOR = [
  'GET /v1/me',
  'POST /v1/auth/logout',
  'POST /v1/me/mfa/verify',
  // A chave de acesso no lugar do código do app (A7, W9, parte 9a).
  'POST /v1/me/mfa/passkey-options',
  'POST /v1/me/mfa/passkey',
  'GET /v1/me/account-recovery',
  'POST /v1/me/account-recovery',
  'DELETE /v1/me/account-recovery/:id',
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

  it('a lista de rotas que valem antes do segundo fator é exatamente a esperada (só a senha basta para elas)', () => {
    const antes = listRoutes(api.app)
      .filter((r) => r.access?.kind === 'autenticado' && r.access.beforeMfa)
      .map((r) => `${r.method} ${r.path}`)
      .sort();
    expect(antes).toEqual(ANTES_DO_SEGUNDO_FATOR);
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

  it('fora da transação da requisição só rodam as rotas revisadas: as que esperam um modelo de IA (A3, I4 e I10), a que lê o objeto na plataforma de anúncio (A4, X8), as duas que leem as conversões da conta no Google (A5, Y1), o começo de uma conexão (o pedido empurrado do RegemCast, Hub DMS B1), o envio de uma foto (A6, Z4), o PIX de uma fatura (A7, W2a), o logo da agência e o relatório que ela manda ao cliente (A7, W7), a conferência e a capa do vídeo das Fotos (A6, Z10)', () => {
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
    // `PUT /v1/agency/brand/logo` (A7, W7, parte 3): o mesmo caminho da foto, para o logo da agência: conferido e
    // regravado sem transação, o arquivo vai ao armazenamento sem transação aberta, e a marca muda com o evento de
    // auditoria (manual) numa transação curta.
    // `GET /v1/agency-logos/:arquivo` (A7, W7, parte 4a): lê o logo de agora no contexto da agência do endereço, numa
    // transação curta, e os bytes no armazenamento, sem transação aberta.
    // As três do relatório da agência (A7, W7, parte 4a): a requisição está na agência e o relatório é do cliente; cada
    // cliente é lido no contexto dele, com a pessoa da agência, numa transação curta. O envio grava o envio e as
    // entregas na agência com a auditoria (manual), manda os e-mails sem transação aberta e grava cada resultado.
    // `GET /v1/billing/invoices/:id/pix` (A7, W2a): lê e reserva a fatura numa transação curta, com a empresa no contexto
    // da RLS; procura e cria no Asaas o cliente e a cobrança, e lê o QR Code, sem transação aberta; e grava a referência
    // da cobrança noutra transação curta. Sem auditoria: só lê e liga a fatura à cobrança dela (nenhum dinheiro muda).
    // As duas do vídeo nas Fotos (A6, Z10, parte 1): `POST /v1/brand-photos/:id/video` lê a linha numa transação curta,
    // o tamanho e o cabeçalho do vídeo no armazenamento sem transação aberta, e marca o vídeo pronto com o evento de
    // auditoria (manual) noutra transação curta (o recusado sai da lista, sem auditoria, como a foto que falha).
    // `PUT /v1/brand-photos/:id/cover`: o caminho do logo, para a capa do vídeo (a miniatura, com a auditoria manual).
    expect(semTransacao).toEqual([
      'GET /v1/actions/options',
      'GET /v1/agency-logos/:arquivo',
      'GET /v1/agency/clients/:id/reports/:reportId',
      'GET /v1/agency/reports',
      'GET /v1/billing/invoices/:id/pix',
      'GET /v1/conversions/google/actions',
      'GET /v1/messaging',
      'GET /v1/messaging/campaigns/:id',
      'GET /v1/reviews/authors',
      'POST /v1/agency/clients/:id/reports/:reportId/send',
      'POST /v1/ai/explain/attention',
      'POST /v1/ai/explain/results',
      'POST /v1/brand-photos',
      'POST /v1/brand-photos/:id/video',
      'POST /v1/connections',
      'POST /v1/conversations/messages',
      'PUT /v1/agency/brand/logo',
      'PUT /v1/brand-photos/:id/cover',
      'PUT /v1/conversions/google/destination',
    ]);
  });

  it('cookie inválido também é 401', async () => {
    const res = await api.call('GET', '/v1/me', { cookie: 'liame_sessao=token-que-nao-existe' });
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('nao-autenticado');
  });
});
