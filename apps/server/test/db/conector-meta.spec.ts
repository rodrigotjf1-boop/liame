import { createHmac, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import { createDatabase, type Database, runMigrations, withTenant } from '@liame/database';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ClienteConector } from '../../src/connectors/cliente-http.js';
import { enderecosDasPlataformas } from '../../src/connectors/enderecos.js';
import { fatias } from '../../src/connectors/janela.js';
import { ConectorMeta, criarConectorMeta, METRICAS_CANONICAS_META, orcamentoEmMicros } from '../../src/connectors/meta/conector-meta.js';
import { gravarMetricas, type PontoMetrica } from '../../src/media/metric-store.js';
import { ownerQuery, resetIpRateLimits, signupAndLogin, startApi, type TestApi } from '../helpers/api.js';
import { APP_URL, hasDb, OWNER_URL } from './env.js';

// A2 · G4: contrato do conector da Meta contra respostas gravadas da v26.0 (fixtures), servidas por
// uma "Graph API" local. Confere o que sai (endereço, token no cabeçalho, appsecret_proof) e o que
// entra no modelo canônico (status, orçamento em micros, métricas por janela de atribuição).

const FIXTURES = resolve(import.meta.dirname, '../fixtures/meta/v26.0');
const TOKEN = 'token-de-teste-meta';
const SEGREDO = 'segredo-do-app-de-teste';
const CONTA = 'act_1234567890';

type Pedido = { metodo: string; caminho: string; query: URLSearchParams; autorizacao: string | undefined; urlCompleta: string };

