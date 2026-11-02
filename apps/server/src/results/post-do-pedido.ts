import { type SQL, sql } from 'drizzle-orm';

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
