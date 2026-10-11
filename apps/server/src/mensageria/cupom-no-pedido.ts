import { sql } from 'drizzle-orm';

/**
 * A ligação entre um pedido do caixa (`o`, de `order_fact`) e a mensagem de WhatsApp cujo cupom ele usou (`m`, de
 * `message_request`): a loja do cupom, o código dele e o pedido confirmado depois de o cupom nascer (ele nasce junto
 * com o envio, depois da aprovação). Uma definição só, para Mensagens e Resultados ligarem os mesmos pedidos às
 * mesmas mensagens. Nenhum nome e nenhum telefone entram nisto: é o cupom no pedido.
 *
 * O cupom de uma mensagem é só dela (`uq_message_request_cupom`): um pedido casa com uma mensagem, no máximo, e a
 * junção não multiplica linhas. Os nomes `o` e `m` são os que a consulta de quem usa precisa dar às duas tabelas.
 */
export const PEDIDO_USOU_O_CUPOM_DA_MENSAGEM = sql`o.tenant_id = m.tenant_id and o.connected_account_id = m.coupon_account_id and o.coupon_code = m.coupon_code and m.coupon_created_at is not null and o.confirmed_at >= m.coupon_created_at`;
