import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import { ConnectionListResponse } from '@liame/contracts';
import { createDatabase, type Database } from '@liame/database';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';
import { procuraDosSites } from '../../src/connections/connections.service.js';
import { ESCOPOS_GOOGLE } from '../../src/connections/oauth.js';
import { ESCOPO_PERFIL_GOOGLE } from '../../src/connectors/google-business/perfil-google.js';
import { ESCOPO_SEARCH_CONSOLE } from '../../src/connectors/search-console/search-console.js';
import { FlagService } from '../../src/flags/flag.service.js';
import { VaultService } from '../../src/vault/vault.service.js';
import { ConexaoProcessor, siteDescoberto } from '../../src/worker/conexao-processor.js';
import { enableMfa, ownerQuery, resetIpRateLimits, signupAndLogin, startApi, type TestApi } from '../helpers/api.js';
import { ligarFlagDaEmpresa } from '../helpers/meta-de-mentira.js';
import { APP_URL, hasDb } from './env.js';

// A6 · Z3 (parte b): a conexão do Search Console, de ponta a ponta, contra um Google local (o OAuth, o Google Ads, o
// GA4, o Perfil e o Search Console numa origem só). O que se prova aqui:
//   - a permissão do Search Console só é pedida à empresa com a função ligada, e só então o Liame procura os sites;
//   - o site que a empresa pode ler vira uma conta ligada da marca, pela mesma autorização do Google;
//   - o limite, a recusa e a queda do Search Console NÃO derrubam a conexão, e o Liame não insiste;
//   - a procura dos sites e a das lojas do Perfil andam juntas sem uma apagar a anotação da outra.

const FIX = resolve(import.meta.dirname, '../fixtures');
const API_PUBLICA = 'http://api.liame.test';
const VOLTA = `${API_PUBLICA}/v1/oauth/callback`;
const LEITURA = [...ESCOPOS_GOOGLE];
const CONTA = 'accounts/111000111';
const LOJA = 'locations/222000222';
const DOMINIO = 'sc-domain:misterburgers.exemplo.test';
const CARDAPIO = 'https://cardapio.misterburgers.exemplo.test/';
/** Um site com o endereço mais comprido que o código de uma conta ligada aceita (100 caracteres). */
const COMPRIDO = `https://misterburgers.exemplo.test/${'cardapio-'.repeat(8)}/`;
const DE_ANUNCIO = ['google_ads:4445556667', 'google_ads:5556667778', 'ga4:333444555', 'ga4:666777888'];
const SITES_PADRAO = [
  { siteUrl: DOMINIO, permissionLevel: 'siteOwner' },
  { siteUrl: CARDAPIO, permissionLevel: 'siteRestrictedUser' },
  { siteUrl: 'https://alheio.exemplo.test/', permissionLevel: 'siteUnverifiedUser' },
  { siteUrl: COMPRIDO, permissionLevel: 'siteFullUser' },
];

type Descoberta = { provider: string; external_id: string; name: string; currency: string | null; timezone: string | null; provider_attributes: Record<string, unknown> };
type Resposta = 'ok' | 'sem-cota' | 'cota-antiga' | 'recusa' | 'fora';

