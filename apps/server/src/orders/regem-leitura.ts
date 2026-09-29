import { type Tx, uuidv7 } from '@liame/database';
import { sql } from 'drizzle-orm';
import type { ToqueLido } from '../attribution/toque-store.js';
import type { CupomRegem, PedidoRegem } from '../connectors/regem/contrato-regem.js';
import { centavosParaMicros, type PedidoLido } from './order-store.js';

// Do contrato do Regem (docs/integracoes/regem.md e cupons.md) para o modelo do Liame (F1, F2). Funções
// puras, exceto a gravação dos cupons. O telefone não passa por aqui: quem chama já trocou pelo índice
// cego (a chave é da empresa, no cofre).

/** O pedido do Regem no formato de `gravarPedidos`. Marketplace chega sem cliente (D-A2.5-11). */
export function pedidoDoRegem(p: PedidoRegem, indiceTelefone: string | null): PedidoLido {
  const marketplace = p.grupo_canal === 'marketplace';
  return {
    externalId: p.id,
    channel: p.canal,
    channelGroup: p.grupo_canal,
    status: p.situacao,
    currency: p.moeda,
    timezone: p.fuso,
    revenueMicros: centavosParaMicros(p.receita_centavos),
    discountMicros: centavosParaMicros(p.desconto_loja_centavos),
    refundedMicros: centavosParaMicros(p.estornado_centavos),
    couponCode: p.cupom?.trim() ? p.cupom.trim().toUpperCase() : null,
    customer: marketplace || !p.cliente ? null : { phoneIndex: indiceTelefone, externalId: p.cliente.id },
    isNewCustomer: marketplace ? null : (p.cliente?.novo ?? null),
    placedAt: p.criado_em ?? null,
    confirmedAt: p.confirmado_em,
    cancelledAt: p.cancelado_em,
    version: p.versao,
    sourceUpdatedAt: p.atualizado_em,
    items: p.itens.map((i) => ({
      externalId: i.id,
      productExternalId: i.produto_id ?? null,
      name: i.nome,
      quantity: i.quantidade,
      revenueMicros: centavosParaMicros(i.receita_centavos),
      costMicros: i.custo_centavos === null ? null : centavosParaMicros(i.custo_centavos),
    })),
  };
}

/**
 * O clique captado pelo cardápio na sessão do pedido (C3a) vira um ponto de contato ligado a ele. Pedido
 * de marketplace não tem clique da loja: a origem, se vier, é ignorada.
 */
export function toqueDoPedido(p: PedidoRegem): ToqueLido | null {
  const o = p.origem;
  if (!o || p.grupo_canal === 'marketplace') return null;
  return {
    externalId: `pedido:${p.id}`,
    kind: 'clique',
    occurredAt: o.capturado_em,
    orderExternalId: p.id,
    linkCode: o.lk ?? null,
    campaignExternalId: o.campaign_id ?? null,
    adGroupExternalId: o.adset_id ?? o.adgroup_id ?? null,
    adExternalId: o.ad_id ?? null,
    gclid: o.gclid ?? null,
    gbraid: o.gbraid ?? null,
    wbraid: o.wbraid ?? null,
    fbclid: o.fbclid ?? null,
    utm: { source: o.utm_source, medium: o.utm_medium, campaign: o.utm_campaign, content: o.utm_content, term: o.utm_term },
    origem: 'url',
  };
}

export type ContextoCupons = { tenantId: string; brandId: string; connectedAccountId: string };

/**
 * Espelho dos cupons da loja (D-A2.5-3): a versão do recurso decide, como nos pedidos. A validade chega em
 * datas no fuso da loja e vira instante: do começo do primeiro dia até o fim do último (exclusivo).
 */
export async function gravarCupons(tx: Tx, ctx: ContextoCupons, cupons: CupomRegem[]): Promise<{ alterados: number }> {
  const porId = new Map<string, CupomRegem>();
  for (const c of cupons) {
    const antes = porId.get(c.id);
    if (!antes || c.versao > antes.versao) porId.set(c.id, c);
  }
  if (!porId.size) return { alterados: 0 };
  const linhas = [...porId.values()].map((c) => ({
    new_id: uuidv7(),
    external_id: c.id,
    code: c.codigo.trim().toUpperCase(),
    description: c.nome?.slice(0, 500) ?? null,
    kind: c.tipo,
    percent: c.percentual ?? null,
    value_micros: c.valor_centavos == null ? null : centavosParaMicros(c.valor_centavos).toString(),
    max_discount_micros: c.teto_desconto_centavos == null ? null : centavosParaMicros(c.teto_desconto_centavos).toString(),
    min_order_micros: c.pedido_minimo_centavos == null ? null : centavosParaMicros(c.pedido_minimo_centavos).toString(),
    valido_de: c.valido_de ?? null,
    valido_ate: c.valido_ate ?? null,
    fuso: c.fuso,
    active: c.ativo,
    max_uses: c.max_usos ?? null,
    uses_count: c.usos,
    conditions: c.condicoes ?? {},
    all_units: c.todas_as_lojas ?? false,
    source_version: c.versao.toString(),
    source_updated_at: c.atualizado_em,
  }));
  const r = await tx.execute<{ id: string }>(sql`
    with e as (
      select * from jsonb_to_recordset(${JSON.stringify(linhas)}::jsonb) as e(
        new_id uuid, external_id text, code text, description text, kind text, percent numeric, value_micros bigint,
        max_discount_micros bigint, min_order_micros bigint, valido_de date, valido_ate date, fuso text, active boolean,
        max_uses integer, uses_count integer, conditions jsonb, all_units boolean, source_version bigint, source_updated_at timestamptz)
    )
    insert into liame.coupon (
      id, tenant_id, brand_id, connected_account_id, external_id, code, description, kind, percent, value_micros,
      max_discount_micros, min_order_micros, valid_from, valid_until, active, max_uses, uses_count, conditions, all_units,
      source_version, source_updated_at)
    select e.new_id, ${ctx.tenantId}, ${ctx.brandId}, ${ctx.connectedAccountId}, e.external_id, e.code, e.description, e.kind,
           e.percent, e.value_micros, e.max_discount_micros, e.min_order_micros,
           e.valido_de::timestamp at time zone e.fuso,
           (e.valido_ate + 1)::timestamp at time zone e.fuso,
           e.active, e.max_uses, e.uses_count, e.conditions, e.all_units, e.source_version, e.source_updated_at
      from e
    on conflict (connected_account_id, external_id) do update
       set code = excluded.code, description = excluded.description, kind = excluded.kind, percent = excluded.percent,
           value_micros = excluded.value_micros, max_discount_micros = excluded.max_discount_micros,
           min_order_micros = excluded.min_order_micros, valid_from = excluded.valid_from, valid_until = excluded.valid_until,
           active = excluded.active, max_uses = excluded.max_uses, uses_count = excluded.uses_count,
           conditions = excluded.conditions, all_units = excluded.all_units, source_version = excluded.source_version,
           source_updated_at = excluded.source_updated_at
     where liame.coupon.source_version < excluded.source_version
    returning id`);
  return { alterados: r.rows.length };
}
