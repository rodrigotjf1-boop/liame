import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import { createDatabase, type Database, runMigrations, withTenant } from '@liame/database';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ClienteConector } from '../../src/connectors/cliente-http.js';
import { enderecosDasPlataformas } from '../../src/connectors/enderecos.js';
import { ConectorGoogleAds, criarConectorGoogleAds, METRICAS_CANONICAS_GOOGLE_ADS, microsParaUnidade } from '../../src/connectors/google-ads/conector-google-ads.js';
import { gravarMetricas, type PontoMetrica } from '../../src/media/metric-store.js';
import { ownerQuery, resetIpRateLimits, signupAndLogin, startApi, type TestApi } from '../helpers/api.js';
import { APP_URL, hasDb, OWNER_URL } from './env.js';

// A2 · G5: contrato do conector do Google Ads contra respostas gravadas da v25 (REST, searchStream),
// servidas por uma "Google Ads API" local. Confere cabeçalhos (token, login-customer-id, sem developer
// token), a GAQL enviada e a tradução para o modelo canônico (status, micros, métricas por nível).

const FIXTURES = resolve(import.meta.dirname, '../fixtures/google-ads/v25');
const TOKEN = 'token-de-teste-google';
const TOKEN_CONTA_FECHADA = 'token-com-conta-fechada';
const CLIENTE = '4445556667';
const GERENTE = '1112223334';

type Pedido = { metodo: string; caminho: string; cabecalhos: IncomingMessage['headers']; query: string | null };

