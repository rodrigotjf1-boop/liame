import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import { createDatabase, type Database, runMigrations, withTenant } from '@liame/database';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ClienteConector } from '../../src/connectors/cliente-http.js';
import { enderecosDasPlataformas } from '../../src/connectors/enderecos.js';
import { ConectorGa4, criarConectorGa4, esperaPelaCota, METRICAS_CANONICAS_GA4, type OpcoesGa4 } from '../../src/connectors/ga4/conector-ga4.js';
import { gravarMetricas, type PontoMetrica } from '../../src/media/metric-store.js';
import { ownerQuery, resetIpRateLimits, signupAndLogin, startApi, type TestApi } from '../helpers/api.js';
import { APP_URL, hasDb, OWNER_URL } from './env.js';

// A2 · G6: contrato do conector do GA4 contra respostas gravadas da v1beta (Admin API e Data API),
// servidas por um GA4 local em duas origens, como na produção. Confere a descoberta das propriedades, o
// runReport (dimensões, métricas, paginação, cota pedida em toda chamada), a qualidade do dado e a
// parada antes de esgotar a cota.

const FIXTURES = resolve(import.meta.dirname, '../fixtures/ga4/v1beta');
const TOKEN = 'token-de-teste-ga4';
const PROPRIEDADE = '333444555';
const COTA_BAIXA = '666777888';

type Pedido = { origem: 'admin' | 'data'; metodo: string; caminho: string; busca: URLSearchParams; autorizacao: string | undefined; corpo: Record<string, unknown> | null };
type Relatorio = { rows: { dimensionValues: { value: string }[] }[]; rowCount: number; propertyQuota: Record<string, { consumed: number; remaining: number }> };

