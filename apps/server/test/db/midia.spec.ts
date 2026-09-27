import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { createDatabase, type Database, runMigrations, withTenant } from '@liame/database';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { gravarMetricas, metricasEm, type PontoMetrica } from '../../src/media/metric-store.js';
import { ownerQuery, resetIpRateLimits, signupAndLogin, startApi, type TestApi } from '../helpers/api.js';
import { APP_URL, hasDb, OWNER_URL } from './env.js';

// A2 · G1: métricas com modelo temporal. A plataforma reescreve o passado; o Liame guarda cada número
// que mudou ("quanto dizia naquela data") e o último valor por chave, tudo sob a RLS da empresa.
describe.skipIf(!hasDb)('modelo de mídia: métricas com modelo temporal', () => {
  let api: TestApi;
  let database: Database;
  const empresas: { tenantId: string; brandId: string; contaId: string }[] = [];

  async function empresaComConta(nome: string) {
    const s = await signupAndLogin(api, undefined, nome);
    const tenantId = s.me.active_organization_id as string;
    const [marca] = await ownerQuery<{ id: string }>(`select id from liame.brand where tenant_id = $1 limit 1`, [tenantId]);
    const contaId = randomUUID();
    await ownerQuery(
      `insert into liame.connected_account (id, tenant_id, brand_id, provider, external_id, name, currency, timezone)
       values ($1, $2, $3, 'meta_ads', 'act_' || $4, 'Conta de teste', 'BRL', 'America/Sao_Paulo')`,
      [contaId, tenantId, marca!.id, Math.floor(Math.random() * 1e9).toString()],
    );
    return { tenantId, brandId: marca!.id, contaId };
  }

  const ctx = (e: (typeof empresas)[number], observedAt: Date) => ({
    tenantId: e.tenantId,
    brandId: e.brandId,
    connectedAccountId: e.contaId,
    provider: 'meta_ads',
    syncRunId: null,
    sourceVersion: 'v26.0',
    currency: 'BRL',
    timezone: 'America/Sao_Paulo',
    observedAt,
  });

  const dia = (d: string, conv: number, gasto = '123.45'): PontoMetrica[] => [
    { level: 'ad', externalEntityId: '6001', metricDate: d, metricName: 'spend', value: gasto },
    { level: 'ad', externalEntityId: '6001', metricDate: d, metricName: 'impressions', value: 1000 },
    { level: 'ad', externalEntityId: '6001', metricDate: d, metricName: 'conversions', attributionWindow: '7d_click_1d_view', value: conv },
  ];

  beforeAll(async () => {
    await runMigrations({ connectionString: OWNER_URL, dir: resolve(process.cwd(), '../../packages/database/migrations') });
    api = await startApi();
    await resetIpRateLimits();
    database = createDatabase({ connectionString: APP_URL, max: 2, applicationName: 'liame-test' });
    empresas.push(await empresaComConta('Pizzaria Mídia A'), await empresaComConta('Pizzaria Mídia B'));
  });
  afterAll(async () => {
    await database?.close();
    await api?.close();
  });

  it('a primeira leitura grava tudo; a mesma leitura de novo não duplica; o passado reescrito vira observação nova', async () => {
    const [a] = empresas;
    const t1 = new Date('2026-09-20T10:00:00Z');
    const t2 = new Date('2026-09-21T10:00:00Z');
    const t3 = new Date('2026-09-22T10:00:00Z');

    const r1 = await withTenant(database.db, a!.tenantId, (tx) => gravarMetricas(tx, ctx(a!, t1), [...dia('2026-09-19', 3), ...dia('2026-09-19', 3)]));
    expect(r1).toEqual({ novas: 3, lidas: 3 });

    // Mesmos números no dia seguinte: nenhuma linha nova, só a hora da última leitura.
    const r2 = await withTenant(database.db, a!.tenantId, (tx) => gravarMetricas(tx, ctx(a!, t2), dia('2026-09-19', 3)));
    expect(r2).toEqual({ novas: 0, lidas: 3 });

    // A Meta atribuiu mais 2 conversões ao dia 19: só a chave que mudou ganha observação.
    const r3 = await withTenant(database.db, a!.tenantId, (tx) => gravarMetricas(tx, ctx(a!, t3), dia('2026-09-19', 5)));
    expect(r3).toEqual({ novas: 1, lidas: 3 });

    await withTenant(database.db, a!.tenantId, async (tx) => {
      const antes = await metricasEm(tx, a!.contaId, '2026-09-19', t2);
      const hoje = await metricasEm(tx, a!.contaId, '2026-09-19', t3);
      const valor = (linhas: typeof antes, nome: string) => linhas.find((l) => l.metric_name === nome)?.metric_value;
      expect(valor(antes, 'conversions')).toBe('3');
      expect(valor(hoje, 'conversions')).toBe('5');
      expect(valor(hoje, 'spend')).toBe('123.45');

      const ultimo = await tx.execute<{ metric_value: string; observed_at: Date; changed_at: Date }>(sql`
        select metric_value::text, observed_at, changed_at from liame.metric_latest
         where connected_account_id = ${a!.contaId} and metric_name = 'spend' and metric_date = '2026-09-19'`);
      expect(ultimo.rows[0]).toMatchObject({ metric_value: '123.45' });
      expect(new Date(ultimo.rows[0]!.observed_at).toISOString()).toBe(t3.toISOString());
      expect(new Date(ultimo.rows[0]!.changed_at).toISOString()).toBe(t1.toISOString());
    });
  });

  it('o histórico não se reescreve e uma empresa não vê nem toca as métricas da outra', async () => {
    const [a, b] = empresas;
    await withTenant(database.db, b!.tenantId, (tx) => gravarMetricas(tx, ctx(b!, new Date('2026-09-22T12:00:00Z')), dia('2026-09-21', 1)));

    // A aplicação não altera observação (só insere) e não apaga fora do expurgo.
    await expect(
      withTenant(database.db, a!.tenantId, (tx) => tx.execute(sql`update liame.metric_observation set metric_value = 0 where connected_account_id = ${a!.contaId}`)),
    ).rejects.toMatchObject({ cause: expect.objectContaining({ code: '42501' }) });
    const apagadas = await withTenant(database.db, a!.tenantId, (tx) =>
      tx.execute(sql`delete from liame.metric_latest where connected_account_id = ${a!.contaId}`),
    );
    expect(apagadas.rowCount).toBe(0);

    const vistas = await withTenant(database.db, a!.tenantId, (tx) =>
      tx.execute<{ n: string }>(sql`select count(*)::text as n from liame.metric_observation where connected_account_id = ${b!.contaId}`),
    );
    expect(vistas.rows[0]?.n).toBe('0');
    // Gravar com a conta de outra empresa é recusado pela RLS (tenant_id da linha ≠ contexto).
    await expect(
      withTenant(database.db, a!.tenantId, (tx) => gravarMetricas(tx, ctx(b!, new Date()), dia('2026-09-21', 9))),
    ).rejects.toMatchObject({ cause: expect.objectContaining({ code: '42501' }) });
  });
});
