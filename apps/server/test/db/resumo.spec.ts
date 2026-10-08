import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { SummaryResponse } from '@liame/contracts';
import { createDatabase, type Database, runMigrations, withTenant } from '@liame/database';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { atribuirPedidos } from '../../src/attribution/motor.js';
import { gravarToques } from '../../src/attribution/toque-store.js';
import { gravarMetricas } from '../../src/media/metric-store.js';
import { centavosParaMicros, gravarPedidos, type PedidoLido } from '../../src/orders/order-store.js';
import { diaNoFuso, menosDias } from '../../src/results/fora-do-normal.js';
import { enableMfa, ownerQuery, resetIpRateLimits, signupAndLogin, startApi, type TestApi } from '../helpers/api.js';
import { APP_URL, hasDb, OWNER_URL } from './env.js';

// A3 · I13c: o Resumo pela API. Os números são os de Resultados nos últimos 7 dias completos (e nos 7 antes), com o
// que sobrou; a situação diz quando não há Regem ou quando é a primeira semana; o que espera decisão é contado.

const FUSO = 'America/Sao_Paulo';
const hoje = diaNoFuso(new Date(), FUSO);
/** O id da campanha na plataforma é numérico: é ele que o clique traz e que liga o pedido à campanha. */
const ID_NA_META = '1301';

