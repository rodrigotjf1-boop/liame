import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { createDatabase, type Database, runMigrations, withTenant } from '@liame/database';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { atribuirPedidos } from '../../src/attribution/motor.js';
import { gravarToques } from '../../src/attribution/toque-store.js';
import { centavosParaMicros, gravarPedidos, type PedidoLido } from '../../src/orders/order-store.js';
import { enableMfa, ownerQuery, resetIpRateLimits, signupAndLogin, startApi, type TestApi } from '../helpers/api.js';
import { contaDoRegemcast, semearMensagemDoCrm } from '../helpers/mensagens-semeadas.js';
import { APP_URL, hasDb, OWNER_URL } from './env.js';

// A5 · as mensagens de WhatsApp em Resultados (D-A5-16; protótipo P15, parte C, aprovado em 10/10/2026). O pedido se
// liga à mensagem só pelo cupom dela. Com prova de anúncio, ele fica com o anúncio (decisão do dono); sem, a origem é a
// mensagem: sai de "sem origem" quando é do cardápio ou do WhatsApp, e segue no canal dele quando o canal não tem clique.

const M = (reais: number) => (BigInt(Math.round(reais * 100)) * 10_000n).toString();

type Totais = {
  orders_confirmed: number;
  confirmed: { orders: number; revenue_micros: string };
  without_origin: { orders: number; revenue_micros: string; share_pct: string | null };
  no_click_channels: { channel_group: string; orders: number; revenue_micros: string }[];
  cancelled: { orders: number };
  messages?: { orders: number; revenue_micros: string; own_channel_orders: number; with_ad_orders: number };
};
type Item = { external_id: string; attribution: { status: string; counted: boolean; reason: string | null }; message: { name: string; coupon_code: string; sent_at: string } | null };

