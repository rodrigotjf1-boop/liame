import { z } from 'zod';
import { ChaveNoLugarDoCodigo } from './passkeys.js';
import { AutonomyMode, BudgetImpact, PolicyDecision, RiskLevel } from './policy.js';
import { PostResponse } from './posts.js';
import { ReviewItem } from './reviews.js';

// Pedido de ação (ADR-007): toda escrita fora do Liame passa por aqui. Risco, impacto e valores vêm
// do registro de ferramentas e do estado lido no provedor, nunca de quem pede.

const Slug = z.string().regex(/^[a-z0-9_]+$/).max(60);
const Ref = z.string().min(1).max(100);
const Micros = z.int().min(0).max(Number.MAX_SAFE_INTEGER);

export const ActionStatus = z.enum(['sombra', 'aguardando_aprovacao', 'aprovada', 'executando', 'executada', 'falhou', 'cancelada', 'expirada']);
export type ActionStatus = z.infer<typeof ActionStatus>;

export const CreateActionRequest = z.strictObject({
  tool: Slug,
  brand_id: z.uuid().nullable().optional(),
  provider: Slug,
  account_id: Ref,
  resource_id: Ref,
  params: z.record(z.string(), z.unknown()),
  /**
   * A recomendação do Gestor de tráfego de que o pedido nasce (A4, X3): o "Pedir esta mudança" da Atenção. O servidor
   * confere que ela está em aberto, é da mesma conta e da mesma campanha e vai na mesma direção do pedido.
   */
  recommendation_id: z.uuid().optional(),
});
export type CreateActionRequest = z.infer<typeof CreateActionRequest>;

export const UpdateActionRequest = z.strictObject({ params: z.record(z.string(), z.unknown()) });
export type UpdateActionRequest = z.infer<typeof UpdateActionRequest>;

/**
 * Aprovar exige confirmar agora (fora do chat, ADR-007), com a chave de acesso ou o código do app (D-A7-56), e o hash do
 * plano visto.
 */
export const ApproveActionRequest = z.strictObject({
  plan_hash: z.string().regex(/^[0-9a-f]{64}$/),
  code: z.string().regex(/^\d{6}$/, { error: 'Digite os 6 números do app' }).optional(),
  passkey: ChaveNoLugarDoCodigo,
});
export type ApproveActionRequest = z.infer<typeof ApproveActionRequest>;

/** Aprovar vários com um código (A6, Z11, parte 2c-2; D-A6-93): até este tanto de pedidos por vez. */
export const ACTIONS_BATCH_APPROVE_LIMIT = 50;

/**
 * Aprovar vários pedidos com uma confirmação só (A6, Z11, parte 2c-2; P38, D-A6-93 e D-A6-97). Hoje, só os pedidos sobre
 * um comentário que o lote aceita: responder a um elogio, a uma marcação ou a uma pergunta, e ocultar; nunca o que é de
 * uma reclamação (uma por vez) nem o comentário de tipo ainda não decidido. Cada item leva o hash do plano que a pessoa
 * viu. Tudo ou nada: com um item que não serve, nenhum é aprovado e a confirmação não é gasta (409 `lote-recusado`, com
 * o motivo de cada item em `errors`).
 */
export const ApproveActionsBatchRequest = z.strictObject({
  items: z
    .array(z.strictObject({ id: z.uuid(), plan_hash: z.string().regex(/^[0-9a-f]{64}$/) }))
    .min(1)
    .max(ACTIONS_BATCH_APPROVE_LIMIT),
  code: z.string().regex(/^\d{6}$/, { error: 'Digite os 6 números do app' }).optional(),
  passkey: ChaveNoLugarDoCodigo,
});
export type ApproveActionsBatchRequest = z.infer<typeof ApproveActionsBatchRequest>;

/**
 * Recusar (quem pode aprovar): o pedido sai da fila, nada é executado e o motivo fica no pedido e na auditoria.
 * O plano visto vai junto, como na aprovação: se o pedido mudou, a recusa não vale para a versão nova.
 */
export const RejectActionRequest = z.strictObject({
  plan_hash: z.string().regex(/^[0-9a-f]{64}$/),
  reason: z.string().trim().min(3, { error: 'Diga o motivo em poucas palavras' }).max(200),
});
export type RejectActionRequest = z.infer<typeof RejectActionRequest>;

export const ActionApproval = z.strictObject({
  approved_by: z.uuid(),
  approver_name: z.string(),
  approver_role: z.string(),
  sufficient: z.boolean(),
  /** A aprovação foi para o plano atual (se o plano mudou depois, ela não vale). */
  current_plan: z.boolean(),
  created_at: z.string(),
});

/**
 * A recomendação de que um pedido nasceu, com os números do retrato dela (os mesmos de Resultados na janela olhada):
 * é o porquê do pedido na tela de Aprovações. Dinheiro em micros, como texto.
 */
export const ActionRecommendation = z.strictObject({
  id: z.uuid(),
  /** A ação recomendada: `orcamento_reduzir`, `orcamento_aumentar` ou `campanha_pausar`. */
  tool: z.string(),
  /** A regra que recomendou e a versão do conjunto de regras. */
  rule: z.string(),
  rule_version: z.int().min(1),
  /** De 0 a 100, com uma casa. É evidência (gasto observado e margem conhecida), não probabilidade. */
  confidence_pct: z.string(),
  /** Só nas de verba: quanto a regra recomendou mudar, em porcento. */
  percent: z.int().min(0).max(100).nullable(),
  /** O dia da recomendação e a janela olhada (AAAA-MM-DD, no fuso da loja). */
  decided_on: z.string(),
  window: z.strictObject({ from: z.string(), to: z.string() }),
  /** A verba diária da campanha no dia da recomendação. */
  daily_budget_micros: z.string().nullable(),
  spend_micros: z.string().nullable(),
  /** Os pedidos, a receita e a margem do caixa na janela: nulos para quem não vê as vendas (`vendas.ver`). */
  orders: z.int().min(0).nullable(),
  revenue_micros: z.string().nullable(),
  margin_known_micros: z.string().nullable(),
  /** Parte da receita com margem conhecida, de 0 a 100, com uma casa. */
  margin_coverage_pct: z.string().nullable(),
});
export type ActionRecommendation = z.infer<typeof ActionRecommendation>;

