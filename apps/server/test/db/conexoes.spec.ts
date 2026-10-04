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
import { ligarEscritaNaMeta } from '../helpers/meta-de-mentira.js';
import { APP_URL, hasDb } from './env.js';

// A2 · G3: conectar contas de ponta a ponta contra uma "plataforma" local (Meta, OAuth do Google,
// Google Ads e GA4 numa origem só, com prefixo por serviço). O navegador só vê a página de autorização
// e a volta; token nenhum passa pela API; o worker troca o código, guarda no cofre e descobre as contas.

const FIX = resolve(import.meta.dirname, '../fixtures');
const API_PUBLICA = 'http://api.liame.test';
const VOLTA = `${API_PUBLICA}/v1/oauth/callback`;
/** As duas configurações do login da Meta: a de leitura (todo mundo) e a de escrita (só a empresa com `meta_write`). */
const CONFIG_LEITURA = '99887766554433';
const CONFIG_ESCRITA = '11223344556677';

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
      META_LOGIN_CONFIG_ID: CONFIG_LEITURA,
      META_LOGIN_CONFIG_ID_ESCRITA: CONFIG_ESCRITA,
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
      // Sem a escrita ligada para a empresa, a configuração de leitura (mesmo com a de escrita configurada).
      config_id: CONFIG_LEITURA,
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
    expect(item.discovered.map((d: { external_id: string; linked: boolean; via: string | null }) => [d.external_id, d.linked, d.via])).toEqual([
      ['act_1234567890', false, null],
      ['act_2233445566', false, null],
    ]);
    // Quem autorizou: quem começou a conexão (só ele pode voltar dela).
    expect(item.authorized_by).toBe('Pessoa de Teste');

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

    // Token recusado na leitura (a sincronização marca a conta): reautorizar a mesma marca assume a conta
    // com a credencial nova; ligar a mesma conta a outra marca não mexe nela.
    await ownerQuery(`update liame.connected_account set status = 'desconectada', status_reason = 'token recusado' where id = $1`, [religar.body.linked[0].id]);
    const reautorizar = async (brandId: string) => {
      const r = await api.call('POST', '/v1/connections', { cookie: e.cookie, body: { provider: 'meta', brand_id: brandId } });
      await voltar(e.cookie, { state: new URL(r.body.authorize_url).searchParams.get('state')!, code: 'codigo-meta-bom' });
      await processador.processarLote(5, { tenantIds: [e.tenantId] });
      return r.body.id as string;
    };
    const nova = await reautorizar(e.brandId);
    const assumida = await api.call('POST', `/v1/connections/${nova}/accounts`, { cookie: e.cookie, body: { accounts: [{ provider: 'meta_ads', external_id: 'act_1234567890' }] } });
    expect(assumida.body.linked).toEqual([expect.objectContaining({ id: religar.body.linked[0].id, connection_id: nova, status: 'ativa', status_reason: null })]);
    const outraMarca = await api.call('POST', '/v1/brands', { cookie: e.cookie, body: { name: 'Casa Brasa Delivery' } });
    expect(outraMarca.status).toBe(201);
    const deOutraMarca = await reautorizar(outraMarca.body.id);
    const recusada = await api.call('POST', `/v1/connections/${deOutraMarca}/accounts`, { cookie: e.cookie, body: { accounts: [{ provider: 'meta_ads', external_id: 'act_1234567890' }] } });
    expect(recusada.body).toEqual({ linked: [], already_linked: [{ provider: 'meta_ads', external_id: 'act_1234567890' }] });

    const acoes = await ownerQuery<{ action: string }>(`select action from liame.audit_event where tenant_id = $1 order by chain_seq`, [e.tenantId]);
    expect(acoes.map((a) => a.action)).toEqual(expect.arrayContaining(['conexao.iniciar', 'conexao.autorizar', 'conexao.concluir', 'conta.conectar', 'conta.desconectar']));
  });

  it('Meta: com a escrita ligada para a empresa, conectar de novo vai pela configuração de escrita e a autorização nova assume a conta', async () => {
    const e = await empresa('Casa Brasa Escrita na Meta');
    const vizinha = await empresa('Casa Brasa Só Leitura');
    const iniciar = async (quem: { cookie: string; brandId: string }) => {
      const r = await api.call('POST', '/v1/connections', { cookie: quem.cookie, body: { provider: 'meta', brand_id: quem.brandId } });
      expect(r.status).toBe(201);
      const url = new URL(r.body.authorize_url);
      return { id: r.body.id as string, config: url.searchParams.get('config_id'), estado: url.searchParams.get('state')! };
    };
    /** O que a auditoria guardou do pedido de conexão: por qual acesso a empresa foi mandada autorizar. */
    const acessoPedido = async (tenantId: string, id: string) =>
      (await ownerQuery<{ acesso: string | null }>(`select "after" ->> 'acesso' as acesso from liame.audit_event where tenant_id = $1 and action = 'conexao.iniciar' and resource_id = $2`, [tenantId, id]))[0]?.acesso;
    const concluir = async (c: { id: string; estado: string }) => {
      expect((await voltar(e.cookie, { state: c.estado, code: 'codigo-meta-bom' })).status).toBe(303);
      expect(await processador.processarLote(5, { tenantIds: [e.tenantId] })).toBe(1);
      return api.call('POST', `/v1/connections/${c.id}/accounts`, { cookie: e.cookie, body: { accounts: [{ provider: 'meta_ads', external_id: 'act_2233445566' }] } });
    };

    // A função nasce desligada: a empresa conecta pela configuração de leitura e liga a conta.
    const leitura = await iniciar(e);
    expect(leitura.config).toBe(CONFIG_LEITURA);
    expect(await acessoPedido(e.tenantId, leitura.id)).toBe('leitura');
    const primeira = await concluir(leitura);
    expect(primeira.body.linked).toEqual([expect.objectContaining({ connection_id: leitura.id, status: 'ativa' })]);

    // Ligada para a empresa (e só para ela): conectar de novo manda autorizar pela configuração de escrita.
    await ligarEscritaNaMeta(api, e.tenantId, true);
    const escrita = await iniciar(e);
    expect(escrita.config).toBe(CONFIG_ESCRITA);
    expect(await acessoPedido(e.tenantId, escrita.id)).toBe('escrita');
    const daVizinha = await iniciar(vizinha);
    expect(daVizinha.config).toBe(CONFIG_LEITURA);
    expect(await acessoPedido(vizinha.tenantId, daVizinha.id)).toBe('leitura');

    // A autorização nova assume a conta (a mesma linha, com a credencial nova) e a antiga, sem conta, é encerrada.
    const segunda = await concluir(escrita);
    expect(segunda.body.linked).toEqual([expect.objectContaining({ id: primeira.body.linked[0].id, connection_id: escrita.id, status: 'ativa' })]);
    expect((await conexao(leitura.id)).status).toBe('revogada');
    expect((await conexao(escrita.id)).status).toBe('ativa');

    // Desligada de novo, a próxima conexão volta para a configuração de leitura.
    await ligarEscritaNaMeta(api, e.tenantId, false);
    expect((await iniciar(e)).config).toBe(CONFIG_LEITURA);
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

    // A conta alcançada pela gerente mostra o nome dela ("via"); a de acesso direto e o GA4, não.
    const detalhe = await api.call('GET', `/v1/connections/${inicio.body.id}`, { cookie: e.cookie });
    expect(detalhe.status).toBe(200);
    expect(detalhe.body.authorized_by).toBe('Pessoa de Teste');
    expect(detalhe.body.discovered.map((d: { external_id: string; via: string | null }) => [d.external_id, d.via])).toEqual([
      ['4445556667', 'Agência Parceira'],
      ['5556667778', null],
      ['333444555', null],
      ['666777888', null],
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

  it('Google em fase de teste: conectar de novo ANTES de vencer passa as contas para a autorização nova e encerra a antiga sem revogar no Google', async () => {
    const e = await empresa('Casa Brasa Renovar Google');
    const autorizar = async () => {
      const inicio = await api.call('POST', '/v1/connections', { cookie: e.cookie, body: { provider: 'google', brand_id: e.brandId } });
      expect(inicio.status).toBe(201);
      const url = new URL(inicio.body.authorize_url);
      desafios.set(url.searchParams.get('code_challenge')!, inicio.body.id);
      expect((await voltar(e.cookie, { state: url.searchParams.get('state')!, code: 'codigo-google-bom', scope: 'x' })).status).toBe(303);
      expect(await processador.processarLote(5, { tenantIds: [e.tenantId] })).toBe(1);
      return inicio.body.id as string;
    };
    const contasDe = (id: string) =>
      ownerQuery<{ provider: string; status: string; credential_secret_id: string }>(
        `select provider, status, credential_secret_id from liame.connected_account where connection_id = $1 and disconnected_at is null order by provider`,
        [id],
      );

    // A autorização de 29/09: Google Ads e GA4 ligados; vence daqui a dois dias.
    const antiga = await autorizar();
    const ligar = await api.call('POST', `/v1/connections/${antiga}/accounts`, {
      cookie: e.cookie,
      body: { accounts: [{ provider: 'google_ads', external_id: '4445556667' }, { provider: 'ga4', external_id: '333444555' }] },
    });
    expect(ligar.body.linked).toHaveLength(2);
    await ownerQuery(`update liame.oauth_connection set refresh_expires_at = now() + interval '2 days' where id = $1`, [antiga]);
    const credencialAntiga = (await conexao(antiga)).credential_secret_id;

    // A pessoa conecta de novo antes de vencer: a autorização nova alcança as mesmas contas (já ligadas pela antiga).
    const nova = await autorizar();
    expect((await conexao(nova)).status).toBe('aguardando_escolha');
    const credencialNova = (await conexao(nova)).credential_secret_id;
    const antes = revogados.length;

    // Só o Google Ads passa: a antiga ainda lê o GA4 e segue valendo.
    const primeiro = await api.call('POST', `/v1/connections/${nova}/accounts`, { cookie: e.cookie, body: { accounts: [{ provider: 'google_ads', external_id: '4445556667' }] } });
    expect(primeiro.status).toBe(200);
    expect(primeiro.body.linked.map((c: { provider: string; status: string }) => [c.provider, c.status])).toEqual([['google_ads', 'ativa']]);
    expect(primeiro.body.already_linked).toEqual([]);
    expect(await contasDe(nova)).toEqual([{ provider: 'google_ads', status: 'ativa', credential_secret_id: credencialNova }]);
    expect(await contasDe(antiga)).toEqual([{ provider: 'ga4', status: 'ativa', credential_secret_id: credencialAntiga }]);
    expect((await conexao(antiga)).status).toBe('ativa');

    // O GA4 também passa: a antiga fica sem conta e é encerrada aqui (credencial fora do cofre), SEM revogar no
    // Google — por precaução: revogar o token antigo pode levar junto o consentimento da autorização nova.
    const segundo = await api.call('POST', `/v1/connections/${nova}/accounts`, { cookie: e.cookie, body: { accounts: [{ provider: 'ga4', external_id: '333444555' }] } });
    expect(segundo.body.linked.map((c: { provider: string }) => c.provider)).toEqual(['ga4']);
    expect((await contasDe(nova)).map((c) => [c.provider, c.status, c.credential_secret_id === credencialNova])).toEqual([
      ['ga4', 'ativa', true],
      ['google_ads', 'ativa', true],
    ]);
    expect((await conexao(antiga)).status).toBe('revogada');
    expect((await conexao(nova)).status).toBe('ativa');
    const [segredoAntigo] = await ownerQuery<{ revoked_at: Date | null }>(`select revoked_at from liame.secret where id = $1`, [credencialAntiga]);
    expect(segredoAntigo!.revoked_at).not.toBeNull();
    const [segredoNovo] = await ownerQuery<{ revoked_at: Date | null }>(`select revoked_at from liame.secret where id = $1`, [credencialNova]);
    expect(segredoNovo!.revoked_at).toBeNull();
    await new Promise((ok) => setTimeout(ok, 300));
    expect(revogados.length).toBe(antes);
    const [auditoria] = await ownerQuery<{ after: { autorizacoes_encerradas?: string[] } }>(
      `select after from liame.audit_event where tenant_id = $1 and resource_id = $2 and after ? 'autorizacoes_encerradas' order by chain_seq desc limit 1`,
      [e.tenantId, nova],
    );
    expect(auditoria?.after.autorizacoes_encerradas).toEqual([antiga]);

    // Revogar a que ficou continua revogando no Google (é o "sim" que vale agora).
    expect((await api.call('DELETE', `/v1/connections/${nova}`, { cookie: e.cookie })).status).toBe(204);
    await new Promise((ok) => setTimeout(ok, 300));
    expect(revogados.length).toBe(antes + 1);
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