describe.skipIf(!hasDb)('conector do Google Ads (leitura, v25)', () => {
  let database: Database;
  let servidor: Server;
  let base = '';
  let api: TestApi;
  const pedidos: Pedido[] = [];

  const fixture = <T = unknown>(nome: string) => JSON.parse(readFileSync(resolve(FIXTURES, `${nome}.json`), 'utf8')) as T;
  type Lote = { results: { segments?: { date: string } }[] };
  const porData = (nome: string, query: string) => {
    const [, desde, ate] = query.match(/BETWEEN '(\d{4}-\d{2}-\d{2})' AND '(\d{4}-\d{2}-\d{2})'/) ?? [];
    return fixture<Lote[]>(nome).map((l) => ({ ...l, results: l.results.filter((r) => r.segments!.date >= desde! && r.segments!.date <= ate!) }));
  };

  function responder(req: IncomingMessage, corpo: string): { status: number; corpo: unknown } {
    const url = new URL(req.url ?? '/', base);
    const query = corpo ? (JSON.parse(corpo) as { query: string }).query : null;
    pedidos.push({ metodo: req.method ?? 'GET', caminho: url.pathname, cabecalhos: req.headers, query });
    if (url.pathname === '/v25/customers:listAccessibleCustomers') {
      const lista = fixture<{ resourceNames: string[] }>('list-accessible-customers');
      if (req.headers.authorization === `Bearer ${TOKEN_CONTA_FECHADA}`) lista.resourceNames.push('customers/9990000009');
      return { status: 200, corpo: lista };
    }
    const m = url.pathname.match(/^\/v25\/customers\/(\d+)\/googleAds:searchStream$/);
    if (!m || req.method !== 'POST' || !query) return { status: 404, corpo: { error: { code: 404, status: 'NOT_FOUND', message: 'not found' } } };
    const cliente = m[1]!;
    if (cliente === '9990000009') return { status: 403, corpo: { error: { code: 403, status: 'PERMISSION_DENIED', message: "The caller does not have permission" } } };
    // Conta em que o Google recusa os campos de URL (campo desconhecido na versão): o conector lê sem eles.
    if (cliente === '7778889990' && /final_url|tracking_url_template/.test(query)) {
      return { status: 400, corpo: { error: { code: 400, status: 'INVALID_ARGUMENT', message: 'Unrecognized field in the query' } } };
    }
    if (/FROM customer_client/.test(query)) return { status: 200, corpo: fixture(`customer-clients-${cliente}`) };
    const comData = /segments\.date BETWEEN/.test(query);
    if (/FROM campaign\b/.test(query)) return { status: 200, corpo: comData ? porData('metrics-campaign', query) : fixture('campaigns') };
    if (/FROM ad_group_ad\b/.test(query)) return { status: 200, corpo: comData ? porData('metrics-ad', query) : fixture('ads') };
    if (/FROM ad_group\b/.test(query)) return { status: 200, corpo: fixture('ad-groups') };
    return { status: 400, corpo: { error: { code: 400, status: 'INVALID_ARGUMENT', message: 'query' } } };
  }

  beforeAll(async () => {
    await runMigrations({ connectionString: OWNER_URL, dir: resolve(process.cwd(), '../../packages/database/migrations') });
    database = createDatabase({ connectionString: APP_URL, max: 2, applicationName: 'liame-test' });
    servidor = createServer((req, res) => {
      let corpo = '';
      req.on('data', (c: Buffer) => {
        corpo += c.toString('utf8');
      });
      req.on('end', () => {
        const r = responder(req, corpo);
        res.writeHead(r.status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(r.corpo));
      });
    });
    await new Promise<void>((ok) => servidor.listen(0, '127.0.0.1', ok));
    base = `http://127.0.0.1:${(servidor.address() as AddressInfo).port}`;
    api = await startApi();
    await resetIpRateLimits();
  });
  afterAll(async () => {
    await new Promise((ok) => servidor?.close(ok));
    await database?.close();
    await api?.close();
  });

  const plataformas = () => ({ metaGraphUrl: 'https://graph.facebook.com', googleAdsUrl: base, ga4DataUrl: 'https://analyticsdata.googleapis.com', ga4AdminUrl: 'https://analyticsadmin.googleapis.com', dataManagerUrl: 'https://datamanager.googleapis.com', metaAppSecret: null });
  const cliente = () => new ClienteConector(database.db, { enderecos: enderecosDasPlataformas(plataformas()), tentativas: 1, esperaMaximaMs: 2_000, balde: { capacidade: 500, porSegundo: 50 } });
  const conector = () => new ConectorGoogleAds(cliente(), base, 'v25');
  const conta = (externalId = CLIENTE, loginCustomerId: string | null = GERENTE) => ({ credencial: { accessToken: TOKEN }, externalId, timezone: 'America/Sao_Paulo', currency: 'BRL', loginCustomerId });
  const doPonto = (pontos: PontoMetrica[], level: string, id: string, data: string, nome: string) =>
    pontos.find((p) => p.level === level && p.externalEntityId === id && p.metricDate === data && p.metricName === nome)?.value;

  it('versão do Capability Registry', async () => {
    expect((await criarConectorGoogleAds(database.db, cliente(), plataformas())).apiVersion).toBe('v25');
  });

  it('descoberta: diretas e clientes das gerentes (com o nome da gerente), sem gerentes; acesso direto vence; sem developer token', async () => {
    const antes = pedidos.length;
    const contas = await conector().descobrirContas({ accessToken: TOKEN });
    expect(contas).toEqual([
      { externalId: '4445556667', name: 'Casa Brasa Google', currency: 'BRL', timezone: 'America/Sao_Paulo', providerAttributes: { login_customer_id: GERENTE, status: 'ENABLED', via: 'Agência Parceira' } },
      { externalId: '5556667778', name: 'Casa Brasa Loja 2', currency: 'BRL', timezone: 'America/Sao_Paulo', providerAttributes: { login_customer_id: '5556667778', status: 'ENABLED', via: null } },
    ]);
    const feitos = pedidos.slice(antes);
    expect(feitos.every((p) => p.cabecalhos.authorization === `Bearer ${TOKEN}`)).toBe(true);
    expect(feitos.some((p) => 'developer-token' in p.cabecalhos)).toBe(false);
    expect(feitos.filter((p) => p.query).map((p) => [p.caminho, p.cabecalhos['login-customer-id']])).toEqual([
      [`/v25/customers/${GERENTE}/googleAds:searchStream`, GERENTE],
      ['/v25/customers/5556667778/googleAds:searchStream', '5556667778'],
    ]);
  });

  it('conta que recusa a consulta fica de fora sem derrubar as outras', async () => {
    const contas = await conector().descobrirContas({ accessToken: TOKEN_CONTA_FECHADA });
    expect(contas.map((c) => c.externalId)).toEqual(['4445556667', '5556667778']);
  });

  it('entidades: status canônico, status principal guardado, orçamento em micros e anúncio como criativo', async () => {
    const antes = pedidos.length;
    const e = await conector().lerEntidades(conta());
    expect(pedidos.slice(antes).every((p) => p.cabecalhos['login-customer-id'] === GERENTE)).toBe(true);
    expect(e.campaigns.map((c) => [c.externalId, c.status, c.providerStatus, c.objective, c.dailyBudgetMicros, c.lifetimeBudgetMicros])).toEqual([
      ['21000000001', 'ativa', 'ELIGIBLE', 'SEARCH', 50_000_000, null],
      ['21000000002', 'pausada', 'PAUSED', 'PERFORMANCE_MAX', 80_000_000, null],
      ['21000000003', 'removida', 'REMOVED', 'SEARCH', null, 1_500_000_000],
    ]);
    expect(e.adGroups.map((g) => [g.externalId, g.status, g.parentExternalId])).toEqual([
      ['41000000001', 'ativa', '21000000001'],
      ['41000000002', 'pausada', '21000000001'],
    ]);
    expect(e.ads.map((a) => [a.externalId, a.name, a.status, a.parentExternalId, a.creativeExternalId])).toEqual([
      ['51000000001', 'Anúncio 51000000001', 'ativa', '41000000001', '51000000001'],
      ['51000000002', 'Marca - institucional', 'pausada', '41000000002', '51000000002'],
    ]);
    expect(e.creatives.map((c) => [c.externalId, c.kind])).toEqual([
      ['51000000001', 'RESPONSIVE_SEARCH_AD'],
      ['51000000002', 'RESPONSIVE_SEARCH_AD'],
    ]);
  });

  it('F5: URLs finais, sufixo do URL final e modelo de cada anúncio, pelo nível mais específico (conferência do rastreio)', async () => {
    const antes = pedidos.length;
    const e = await conector().lerEntidades(conta());
    const consultas = pedidos.slice(antes).map((p) => p.query ?? '');
    expect(consultas.find((q) => /FROM campaign$/.test(q))).toContain('customer.final_url_suffix, customer.tracking_url_template FROM campaign');
    expect(consultas.find((q) => /FROM ad_group$/.test(q))).toContain('ad_group.final_url_suffix, ad_group.tracking_url_template FROM ad_group');
    expect(consultas.find((q) => /FROM ad_group_ad$/.test(q))).toContain('ad_group_ad.ad.final_urls, ad_group_ad.ad.final_url_suffix, ad_group_ad.ad.tracking_url_template FROM ad_group_ad');
    const CARDAPIO = 'https://cardapio.exemplo.com.br/casabrasa';
    expect(e.ads.map((a) => a.providerAttributes)).toEqual([
      {
        rastreio: {
          url_tags: null,
          destinos: [{ url: CARDAPIO, url_tags: null }],
          // Sem sufixo no anúncio, no grupo nem na campanha: vale o da conta.
          sufixo: 'utm_source=google&utm_medium=cpc&campaign_id={campaignid}&adgroup_id={adgroupid}&ad_id={creative}&lk=BH4K8XJ2QM',
          sufixo_nivel: 'conta',
          modelo: null,
          modelo_nivel: null,
        },
      },
      {
        rastreio: {
          url_tags: null,
          destinos: [{ url: CARDAPIO, url_tags: null }],
          // O do anúncio vence o da conta; o modelo vem do grupo.
          sufixo: 'utm_source=google',
          sufixo_nivel: 'anuncio',
          modelo: '{lpurl}?lk=BH4K8XJ2QM',
          modelo_nivel: 'grupo',
        },
      },
    ]);
  });

  it('F5: se o Google recusa os campos de URL, lê sem eles e segue (os anúncios ficam por conferir)', async () => {
    const antes = pedidos.length;
    const e = await conector().lerEntidades(conta('7778889990', null));
    expect(e.campaigns).toHaveLength(3);
    expect(e.ads.map((a) => a.providerAttributes)).toEqual([undefined, undefined]);
    const consultas = pedidos.slice(antes).map((p) => p.query ?? '');
    expect(consultas.filter((q) => /final_url|tracking_url_template/.test(q))).toHaveLength(3);
    expect(consultas.filter((q) => !/final_url|tracking_url_template/.test(q))).toHaveLength(3);
  });

  it('micros para unidade sem ponto flutuante', () => {
    expect(microsParaUnidade('48370000')).toBe('48.37');
    expect(microsParaUnidade('0')).toBe('0');
    expect(microsParaUnidade('1')).toBe('0.000001');
    expect(microsParaUnidade('-2500000')).toBe('-2.5');
    expect(microsParaUnidade('1234567890123')).toBe('1234567.890123');
    expect(microsParaUnidade(12345678)).toBe('12.345678');
  });

  it('métricas por anúncio e por campanha (a Performance Max só existe na campanha); zero omitido vira zero', async () => {
    const antes = pedidos.length;
    const pontos = await conector().lerMetricas(conta(), { inicio: '2026-09-14', fim: '2026-09-20' });
    const consultas = pedidos.slice(antes).map((p) => p.query!);
    expect(consultas).toHaveLength(2);
    expect(consultas.every((q) => q.includes("segments.date BETWEEN '2026-09-14' AND '2026-09-20'") && q.includes('metrics.cost_micros'))).toBe(true);

    expect(pontos).toHaveLength(32);
    expect(doPonto(pontos, 'ad', '51000000001', '2026-09-19', 'spend')).toBe('48.37');
    expect(doPonto(pontos, 'ad', '51000000001', '2026-09-19', 'conversions')).toBe('5');
    expect(doPonto(pontos, 'ad', '51000000001', '2026-09-19', 'conversions_value')).toBe('412.5');
    expect(doPonto(pontos, 'ad', '51000000001', '2026-09-20', 'conversions')).toBe('0');
    expect(doPonto(pontos, 'ad', '51000000001', '2026-09-20', 'google:all_conversions')).toBe('0.5');
    expect(doPonto(pontos, 'campaign', '21000000002', '2026-09-19', 'spend')).toBe('12.345678');
    expect(doPonto(pontos, 'campaign', '21000000002', '2026-09-19', 'google:all_conversions')).toBe('0');
    expect(pontos.find((p) => p.metricName === 'conversions')?.attributionWindow).toBe('padrao');
    expect(pontos.find((p) => p.metricName === 'spend')?.attributionWindow).toBeUndefined();
    for (const n of new Set(pontos.map((p) => p.metricName).filter((n) => !n.startsWith('google:')))) expect(METRICAS_CANONICAS_GOOGLE_ADS).toContain(n);
  });

  it('carga inicial em fatias de 30 dias', async () => {
    const antes = pedidos.length;
    await conector().lerMetricas(conta(), { inicio: '2026-08-07', fim: '2026-09-20' });
    const faixas = pedidos
      .slice(antes)
      .map((p) => p.query!.match(/BETWEEN '([\d-]+)' AND '([\d-]+)'/)!.slice(1).join('..'))
      .sort();
    expect(faixas).toEqual(['2026-08-07..2026-09-05', '2026-08-07..2026-09-05', '2026-09-06..2026-09-20', '2026-09-06..2026-09-20']);
  });

  it('id de cliente, gerente ou data fora do formato nem vira chamada', async () => {
    const antes = pedidos.length;
    await expect(conector().lerEntidades(conta('123/../456'))).rejects.toMatchObject({ tipo: 'definitivo' });
    await expect(conector().lerEntidades(conta(CLIENTE, '111\r\nx-injetado: 1'))).rejects.toMatchObject({ tipo: 'definitivo' });
    await expect(conector().lerMetricas(conta(), { inicio: "2026-09-01' OR '1'='1", fim: '2026-09-20' })).rejects.toMatchObject({ tipo: 'definitivo' });
    await expect(conector().lerMetricas(conta(), { inicio: '2026-02-30', fim: '2026-03-02' })).rejects.toMatchObject({ tipo: 'definitivo' });
    expect(pedidos.length).toBe(antes);
  });

  it('os pontos lidos gravam no modelo temporal (nomes e janelas aceitos pelo banco)', async () => {
    const s = await signupAndLogin(api, undefined, 'Casa Brasa Google');
    const tenantId = s.me.active_organization_id as string;
    const [marca] = await ownerQuery<{ id: string }>(`select id from liame.brand where tenant_id = $1 limit 1`, [tenantId]);
    const contaId = randomUUID();
    await ownerQuery(
      `insert into liame.connected_account (id, tenant_id, brand_id, provider, external_id, name, currency, timezone)
       values ($1, $2, $3, 'google_ads', $4, 'Casa Brasa Google', 'BRL', 'America/Sao_Paulo')`,
      [contaId, tenantId, marca!.id, String(Date.now())],
    );
    const pontos = await conector().lerMetricas(conta(), { inicio: '2026-09-14', fim: '2026-09-20' });
    const ctx = {
      tenantId,
      brandId: marca!.id,
      connectedAccountId: contaId,
      provider: 'google_ads',
      syncRunId: null,
      sourceVersion: 'v25',
      currency: 'BRL',
      timezone: 'America/Sao_Paulo',
      observedAt: new Date('2026-09-21T10:00:00Z'),
    };
    expect(await withTenant(database.db, tenantId, (tx) => gravarMetricas(tx, ctx, pontos))).toEqual({ novas: 32, lidas: 32 });
  });
});
