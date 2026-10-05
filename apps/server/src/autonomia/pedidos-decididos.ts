import type { Tx } from '@liame/database';
import { sql } from 'drizzle-orm';
import { PREFIXO_RECUSA } from '../actions/action.service.js';
import { type DesfechoDoPedido, desfechoDoPedido } from '../sombra/autonomia.js';

/** A chave de uma conta e ação da sombra, para juntar o que se lê de cada uma. */
export const chaveDoPar = (conta: string, tool: string): string => `${conta}|${tool}`;

/**
 * Os pedidos decididos que nasceram de uma recomendação do Gestor de tráfego (A4, X3), por conta e ação da
 * recomendação, do mais novo para o mais antigo. É a evidência dos portões da Aprovação: quem pediu pode ter sido uma
 * pessoa (em Sugerir) ou o próprio funcionário (em Aprovação); o que conta é o que uma pessoa decidiu sobre o pedido.
 * Ficam de fora o que ainda espera decisão e o que foi retirado por quem pediu.
 *
 * Serve à rotina (em escopo de sistema, com a empresa na consulta) e à tela (sob a RLS da empresa).
 */
export async function pedidosDecididos(tx: Tx, alvo: { tenantId: string; brandId: string }): Promise<Map<string, DesfechoDoPedido[]>> {
  const r = await tx.execute<{ connected_account_id: string; tool: string; status: string; recusado: boolean }>(sql`
    select d.connected_account_id, d.tool, r.status,
           (r.status = 'cancelada' and starts_with(coalesce(r.status_reason, ''), ${PREFIXO_RECUSA})) as recusado
      from liame.action_request r
      join liame.shadow_decision d on d.id = r.shadow_decision_id
     where r.tenant_id = ${alvo.tenantId} and d.tenant_id = ${alvo.tenantId} and d.brand_id = ${alvo.brandId}
       and r.status in ('aprovada', 'executando', 'executada', 'falhou', 'expirada', 'cancelada')
     order by r.created_at desc, r.id desc`);
  const porPar = new Map<string, DesfechoDoPedido[]>();
  for (const l of r.rows) {
    const desfecho = desfechoDoPedido(l);
    if (!desfecho) continue;
    const chave = chaveDoPar(l.connected_account_id, l.tool);
    const lista = porPar.get(chave) ?? [];
    lista.push(desfecho);
    porPar.set(chave, lista);
  }
  return porPar;
}
