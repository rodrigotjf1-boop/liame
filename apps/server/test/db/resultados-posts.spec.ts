import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { createDatabase, type Database, runMigrations, withTenant } from '@liame/database';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { atribuirPedidos } from '../../src/attribution/motor.js';
import { gravarToques } from '../../src/attribution/toque-store.js';
import { centavosParaMicros, gravarPedidos, type PedidoLido } from '../../src/orders/order-store.js';
import { enableMfa, ownerQuery, resetIpRateLimits, signupAndLogin, startApi, type TestApi } from '../helpers/api.js';
import { ligarFlagDaEmpresa } from '../helpers/meta-de-mentira.js';
import { APP_URL, hasDb, OWNER_URL } from './env.js';

// A6 · Z7, parte b: o que cada post trouxe, em Resultados (D-A6-49; protótipo P32, aprovado em 01/11/2026). O pedido se
// liga ao post só pelo código do link dele. Sem prova de anúncio, a origem é o post: ele sai de "sem origem" e conta nos
// posts; com prova, fica com o anúncio (D-A6-48) e só é contado à parte. O clique fora da janela não é do post.

const M = (reais: number) => (BigInt(Math.round(reais * 100)) * 10_000n).toString();

type Totais = {
  orders_confirmed: number;
  confirmed: { orders: number; revenue_micros: string };
  without_origin: { orders: number; revenue_micros: string };
  cancelled: { orders: number };
  posts?: {
    orders: number;
    revenue_micros: string;
    with_ad_orders: number;
    published_posts: number;
    posts: { post_id: string; kind: string; channel: string; published_at: string; orders: number; revenue_micros: string }[];
  };
};
type Item = {
  external_id: string;
  attribution: { status: string; counted: boolean; reason: string | null };
  post?: { id: string; kind: string; channel: string; published_at: string | null; link_code: string; touch_at: string } | null;
};

