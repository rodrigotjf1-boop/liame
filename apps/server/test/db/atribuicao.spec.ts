import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createDatabase, type Database, runMigrations, withTenant } from '@liame/database';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { atribuirPedidos, MODELO_PADRAO, pedidosDosToques } from '../../src/attribution/motor.js';
import { completarCliqueGoogle, gravarToques, inferirProvider, type ToqueLido } from '../../src/attribution/toque-store.js';
import { centavosParaMicros, type GrupoCanal, gravarPedidos, type PedidoLido } from '../../src/orders/order-store.js';
import { LifecyclePurgeService } from '../../src/worker/lifecycle-purge.service.js';
import { VaultService } from '../../src/vault/vault.service.js';
import { Mailer } from '../../src/mail/mailer.js';
import { ownerQuery, resetIpRateLimits, signupAndLogin, startApi, type TestApi } from '../helpers/api.js';
import { APP_URL, hasDb, OWNER_URL } from './env.js';

// A2.5 · F2: atribuição determinística (ADR-020). Os casos de referência (critério A2.5-3) ficam num
// arquivo versionado e rodam contra o motor real no banco: mudar a regra sem atualizar os casos reprova.

type ToqueCaso = {
  tipo: 'clique' | 'conversa';
  horas_antes: number;
  cliente?: string;
  fbclid?: string;
  gclid?: string;
  gbraid?: string;
  ctwa_clid?: string;
  campaign_id?: string;
  adgroup_id?: string;
  ad_id?: string;
  lk?: string;
  utm_source?: string;
  utm_campaign?: string;
};
type Caso = {
  caso: string;
  pedido: { grupo: GrupoCanal; canal?: string; status?: 'confirmado' | 'cancelado'; cupom?: string; cliente?: string };
  cupons?: { codigo: string; campanha: string; exclusivo: boolean; ligado_horas_antes: number; desligado_horas_antes?: number }[];
  toques?: ToqueCaso[];
  esperado: {
    status: 'atribuido' | 'plataforma' | 'sem_origem';
    evidencia?: string;
    campanha?: string;
    provider?: string;
    confianca?: string;
    conta: boolean;
    motivo?: string;
    anuncio?: string;
  };
};

const CASOS = (JSON.parse(readFileSync(resolve(import.meta.dirname, '../fixtures/atribuicao/casos-ultimo-toque-v1.json'), 'utf8')) as { casos: Caso[] }).casos;
const T0 = new Date('2026-09-20T20:00:00Z');
const horasAntes = (h: number) => new Date(T0.getTime() - h * 3_600_000).toISOString();
const indice = (texto: string) => createHash('sha256').update(texto).digest('hex');

