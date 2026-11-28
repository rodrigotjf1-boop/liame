import { type SQL, sql } from 'drizzle-orm';

// O custo do item que conta para a margem (Resultados, a Atenção, o ranking dos produtos do plano de conteúdo). O Regem
// mandou o custo ZERO quando o produto não tinha custo cadastrado (até 26/11/2026; desde a correção do custo manual no
// Regem, #1393, manda nulo): na Mister Burgers, 6.684 dos 6.855 itens com custo das 4 semanas até 27/11/2026 tinham zero.
// Contado como custo, o zero dava a margem igual à receita. A regra única: o custo só é conhecido quando é maior que zero.
// A coluna gerada `cost_known` (migration 0021) diz só "não é nulo" e não serve para a margem.

/** O item tem o custo do Regem para a margem: maior que zero. `alias` é o apelido de `order_item_fact` na consulta. */
export function custoConhecido(alias: 'i'): SQL {
  return sql.raw(`(coalesce(${alias}.cost_micros, 0) > 0)`);
}
