import type { Tx } from '@liame/database';
import { sql } from 'drizzle-orm';

/**
 * O funcionário está ligado para esta empresa (e esta marca)? A linha da marca vale mais que a da empresa;
 * sem linha nenhuma, vale o padrão da definição. A flag `ia` continua sendo a chave geral: isto decide
 * QUAL funcionário trabalha, não se a IA está ligada.
 */
export async function funcionarioAtivo(
  tx: Tx,
  alvo: { tenantId: string; brandId?: string | null; agentKey: string; ativoPorPadrao: boolean },
): Promise<boolean> {
  const r = await tx.execute<{ enabled: boolean }>(sql`
    select enabled from liame.agent_activation
     where tenant_id = ${alvo.tenantId} and agent_key = ${alvo.agentKey} and (brand_id is null or brand_id = ${alvo.brandId ?? null})
     order by (brand_id is not null) desc
     limit 1`);
  return r.rows[0]?.enabled ?? alvo.ativoPorPadrao;
}