describe.skipIf(!hasDb)('atribuição determinística (ADR-020)', () => {
  let api: TestApi;
  let database: Database;
  let tenantId = '';
  let brandId = '';
  let loja = '';
  let regemcast = '';
  const campanhas: Record<string, string> = {};
  const anuncios: Record<string, string> = {};
  const pedidos = new Map<string, string>();

  const pedidoDoCaso = (c: Caso, over: Partial<PedidoLido> = {}): PedidoLido => ({
    externalId: c.caso,
    channel: c.pedido.canal ?? (c.pedido.grupo === 'whatsapp' ? 'whatsapp_bot' : 'cardapio_online'),
    channelGroup: c.pedido.grupo,
    status: c.pedido.status ?? 'confirmado',
    currency: 'BRL',
    timezone: 'America/Sao_Paulo',
    revenueMicros: centavosParaMicros(8990),
    discountMicros: 0n,
    refundedMicros: 0n,
    couponCode: c.pedido.cupom ?? null,
    customer: c.pedido.cliente ? { phoneIndex: indice(`${c.caso}:${c.pedido.cliente}`), externalId: null } : null,
    isNewCustomer: null,
    placedAt: null,
    confirmedAt: T0.toISOString(),
    cancelledAt: c.pedido.status === 'cancelado' ? T0.toISOString() : null,
    version: 1n,
    sourceUpdatedAt: T0.toISOString(),
    items: [],
    ...over,
  });

  const toqueDoCaso = (c: Caso, t: ToqueCaso, i: number): ToqueLido => ({
    externalId: `${c.caso}-${i}`,
    kind: t.tipo,
    occurredAt: horasAntes(t.horas_antes),
    orderExternalId: t.tipo === 'clique' ? c.caso : null,
    customerPhoneIndex: t.tipo === 'conversa' && t.cliente ? indice(`${c.caso}:${t.cliente}`) : null,
    linkCode: t.lk ?? null,
    campaignExternalId: t.campaign_id ?? null,
    adGroupExternalId: t.adgroup_id ?? null,
    adExternalId: t.ad_id ?? null,
    gclid: t.gclid ?? null,
    gbraid: t.gbraid ?? null,
    fbclid: t.fbclid ?? null,
    ctwaClid: t.ctwa_clid ?? null,
    utm: { source: t.utm_source ?? null, campaign: t.utm_campaign ?? null },
  });

  async function conta(provider: string, nome: string): Promise<string> {
    const id = randomUUID();
    await ownerQuery(
      `insert into liame.connected_account (id, tenant_id, brand_id, provider, external_id, name, currency, timezone)
       values ($1, $2, $3, $4, $5, $6, 'BRL', 'America/Sao_Paulo')`,
      [id, tenantId, brandId, provider, randomUUID(), nome],
    );
    return id;
  }

  async function catalogo(contaId: string, provider: string, campanha: { ref: string; ext: string; grupo?: string; anuncio?: string }) {
    const cId = randomUUID();
    await ownerQuery(
      `insert into liame.campaign (id, tenant_id, connected_account_id, provider, external_id, name, status) values ($1, $2, $3, $4, $5, $6, 'ativa')`,
      [cId, tenantId, contaId, provider, campanha.ext, campanha.ref],
    );
    campanhas[campanha.ref] = cId;
    if (campanha.grupo) {
      const gId = randomUUID();
      await ownerQuery(
        `insert into liame.ad_group (id, tenant_id, connected_account_id, campaign_id, provider, external_id, name, status) values ($1, $2, $3, $4, $5, $6, 'grupo', 'ativa')`,
        [gId, tenantId, contaId, cId, provider, campanha.grupo],
      );
      if (campanha.anuncio) {
        const aId = randomUUID();
        await ownerQuery(
          `insert into liame.ad (id, tenant_id, connected_account_id, ad_group_id, provider, external_id, name, status) values ($1, $2, $3, $4, $5, $6, 'anúncio', 'ativa')`,
          [aId, tenantId, contaId, gId, provider, campanha.anuncio],
        );
        anuncios[campanha.anuncio] = aId;
      }
    }
  }

  const resultados = () =>
    ownerQuery<{
      external_id: string;
      status: string;
      evidence: string | null;
      campaign_id: string | null;
      ad_id: string | null;
      provider: string | null;
      confidence: string | null;
      counted: boolean;
      reason: string | null;
      window_days: number;
    }>(
      `select o.external_id, r.status, r.evidence, r.campaign_id, r.ad_id, r.provider, r.confidence, r.counted, r.reason, r.window_days
         from liame.attribution_result r join liame.order_fact o on o.id = r.order_id
        where r.tenant_id = $1 and r.model_id = $2 order by o.external_id`,
      [tenantId, MODELO_PADRAO],
    );

  beforeAll(async () => {
    await runMigrations({ connectionString: OWNER_URL, dir: resolve(process.cwd(), '../../packages/database/migrations') });
    api = await startApi();
    await resetIpRateLimits();
    database = createDatabase({ connectionString: APP_URL, max: 2, applicationName: 'liame-test' });
    const s = await signupAndLogin(api, undefined, 'Hamburgueria Atribuição');
    tenantId = s.me.active_organization_id as string;
    brandId = (await ownerQuery<{ id: string }>(`select id from liame.brand where tenant_id = $1 limit 1`, [tenantId]))[0]!.id;

    loja = await conta('regem', 'Loja Centro (Regem)');
    regemcast = await conta('regemcast', 'WhatsApp da loja (RegemCast)');
    const meta = await conta('meta_ads', 'CA - Hamburgueria');
    const google = await conta('google_ads', 'Google Ads da Hamburgueria');
    await catalogo(meta, 'meta_ads', { ref: 'C_META_1', ext: '120001', grupo: '230001', anuncio: '340001' });
    await catalogo(meta, 'meta_ads', { ref: 'C_META_2', ext: '120002' });
    await catalogo(google, 'google_ads', { ref: 'C_GOOG_1', ext: '9001', grupo: '9101', anuncio: '9201' });
    await ownerQuery(
      `insert into liame.tracking_link (id, tenant_id, brand_id, code, name, provider, campaign_id, destination_url, utm_source, utm_medium)
       values ($1, $2, $3, 'LKGOOG9001', 'Busca · cardápio', 'google_ads', $4, 'https://cardapio.exemplo.com.br/loja', 'google', 'cpc')`,
      [randomUUID(), tenantId, brandId, campanhas.C_GOOG_1],
    );

    for (const c of CASOS) {
      for (const cupom of c.cupons ?? []) {
        const couponId = randomUUID();
        await ownerQuery(
          `insert into liame.coupon (id, tenant_id, brand_id, connected_account_id, external_id, code, kind, percent, active, source_version, source_updated_at)
           values ($1, $2, $3, $4, $5, $6, 'percentual', 10, true, 1, now())`,
          [couponId, tenantId, brandId, loja, `${c.caso}-${cupom.codigo}`, cupom.codigo],
        );
        await ownerQuery(
          `insert into liame.campaign_coupon (id, tenant_id, brand_id, coupon_id, campaign_id, exclusive, linked_at, unlinked_at)
           values ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [
            randomUUID(),
            tenantId,
            brandId,
            couponId,
            campanhas[cupom.campanha],
            cupom.exclusivo,
            horasAntes(cupom.ligado_horas_antes),
            cupom.desligado_horas_antes === undefined ? null : horasAntes(cupom.desligado_horas_antes),
          ],
        );
      }
    }

    await withTenant(database.db, tenantId, async (tx) => {
      const ctx = { tenantId, brandId, unitId: null, connectedAccountId: loja, provider: 'regem' };
      const r = await gravarPedidos(tx, ctx, CASOS.map((c) => pedidoDoCaso(c)));
      for (const a of r.alterados) pedidos.set(a.externalId, a.id);
      const cliques = CASOS.flatMap((c) => (c.toques ?? []).map((t, i) => [t, toqueDoCaso(c, t, i)] as const)).filter(([t]) => t.tipo === 'clique');
      const conversas = CASOS.flatMap((c) => (c.toques ?? []).map((t, i) => [t, toqueDoCaso(c, t, i)] as const)).filter(([t]) => t.tipo === 'conversa');
      await gravarToques(tx, { tenantId, brandId, connectedAccountId: loja }, cliques.map(([, t]) => t));
      await gravarToques(tx, { tenantId, brandId, connectedAccountId: regemcast }, conversas.map(([, t]) => t));
    });
  });
  afterAll(async () => {
    await database?.close();
    await api?.close();
  });

  it('os casos de referência dão o resultado esperado', async () => {
    const resumo = await withTenant(database.db, tenantId, (tx) => atribuirPedidos(tx, { tenantId, orderIds: [...pedidos.values()], gatilho: 'pedidos' }));
    expect(resumo.considerados).toBe(CASOS.length);

    const porPedido = new Map((await resultados()).map((r) => [r.external_id, r]));
    const nomeDaCampanha = Object.fromEntries(Object.entries(campanhas).map(([ref, id]) => [id, ref]));
    for (const c of CASOS) {
      const r = porPedido.get(c.caso);
      const obtido = {
        caso: c.caso,
        status: r?.status,
        evidencia: r?.evidence ?? undefined,
        campanha: r?.campaign_id ? nomeDaCampanha[r.campaign_id] : undefined,
        provider: r?.provider ?? undefined,
        confianca: r?.confidence ?? undefined,
        conta: r?.counted,
        motivo: r?.reason ?? undefined,
      };
      const { anuncio, ...esperado } = c.esperado;
      expect(obtido).toEqual({ caso: c.caso, ...esperado });
      if (anuncio) expect(r?.ad_id).toBe(anuncios[anuncio]);
      expect(r?.window_days).toBe(7);
    }
  });

  it('a mesma entrada dá o mesmo resultado: rodar de novo não duplica nem muda nada', async () => {
    const antes = await resultados();
    await withTenant(database.db, tenantId, (tx) => atribuirPedidos(tx, { tenantId, orderIds: [...pedidos.values()], gatilho: 'manual' }));
    expect(await resultados()).toEqual(antes);
    const [n] = await ownerQuery<{ n: string }>(`select count(*)::text as n from liame.attribution_result where tenant_id = $1`, [tenantId]);
    expect(Number(n?.n)).toBe(CASOS.length);
    const runs = await ownerQuery<{ trigger: string; orders_considered: number; finished: boolean }>(
      `select trigger, orders_considered, finished_at is not null as finished from liame.attribution_run where tenant_id = $1 order by started_at`,
      [tenantId],
    );
    expect(runs).toEqual([
      { trigger: 'pedidos', orders_considered: CASOS.length, finished: true },
      { trigger: 'manual', orders_considered: CASOS.length, finished: true },
    ]);
  });

  it('cancelamento depois recalcula: o pedido sai da conta', async () => {
    const caso = CASOS.find((c) => c.caso === 'clique_com_campanha')!;
    await withTenant(database.db, tenantId, async (tx) => {
      const r = await gravarPedidos(tx, { tenantId, brandId, unitId: null, connectedAccountId: loja, provider: 'regem' }, [
        pedidoDoCaso(caso, { status: 'cancelado', cancelledAt: new Date(T0.getTime() + 3_600_000).toISOString(), version: 2n }),
      ]);
      await atribuirPedidos(tx, { tenantId, orderIds: r.alterados.map((a) => a.id), gatilho: 'pedidos' });
    });
    const r = (await resultados()).find((x) => x.external_id === 'clique_com_campanha');
    expect(r).toMatchObject({ status: 'atribuido', counted: false, reason: 'cancelado' });
  });

  it('o gclid resolvido depois pela API do Google vira campanha, com a proveniência do Google', async () => {
    const caso: Caso = { caso: 'gclid_resolvido_depois', pedido: { grupo: 'cardapio' }, esperado: { status: 'atribuido', conta: true } };
    const toque: ToqueCaso = { tipo: 'clique', horas_antes: 8, gclid: 'Cj0gclidresolvido' };
    const touchpointId = await withTenant(database.db, tenantId, async (tx) => {
      const r = await gravarPedidos(tx, { tenantId, brandId, unitId: null, connectedAccountId: loja, provider: 'regem' }, [pedidoDoCaso(caso)]);
      pedidos.set(caso.caso, r.alterados[0]!.id);
      const t = await gravarToques(tx, { tenantId, brandId, connectedAccountId: loja }, [toqueDoCaso(caso, toque, 0)]);
      await atribuirPedidos(tx, { tenantId, orderIds: [r.alterados[0]!.id], gatilho: 'pedidos' });
      return t.alterados[0]!;
    });
    expect((await resultados()).find((x) => x.external_id === caso.caso)).toMatchObject({ status: 'plataforma', provider: 'google_ads' });

    await withTenant(database.db, tenantId, async (tx) => {
      expect(await completarCliqueGoogle(tx, [{ touchpointId, campaignExternalId: '9001', adGroupExternalId: '9101', adExternalId: '9201' }])).toBe(1);
      const afetados = await pedidosDosToques(tx, tenantId, [touchpointId]);
      expect(afetados).toEqual([pedidos.get(caso.caso)]);
      await atribuirPedidos(tx, { tenantId, orderIds: afetados, gatilho: 'toques' });
    });
    const r = (await resultados()).find((x) => x.external_id === caso.caso);
    expect(r).toMatchObject({ status: 'atribuido', evidence: 'clique_campanha', campaign_id: campanhas.C_GOOG_1, ad_id: anuncios['9201'] });
    const [t] = await ownerQuery<{ provenance: Record<string, string> }>(`select provenance from liame.touchpoint where id = $1`, [touchpointId]);
    expect(t?.provenance).toEqual({ gclid: 'url', campaign_external_id: 'google_ads', ad_group_external_id: 'google_ads', ad_external_id: 'google_ads' });
  });

  it('a conversa nova acha os pedidos do mesmo cliente dentro da janela', async () => {
    const caso = CASOS.find((c) => c.caso === 'conversa_por_anuncio')!;
    const [t] = await ownerQuery<{ id: string }>(`select id from liame.touchpoint where external_id = $1 and tenant_id = $2`, [`${caso.caso}-0`, tenantId]);
    const afetados = await withTenant(database.db, tenantId, (tx) => pedidosDosToques(tx, tenantId, [t!.id]));
    expect(afetados).toEqual([pedidos.get(caso.caso)]);
  });

  it('a plataforma do clique sai dos ids, nunca do nome solto no UTM', () => {
    const base: ToqueLido = { externalId: 'x', kind: 'clique', occurredAt: T0.toISOString() };
    expect(inferirProvider({ ...base, fbclid: 'IwAR' })).toBe('meta_ads');
    expect(inferirProvider({ ...base, wbraid: 'x' })).toBe('google_ads');
    expect(inferirProvider({ ...base, utm: { source: 'facebook' } })).toBeNull();
    expect(inferirProvider({ ...base, utm: { source: 'ig' }, adExternalId: '1' })).toBe('meta_ads');
    expect(inferirProvider({ ...base, utm: { source: 'google' }, campaignExternalId: '9' })).toBe('google_ads');
  });

  it('toque com mais de 90 dias sai no expurgo (ids de clique são dado pessoal)', async () => {
    await withTenant(database.db, tenantId, (tx) =>
      gravarToques(tx, { tenantId, brandId, connectedAccountId: loja }, [
        { externalId: 'sem_nada-velho', kind: 'clique', occurredAt: new Date(Date.now() - 91 * 86_400_000).toISOString(), orderExternalId: 'sem_nada', fbclid: 'IwARvelho' },
      ]),
    );
    const purge = new LifecyclePurgeService(database, api.app.get(VaultService), api.app.get(Mailer));
    const contagem = await purge.purgeRetention({ tenantIds: [tenantId] });
    expect(contagem.toque).toBe(1);
    const [n] = await ownerQuery<{ n: string }>(`select count(*)::text as n from liame.touchpoint where tenant_id = $1 and external_id = 'sem_nada-velho'`, [tenantId]);
    expect(n?.n).toBe('0');
  });

  it('o modelo não se altera: a empresa não grava nem muda o modelo da distribuição', async () => {
    const tentativa = withTenant(database.db, tenantId, (tx) =>
      tx.execute(sql`update liame.attribution_model set window_days = 30 where id = ${MODELO_PADRAO}`),
    );
    await expect(tentativa).rejects.toThrow();
    const [m] = await ownerQuery<{ window_days: number }>(`select window_days from liame.attribution_model where id = $1`, [MODELO_PADRAO]);
    expect(m?.window_days).toBe(7);
  });
});