/** A situação e a verba diária de um objeto de anúncio (a verba é nula quando não mora nele). */
const BudgetChangeState = z.strictObject({ status: z.string(), daily_micros: Micros.nullable() });

/**
 * O objeto de anúncio que um pedido muda, como foi lido na plataforma na hora do pedido: `campanha`, `conjunto` ou
 * `anuncio`, o nome dele e a campanha de que faz parte na lista do Liame (a própria, quando o objeto é a campanha; nula
 * se ela saiu da lista). É com a campanha que a tela abre um pedido novo ("Pedir de novo").
 */
export const ActionTarget = z.strictObject({
  kind: z.string(),
  name: z.string(),
  campaign: z.strictObject({ id: z.uuid(), name: z.string() }).nullable(),
});
export type ActionTarget = z.infer<typeof ActionTarget>;

/**
 * A tentativa de execução mais recente de um pedido. `status`: `executada`; `falhou` (a plataforma recusou na
 * conferência, e o motivo está em `status_reason`); `estado_mudou` (alguém mexeu no objeto depois do pedido: nada foi
 * sobrescrito, e `observed` diz como ele estava); `bloqueada` (trava, aprovação que deixou de valer ou escrita
 * desligada); ou `adiada` (a plataforma mandou esperar: `next_attempt_at` no pedido diz quando o Liame tenta de novo).
 */
const Contagem = z.int().min(0);
const Centavos = z.int().min(0);
/** O valor de uma variável do texto: `fixo` com o valor, ou o que o RegemCast preenche na hora (`primeiro_nome`…), sem valor. */
const MessageVariable = z.strictObject({ origin: Slug, value: z.string().nullable() });

/**
 * A mensagem de WhatsApp de um pedido de envio (A5, Y5; protótipo P15): o que a pessoa aprova. O texto é o do modelo
 * como a Meta o aprovou, na hora do pedido; o público vem com a conta de quem recebe; a janela é a do envio, no fuso da
 * conta do RegemCast; o cupom nasce no Regem junto com o envio; e `plan` é o plano do disparo guardado no pedido (as
 * pessoas, o custo como teto e o teto de gasto de mensagens). Só números e textos escritos pela loja ou pelo
 * RegemCast: nenhum telefone e nenhum nome de contato.
 */
export const ActionMessage = z.strictObject({
  /** O id da campanha no RegemCast (o mesmo de `GET /v1/messaging/campaigns/:id`). */
  campaign_id: z.string(),
  name: z.string(),
  template: z.strictObject({
    name: z.string(),
    language: z.string(),
    category: z.string().nullable(),
    header: z.string().nullable(),
    body: z.string(),
    footer: z.string().nullable(),
    buttons: z.array(z.string()),
  }),
  /** Em ordem: a primeira é `{{1}}` do texto. */
  variables: z.array(MessageVariable),
  header_variable: MessageVariable.nullable(),
  audience: z.strictObject({
    name: z.string(),
    rule: z.string().nullable(),
    /** Quantas pessoas do público podiam receber na hora do pedido, e quantas ficaram de fora pelo descanso. */
    can_receive: Contagem,
    resting: Contagem,
    rest_days: Contagem.nullable(),
  }),
  /** Os dias (0 = domingo) e o horário de envio, sempre dentro de 09:00 a 20:00. */
  window: z.strictObject({ days: z.array(z.int().min(0).max(6)), start: z.string(), end: z.string() }),
  coupon: z
    .strictObject({
      code: z.string(),
      /** `percentual`, `valor` ou `frete_gratis`. */
      kind: Slug,
      percent: z.number().nullable(),
      value_cents: Centavos.nullable(),
      min_order_cents: Centavos.nullable(),
      valid_from: z.string(),
      valid_until: z.string(),
      /** O cupom já existe no Regem (ele nasce junto com o envio). */
      created: z.boolean(),
    })
    .nullable(),
  /**
   * O pedido no destino (Hub DMS F5, parte D): a aprovação do envio é de uma pessoa no RegemCast, com o código do
   * aplicativo autenticador e o teto de gasto. Nulo (ou ausente) enquanto o pedido não foi feito, ou quando o envio é
   * aprovado no Liame.
   */
  destination: z
    .strictObject({
      /** `aguardando`, `aprovado`, `executando`, `executado`, `recusado`, `vencido`, `cancelado` ou `falhou`. */
      status: Slug,
      /** Até quando a pessoa pode aprovar lá (24 horas desde o pedido). */
      expires_at: z.string().nullable(),
      /** A tela de aprovação no RegemCast. */
      url: z.string().nullable(),
      /** O que quem recusou escreveu, ou o motivo do RegemCast (o plano mudou, o teto de gasto…). */
      reason: z.string().nullable(),
      /** Quando o Liame leu o pedido pela última vez. */
      checked_at: z.string().nullable(),
      /** O cupom da mensagem foi desativado no Regem porque a mensagem não saiu (F5-5). */
      coupon_deactivated: z.boolean(),
    })
    .nullable()
    .optional(),
  /** O plano do disparo guardado no pedido; nulo se o estado guardado não é o de uma mensagem. */
  plan: z
    .strictObject({
      /** A situação da campanha no RegemCast quando o plano foi lido. */
      status: Slug,
      /** Quantas pessoas ainda vão receber, e quantas a campanha tem ao todo. */
      people: Contagem,
      recipients: Contagem,
      /** O custo estimado do que ainda vai sair: é teto, a Meta só cobra a mensagem entregue. Nulo sem preço. */
      cost_cents: Centavos.nullable(),
      currency: z.string().nullable(),
      budget: z.strictObject({
        defined: z.boolean(),
        periods: z.array(z.strictObject({ period: Slug, label: z.string(), limit_cents: Centavos, spent_cents: Centavos, signal: Slug })),
        notice: z.string().nullable(),
      }),
    })
    .nullable(),
});
export type ActionMessage = z.infer<typeof ActionMessage>;

