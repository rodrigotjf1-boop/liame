import type { Tx } from '@liame/database';
import { type SQL, sql } from 'drizzle-orm';
import type { RegraDoCupom } from '../actions/regem-cupom.js';

// As datas do cupom de uma mensagem (A5, Y6; decisão do dono em 10/10/2026; migration 0065). O cupom vale por tantos
// dias, contando o dia do envio, e o texto da mensagem diz a validade em dias. O pedido nasce antes (a Meta analisa o
// modelo, uma pessoa aprova): as datas guardadas com ele dizem só por quantos dias o cupom vale, até o envio fixá-las.

/** O fuso da loja do cupom de um pedido; o de São Paulo quando a loja não informa (ou foi desconectada). */
const FUSO_DA_LOJA = sql`coalesce((select a.timezone from liame.connected_account a where a.id = m.coupon_account_id), 'America/Sao_Paulo')`;

/**
 * As datas que o cupom teria se a mensagem saísse hoje: do dia de hoje, na loja do cupom, pelos mesmos dias da regra
 * (contando o primeiro e o último). Para a consulta que tem `liame.message_request m`.
 */
export const DATAS_SE_SAIR_HOJE: { de: SQL; ate: SQL } = {
  de: sql`(now() at time zone ${FUSO_DA_LOJA})::date::text`,
  ate: sql`((now() at time zone ${FUSO_DA_LOJA})::date + ((m.coupon_rule ->> 'valido_ate')::date - (m.coupon_rule ->> 'valido_de')::date))::text`,
};

/**
 * Fixa as datas do cupom do pedido no dia de hoje, uma vez só, e devolve a regra que vale (a fixada agora, ou a que
 * já estava). Quem chama está numa transação da empresa que confirma logo, à parte da execução do envio: se a execução
 * cair depois de o Regem criar o cupom, a nova tentativa manda a mesma regra, e o Regem devolve o mesmo cupom. Nulo
 * quando o pedido não é desta empresa ou não leva cupom.
 */
export async function fixarDatasDoCupom(tx: Tx, alvo: { tenantId: string; pedidoId: string }): Promise<RegraDoCupom | null> {
  const fixada = await tx.execute<{ coupon_rule: RegraDoCupom }>(sql`
    update liame.message_request m
       set coupon_rule = m.coupon_rule || jsonb_build_object('valido_de', ${DATAS_SE_SAIR_HOJE.de}, 'valido_ate', ${DATAS_SE_SAIR_HOJE.ate}),
           coupon_dated_on = (now() at time zone ${FUSO_DA_LOJA})::date,
           updated_at = now()
     where m.id = ${alvo.pedidoId} and m.tenant_id = ${alvo.tenantId}
       and m.coupon_rule is not null and m.coupon_dated_on is null and m.coupon_created_at is null
    returning m.coupon_rule`);
  if (fixada.rows[0]) return fixada.rows[0].coupon_rule;
  const guardada = await tx.execute<{ coupon_rule: RegraDoCupom | null }>(sql`
    select m.coupon_rule from liame.message_request m where m.id = ${alvo.pedidoId} and m.tenant_id = ${alvo.tenantId}`);
  return guardada.rows[0]?.coupon_rule ?? null;
}
