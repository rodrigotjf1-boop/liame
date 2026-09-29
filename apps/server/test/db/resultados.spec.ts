import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { createDatabase, type Database, runMigrations, withTenant } from '@liame/database';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { atribuirPedidos } from '../../src/attribution/motor.js';
import { gravarToques } from '../../src/attribution/toque-store.js';
import { gravarMetricas } from '../../src/media/metric-store.js';
import { centavosParaMicros, gravarPedidos, type PedidoLido } from '../../src/orders/order-store.js';
import { razao, porcento } from '../../src/results/results.service.js';
import { enableMfa, ownerQuery, resetIpRateLimits, signupAndLogin, startApi, type TestApi } from '../helpers/api.js';
import { APP_URL, hasDb, OWNER_URL } from './env.js';

// A2.5 · F8: o ROAS que a plataforma informa, com a janela dela, ao lado do ROAS confirmado no caixa, com
// o modelo (último toque, 7 dias). Cada número conferido: gasto, valor da plataforma, pedidos, receita,
// margem conhecida e cobertura, sem origem, canais sem clique e cancelados (A2.5-6, A2.5-9).

const M = (reais: number) => (BigInt(Math.round(reais * 100)) * 10_000n).toString();

describe.skipIf(!hasDb)('resultados do ciclo fechado (A2.5 · F8)', () => {
  let api: TestApi;
  let database: Database;
  let cookie = '';
  let tenantId = '';
  let brandId = '';
  let unitId = '';
  const ids: Record<string, string> = {};

  const pedido = (externalId: string, over: Partial<PedidoLido>): PedidoLido => ({
    externalId,
    channel: 'cardapio',
    channelGroup: 'cardapio',
    status: 'confirmado',
    currency: 'BRL',
    timezone: 'America/Sao_Paulo',
    revenueMicros: 0n,
    discountMicros: 0n,
    refundedMicros: 0n,
    couponCode: null,
    customer: null,
    isNewCustomer: null,
    placedAt: null,
    confirmedAt: '2026-09-26T23:00:00Z',
    cancelledAt: null,
    version: 1n,
    sourceUpdatedAt: '2026-09-26T23:00:00Z',
    items: [],
    ...over,
  });
  const item = (id: string, receita: number, custo: number | null) => ({
    externalId: id,
    name: `Item ${id}`,
    quantity: '1',
    revenueMicros: centavosParaMicros(Math.round(receita * 100)),
    costMicros: custo === null ? null : centavosParaMicros(Math.round(custo * 100)),
  });

  async function conta(provider: string, nome: string, extra: { unit?: boolean } = {}) {
    const id = randomUUID();
    await ownerQuery(
      `insert into liame.connected_account (id, tenant_id, brand_id, unit_id, provider, external_id, name, currency, timezone)
       values ($1, $2, $3, $4, $5, $6, $7, 'BRL', 'America/Sao_Paulo')`,
      [id, tenantId, brandId, extra.unit ? unitId : null, provider, randomUUID(), nome],
    );
    return id;
  }

  beforeAll(async () => {
    await runMigrations({ connectionString: OWNER_URL, dir: resolve(process.cwd(), '../../packages/database/migrations') });
    api = await startApi();
    await resetIpRateLimits();
    database = createDatabase({ connectionString: APP_URL, max: 2, applicationName: 'liame-test' });
    const s = await signupAndLogin(api, undefined, 'Mister Burgers Resultados');
    await enableMfa(api, s.cookie);
    cookie = s.cookie;
    tenantId = s.me.active_organization_id as string;
    brandId = (await ownerQuery<{ id: string }>(`select id from liame.brand where tenant_id = $1 limit 1`, [tenantId]))[0]!.id;
    unitId = randomUUID();
    await ownerQuery(`insert into liame.unit (id, tenant_id, brand_id, name, timezone) values ($1, $2, $3, 'Loja Centro', 'America/Sao_Paulo')`, [unitId, tenantId, brandId]);

    // Mídia: Meta por anúncio (janela 7d_click) e Google por campanha (janela padrão da ação de conversão).
    const meta = await conta('meta_ads', 'CA - Mister');
    const google = await conta('google_ads', 'Google Ads Mister');
    ids.C1 = randomUUID();
    ids.G1 = randomUUID();
    const grupo = randomUUID();
    ids.A1 = randomUUID();
    await ownerQuery(`insert into liame.campaign (id, tenant_id, connected_account_id, provider, external_id, name, status) values ($1, $2, $3, 'meta_ads', '1201', 'Combo sexta', 'ativa')`, [ids.C1, tenantId, meta]);
    await ownerQuery(`insert into liame.ad_group (id, tenant_id, connected_account_id, campaign_id, provider, external_id, name, status) values ($1, $2, $3, $4, 'meta_ads', '2301', 'Público', 'ativa')`, [grupo, tenantId, meta, ids.C1]);
    await ownerQuery(`insert into liame.ad (id, tenant_id, connected_account_id, ad_group_id, provider, external_id, name, status) values ($1, $2, $3, $4, 'meta_ads', '3401', 'Vídeo combo', 'ativa')`, [ids.A1, tenantId, meta, grupo]);
    await ownerQuery(`insert into liame.campaign (id, tenant_id, connected_account_id, provider, external_id, name, status) values ($1, $2, $3, 'google_ads', '9001', 'Busca hambúrguer', 'ativa')`, [ids.G1, tenantId, google]);

    await withTenant(database.db, tenantId, async (tx) => {
      const base = { tenantId, brandId, syncRunId: null, sourceVersion: null, currency: 'BRL', timezone: 'America/Sao_Paulo', observedAt: new Date('2026-09-28T10:00:00Z') };
      await gravarMetricas(tx, { ...base, connectedAccountId: meta, provider: 'meta_ads' }, [
        { level: 'ad', externalEntityId: '3401', entityId: ids.A1, metricDate: '2026-09-26', metricName: 'spend', value: '100.00' },
        { level: 'ad', externalEntityId: '3401', entityId: ids.A1, metricDate: '2026-09-27', metricName: 'spend', value: '50.00' },
        { level: 'ad', externalEntityId: '3401', entityId: ids.A1, metricDate: '2026-09-26', metricName: 'purchase_value', attributionWindow: '7d_click', value: '380.00' },
        { level: 'ad', externalEntityId: '3401', entityId: ids.A1, metricDate: '2026-09-26', metricName: 'purchase_value', attributionWindow: '1d_view', value: '999.00' },
        { level: 'ad', externalEntityId: '3401', entityId: ids.A1, metricDate: '2026-09-26', metricName: 'purchases', attributionWindow: '7d_click', value: 4 },
        { level: 'ad', externalEntityId: '3401', entityId: ids.A1, metricDate: '2026-09-26', metricName: 'conversations_started', attributionWindow: '7d_click', value: 10 },
        // Fora do período: não entra.
        { level: 'ad', externalEntityId: '3401', entityId: ids.A1, metricDate: '2026-09-28', metricName: 'spend', value: '70.00' },
      ]);
      await gravarMetricas(tx, { ...base, connectedAccountId: google, provider: 'google_ads' }, [
        { level: 'campaign', externalEntityId: '9001', entityId: ids.G1, metricDate: '2026-09-26', metricName: 'spend', value: '40.00' },
        { level: 'campaign', externalEntityId: '9001', entityId: ids.G1, metricDate: '2026-09-26', metricName: 'conversions_value', attributionWindow: 'padrao', value: '120.00' },
        { level: 'campaign', externalEntityId: '9001', entityId: ids.G1, metricDate: '2026-09-26', metricName: 'conversions', attributionWindow: 'padrao', value: 3 },
        // O nível de anúncio do Google não soma de novo (a campanha já tem tudo, inclusive a PMax).
        { level: 'ad', externalEntityId: '9201', metricDate: '2026-09-26', metricName: 'spend', value: '40.00' },
      ]);

      // Caixa: pedidos da loja, com a origem de cada um.
      const loja = await conta('regem', 'Loja Centro (Regem)', { unit: true });
      const ctx = { tenantId, brandId, unitId, connectedAccountId: loja, provider: 'regem' };
      const r = await gravarPedidos(tx, ctx, [
        pedido('o1', { revenueMicros: BigInt(M(60)), items: [item('a', 40, 15), item('b', 20, 5)] }),
        pedido('o2', { revenueMicros: BigInt(M(40)), items: [item('a', 40, null)] }),
        pedido('o3', { channel: 'ifood', channelGroup: 'marketplace', revenueMicros: BigInt(M(80)), items: [item('a', 80, 30)] }),
        pedido('o4', { revenueMicros: BigInt(M(30)), items: [item('a', 30, 10)] }),
        pedido('o5', { status: 'cancelado', cancelledAt: '2026-09-27T01:00:00Z', revenueMicros: BigInt(M(25)), items: [item('a', 25, 5)] }),
        pedido('o6', { channel: 'balcao', channelGroup: 'presencial', status: 'removido', revenueMicros: BigInt(M(19.9)) }),
        pedido('o7', { revenueMicros: BigInt(M(55)), confirmedAt: '2026-09-30T15:00:00Z', items: [item('a', 55, 20)] }),
        // Confirmado às 23:30 de 27/09 em Brasília (02:30 UTC de 28/09): ainda é do período no fuso da loja.
        pedido('o8', { revenueMicros: BigInt(M(10)), confirmedAt: '2026-09-28T02:30:00Z', items: [item('a', 10, 2)] }),
      ]);
      for (const a of r.alterados) ids[a.externalId] = a.id;
      await gravarToques(tx, { tenantId, brandId, connectedAccountId: loja }, [
        { externalId: 't1', kind: 'clique', occurredAt: '2026-09-25T20:00:00Z', orderExternalId: 'o1', fbclid: 'IwAR1', campaignExternalId: '1201' },
        { externalId: 't2', kind: 'clique', occurredAt: '2026-09-26T21:00:00Z', orderExternalId: 'o2', gclid: 'Cj0o2' },
        { externalId: 't5', kind: 'clique', occurredAt: '2026-09-26T21:00:00Z', orderExternalId: 'o5', fbclid: 'IwAR5', campaignExternalId: '1201' },
        { externalId: 't7', kind: 'clique', occurredAt: '2026-09-29T21:00:00Z', orderExternalId: 'o7', fbclid: 'IwAR7', campaignExternalId: '1201' },
      ]);
      await atribuirPedidos(tx, { tenantId, orderIds: r.alterados.map((a) => a.id), gatilho: 'pedidos' });
    });
  });
  afterAll(async () => {
    await database?.close();
    await api?.close();
  });

  const consultar = (params: Record<string, string>) => api.call('GET', `/v1/results/closed-loop?${new URLSearchParams(params)}`, { cookie });

  it('razão e porcentagem com arredondamento exato, sem ponto flutuante', () => {
    expect(razao(380_000_000n, 150_000_000n)).toBe('2.53');
    expect(razao(100_000_000n, 190_000_000n)).toBe('0.53');
    expect(razao(1n, 3n)).toBe('0.33');
    expect(razao(2n, 3n)).toBe('0.67');
    expect(razao(5n, 0n)).toBeNull();
    expect(porcento(60n, 100n)).toBe('60.0');
    expect(porcento(2n, 3n)).toBe('66.7');
    expect(porcento(1n, 0n)).toBeNull();
  });

  it('totais: gasto, caixa, atribuído, sem origem, canais sem clique e cancelados', async () => {
    const r = await consultar({ brand_id: brandId, from: '2026-09-26', to: '2026-09-27' });
    expect(r.status).toBe(200);
    expect(r.body.period).toEqual({ from: '2026-09-26', to: '2026-09-27', timezone: 'America/Sao_Paulo', account_timezones: ['America/Sao_Paulo'] });
    expect(r.body.model).toMatchObject({ key: 'ultimo_toque', version: 1, window_days: 7, counts_views: false });
    expect(r.body.totals).toEqual({
      spend_micros: M(190),
      orders_confirmed: 5,
      revenue_micros: M(220),
      confirmed: {
        orders: 2,
        revenue_micros: M(100),
        roas: '0.53',
        cost_per_order_micros: M(95),
        // o1: 60 − 20 de custo = 40; o2 tem item sem custo → margem desconhecida (não é zero).
        margin_known_micros: M(40),
        margin_coverage_pct: '60.0',
      },
      // 2 dos 4 pedidos dos canais com clique (o marketplace fica à parte).
      without_origin: { orders: 2, revenue_micros: M(40), share_pct: '50.0' },
      no_click_channels: [{ channel_group: 'marketplace', orders: 1, revenue_micros: M(80) }],
      cancelled: { orders: 1, revenue_micros: M(25) },
      verdict: null,
    });
  });

  it('cada plataforma com a janela dela, ao lado do confirmado; campanha com o que a plataforma diz e o caixa', async () => {
    const r = await consultar({ brand_id: brandId, from: '2026-09-26', to: '2026-09-27' });
    const meta = r.body.platforms.find((p: { provider: string }) => p.provider === 'meta_ads');
    expect(meta).toEqual({
      provider: 'meta_ads',
      platform: {
        spend_micros: M(150),
        value_micros: M(380),
        roas: '2.53',
        window: '7d_click',
        conversions: '4',
        conversations: '10',
        cost_per_conversation_micros: M(15),
      },
      confirmed: { orders: 1, revenue_micros: M(60), roas: '0.40', cost_per_order_micros: M(150), margin_known_micros: M(40), margin_coverage_pct: '100.0' },
      platform_only_orders: 0,
    });
    const google = r.body.platforms.find((p: { provider: string }) => p.provider === 'google_ads');
    expect(google.platform).toMatchObject({ spend_micros: M(40), value_micros: M(120), roas: '3.00', window: 'padrao', conversions: '3' });
    // O gclid sem campanha prova o Google, mas não a campanha: entra na plataforma, não na campanha.
    expect(google.confirmed).toMatchObject({ orders: 1, revenue_micros: M(40), roas: '1.00', margin_known_micros: null, margin_coverage_pct: '0.0' });
    expect(google.platform_only_orders).toBe(1);

    expect(r.body.campaigns.map((c: { name: string }) => c.name)).toEqual(['Combo sexta', 'Busca hambúrguer']);
    const c1 = r.body.campaigns[0];
    expect(c1).toMatchObject({ campaign_id: ids.C1, provider: 'meta_ads', status: 'ativa' });
    expect(c1.platform).toMatchObject({ spend_micros: M(150), value_micros: M(380), roas: '2.53' });
    expect(c1.confirmed).toMatchObject({ orders: 1, revenue_micros: M(60), roas: '0.40', cost_per_order_micros: M(150) });
    expect(r.body.campaigns[1].confirmed).toMatchObject({ orders: 0, revenue_micros: '0', roas: '0.00', cost_per_order_micros: null, margin_known_micros: null });
  });

  it('com a margem conhecida em 80%+ da receita confirmada, diz se deu lucro ou prejuízo', async () => {
    // O item de o2 ganha custo: a margem passa a ser conhecida em toda a receita confirmada.
    await ownerQuery(`update liame.order_item_fact set cost_micros = $1 where order_id = $2`, [M(10), ids.o2]);
    const r = await consultar({ brand_id: brandId, from: '2026-09-26', to: '2026-09-27' });
    // Margem: o1 40 + o2 30 = 70 em 100% da receita confirmada; gasto 190 → prejuízo.
    expect(r.body.totals.confirmed).toMatchObject({ margin_known_micros: M(70), margin_coverage_pct: '100.0' });
    expect(r.body.totals.verdict).toBe('prejuizo');
  });

  it('origem de cada pedido: evidência, horas antes, janela e motivo; sem dado pessoal', async () => {
    const r = await api.call('GET', `/v1/results/orders?${new URLSearchParams({ brand_id: brandId, from: '2026-09-26', to: '2026-09-27' })}`, { cookie });
    expect(r.status).toBe(200);
    const o1 = r.body.items.find((i: { external_id: string }) => i.external_id === 'o1');
    expect(o1.attribution).toEqual({
      status: 'atribuido',
      evidence: 'clique_campanha',
      confidence: 'alta',
      provider: 'meta_ads',
      campaign: { id: ids.C1, name: 'Combo sexta' },
      ad: null,
      touch_at: '2026-09-25T20:00:00.000Z',
      hours_before: 27,
      window_days: 7,
      counted: true,
      reason: null,
    });
    expect(o1).toMatchObject({ channel_group: 'cardapio', status: 'confirmado', revenue_micros: M(60), margin_micros: M(40) });
    expect(r.body.items.map((i: { external_id: string }) => i.external_id)).not.toContain('o6');
    expect(r.body.items.map((i: { external_id: string }) => i.external_id)).not.toContain('o7');
    expect(JSON.stringify(r.body)).not.toMatch(/IwAR|Cj0|gclid|fbclid|telefone|phone/);

    const semOrigem = await api.call('GET', `/v1/results/orders?${new URLSearchParams({ brand_id: brandId, from: '2026-09-26', to: '2026-09-27', status: 'sem_origem' })}`, { cookie });
    expect(semOrigem.body.items.map((i: { external_id: string; attribution: { reason: string } }) => [i.external_id, i.attribution.reason]).sort()).toEqual([
      ['o3', 'canal_sem_clique'],
      ['o4', 'sem_evidencia'],
      ['o8', 'sem_evidencia'],
    ]);
  });

  it('período inválido ou longo, marca de outra empresa e loja de outra marca são recusados', async () => {
    expect((await consultar({ brand_id: brandId, from: '2026-09-27', to: '2026-09-26' })).status).toBe(422);
    expect((await consultar({ brand_id: brandId, from: '2026-01-01', to: '2026-09-26' })).status).toBe(422);
    expect((await consultar({ brand_id: randomUUID(), from: '2026-09-26', to: '2026-09-27' })).status).toBe(404);
    expect((await consultar({ brand_id: brandId, unit_id: randomUUID(), from: '2026-09-26', to: '2026-09-27' })).status).toBe(404);
    const outra = await signupAndLogin(api, undefined, 'Outra Hamburgueria');
    await enableMfa(api, outra.cookie);
    const r = await api.call('GET', `/v1/results/closed-loop?${new URLSearchParams({ brand_id: brandId, from: '2026-09-26', to: '2026-09-27' })}`, { cookie: outra.cookie });
    expect(r.status).toBe(404);
  });

  it('frescor de cada fonte da tela: mídia pelas métricas, Regem pelos pedidos', async () => {
    const r = await consultar({ brand_id: brandId, from: '2026-09-26', to: '2026-09-27' });
    expect(r.body.sources.map((s: { provider: string; dataset: string; freshness: string }) => [s.provider, s.dataset, s.freshness])).toEqual([
      ['google_ads', 'metricas', 'unknown'],
      ['meta_ads', 'metricas', 'unknown'],
      ['regem', 'pedidos', 'unknown'],
    ]);
  });
});