describe.skipIf(!hasDb)('conector do GA4 (leitura, v1beta)', () => {
  let database: Database;
  let admin: Server;
  let dados: Server;
  let baseAdmin = '';
  let baseDados = '';
  let api: TestApi;
  const pedidos: Pedido[] = [];

  const fixture = <T = unknown>(nome: string) => JSON.parse(readFileSync(resolve(FIXTURES, `${nome}.json`), 'utf8')) as T;
  const json = (status: number, corpo: unknown) => ({ status, corpo });

  function responderAdmin(req: IncomingMessage) {
    const url = new URL(req.url ?? '/', baseAdmin);
    pedidos.push({ origem: 'admin', metodo: req.method ?? 'GET', caminho: url.pathname, busca: url.searchParams, autorizacao: req.headers.authorization, corpo: null });
    if (url.pathname === '/v1beta/accountSummaries') return json(200, fixture(url.searchParams.get('pageToken') === 'pagina-2' ? 'account-summaries-2' : 'account-summaries-1'));
    const m = url.pathname.match(/^\/v1beta\/properties\/(\d+)$/);
    if (m?.[1] === '999000111') return json(403, { error: { code: 403, status: 'PERMISSION_DENIED', message: 'User does not have sufficient permissions for this property.' } });
    if (m) return json(200, fixture(`property-${m[1]}`));
    return json(404, { error: { code: 404, status: 'NOT_FOUND', message: 'not found' } });
  }

  function responderDados(req: IncomingMessage, texto: string) {
    const url = new URL(req.url ?? '/', baseDados);
    const corpo = texto ? (JSON.parse(texto) as Record<string, unknown>) : null;
    pedidos.push({ origem: 'data', metodo: req.method ?? 'GET', caminho: url.pathname, busca: url.searchParams, autorizacao: req.headers.authorization, corpo });
    const m = url.pathname.match(/^\/v1beta\/properties\/(\d+):runReport$/);
    if (!m || !corpo) return json(404, { error: { code: 404, status: 'NOT_FOUND', message: 'not found' } });
    const dims = (corpo.dimensions as { name: string }[]).map((d) => d.name);
    const rel = fixture<Relatorio>(dims.length > 1 ? 'report-origem' : 'report-totais');
    const { startDate, endDate } = (corpo.dateRanges as { startDate: string; endDate: string }[])[0]!;
    const iso = (v: string) => `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}`;
    const noPeriodo = rel.rows.filter((r) => iso(r.dimensionValues[0]!.value) >= startDate && iso(r.dimensionValues[0]!.value) <= endDate);
    const offset = Number(corpo.offset ?? 0);
    const limite = Number(corpo.limit ?? 10_000);
    if (m[1] === COTA_BAIXA) rel.propertyQuota.tokensPerHour = { consumed: 39_900, remaining: 100 };
    return json(200, { ...rel, rows: noPeriodo.slice(offset, offset + limite), rowCount: noPeriodo.length });
  }

  async function subir(tratar: (req: IncomingMessage, corpo: string) => { status: number; corpo: unknown }): Promise<[Server, string]> {
    const s = createServer((req, res) => {
      let corpo = '';
      req.on('data', (c: Buffer) => {
        corpo += c.toString('utf8');
      });
      req.on('end', () => {
        const r = tratar(req, corpo);
        res.writeHead(r.status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(r.corpo));
      });
    });
    await new Promise<void>((ok) => s.listen(0, '127.0.0.1', ok));
    return [s, `http://127.0.0.1:${(s.address() as AddressInfo).port}`];
  }

  beforeAll(async () => {
    await runMigrations({ connectionString: OWNER_URL, dir: resolve(process.cwd(), '../../packages/database/migrations') });
    database = createDatabase({ connectionString: APP_URL, max: 2, applicationName: 'liame-test' });
    [admin, baseAdmin] = await subir((req) => responderAdmin(req));
    [dados, baseDados] = await subir(responderDados);
    api = await startApi();
    await resetIpRateLimits();
  });
  afterAll(async () => {
    await new Promise((ok) => admin?.close(ok));
    await new Promise((ok) => dados?.close(ok));
    await database?.close();
    await api?.close();
  });

  const plataformas = () => ({ metaGraphUrl: 'https://graph.facebook.com', googleAdsUrl: 'https://googleads.googleapis.com', ga4DataUrl: baseDados, ga4AdminUrl: baseAdmin, dataManagerUrl: 'https://datamanager.googleapis.com', metaAppSecret: null });
  const cliente = () => new ClienteConector(database.db, { enderecos: enderecosDasPlataformas(plataformas()), tentativas: 1, esperaMaximaMs: 2_000, balde: { capacidade: 500, porSegundo: 50 } });
  const conector = (opcoes: OpcoesGa4 = {}) => new ConectorGa4(cliente(), { data: baseDados, admin: baseAdmin }, 'v1beta', 'v1beta', opcoes);
  const conta = (externalId = PROPRIEDADE) => ({ credencial: { accessToken: TOKEN }, externalId, timezone: 'America/Sao_Paulo', currency: 'BRL' });
  const doPonto = (pontos: PontoMetrica[], level: string, id: string, data: string, nome: string) =>
    pontos.find((p) => p.level === level && p.externalEntityId === id && p.metricDate === data && p.metricName === nome);

  it('versões do Capability Registry (Admin e Data)', async () => {
    const c = await criarConectorGa4(database.db, cliente(), plataformas());
    expect(c.apiVersion).toBe('v1beta');
  });

  it('descoberta: propriedades de todas as páginas, com fuso e moeda; a que recusa fica de fora', async () => {
    const antes = pedidos.length;
    const contas = await conector().descobrirContas({ accessToken: TOKEN });
    expect(contas).toEqual([
      {
        externalId: '333444555',
        name: 'Casa Brasa - site',
        currency: 'BRL',
        timezone: 'America/Sao_Paulo',
        providerAttributes: { account: 'accounts/111000111', account_name: 'Casa Brasa', property_type: 'PROPERTY_TYPE_ORDINARY' },
      },
      {
        externalId: '666777888',
        name: 'Delivery - app e site',
        currency: 'BRL',
        timezone: 'America/Sao_Paulo',
        providerAttributes: { account: 'accounts/222000222', account_name: 'Casa Brasa Delivery', property_type: 'PROPERTY_TYPE_ORDINARY' },
      },
    ]);
    const feitos = pedidos.slice(antes);
    expect(feitos.every((p) => p.origem === 'admin' && p.autorizacao === `Bearer ${TOKEN}`)).toBe(true);
    expect(feitos.filter((p) => p.caminho === '/v1beta/accountSummaries').map((p) => p.busca.get('pageToken'))).toEqual([null, 'pagina-2']);
  });

  it('GA4 não tem entidades próprias', async () => {
    expect(await conector().lerEntidades()).toEqual({ campaigns: [], adGroups: [], ads: [], creatives: [] });
  });

  it('métricas: total da propriedade por dia e recorte origem / mídia / campanha, com a cota pedida e a qualidade', async () => {
    const antes = pedidos.length;
    const pontos = await conector().lerMetricas(conta(), { inicio: '2026-09-14', fim: '2026-09-20' });
    const relatorios = pedidos.slice(antes);
    expect(relatorios.every((p) => p.origem === 'data' && p.metodo === 'POST' && p.caminho === `/v1beta/properties/${PROPRIEDADE}:runReport`)).toBe(true);
    expect(relatorios.every((p) => p.corpo!.returnPropertyQuota === true)).toBe(true);
    expect(relatorios.map((p) => (p.corpo!.dimensions as { name: string }[]).map((d) => d.name))).toEqual([
      ['date'],
      ['date', 'sessionSource', 'sessionMedium', 'sessionCampaignName'],
    ]);
    expect(relatorios[0]!.corpo!.dateRanges).toEqual([{ startDate: '2026-09-14', endDate: '2026-09-20' }]);

    expect(pontos).toHaveLength(2 * 7 + 3 * 7);
    expect(doPonto(pontos, 'account', PROPRIEDADE, '2026-09-19', 'sessions')).toMatchObject({ value: '310', quality: 'ok' });
    expect(doPonto(pontos, 'account', PROPRIEDADE, '2026-09-20', 'purchase_value')?.value).toBe('612.00');
    expect(doPonto(pontos, 'campaign', 'google / cpc / Pesquisa - delivery', '2026-09-19', 'key_events')).toMatchObject({ value: '14', quality: 'parcial' });
    expect(doPonto(pontos, 'campaign', 'facebook / paid / Delivery noite', '2026-09-19', 'purchases')?.value).toBe('3');
    expect(doPonto(pontos, 'campaign', '(direct) / (none) / (direct)', '2026-09-20', 'users')?.value).toBe('88');
    expect(pontos.every((p) => p.attributionWindow === undefined)).toBe(true);
    for (const n of new Set(pontos.map((p) => p.metricName))) expect(METRICAS_CANONICAS_GA4).toContain(n);
  });

  it('paginação por offset até o rowCount', async () => {
    const antes = pedidos.length;
    const pontos = await conector({ linhasPorPagina: 2 }).lerMetricas(conta(), { inicio: '2026-09-14', fim: '2026-09-20' });
    const offsets = pedidos.slice(antes).map((p) => [(p.corpo!.dimensions as unknown[]).length, p.corpo!.offset, p.corpo!.limit]);
    expect(offsets).toEqual([
      [1, 0, 2],
      [4, 0, 2],
      [4, 2, 2],
    ]);
    expect(pontos).toHaveLength(35);
  });

  it('cota da propriedade quase no fim: para antes do próximo relatório e devolve "limite" com a espera até a próxima hora', async () => {
    const agora = new Date('2026-09-26T14:40:00Z');
    const antes = pedidos.length;
    await expect(conector({ agora: () => agora }).lerMetricas(conta(COTA_BAIXA), { inicio: '2026-09-14', fim: '2026-09-20' })).rejects.toMatchObject({
      tipo: 'limite',
      esperarMs: 20 * 60_000,
    });
    expect(pedidos.length - antes).toBe(1);
  });

  it('regra da cota: cada cota de fichas conta; sem cota na resposta, segue', () => {
    const agora = new Date('2026-09-26T14:00:00Z');
    expect(esperaPelaCota(undefined, 0.05, agora)).toBeNull();
    expect(esperaPelaCota({ tokensPerHour: { consumed: 100, remaining: 39_900 } }, 0.05, agora)).toBeNull();
    expect(esperaPelaCota({ tokensPerDay: { consumed: 199_000, remaining: 1_000 } }, 0.05, agora)).toEqual({ esperarMs: 6 * 3_600_000, qual: 'tokensPerDay' });
    expect(esperaPelaCota({ tokensPerProjectPerHour: { consumed: 13_900, remaining: 100 } }, 0.05, agora)).toEqual({ esperarMs: 3_600_000, qual: 'tokensPerProjectPerHour' });
  });

  it('propriedade ou data fora do formato nem vira chamada', async () => {
    const antes = pedidos.length;
    await expect(conector().lerMetricas(conta('properties/1'), { inicio: '2026-09-14', fim: '2026-09-20' })).rejects.toMatchObject({ tipo: 'definitivo' });
    await expect(conector().lerMetricas(conta(), { inicio: 'ontem', fim: '2026-09-20' })).rejects.toMatchObject({ tipo: 'definitivo' });
    expect(pedidos.length).toBe(antes);
  });

  it('os pontos lidos gravam no modelo temporal (nomes, qualidade e chaves aceitos pelo banco)', async () => {
    const s = await signupAndLogin(api, undefined, 'Casa Brasa GA4');
    const tenantId = s.me.active_organization_id as string;
    const [marca] = await ownerQuery<{ id: string }>(`select id from liame.brand where tenant_id = $1 limit 1`, [tenantId]);
    const contaId = randomUUID();
    await ownerQuery(
      `insert into liame.connected_account (id, tenant_id, brand_id, provider, external_id, name, currency, timezone)
       values ($1, $2, $3, 'ga4', $4, 'Casa Brasa - site', 'BRL', 'America/Sao_Paulo')`,
      [contaId, tenantId, marca!.id, String(Date.now())],
    );
    const pontos = await conector().lerMetricas(conta(), { inicio: '2026-09-14', fim: '2026-09-20' });
    const ctx = {
      tenantId,
      brandId: marca!.id,
      connectedAccountId: contaId,
      provider: 'ga4',
      syncRunId: null,
      sourceVersion: 'v1beta',
      currency: 'BRL',
      timezone: 'America/Sao_Paulo',
      observedAt: new Date('2026-09-21T10:00:00Z'),
    };
    expect(await withTenant(database.db, tenantId, (tx) => gravarMetricas(tx, ctx, pontos))).toEqual({ novas: 35, lidas: 35 });
    const [parcial] = await ownerQuery<{ n: string }>(`select count(*) as n from liame.metric_latest where connected_account_id = $1 and quality = 'parcial'`, [contaId]);
    expect(Number(parcial!.n)).toBe(21);
  });
});
