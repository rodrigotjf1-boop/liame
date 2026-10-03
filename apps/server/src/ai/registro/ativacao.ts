import type { Tx } from '@liame/database';
import { sql } from 'drizzle-orm';

/**
 * O funcionário está ligado para esta empresa (e esta marca)? Duas chaves: a da distribuição (`agent_activation`,
 * pelo plano: a linha da marca vale mais que a da empresa e, sem linha, vale o padrão da definição) e a da própria
 * empresa (`agent_pause`, I13b: desligado na marca por alguém da empresa). A flag `ia` continua sendo a chave
 * geral: isto decide QUAL funcionário trabalha, não se a IA está ligada.
 */
export async function funcionarioAtivo(
  tx: Tx,
  alvo: { tenantId: string; brandId?: string | null; agentKey: string; ativoPorPadrao: boolean },
): Promise<boolean> {
  const peloPlano = await ativoPeloPlano(tx, alvo);
  if (!peloPlano || !alvo.brandId) return peloPlano;
  return !(await desligadoPelaEmpresa(tx, { tenantId: alvo.tenantId, brandId: alvo.brandId, agentKey: alvo.agentKey }));
}

/** A chave da distribuição (`agent_activation`): a linha da marca vale mais que a da empresa; sem linha, o padrão. */
export async function ativoPeloPlano(tx: Tx, alvo: { tenantId: string; brandId?: string | null; agentKey: string; ativoPorPadrao: boolean }): Promise<boolean> {
  const r = await tx.execute<{ enabled: boolean }>(sql`
    select enabled from liame.agent_activation
     where tenant_id = ${alvo.tenantId} and agent_key = ${alvo.agentKey} and (brand_id is null or brand_id = ${alvo.brandId ?? null})
     order by (brand_id is not null) desc
     limit 1`);
  return r.rows[0]?.enabled ?? alvo.ativoPorPadrao;
}

/** A empresa desligou este membro da equipe nesta marca (I13b)? Vale também para quem trabalha por regra (Relatórios, Gestor de tráfego). */
export async function desligadoPelaEmpresa(tx: Tx, alvo: { tenantId: string; brandId: string; agentKey: string }): Promise<boolean> {
  const r = await tx.execute(sql`
    select 1 from liame.agent_pause
     where tenant_id = ${alvo.tenantId} and brand_id = ${alvo.brandId} and agent_key = ${alvo.agentKey} and resumed_at is null
     limit 1`);
  return r.rows.length > 0;
}
