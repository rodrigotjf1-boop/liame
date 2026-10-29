import { randomBytes, randomUUID } from 'node:crypto';
import { uuidv7 } from '@liame/database';
import { PREFIXO_RETIRADA } from '../../src/actions/action.service.js';
import { recursoDaAvaliacao } from '../../src/actions/perfil-avaliacao.js';
import { ownerQuery } from './api.js';

// O trabalho do Social media nas respostas às avaliações (A6, Z6), gravado direto no banco para Sua equipe: a loja do
// Perfil, a avaliação, o pedido de resposta em Aprovações e a vez de cada avaliação na fila (`review_suggestion`). O
// caminho de verdade (a leitura do Google abre a vez, a rotina chama o modelo, confere e pede; a pessoa aprova com o
// código do app e a resposta vai ao Google) está provado em `sugestoes-de-resposta.spec.ts` e
// `avaliacao-resposta.spec.ts`. As linhas são gravadas como a produção grava (V158).

type Alvo = { tenantId: string; brandId: string; userId: string };

/** A situação do pedido de resposta semeado. */
export type RespostaSemeada = 'aguardando' | 'executada' | 'recusada' | 'retirada' | 'cancelada' | 'expirada' | 'falhou';

const SITUACAO: Record<RespostaSemeada, { status: string; motivo: (codigo: string) => string | null }> = {
  aguardando: { status: 'aguardando_aprovacao', motivo: () => null },
  executada: { status: 'executada', motivo: () => null },
  // Os motivos são os que `action.service.ts` grava: a recusa de quem aprova, a retirada pelo funcionário (com o código
  // dela) e o cancelamento de quem opera.
  recusada: { status: 'cancelada', motivo: () => 'recusada por Pessoa de Teste: Prefiro responder eu mesmo' },
  retirada: { status: 'cancelada', motivo: (codigo) => `${PREFIXO_RETIRADA}${codigo}` },
  cancelada: { status: 'cancelada', motivo: () => 'cancelada por quem opera' },
  expirada: { status: 'expirada', motivo: () => 'ninguém aprovou no prazo' },
  falhou: { status: 'falhou', motivo: () => 'O Google recusou a resposta.' },
};

/** Uma loja do Perfil no Google (a conta `google_business`) na marca. Devolve o id. */
export async function lojaDoPerfil(alvo: Pick<Alvo, 'tenantId' | 'brandId'>): Promise<string> {
  const id = randomUUID();
  await ownerQuery(
    `insert into liame.connected_account (id, tenant_id, brand_id, provider, external_id, name, currency, timezone)
     values ($1, $2, $3, 'google_business', $4, 'Hamburgueria do Centro', 'BRL', 'America/Sao_Paulo')`,
    [id, alvo.tenantId, alvo.brandId, `locations/${randomBytes(6).toString('hex')}`],
  );
  return id;
}

/** Uma avaliação da loja, com a nota dada, feita há `haMinutos`. Devolve o id. */
export async function avaliacaoDaLoja(alvo: Pick<Alvo, 'tenantId' | 'brandId'>, loja: string, estrelas: number, haMinutos = 30): Promise<string> {
  const id = randomUUID();
  await ownerQuery(
    `insert into liame.profile_review (id, tenant_id, brand_id, connected_account_id, external_id, stars, comment, reviewed_at, changed_at)
     values ($1, $2, $3, $4, $5, $6, 'Chegou tudo certinho e quente.', now() - make_interval(mins => $7), now() - make_interval(mins => $7))`,
    [id, alvo.tenantId, alvo.brandId, loja, `rv-${randomBytes(6).toString('hex')}`, estrelas, haMinutos],
  );
  return id;
}

/**
 * Um pedido de resposta do Social media em Aprovações, já na situação dada, com a vez da primeira rodada pronta e ligada
 * a ele. `haMinutos` empurra o pedido para trás no tempo; `venceuHaMinutos`: o prazo da aprovação já passou, e a rotina
 * de expirar ainda não chegou nele. Devolve o id do pedido e o da avaliação.
 */