describe.skipIf(!hasDb)('Resumo: o dinheiro do marketing, os pedidos e o que precisa de você (A3, I13c)', () => {
  let api: TestApi;
  let database: Database;

  type Empresa = { cookie: string; tenantId: string; brandId: string; unitId: string; meta: string; loja: string | null; campanha: string; anuncio: string };

  async function empresa(opcoes: { regem?: boolean } = {}): Promise<Empresa> {
    await resetIpRateLimits();
    const s = await signupAndLogin(api, undefined, 'Hamburgueria do Resumo');
    await enableMfa(api, s.cookie);
    const tenantId = s.me.active_organization_id as string;
    const brandId = (await api.call('GET', '/v1/brands', { cookie: s.cookie })).body.items[0].id as string;
    const [unitId, meta, campanha, grupo, anuncio] = [randomUUID(), randomUUID(), randomUUID(), randomUUID(), randomUUID()];
    const loja = opcoes.regem === false ? null : randomUUID();
    await ownerQuery(`insert into liame.unit (id, tenant_id, brand_id, name, timezone) values ($1, $2, $3, 'Loja Centro', $4)`, [unitId, tenantId, brandId, FUSO]);
    await ownerQuery(
      `insert into liame.connected_account (id, tenant_id, brand_id, provider, external_id, name, currency, timezone) values ($1, $2, $3, 'meta_ads', $4, 'CA - Resumo', 'BRL', $5)`,
      [meta, tenantId, brandId, `act_${randomUUID().slice(0, 8)}`, FUSO],
    );
    if (loja) {
      await ownerQuery(
        `insert into liame.connected_account (id, tenant_id, brand_id, unit_id, provider, external_id, name, currency, timezone) values ($1, $2, $3, $4, 'regem', $5, 'Loja Centro (Regem)', 'BRL', $6)`,
        [loja, tenantId, brandId, unitId, randomUUID(), FUSO],
      );
    }
    await ownerQuery(`insert into liame.campaign (id, tenant_id, connected_account_id, provider, external_id, name, status, daily_budget_micros) values ($1, $2, $3, 'meta_ads', $4, 'Delivery noite', 'ativa', 30000000)`, [
      campanha,
      tenantId,
      meta,
      ID_NA_META,
    ]);
    await ownerQuery(`insert into liame.ad_group (id, tenant_id, connected_account_id, campaign_id, provider, external_id, name, status) values ($1, $2, $3, $4, 'meta_ads', 'g-resumo', 'Público', 'ativa')`, [
      grupo,
      tenantId,
      meta,
      campanha,
    ]);
    await ownerQuery(`insert into liame.ad (id, tenant_id, connected_account_id, ad_group_id, provider, external_id, name, status) values ($1, $2, $3, $4, 'meta_ads', 'a-resumo', 'Vídeo', 'ativa')`, [
      anuncio,
      tenantId,
      meta,
      grupo,
    ]);
    return { cookie: s.cookie, tenantId, brandId, unitId, meta, loja, campanha, anuncio };
  }

  /** As contas como se estivessem conectadas há um mês (sai da primeira semana). */
  const conectadasHaUmMes = (e: Empresa) => ownerQuery(`update liame.connected_account set created_at = now() - interval '30 days' where brand_id = $1`, [e.brandId]);

  async function gastar(e: Empresa, dia: string, reais: number): Promise<void> {
    await withTenant(database.db, e.tenantId, (tx) =>
      gravarMetricas(tx, { tenantId: e.tenantId, brandId: e.brandId, syncRunId: null, sourceVersion: null, currency: 'BRL', timezone: FUSO, observedAt: new Date(), connectedAccountId: e.meta, provider: 'meta_ads' }, [
        { level: 'ad', externalEntityId: 'a-resumo', entityId: e.anuncio, metricDate: dia, metricName: 'spend', value: reais.toFixed(2) },
      ]),
    );
  }

  /** Pedidos confirmados no caixa às 20:00 do dia, cada um com o clique da campanha uma hora antes. */
  async function vender(e: Empresa, dia: string, quantos: number, receita: number, custo: number): Promise<void> {
    const pedidos: PedidoLido[] = Array.from({ length: quantos }, (_, i) => ({
      externalId: `${dia}-${i}-${randomUUID().slice(0, 6)}`,
      channel: 'cardapio',
      channelGroup: 'cardapio',
      status: 'confirmado',
      currency: 'BRL',
      timezone: FUSO,
      revenueMicros: centavosParaMicros(Math.round(receita * 100)),
      discountMicros: 0n,
      refundedMicros: 0n,
      couponCode: null,
      customer: null,
      isNewCustomer: null,
      placedAt: null,
      confirmedAt: `${dia}T23:00:00Z`,
      cancelledAt: null,
      version: 1n,
      sourceUpdatedAt: `${dia}T23:00:00Z`,
      items: [{ externalId: 'i1', name: 'Combo', quantity: '1', revenueMicros: centavosParaMicros(Math.round(receita * 100)), costMicros: centavosParaMicros(Math.round(custo * 100)) }],
    }));
    await withTenant(database.db, e.tenantId, async (tx) => {
      const r = await gravarPedidos(tx, { tenantId: e.tenantId, brandId: e.brandId, unitId: e.unitId, connectedAccountId: e.loja!, provider: 'regem' }, pedidos);
      await gravarToques(
        tx,
        { tenantId: e.tenantId, brandId: e.brandId, connectedAccountId: e.loja! },
        pedidos.map((p) => ({ externalId: `t-${p.externalId}`, kind: 'clique' as const, occurredAt: `${dia}T22:00:00Z`, orderExternalId: p.externalId, fbclid: `IwAR-${p.externalId}`, campaignExternalId: ID_NA_META })),
      );
      await atribuirPedidos(tx, { tenantId: e.tenantId, orderIds: r.alterados.map((a) => a.id), gatilho: 'pedidos' });
    });
  }

  const resumo = async (e: { cookie: string }, brandId: string) => {
    const r = await api.call('GET', `/v1/summary?brand_id=${brandId}`, { cookie: e.cookie });
    expect(r.status).toBe(200);
    return SummaryResponse.parse(r.body);
  };

  beforeAll(async () => {
    await runMigrations({ connectionString: OWNER_URL, dir: resolve(process.cwd(), '../../packages/database/migrations') });
    api = await startApi();
    await resetIpRateLimits();
    database = createDatabase({ connectionString: APP_URL, max: 3, applicationName: 'liame-test' });
  });
  afterAll(async () => {
    await database?.close();
    await api?.close();
  });

  it('o dinheiro do marketing nos últimos 7 dias completos, com a semana anterior, o veredito e os pedidos', async () => {
    const e = await empresa();
    await conectadasHaUmMes(e);
    // Esta semana: R$ 100 de gasto e 2 pedidos de R$ 60 com custo de R$ 20 (margem de R$ 80): sobrou −R$ 20.
    await gastar(e, menosDias(hoje, 2), 100);
    await vender(e, menosDias(hoje, 2), 2, 60, 20);
    // A semana anterior: R$ 80 de gasto e 1 pedido de R$ 100 com custo de R$ 30 (margem de R$ 70): sobrou −R$ 10.
    await gastar(e, menosDias(hoje, 9), 80);
    await vender(e, menosDias(hoje, 9), 1, 100, 30);

    const r = await resumo(e, e.brandId);
    expect(r).toMatchObject({
      state: 'ok',
      period: { from: menosDias(hoje, 7), to: menosDias(hoje, 1), timezone: FUSO },
      previous: { from: menosDias(hoje, 14), to: menosDias(hoje, 8) },
      money: {
        revenue_micros: { now: '120000000', before: '100000000' },
        spend_micros: { now: '100000000', before: '80000000' },
        left_micros: { now: '-20000000', before: '-10000000' },
        margin_known_micros: '80000000',
        margin_coverage_pct: '100.0',
        revenue_with_margin_micros: '120000000',
        verdict: 'prejuizo',
      },
      campaigns: { profit: [], loss: [{ campaign_id: e.campanha, name: 'Delivery noite', provider: 'meta_ads' }] },
      orders: { marketing: 2, average_micros: '60000000', all_channels: 2, without_origin: 0 },
      platforms: [{ provider: 'meta_ads', orders: 2, left_micros: '-20000000', spend_micros: '100000000' }],
      needs_you: { approvals: { actions: 0, plans: 0, autonomy: 0 } },
    });
    expect(r.needs_you.items.length).toBeLessThanOrEqual(5);
    expect(r.needs_you.items.every((i) => i.severity === 'critica' || i.severity === 'atencao')).toBe(true);
    expect(r.needs_you.critical + r.needs_you.attention).toBeGreaterThanOrEqual(r.needs_you.items.length);
    expect(r.sources.map((s) => s.provider).sort()).toEqual(['meta_ads', 'regem']);
  });

  it('as situações: a primeira semana e a marca sem o Regem; e o que espera decisão', async () => {
    const nova = await empresa();
    expect((await resumo(nova, nova.brandId)).state).toBe('primeira_semana');

    const semRegem = await empresa({ regem: false });
    await conectadasHaUmMes(semRegem);
    await gastar(semRegem, menosDias(hoje, 2), 50);
    const r = await resumo(semRegem, semRegem.brandId);
    expect(r).toMatchObject({ state: 'sem_regem', money: { spend_micros: { now: '50000000' }, revenue_micros: { now: '0' }, left_micros: { now: null }, verdict: null } });
    // O aviso de que as vendas não estão conectadas é informação: está na Atenção, mas não pede ninguém aqui.
    expect(r.needs_you.items.map((i) => i.kind)).not.toContain('vendas_nao_conectadas');

    // Uma proposta de autonomia pendente entra no que espera decisão.
    const snapshot = randomUUID();
    await ownerQuery(
      `insert into liame.readiness_snapshot (id, tenant_id, brand_id, connected_account_id, tool, computed_on, rule_version, sample_size, missing) values ($1, $2, $3, $4, 'orcamento_reduzir', $5, 1, 31, '{}')`,
      [snapshot, nova.tenantId, nova.brandId, nova.meta, hoje],
    );
    await ownerQuery(
      `insert into liame.autonomy_proposal (id, tenant_id, brand_id, connected_account_id, tool, action, from_mode, to_mode, readiness_snapshot_id, rule_version, sample_size, signals, status)
       values ($1, $2, $3, $4, 'orcamento_reduzir', 'orcamento.reduzir', 'SHADOW', 'SUGGEST', $5, 1, 31, '{}', 'pendente')`,
      [randomUUID(), nova.tenantId, nova.brandId, nova.meta, snapshot],
    );
    // As peças do Criativo vêm junto para quem acompanha as campanhas: aqui, nenhuma (a conta com peças está em `pecas-decisoes.spec.ts`).
    expect((await resumo(nova, nova.brandId)).needs_you.approvals).toEqual({ actions: 0, plans: 0, autonomy: 1, pieces: { ready: 0, barred: 0, offers: 0, offer: null } });

    // Outra empresa não vê esta marca.
    expect((await api.call('GET', `/v1/summary?brand_id=${nova.brandId}`, { cookie: semRegem.cookie })).status).toBe(404);
  });
});