/**
 * Uma sugestão de resposta do Social media num pedido (A6, Z6; protótipo P31): o enfoque (um rótulo curto), o texto e a
 * rodada em que ela veio (1: a da avaliação nova; 2: a do "Pedir outras").
 */
export const ActionReviewSuggestion = z.strictObject({
  focus: z.string(),
  text: z.string(),
  round: z.int().min(1).max(2),
});
export type ActionReviewSuggestion = z.infer<typeof ActionReviewSuggestion>;

/**
 * A avaliação do Google de um pedido de resposta, ou de apagar a resposta (A6, Z2; protótipo P17). O pedido não guarda
 * o texto da avaliação nem nada de quem avaliou: o texto vem do que o Liame tem guardado dela agora (`current`), e o
 * nome de quem avaliou, só para a tela, de `GET /v1/reviews/authors`, pelo `id`.
 */
export const ActionReview = z.strictObject({
  /** O id da avaliação no Liame (o mesmo de `GET /v1/reviews`). */
  id: z.uuid(),
  /** A nota da avaliação na hora do pedido; nula se a avaliação já não existia no Google. */
  stars: z.int().min(1).max(5).nullable(),
  /** Só o dono da empresa aprova, recusa, altera e desfaz este pedido (a resposta a uma avaliação de 1 ou 2 estrelas). */
  owner_only: z.boolean(),
  /** O texto da resposta de que o pedido trata: o que será publicado ou, no pedido de apagar, o que sai do perfil. */
  reply_text: z.string().nullable(),
  /** A avaliação como o Liame a guarda agora, com a resposta que está no Google; nula quando ela saiu da guarda do Liame. */
  current: ReviewItem.nullable(),
  /**
   * A nota ou o texto da avaliação já não são os da hora do pedido (a pessoa editou o que escreveu). No pedido que
   * espera aprovação, a resposta foi escrita para a avaliação de antes: aprovada assim, ela não é publicada.
   */
  changed: z.boolean(),
  /**
   * As sugestões do Social media, no pedido que ele fez (A6, Z6; P31): a pessoa escolhe uma (o texto do pedido,
   * `reply_text`, é o escolhido, ou a versão que ela ajustou), e as da segunda rodada vêm antes das da primeira. Nulo
   * no pedido de uma pessoa e no de apagar a resposta.
   */
  suggestions: z.array(ActionReviewSuggestion).nullable().optional(),
  /**
   * Por que o Social media tirou este pedido de Aprovações, quando tirou (A6, Z6; P31), em código: `avaliacao_mudou` (a
   * avaliação foi editada depois das sugestões; as novas vêm num pedido novo) ou `respondida_no_google` (a avaliação
   * ganhou resposta direto no Google). Nulo quando ele não tirou. A lista pode crescer.
   */
  withdrawn: z
    .string()
    .regex(/^[a-z_]{2,40}$/)
    .nullable()
    .optional(),
  /**
   * O "Pedir outras", no pedido do Social media (A6, Z6; P31; uma vez por avaliação, D-A6-27), em código: `pode_pedir`
   * (o pedido espera a decisão e a segunda rodada ainda não foi pedida), `escrevendo` (ele está escrevendo as outras),
   * `feitas` (as outras já vieram e estão em `suggestions`, com `round` 2) ou `nao_deu` (a segunda rodada acabou sem
   * sugestão nova). Nulo no pedido de uma pessoa e no pedido decidido sem segunda rodada. A lista pode crescer.
   */
  more_suggestions: z
    .string()
    .regex(/^[a-z_]{2,40}$/)
    .nullable()
    .optional(),
  /**
   * Quando as outras sugestões foram pedidas (a segunda rodada nasceu), em ISO. A tela mede por ele quanto o Social
   * media já está escrevendo. Nulo enquanto ninguém pediu, e nos mesmos casos de `more_suggestions`.
   */
  more_suggestions_asked_at: z.iso.datetime().nullable().optional(),
});
export type ActionReview = z.infer<typeof ActionReview>;

/**
 * O post do pedido de publicar (A6, Z5c, parte 4; protótipo P19): o post como o Liame o guarda agora, o mesmo de
 * `GET /v1/posts/{id}` (a foto, o recorte, a hora, cada canal com a conta, o texto e a situação, e a situação do post),
 * com o fuso da empresa, em que a hora marcada se mostra. O texto, a foto e os canais não mudam depois do pedido (mudar é
 * outro post, D-A6-7): é o que a aprovação publica.
 */
export const ActionPost = PostResponse.extend({
  /** O fuso da empresa (a janela das 8h às 22h é nele). */
  timezone: z.string().min(1).max(64),
});
export type ActionPost = z.infer<typeof ActionPost>;

/**
 * O comentário do pedido de responder, apagar a resposta, ocultar ou mostrar (A6, Z11, parte 2c; P38): o que a tela de
 * Aprovações mostra. O pedido não guarda o texto do comentário nem nada de quem comentou (só um resumo do texto): o
 * texto, o @ ou o nome e o post saem do que o Liame guarda do comentário agora (`social_comment`, 90 dias). Nulo nos
 * outros pedidos.
 */