export async function semearPedidoDoSocial(
  alvo: Alvo,
  loja: string,
  o: {
    situacao: RespostaSemeada;
    estrelas?: number;
    haMinutos?: number;
    /** Há quantos minutos o pedido mudou de situação (aprovado, recusado, retirado…); sem isto, na hora em que nasceu. */
    decididaHaMinutos?: number;
    aprovadaPor?: string;
    /** O código da retirada (`avaliacao_mudou`, `respondida_no_google`). */
    retirada?: string;
    venceuHaMinutos?: number;
    /** O funcionário que pediu (o Social media, se nada for dito): outro serve para provar que só os dele contam. */
    funcionario?: string | null;
  },
): Promise<{ pedido: string; avaliacao: string }> {
  const minutos = o.haMinutos ?? 1;
  const avaliacao = await avaliacaoDaLoja(alvo, loja, o.estrelas ?? 5, minutos + 30);
  const pedido = uuidv7();
  const { status, motivo } = SITUACAO[o.situacao];
  const prazo = o.venceuHaMinutos === undefined ? 72 * 60 : -o.venceuHaMinutos;
  const funcionario = o.funcionario === undefined ? 'social' : o.funcionario;
  await ownerQuery(
    `insert into liame.action_request (id, tenant_id, brand_id, tool, action, provider, account_id, resource_id, params, risk_level, budget_impact,
                                       value_micros, current_value_micros, reserved_micros, desired_state, plan_hash, action_fingerprint, mode,
                                       policy_decision, status, status_reason, actor_type, agent_key, requested_by, expires_at, created_at, updated_at)
     values ($1, $2, $3, 'avaliacao_responder', 'avaliacao.responder', 'google_business', $4, $5, '{}'::jsonb, 'R2', 'none',
             null, null, 0, '{}'::jsonb, $6, $7, 'APPROVAL',
             '{"allowed": true, "mode": "APPROVAL", "violations": [], "versions": ["plataforma@6"]}'::jsonb, $8, $9, $10, $11, $12,
             now() + make_interval(mins => $13), now() - make_interval(mins => $14), now() - make_interval(mins => $15))`,
    [
      pedido,
      alvo.tenantId,
      alvo.brandId,
      loja,
      recursoDaAvaliacao(avaliacao),
      randomBytes(32).toString('hex'),
      randomBytes(32).toString('hex'),
      status,
      motivo(o.retirada ?? 'avaliacao_mudou'),
      funcionario ? 'agent' : 'human',
      funcionario,
      alvo.userId,
      prazo,
      minutos,
      o.decididaHaMinutos ?? minutos,
    ],
  );
  if (o.aprovadaPor) {
    await ownerQuery(
      `insert into liame.approval (id, tenant_id, action_request_id, plan_hash, approved_by, approver_role, approver_limit_micros, sufficient, method)
       select $1, r.tenant_id, r.id, r.plan_hash, $2, 'dono', null, true, 'totp' from liame.action_request r where r.id = $3`,
      [randomUUID(), o.aprovadaPor, pedido],
    );
  }
  // A vez da primeira rodada, pronta, com o pedido que saiu dela (só a do Social media: o pedido de uma pessoa não tem vez).
  if (funcionario === 'social') {
    await ownerQuery(
      `insert into liame.review_suggestion (id, tenant_id, brand_id, review_id, round, status, suggestions, action_id, created_at, updated_at, finished_at)
       values ($1, $2, $3, $4, 1, 'pronta', 2, $5, now() - make_interval(mins => $6 + 1), now() - make_interval(mins => $6), now() - make_interval(mins => $6))`,
      [uuidv7(), alvo.tenantId, alvo.brandId, avaliacao, pedido, minutos],
    );
  }
  return { pedido, avaliacao };
}

/**
 * A vez de uma avaliação na fila do Social media, na situação dada: `esperando` (com o porquê, quando há), `barrada`
 * (com os nomes do que barrou) ou `pronta` na segunda rodada (o "Pedir outras", com quem pediu). Devolve o id da vez.
 */
export async function semearVezDoSocial(
  alvo: Alvo,
  avaliacao: string,
  o: { status: 'esperando' | 'barrada' | 'pronta'; motivo?: string; barradaPor?: string[]; rodada?: 1 | 2; pedidaPor?: string; haMinutos?: number },
): Promise<string> {
  const id = uuidv7();
  const minutos = o.haMinutos ?? 1;
  await ownerQuery(
    `insert into liame.review_suggestion (id, tenant_id, brand_id, review_id, round, status, reason, barred_by, suggestions, requested_by, next_attempt_at, created_at, updated_at, finished_at)
     values ($1, $2, $3, $4, $5, $6::text, $7, $8::text[], $9, $10, case when $6::text = 'esperando' then now() end,
             now() - make_interval(mins => $11), now() - make_interval(mins => $11), case when $6::text <> 'esperando' then now() - make_interval(mins => $11) end)`,
    [id, alvo.tenantId, alvo.brandId, avaliacao, o.rodada ?? 1, o.status, o.motivo ?? null, o.barradaPor ?? null, o.status === 'pronta' ? 2 : null, o.pedidaPor ?? null, minutos],
  );
  return id;
}
