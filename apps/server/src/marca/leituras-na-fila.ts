import type { Tx } from '@liame/database';
import { sql } from 'drizzle-orm';

// A fila do Pesquisador vista de fora da leitura (A3, I12; P25 aprovado em 21/10/2026). Arquivo sem serviço do Nest,
// para Sua equipe usar sem importar o serviço do pedido (que importa o gateway de IA).

/**
 * O Pesquisador foi ligado de novo nesta marca (em Sua equipe): os pedidos que esperavam por ele voltam para a fila na
 * hora, sem o motivo da espera, em vez de esperar a volta marcada (até seis horas, `worker/pesquisa-loop.ts`). Na
 * transação de quem ligou. Devolve quantos voltaram.
 */
export async function acordarLeiturasDaMarca(tx: Tx, brandId: string): Promise<number> {
  const r = await tx.execute(sql`
    update liame.research_request set reason = null, next_attempt_at = now(), updated_at = now()
     where brand_id = ${brandId} and status = 'pendente' and reason = 'funcionario_desligado'`);
  return r.rowCount ?? 0;
}
