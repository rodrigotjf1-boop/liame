import { randomBytes, randomUUID } from 'node:crypto';
import { uuidv7 } from '@liame/database';
import { ownerQuery } from './api.js';

/** A situação do pedido de envio semeado (as mesmas palavras de `pedidos-semeados.ts`). */
export type MensagemSemeada = 'executada' | 'aprovada' | 'falhou' | 'recusada' | 'cancelada' | 'expirada' | 'aguardando';

const SITUACAO: Record<MensagemSemeada, { status: string; motivo: string | null }> = {
  executada: { status: 'executada', motivo: null },
  aprovada: { status: 'aprovada', motivo: null },
  falhou: { status: 'falhou', motivo: 'O RegemCast recusou o envio: o modelo desta campanha foi pausado pela Meta.' },
  // Os dois motivos são os que `action.service.ts` grava: a recusa de quem aprova e o cancelamento de quem opera.
  recusada: { status: 'cancelada', motivo: 'recusada por Pessoa de Teste: Quero outro texto' },
  cancelada: { status: 'cancelada', motivo: 'cancelada por quem opera' },
  expirada: { status: 'expirada', motivo: 'ninguém aprovou no prazo' },
  aguardando: { status: 'aguardando_aprovacao', motivo: null },
};

/** Uma conta do RegemCast conectada à marca, direto no banco (a conexão de verdade está provada em `mensageria-rotas.spec.ts`). */
export async function contaDoRegemcast(alvo: { tenantId: string; brandId: string }): Promise<string> {
  const id = randomUUID();
  await ownerQuery(
    `insert into liame.connected_account (id, tenant_id, brand_id, provider, external_id, name, currency, timezone) values ($1, $2, $3, 'regemcast', $4, 'WhatsApp da loja', 'BRL', 'America/Sao_Paulo')`,
    [id, alvo.tenantId, alvo.brandId, randomUUID()],
  );
  return id;
}

/**
 * Uma mensagem que o funcionário de CRM e mensageria propôs, já na situação dada: o pedido de envio no trilho de ação
 * (em nome do funcionário) e o retrato da mensagem. Gravado direto no banco, porque o caminho de verdade (montar o
 * rascunho no RegemCast, pedir, aprovar com o código do app e disparar) está provado em `mensagem-proposta.spec.ts` e
 * em `mensagem-pedido.spec.ts`. `cupom`: a loja do Regem, o código e desde quando ele existe (nulo: ainda não nasceu).
 * `haMinutos` empurra o pedido para trás no tempo. Devolve o id do pedido de ação.
 */
export async function semearMensagemDoCrm(
  alvo: { tenantId: string; brandId: string; userId: string; conta: string },
  o: {
    situacao: MensagemSemeada;
    nome?: string;
    pessoas?: number;
    cupom?: { loja: string; codigo: string; nascido: string | null };
    haMinutos?: number;
    /** Há quantos minutos o pedido mudou de situação (aprovado e enviado, recusado…); sem isto, na mesma hora em que nasceu. */
    decididaHaMinutos?: number;
    aprovadaPor?: string;
    /** O funcionário que propôs (o CRM e mensageria, se nada for dito): outro serve para provar que só as dele contam. */
    funcionario?: string;
    /** O prazo da aprovação já acabou há tantos minutos, e a rotina de expirar ainda não passou pelo pedido. */
    venceuHaMinutos?: number;
  },
): Promise<string> {
  const acao = uuidv7();
  const campanha = randomUUID();
  const { status, motivo } = SITUACAO[o.situacao];
  const minutos = o.haMinutos ?? 1;
  const decidida = o.decididaHaMinutos ?? minutos;
  const funcionario = o.funcionario ?? 'crm';
  // Em minutos a partir de agora: 72 horas à frente, ou já no passado.
  const prazo = o.venceuHaMinutos === undefined ? 72 * 60 : -o.venceuHaMinutos;
  await ownerQuery(
    `insert into liame.action_request (id, tenant_id, brand_id, tool, action, provider, account_id, resource_id, params, risk_level, budget_impact,
                                       value_micros, current_value_micros, reserved_micros, desired_state, plan_hash, action_fingerprint, mode,
                                       policy_decision, status, status_reason, actor_type, agent_key, requested_by, expires_at, created_at, updated_at)
     values ($1, $2, $3, 'mensagem_disparar', 'mensagem.disparar', 'regemcast', $4, $5, '{}'::jsonb, 'R3', 'none',
             null, null, 0, '{}'::jsonb, $6, $7, 'APPROVAL',
             '{"allowed": true, "mode": "APPROVAL", "violations": [], "versions": ["plataforma@6"]}'::jsonb, $8, $9, 'agent', $13, $10,
             now() + make_interval(mins => $14), now() - make_interval(mins => $11), now() - make_interval(mins => $12))`,
    [acao, alvo.tenantId, alvo.brandId, alvo.conta, `mensagem:${campanha}`, randomBytes(32).toString('hex'), randomBytes(32).toString('hex'), status, motivo, alvo.userId, minutos, decidida, funcionario, prazo],
  );
  if (o.aprovadaPor) {
    await ownerQuery(
      `insert into liame.approval (id, tenant_id, action_request_id, plan_hash, approved_by, approver_role, approver_limit_micros, sufficient, method)
       select $1, r.tenant_id, r.id, r.plan_hash, $2, 'dono', null, true, 'totp' from liame.action_request r where r.id = $3`,
      [uuidv7(), o.aprovadaPor, acao],
    );
  }
  const c = o.cupom ?? null;
  await ownerQuery(
    `insert into liame.message_request (id, tenant_id, brand_id, connected_account_id, campaign_id, action_request_id, name, template_name, template_language, template_body,
                                        audience, audience_name, people_can_receive, people_resting, window_days, window_start, window_end,
                                        coupon_account_id, coupon_code, coupon_rule, coupon_created_at, actor_type, agent_key, requested_by, created_at, updated_at)
     values (gen_random_uuid(), $1, $2, $3, $4, $5, $6, 'combo_sexta_v1', 'pt_BR', 'Oi, {{1}}! Use o cupom {{2}}.', '{"origem":"publico","id":"p"}'::jsonb, 'Quem pediu nos últimos 30 dias',
             $7, 0, '{0,1,2,3,4,5,6}', '09:00', '20:00', $8, $9, $10::jsonb, $11::timestamptz, 'agent', $14, $12,
             now() - make_interval(mins => $13), now() - make_interval(mins => $13))`,
    [alvo.tenantId, alvo.brandId, alvo.conta, campanha, acao, o.nome ?? 'Sexta em dobro', o.pessoas ?? 412, c?.loja ?? null, c?.codigo ?? null, c ? JSON.stringify({ codigo: c.codigo }) : null, c?.nascido ?? null, alvo.userId, minutos, funcionario],
  );
  return acao;
}
