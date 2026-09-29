import { createHash, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { createDatabase, type Database, runMigrations, withSystem, withTenant } from '@liame/database';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { apagarClienteDaOrigem, centavosParaMicros, type ContextoPedidos, gravarPedidos, type PedidoLido } from '../../src/orders/order-store.js';
import { ownerQuery, resetIpRateLimits, signupAndLogin, startApi, type TestApi } from '../helpers/api.js';
import { APP_URL, hasDb, OWNER_URL } from './env.js';

// A2.5 · F1: pedidos da loja com a versão do recurso decidindo a ordem (ADR-004), itens com custo
// desconhecido ≠ zero, cliente só como índice cego e marketplace sem cliente (A2.5-4, A2.5-6, A2.5-7).
describe.skipIf(!hasDb)('modelo de vendas: pedidos, itens e cliente pseudonimizado', () => {
  let api: TestApi;
  let database: Database;
  let ctx: ContextoPedidos;

  // Índice cego de teste: o conector usa a chave da empresa (VaultService.blindIndexFor).
  const indice = (telefone: string) => createHash('sha256').update(telefone).digest('hex');
  const m = (centavos: number) => centavosParaMicros(centavos);

  const pedido = (externalId: string, over: Partial<PedidoLido> = {}): PedidoLido => ({
    externalId,
    channel: 'cardapio_online',
    channelGroup: 'cardapio',
    status: 'confirmado',
    currency: 'BRL',
    timezone: 'America/Sao_Paulo',
    revenueMicros: m(5990),
    discountMicros: m(500),
    refundedMicros: 0n,
    couponCode: null,
    customer: { phoneIndex: indice('+5521999998888'), externalId: 'cli-1' },
    isNewCustomer: true,
    placedAt: '2026-09-26T22:58:00Z',
    confirmedAt: '2026-09-26T23:00:00Z',
    cancelledAt: null,
    version: 1n,
    sourceUpdatedAt: '2026-09-26T23:00:00Z',
    items: [
      { externalId: 'it-1', productExternalId: 'p-burger', name: 'Burger da casa', quantity: '2', revenueMicros: m(4000), costMicros: m(1600) },
      { externalId: 'it-2', productExternalId: 'p-refri', name: 'Refrigerante', quantity: '1', revenueMicros: m(990), costMicros: null },
    ],
    ...over,
  });

  const grava = (pedidos: PedidoLido[]) => withTenant(database.db, ctx.tenantId, (tx) => gravarPedidos(tx, ctx, pedidos));

  beforeAll(async () => {
    await runMigrations({ connectionString: OWNER_URL, dir: resolve(process.cwd(), '../../packages/database/migrations') });
    api = await startApi();
    await resetIpRateLimits();
    database = createDatabase({ connectionString: APP_URL, max: 2, applicationName: 'liame-test' });
    const s = await signupAndLogin(api, undefined, 'Hamburgueria Vendas');
    const tenantId = s.me.active_organization_id as string;
    const [marca] = await ownerQuery<{ id: string }>(`select id from liame.brand where tenant_id = $1 limit 1`, [tenantId]);
    const unitId = randomUUID();
    await ownerQuery(`insert into liame.unit (id, tenant_id, brand_id, name) values ($1, $2, $3, 'Loja Centro')`, [unitId, tenantId, marca!.id]);
    const contaId = randomUUID();
    await ownerQuery(
      `insert into liame.connected_account (id, tenant_id, brand_id, unit_id, provider, external_id, name, currency, timezone)
       values ($1, $2, $3, $4, 'regem', $5, 'Loja Centro (Regem)', 'BRL', 'America/Sao_Paulo')`,
      [contaId, tenantId, marca!.id, unitId, randomUUID()],
    );
    ctx = { tenantId, brandId: marca!.id, unitId, connectedAccountId: contaId, provider: 'regem' };
  });
  afterAll(async () => {
    await database?.close();
    await api?.close();
  });

  it('grava o pedido com itens; repetido ou fora de ordem não muda nada; versão maior atualiza', async () => {
    const r1 = await grava([pedido('ped-1')]);
    expect(r1).toMatchObject({ novos: 1, atualizados: 0, ignorados: 0 });

    // O mesmo evento de novo (webhook repetido): nada muda.
    expect(await grava([pedido('ped-1')])).toMatchObject({ novos: 0, atualizados: 0, ignorados: 1 });

    // Versão 3: cancelado e sem o refrigerante.
    const cancelado = pedido('ped-1', {
      version: 3n,
      status: 'cancelado',
      sourceUpdatedAt: '2026-09-27T01:00:00Z',
      items: [pedido('ped-1').items[0]!],
    });
    expect(await grava([cancelado])).toMatchObject({ novos: 0, atualizados: 1, ignorados: 0 });

    // A versão 2 chega atrasada: fica ignorada, o cancelamento continua valendo.
    expect(await grava([pedido('ped-1', { version: 2n, revenueMicros: m(9999) })])).toMatchObject({ ignorados: 1 });

    await withTenant(database.db, ctx.tenantId, async (tx) => {
      const [p] = (
        await tx.execute<{ status: string; cancelled_at: Date | null; revenue_micros: string; discount_micros: string; source_version: string }>(sql`
          select status, cancelled_at, revenue_micros::text, discount_micros::text, source_version::text
            from liame.order_fact where connected_account_id = ${ctx.connectedAccountId} and external_id = 'ped-1'`)
      ).rows;
      expect(p).toMatchObject({ status: 'cancelado', revenue_micros: '59900000', discount_micros: '5000000', source_version: '3' });
      expect(p!.cancelled_at).not.toBeNull();

      const itens = (
        await tx.execute<{ external_id: string; removido: boolean; cost_known: boolean; revenue_micros: string }>(sql`
          select i.external_id, i.removed_at is not null as removido, i.cost_known, i.revenue_micros::text
            from liame.order_item_fact i join liame.order_fact o on o.id = i.order_id
           where o.external_id = 'ped-1' order by i.external_id`)
      ).rows;
      expect(itens).toEqual([
        { external_id: 'it-1', removido: false, cost_known: true, revenue_micros: '40000000' },
        { external_id: 'it-2', removido: true, cost_known: false, revenue_micros: '9900000' },
      ]);
    });
  });

  it('o mesmo telefone é o mesmo cliente; o id da origem sem telefone ganha o cliente do telefone depois', async () => {
    await grava([
      pedido('ped-2', { customer: { phoneIndex: indice('+5521988887777'), externalId: 'cli-2' } }),
      pedido('ped-3', { customer: { phoneIndex: indice('+5521988887777'), externalId: 'cli-2' } }),
      pedido('ped-4', { customer: { phoneIndex: null, externalId: 'cli-3' } }),
    ]);
    // O cliente cli-3 informa o telefone num pedido seguinte.
    await grava([pedido('ped-5', { customer: { phoneIndex: indice('+5521977776666'), externalId: 'cli-3' } })]);

    await withTenant(database.db, ctx.tenantId, async (tx) => {
      const refs = (
        await tx.execute<{ external_id: string; customer_ref_id: string | null }>(sql`
          select external_id, customer_ref_id from liame.order_fact
           where connected_account_id = ${ctx.connectedAccountId} and external_id in ('ped-2', 'ped-3', 'ped-4', 'ped-5') order by external_id`)
      ).rows;
      const ref = Object.fromEntries(refs.map((r) => [r.external_id, r.customer_ref_id]));
      expect(ref['ped-2']).toBeTruthy();
      expect(ref['ped-2']).toBe(ref['ped-3']);
      expect(ref['ped-4']).toBeTruthy();
      expect(ref['ped-4']).not.toBe(ref['ped-5']);
      const [ligacao] = (
        await tx.execute<{ customer_ref_id: string }>(sql`
          select customer_ref_id from liame.customer_ref_link where connected_account_id = ${ctx.connectedAccountId} and external_id = 'cli-3'`)
      ).rows;
      expect(ligacao?.customer_ref_id).toBe(ref['ped-5']);
    });
  });

  it('marketplace chega sem cliente, mesmo se a origem mandar; o banco recusa o contrário', async () => {
    await grava([pedido('ifood-1', { channel: 'ifood', channelGroup: 'marketplace', customer: { phoneIndex: indice('+5521966665555'), externalId: 'cli-9' } })]);
    await withTenant(database.db, ctx.tenantId, async (tx) => {
      const [p] = (
        await tx.execute<{ customer_ref_id: string | null }>(sql`
          select customer_ref_id from liame.order_fact where connected_account_id = ${ctx.connectedAccountId} and external_id = 'ifood-1'`)
      ).rows;
      expect(p?.customer_ref_id).toBeNull();
      const [c] = (await tx.execute<{ n: string }>(sql`select count(*)::text as n from liame.customer_ref_link where external_id = 'cli-9'`)).rows;
      expect(c?.n).toBe('0');
    });
    const [umCliente] = await ownerQuery<{ id: string }>(`select id from liame.customer_ref where tenant_id = $1 limit 1`, [ctx.tenantId]);
    await expect(
      ownerQuery(`update liame.order_fact set customer_ref_id = $1 where connected_account_id = $2 and external_id = 'ifood-1'`, [
        umCliente!.id,
        ctx.connectedAccountId,
      ]),
    ).rejects.toThrow(/order_fact_marketplace_sem_cliente/);
  });

  it('nenhum telefone em claro: só o índice de 64 hex', async () => {
    const colunas = await ownerQuery<{ table_name: string; column_name: string }>(
      `select table_name, column_name from information_schema.columns
        where table_schema = 'liame' and table_name in ('customer_ref', 'customer_ref_link', 'order_fact', 'order_item_fact')
          and (column_name like '%phone%' or column_name like '%telefone%' or column_name like '%email%' or column_name like '%name%')`,
    );
    expect(colunas.map((c) => `${c.table_name}.${c.column_name}`).sort()).toEqual(['customer_ref.phone_index', 'order_item_fact.name']);
    const [fora] = await ownerQuery<{ n: string }>(
      `select count(*)::text as n from liame.customer_ref where tenant_id = $1 and phone_index is not null and phone_index !~ '^[0-9a-f]{64}$'`,
      [ctx.tenantId],
    );
    expect(fora?.n).toBe('0');
  });

  it('a origem anonimiza o cliente: o Liame apaga o cliente pseudonimizado e os pedidos ficam sem cliente', async () => {
    // A empresa não apaga por conta própria ("só o expurgo apaga"): zero linhas, sem erro.
    const tentativa = await withTenant(database.db, ctx.tenantId, (tx) =>
      tx.execute<{ id: string }>(sql`delete from liame.customer_ref where tenant_id = ${ctx.tenantId} returning id`),
    );
    expect(tentativa.rows).toHaveLength(0);

    const apagados = await withSystem(database.db, (tx) =>
      apagarClienteDaOrigem(tx, { tenantId: ctx.tenantId, connectedAccountId: ctx.connectedAccountId, externalCustomerId: 'cli-2' }),
    );
    expect(apagados).toBe(1);
    const pedidos = await ownerQuery<{ external_id: string; customer_ref_id: string | null }>(
      `select external_id, customer_ref_id from liame.order_fact where connected_account_id = $1 and external_id in ('ped-2', 'ped-3') order by 1`,
      [ctx.connectedAccountId],
    );
    expect(pedidos).toEqual([
      { external_id: 'ped-2', customer_ref_id: null },
      { external_id: 'ped-3', customer_ref_id: null },
    ]);
    const [ligacao] = await ownerQuery<{ n: string }>(
      `select count(*)::text as n from liame.customer_ref_link where connected_account_id = $1 and external_id = 'cli-2'`,
      [ctx.connectedAccountId],
    );
    expect(ligacao?.n).toBe('0');
  });

  it('um lote grande é gravado em poucas instruções e o mesmo pedido duas vezes no lote vale a maior versão', async () => {
    const lote = Array.from({ length: 1200 }, (_, i) => pedido(`massa-${i}`, { customer: { phoneIndex: indice(`+55219${String(i).padStart(8, '0')}`), externalId: null } }));
    lote.push(pedido('massa-0', { version: 5n, revenueMicros: m(100) }));
    const r = await grava(lote);
    expect(r).toMatchObject({ novos: 1200, atualizados: 0, ignorados: 0 });
    const [p] = await ownerQuery<{ revenue_micros: string; source_version: string }>(
      `select revenue_micros::text, source_version::text from liame.order_fact where connected_account_id = $1 and external_id = 'massa-0'`,
      [ctx.connectedAccountId],
    );
    expect(p).toEqual({ revenue_micros: '1000000', source_version: '5' });
  });
});
