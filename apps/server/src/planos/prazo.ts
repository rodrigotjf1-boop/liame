import type { PlanContent } from '@liame/contracts';
import type { Tx } from '@liame/database';
import { type SQL, sql } from 'drizzle-orm';

// O que a geração do Estrategista (worker) e as rotas dos planos calculam igual no banco (A3, I11).

/** Prazo para decidir um plano: três dias (o do plano de 90 dias espera a decisão do dono; até lá, o mesmo). */
const PRAZO = sql.raw(`interval '72 hours'`);

/**
 * Até quando o plano espera a decisão: três dias e, na oferta e na pauta, nunca depois do que o plano propõe (a oferta
 * expira na hora em que começa; a pauta, no fim do primeiro dia dela), no fuso da loja.
 */
export function prazoDoPlano(c: PlanContent, fuso: string, agora: Date): SQL {
  const tresDias = sql`${agora.toISOString()}::timestamptz + ${PRAZO}`;
  if (c.kind === 'oferta') return sql`least(${tresDias}, (${c.day}::date + ${c.starts_at}::time) at time zone ${fuso})`;
  if (c.kind === 'pauta') return sql`least(${tresDias}, (${c.days[0]!.day}::date + 1)::timestamp at time zone ${fuso})`;
  return tresDias;
}

/** Os nomes que vieram dos dados da marca (campanhas e contas): citar um nome não é falar de política (Compliance). */
export async function nomesDaMarca(tx: Tx, brandId: string): Promise<string[]> {
  const r = await tx.execute<{ name: string }>(sql`
    select c.name from liame.campaign c join liame.connected_account a on a.id = c.connected_account_id where a.brand_id = ${brandId}
    union select a.name from liame.connected_account a where a.brand_id = ${brandId} and a.name is not null`);
  return r.rows.map((x) => x.name);
}
