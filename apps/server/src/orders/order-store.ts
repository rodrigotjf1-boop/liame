import { type Tx, uuidv7 } from '@liame/database';
import { sql } from 'drizzle-orm';

// Gravação dos pedidos lidos da loja (A2.5, F1; ADR-019). Um número fixo de instruções por lote
// (set-based, nunca uma por pedido), na transação de quem chama, sob a RLS da empresa:
//   1. cliente pelo índice cego do telefone; 2. cliente só pelo id da origem (sem telefone);
//   3. ligação id da origem → cliente; 4. pedidos, com a versão do recurso decidindo (ADR-004);
//   5. itens só dos pedidos que mudaram, com o item que sumiu marcado (nada se apaga).
// O telefone nunca chega aqui: quem chama já trocou pelo índice cego (VaultService.blindIndexFor).

export type GrupoCanal = 'cardapio' | 'whatsapp' | 'presencial' | 'marketplace' | 'outro';

export type ItemLido = {
  externalId: string;
  productExternalId?: string | null;
  name: string;
  /** Quantidade exata em texto ("1", "0.5"). */
  quantity: string;
  revenueMicros: bigint;
  /** `null` = custo desconhecido (margem desconhecida ≠ zero). */
  costMicros: bigint | null;
};

export type PedidoLido = {
  externalId: string;
  channel: string;
  channelGroup: GrupoCanal;
  /** `removido`: a venda deixou de existir sozinha na origem e sai das contas (não é cancelamento). */
  status: 'confirmado' | 'cancelado' | 'removido';
  currency: string;
  timezone: string;
  /** Receita pela definição única de faturamento do Regem (D-A2.5-6). */
  revenueMicros: bigint;
  discountMicros: bigint;
  refundedMicros: bigint;
  couponCode: string | null;
  /** Índice cego do telefone (64 hex) e/ou id do cliente na origem. Marketplace: sempre `null`. */
  customer: { phoneIndex: string | null; externalId: string | null } | null;
  isNewCustomer: boolean | null;
  placedAt: string | null;
  confirmedAt: string;
  /** Instante que põe a receita no dia (o do Painel do Regem); nulo = o da confirmação. */
  billedAt?: string | null;
  cancelledAt: string | null;
  /** Versão do recurso na origem: só cresce. */
  version: bigint;
  sourceUpdatedAt: string;
  items: ItemLido[];
};

export type ContextoPedidos = {
  tenantId: string;
  brandId: string;
  unitId: string | null;
  connectedAccountId: string;
  provider: string;
};

export type ResultadoPedidos = {
  novos: number;
  atualizados: number;
  /** Versão igual ou menor que a gravada: nada muda (repetido ou fora de ordem). */
  ignorados: number;
  /** Pedidos que entraram ou mudaram: o motor de atribuição recalcula só estes. */
  alterados: { id: string; externalId: string }[];
};

const LOTE = 500;
const MICROS_POR_CENTAVO = 10_000n;
/** Teto que cabe no bigint do banco depois de virar micros (R$ 9 trilhões). */
const MAX_CENTAVOS = 900_000_000_000_000;

/** Centavos inteiros do contrato → micros, sem ponto flutuante (A2.5-4). */
export function centavosParaMicros(centavos: number): bigint {
  if (!Number.isSafeInteger(centavos) || centavos < 0 || centavos > MAX_CENTAVOS) throw new Error(`valor em centavos inválido: ${centavos}`);
  return BigInt(centavos) * MICROS_POR_CENTAVO;
}

const INDICE = /^[0-9a-f]{64}$/;

/** Grava os pedidos lidos. Pedido repetido no lote: vale o de maior versão. */
export async function gravarPedidos(tx: Tx, ctx: ContextoPedidos, pedidos: PedidoLido[]): Promise<ResultadoPedidos> {
  const porId = new Map<string, PedidoLido>();
  for (const p of pedidos) {
    const antes = porId.get(p.externalId);
    if (!antes || p.version > antes.version) porId.set(p.externalId, p);
  }
  const unicos = [...porId.values()];
  const total: ResultadoPedidos = { novos: 0, atualizados: 0, ignorados: 0, alterados: [] };
  for (let i = 0; i < unicos.length; i += LOTE) {
    const r = await gravarLote(tx, ctx, unicos.slice(i, i + LOTE));
    total.novos += r.novos;
    total.atualizados += r.atualizados;
    total.ignorados += r.ignorados;
    total.alterados.push(...r.alterados);
  }
  return total;
}