export const ActionComment = z.strictObject({
  /** O id do comentário na rede (o mesmo de `GET /v1/comments`). */
  id: z.string().min(1).max(120),
  /** `instagram` ou `facebook`. A lista pode crescer (V23). */
  channel: z.string().regex(/^[a-z_]{2,40}$/),
  /** O que o pedido faz: `responder`, `apagar_resposta`, `ocultar` ou `mostrar`. A lista pode crescer (V23). */
  operation: z.string().regex(/^[a-z_]{2,40}$/),
  /** O texto da resposta de que o pedido trata: o que será publicado ou, no pedido de apagar, o que sai do post. */
  reply_text: z.string().nullable(),
  /**
   * O comentário como o Liame o guarda agora: o @ ou o nome de quem comentou (nulo quando a rede não manda), o texto, a
   * hora, o tipo, se está oculto e a resposta da marca que está lá. Nulo quando ele saiu da guarda do Liame (apagado na
   * rede, a conta desligada ou passado o prazo de 90 dias).
   */
  current: z
    .strictObject({
      author: z.string().nullable(),
      message: z.string(),
      published_at: z.iso.datetime(),
      kind: z.string().regex(/^[a-z_]{2,40}$/).nullable(),
      hidden: z.boolean(),
      brand_reply: z.string().nullable(),
    })
    .nullable(),
  /**
   * O post de onde veio o comentário (a legenda com até 280 caracteres, e reticências quando é maior); nulo quando não
   * está mais no Liame.
   */
  post: z
    .strictObject({
      id: z.string().min(1).max(80),
      caption: z.string(),
      permalink: z.string().nullable(),
      thumbnail_url: z.string().nullable(),
      published_at: z.iso.datetime(),
    })
    .nullable(),
  /**
   * O texto do comentário, lido na rede depois do pedido, já não é o da hora do pedido (quem comentou editou, na Página).
   * A resposta foi escrita para o texto de antes: aprovada assim, ela não é publicada (a versão mudou). Falso enquanto o
   * Liame não leu o comentário de novo.
   */
  changed: z.boolean(),
  /**
   * O porquê, em código, quando o Social media tirou o pedido de Aprovações porque o comentário mudou (A6, Z11, parte
   * 2d-5): `respondido_na_rede`, `oculto_na_rede`, `ja_oculto`, `comentario_mudou` ou `comentario_sumiu`. Nulo nos
   * outros pedidos. A lista pode crescer (V23).
   */
  withdrawn: z
    .string()
    .regex(/^[a-z_]{2,40}$/)
    .nullable()
    .optional(),
  /**
   * As sugestões do Social media no pedido de responder que ele escreveu (A6, Z11, partes 2d e 3c): uma na pergunta,
   * três na reclamação (uma por caminho). A pessoa escolhe uma (o texto do pedido, `reply_text`, é o escolhido, ou a
   * versão que ela ajustou), e as da rodada 2 vêm antes das da rodada 1. Nulo no pedido de uma pessoa, na resposta pronta
   * (o elogio e a marcação) e nos outros pedidos.
   */
  suggestions: z.array(ActionReviewSuggestion).nullable().optional(),
  /**
   * O "Pedir outra", no pedido do Social media que tem sugestões (A6, Z11, parte 3c; uma vez por comentário, D-A6-88),
   * em código: `pode_pedir`, `escrevendo`, `feitas` (as novas estão em `suggestions`, com `round` 2) ou `nao_deu`. Os
   * mesmos códigos de `review.more_suggestions`. Nulo nos outros pedidos e no decidido sem rodada 2. A lista pode crescer.
   */
  more_suggestions: z
    .string()
    .regex(/^[a-z_]{2,40}$/)
    .nullable()
    .optional(),
  /** Quando a outra sugestão foi pedida (a rodada 2 nasceu), em ISO; nulo nos mesmos casos de `more_suggestions`. */
  more_suggestions_asked_at: z.iso.datetime().nullable().optional(),
});
export type ActionComment = z.infer<typeof ActionComment>;

export const ActionExecution = z.strictObject({
  status: z.string(),
  finished_at: z.string(),
  /** O objeto já estava como o pedido queria: nada foi escrito (e não há o que desfazer). */
  no_write: z.boolean(),
  observed: BudgetChangeState.nullable(),
  /**
   * O que a plataforma respondeu ao recusar, nas palavras dela (`text`; o Google escreve em inglês) e com o código
   * dela, quando há (`code`: `campaignBudgetError.MONEY_AMOUNT_TOO_LARGE`). Nulo quando a execução não foi recusada
   * por ela, ou quando o motivo em `status_reason` é uma frase do Liame (a autorização venceu, o objeto sumiu).
   */
  provider_reply: z.strictObject({ text: z.string(), code: z.string().nullable() }).nullable().optional(),
});
export type ActionExecution = z.infer<typeof ActionExecution>;