describe.skipIf(!hasDb)('as mensagens de WhatsApp em Resultados (A5 · P15, parte C)', () => {
  let api: TestApi;
  let database: Database;
  let cookie = '';
  let tenantId = '';
  let brandId = '';
  let unitId = '';
  let outraLojaId = '';

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

  beforeAll(async () => {
    await runMigrations({ connectionString: OWNER_URL, dir: resolve(process.cwd(), '../../packages/database/migrations') });
    api = await startApi();
    await resetIpRateLimits();
    database = createDatabase({ connectionString: APP_URL, max: 2, applicationName: 'liame-test' });
    const s = await signupAndLogin(api, undefined, 'Mister Burgers Mensagens em Resultados');
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
    const outraLoja = await conta('regem', 'Loja Lapa (Regem)', outraLojaId);

    // A mensagem saiu em 26/09, às 11h de Brasília, com o cupom DOCE10 (da Loja Centro), que vale até 28/09.
    const regemcast = await contaDoRegemcast({ tenantId, brandId });
    const alvo = { tenantId, brandId, userId: s.me.user.id as string, conta: regemcast };
    await semearMensagemDoCrm(alvo, { situacao: 'executada', nome: 'Sobremesa por nossa conta', cupom: { loja, codigo: 'DOCE10', nascido: '2026-09-26T14:00:00Z', validoAte: '2026-09-28' }, aprovadaPor: alvo.userId });
    // Uma mensagem recusada: o cupom dela nunca nasceu, e um pedido com esse código não é de mensagem nenhuma.
    await semearMensagemDoCrm(alvo, { situacao: 'recusada', nome: 'Combo kids', cupom: { loja, codigo: 'KIDS10', nascido: null, validoAte: '2026-09-28' } });

    await withTenant(database.db, tenantId, async (tx) => {
      const naCentro = { tenantId, brandId, unitId, connectedAccountId: loja, provider: 'regem' };
      const r = await gravarPedidos(tx, naCentro, [
        // Do cardápio, com o cupom, sem clique: veio pela mensagem e sai de "sem origem".
        pedido('m1', { couponCode: 'DOCE10', revenueMicros: BigInt(M(58.9)) }),
        // No balcão, com o cupom: veio pela mensagem e segue no canal dele (canal sem clique).
        pedido('m2', { couponCode: 'DOCE10', channel: 'balcao', channelGroup: 'presencial', revenueMicros: BigInt(M(40)) }),
        // Com o cupom E com clique numa campanha: fica com o anúncio.
        pedido('m3', { couponCode: 'DOCE10', revenueMicros: BigInt(M(70)) }),
        // Com o código, mas confirmado antes de o cupom nascer: não é da mensagem.
        pedido('m4', { couponCode: 'DOCE10', revenueMicros: BigInt(M(30)), confirmedAt: '2026-09-26T13:00:00Z' }),
        // Com o cupom, cancelado depois: fora das contas.
        pedido('m5', { couponCode: 'DOCE10', status: 'cancelado', cancelledAt: '2026-09-27T01:00:00Z', revenueMicros: BigInt(M(25)) }),
        // Sem cupom e sem clique: sem origem, como sempre.
        pedido('m6', { revenueMicros: BigInt(M(20)) }),
        // Com o código de uma mensagem recusada (o cupom nunca nasceu): sem origem.
        pedido('m7', { couponCode: 'KIDS10', revenueMicros: BigInt(M(15)) }),
      ]);
      // Na outra loja, o mesmo código não é o cupom da mensagem (o cupom nasce numa loja só).
      const naLapa = { tenantId, brandId, unitId: outraLojaId, connectedAccountId: outraLoja, provider: 'regem' };
      const r2 = await gravarPedidos(tx, naLapa, [pedido('m8', { couponCode: 'DOCE10', revenueMicros: BigInt(M(12)) })]);
      await gravarToques(tx, { tenantId, brandId, connectedAccountId: loja }, [
        { externalId: 't3', kind: 'clique', occurredAt: '2026-09-26T21:00:00Z', orderExternalId: 'm3', fbclid: 'IwAR3', campaignExternalId: '1201' },
      ]);
      await atribuirPedidos(tx, { tenantId, orderIds: [...r.alterados, ...r2.alterados].map((a) => a.id), gatilho: 'pedidos' });
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

  it('o pedido com o cupom de uma mensagem e sem prova de anúncio conta nas mensagens; com prova, fica com o anúncio', async () => {
    const t = await totais({ from: '2026-09-26', to: '2026-09-27' });
    // m1 (cardápio) e m2 (balcão) são da mensagem; m3 usou o cupom e tem clique: fica com o anúncio.
    expect(t.messages).toEqual({ orders: 2, revenue_micros: M(98.9), own_channel_orders: 1, with_ad_orders: 1 });
    expect(t.confirmed).toMatchObject({ orders: 1, revenue_micros: M(70) });
    // Sem origem: m4 (antes de o cupom nascer), m6 (sem cupom), m7 (cupom que nunca nasceu) e m8 (outra loja).
    // A porcentagem é sobre os seis pedidos dos canais com clique (m1, m3, m4, m6, m7 e m8); o m1 não entra na conta
    // dos sem origem, mas é um pedido do cardápio.
    expect(t.without_origin).toEqual({ orders: 4, revenue_micros: M(77), share_pct: '66.7' });
    // O do balcão segue no canal dele: a barra da tela não muda.
    expect(t.no_click_channels).toEqual([{ channel_group: 'presencial', orders: 1, revenue_micros: M(40) }]);
    expect(t.cancelled.orders).toBe(1);
    expect(t.orders_confirmed).toBe(7);
  });

  it('só a loja do cupom conta: na outra loja, o mesmo código não é da mensagem', async () => {
    const centro = await totais({ from: '2026-09-26', to: '2026-09-27', unit_id: unitId });
    expect(centro.messages).toEqual({ orders: 2, revenue_micros: M(98.9), own_channel_orders: 1, with_ad_orders: 1 });
    expect(centro.without_origin.orders).toBe(3);
    // A Loja Lapa tem um pedido com o código, e nenhum cupom de mensagem: a resposta é a de sempre, sem o campo.
    const lapa = await totais({ from: '2026-09-26', to: '2026-09-27', unit_id: outraLojaId });
    expect(lapa).not.toHaveProperty('messages');
    expect(lapa.without_origin.orders).toBe(1);
  });

  it('com o cupom valendo e nenhum pedido, o campo vem zerado; fora da validade, e antes de o cupom nascer, não vem', async () => {
    // 28/09: o último dia do cupom, sem nenhum pedido.
    expect((await totais({ from: '2026-09-28', to: '2026-09-28' })).messages).toEqual({ orders: 0, revenue_micros: '0', own_channel_orders: 0, with_ad_orders: 0 });
    // 29/09 em diante: o cupom já venceu.
    expect(await totais({ from: '2026-09-29', to: '2026-09-30' })).not.toHaveProperty('messages');
    // Até 25/09: o cupom ainda não existia (nasceu em 26/09, no fuso da loja).
    expect(await totais({ from: '2026-09-20', to: '2026-09-25' })).not.toHaveProperty('messages');
  });

  it('pedido a pedido: quem usou o cupom traz a mensagem (o nome, o cupom e o envio), e mais ninguém', async () => {
    const itens = await pedidos({ from: '2026-09-26', to: '2026-09-27' });
    const por = new Map(itens.map((i) => [i.external_id, i]));
    const mensagem = { name: 'Sobremesa por nossa conta', coupon_code: 'DOCE10', sent_at: '2026-09-26T14:00:00.000Z' };
    expect(por.get('m1')).toMatchObject({ message: mensagem, attribution: { status: 'sem_origem', counted: false, reason: 'sem_evidencia' } });
    expect(por.get('m2')).toMatchObject({ message: mensagem, attribution: { counted: false, reason: 'canal_sem_clique' } });
    // Com prova de anúncio, a mensagem vem junto, e o pedido segue contado no anúncio.
    expect(por.get('m3')).toMatchObject({ message: mensagem, attribution: { status: 'atribuido', counted: true } });
    expect(por.get('m5')?.message).toEqual(mensagem);
    for (const id of ['m4', 'm6', 'm7', 'm8']) expect(por.get(id)?.message, id).toBeNull();
    // A junção não multiplica linhas: cada pedido aparece uma vez.
    expect(itens.map((i) => i.external_id).sort()).toEqual(['m1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7', 'm8']);
    // Nenhum dado de quem recebeu a mensagem: só o nome dela e o cupom.
    expect(JSON.stringify(itens)).not.toMatch(/telefone|phone|IwAR/);
  });

  it('a tela Mensagens e Resultados ligam os mesmos pedidos ao cupom', async () => {
    // Mensagens conta todo pedido confirmado que usou o cupom (m1, m2 e m3); Resultados separa o que tem prova de
    // anúncio: os dois somados dão o mesmo.
    const t = await totais({ from: '2026-09-26', to: '2026-09-27' });
    const linhas = await ownerQuery<{ n: number }>(
      `select count(*)::int as n from liame.order_fact o join liame.message_request m
          on o.tenant_id = m.tenant_id and o.connected_account_id = m.coupon_account_id and o.coupon_code = m.coupon_code and o.confirmed_at >= m.coupon_created_at
       where m.tenant_id = $1 and o.status = 'confirmado'`,
      [tenantId],
    );
    const comOCupom = linhas[0]!.n;
    expect(comOCupom).toBe(3);
    expect(t.messages!.orders + t.messages!.with_ad_orders).toBe(comOCupom);
  });
});