describe.skipIf(!hasDb)('conectar o Search Console (A6 · Z3)', () => {
  let api: TestApi;
  let database: Database;
  let processador: ConexaoProcessor;
  let google: Server;
  let base = '';
  const vistos: { caminho: string; autorizacao?: string }[] = [];
  const desafios = new Set<string>();
  const anterior: Record<string, string | undefined> = {};
  let concedidos: string[] = [];
  let sites: Resposta = 'ok';
  let listaDeSites = SITES_PADRAO;
  let trocas = 0;

  const fixture = (arquivo: string) => JSON.parse(readFileSync(resolve(FIX, arquivo), 'utf8')) as unknown;

  function responder(req: IncomingMessage, texto: string): { status: number; corpo: unknown } {
    const url = new URL(req.url ?? '/', base);
    const corpo = req.headers['content-type']?.includes('x-www-form-urlencoded') ? new URLSearchParams(texto) : undefined;
    const p = url.pathname;
    vistos.push({ caminho: p, autorizacao: req.headers.authorization });
    if (p === '/oauth2/token' && corpo?.get('grant_type') === 'authorization_code') {
      const desafio = createHash('sha256').update(corpo.get('code_verifier') ?? '').digest('base64url');
      if (corpo.get('code') !== 'codigo-google-bom' || !desafios.has(desafio) || corpo.get('redirect_uri') !== VOLTA) return { status: 400, corpo: { error: 'invalid_grant' } };
      trocas++;
      return { status: 200, corpo: { access_token: 'acesso-google-1', expires_in: 3599, refresh_token: `refresh-google-${trocas}`, scope: concedidos.join(' '), token_type: 'Bearer' } };
    }
    if (p === '/oauth2/token' && corpo?.get('grant_type') === 'refresh_token') return { status: 200, corpo: { access_token: 'acesso-google-2', expires_in: 3599, token_type: 'Bearer' } };
    if (p === '/oauth2/revoke') return { status: 200, corpo: {} };
    // Google Ads e GA4: as respostas gravadas dos contratos G5 e G6.
    if (p === '/ads/v25/customers:listAccessibleCustomers') return { status: 200, corpo: fixture('google-ads/v25/list-accessible-customers.json') };
    const cc = p.match(/^\/ads\/v25\/customers\/(\d+)\/googleAds:searchStream$/);
    if (cc) return { status: 200, corpo: fixture(`google-ads/v25/customer-clients-${cc[1]}.json`) };
    if (p === '/ga4admin/v1beta/accountSummaries') {
      return { status: 200, corpo: fixture(url.searchParams.get('pageToken') ? 'ga4/v1beta/account-summaries-2.json' : 'ga4/v1beta/account-summaries-1.json') };
    }
    const prop = p.match(/^\/ga4admin\/v1beta\/properties\/(\d+)$/);
    if (prop?.[1] === '999000111') return { status: 403, corpo: { error: { code: 403, status: 'PERMISSION_DENIED', message: 'no' } } };
    if (prop) return { status: 200, corpo: fixture(`ga4/v1beta/property-${prop[1]}.json`) };
    // O Perfil da Empresa: uma conta com uma loja.
    if (p === '/contas/v1/accounts') return { status: 200, corpo: { accounts: [{ name: CONTA, accountName: 'Mister Burgers' }] } };
    if (p === `/lojas/v1/${CONTA}/locations`) return { status: 200, corpo: { locations: [{ name: LOJA, title: 'Mister Burgers — Centro' }] } };
    // O Search Console: os erros no formato antigo das APIs do Google (`error.errors[].reason`).
    if (p.startsWith('/sc/')) {
      if (sites === 'sem-cota') return { status: 429, corpo: { error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'Quota exceeded' } } };
      if (sites === 'cota-antiga') return { status: 403, corpo: { error: { code: 403, message: 'User Rate Limit Exceeded', errors: [{ domain: 'usageLimits', reason: 'userRateLimitExceeded' }] } } };
      if (sites === 'recusa') return { status: 403, corpo: { error: { code: 403, message: 'Forbidden', errors: [{ domain: 'global', reason: 'forbidden' }] } } };
      if (sites === 'fora') return { status: 503, corpo: { error: { code: 503, message: 'Backend Error', errors: [{ domain: 'global', reason: 'backendError' }] } } };
      if (p === '/sc/webmasters/v3/sites' && req.method === 'GET') return { status: 200, corpo: { siteEntry: listaDeSites } };
    }
    return { status: 404, corpo: { error: { code: 404, status: 'NOT_FOUND', message: p } } };
  }

  beforeAll(async () => {
    google = createServer((req, res) => {
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
    await new Promise<void>((ok) => google.listen(0, '127.0.0.1', ok));
    base = `http://127.0.0.1:${(google.address() as AddressInfo).port}`;
    const ambiente = {
      API_URL: API_PUBLICA,
      GOOGLE_OAUTH_CLIENT_ID: 'cliente-google-teste.apps.googleusercontent.com',
      GOOGLE_OAUTH_CLIENT_SECRET: 'segredo-cliente-google-teste',
      GOOGLE_AUTH_URL: `${base}/google`,
      GOOGLE_TOKEN_URL: `${base}/oauth2`,
      GOOGLE_ADS_URL: `${base}/ads`,
      GA4_DATA_URL: `${base}/ga4data`,
      GA4_ADMIN_URL: `${base}/ga4admin`,
      GOOGLE_BUSINESS_ACCOUNTS_URL: `${base}/contas`,
      GOOGLE_BUSINESS_LOCATIONS_URL: `${base}/lojas`,
      GOOGLE_BUSINESS_REVIEWS_URL: `${base}/avaliacoes`,
      GOOGLE_BUSINESS_PERFORMANCE_URL: `${base}/numeros`,
      SEARCH_CONSOLE_URL: `${base}/sc`,
    };
    for (const k of Object.keys(ambiente)) anterior[k] = process.env[k];
    Object.assign(process.env, ambiente);
    api = await startApi();
    await resetIpRateLimits();
    database = createDatabase({ connectionString: APP_URL, max: 3, applicationName: 'liame-test' });
    processador = new ConexaoProcessor(database, loadConfig(), api.app.get(VaultService), api.app.get(FlagService));
  }, 120_000);
  beforeEach(() => {
    vistos.length = 0;
    concedidos = [...LEITURA];
    sites = 'ok';
    listaDeSites = SITES_PADRAO;
  });
  afterAll(async () => {
    await api?.close();
    await database?.close();
    await new Promise((ok) => google?.close(ok));
    for (const [k, v] of Object.entries(anterior)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  type Empresa = { cookie: string; tenantId: string; brandId: string };

  /** A empresa nasce no teste que a usa (V96), com as funções pedidas ligadas só para ela. */
  async function empresa(nome: string, funcoes: Array<'search_console' | 'perfil_google'>): Promise<Empresa> {
    const s = await signupAndLogin(api, undefined, nome);
    await enableMfa(api, s.cookie);
    const tenantId = s.me.active_organization_id as string;
    const [marca] = await ownerQuery<{ id: string }>(`select id from liame.brand where tenant_id = $1 limit 1`, [tenantId]);
    for (const f of funcoes) await ligarFlagDaEmpresa(api, f, tenantId, true);
    return { cookie: s.cookie, tenantId, brandId: marca!.id };
  }

  async function conectar(e: Empresa) {
    const inicio = await api.call('POST', '/v1/connections', { cookie: e.cookie, body: { provider: 'google', brand_id: e.brandId } });
    expect(inicio.status, JSON.stringify(inicio.body)).toBe(201);
    const url = new URL(inicio.body.authorize_url);
    desafios.add(url.searchParams.get('code_challenge')!);
    const volta = await fetch(`${api.base}/v1/oauth/callback?${new URLSearchParams({ state: url.searchParams.get('state')!, code: 'codigo-google-bom' }).toString()}`, {
      headers: { cookie: e.cookie },
      redirect: 'manual',
    });
    expect(volta.status).toBe(303);
    expect(await processador.processarLote(5, { tenantIds: [e.tenantId] })).toBe(1);
    return { id: inicio.body.id as string, pedido: url.searchParams.get('scope')! };
  }

  /** Procurar de novo as contas da autorização (o botão da tela), até o worker terminar. */
  async function procurarDeNovo(e: Empresa, id: string) {
    const r = await api.call('POST', `/v1/connections/${id}/discover`, { cookie: e.cookie });
    expect(r.status, JSON.stringify(r.body)).toBe(202);
    expect(await processador.processarLote(5, { tenantIds: [e.tenantId] })).toBe(1);
  }

  const conexao = async (id: string) =>
    (await ownerQuery<{ status: string; error_code: string | null; discovered: Descoberta[]; discovery_notes: Record<string, { resultado: string; em: string; sites?: number; lojas?: number }> }>(
      `select status, error_code, discovered, discovery_notes from liame.oauth_connection where id = $1`,
      [id],
    ))[0]!;
  const chaves = (d: Descoberta[]) => d.map((x) => `${x.provider}:${x.external_id}`);
  /** A lista da tela de Contas, conferida pelo contrato. */
  async function listar(e: Empresa): Promise<ConnectionListResponse> {
    const r = await api.call('GET', '/v1/connections', { cookie: e.cookie });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    return ConnectionListResponse.parse(r.body);
  }
  const doSearchConsole = () => vistos.filter((v) => v.caminho.startsWith('/sc/'));
  const auditoria = async (e: Empresa, id: string, acao: string) =>
    (await ownerQuery<{ after: Record<string, unknown> }>(`select after from liame.audit_event where tenant_id = $1 and resource_id = $2 and action = $3 order by occurred_at desc limit 1`, [e.tenantId, id, acao]))[0]?.after;

  it('o site como conta descoberta: o código, o nome e a permissão; o endereço comprido demais fica de fora', () => {
    expect(siteDescoberto({ site: DOMINIO, nome: 'misterburgers.exemplo.test', permissao: 'dono' })).toEqual({
      provider: 'search_console',
      external_id: DOMINIO,
      name: 'misterburgers.exemplo.test',
      currency: null,
      timezone: null,
      provider_attributes: { permissao: 'dono' },
    });
    expect(COMPRIDO.length).toBeGreaterThan(100);
    expect(siteDescoberto({ site: COMPRIDO, nome: 'x', permissao: 'completo' })).toBeNull();
  });

  it('com a função desligada, a autorização pede só a leitura, e o Liame não procura os sites nem que o Google diga que a permissão existe', async () => {
    const e = await empresa('Casa Brasa Sem Search Console', []);
    concedidos = [...LEITURA, ESCOPO_SEARCH_CONSOLE];
    const c = await conectar(e);
    expect(c.pedido).toBe(LEITURA.join(' '));
    expect(await auditoria(e, c.id, 'conexao.iniciar')).not.toHaveProperty('search_console');
    const pronta = await conexao(c.id);
    expect(pronta).toMatchObject({ status: 'aguardando_escolha', error_code: null, discovery_notes: {} });
    expect(chaves(pronta.discovered)).toEqual(DE_ANUNCIO);
    expect(doSearchConsole()).toEqual([]);
    expect(await auditoria(e, c.id, 'conexao.concluir')).toEqual({ provider: 'google', contas_encontradas: 4 });
    // A tela de Contas: a função desligada e nenhuma procura dos sites na autorização.
    const lista = await listar(e);
    expect(lista.search_console).toBe(false);
    expect(lista.items.find((i) => i.id === c.id)?.site_search).toBeNull();
  });

  it('com a função ligada: a autorização pede o Search Console, os sites aparecem entre as contas e o site escolhido vira conta ligada da marca', async () => {
    const e = await empresa('Mister Burgers Search Console', ['search_console']);
    concedidos = [...LEITURA, ESCOPO_SEARCH_CONSOLE];
    const c = await conectar(e);
    expect(c.pedido).toBe([...LEITURA, ESCOPO_SEARCH_CONSOLE].join(' '));
    expect(await auditoria(e, c.id, 'conexao.iniciar')).toMatchObject({ provider: 'google', search_console: true });

    const pronta = await conexao(c.id);
    expect(pronta).toMatchObject({ status: 'aguardando_escolha', error_code: null });
    // Os dois sites que a empresa pode ler; o sem verificação e o de endereço comprido demais ficam de fora.
    expect(chaves(pronta.discovered)).toEqual([...DE_ANUNCIO, `search_console:${DOMINIO}`, `search_console:${CARDAPIO}`]);
    expect(pronta.discovered.filter((d) => d.provider === 'search_console')).toEqual([
      { provider: 'search_console', external_id: DOMINIO, name: 'misterburgers.exemplo.test', currency: null, timezone: null, provider_attributes: { permissao: 'dono' } },
      { provider: 'search_console', external_id: CARDAPIO, name: 'cardapio.misterburgers.exemplo.test', currency: null, timezone: null, provider_attributes: { permissao: 'restrito' } },
    ]);
    expect(pronta.discovery_notes).toEqual({ search_console: { resultado: 'ok', em: expect.any(String), sites: 2 } });
    expect(Math.abs(Date.now() - new Date(pronta.discovery_notes.search_console!.em).getTime())).toBeLessThan(120_000);
    // Uma chamada só, com o acesso da autorização.
    expect(doSearchConsole()).toEqual([{ caminho: '/sc/webmasters/v3/sites', autorizacao: 'Bearer acesso-google-1' }]);
    expect(await auditoria(e, c.id, 'conexao.concluir')).toEqual({ provider: 'google', contas_encontradas: 6, search_console: 'ok' });

    // A tela de Contas recebe os sites entre as descobertas, e nenhum token.
    const lista = await api.call('GET', '/v1/connections', { cookie: e.cookie });
    expect(lista.status).toBe(200);
    expect(JSON.stringify(lista.body)).not.toContain('acesso-google');
    const item = lista.body.items.find((i: { id: string }) => i.id === c.id);
    expect(item.discovered.filter((d: Descoberta) => d.provider === 'search_console').map((d: Descoberta) => [d.external_id, d.name])).toEqual([
      [DOMINIO, 'misterburgers.exemplo.test'],
      [CARDAPIO, 'cardapio.misterburgers.exemplo.test'],
    ]);
    // E sabe que a função está ligada e como terminou a procura dos sites (P18, parte B).
    const comoATelaLe = ConnectionListResponse.parse(lista.body);
    expect(comoATelaLe.search_console).toBe(true);
    expect(comoATelaLe.items.find((i) => i.id === c.id)?.site_search).toEqual({ result: 'ok', searched_at: pronta.discovery_notes.search_console!.em, sites: 2 });
    // O acesso da conta do Google a cada site, para o diálogo de escolher; as contas de anúncio não trazem o campo.
    const descobertas = comoATelaLe.items.find((i) => i.id === c.id)!.discovered;
    expect(descobertas.filter((d) => d.provider === 'search_console').map((d) => [d.external_id, d.site_access])).toEqual([
      [DOMINIO, 'dono'],
      [CARDAPIO, 'restrito'],
    ]);
    expect(descobertas.filter((d) => d.provider !== 'search_console').every((d) => !('site_access' in d))).toBe(true);

    // Ligar o site à marca: uma conta como as outras, da autorização.
    const ligar = await api.call('POST', `/v1/connections/${c.id}/accounts`, { cookie: e.cookie, body: { accounts: [{ provider: 'search_console', external_id: DOMINIO }] } });
    expect(ligar.status, JSON.stringify(ligar.body)).toBe(200);
    expect(ligar.body.linked).toHaveLength(1);
    const [conta] = await ownerQuery<{ provider: string; external_id: string; name: string; brand_id: string; connection_id: string }>(
      `select provider, external_id, name, brand_id, connection_id from liame.connected_account where id = $1`,
      [ligar.body.linked[0].id],
    );
    expect(conta).toEqual({ provider: 'search_console', external_id: DOMINIO, name: 'misterburgers.exemplo.test', brand_id: e.brandId, connection_id: c.id });
    // O site que a autorização não achou não é ligado.
    const fora = await api.call('POST', `/v1/connections/${c.id}/accounts`, { cookie: e.cookie, body: { accounts: [{ provider: 'search_console', external_id: 'https://alheio.exemplo.test/' }] } });
    expect(fora.status).toBeGreaterThanOrEqual(400);
  });

  it('com a função ligada e a permissão desmarcada na tela do Google, o Liame não procura os sites', async () => {
    const e = await empresa('Casa Brasa Sem Permissão', ['search_console']);
    const c = await conectar(e);
    expect(c.pedido).toBe([...LEITURA, ESCOPO_SEARCH_CONSOLE].join(' '));
    const pronta = await conexao(c.id);
    expect(pronta).toMatchObject({ status: 'aguardando_escolha', discovery_notes: {} });
    expect(chaves(pronta.discovered)).toEqual(DE_ANUNCIO);
    expect(doSearchConsole()).toEqual([]);
  });

  it('o limite, a recusa e a queda do Search Console não derrubam a conexão, uma chamada só, e os sites já conhecidos ficam', async () => {
    const e = await empresa('Mister Burgers Sites Que Falham', ['search_console', 'perfil_google']);
    concedidos = [...LEITURA, ESCOPO_PERFIL_GOOGLE, ESCOPO_SEARCH_CONSOLE];
    const c = await conectar(e);
    // As duas permissões a mais, e as duas procuras anotadas lado a lado.
    expect(c.pedido).toBe([...LEITURA, ESCOPO_PERFIL_GOOGLE, ESCOPO_SEARCH_CONSOLE].join(' '));
    let pronta = await conexao(c.id);
    expect(chaves(pronta.discovered)).toEqual([...DE_ANUNCIO, `google_business:${LOJA}`, `search_console:${DOMINIO}`, `search_console:${CARDAPIO}`]);
    expect(pronta.discovery_notes).toMatchObject({ google_business: { resultado: 'ok', lojas: 1 }, search_console: { resultado: 'ok', sites: 2 } });

    for (const [resposta, resultado] of [
      ['sem-cota', 'limite'],
      ['cota-antiga', 'limite'],
      ['recusa', 'sem_permissao'],
      ['fora', 'falhou'],
    ] as const) {
      sites = resposta;
      vistos.length = 0;
      await procurarDeNovo(e, c.id);
      pronta = await conexao(c.id);
      expect([resposta, pronta.status, pronta.error_code]).toEqual([resposta, 'aguardando_escolha', null]);
      // A anotação diz o que houve; a do Perfil segue a dela; os sites já conhecidos ficam na lista.
      expect(pronta.discovery_notes).toMatchObject({ google_business: { resultado: 'ok', lojas: 1 }, search_console: { resultado, sites: 0 } });
      expect(chaves(pronta.discovered), resposta).toEqual([...DE_ANUNCIO, `google_business:${LOJA}`, `search_console:${DOMINIO}`, `search_console:${CARDAPIO}`]);
      expect(doSearchConsole(), resposta).toHaveLength(1);
      expect(await auditoria(e, c.id, 'conexao.concluir')).toMatchObject({ search_console: resultado });
      // A tela lê o mesmo resultado, com a procura do Perfil ao lado.
      const item = (await listar(e)).items.find((i) => i.id === c.id);
      expect([resposta, item?.site_search?.result, item?.site_search?.sites]).toEqual([resposta, resultado, 0]);
      expect(item?.profile_search?.result).toBe('ok');
    }

    // De volta, a lista do Google manda: o site que saiu do Search Console sai da lista.
    sites = 'ok';
    listaDeSites = [{ siteUrl: CARDAPIO, permissionLevel: 'SITE_FULL_USER' }];
    await procurarDeNovo(e, c.id);
    pronta = await conexao(c.id);
    expect(chaves(pronta.discovered)).toEqual([...DE_ANUNCIO, `google_business:${LOJA}`, `search_console:${CARDAPIO}`]);
    expect(pronta.discovered.find((d) => d.provider === 'search_console')!.provider_attributes).toEqual({ permissao: 'completo' });
    expect(pronta.discovery_notes).toMatchObject({ search_console: { resultado: 'ok', sites: 1 } });

    // A função desligada: a próxima procura não lê os sites, e a anotação sai.
    await ligarFlagDaEmpresa(api, 'search_console', e.tenantId, false);
    vistos.length = 0;
    await procurarDeNovo(e, c.id);
    pronta = await conexao(c.id);
    expect(pronta.discovery_notes).not.toHaveProperty('search_console');
    expect(chaves(pronta.discovered)).toEqual([...DE_ANUNCIO, `google_business:${LOJA}`]);
    expect(doSearchConsole()).toEqual([]);
    const depois = await listar(e);
    expect(depois.search_console).toBe(false);
    expect(depois.items.find((i) => i.id === c.id)?.site_search).toBeNull();
  });

  it('a procura guardada que não confere não chega à tela', () => {
    expect(procuraDosSites({})).toBeNull();
    expect(procuraDosSites(null)).toBeNull();
    expect(procuraDosSites({ search_console: { resultado: 'talvez', em: '2026-10-20T10:00:00Z', sites: 1 } })).toBeNull();
    expect(procuraDosSites({ search_console: { resultado: 'ok', em: 'ontem', sites: 1 } })).toBeNull();
    expect(procuraDosSites({ search_console: { resultado: 'ok', em: '2026-10-20T10:00:00Z', sites: -3 } })).toEqual({ result: 'ok', searched_at: '2026-10-20T10:00:00.000Z', sites: 0 });
    // A anotação do Perfil não vira a dos sites.
    expect(procuraDosSites({ google_business: { resultado: 'ok', em: '2026-10-20T10:00:00Z', lojas: 1 } })).toBeNull();
  });
});
