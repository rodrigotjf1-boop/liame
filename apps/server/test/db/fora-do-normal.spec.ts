import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { createDatabase, type Database, runMigrations, withTenant } from '@liame/database';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { atribuirPedidos } from '../../src/attribution/motor.js';
import { gravarToques } from '../../src/attribution/toque-store.js';
import { gravarPedidos, type PedidoLido } from '../../src/orders/order-store.js';
import { diaNoFuso, menosDias } from '../../src/results/fora-do-normal.js';
import { enableMfa, ownerQuery, resetIpRateLimits, signupAndLogin, startApi, type TestApi } from '../helpers/api.js';
import { APP_URL, hasDb, OWNER_URL } from './env.js';

// A3 · I6 de ponta a ponta: a Atenção pela API, com o banco. A loja vendeu ontem menos da metade do normal
// do mesmo dia da semana; a campanha gastou mais que o dobro e o custo por pedido subiu. Com a fonte lida
// só ontem, nenhum desses avisos sai (dado velho não gera aviso).

const FUSO = 'America/Sao_Paulo';
const nbsp = (s: string) => s.replace(/R\$ /g, 'R$ ');

type Item = { kind: string; severity: string; title: string; detail: string; provider: string | null; campaign_id: string | null; connected_account_id: string | null };