export const ActionResponse = z.strictObject({
  id: z.uuid(),
  tool: z.string(),
  action: z.string(),
  brand_id: z.uuid().nullable(),
  provider: z.string(),
  account_id: z.string(),
  resource_id: z.string(),
  params: z.record(z.string(), z.unknown()),
  risk_level: RiskLevel,
  budget_impact: BudgetImpact,
  value_micros: Micros.nullable(),
  current_value_micros: Micros.nullable(),
  reserved_micros: Micros,
  plan_hash: z.string(),
  mode: AutonomyMode,
  status: ActionStatus,
  status_reason: z.string().nullable(),
  /**
   * O que impede a aprovação agora, no pedido que espera aprovação (A5, Y5: a mensagem cujo modelo a Meta ainda
   * analisa, ou que não cabe no teto de gasto de mensagens do mês). Com ele, a aprovação é recusada (409
   * `pedido-impedido`) e a tela não oferece aprovar; nulo quando nada impede.
   */
  blocked_reason: z.string().nullable().optional(),
  /**
   * Quantas vezes a execução esperou a plataforma (limite de uso da conta, fora do ar). A ação aprovada volta para a
   * fila com a hora da próxima tentativa, em vez de insistir; depois de seis esperas, falha.
   */
  attempts: z.int().min(0),
  /** Quando a execução tenta de novo; nulo quando não está esperando. */
  next_attempt_at: z.string().nullable(),
  /** A ação que este pedido desfaz (a volta), ou nulo. */
  undoes: z.uuid().nullable(),
  /** O pedido de volta mais recente desta ação (em qualquer situação), ou nulo. */
  undone_by: z.strictObject({ id: z.uuid(), status: ActionStatus }).nullable(),
  policy: PolicyDecision,
  approvals: z.array(ActionApproval),
  /** Estado durável do fluxo (ADR-005): política → orçamento → aprovação → execução. */
  workflow: z.strictObject({
    status: z.enum(['em_andamento', 'aguardando', 'concluido', 'falhou', 'cancelado']),
    steps: z.array(
      z.strictObject({
        name: z.string(),
        status: z.enum(['aguardando', 'concluido', 'falhou', 'pulado']),
        attempts: z.int(),
        finished_at: z.string().nullable(),
      }),
    ),
  }).nullable(),
  expires_at: z.string(),
  created_at: z.string(),
  /** A última mudança de situação (pedido, aprovação, recusa, execução). */
  updated_at: z.string(),
  /** Quem pediu; no pedido de um funcionário de IA (`agent_key`), a pessoa que o deixou pedir. */
  requested_by: z.strictObject({ id: z.uuid(), name: z.string() }),
  /** A conta do alvo, para a tela: a loja do Liame (ou o nome da conta conectada); nula quando a conta não é do Liame (sandbox). */
  account_name: z.string().nullable(),
  /** A campanha citada nos parâmetros (`campaign_id`), quando há; nula se ela saiu da lista. */
  campaign: z.strictObject({ id: z.uuid(), name: z.string(), provider: z.string(), status: z.string() }).nullable(),
  /** A recomendação do Gestor de tráfego de que o pedido nasceu (A4, X3); nula no pedido comum. */
  recommendation: ActionRecommendation.nullable().optional(),
  /**
   * O funcionário de IA que fez o pedido, no modo Aprovação (a chave dele em Sua equipe: `trafego`); nulo no pedido de
   * uma pessoa. No pedido do funcionário, `requested_by` é a pessoa que o deixou pedir (quem publicou a regra do modo).
   */
  agent_key: Slug.nullable().optional(),
  /** O objeto de anúncio do pedido (A4, X8); nulo no pedido que não é de anúncio (o cupom, o sandbox). */
  target: ActionTarget.nullable().optional(),
  /** A situação e a verba do objeto na hora do pedido, e como o pedido quer deixar; nulos sem `target`. */
  from: BudgetChangeState.nullable().optional(),
  to: BudgetChangeState.nullable().optional(),
  /** A tentativa de execução mais recente; nula enquanto o executor não pegou o pedido. */
  execution: ActionExecution.nullable().optional(),
  /** A mensagem de WhatsApp do pedido de envio ou de pausa (A5, Y5); nula nos outros pedidos. */
  message: ActionMessage.nullable().optional(),
  /** A avaliação do Google do pedido de resposta ou de apagar a resposta (A6, Z2); nula nos outros pedidos. */
  review: ActionReview.nullable().optional(),
  /** O post do pedido de publicar (A6, Z5c); nulo nos outros pedidos e quando o post não está mais no Liame. */
  post: ActionPost.nullable().optional(),
  /** O comentário do pedido de responder, apagar a resposta, ocultar ou mostrar (A6, Z11); nulo nos outros pedidos. */
  comment: ActionComment.nullable().optional(),
});
export type ActionResponse = z.infer<typeof ActionResponse>;

export const ActionListResponse = z.strictObject({ items: z.array(ActionResponse) });
export type ActionListResponse = z.infer<typeof ActionListResponse>;

export const ActionListQuery = z.strictObject({ status: ActionStatus.optional() });
export type ActionListQuery = z.infer<typeof ActionListQuery>;

// ------------------------------------------------------------------ orçamento

export const BudgetPolicyRequest = z.strictObject({ brand_id: z.uuid().nullable().default(null), limit_micros: Micros });
export type BudgetPolicyRequest = z.infer<typeof BudgetPolicyRequest>;

export const BudgetEnvelope = z.strictObject({
  brand_id: z.uuid().nullable(),
  limit_micros: Micros,
  /** Reservado e ainda não liberado (inclui o já executado). */
  committed_micros: Micros,
  executed_micros: Micros,
  available_micros: z.int(),
});

export const BudgetResponse = z.strictObject({ period: z.string(), envelopes: z.array(BudgetEnvelope) });
export type BudgetResponse = z.infer<typeof BudgetResponse>;

// ------------------------------------------------------------------ verba do mês (A4, X4)

/** Dia no fuso da empresa (AAAA-MM-DD). */
const Dia = z.iso.date();

/**
 * Os dois limites que a empresa define para o Liame mexer em verba (D-A4-22), sempre juntos: o teto do mês (tudo o que
 * as contas conectadas podem gastar em anúncios no mês) e o teto por campanha (a maior verba diária que um aumento
 * pode deixar numa campanha ou num conjunto). O teto por campanha é por dia e não passa do teto do mês.
 */
export const BudgetLimitsRequest = z.strictObject({
  month_micros: z.int().min(1_000_000, { error: 'O teto do mês começa em R$ 1,00' }).max(Number.MAX_SAFE_INTEGER),
  campaign_daily_micros: z.int().min(1_000_000, { error: 'O teto por campanha começa em R$ 1,00' }).max(Number.MAX_SAFE_INTEGER),
  /**
   * A divisão do teto do mês por plataforma (D-A4-36), com a função `verba_por_plataforma` ligada para a empresa.
   * Ausente: a divisão fica como está (com divisão, `month_micros` precisa ser a soma das partes). Nulo: tira a divisão.
   * Lista: a divisão nova, com uma parte para cada plataforma de anúncio conectada, e `month_micros` igual à soma delas.
   */
  platform_parts: z
    .array(
      z.strictObject({
        provider: z.enum(['meta_ads', 'google_ads']),
        micros: z.int().min(1_000_000, { error: 'A parte de cada plataforma começa em R$ 1,00' }).max(Number.MAX_SAFE_INTEGER),
      }),
    )
    .min(1)
    .max(8)
    .nullable()
    .optional(),
});
export type BudgetLimitsRequest = z.infer<typeof BudgetLimitsRequest>;

