import type { Tx } from '@liame/database';
import { type SQL, sql } from 'drizzle-orm';
import { MODELO_PADRAO } from '../attribution/motor.js';
import { PEDIDO_USOU_O_CUPOM_DA_MENSAGEM } from '../mensageria/cupom-no-pedido.js';

/**
 * O post do pedido (A6, Z7, parte b; D-A6-49; protótipo P32): o último clique no link de um post antes da confirmação,
 * dentro da janela do modelo, pela mesma regra do motor de atribuição (`attribution/motor.ts`, o motivo `link_do_post`,
 * D-A6-48). É um `left join lateral` sobre o pedido `o` (`order_fact`), com o apelido `lp`: `lp.post_id` (nulo se o post
 * foi apagado), `lp.link_code`, `lp.canal` (a rede do link) e `lp.toque_em`; sem clique no link de um post, tudo nulo.
 * O pedido se liga ao post só pelo código do link: nenhum nome, nenhum telefone.
 */
export function postDoPedido(o: SQL, janelaDias: number): SQL {
  return sql`left join lateral (
      select tl.post_id, tl.code as link_code, tl.provider as canal, t.occurred_at as toque_em
        from liame.touchpoint t
        join liame.tracking_link tl on tl.tenant_id = ${o}.tenant_id and tl.code = t.link_code and tl.kind = 'post'
       where t.connected_account_id = ${o}.connected_account_id and t.order_external_id = ${o}.external_id and t.kind = 'clique'
         and t.occurred_at <= ${o}.confirmed_at and t.occurred_at > ${o}.confirmed_at - make_interval(days => ${janelaDias})
       order by t.occurred_at desc, t.id
       limit 1) lp on true`;
}

/** O que um post trouxe pelo link dele: os pedidos sem prova de anúncio e o valor deles, e os que ficam com o anúncio. */
export type PedidosDoPost = { orders: number; revenue: bigint; comAnuncio: number };

/**
 * Os pedidos que cada post trouxe pelo link (A6, Z7, parte b; P33, D-A6-53), desde que saiu: a mesma conta de Resultados
 * (P32, D-A6-64). Confirmados (o cancelado sai); o post do pedido é o do último clique no link de um post dentro da
 * janela; sem prova de anúncio, conta no post (`link_do_post`); com prova, fica com o anúncio e conta à parte; o pedido
 * com o cupom de uma mensagem fica com a mensagem. Parte dos cliques nos links destes posts (set-based: uma consulta para
 * todos). Post sem pedido não aparece no mapa.
 */
export async function pedidosDosPosts(tx: Tx, tenantId: string, postIds: string[]): Promise<Map<string, PedidosDoPost>> {
  const mapa = new Map<string, PedidosDoPost>();
  if (!postIds.length) return mapa;
  const modelo = await tx.execute<{ window_days: number }>(sql`select window_days from liame.attribution_model where id = ${MODELO_PADRAO}`);
  const janela = modelo.rows[0]?.window_days;
  if (!janela) return mapa;
  const r = await tx.execute<{ post_id: string; pedidos: number; receita: string; com_anuncio: number }>(sql`
    with candidatos as (
      select distinct o.id
        from liame.tracking_link tl
        join liame.touchpoint t on t.tenant_id = tl.tenant_id and t.link_code = tl.code and t.kind = 'clique'
        join liame.order_fact o on o.connected_account_id = t.connected_account_id and o.external_id = t.order_external_id
       where tl.tenant_id = ${tenantId} and tl.kind = 'post' and tl.post_id in ${postIds}
    )
    select lp.post_id,
           count(*) filter (where r.reason = 'link_do_post' and not coalesce(r.counted, false) and not dm.da_mensagem)::int as pedidos,
           coalesce(sum(o.revenue_micros - o.refunded_micros) filter (where r.reason = 'link_do_post' and not coalesce(r.counted, false) and not dm.da_mensagem), 0)::text as receita,
           count(*) filter (where r.counted)::int as com_anuncio
      from candidatos c
      join liame.order_fact o on o.id = c.id
      cross join lateral (select exists (select 1 from liame.message_request m where ${PEDIDO_USOU_O_CUPOM_DA_MENSAGEM}) as da_mensagem) dm
      left join liame.attribution_result r on r.order_id = o.id and r.model_id = ${MODELO_PADRAO}
      ${postDoPedido(sql`o`, janela)}
     where o.status = 'confirmado' and lp.post_id in ${postIds}
     group by lp.post_id`);
  for (const l of r.rows) mapa.set(l.post_id, { orders: l.pedidos, revenue: BigInt(l.receita), comAnuncio: l.com_anuncio });
  return mapa;
}
