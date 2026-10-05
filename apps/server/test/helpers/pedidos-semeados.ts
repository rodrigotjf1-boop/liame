import { randomBytes } from 'node:crypto';
import { uuidv7 } from '@liame/database';
import { ownerQuery } from './api.js';

/**
 * A situação de um pedido semeado: `executada` e `aprovada` (uma pessoa aprovou), `falhou` (aprovado, e a execução
 * terminou em erro), `recusada` (uma pessoa recusou), `expirada` (ninguém decidiu no prazo), `retirada` (cancelado por
 * quem pediu: não conta como decisão) e `aguardando` (ainda sem decisão).
 */
export type PedidoSemeado = 'executada' | 'aprovada' | 'falhou' | 'recusada' | 'expirada' | 'retirada' | 'aguardando';

const SITUACAO: Record<PedidoSemeado, { status: string; motivo: string | null }> = {
  executada: { status: 'executada', motivo: null },
  aprovada: { status: 'aprovada', motivo: null },
  falhou: { status: 'falhou', motivo: 'A Meta recusou a mudança: o orçamento diário precisa ser de pelo menos R$ 6,00.' },
  recusada: { status: 'cancelada', motivo: 'recusada por Pessoa de Teste: agora não' },
  expirada: { status: 'expirada', motivo: 'ninguém aprovou no prazo' },
  retirada: { status: 'cancelada', motivo: 'cancelada por quem opera' },
  aguardando: { status: 'aguardando_aprovacao', motivo: null },
};

/**
 * Pedidos de ação ligados a uma recomendação do Gestor de tráfego, já na situação dada: a evidência dos portões da
 * Aprovação (A4, X3). São gravados direto no banco, porque dez pedidos decididos pelo caminho de verdade (pedido,
 * código do app, execução na plataforma) estão provados em `meta-ferramentas.spec.ts` e em `modo-aprovacao.spec.ts`.
 * A lista vai do mais novo para o mais antigo; `haMinutos` empurra o lote inteiro para trás no tempo.
 */
export async function semearPedidos(
  alvo: { tenantId: string; brandId: string; conta: string; userId: string; recomendacao: string },
  pedidos: PedidoSemeado[],
  haMinutos = 0,
): Promise<string[]> {
  const ids: string[] = [];
  for (const [i, pedido] of pedidos.entries()) {
    const id = uuidv7();
    const { status, motivo } = SITUACAO[pedido];
    await ownerQuery(
      `insert into liame.action_request (id, tenant_id, brand_id, tool, action, provider, account_id, resource_id, params, risk_level, budget_impact,
                                         value_micros, current_value_micros, reserved_micros, desired_state, plan_hash, action_fingerprint, mode,
                                         policy_decision, status, status_reason, requested_by, expires_at, created_at, updated_at, shadow_decision_id)
       values ($1, $2, $3, 'orcamento_ajustar', 'orcamento.reduzir', 'meta_ads', $4, $5, '{"daily_budget_micros": 27000000}'::jsonb, 'R3', 'decrease',
               27000000, 30000000, 0, '{}'::jsonb, $6, $7, 'APPROVAL',
               '{"allowed": true, "mode": "APPROVAL", "violations": [], "versions": ["plataforma@3"]}'::jsonb, $8, $9, $10,
               now() + interval '72 hours', now() - make_interval(mins => $11), now() - make_interval(mins => $11), $12)`,
      [
        id,
        alvo.tenantId,
        alvo.brandId,
        alvo.conta,
        `campanha:${1_000_000 + Math.floor(Math.random() * 8_000_000)}${i}`,
        randomBytes(32).toString('hex'),
        randomBytes(32).toString('hex'),
        status,
        motivo,
        alvo.userId,
        haMinutos + i + 1,
        alvo.recomendacao,
      ],
    );
    ids.push(id);
  }
  return ids;
}