async function gravarLote(tx: Tx, ctx: ContextoPedidos, lote: PedidoLido[]): Promise<ResultadoPedidos> {
  const clientes = lote.map((p) => {
    const marketplace = p.channelGroup === 'marketplace';
    const phoneIndex = marketplace ? null : (p.customer?.phoneIndex ?? null);
    if (phoneIndex !== null && !INDICE.test(phoneIndex)) throw new Error('índice cego do telefone inválido');
    return { phoneIndex, externalId: marketplace ? null : (p.customer?.externalId ?? null) };
  });

  // 1. Cliente pelo telefone (um id novo por índice distinto; o existente só renova o "visto").
  const indices = [...new Set(clientes.map((c) => c.phoneIndex).filter((x): x is string => x !== null))];
  if (indices.length) {
    await tx.execute(sql`
      insert into liame.customer_ref (id, tenant_id, phone_index)
      select e.new_id, ${ctx.tenantId}, e.phone_index
        from jsonb_to_recordset(${JSON.stringify(indices.map((phone_index) => ({ phone_index, new_id: uuidv7() })))}::jsonb)
             as e(phone_index text, new_id uuid)
      on conflict (tenant_id, phone_index) where phone_index is not null do update set last_seen_at = now()`);
  }

  // 2. Cliente só com o id da origem (sem telefone) e ainda sem ligação: cliente novo sem índice.
  const semTelefone = [...new Set(clientes.filter((c) => c.phoneIndex === null && c.externalId !== null).map((c) => c.externalId as string))];
  if (semTelefone.length) {
    await tx.execute(sql`
      with e as (
        select * from jsonb_to_recordset(${JSON.stringify(semTelefone.map((external_id) => ({ external_id, new_id: uuidv7() })))}::jsonb)
             as e(external_id text, new_id uuid)
      ),
      faltam as (
        select e.* from e
         where not exists (select 1 from liame.customer_ref_link l
                            where l.connected_account_id = ${ctx.connectedAccountId} and l.external_id = e.external_id)
      ),
      novos as (
        insert into liame.customer_ref (id, tenant_id) select new_id, ${ctx.tenantId} from faltam returning id
      )
      insert into liame.customer_ref_link (connected_account_id, external_id, tenant_id, customer_ref_id)
      select ${ctx.connectedAccountId}, f.external_id, ${ctx.tenantId}, f.new_id from faltam f
      on conflict (connected_account_id, external_id) do nothing`);
  }

  // 3. Id da origem com telefone: a ligação passa a apontar para o cliente do telefone mais recente.
  const comAmbos = new Map<string, string>();
  for (const c of clientes) if (c.phoneIndex !== null && c.externalId !== null) comAmbos.set(c.externalId, c.phoneIndex);
  if (comAmbos.size) {
    await tx.execute(sql`
      insert into liame.customer_ref_link (connected_account_id, external_id, tenant_id, customer_ref_id)
      select ${ctx.connectedAccountId}, e.external_id, ${ctx.tenantId}, r.id
        from jsonb_to_recordset(${JSON.stringify([...comAmbos].map(([external_id, phone_index]) => ({ external_id, phone_index })))}::jsonb)
             as e(external_id text, phone_index text)
        join liame.customer_ref r on r.tenant_id = ${ctx.tenantId} and r.phone_index = e.phone_index
      on conflict (connected_account_id, external_id) do update set customer_ref_id = excluded.customer_ref_id
       where liame.customer_ref_link.customer_ref_id <> excluded.customer_ref_id`);
  }

  // 4. Pedidos: entra o novo; o existente só muda com versão maior (repetido ou fora de ordem não mexe).
  const linhas = lote.map((p, i) => ({
    external_id: p.externalId,
    new_id: uuidv7(),
    channel: p.channel,
    channel_group: p.channelGroup,
    status: p.status,
    currency: p.currency,
    timezone: p.timezone,
    revenue_micros: p.revenueMicros.toString(),
    discount_micros: p.discountMicros.toString(),
    refunded_micros: p.refundedMicros.toString(),
    coupon_code: p.couponCode ? p.couponCode.trim().toUpperCase() : null,
    phone_index: clientes[i]!.phoneIndex,
    customer_external_id: clientes[i]!.externalId,
    is_new_customer: p.isNewCustomer,
    placed_at: p.placedAt,
    confirmed_at: p.confirmedAt,
    billed_at: p.billedAt ?? null,
    cancelled_at: p.status === 'cancelado' ? (p.cancelledAt ?? p.sourceUpdatedAt) : null,
    source_version: p.version.toString(),
    source_updated_at: p.sourceUpdatedAt,
  }));
  const gravados = await tx.execute<{ id: string; external_id: string; novo: boolean }>(sql`
    with e as (
      select * from jsonb_to_recordset(${JSON.stringify(linhas)}::jsonb) as e(
        external_id text, new_id uuid, channel text, channel_group text, status text, currency text, timezone text,
        revenue_micros bigint, discount_micros bigint, refunded_micros bigint, coupon_code text, phone_index text,
        customer_external_id text, is_new_customer boolean, placed_at timestamptz, confirmed_at timestamptz,
        billed_at timestamptz, cancelled_at timestamptz, source_version bigint, source_updated_at timestamptz)
    ),
    c as (
      select e.*, coalesce(rp.id, l.customer_ref_id) as customer_ref_id
        from e
        left join liame.customer_ref rp on rp.tenant_id = ${ctx.tenantId} and rp.phone_index = e.phone_index
        left join liame.customer_ref_link l on l.connected_account_id = ${ctx.connectedAccountId} and l.external_id = e.customer_external_id
    )
    insert into liame.order_fact (
      id, tenant_id, brand_id, unit_id, connected_account_id, provider, external_id, channel, channel_group, status,
      currency, timezone, revenue_micros, discount_micros, refunded_micros, coupon_code, customer_ref_id,
      is_new_customer, placed_at, confirmed_at, billed_at, cancelled_at, source_version, source_updated_at)
    select c.new_id, ${ctx.tenantId}, ${ctx.brandId}, ${ctx.unitId}, ${ctx.connectedAccountId}, ${ctx.provider}, c.external_id,
           c.channel, c.channel_group, c.status, c.currency, c.timezone, c.revenue_micros, c.discount_micros, c.refunded_micros,
           c.coupon_code, case when c.channel_group = 'marketplace' then null else c.customer_ref_id end,
           c.is_new_customer, c.placed_at, c.confirmed_at, c.billed_at, c.cancelled_at, c.source_version, c.source_updated_at
      from c
    on conflict (connected_account_id, external_id) do update
       set channel = excluded.channel, channel_group = excluded.channel_group, status = excluded.status,
           currency = excluded.currency, timezone = excluded.timezone, unit_id = excluded.unit_id,
           revenue_micros = excluded.revenue_micros, discount_micros = excluded.discount_micros,
           refunded_micros = excluded.refunded_micros, coupon_code = excluded.coupon_code,
           customer_ref_id = excluded.customer_ref_id, is_new_customer = excluded.is_new_customer,
           placed_at = excluded.placed_at, confirmed_at = excluded.confirmed_at, billed_at = excluded.billed_at,
           cancelled_at = excluded.cancelled_at,
           source_version = excluded.source_version, source_updated_at = excluded.source_updated_at
     where liame.order_fact.source_version < excluded.source_version
    returning id, external_id, (xmax = 0) as novo`);

  const alterados = gravados.rows.map((r) => ({ id: r.id, externalId: r.external_id }));
  const novos = gravados.rows.filter((r) => r.novo).length;

  // 5. Itens dos pedidos que mudaram: upsert por id do item; o que não veio na versão nova fica marcado.
  if (alterados.length) {
    const idPorExterno = new Map(alterados.map((a) => [a.externalId, a.id]));
    const itens = lote.flatMap((p) => {
      const orderId = idPorExterno.get(p.externalId);
      if (!orderId) return [];
      return [...new Map(p.items.map((it) => [it.externalId, it])).values()].map((it) => ({
        order_id: orderId,
        new_id: uuidv7(),
        external_id: it.externalId,
        product_external_id: it.productExternalId ?? null,
        name: it.name,
        quantity: it.quantity,
        revenue_micros: it.revenueMicros.toString(),
        cost_micros: it.costMicros === null ? null : it.costMicros.toString(),
      }));
    });
    await tx.execute(sql`
      with e as (
        select * from jsonb_to_recordset(${JSON.stringify(itens)}::jsonb) as e(
          order_id uuid, new_id uuid, external_id text, product_external_id text, name text, quantity numeric,
          revenue_micros bigint, cost_micros bigint)
      ),
      pedidos as (select value::uuid as id from jsonb_array_elements_text(${JSON.stringify(alterados.map((a) => a.id))}::jsonb)),
      gravados as (
        insert into liame.order_item_fact (id, tenant_id, order_id, external_id, product_external_id, name, quantity, revenue_micros, cost_micros)
        select e.new_id, ${ctx.tenantId}, e.order_id, e.external_id, e.product_external_id, e.name, e.quantity, e.revenue_micros, e.cost_micros
          from e
        on conflict (order_id, external_id) do update
           set product_external_id = excluded.product_external_id, name = excluded.name, quantity = excluded.quantity,
               revenue_micros = excluded.revenue_micros, cost_micros = excluded.cost_micros, removed_at = null
        returning 1
      )
      update liame.order_item_fact i set removed_at = now()
       where i.order_id in (select id from pedidos) and i.removed_at is null
         and not exists (select 1 from e where e.order_id = i.order_id and e.external_id = i.external_id)`);
  }

  return { novos, atualizados: alterados.length - novos, ignorados: lote.length - alterados.length, alterados };
}

/**
 * A origem anonimizou o cliente (aviso `cliente.anonimizado`): apaga o cliente pseudonimizado do Liame
 * inteiro. As ligações somem junto e os pedidos e toques ficam sem cliente (A2.5-7). Apagar é só do
 * escopo de sistema ("só o expurgo apaga"): quem chama usa `withSystem`, com a empresa explícita.
 */
export async function apagarClienteDaOrigem(tx: Tx, alvo: { tenantId: string; connectedAccountId: string; externalCustomerId: string }): Promise<number> {
  const r = await tx.execute<{ id: string }>(sql`
    delete from liame.customer_ref c
     using liame.customer_ref_link l
     where l.connected_account_id = ${alvo.connectedAccountId} and l.external_id = ${alvo.externalCustomerId}
       and l.tenant_id = ${alvo.tenantId} and c.id = l.customer_ref_id and c.tenant_id = ${alvo.tenantId}
    returning c.id`);
  return r.rows.length;
}