/** O gasto de uma plataforma no mês, somando as contas conectadas dela. */
export const BudgetMonthPlatform = z.strictObject({
  provider: z.string(),
  accounts: z.int().min(1),
  /** Do primeiro dia do mês até `read_through`. */
  spend_micros: Micros,
  /** O ritmo: a média dos 7 dias inteiros mais recentes que a leitura cobre. */
  daily_micros: Micros,
  /** O gasto lido mais o ritmo vezes os dias que a leitura ainda não cobre, até o fim do mês. */
  forecast_micros: Micros,
  /** O último dia inteiro que as leituras cobrem (o mais antigo entre as contas); nulo se alguma nunca foi lida. */
  read_through: Dia.nullable(),
  /** Quantos dias entram na previsão pelo ritmo; nulo quando as contas da plataforma foram lidas até dias diferentes. */
  forecast_days: z.int().min(0).nullable(),
  /** A leitura de hoje ainda não chegou em alguma conta: o gasto vale só até `read_through`. */
  stale: z.boolean(),
  /** A leitura boa mais antiga entre as contas; nula se alguma nunca foi lida. */
  last_success_at: z.iso.datetime().nullable(),
  /**
   * Mudar campanhas pelo Liame está ligado para alguma conta conectada desta plataforma (a mesma flag que o pedido
   * confere). Com `false`, o Liame só lê a plataforma nesta empresa. Opcional: a resposta de antes de 09/10/2026 não traz.
   */
  writes: z.boolean().optional(),
  /**
   * A parte desta plataforma no teto do mês (D-A4-36), quando a empresa dividiu o teto; nula sem divisão ou quando a
   * plataforma ficou fora dela (conectada depois). `pending_micros`: os aumentos e as retomadas de hoje nesta plataforma,
   * até o fim do mês. `remaining_micros`: parte − previsão − `pending_micros` (negativo quando a plataforma passa da
   * parte). Opcional: a resposta de antes de 04/11/2026 não traz.
   */
  part: z.strictObject({ micros: Micros, pending_micros: Micros, remaining_micros: z.int() }).nullable().optional(),
});
export type BudgetMonthPlatform = z.infer<typeof BudgetMonthPlatform>;

/** O gasto de um dia do mês, somando as contas de anúncio que a leitura cobre naquele dia. */
export const BudgetMonthDay = z.strictObject({
  day: Dia,
  spend_micros: Micros,
  /** As plataformas com alguma conta que a leitura não cobre neste dia: o gasto delas entra na previsão, pelo ritmo. */
  missing: z.array(z.string()),
});
export type BudgetMonthDay = z.infer<typeof BudgetMonthDay>;

/**
 * A conferência mais recente de uma mudança (D-A4-24): o que a leitura do dia mostrou do objeto e quanto ele gastou. O
 * gasto é conferido pela semana (os dias comparados, o gasto neles e o que a verba de cada dia permite), não pelo dia.
 */
export const BudgetChangeCheck = z.strictObject({
  checked_on: Dia,
  /**
   * `confere`; `mudou` (a plataforma mostra outra situação ou outra verba: alguém mudou lá depois, e não é erro); ou
   * `acima` (o objeto gastou mais do que a verba permite nos dias comparados, ou gastou depois de pausado).
   */
  status: z.string().regex(/^[a-z_]{1,30}$/),
  /** Desde que dia a conferência dá este resultado, sem interrupção. */
  since: Dia,
  /** Como a leitura do dia mostra o objeto; a situação é nula quando ele saiu da lista da conta. */
  informed_status: z.string().nullable(),
  informed_daily_micros: Micros.nullable(),
  window: z.strictObject({ from: Dia, to: Dia }),
  window_spend_micros: Micros,
  /** Nulo quando a verba não mora no objeto: não há com o que comparar. */
  window_allowed_micros: Micros.nullable(),
  /** Os dias inteiros depois do dia da mudança, e o gasto neles (a média "depois da mudança"). */
  days_after: z.int().min(0),
  spend_after_micros: Micros,
});
export type BudgetChangeCheck = z.infer<typeof BudgetChangeCheck>;

/** Uma mudança que o Liame executou numa plataforma de anúncio, com a conferência dela. */
/** Um ritmo da semana na Verba do mês: a semana, a situação e quantas mudanças de verba o Liame fez por ele no mês. */
export const BudgetMonthRhythm = z.strictObject({
  id: z.uuid(),
  /** `aprovado`, `parado` ou `encerrado`. */
  status: z.string(),
  week: z.strictObject({ from: Dia, to: Dia }),
  /** O pedido da semana em Aprovações. */
  action_id: z.uuid().nullable(),
  /** As mudanças de verba feitas pelo ritmo no mês (os passos de cada dia e os da volta) e em quantos objetos. */
  steps: z.int(),
  objects: z.int(),
});
export type BudgetMonthRhythm = z.infer<typeof BudgetMonthRhythm>;

export const BudgetMonthChange = z.strictObject({
  action_id: z.uuid(),
  executed_at: z.iso.datetime(),
  /** O dia da execução, no fuso da empresa. */
  executed_on: Dia,
  tool: z.string(),
  /** `orcamento.aumentar`, `orcamento.reduzir`, `campanha.pausar`… */
  action: z.string(),
  provider: z.string(),
  account_id: z.string(),
  /** O objeto: `campanha`, `conjunto` ou `anuncio`, com o nome lido na hora do pedido e a campanha de que faz parte. */
  target: z.strictObject({ kind: z.string(), name: z.string(), campaign_name: z.string().nullable() }),
  from: BudgetChangeState,
  to: BudgetChangeState,
  requested_by: z.strictObject({ id: z.uuid(), name: z.string() }),
  /** O funcionário de IA que fez o pedido (modo Aprovação); nulo no pedido de uma pessoa. */
  agent_key: Slug.nullable(),
  /** A ação que este pedido desfez (a volta), ou nulo. */
  undoes: z.uuid().nullable(),
  /** Nula enquanto a primeira conferência não roda: a mudança de hoje só tem gasto para conferir amanhã. */
  check: BudgetChangeCheck.nullable(),
  /** Outro pedido do Liame mudou o mesmo objeto depois: esta mudança deixou de valer e não é mais conferida. */
  superseded_by: z.strictObject({ action_id: z.uuid(), executed_at: z.iso.datetime() }).nullable(),
});
export type BudgetMonthChange = z.infer<typeof BudgetMonthChange>;

/**
 * A verba do mês (D-A4-19): o que as contas de anúncio conectadas já gastaram no mês, a previsão de fechamento pelo
 * ritmo dos últimos 7 dias, os aumentos e as retomadas pedidos ou feitos hoje (que o ritmo ainda não mostra) e os dois
 * limites da empresa. O pedido que faz o gasto subir só passa se a previsão, com ele, couber no teto do mês.
 * Dinheiro em micros da moeda das contas, sempre em centavos inteiros: as parcelas somam o total que a tela mostra.
 */
