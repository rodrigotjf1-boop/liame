import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import { createDatabase, type Database } from '@liame/database';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';
import { procuraDoPerfil } from '../../src/connections/connections.service.js';
import { ESCOPOS_GOOGLE } from '../../src/connections/oauth.js';
import { ESCOPO_DATA_MANAGER } from '../../src/connectors/google-ads/data-manager.js';
import { ESCOPO_PERFIL_GOOGLE, procuraGuardada } from '../../src/connectors/google-business/perfil-google.js';
import { FlagService } from '../../src/flags/flag.service.js';
import { VaultService } from '../../src/vault/vault.service.js';
import { ConexaoProcessor } from '../../src/worker/conexao-processor.js';
import { enableMfa, ownerQuery, resetIpRateLimits, signupAndLogin, startApi, type TestApi } from '../helpers/api.js';
import { ligarFlagDaEmpresa } from '../helpers/meta-de-mentira.js';
import { APP_URL, hasDb } from './env.js';

// A6 · Z1 (parte b): a conexão do Perfil da Empresa no Google, de ponta a ponta, contra um Google local (o OAuth, o
// Google Ads, o GA4 e as APIs do Perfil numa origem só). O que se prova aqui:
//   - a permissão do Perfil só é pedida à empresa com a função ligada, e só então o Liame procura as lojas (D-A6-17);
//   - a loja do Perfil vira uma conta ligada da marca, como as outras, pela mesma autorização do Google;
//   - a cota do Perfil é do app do Liame: o limite (zero até o Google liberar o acesso), a recusa e a queda do Perfil
//     NÃO derrubam a conexão do Google Ads e do GA4, e o Liame não insiste (critério A6-2);
//   - quem já estava conectado ao Google ganha o Perfil autorizando de novo, sem perder as contas que tinha.

const FIX = resolve(import.meta.dirname, '../fixtures');
const API_PUBLICA = 'http://api.liame.test';
const VOLTA = `${API_PUBLICA}/v1/oauth/callback`;
const LEITURA = [...ESCOPOS_GOOGLE];
const CONTA = 'accounts/111000111';
const LOJA = 'locations/222000222';
const OUTRA_LOJA = 'locations/555000555';
/** As contas do Google Ads e do GA4 das respostas gravadas (as mesmas do teste de conexões). */
const DE_ANUNCIO = ['google_ads:4445556667', 'google_ads:5556667778', 'ga4:333444555', 'ga4:666777888'];

type Descoberta = { provider: string; external_id: string; name: string; currency: string | null; timezone: string | null; provider_attributes: Record<string, unknown> };