describe.skipIf(!hasDb)('o que cada post trouxe, em Resultados (A6 · Z7, parte b; P32)', () => {
  let api: TestApi;
  let database: Database;
  let cookie = '';
  let tenantId = '';
  let brandId = '';
  let unitId = '';
  let outraLojaId = '';
  const postA = randomUUID();
  const postB = randomUUID();
  const postC = randomUUID();
  const postD = randomUUID();

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
    items: [{ externalId: 'a', name: 'Item a', quantity: '1', revenueMicros: centavosParaMicros(1000), costMicros: centavosParaMicros(400) }],
    ...over,
  });

  async function conta(provider: string, nome: string, loja: string | null) {
    const id = randomUUID();
    await ownerQuery(
      `insert into liame.connected_account (id, tenant_id, brand_id, unit_id, provider, external_id, name, currency, timezone)
       values ($1, $2, $3, $4, $5, $6, $7, 'BRL', 'America/Sao_Paulo')`,
      [id, tenantId, brandId, loja, provider, randomUUID(), nome],
    );
    return id;
  }

  /** Um post com o link só dele, publicado na rede do link (a Página ou o TikTok do pacote) na hora dada. */
  async function postComLink(id: string, o: { kind: 'post' | 'pacote'; canal: 'facebook' | 'tiktok'; codigo: string; publicadoEm: string; loja: string }) {
    await ownerQuery(`insert into liame.social_post (id, tenant_id, brand_id, kind, photo_sha256, publish_at) values ($1, $2, $3, $4, $5, $6)`, [
      id,
      tenantId,
      brandId,
      o.kind,
      'a'.repeat(64),
      o.publicadoEm,
    ]);
    await ownerQuery(
      `insert into liame.social_post_channel (id, tenant_id, post_id, channel, body, status, external_id, published_at) values ($1, $2, $3, $4, 'Sexta tem combo.', 'publicado', $5, $6)`,
      [randomUUID(), tenantId, id, o.canal, o.canal === 'facebook' ? `1020_${o.codigo}` : null, o.publicadoEm],
    );
    await ownerQuery(
      `insert into liame.tracking_link (id, tenant_id, brand_id, unit_id, code, name, provider, kind, post_id, destination_url, utm_source, utm_medium, utm_campaign)
       values ($1, $2, $3, $4, $5, 'Post', $6, 'post', $7, 'https://cardapio.exemplo.com.br/loja', $6, 'social', 'post')`,
      [randomUUID(), tenantId, brandId, o.loja, o.codigo, o.canal, id],
    );
  }

  beforeAll(async () => {
    await runMigrations({ connectionString: OWNER_URL, dir: resolve(process.cwd(), '../../packages/database/migrations') });
    api = await startApi();
    await resetIpRateLimits();
    database = createDatabase({ connectionString: APP_URL, max: 2, applicationName: 'liame-test' });
    const s = await signupAndLogin(api, undefined, 'Mister Burgers Posts em Resultados');
    await enableMfa(api, s.cookie);
    cookie = s.cookie;
    tenantId = s.me.active_organization_id as string;
    brandId = (await ownerQuery<{ id: string }>(`select id from liame.brand where tenant_id = $1 limit 1`, [tenantId]))[0]!.id;
    unitId = randomUUID();
    outraLojaId = randomUUID();
    await ownerQuery(`insert into liame.unit (id, tenant_id, brand_id, name, timezone) values ($1, $2, $3, 'Loja Centro', 'America/Sao_Paulo'), ($4, $2, $3, 'Loja Lapa', 'America/Sao_Paulo')`, [unitId, tenantId, brandId, outraLojaId]);

    const meta = await conta('meta_ads', 'CA - Mister', null);
    await ownerQuery(`insert into liame.campaign (id, tenant_id, connected_account_id, provider, external_id, name, status) values ($1, $2, $3, 'meta_ads', '1201', 'Combo sexta', 'ativa')`, [randomUUID(), tenantId, meta]);
    const loja = await conta('regem', 'Loja Centro (Regem)', unitId);

    // A: o post de sexta na Página (25/09, 19h de Brasília); B: o pacote de sábado no TikTok; C: um post de domingo sem
    // pedido; D: um post de antes do período (10/09).
    await postComLink(postA, { kind: 'post', canal: 'facebook', codigo: 'LKPOSTFB01', publicadoEm: '2026-09-25T22:00:00Z', loja: unitId });
    await postComLink(postB, { kind: 'pacote', canal: 'tiktok', codigo: 'LKPOSTTT02', publicadoEm: '2026-09-26T15:00:00Z', loja: unitId });
    await postComLink(postC, { kind: 'post', canal: 'facebook', codigo: 'LKPOSTFB03', publicadoEm: '2026-09-27T21:30:00Z', loja: unitId });
    await postComLink(postD, { kind: 'post', canal: 'facebook', codigo: 'LKPOSTFB04', publicadoEm: '2026-09-10T22:00:00Z', loja: unitId });

    await withTenant(database.db, tenantId, async (tx) => {
      const naCentro = { tenantId, brandId, unitId, connectedAccountId: loja, provider: 'regem' };
      const r = await gravarPedidos(tx, naCentro, [
        // Pelo link do post A, sem anúncio: a origem é o post.
        pedido('p1', { revenueMicros: BigInt(M(46.9)) }),
        pedido('p2', { revenueMicros: BigInt(M(30)), confirmedAt: '2026-09-27T01:00:00Z' }),
        // Pelo link do pacote B.
        pedido('p3', { revenueMicros: BigInt(M(37.2)) }),
        // Pelo link do post A e com o clique numa campanha: fica com o anúncio.
        pedido('p4', { revenueMicros: BigInt(M(50)) }),
        // Sem nada: sem origem, como sempre.
        pedido('p5', { revenueMicros: BigInt(M(20)) }),
        // O clique no link do post A há 10 dias, fora da janela de 7: não é do post, fica sem origem.
        pedido('p6', { revenueMicros: BigInt(M(15)) }),
        // Pelo link do post A, cancelado depois: fora das contas.
        pedido('p7', { revenueMicros: BigInt(M(25)), status: 'cancelado', cancelledAt: '2026-09-27T02:00:00Z' }),
      ]);
      await gravarToques(tx, { tenantId, brandId, connectedAccountId: loja }, [
        { externalId: 't1', kind: 'clique', occurredAt: '2026-09-26T21:25:00Z', orderExternalId: 'p1', linkCode: 'LKPOSTFB01', fbclid: 'IwAR1' },
        { externalId: 't2', kind: 'clique', occurredAt: '2026-09-27T00:30:00Z', orderExternalId: 'p2', linkCode: 'LKPOSTFB01' },
        { externalId: 't3', kind: 'clique', occurredAt: '2026-09-26T22:00:00Z', orderExternalId: 'p3', linkCode: 'LKPOSTTT02' },
        // p4: um acesso pelo link do post e, depois, um clique no anúncio da campanha (o clique no link do post nunca é
        // prova de anúncio, D-A6-48; a prova é o outro).
        { externalId: 't4', kind: 'clique', occurredAt: '2026-09-26T22:10:00Z', orderExternalId: 'p4', linkCode: 'LKPOSTFB01', fbclid: 'IwAR4' },
        { externalId: 't4b', kind: 'clique', occurredAt: '2026-09-26T22:40:00Z', orderExternalId: 'p4', fbclid: 'IwAR4b', campaignExternalId: '1201' },
        { externalId: 't6', kind: 'clique', occurredAt: '2026-09-16T22:00:00Z', orderExternalId: 'p6', linkCode: 'LKPOSTFB01' },
        { externalId: 't7', kind: 'clique', occurredAt: '2026-09-26T22:20:00Z', orderExternalId: 'p7', linkCode: 'LKPOSTFB01' },
      ]);
      await atribuirPedidos(tx, { tenantId, orderIds: r.alterados.map((a) => a.id), gatilho: 'pedidos' });
    });
  }, 120_000);
  afterAll(async () => {
    await database?.close();
    await api?.close();
  });

  const totais = async (params: Record<string, string>): Promise<Totais> => {
    const r = await api.call('GET', `/v1/results/closed-loop?${new URLSearchParams({ brand_id: brandId, ...params })}`, { cookie });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    return r.body.totals as Totais;
  };
  const pedidos = async (params: Record<string, string>): Promise<Item[]> => {
    const r = await api.call('GET', `/v1/results/orders?${new URLSearchParams({ brand_id: brandId, ...params })}`, { cookie });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    return r.body.items as Item[];
  };

  it('o pedido pelo link de um post e sem prova de anúncio conta nos posts e sai de "sem origem"; com prova, fica com o anúncio', async () => {
    const t = await totais({ from: '2026-09-25', to: '2026-09-27' });
    expect(t.posts).toEqual({
      orders: 3,
      revenue_micros: M(46.9 + 30 + 37.2),
      with_ad_orders: 1,
      // A, B e C saíram no período; D, antes.
      published_posts: 3,
      posts: [
        { post_id: postA, kind: 'post', channel: 'facebook', published_at: '2026-09-25T22:00:00.000Z', orders: 2, revenue_micros: M(76.9) },
        { post_id: postB, kind: 'pacote', channel: 'tiktok', published_at: '2026-09-26T15:00:00.000Z', orders: 1, revenue_micros: M(37.2) },
      ],
    });
    // Sem origem: só p5 e p6 (o clique fora da janela). p4 conta no confirmado; p7 foi cancelado.
    expect(t.without_origin.orders).toBe(2);
    expect(t.without_origin.revenue_micros).toBe(M(35));
    expect(t.confirmed.orders).toBe(1);
    expect(t.orders_confirmed).toBe(6);
    expect(t.cancelled.orders).toBe(1);
  });

  it('no pedido a pedido: o post de onde o pedido veio, com o código do link e o acesso; fora da janela, nenhum', async () => {
    const itens = await pedidos({ from: '2026-09-25', to: '2026-09-27' });
    const de = (id: string) => itens.find((i) => i.external_id === id)!;
    expect(de('p1').attribution).toMatchObject({ status: 'sem_origem', counted: false, reason: 'link_do_post' });
    expect(de('p1').post).toEqual({ id: postA, kind: 'post', channel: 'facebook', published_at: '2026-09-25T22:00:00.000Z', link_code: 'LKPOSTFB01', touch_at: '2026-09-26T21:25:00.000Z' });
    expect(de('p3').post).toMatchObject({ id: postB, kind: 'pacote', channel: 'tiktok', link_code: 'LKPOSTTT02' });
    // Com o clique numa campanha: o anúncio fica com ele, e o post aparece como o caminho que o cliente usou.
    expect(de('p4').attribution.counted).toBe(true);
    expect(de('p4').post).toMatchObject({ id: postA, link_code: 'LKPOSTFB01' });
    expect(de('p5').post).toBeNull();
    expect(de('p6').post).toBeNull();
    expect(de('p6').attribution.reason).toBe('fora_da_janela');
  });

  it('na Agenda, cada post com link diz o que trouxe pelo link desde que saiu (P33, D-A6-53): a mesma conta de Resultados', async () => {
    await ligarFlagDaEmpresa(api, 'social_write', tenantId, true);
    try {
      const r = await api.call('GET', `/v1/posts?${new URLSearchParams({ brand_id: brandId, from: '2026-09-20', to: '2026-09-30' })}`, { cookie });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      const de = (id: string) => (r.body.items as { id: string; link_orders: unknown }[]).find((i) => i.id === id)?.link_orders;
      // A: p1 e p2 pelo link, sem anúncio; p4 com anúncio conta à parte; p6 (fora da janela) e p7 (cancelado) não.
      expect(de(postA)).toEqual({ orders: 2, revenue_micros: M(76.9), with_ad_orders: 1 });
      expect(de(postB)).toEqual({ orders: 1, revenue_micros: M(37.2), with_ad_orders: 0 });
      // C saiu com o link e ainda não trouxe pedido: zero, e não nulo.
      expect(de(postC)).toEqual({ orders: 0, revenue_micros: '0', with_ad_orders: 0 });
    } finally {
      await ligarFlagDaEmpresa(api, 'social_write', tenantId, false);
    }
  });

  it('sem post com o link no período, e na loja que os links dos posts não levam, o bloco não vem', async () => {
    expect((await totais({ from: '2026-08-01', to: '2026-08-02' })).posts).toBeUndefined();
    expect((await totais({ from: '2026-09-25', to: '2026-09-27', unit_id: outraLojaId })).posts).toBeUndefined();
    // Na loja dos links: o mesmo da marca toda.
    expect((await totais({ from: '2026-09-25', to: '2026-09-27', unit_id: unitId })).posts?.orders).toBe(3);
    // Só o dia do post de domingo, sem pedido por ele: o bloco vem, com o post publicado e nenhum pedido.
    expect((await totais({ from: '2026-09-28', to: '2026-09-28' })).posts).toBeUndefined();
    const domingo = await totais({ from: '2026-09-27', to: '2026-09-27' });
    expect(domingo.posts).toMatchObject({ published_posts: 1 });
  });
});