export const BudgetMonthResponse = z.strictObject({
  /** O mês corrente no fuso da empresa (`2026-10`). */
  period: z.string().regex(/^\d{4}-\d{2}$/),
  timezone: z.string(),
  today: Dia,
  month_start: Dia,
  month_end: Dia,
  /** Ontem: o último dia com gasto quando as contas foram lidas hoje. */
  through: Dia,
  /** De hoje ao fim do mês, contando hoje. */
  days_left: z.int().min(1).max(31),
  currency: z.string(),
  spend_micros: Micros,
  daily_micros: Micros,
  forecast_micros: Micros,
  /** Os dias previstos pelo ritmo, quando são os mesmos em todas as contas; senão, nulo. */
  forecast_days: z.int().min(0).nullable(),
  /** Aumentos e retomadas pedidos (esperando aprovação ou execução) ou feitos hoje: quanto somam por dia. */
  pending_daily_micros: Micros,
  /** O mesmo, até o fim do mês (`pending_daily_micros` × `days_left`). */
  pending_micros: Micros,
  limits: z.strictObject({
    /** O teto do mês; nulo enquanto a empresa não define. */
    month_micros: Micros.nullable(),
    /** O teto por campanha (verba diária); nulo enquanto a empresa não define. */
    campaign_daily_micros: Micros.nullable(),
    /** Quem definiu os limites por último, e quando. */
    set_by: z.strictObject({ id: z.uuid(), name: z.string() }).nullable(),
    set_at: z.iso.datetime().nullable(),
    /**
     * A divisão do teto do mês por plataforma (D-A4-36): a parte de cada uma, cuja soma é `month_micros`; nula sem
     * divisão. `provider`: `meta_ads` ou `google_ads` (a lista pode crescer). Opcional: a resposta de antes de 04/11/2026
     * não traz.
     */
    platform_parts: z
      .array(z.strictObject({ provider: z.string().regex(/^[a-z_]{2,30}$/), micros: Micros }))
      .nullable()
      .optional(),
    /** A função `verba_por_plataforma` está ligada para a empresa (a tela oferece dividir). Opcional, como a de cima. */
    platform_parts_enabled: z.boolean().optional(),
    /**
     * A divisão que o plano do trimestre aprovado mais recente propõe (D-A4-38): a verba de cada plataforma por mês, para
     * o formulário oferecer "Usar a divisão do plano". Só para quem muda os limites, com a função ligada; nula sem plano
     * aprovado. Opcional, como as de cima.
     */
    plan_parts: z
      .array(z.strictObject({ provider: z.string().regex(/^[a-z_]{2,30}$/), micros: Micros }))
      .nullable()
      .optional(),
  }),
  /** O que sobra do teto do mês: teto − previsão − aumentos de hoje. Negativo quando o mês passa do teto; nulo sem teto. */
  remaining_micros: z.int().nullable(),
  platforms: z.array(BudgetMonthPlatform),
  /**
   * O gasto de cada dia, do primeiro dia do mês ao último que alguma conta cobre (o desenho "o mês, dia a dia"); a soma
   * é `spend_micros`. Vazio quando ainda não há dia inteiro lido neste mês. Opcional: a resposta de antes de
   * 07/10/2026 não traz, e a tela fica com a barra do teto.
   */
  days: z.array(BudgetMonthDay).optional(),
  /** As regras da distribuição que a tela cita (valem para todas as empresas); nulas se a regra deixar de existir. */
  rules: z.strictObject({
    /** Quanto um pedido pode mexer na verba diária, em %. */
    change_percent_max: z.number().min(0).max(1000).nullable(),
    /** Mudanças de verba no mesmo objeto por janela. */
    rate_limit: z.strictObject({ max: z.int().min(1), window_minutes: z.int().min(1) }).nullable(),
  }),
  /**
   * O que o Liame mudou nas plataformas de anúncio neste mês e, de antes dele, o que continua valendo e sendo
   * conferido (as 100 mudanças mais recentes, da mais nova para a mais antiga). Cada uma é conferida todo dia com o
   * que a plataforma informa e com o que ela gastou (D-A4-24).
   */
  changes: z.array(BudgetMonthChange),
  /**
   * O ritmo da semana no mês (plano da região, R7): cada ritmo com passos feitos no mês, do mais novo ao mais antigo. O
   * pedido da semana e os passos diários dele não entram em `changes` (são dezenas por semana): ficam aqui, juntos.
   * Opcional: a resposta de antes de 13/11/2026 não traz.
   */
  rhythms: z.array(BudgetMonthRhythm).optional(),
  /**
   * As mudanças que continuam valendo e cuja conferência mais recente (de hoje ou de ontem) diz que o objeto gastou
   * mais do que a verba permite: o mesmo aviso da Atenção, já em palavras, para a faixa do topo da tela.
   */
  overspend: z.array(z.strictObject({ action_id: z.uuid(), title: z.string(), detail: z.string(), action: z.string() })),
  /**
   * A maior verba diária entre as campanhas e os conjuntos ativos das contas em que o Liame muda verba, pela leitura
   * mais recente; nula quando nenhum tem verba diária. Ajuda a escolher o teto por campanha.
   */
  largest_daily_micros: Micros.nullable(),
  generated_at: z.iso.datetime(),
});
export type BudgetMonthResponse = z.infer<typeof BudgetMonthResponse>;

// ------------------------------------------------------------------ o pedido de mudança (A4, X8)

/** Um pedido em aberto (esperando aprovação, aprovado ou executando), para a tela não deixar pedir o mesmo duas vezes. */
export const ActionOpenRequest = z.strictObject({
  id: z.uuid(),
  tool: z.string(),
  /** `orcamento.aumentar`, `orcamento.reduzir`, `campanha.pausar`, `conjunto.retomar`… */
  action: z.string(),
  resource_id: z.string(),
  status: ActionStatus,
  /** A verba diária pedida, nos pedidos de verba. */
  value_micros: Micros.nullable(),
  created_at: z.iso.datetime(),
});
export type ActionOpenRequest = z.infer<typeof ActionOpenRequest>;

