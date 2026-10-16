import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { runMigrations } from '@liame/database';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hojeNoFuso } from '../../src/media/sincronizador.js';
import { enableMfa, ownerQuery, resetIpRateLimits, signupAndLogin, startApi, type TestApi } from '../helpers/api.js';
import { ligarFlagDaEmpresa } from '../helpers/meta-de-mentira.js';
import { hasDb, OWNER_URL } from './env.js';

// Como os anúncios rodaram (P23): o que a Meta e o Google informam por campanha e o "Ler agora". O alcance do período
// vem do número que a Meta devolve para a faixa inteira, nunca da soma do alcance de cada dia.

const FUSO = 'America/Sao_Paulo';
const DIA_MS = 86_400_000;
const menos = (dia: string, n: number) => new Date(new Date(`${dia}T00:00:00Z`).getTime() - n * DIA_MS).toISOString().slice(0, 10);
const HOJE = hojeNoFuso(new Date(), FUSO);
const ONTEM = menos(HOJE, 1);
const SETE = { from: menos(HOJE, 7), to: ONTEM };
const REAL = 1_000_000;

describe.skipIf(!hasDb)('como os anúncios rodaram (P23)', () => {
  let api: TestApi;
  let cookie = '';
  let tenantId = '';
  let brandId = '';
  const ids = { meta: randomUUID(), google: randomUUID(), campMeta: randomUUID(), grupo: randomUUID(), anuncio: randomUUID(), campGoogle: randomUUID() };

  /** Um número gravado como a leitura diária grava (o último valor por chave). */
  async function numero(conta: string, provider: string, nivel: string, externo: string, entidade: string | null, dia: string, nome: string, valor: number, janela = '') {
    await ownerQuery(
      `insert into liame.metric_latest (connected_account_id, level, external_entity_id, metric_date, metric_name, attribution_window, tenant_id, brand_id, provider, entity_id, metric_value, currency, timezone, observed_at, changed_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'BRL', $12, now(), now())
       on conflict (connected_account_id, level, external_entity_id, metric_date, metric_name, attribution_window) do update set metric_value = excluded.metric_value`,
      [conta, nivel, externo, dia, nome, janela, tenantId, brandId, provider, entidade, valor, FUSO],
    );
  }

  beforeAll(async () => {
    await runMigrations({ connectionString: OWNER_URL, dir: resolve(process.cwd(), '../../packages/database/migrations') });
    api = await startApi();
    await resetIpRateLimits();
    const s = await signupAndLogin(api, undefined, 'Mister Burgers Desempenho');
    await enableMfa(api, s.cookie);
    cookie = s.cookie;
    tenantId = s.me.active_organization_id as string;
    brandId = (await ownerQuery<{ id: string }>(`select id from liame.brand where tenant_id = $1 limit 1`, [tenantId]))[0]!.id;

    await ownerQuery(
      `insert into liame.connected_account (id, tenant_id, brand_id, provider, external_id, name, currency, timezone) values
         ($1, $3, $4, 'meta_ads', 'act_7700000001', 'CA - Mister Burguer', 'BRL', $5),
         ($2, $3, $4, 'google_ads', '7700000002', 'Mister Burguer Steakhouse', 'BRL', $5)`,
      [ids.meta, ids.google, tenantId, brandId, FUSO],
    );
    await ownerQuery(
      `insert into liame.campaign (id, tenant_id, connected_account_id, provider, external_id, name, status, objective) values
         ($1, $3, $4, 'meta_ads', '120330000000000001', 'Combo sexta', 'ativa', 'OUTCOME_SALES'),
         ($2, $3, $5, 'google_ads', '7700000099', 'Busca hambúrguer perto', 'ativa', 'SEARCH')`,
      [ids.campMeta, ids.campGoogle, tenantId, ids.meta, ids.google],
    );
    await ownerQuery(`insert into liame.ad_group (id, tenant_id, connected_account_id, campaign_id, provider, external_id, name, status) values ($1, $2, $3, $4, 'meta_ads', '120330000000000101', 'Conjunto', 'ativa')`, [
      ids.grupo,
      tenantId,
      ids.meta,
      ids.campMeta,
    ]);
    await ownerQuery(`insert into liame.ad (id, tenant_id, connected_account_id, ad_group_id, provider, external_id, name, status) values ($1, $2, $3, $4, 'meta_ads', '120330000000001001', 'Anúncio', 'ativa')`, [
      ids.anuncio,
      tenantId,
      ids.meta,
      ids.grupo,
    ]);
    // Os 7 dias completos até ontem e o dia de hoje até agora, como a leitura diária grava.
    for (let d = 0; d <= 7; d++) {
      const dia = menos(HOJE, d);
      const parte = d === 0 ? 0.25 : 1;
      await numero(ids.meta, 'meta_ads', 'ad', '120330000000001001', ids.anuncio, dia, 'spend', 10 * parte);
      await numero(ids.meta, 'meta_ads', 'ad', '120330000000001001', ids.anuncio, dia, 'impressions', 1000 * parte);
      await numero(ids.meta, 'meta_ads', 'ad', '120330000000001001', ids.anuncio, dia, 'clicks', 30 * parte);
      await numero(ids.meta, 'meta_ads', 'ad', '120330000000001001', ids.anuncio, dia, 'link_clicks', 20 * parte);
      // O alcance de cada dia: somado daria 5.600 em 7 dias, e não é o que a tela mostra.
      await numero(ids.meta, 'meta_ads', 'ad', '120330000000001001', ids.anuncio, dia, 'reach', 800 * parte);
      await numero(ids.meta, 'meta_ads', 'ad', '120330000000001001', ids.anuncio, dia, 'purchases', d === 0 ? 0 : 1, '7d_click');
      await numero(ids.meta, 'meta_ads', 'ad', '120330000000001001', ids.anuncio, dia, 'purchases', 3, 'padrao');
      await numero(ids.google, 'google_ads', 'campaign', '7700000099', ids.campGoogle, dia, 'spend', 5 * parte);
      await numero(ids.google, 'google_ads', 'campaign', '7700000099', ids.campGoogle, dia, 'impressions', 200 * parte);
      await numero(ids.google, 'google_ads', 'campaign', '7700000099', ids.campGoogle, dia, 'clicks', 12 * parte);
      await numero(ids.google, 'google_ads', 'campaign', '7700000099', ids.campGoogle, dia, 'conversions', 0.5, 'padrao');
    }
    // O alcance do período, como a Meta devolve (um número para a faixa): o de 7 dias termina ontem; o do dia, hoje.
    await numero(ids.meta, 'meta_ads', 'campaign', '120330000000000001', ids.campMeta, ONTEM, 'reach_7d', 4500);
    await numero(ids.meta, 'meta_ads', 'account', 'act_7700000001', null, ONTEM, 'reach_7d', 5200);
    await numero(ids.meta, 'meta_ads', 'campaign', '120330000000000001', ids.campMeta, HOJE, 'reach_dia', 610);
    await numero(ids.meta, 'meta_ads', 'account', 'act_7700000001', null, HOJE, 'reach_dia', 700);
    // A leitura de todo dia: feita hoje às 6h, a próxima amanhã.
    for (const conta of [ids.meta, ids.google]) {
      await ownerQuery(
        `insert into liame.sync_state (connected_account_id, dataset, tenant_id, expected_every_minutes, last_success_at, last_attempt_at, cursor)
         values ($1, 'metricas', $2, 1440, now() - interval '3 hours', now() - interval '3 hours', jsonb_build_object('proxima', (now() + interval '21 hours')::text))`,
        [conta, tenantId],
      );
    }
  }, 120_000);
  afterAll(async () => {
    await api?.close();
  });

  const ler = (periodo: { from: string; to: string }, quem = cookie) => api.call('GET', `/v1/results/delivery?brand_id=${brandId}&from=${periodo.from}&to=${periodo.to}`, { cookie: quem });
  const lerAgora = () => api.call('POST', '/v1/results/delivery/refresh', { cookie, body: { brand_id: brandId } });

  it('com a função desligada: nada vem, e "Ler agora" diz que a função está desligada', async () => {
    const r = await ler(SETE);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ enabled: false, campaigns: [], accounts: [], refresh: { available: false, next_at: null } });
    const pedido = await lerAgora();
    expect(pedido.status, JSON.stringify(pedido.body)).toBe(409);
    expect(pedido.body.code).toBe('funcao-desligada');
  });

  it('7 dias: por campanha, o que a plataforma informa; o alcance é o da faixa, não a soma dos dias; o gasto bate com closed-loop', async () => {
    await ligarFlagDaEmpresa(api, 'desempenho_anuncios', tenantId, true);
    const r = await ler(SETE);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.enabled).toBe(true);
    expect(r.body.campaigns).toEqual([
      {
        campaign_id: ids.campMeta,
        provider: 'meta_ads',
        name: 'Combo sexta',
        status: 'ativa',
        objective: 'OUTCOME_SALES',
        impressions: '7000',
        reach: '4500',
        clicks: '210',
        link_clicks: '140',
        spend_micros: String(70 * REAL),
        result: { kind: 'purchases', value: '7', window: '7d_click' },
      },
      {
        campaign_id: ids.campGoogle,
        provider: 'google_ads',
        name: 'Busca hambúrguer perto',
        status: 'ativa',
        objective: 'SEARCH',
        impressions: '1400',
        reach: null,
        clicks: '84',
        link_clicks: null,
        spend_micros: String(35 * REAL),
        result: { kind: 'conversions', value: '3.5', window: 'padrao' },
      },
    ]);
    expect(r.body.totals).toEqual({ impressions: '8400', clicks: '294', spend_micros: String(105 * REAL), meta_reach: '5200' });
    expect(r.body.accounts.map((a: { provider: string; last_success_at: string | null }) => [a.provider, a.last_success_at !== null])).toEqual([
      ['google_ads', true],
      ['meta_ads', true],
    ]);
    expect(r.body.refresh).toEqual({ available: true, next_at: null });

    // Os dois cartões de Resultados mostram o mesmo gasto.
    const ciclo = await api.call('GET', `/v1/results/closed-loop?brand_id=${brandId}&from=${SETE.from}&to=${SETE.to}`, { cookie });
    expect(ciclo.status, JSON.stringify(ciclo.body)).toBe(200);
    expect(ciclo.body.totals.spend_micros).toBe(r.body.totals.spend_micros);
  });

  it('hoje: o alcance do dia; outro período sem faixa lida: alcance nulo (nunca a soma de cada dia)', async () => {
    const hoje = await ler({ from: HOJE, to: HOJE });
    expect(hoje.status).toBe(200);
    expect(hoje.body.campaigns.find((c: { provider: string }) => c.provider === 'meta_ads')).toMatchObject({ impressions: '250', reach: '610', clicks: '8' });
    expect(hoje.body.totals.meta_reach).toBe('700');

    const dez = await ler({ from: menos(HOJE, 10), to: ONTEM });
    expect(dez.status).toBe(200);
    expect(dez.body.campaigns.find((c: { provider: string }) => c.provider === 'meta_ads').reach).toBeNull();
    expect(dez.body.totals.meta_reach).toBeNull();

    expect((await ler({ from: ONTEM, to: menos(HOJE, 3) })).status).toBe(422);
  });

  it('"Ler agora": adianta a leitura das duas contas; a conta que já está sendo lida fica como está; uma vez por janela de 15 minutos', async () => {
    // A conta do Google com uma leitura em andamento: o worker não a pega de novo.
    await ownerQuery(`insert into liame.sync_run (id, tenant_id, connected_account_id, dataset, kind, status) values ($1, $2, $3, 'metricas', 'incremental', 'rodando')`, [
      randomUUID(),
      tenantId,
      ids.google,
    ]);
    // Janela fixa: a vez pode cair na janela seguinte; tenta até ver o bloqueio (V70).
    let primeira: Awaited<ReturnType<typeof lerAgora>> | null = null;
    let bloqueio: Awaited<ReturnType<typeof lerAgora>> | null = null;
    for (let i = 0; i < 3 && !bloqueio; i++) {
      const p = await lerAgora();
      if (p.status === 202) primeira ??= p;
      else bloqueio = p;
    }
    expect(primeira?.status, JSON.stringify(primeira?.body)).toBe(202);
    expect(primeira!.body).toMatchObject({ accounts: 2 });
    expect(Date.parse(primeira!.body.next_at)).toBeGreaterThan(Date.parse(primeira!.body.requested_at));
    expect(bloqueio?.status, JSON.stringify(bloqueio?.body)).toBe(429);
    expect(bloqueio!.body.code).toBe('leitura-recente');
    expect(Number(bloqueio!.headers.get('retry-after'))).toBeGreaterThan(0);

    const estado = await ownerQuery<{ connected_account_id: string; proxima: string }>(
      `select connected_account_id, cursor->>'proxima' as proxima from liame.sync_state where connected_account_id in ($1, $2) and dataset = 'metricas'`,
      [ids.meta, ids.google],
    );
    const proxima = new Map(estado.map((e) => [e.connected_account_id, Date.parse(e.proxima)]));
    expect(proxima.get(ids.meta)).toBeLessThanOrEqual(Date.now());
    expect(proxima.get(ids.google)).toBeGreaterThan(Date.now() + 20 * 3_600_000);

    // A tela sabe que a vez foi usada nesta janela.
    const r = await ler(SETE);
    expect(r.body.refresh.available).toBe(false);
    expect(Date.parse(r.body.refresh.next_at)).toBeGreaterThan(Date.now());

    const auditoria = await ownerQuery<{ n: string }>(`select count(*) as n from liame.audit_event where tenant_id = $1 and action = 'resultados.ler_agora'`, [tenantId]);
    expect(Number(auditoria[0]!.n)).toBeGreaterThanOrEqual(1);
  });

  it('outra empresa não lê a marca desta nem pede a leitura dela', async () => {
    const outra = await signupAndLogin(api, undefined, 'Outra Hamburgueria');
    await enableMfa(api, outra.cookie);
    expect((await ler(SETE, outra.cookie)).status).toBe(404);
    const pedido = await api.call('POST', '/v1/results/delivery/refresh', { cookie: outra.cookie, body: { brand_id: brandId } });
    expect(pedido.status).toBe(404);
  });
});