describe.skipIf(!hasDb)('fora do normal, pela Atenção (A3 · I6)', () => {
  let api: TestApi;
  let database: Database;
  const hoje = diaNoFuso(new Date(), FUSO);
  const ontem = menosDias(hoje, 1);
  /** O mesmo dia da semana de ontem, nas 4 semanas anteriores. */
  const semanas = [1, 2, 3, 4].map((s) => menosDias(ontem, s * 7));

  const foraDoNormal = async (cookie: string, brandId: string) => {
    const r = await api.call('GET', `/v1/results/attention?brand_id=${brandId}`, { cookie });
    expect(r.status).toBe(200);
    return (r.body.items as Item[]).filter((i) => i.kind.endsWith('fora_do_normal'));
  };

  beforeAll(async () => {
    await runMigrations({ connectionString: OWNER_URL, dir: resolve(process.cwd(), '../../packages/database/migrations') });
    api = await startApi();
    await resetIpRateLimits();
    database = createDatabase({ connectionString: APP_URL, max: 2, applicationName: 'liame-test' });
  });
  afterAll(async () => {
    await database?.close();
    await api?.close();
  });

  it('vendas abaixo do normal, gasto da campanha acima e custo por pedido subindo; com a fonte de ontem, nada', async () => {
    const s = await signupAndLogin(api, undefined, 'Mister Burgers Fora do Normal');
    await enableMfa(api, s.cookie);
    const tenantId = s.me.active_organization_id as string;
    const brandId = (await ownerQuery<{ id: string }>(`select id from liame.brand where tenant_id = $1 limit 1`, [tenantId]))[0]!.id;
    const [unitId, meta, regem, campanha, grupo, anuncio] = [randomUUID(), randomUUID(), randomUUID(), randomUUID(), randomUUID(), randomUUID()];
    await ownerQuery(`insert into liame.unit (id, tenant_id, brand_id, name, timezone, order_platform) values ($1, $2, $3, 'Loja Centro', $4, 'regem')`, [unitId, tenantId, brandId, FUSO]);
    await ownerQuery(
      `insert into liame.connected_account (id, tenant_id, brand_id, unit_id, provider, external_id, name, currency, timezone)
       values ($1, $2, $3, null, 'meta_ads', $4, 'CA - Mister', 'BRL', $6), ($5, $2, $3, $7, 'regem', $8, 'Loja Centro (Regem)', 'BRL', $6)`,
      [meta, tenantId, brandId, randomUUID(), regem, FUSO, unitId, randomUUID()],
    );
    await ownerQuery(`insert into liame.campaign (id, tenant_id, connected_account_id, provider, external_id, name, status) values ($1, $2, $3, 'meta_ads', '7701', 'Combo sexta', 'ativa')`, [campanha, tenantId, meta]);
    await ownerQuery(`insert into liame.ad_group (id, tenant_id, connected_account_id, campaign_id, provider, external_id, name, status) values ($1, $2, $3, $4, 'meta_ads', '7702', 'Público', 'ativa')`, [grupo, tenantId, meta, campanha]);
    await ownerQuery(`insert into liame.ad (id, tenant_id, connected_account_id, ad_group_id, provider, external_id, name, status) values ($1, $2, $3, $4, 'meta_ads', '7703', 'Vídeo', 'ativa')`, [anuncio, tenantId, meta, grupo]);
    const lidas = (quando: string) =>
      ownerQuery(
        `insert into liame.sync_state (connected_account_id, dataset, tenant_id, expected_every_minutes, last_success_at)
         values ($1, 'metricas', $3, 1440, ${quando}), ($2, 'pedidos', $3, 15, ${quando})
         on conflict (connected_account_id, dataset) do update set last_success_at = excluded.last_success_at`,
        [meta, regem, tenantId],
      );
    await lidas('now()');

    // Gasto da campanha: R$ 50 no mesmo dia das 4 semanas anteriores e R$ 130 ontem.
    for (const [dia, valor] of [...semanas.map((d) => [d, 50] as const), [ontem, 130] as const]) {
      await ownerQuery(
        `insert into liame.metric_latest (connected_account_id, level, external_entity_id, metric_date, metric_name, attribution_window, tenant_id, brand_id,
                                          provider, entity_id, metric_value, currency, timezone, observed_at, changed_at)
         values ($1, 'ad', '7703', $2, 'spend', '', $3, $4, 'meta_ads', $5, $6, 'BRL', $7, now(), now())`,
        [meta, dia, tenantId, brandId, anuncio, valor, FUSO],
      );
    }

    // Vendas: 20 pedidos de R$ 50 em cada um dos 4 dias (2 deles pelo clique da campanha) e 8 ontem (1 pela campanha).
    const pedido = (externalId: string, dia: string): PedidoLido => ({
      externalId,
      channel: 'cardapio',
      channelGroup: 'cardapio',
      status: 'confirmado',
      currency: 'BRL',
      timezone: FUSO,
      revenueMicros: 50_000_000n,
      discountMicros: 0n,
      refundedMicros: 0n,
      couponCode: null,
      customer: null,
      isNewCustomer: null,
      placedAt: null,
      // Meio-dia em Brasília.
      confirmedAt: `${dia}T15:00:00Z`,
      cancelledAt: null,
      version: 1n,
      sourceUpdatedAt: `${dia}T15:00:00Z`,
      items: [],
    });
    const pedidos = [...semanas.flatMap((dia) => Array.from({ length: 20 }, (_, i) => pedido(`${dia}-${i}`, dia))), ...Array.from({ length: 8 }, (_, i) => pedido(`${ontem}-${i}`, ontem))];
    const daCampanha = [...semanas.flatMap((dia) => [`${dia}-0`, `${dia}-1`]), `${ontem}-0`];
    await withTenant(database.db, tenantId, async (tx) => {
      const g = await gravarPedidos(tx, { tenantId, brandId, unitId, connectedAccountId: regem, provider: 'regem' }, pedidos);
      await gravarToques(
        tx,
        { tenantId, brandId, connectedAccountId: regem },
        daCampanha.map((id) => ({ externalId: `t-${id}`, kind: 'clique' as const, occurredAt: `${id.slice(0, 10)}T14:00:00Z`, orderExternalId: id, fbclid: `IwAR-${id}`, campaignExternalId: '7701' })),
      );
      await atribuirPedidos(tx, { tenantId, orderIds: g.alterados.map((a) => a.id), gatilho: 'pedidos' });
    });

    const avisos = await foraDoNormal(s.cookie, brandId);
    expect(avisos.map((i) => [i.kind, i.severity])).toEqual([
      ['vendas_fora_do_normal', 'atencao'],
      ['gasto_da_campanha_fora_do_normal', 'atencao'],
      ['custo_por_pedido_fora_do_normal', 'atencao'],
    ]);
    expect(avisos[0]).toMatchObject({ provider: 'regem', connected_account_id: regem, title: 'As vendas de ontem na Loja Centro ficaram abaixo do normal' });
    expect(avisos[0]!.detail).toContain(nbsp('8 pedidos e R$ 400,00 ontem'));
    expect(avisos[0]!.detail).toContain(nbsp('o normal foi de 20 pedidos e R$ 1.000,00. São R$ 600,00 a menos.'));
    expect(avisos[1]).toMatchObject({ provider: 'meta_ads', campaign_id: campanha, connected_account_id: meta, title: 'A campanha "Combo sexta" gastou acima do normal ontem' });
    expect(avisos[1]!.detail).toContain(nbsp('R$ 130,00 ontem'));
    expect(avisos[1]!.detail).toContain(nbsp('o normal foi de R$ 50,00. São R$ 80,00 a mais'));
    // R$ 130 para 1 pedido na semana; nas 4 semanas anteriores, R$ 200 para 8 pedidos (R$ 25 cada).
    expect(avisos[2]).toMatchObject({ campaign_id: campanha, title: 'O custo por pedido da campanha "Combo sexta" subiu' });
    expect(avisos[2]!.detail).toContain(nbsp('R$ 130,00 por pedido confirmado nos últimos 7 dias (1 pedido, R$ 130,00); nas 4 semanas anteriores era R$ 25,00. São R$ 105,00 a mais no período'));

    // Outra empresa não vê nada disso.
    const outra = await signupAndLogin(api, undefined, 'Outra Empresa Fora do Normal');
    await enableMfa(api, outra.cookie);
    const outraMarca = (await ownerQuery<{ id: string }>(`select id from liame.brand where tenant_id = $1 limit 1`, [outra.me.active_organization_id]))[0]!.id;
    expect(await foraDoNormal(outra.cookie, outraMarca)).toEqual([]);
    expect((await api.call('GET', `/v1/results/attention?brand_id=${brandId}`, { cookie: outra.cookie })).status).toBe(404);

    // Dado velho não gera aviso: com a última leitura feita ontem, o dia de ontem pode não estar inteiro.
    await lidas(`now() - interval '26 hours'`);
    expect(await foraDoNormal(s.cookie, brandId)).toEqual([]);
  });
});