describe.skipIf(!hasDb)('conector da Meta (leitura, v26.0)', () => {
  let database: Database;
  let servidor: Server;
  let base = '';
  let api: TestApi;
  const pedidos: Pedido[] = [];
  const relatorios = new Map<string, { timeRange: { since: string; until: string }; consultas: number; falha: boolean }>();
  let proximoRelatorio = 900_000_001;

  const fixture = (nome: string) => JSON.parse(readFileSync(resolve(FIXTURES, `${nome}.json`), 'utf8').replaceAll('{{BASE}}', base)) as {
    data: Record<string, unknown>[];
    paging?: unknown;
  };
  const insightsDe = (faixa: { since: string; until: string }) => {
    const f = fixture('insights');
    return { ...f, data: f.data.filter((l) => (l.date_start as string) >= faixa.since && (l.date_start as string) <= faixa.until) };
  };

  function responder(req: IncomingMessage) {
    const url = new URL(req.url ?? '/', base);
    const p: Pedido = { metodo: req.method ?? 'GET', caminho: url.pathname, query: url.searchParams, autorizacao: req.headers.authorization, urlCompleta: url.toString() };
    pedidos.push(p);
    const m = url.pathname.match(/^\/v26\.0\/(.+)$/);
    if (!m) return { status: 404, corpo: { error: { code: 100, message: 'Unknown path' } } };
    const [no, aresta] = m[1]!.split('/') as [string, string | undefined];

    if (no === 'me' && aresta === 'adaccounts') return { status: 200, corpo: fixture('adaccounts') };
    if (no === 'act_9990000001' && aresta === 'campaigns') {
      return { status: 200, corpo: { data: [], paging: { next: 'https://graph.facebook.com.outro.site/v26.0/act_9990000001/campaigns?after=x' } } };
    }
    if (no.startsWith('act_') && aresta) {
      if (aresta === 'campaigns') return { status: 200, corpo: fixture(url.searchParams.get('after') === 'b' ? 'campaigns-2' : 'campaigns-1') };
      if (aresta === 'insights' && p.metodo === 'POST') {
        const id = String(proximoRelatorio++);
        relatorios.set(id, { timeRange: JSON.parse(url.searchParams.get('time_range')!), consultas: 0, falha: no === 'act_9990000002' });
        return { status: 200, corpo: { report_run_id: id } };
      }
      if (aresta === 'insights') return { status: 200, corpo: insightsDe(JSON.parse(url.searchParams.get('time_range')!)) };
      if (['adsets', 'ads', 'adcreatives'].includes(aresta)) return { status: 200, corpo: fixture(aresta) };
    }
    const relatorio = relatorios.get(no);
    if (relatorio && !aresta) {
      relatorio.consultas++;
      if (relatorio.falha) return { status: 200, corpo: { id: no, async_status: 'Job Failed', async_percent_completion: 0 } };
      return relatorio.consultas < 2
        ? { status: 200, corpo: { id: no, async_status: 'Job Running', async_percent_completion: 40 } }
        : { status: 200, corpo: { id: no, async_status: 'Job Completed', async_percent_completion: 100 } };
    }
    if (relatorio && aresta === 'insights') return { status: 200, corpo: insightsDe(relatorio.timeRange) };
    return { status: 404, corpo: { error: { code: 100, message: 'Unknown path' } } };
  }

  beforeAll(async () => {
    await runMigrations({ connectionString: OWNER_URL, dir: resolve(process.cwd(), '../../packages/database/migrations') });
    database = createDatabase({ connectionString: APP_URL, max: 2, applicationName: 'liame-test' });
    servidor = createServer((req, res) => {
      const r = responder(req);
      res.writeHead(r.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(r.corpo));
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

  const plataformas = () => ({ metaGraphUrl: base, googleAdsUrl: 'https://googleads.googleapis.com', ga4DataUrl: 'https://analyticsdata.googleapis.com', ga4AdminUrl: 'https://analyticsadmin.googleapis.com', metaAppSecret: SEGREDO });
  const cliente = () => new ClienteConector(database.db, { enderecos: enderecosDasPlataformas(plataformas()), tentativas: 2, esperaMaximaMs: 2_000, balde: { capacidade: 500, porSegundo: 50 } });
  const conector = (opcoes = {}) => new ConectorMeta(cliente(), base, 'v26.0', SEGREDO, { intervaloRelatorioMs: 10, ...opcoes });
  const conta = (externalId = CONTA) => ({ credencial: { accessToken: TOKEN }, externalId, timezone: 'America/Sao_Paulo', currency: 'BRL' });
  const doPonto = (pontos: PontoMetrica[], data: string, nome: string, janela?: string) =>
    pontos.find((p) => p.metricDate === data && p.metricName === nome && (p.attributionWindow ?? '') === (janela ?? ''))?.value;

  it('versão do Capability Registry; token só no cabeçalho, com appsecret_proof', async () => {
    const c = await criarConectorMeta(database.db, cliente(), plataformas());
    expect(c.apiVersion).toBe('v26.0');

    const antes = pedidos.length;
    const contas = await c.descobrirContas({ accessToken: TOKEN });
    expect(contas).toEqual([
      { externalId: 'act_1234567890', name: 'Casa Brasa', currency: 'BRL', timezone: 'America/Sao_Paulo', providerAttributes: { account_status: 1 } },
      { externalId: 'act_2233445566', name: 'Casa Brasa Delivery', currency: 'BRL', timezone: 'America/Sao_Paulo', providerAttributes: { account_status: 1 } },
    ]);
    const [pedido] = pedidos.slice(antes);
    expect(pedido!.caminho).toBe('/v26.0/me/adaccounts');
    expect(pedido!.autorizacao).toBe(`Bearer ${TOKEN}`);
    expect(pedido!.urlCompleta).not.toContain(TOKEN);
    expect(pedido!.query.get('appsecret_proof')).toBe(createHmac('sha256', SEGREDO).update(TOKEN).digest('hex'));
  });

  it('entidades: paginação seguida, status canônico, status efetivo guardado e orçamento em micros', async () => {
    const e = await conector().lerEntidades(conta());
    expect(e.campaigns.map((c) => [c.externalId, c.status, c.providerStatus, c.dailyBudgetMicros, c.lifetimeBudgetMicros])).toEqual([
      ['120210000000000001', 'ativa', 'ACTIVE', 50_000_000, null],
      ['120210000000000002', 'pausada', 'PAUSED', null, 1_500_000_000],
    ]);
    expect(e.campaigns[0]!.objective).toBe('OUTCOME_SALES');
    expect(e.adGroups.map((g) => [g.externalId, g.status, g.providerStatus, g.parentExternalId])).toEqual([
      ['120210000000000101', 'ativa', 'ACTIVE', '120210000000000001'],
      ['120210000000000102', 'ativa', 'CAMPAIGN_PAUSED', '120210000000000002'],
    ]);
    expect(e.ads.map((a) => [a.externalId, a.status, a.parentExternalId, a.creativeExternalId])).toEqual([
      ['120210000000001001', 'ativa', '120210000000000101', '120210000000009001'],
      ['120210000000001002', 'removida', '120210000000000102', '120210000000009002'],
    ]);
    expect(e.creatives.map((c) => [c.externalId, c.kind])).toEqual([
      ['120210000000009001', 'VIDEO'],
      ['120210000000009002', 'PHOTO'],
    ]);
  });

  it('orçamento: centavos viram micros; moeda sem casas decimais não é dividida', () => {
    expect(orcamentoEmMicros('5000', 'BRL')).toBe(50_000_000);
    expect(orcamentoEmMicros('5000', 'JPY')).toBe(5_000_000_000);
    expect(orcamentoEmMicros(undefined, 'BRL')).toBeNull();
    expect(orcamentoEmMicros('abc', 'BRL')).toBeNull();
  });

  it('métricas da janela curta: insights síncronos por anúncio e dia, com cada janela de atribuição', async () => {
    const antes = pedidos.length;
    const pontos = await conector().lerMetricas(conta(), { inicio: '2026-09-14', fim: '2026-09-20' });
    const chamada = pedidos.slice(antes).find((p) => p.caminho.endsWith('/insights'))!;
    expect(chamada.metodo).toBe('GET');
    expect(chamada.query.get('level')).toBe('ad');
    expect(chamada.query.get('time_increment')).toBe('1');
    expect(JSON.parse(chamada.query.get('action_attribution_windows')!)).toEqual(['7d_click', '1d_view']);

    expect(pontos).toHaveLength(29);
    expect(doPonto(pontos, '2026-09-19', 'spend')).toBe('48.37');
    expect(doPonto(pontos, '2026-09-19', 'link_clicks')).toBe('97');
    expect(doPonto(pontos, '2026-09-20', 'impressions')).toBe('5388');
    expect(doPonto(pontos, '2026-09-19', 'conversations_started', 'padrao')).toBe('12');
    expect(doPonto(pontos, '2026-09-19', 'conversations_started', '7d_click')).toBe('10');
    expect(doPonto(pontos, '2026-09-19', 'purchases', '1d_view')).toBe('1');
    expect(doPonto(pontos, '2026-09-19', 'purchase_value', 'padrao')).toBe('412.50');
    expect(doPonto(pontos, '2026-09-19', 'meta:acao:link_click', 'padrao')).toBe('97');
    expect(doPonto(pontos, '2026-09-19', 'meta:valor:offsite_conversion.fb_pixel_purchase', '7d_click')).toBe('330.00');
    expect(doPonto(pontos, '2026-09-19', 'leads', 'padrao')).toBeUndefined();
    const canonicas = new Set(pontos.map((p) => p.metricName).filter((n) => !n.startsWith('meta:')));
    for (const n of canonicas) expect(METRICAS_CANONICAS_META).toContain(n);
  });

  it('janela de 10 dias vai em duas fatias de até 7 dias, sem buraco', async () => {
    expect(fatias('2026-09-11', '2026-09-20', 7)).toEqual([
      { since: '2026-09-11', until: '2026-09-17' },
      { since: '2026-09-18', until: '2026-09-20' },
    ]);
    const antes = pedidos.length;
    const pontos = await conector().lerMetricas(conta(), { inicio: '2026-09-11', fim: '2026-09-20' });
    const faixas = pedidos.slice(antes).filter((p) => p.caminho.endsWith('/insights')).map((p) => JSON.parse(p.query.get('time_range')!));
    expect(faixas).toEqual([
      { since: '2026-09-11', until: '2026-09-17' },
      { since: '2026-09-18', until: '2026-09-20' },
    ]);
    expect(pontos).toHaveLength(29);
  });

  it('carga inicial (janela longa): relatório assíncrono criado, acompanhado até concluir e lido', async () => {
    const antes = pedidos.length;
    const pontos = await conector().lerMetricas(conta(), { inicio: '2026-07-23', fim: '2026-09-20' });
    const feitos = pedidos.slice(antes);
    const criados = feitos.filter((p) => p.metodo === 'POST' && p.caminho === `/v26.0/${CONTA}/insights`);
    expect(criados.map((p) => JSON.parse(p.query.get('time_range')!))).toEqual([
      { since: '2026-07-23', until: '2026-08-21' },
      { since: '2026-08-22', until: '2026-09-20' },
    ]);
    expect(feitos.every((p) => p.autorizacao === `Bearer ${TOKEN}`)).toBe(true);
    expect(feitos.filter((p) => /^\/v26\.0\/\d+$/.test(p.caminho))).toHaveLength(4);
    expect(pontos).toHaveLength(29);
    expect(doPonto(pontos, '2026-09-19', 'purchase_value', '7d_click')).toBe('330.00');
  });

  it('relatório que falha ou demora devolve erro passageiro (o job tenta de novo depois)', async () => {
    await expect(conector().lerMetricas(conta('act_9990000002'), { inicio: '2026-07-01', fim: '2026-09-20' })).rejects.toMatchObject({ tipo: 'transitorio' });
    await expect(conector({ prazoRelatorioMs: 0 }).lerMetricas(conta(), { inicio: '2026-07-01', fim: '2026-09-20' })).rejects.toMatchObject({
      tipo: 'transitorio',
      message: expect.stringContaining('em andamento'),
    });
  });

  it('id de conta ou data fora do formato nem vira chamada', async () => {
    const antes = pedidos.length;
    await expect(conector().lerEntidades(conta('act_1/../me'))).rejects.toMatchObject({ tipo: 'definitivo' });
    await expect(conector().lerMetricas(conta(), { inicio: '2026-09-14', fim: "2026-09-20' OR 1=1" })).rejects.toMatchObject({ tipo: 'definitivo' });
    expect(pedidos.length).toBe(antes);
  });

  it('paginação apontando para outro endereço é recusada (o token não sai)', async () => {
    await expect(conector().lerEntidades(conta('act_9990000001'))).rejects.toMatchObject({ tipo: 'definitivo' });
  });

  it('os pontos lidos gravam no modelo temporal (nomes e janelas aceitos pelo banco)', async () => {
    const s = await signupAndLogin(api, undefined, 'Casa Brasa Conector');
    const tenantId = s.me.active_organization_id as string;
    const [marca] = await ownerQuery<{ id: string }>(`select id from liame.brand where tenant_id = $1 limit 1`, [tenantId]);
    const contaId = randomUUID();
    await ownerQuery(
      `insert into liame.connected_account (id, tenant_id, brand_id, provider, external_id, name, currency, timezone)
       values ($1, $2, $3, 'meta_ads', $4, 'Casa Brasa', 'BRL', 'America/Sao_Paulo')`,
      [contaId, tenantId, marca!.id, `act_${randomUUID().slice(0, 8)}`],
    );
    const pontos = await conector().lerMetricas(conta(), { inicio: '2026-09-14', fim: '2026-09-20' });
    const ctx = {
      tenantId,
      brandId: marca!.id,
      connectedAccountId: contaId,
      provider: 'meta_ads',
      syncRunId: null,
      sourceVersion: 'v26.0',
      currency: 'BRL',
      timezone: 'America/Sao_Paulo',
      observedAt: new Date('2026-09-21T10:00:00Z'),
    };
    const r = await withTenant(database.db, tenantId, (tx) => gravarMetricas(tx, ctx, pontos));
    expect(r).toEqual({ novas: 29, lidas: 29 });
  });
});