describe.skipIf(!hasDb)('conectar o Perfil da Empresa no Google (A6 · Z1)', () => {
  let api: TestApi;
  let database: Database;
  let processador: ConexaoProcessor;
  let google: Server;
  let base = '';
  const vistos: { caminho: string; autorizacao?: string }[] = [];
  const desafios = new Set<string>();
  const anterior: Record<string, string | undefined> = {};
  /** As permissões que o Google diz ter concedido na troca do código. */
  let concedidos: string[] = [];
  /** Como as APIs do Perfil respondem: bem, com a cota esgotada (ou zero), com a leitura recusada ou fora do ar. */
  let perfil: 'ok' | 'sem-cota' | 'recusa' | 'fora' = 'ok';
  let trocas = 0;

  const fixture = (arquivo: string) => JSON.parse(readFileSync(resolve(FIX, arquivo), 'utf8')) as unknown;

  function responder(req: IncomingMessage, texto: string): { status: number; corpo: unknown } {
    const url = new URL(req.url ?? '/', base);
    const corpo = req.headers['content-type']?.includes('x-www-form-urlencoded') ? new URLSearchParams(texto) : undefined;
    const p = url.pathname;
    vistos.push({ caminho: p, autorizacao: req.headers.authorization });
    // OAuth do Google: o código (com PKCE) e a renovação.
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
    // O Perfil da Empresa: as contas e as lojas.
    if (p.startsWith('/contas/') || p.startsWith('/lojas/')) {
      if (perfil === 'sem-cota') return { status: 429, corpo: { error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'Quota exceeded for quota metric Requests and limit Requests per minute' } } };
      if (perfil === 'recusa') return { status: 403, corpo: { error: { code: 403, status: 'PERMISSION_DENIED', message: 'The caller does not have permission' } } };
      if (perfil === 'fora') return { status: 503, corpo: { error: { code: 503, status: 'UNAVAILABLE', message: 'The service is currently unavailable' } } };
      if (p === '/contas/v1/accounts') return { status: 200, corpo: { accounts: [{ name: CONTA, accountName: 'Mister Burgers' }] } };
      if (p === `/lojas/v1/${CONTA}/locations`) {
        return {
          status: 200,
          corpo: {
            locations: [
              { name: LOJA, title: 'Mister Burgers — Centro', websiteUri: 'https://misterburgers.exemplo.test', metadata: { placeId: 'ChIJ-centro', mapsUri: 'https://maps.google.com/?cid=1' } },
              { name: OUTRA_LOJA, title: 'Mister Burgers — Praia' },
            ],
          },
        };
      }
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
    perfil = 'ok';
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

  /** A empresa nasce no teste que a usa (V96); `comPerfil`: com a função ligada para ela. */
  async function empresa(nome: string, comPerfil: boolean): Promise<Empresa> {
    const s = await signupAndLogin(api, undefined, nome);
    await enableMfa(api, s.cookie);
    const tenantId = s.me.active_organization_id as string;
    const [marca] = await ownerQuery<{ id: string }>(`select id from liame.brand where tenant_id = $1 limit 1`, [tenantId]);
    if (comPerfil) await ligarFlagDaEmpresa(api, 'perfil_google', tenantId, true);
    return { cookie: s.cookie, tenantId, brandId: marca!.id };
  }

  /** Começa a autorização e devolve o que o Liame pediu ao Google. */
  async function autorizar(e: Empresa) {
    const inicio = await api.call('POST', '/v1/connections', { cookie: e.cookie, body: { provider: 'google', brand_id: e.brandId } });
    expect(inicio.status, JSON.stringify(inicio.body)).toBe(201);
    const url = new URL(inicio.body.authorize_url);
    desafios.add(url.searchParams.get('code_challenge')!);
    return { id: inicio.body.id as string, pedido: url.searchParams.get('scope')!, estado: url.searchParams.get('state')! };
  }

  /** A autorização inteira: a pessoa volta do Google e o worker troca o código e procura as contas. */
  async function conectar(e: Empresa) {
    const a = await autorizar(e);
    const volta = await fetch(`${api.base}/v1/oauth/callback?${new URLSearchParams({ state: a.estado, code: 'codigo-google-bom' }).toString()}`, { headers: { cookie: e.cookie }, redirect: 'manual' });
    expect(volta.status).toBe(303);
    expect(await processador.processarLote(5, { tenantIds: [e.tenantId] })).toBe(1);
    return a;
  }

  /** Procurar de novo as contas da autorização (o botão da tela), até o worker terminar. */
  async function procurarDeNovo(e: Empresa, id: string) {
    const r = await api.call('POST', `/v1/connections/${id}/discover`, { cookie: e.cookie });
    expect(r.status, JSON.stringify(r.body)).toBe(202);
    expect(await processador.processarLote(5, { tenantIds: [e.tenantId] })).toBe(1);
  }

  const conexao = async (id: string) =>
    (await ownerQuery<{ status: string; error_code: string | null; credential_secret_id: string | null; discovered: Descoberta[]; discovery_notes: Record<string, unknown>; scopes: string[] }>(
      `select status, error_code, credential_secret_id, discovered, discovery_notes, scopes from liame.oauth_connection where id = $1`,
      [id],
    ))[0]!;
  const chaves = (d: Descoberta[]) => d.map((x) => `${x.provider}:${x.external_id}`);
  const doPerfil = () => vistos.filter((v) => v.caminho.startsWith('/contas/') || v.caminho.startsWith('/lojas/'));
  const auditoria = async (e: Empresa, id: string, acao: string) =>
    (await ownerQuery<{ after: Record<string, unknown> }>(`select after from liame.audit_event where tenant_id = $1 and resource_id = $2 and action = $3 order by occurred_at desc limit 1`, [e.tenantId, id, acao]))[0]?.after;

  it('com a função desligada, a autorização pede só a leitura, e o Liame não procura o Perfil nem que o Google diga que a permissão existe', async () => {
    const e = await empresa('Casa Brasa Sem Perfil', false);
    // A pessoa já tinha dado a permissão do Perfil a este app noutra ocasião: o Google a devolve junto.
    concedidos = [...LEITURA, ESCOPO_PERFIL_GOOGLE];
    const c = await conectar(e);
    expect(c.pedido).toBe(LEITURA.join(' '));
    expect(await auditoria(e, c.id, 'conexao.iniciar')).not.toHaveProperty('perfil_no_google');

    const pronta = await conexao(c.id);
    expect(pronta).toMatchObject({ status: 'aguardando_escolha', error_code: null, discovery_notes: {} });
    expect(chaves(pronta.discovered)).toEqual(DE_ANUNCIO);
    expect(doPerfil()).toEqual([]);
    expect(await auditoria(e, c.id, 'conexao.concluir')).toEqual({ provider: 'google', contas_encontradas: 4 });
    // P17, parte B: a tela de Contas sabe que a função está desligada, e que o Liame não procurou o Perfil.
    const lista = await api.call('GET', '/v1/connections', { cookie: e.cookie });
    expect(lista.body.business_profile).toBe(false);
    expect(lista.body.items.find((i: { id: string }) => i.id === c.id).profile_search).toBeNull();
  });

  it('com a função ligada: a autorização pede o Perfil, as lojas aparecem entre as contas e a loja escolhida vira conta ligada da marca', async () => {
    const e = await empresa('Mister Burgers Perfil', true);
    concedidos = [...LEITURA, ESCOPO_PERFIL_GOOGLE];
    const c = await conectar(e);
    expect(c.pedido).toBe([...LEITURA, ESCOPO_PERFIL_GOOGLE].join(' '));
    expect(await auditoria(e, c.id, 'conexao.iniciar')).toMatchObject({ provider: 'google', perfil_no_google: true });

    const pronta = await conexao(c.id);
    expect(pronta).toMatchObject({ status: 'aguardando_escolha', error_code: null });
    expect(pronta.scopes).toEqual([...LEITURA, ESCOPO_PERFIL_GOOGLE]);
    expect(chaves(pronta.discovered)).toEqual([...DE_ANUNCIO, `google_business:${LOJA}`, `google_business:${OUTRA_LOJA}`]);
    // A loja: o código dela, o nome e a conta do Perfil (as avaliações são lidas por conta e loja); sem moeda e sem fuso.
    expect(pronta.discovered.filter((d) => d.provider === 'google_business')).toEqual([
      { provider: 'google_business', external_id: LOJA, name: 'Mister Burgers — Centro', currency: null, timezone: null, provider_attributes: { conta: CONTA, site: 'https://misterburgers.exemplo.test', place_id: 'ChIJ-centro', maps_uri: 'https://maps.google.com/?cid=1' } },
      { provider: 'google_business', external_id: OUTRA_LOJA, name: 'Mister Burgers — Praia', currency: null, timezone: null, provider_attributes: { conta: CONTA, site: null, place_id: null, maps_uri: null } },
    ]);
    const nota = procuraGuardada(pronta.discovery_notes);
    expect(nota).toMatchObject({ resultado: 'ok', lojas: 2 });
    expect(Math.abs(Date.now() - new Date(nota!.em).getTime())).toBeLessThan(120_000);
    // O Perfil foi lido com o mesmo acesso da autorização, uma chamada por lista.
    expect(doPerfil()).toEqual([
      { caminho: '/contas/v1/accounts', autorizacao: 'Bearer acesso-google-1' },
      { caminho: `/lojas/v1/${CONTA}/locations`, autorizacao: 'Bearer acesso-google-1' },
    ]);
    expect(await auditoria(e, c.id, 'conexao.concluir')).toEqual({ provider: 'google', contas_encontradas: 6, perfil_no_google: 'ok' });

    // A tela de Contas recebe a loja entre as descobertas, e nenhum token.
    const lista = await api.call('GET', '/v1/connections', { cookie: e.cookie });
    expect(lista.status).toBe(200);
    expect(JSON.stringify(lista.body)).not.toContain('acesso-google');
    expect(JSON.stringify(lista.body)).not.toContain('refresh-google');
    const item = lista.body.items.find((i: { id: string }) => i.id === c.id);
    // P17, parte B: a loja leva o site do perfil (para distinguir lojas de mesmo nome); as contas de anúncio, não.
    expect(item.discovered.filter((d: Descoberta) => d.provider === 'google_business')).toEqual([
      { provider: 'google_business', external_id: LOJA, name: 'Mister Burgers — Centro', currency: null, timezone: null, linked: false, via: null, site: 'https://misterburgers.exemplo.test' },
      { provider: 'google_business', external_id: OUTRA_LOJA, name: 'Mister Burgers — Praia', currency: null, timezone: null, linked: false, via: null, site: null },
    ]);
    for (const d of item.discovered.filter((x: Descoberta) => x.provider !== 'google_business')) expect(d).not.toHaveProperty('site');
    // E a autorização diz como terminou a procura das lojas, com a função ligada para a empresa.
    expect(lista.body.business_profile).toBe(true);
    expect(item.profile_search).toEqual({ result: 'ok', searched_at: new Date(nota!.em).toISOString(), stores: 2 });

    // Ligar a loja à marca: uma conta como as outras, com a credencial da autorização.
    const ligar = await api.call('POST', `/v1/connections/${c.id}/accounts`, { cookie: e.cookie, body: { accounts: [{ provider: 'google_business', external_id: LOJA }] } });
    expect(ligar.status, JSON.stringify(ligar.body)).toBe(200);
    expect(ligar.body.already_linked).toEqual([]);
    expect(ligar.body.linked).toHaveLength(1);
    expect(ligar.body.linked[0]).toMatchObject({ brand_id: e.brandId, connection_id: c.id, provider: 'google_business', external_id: LOJA, name: 'Mister Burgers — Centro', currency: null, timezone: null, status: 'ativa', unit_id: null, scopes: [] });
    const [guardada] = await ownerQuery<{ credential_secret_id: string; provider_attributes: Record<string, unknown> }>(
      `select credential_secret_id, provider_attributes from liame.connected_account where id = $1`,
      [ligar.body.linked[0].id],
    );
    expect(guardada!.credential_secret_id).toBe(pronta.credential_secret_id);
    expect(guardada!.provider_attributes).toMatchObject({ conta: CONTA });
    expect((await conexao(c.id)).status).toBe('ativa');
    const detalhe = await api.call('GET', `/v1/connections/${c.id}`, { cookie: e.cookie });
    expect(detalhe.body.discovered.find((d: Descoberta) => d.external_id === LOJA).linked).toBe(true);
    expect(detalhe.body.discovered.find((d: Descoberta) => d.external_id === OUTRA_LOJA).linked).toBe(false);

    // A loja que a autorização não alcança não se liga; e desligar a loja é como desligar qualquer conta.
    const estranha = await api.call('POST', `/v1/connections/${c.id}/accounts`, { cookie: e.cookie, body: { accounts: [{ provider: 'google_business', external_id: 'locations/999000999' }] } });
    expect(estranha.status).toBe(422);
    expect((await api.call('DELETE', `/v1/connected-accounts/${ligar.body.linked[0].id}`, { cookie: e.cookie })).status).toBe(204);
    const [desligada] = await ownerQuery<{ status: string }>(`select status from liame.connected_account where id = $1`, [ligar.body.linked[0].id]);
    expect(desligada!.status).toBe('desconectada');
  });

  it('com a função ligada, quem não concedeu a permissão do Perfil conecta o Google Ads e o GA4, e o Liame não procura as lojas', async () => {
    const e = await empresa('Casa Brasa Desmarcou', true);
    // A pessoa desmarcou a caixa do Perfil na tela do Google: a troca devolve só a leitura.
    concedidos = [...LEITURA];
    const c = await conectar(e);
    expect(c.pedido).toBe([...LEITURA, ESCOPO_PERFIL_GOOGLE].join(' '));
    const pronta = await conexao(c.id);
    expect(pronta).toMatchObject({ status: 'aguardando_escolha', discovery_notes: {} });
    expect(chaves(pronta.discovered)).toEqual(DE_ANUNCIO);
    expect(doPerfil()).toEqual([]);
    // A tela de Contas: a função ligada, a autorização sem a permissão e sem procura (o convite de autorizar de novo).
    const lista = await api.call('GET', '/v1/connections', { cookie: e.cookie });
    expect(lista.body.business_profile).toBe(true);
    const item = lista.body.items.find((i: { id: string }) => i.id === c.id);
    expect([item.scopes.includes(ESCOPO_PERFIL_GOOGLE), item.profile_search]).toEqual([false, null]);
  });

  it('a função das conversões e a do Perfil ligadas juntas: a autorização pede as duas permissões', async () => {
    const e = await empresa('Casa Brasa As Duas', true);
    await ligarFlagDaEmpresa(api, 'conversoes_google', e.tenantId, true);
    expect((await autorizar(e)).pedido).toBe([...LEITURA, ESCOPO_DATA_MANAGER, ESCOPO_PERFIL_GOOGLE].join(' '));
  });

  it.each([
    { resposta: 'sem-cota', resultado: 'limite', porque: 'o Google ainda não liberou o acesso (ou a cota acabou)' },
    { resposta: 'recusa', resultado: 'sem_permissao', porque: 'o Google recusou a leitura do Perfil' },
    { resposta: 'fora', resultado: 'falhou', porque: 'o Perfil está fora do ar' },
  ] as const)('o Perfil que responde "$resposta" não derruba a conexão: o Google Ads e o GA4 conectam, e a anotação diz "$resultado" ($porque)', async ({ resposta, resultado }) => {
    const e = await empresa(`Casa Brasa Perfil ${resposta}`, true);
    concedidos = [...LEITURA, ESCOPO_PERFIL_GOOGLE];
    perfil = resposta;
    const c = await conectar(e);
    const pronta = await conexao(c.id);
    expect(pronta).toMatchObject({ status: 'aguardando_escolha', error_code: null });
    expect(chaves(pronta.discovered)).toEqual(DE_ANUNCIO);
    expect(procuraGuardada(pronta.discovery_notes)).toMatchObject({ resultado, lojas: 0 });
    // A tela de Contas lê o mesmo resultado (P17, parte B: "esperando o Google", "recusou", "não deu para procurar").
    const detalhe = await api.call('GET', `/v1/connections/${c.id}`, { cookie: e.cookie });
    expect(detalhe.body.profile_search).toMatchObject({ result: resultado, stores: 0 });
    // Uma chamada só ao Perfil: no limite e na falha, o Liame não insiste (critério A6-2).
    expect(doPerfil()).toHaveLength(1);
    expect(await auditoria(e, c.id, 'conexao.concluir')).toEqual({ provider: 'google', contas_encontradas: 4, perfil_no_google: resultado });

    // As contas de anúncio se ligam como sempre.
    const ligar = await api.call('POST', `/v1/connections/${c.id}/accounts`, { cookie: e.cookie, body: { accounts: [{ provider: 'google_ads', external_id: '4445556667' }] } });
    expect(ligar.status, JSON.stringify(ligar.body)).toBe(200);
    expect(ligar.body.linked.map((x: { provider: string }) => x.provider)).toEqual(['google_ads']);
  });

  it('procurar de novo: o limite não apaga as lojas que a conexão já conhecia; quando o Google volta, a lista é a dele; e a função desligada tira as lojas', async () => {
    const e = await empresa('Mister Burgers Procura', true);
    concedidos = [...LEITURA, ESCOPO_PERFIL_GOOGLE];
    const c = await conectar(e);
    const lojas = [`google_business:${LOJA}`, `google_business:${OUTRA_LOJA}`];
    expect(chaves((await conexao(c.id)).discovered)).toEqual([...DE_ANUNCIO, ...lojas]);
    const ligar = await api.call('POST', `/v1/connections/${c.id}/accounts`, { cookie: e.cookie, body: { accounts: [{ provider: 'google_business', external_id: LOJA }] } });
    expect(ligar.status, JSON.stringify(ligar.body)).toBe(200);

    // O Perfil sem cota na procura seguinte: as lojas seguem na lista, e a anotação diz o que aconteceu desta vez.
    perfil = 'sem-cota';
    await procurarDeNovo(e, c.id);
    const noLimite = await conexao(c.id);
    expect(noLimite.status).toBe('ativa');
    expect(chaves(noLimite.discovered)).toEqual([...DE_ANUNCIO, ...lojas]);
    expect(procuraGuardada(noLimite.discovery_notes)).toMatchObject({ resultado: 'limite', lojas: 0 });

    // O Google voltou: a lista de lojas é a que ele manda (sem repetir as que já estavam).
    perfil = 'ok';
    await procurarDeNovo(e, c.id);
    const deVolta = await conexao(c.id);
    expect(chaves(deVolta.discovered)).toEqual([...DE_ANUNCIO, ...lojas]);
    expect(procuraGuardada(deVolta.discovery_notes)).toMatchObject({ resultado: 'ok', lojas: 2 });

    // A função desligada para a empresa: a procura não chama o Perfil, e as lojas saem da lista de descobertas. A loja
    // já ligada continua ligada (quem para de ler é a rotina de leitura, que confere a mesma flag).
    await ligarFlagDaEmpresa(api, 'perfil_google', e.tenantId, false);
    vistos.length = 0;
    await procurarDeNovo(e, c.id);
    const semFuncao = await conexao(c.id);
    expect(chaves(semFuncao.discovered)).toEqual(DE_ANUNCIO);
    expect(semFuncao.discovery_notes).toEqual({});
    expect(doPerfil()).toEqual([]);
    const lista = await api.call('GET', '/v1/connections', { cookie: e.cookie });
    expect([lista.body.business_profile, lista.body.items.find((i: { id: string }) => i.id === c.id).profile_search]).toEqual([false, null]);
    const [conta] = await ownerQuery<{ status: string }>(`select status from liame.connected_account where id = $1`, [ligar.body.linked[0].id]);
    expect(conta!.status).toBe('ativa');
  });

  it('quem já estava conectado ao Google ganha o Perfil autorizando de novo: a loja entra pela autorização nova, e as contas de anúncio seguem na antiga', async () => {
    const e = await empresa('Mister Burgers Já Conectado', false);
    // Antes da função: o Google Ads e o GA4 ligados por uma autorização só de leitura.
    const antiga = await conectar(e);
    const anuncios = await api.call('POST', `/v1/connections/${antiga.id}/accounts`, {
      cookie: e.cookie,
      body: { accounts: [{ provider: 'google_ads', external_id: '4445556667' }, { provider: 'ga4', external_id: '333444555' }] },
    });
    expect(anuncios.status, JSON.stringify(anuncios.body)).toBe(200);
    const credencialAntiga = (await conexao(antiga.id)).credential_secret_id;
    expect((await conexao(antiga.id)).scopes).toEqual(LEITURA);

    // A função é ligada; a autorização antiga não alcança o Perfil (procurar de novo por ela não acha loja nenhuma).
    await ligarFlagDaEmpresa(api, 'perfil_google', e.tenantId, true);
    await procurarDeNovo(e, antiga.id);
    expect(chaves((await conexao(antiga.id)).discovered)).toEqual(DE_ANUNCIO);
    expect(doPerfil()).toEqual([]);

    // Autorizar o Google de novo: agora com a permissão do Perfil.
    concedidos = [...LEITURA, ESCOPO_PERFIL_GOOGLE];
    const nova = await conectar(e);
    expect(nova.pedido).toBe([...LEITURA, ESCOPO_PERFIL_GOOGLE].join(' '));
    const pronta = await conexao(nova.id);
    expect(chaves(pronta.discovered)).toContain(`google_business:${LOJA}`);
    // Na lista da tela, as contas de anúncio aparecem como já ligadas, e a loja não.
    const detalhe = await api.call('GET', `/v1/connections/${nova.id}`, { cookie: e.cookie });
    expect(detalhe.body.discovered.map((d: { provider: string; external_id: string; linked: boolean }) => [`${d.provider}:${d.external_id}`, d.linked])).toEqual([
      ['google_ads:4445556667', true],
      ['google_ads:5556667778', false],
      ['ga4:333444555', true],
      ['ga4:666777888', false],
      [`google_business:${LOJA}`, false],
      [`google_business:${OUTRA_LOJA}`, false],
    ]);

    // A pessoa liga só a loja: ela fica na autorização nova, e as contas de anúncio seguem na antiga, que continua valendo.
    const ligar = await api.call('POST', `/v1/connections/${nova.id}/accounts`, { cookie: e.cookie, body: { accounts: [{ provider: 'google_business', external_id: LOJA }] } });
    expect(ligar.status, JSON.stringify(ligar.body)).toBe(200);
    const contas = await ownerQuery<{ provider: string; connection_id: string; credential_secret_id: string; status: string }>(
      `select provider, connection_id, credential_secret_id, status from liame.connected_account where tenant_id = $1 and disconnected_at is null order by provider`,
      [e.tenantId],
    );
    expect(contas).toEqual([
      { provider: 'ga4', connection_id: antiga.id, credential_secret_id: credencialAntiga, status: 'ativa' },
      { provider: 'google_ads', connection_id: antiga.id, credential_secret_id: credencialAntiga, status: 'ativa' },
      { provider: 'google_business', connection_id: nova.id, credential_secret_id: pronta.credential_secret_id, status: 'ativa' },
    ]);
    expect((await conexao(antiga.id)).status).toBe('ativa');
    expect((await conexao(nova.id)).status).toBe('ativa');
  });

  it('a anotação da procura só aceita objeto (a restrição do banco), e o que foge do formato é lido como "não procurou"', async () => {
    const e = await empresa('Casa Brasa Anotação', false);
    const c = await conectar(e);
    await expect(ownerQuery(`update liame.oauth_connection set discovery_notes = '[]'::jsonb where id = $1`, [c.id])).rejects.toThrow(/oauth_connection_procura_objeto/);
    await ownerQuery(`update liame.oauth_connection set discovery_notes = '{"google_business": {"resultado": "ok", "em": "2026-10-11T12:00:00.000Z", "lojas": 3}}'::jsonb where id = $1`, [c.id]);
    expect(procuraGuardada((await conexao(c.id)).discovery_notes)).toEqual({ resultado: 'ok', em: '2026-10-11T12:00:00.000Z', lojas: 3 });

    expect(procuraGuardada(null)).toBeNull();
    expect(procuraGuardada({})).toBeNull();
    expect(procuraGuardada({ google_business: 'ok' })).toBeNull();
    expect(procuraGuardada({ google_business: { resultado: 'talvez', em: '2026-10-11T12:00:00.000Z' } })).toBeNull();
    expect(procuraGuardada({ google_business: { resultado: 'limite', em: 'ontem' } })).toBeNull();
    expect(procuraGuardada({ google_business: { resultado: 'limite', em: '2026-10-11T12:00:00.000Z', lojas: -1 } })).toEqual({ resultado: 'limite', em: '2026-10-11T12:00:00.000Z', lojas: 0 });
    // Como a tela lê (P17, parte B): o instante em ISO, e o que foge do formato é nulo.
    expect(procuraDoPerfil({ google_business: { resultado: 'ok', em: '2026-10-11T09:00:00-03:00', lojas: 2 } })).toEqual({ result: 'ok', searched_at: '2026-10-11T12:00:00.000Z', stores: 2 });
    expect(procuraDoPerfil({})).toBeNull();
    const detalhe = await api.call('GET', `/v1/connections/${c.id}`, { cookie: e.cookie });
    expect(detalhe.body.profile_search).toEqual({ result: 'ok', searched_at: '2026-10-11T12:00:00.000Z', stores: 3 });
  });
});
