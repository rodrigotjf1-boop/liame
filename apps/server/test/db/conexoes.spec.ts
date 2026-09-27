import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import { createDatabase, type Database } from '@liame/database';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';
import { VaultService } from '../../src/vault/vault.service.js';
import { ConexaoProcessor } from '../../src/worker/conexao-processor.js';
import { enableMfa, ownerQuery, resetIpRateLimits, signupAndLogin, startApi, type TestApi } from '../helpers/api.js';
import { APP_URL, hasDb } from './env.js';

// A2 · G3: conectar contas de ponta a ponta contra uma "plataforma" local (Meta, OAuth do Google,
// Google Ads e GA4 numa origem só, com prefixo por serviço). O navegador só vê a página de autorização
// e a volta; token nenhum passa pela API; o worker troca o código, guarda no cofre e descobre as contas.

const FIX = resolve(import.meta.dirname, '../fixtures');
const API_PUBLICA = 'http://api.liame.test';
const VOLTA = `${API_PUBLICA}/v1/oauth/callback`;

describe.skipIf(!hasDb)('conectar contas (OAuth)', () => {
  let api: TestApi;
  let database: Database;
  let processador: ConexaoProcessor;
  let plataforma: Server;
  let base = '';
  const vistos: { caminho: string; autorizacao?: string; corpo?: URLSearchParams }[] = [];
  const desafios = new Map<string, string>();
  const revogados: string[] = [];
  const anterior: Record<string, string | undefined> = {};

  const fixture = (arquivo: string) => JSON.parse(readFileSync(resolve(FIX, arquivo), 'utf8')) as unknown;

  function responder(req: IncomingMessage, texto: string): { status: number; corpo: unknown } {
    const url = new URL(req.url ?? '/', base);
    const corpo = req.headers['content-type']?.includes('x-www-form-urlencoded') ? new URLSearchParams(texto) : undefined;
    vistos.push({ caminho: url.pathname, autorizacao: req.headers.authorization, corpo });
    const p = url.pathname;
    // Meta: troca do código e contas de anúncio.
    if (p === '/graph/v26.0/oauth/access_token') {
      const q = url.searchParams;
      const ok = q.get('code') === 'codigo-meta-bom' && q.get('client_secret') === 'segredo-do-app-meta-teste' && q.get('redirect_uri') === VOLTA && q.get('client_id') === '1234567890123';
      return ok ? { status: 200, corpo: { access_token: 'token-sistema-meta', token_type: 'bearer' } } : { status: 400, corpo: { error: { message: 'Invalid verification code format.', type: 'OAuthException', code: 100 } } };
    }
    if (p === '/graph/v26.0/me/adaccounts') return { status: 200, corpo: fixture('meta/v26.0/adaccounts.json') };
    // OAuth do Google: código (com PKCE), renovação e revogação.
    if (p === '/oauth2/token' && corpo?.get('grant_type') === 'authorization_code') {
      const verificador = corpo.get('code_verifier') ?? '';
      const desafio = createHash('sha256').update(verificador).digest('base64url');
      const ok = corpo.get('code') === 'codigo-google-bom' && desafios.has(desafio) && corpo.get('redirect_uri') === VOLTA && corpo.get('client_secret') === 'segredo-cliente-google-teste';
      if (!ok) return { status: 400, corpo: { error: 'invalid_grant', error_description: 'Bad Request' } };
      return {
        status: 200,
        corpo: {
          access_token: 'acesso-google-1',
          expires_in: 3599,
          refresh_token: 'refresh-google-1',
          scope: 'https://www.googleapis.com/auth/adwords https://www.googleapis.com/auth/analytics.readonly',
          token_type: 'Bearer',
          refresh_token_expires_in: 604_799,
        },
      };
    }
    if (p === '/oauth2/token' && corpo?.get('grant_type') === 'refresh_token') {
      return corpo.get('refresh_token') === 'refresh-google-1' ? { status: 200, corpo: { access_token: 'acesso-google-2', expires_in: 3599, token_type: 'Bearer' } } : { status: 400, corpo: { error: 'invalid_grant' } };
    }
    if (p === '/oauth2/revoke') {
      revogados.push(corpo?.get('token') ?? '');
      return { status: 200, corpo: {} };
    }
    // Google Ads e GA4 (as mesmas respostas gravadas dos contratos G5 e G6).
    if (p === '/ads/v25/customers:listAccessibleCustomers') return { status: 200, corpo: fixture('google-ads/v25/list-accessible-customers.json') };
    const cc = p.match(/^\/ads\/v25\/customers\/(\d+)\/googleAds:searchStream$/);
    if (cc) return { status: 200, corpo: fixture(`google-ads/v25/customer-clients-${cc[1]}.json`) };
    if (p === '/ga4admin/v1beta/accountSummaries') {
      return { status: 200, corpo: fixture(url.searchParams.get('pageToken') ? 'ga4/v1beta/account-summaries-2.json' : 'ga4/v1beta/account-summaries-1.json') };
    }
    const prop = p.match(/^\/ga4admin\/v1beta\/properties\/(\d+)$/);
    if (prop?.[1] === '999000111') return { status: 403, corpo: { error: { code: 403, status: 'PERMISSION_DENIED', message: 'no' } } };
    if (prop) return { status: 200, corpo: fixture(`ga4/v1beta/property-${prop[1]}.json`) };
    return { status: 404, corpo: { error: { code: 404, status: 'NOT_FOUND', message: p } } };
  }

  beforeAll(async () => {
    plataforma = createServer((req, res) => {
      let texto = '';
      req.on('data', (c: Buffer) => {
        texto += c.toString('utf8');
      });
      req.on('end', () => {
        const r = responder(req, texto);
        res.writeHead(r.status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(r.corpo));
      });
    });
    await new Promise<void>((ok) => plataforma.listen(0, '127.0.0.1', ok));
    base = `http://127.0.0.1:${(plataforma.address() as AddressInfo).port}`;
    const ambiente = {
      API_URL: API_PUBLICA,
      META_APP_ID: '1234567890123',
      META_APP_SECRET: 'segredo-do-app-meta-teste',
      META_LOGIN_CONFIG_ID: '99887766554433',
      META_DIALOG_URL: `${base}/dialog`,
      META_GRAPH_URL: `${base}/graph`,
      GOOGLE_OAUTH_CLIENT_ID: 'cliente-google-teste.apps.googleusercontent.com',
      GOOGLE_OAUTH_CLIENT_SECRET: 'segredo-cliente-google-teste',
      GOOGLE_AUTH_URL: `${base}/google`,
      GOOGLE_TOKEN_URL: `${base}/oauth2`,
      GOOGLE_ADS_URL: `${base}/ads`,
      GA4_DATA_URL: `${base}/ga4data`,
      GA4_ADMIN_URL: `${base}/ga4admin`,
    };
    for (const k of Object.keys(ambiente)) anterior[k] = process.env[k];
    Object.assign(process.env, ambiente);
    api = await startApi();
    await resetIpRateLimits();
    database = createDatabase({ connectionString: APP_URL, max: 3, applicationName: 'liame-test' });
    processador = new ConexaoProcessor(database, loadConfig(), api.app.get(VaultService));
  });
  afterAll(async () => {
    await api?.close();
    await database?.close();
    await new Promise((ok) => plataforma?.close(ok));
    for (const [k, v] of Object.entries(anterior)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  async function empresa(nome: string) {
    const s = await signupAndLogin(api, undefined, nome);
    await enableMfa(api, s.cookie);
    const tenantId = s.me.active_organization_id as string;
    const [marca] = await ownerQuery<{ id: string }>(`select id from liame.brand where tenant_id = $1 limit 1`, [tenantId]);
    return { cookie: s.cookie, tenantId, brandId: marca!.id };
  }

  /** A plataforma manda o navegador de volta: GET com a sessão, sem seguir o redirecionamento. */
  async function voltar(cookie: string, params: Record<string, string>) {
    const res = await fetch(`${api.base}/v1/oauth/callback?${new URLSearchParams(params).toString()}`, { headers: { cookie }, redirect: 'manual' });
    return { status: res.status, destino: res.headers.get('location') ?? '' };
  }

  const conexao = async (id: string) =>
    (await ownerQuery<{ status: string; error_code: string | null; code_enc: string | null; pkce_verifier_enc: string | null; credential_secret_id: string | null; discovered: unknown[]; scopes: string[]; refresh_expires_at: Date | null }>(
      `select status, error_code, code_enc, pkce_verifier_enc, credential_secret_id, discovered, scopes, refresh_expires_at from liame.oauth_connection where id = $1`,
      [id],
    ))[0]!;

  it('Meta: autorizar, voltar, trocar no worker, escolher a conta e desligar', async () => {
    const e = await empresa('Casa Brasa Conexões');
    const inicio = await api.call('POST', '/v1/connections', { cookie: e.cookie, body: { provider: 'meta', brand_id: e.brandId } });
    expect(inicio.status).toBe(201);
    const autorizar = new URL(inicio.body.authorize_url);
    expect(`${autorizar.origin}${autorizar.pathname}`).toBe(`${base}/dialog/v26.0/dialog/oauth`);
    expect(Object.fromEntries(autorizar.searchParams)).toMatchObject({
      client_id: '1234567890123',
      config_id: '99887766554433',
      redirect_uri: VOLTA,
      response_type: 'code',
      override_default_response_type: 'true',
    });
    const estado = autorizar.searchParams.get('state')!;
    const [linha] = await ownerQuery<{ state_hash: string }>(`select state_hash from liame.oauth_connection where id = $1`, [inicio.body.id]);
    expect(linha!.state_hash).toBe(createHash('sha256').update(estado).digest('hex'));

    const volta = await voltar(e.cookie, { state: estado, code: 'codigo-meta-bom' });
    expect(volta).toEqual({ status: 303, destino: `http://localhost:3000/contas?conexao=${inicio.body.id}` });
    const recebida = await conexao(inicio.body.id);
    expect(recebida.status).toBe('recebida');
    expect(recebida.code_enc).toMatch(/^pii1\./);
    expect(recebida.code_enc).not.toContain('codigo-meta-bom');

    // A mesma volta de novo (replay) não vale.
    expect((await voltar(e.cookie, { state: estado, code: 'codigo-meta-bom' })).destino).toBe('http://localhost:3000/contas?erro=autorizacao_invalida');

    expect(await processador.processarLote(5, { tenantIds: [e.tenantId] })).toBe(1);
    const pronta = await conexao(inicio.body.id);
    expect(pronta).toMatchObject({ status: 'aguardando_escolha', code_enc: null, error_code: null });
    const [segredo] = await ownerQuery<{ purpose: string; ciphertext: string }>(`select purpose, ciphertext from liame.secret where id = $1`, [pronta.credential_secret_id]);
    expect(segredo!.purpose).toBe('oauth_meta');
    expect(segredo!.ciphertext).not.toContain('token-sistema-meta');
    expect(vistos.find((v) => v.caminho === '/graph/v26.0/me/adaccounts')?.autorizacao).toBe('Bearer token-sistema-meta');

    const lista = await api.call('GET', '/v1/connections', { cookie: e.cookie });
    expect(lista.status).toBe(200);
    expect(JSON.stringify(lista.body)).not.toContain('token-sistema-meta');
    const item = lista.body.items.find((i: { id: string }) => i.id === inicio.body.id);
    expect(item.discovered.map((d: { external_id: string; linked: boolean }) => [d.external_id, d.linked])).toEqual([
      ['act_1234567890', false],
      ['act_2233445566', false],
    ]);

    const ligar = await api.call('POST', `/v1/connections/${inicio.body.id}/accounts`, { cookie: e.cookie, body: { accounts: [{ provider: 'meta_ads', external_id: 'act_1234567890' }] } });
    expect(ligar.status).toBe(200);
    expect(ligar.body.linked).toHaveLength(1);
    expect(ligar.body.linked[0]).toMatchObject({ brand_id: e.brandId, connection_id: inicio.body.id, provider: 'meta_ads', name: 'Casa Brasa', currency: 'BRL', status: 'ativa' });
    const [ligada] = await ownerQuery<{ credential_secret_id: string }>(`select credential_secret_id from liame.connected_account where id = $1`, [ligar.body.linked[0].id]);
    expect(ligada!.credential_secret_id).toBe(pronta.credential_secret_id);
    expect((await conexao(inicio.body.id)).status).toBe('ativa');

    const deNovo = await api.call('POST', `/v1/connections/${inicio.body.id}/accounts`, { cookie: e.cookie, body: { accounts: [{ provider: 'meta_ads', external_id: 'act_1234567890' }] } });
    expect(deNovo.body).toEqual({ linked: [], already_linked: [{ provider: 'meta_ads', external_id: 'act_1234567890' }] });
    const estranha = await api.call('POST', `/v1/connections/${inicio.body.id}/accounts`, { cookie: e.cookie, body: { accounts: [{ provider: 'meta_ads', external_id: 'act_9999999999' }] } });
    expect(estranha.status).toBe(422);

    const detalhe = await api.call('GET', `/v1/connections/${inicio.body.id}`, { cookie: e.cookie });
    expect(detalhe.body.discovered.find((d: { external_id: string }) => d.external_id === 'act_1234567890').linked).toBe(true);

    const desligar = await api.call('DELETE', `/v1/connected-accounts/${ligar.body.linked[0].id}`, { cookie: e.cookie });
    expect(desligar.status).toBe(204);
    expect((await api.call('DELETE', `/v1/connected-accounts/${ligar.body.linked[0].id}`, { cookie: e.cookie })).status).toBe(404);
    const religar = await api.call('POST', `/v1/connections/${inicio.body.id}/accounts`, { cookie: e.cookie, body: { accounts: [{ provider: 'meta_ads', external_id: 'act_1234567890' }] } });
    expect(religar.body.linked).toHaveLength(1);

    const acoes = await ownerQuery<{ action: string }>(`select action from liame.audit_event where tenant_id = $1 order by chain_seq`, [e.tenantId]);
    expect(acoes.map((a) => a.action)).toEqual(expect.arrayContaining(['conexao.iniciar', 'conexao.autorizar', 'conexao.concluir', 'conta.conectar', 'conta.desconectar']));
  });

  it('Google: PKCE, Google Ads e GA4 na mesma autorização, procurar de novo pelo refresh token e revogar', async () => {
    const e = await empresa('Casa Brasa Google Conexões');
    const inicio = await api.call('POST', '/v1/connections', { cookie: e.cookie, body: { provider: 'google', brand_id: e.brandId } });
    expect(inicio.status).toBe(201);
    const autorizar = new URL(inicio.body.authorize_url);
    expect(`${autorizar.origin}${autorizar.pathname}`).toBe(`${base}/google/o/oauth2/v2/auth`);
    expect(Object.fromEntries(autorizar.searchParams)).toMatchObject({
      client_id: 'cliente-google-teste.apps.googleusercontent.com',
      redirect_uri: VOLTA,
      response_type: 'code',
      scope: 'https://www.googleapis.com/auth/adwords https://www.googleapis.com/auth/analytics.readonly',
      access_type: 'offline',
      prompt: 'consent',
      code_challenge_method: 'S256',
    });
    desafios.set(autorizar.searchParams.get('code_challenge')!, inicio.body.id);
    expect((await conexao(inicio.body.id)).pkce_verifier_enc).toMatch(/^pii1\./);

    expect((await voltar(e.cookie, { state: autorizar.searchParams.get('state')!, code: 'codigo-google-bom', scope: 'x' })).status).toBe(303);
    expect(await processador.processarLote(5, { tenantIds: [e.tenantId] })).toBe(1);
    const pronta = await conexao(inicio.body.id);
    expect(pronta).toMatchObject({ status: 'aguardando_escolha', pkce_verifier_enc: null, code_enc: null });
    expect(pronta.scopes).toEqual(['https://www.googleapis.com/auth/adwords', 'https://www.googleapis.com/auth/analytics.readonly']);
    expect(pronta.refresh_expires_at).not.toBeNull();
    expect((pronta.discovered as { provider: string; external_id: string }[]).map((d) => `${d.provider}:${d.external_id}`)).toEqual([
      'google_ads:4445556667',
      'google_ads:5556667778',
      'ga4:333444555',
      'ga4:666777888',
    ]);

    const ligar = await api.call('POST', `/v1/connections/${inicio.body.id}/accounts`, {
      cookie: e.cookie,
      body: { accounts: [{ provider: 'google_ads', external_id: '4445556667' }, { provider: 'ga4', external_id: '333444555' }] },
    });
    expect(ligar.body.linked.map((c: { provider: string }) => c.provider).sort()).toEqual(['ga4', 'google_ads']);
    const [ads] = await ownerQuery<{ provider_attributes: Record<string, unknown> }>(`select provider_attributes from liame.connected_account where connection_id = $1 and provider = 'google_ads'`, [inicio.body.id]);
    expect(ads!.provider_attributes).toMatchObject({ login_customer_id: '1112223334' });

    // Procurar de novo usa o refresh token guardado (token novo, sem código).
    const antes = vistos.length;
    const procura = await api.call('POST', `/v1/connections/${inicio.body.id}/discover`, { cookie: e.cookie });
    expect(procura.status).toBe(202);
    expect(procura.body.status).toBe('recebida');
    expect(await processador.processarLote(5, { tenantIds: [e.tenantId] })).toBe(1);
    expect((await conexao(inicio.body.id)).status).toBe('ativa');
    const novos = vistos.slice(antes);
    expect(novos.some((v) => v.caminho === '/oauth2/token' && v.corpo?.get('grant_type') === 'refresh_token')).toBe(true);
    expect(novos.filter((v) => v.caminho.startsWith('/ads/')).every((v) => v.autorizacao === 'Bearer acesso-google-2')).toBe(true);

    const revogar = await api.call('DELETE', `/v1/connections/${inicio.body.id}`, { cookie: e.cookie });
    expect(revogar.status).toBe(204);
    const [segredo] = await ownerQuery<{ revoked_at: Date | null }>(`select revoked_at from liame.secret where id = $1`, [pronta.credential_secret_id]);
    expect(segredo!.revoked_at).not.toBeNull();
    const contas = await ownerQuery<{ status: string }>(`select status from liame.connected_account where connection_id = $1`, [inicio.body.id]);
    expect(contas.every((c) => c.status === 'desconectada')).toBe(true);
    await new Promise((ok) => setTimeout(ok, 200));
    expect(revogados).toContain('refresh-google-1');
  });

  it('recusa na plataforma, código ruim, prazo vencido e outra empresa', async () => {
    const e = await empresa('Casa Brasa Falhas');
    const estadoDe = async (provider: 'meta' | 'google') => {
      const r = await api.call('POST', '/v1/connections', { cookie: e.cookie, body: { provider, brand_id: e.brandId } });
      return { id: r.body.id as string, estado: new URL(r.body.authorize_url).searchParams.get('state')! };
    };

    const recusa = await estadoDe('meta');
    const r1 = await voltar(e.cookie, { state: recusa.estado, error: 'access_denied', error_reason: 'user_denied' });
    expect(r1.destino).toBe(`http://localhost:3000/contas?conexao=${recusa.id}&erro=recusada_na_plataforma`);
    expect(await conexao(recusa.id)).toMatchObject({ status: 'erro', error_code: 'recusada_na_plataforma' });

    const ruim = await estadoDe('meta');
    await voltar(e.cookie, { state: ruim.estado, code: 'codigo-ruim' });
    await processador.processarLote(5, { tenantIds: [e.tenantId] });
    expect(await conexao(ruim.id)).toMatchObject({ status: 'erro', error_code: 'troca_recusada', code_enc: null, credential_secret_id: null });

    const vencida = await estadoDe('meta');
    await ownerQuery(`update liame.oauth_connection set expires_at = now() - interval '1 minute' where id = $1`, [vencida.id]);
    expect((await voltar(e.cookie, { state: vencida.estado, code: 'codigo-meta-bom' })).destino).toContain('erro=autorizacao_expirada');
    const esquecida = await estadoDe('google');
    await ownerQuery(`update liame.oauth_connection set expires_at = now() - interval '1 minute' where id = $1`, [esquecida.id]);
    await processador.processarLote(5, { tenantIds: [e.tenantId] });
    expect((await conexao(esquecida.id)).status).toBe('expirada');

    // Outra empresa não usa o estado nem enxerga a conexão.
    const outra = await empresa('Outra Casa');
    const alheia = await estadoDe('meta');
    expect((await voltar(outra.cookie, { state: alheia.estado, code: 'codigo-meta-bom' })).destino).toContain('erro=autorizacao_invalida');
    expect((await conexao(alheia.id)).status).toBe('aguardando_autorizacao');
    expect((await api.call('GET', `/v1/connections/${recusa.id}`, { cookie: outra.cookie })).status).toBe(404);
    expect((await api.call('DELETE', `/v1/connections/${recusa.id}`, { cookie: outra.cookie })).status).toBe(404);
  });
});