export const ActionTargetsQuery = z.strictObject({ brand_id: z.uuid() });
export type ActionTargetsQuery = z.infer<typeof ActionTargetsQuery>;

/**
 * Onde dá para pedir uma mudança numa marca (A4, X8; D-A4-20): as campanhas das contas de anúncio em que a escrita do
 * Liame está ligada para a empresa, com os pedidos em aberto de cada uma. A campanha de uma plataforma que o Liame só
 * lê, ou de uma conta com a escrita desligada, não aparece: nela não há botão de pedir.
 */
export const ActionTargetsResponse = z.strictObject({
  campaigns: z.array(
    z.strictObject({
      campaign_id: z.uuid(),
      /**
       * `ligada`, ou `so_leitura` quando a autorização desta conta não pediu para gerenciar anúncios (ela é de antes de
       * a escrita ser ligada): é conectar a plataforma de novo em Contas conectadas.
       */
      write: z.string(),
      /** Os pedidos em aberto na campanha, nos conjuntos e nos anúncios dela, do mais novo para o mais antigo. */
      open: z.array(ActionOpenRequest),
    }),
  ),
});
export type ActionTargetsResponse = z.infer<typeof ActionTargetsResponse>;

/** Um objeto de anúncio como o pedido o vê: `resource_id` é o do pedido (`campanha:123`, `conjunto:456`, `anuncio:789`). */
export const AdObject = z.strictObject({
  resource_id: Ref,
  /** `campanha`, `conjunto` ou `anuncio`. */
  kind: z.string(),
  name: z.string(),
  /** `ativo`, `pausado`, `arquivado`, `removido` ou `desconhecido`. */
  status: z.string(),
  /** A verba diária que mora no objeto; nula quando ela fica em outro nível, quando é de período e em todo anúncio. */
  daily_micros: Micros.nullable(),
});
export type AdObject = z.infer<typeof AdObject>;

/**
 * A verba dividida (A5, Y3; D-A5-4). No Google Ads a verba não mora na campanha: mora num orçamento que pode servir a
 * várias. O Liame nunca muda um orçamento dividido (mudar a verba de uma campanha mudaria a das outras sem ninguém
 * pedir): a tela diz com quem a campanha divide, e nela só cabe pausar e retomar.
 */
export const SharedBudget = z.strictObject({
  /** A média diária do orçamento inteiro; nula quando ele é de período. */
  daily_micros: Micros.nullable(),
  /** Quantas campanhas usam o orçamento agora, como a plataforma informa (contando esta). */
  campaigns: z.int().min(0),
  /**
   * Os nomes das outras campanhas que usam o orçamento, em ordem alfabética (até 10). Vazia quando só esta usa (o
   * orçamento foi criado para ser dividido) e quando a plataforma não respondeu a tempo: o pedido segue sem os nomes.
   */
  shared_with: z.array(z.string()),
});
export type SharedBudget = z.infer<typeof SharedBudget>;

export const ActionOptionsQuery = z.strictObject({
  campaign_id: z.uuid(),
  /** O objeto escolhido na gaveta: um conjunto ou um anúncio desta campanha (o `resource_id` dele). Sem ele, a campanha. */
  target: Ref.optional(),
});
export type ActionOptionsQuery = z.infer<typeof ActionOptionsQuery>;

/**
 * As opções do pedido de mudança numa campanha (A4, X8; D-A4-20): o objeto escolhido lido AGORA na plataforma, para o
 * pedido partir do que está valendo; o que dá para pedir nele; os conjuntos e os anúncios da campanha, pela leitura
 * diária; e os pedidos em aberto. Os limites da empresa e a conta do mês vêm de `GET /v1/budget/month`.
 */
export const ActionOptionsResponse = z.strictObject({
  campaign: z.strictObject({
    id: z.uuid(),
    name: z.string(),
    provider: z.string(),
    brand_id: z.uuid(),
    /** A conta conectada da campanha: o `account_id` do pedido. */
    account_id: z.uuid(),
    account_name: z.string(),
  }),
  target: AdObject.extend({
    /** A situação de entrega que a plataforma informa (`CAMPAIGN_PAUSED` quando o pai está em pausa, por exemplo). */
    effective_status: z.string().nullable(),
    /** A verba do objeto é dividida com outras campanhas (só no Google Ads); nulo quando a verba é só dele. */
    shared_budget: SharedBudget.nullable().optional(),
  }),
  /** Quando o objeto foi lido na plataforma (agora). */
  read_at: z.iso.datetime(),
  /**
   * As ferramentas que cabem no objeto como ele está agora, na ordem da tela: `orcamento_ajustar` (só com verba diária
   * própria) e pausar, ou retomar. Vazia quando o objeto foi arquivado ou removido na plataforma.
   */
  tools: z.array(Slug),
  /**
   * Os conjuntos e os anúncios da campanha pela leitura diária: a situação e a verba são as da última leitura. Vazias
   * na plataforma em que o pedido só cabe na campanha inteira (o Google Ads).
   */
  ad_sets: z.array(AdObject),
  ads: z.array(AdObject.extend({ /** O conjunto do anúncio (o `resource_id` dele). */ ad_set: Ref.nullable() })),
  /** Quando a lista foi vista pela última vez na plataforma; nulo se a conta ainda não foi lida. */
  listed_at: z.iso.datetime().nullable(),
  /** Os pedidos em aberto na campanha, nos conjuntos e nos anúncios dela, do mais novo para o mais antigo. */
  open: z.array(ActionOpenRequest),
});
export type ActionOptionsResponse = z.infer<typeof ActionOptionsResponse>;

// ------------------------------------------------------------------ sandbox

export const SandboxResourceRequest = z.strictObject({ account_id: Ref, resource_id: Ref, state: z.record(z.string(), z.unknown()) });
export type SandboxResourceRequest = z.infer<typeof SandboxResourceRequest>;

export const SandboxResourceResponse = z.strictObject({
  account_id: z.string(),
  resource_id: z.string(),
  state: z.record(z.string(), z.unknown()),
  version: z.int(),
});
export type SandboxResourceResponse = z.infer<typeof SandboxResourceResponse>;
