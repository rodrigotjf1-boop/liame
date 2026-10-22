import { z } from 'zod';

// Avaliações do Google (A6, Z1; `plano-a6.md` D-A6-5; protótipo P17, aprovado em 09/10/2026). O que a tela Avaliações
// lê: a nota da empresa no Google, as avaliações que o Liame guardou das lojas do perfil ligadas (a nota, o texto, as
// datas e a resposta da empresa com a situação dela no Google) e, à parte e só para a tela, o nome de quem avaliou,
// lido do Google na hora e nunca guardado. Só leitura: responder uma avaliação é um pedido de ação (Z2).
// Listas que crescem vão como texto na resposta (V23).

const Slug = z.string().regex(/^[a-z0-9_]+$/).max(60);
const Contagem = z.int().min(0);

export const ReviewsQuery = z.strictObject({ brand_id: z.uuid() });
export type ReviewsQuery = z.infer<typeof ReviewsQuery>;

/** A resposta da empresa a uma avaliação, como o Google a tem. */
export const ReviewReply = z.strictObject({
  text: z.string(),
  /** `pendente` (o Google ainda confere), `aprovada` (está no ar), `recusada` (o Google não publicou) ou `desconhecida`. */
  state: Slug,
  changed_at: z.iso.datetime().nullable(),
  /** O motivo da recusa, no código do Google (`policyViolation`); nulo quando ele não diz. */
  violation: z.string().nullable(),
});
export type ReviewReply = z.infer<typeof ReviewReply>;

export const ReviewItem = z.strictObject({
  id: z.uuid(),
  /** A loja do perfil (a conta ligada) em que a avaliação foi feita. */
  store_id: z.uuid(),
  stars: z.int().min(1).max(5),
  /** O que a pessoa escreveu; nulo quando ela só deu a nota. */
  text: z.string().nullable(),
  reviewed_at: z.iso.datetime(),
  /** A última mudança da avaliação no Google (a nota, o texto ou a resposta). */
  changed_at: z.iso.datetime(),
  reply: ReviewReply.nullable(),
});
export type ReviewItem = z.infer<typeof ReviewItem>;

/** Uma loja do perfil da empresa no Google ligada à marca, com a leitura dela. */
export const ReviewStore = z.strictObject({
  id: z.uuid(),
  name: z.string(),
  /** `ativa`, `sem_permissao`, `erro` ou `desconectada`, como as outras contas ligadas. */
  status: Slug,
  status_reason: z.string().nullable(),
  /** A nota média (1 a 5) e o total de avaliações que o Google informa da loja; nulos antes da primeira leitura. */
  rating: z.number().min(1).max(5).nullable(),
  review_count: Contagem.nullable(),
  /** A última leitura boa das avaliações desta loja; nula antes da primeira. */
  read_at: z.iso.datetime().nullable(),
  /** A leitura espera o Google (a cota acabou, ou ele ainda não liberou o acesso): até quando; nula quando não espera. */
  waiting_until: z.iso.datetime().nullable(),
});
export type ReviewStore = z.infer<typeof ReviewStore>;

export const ReviewsSummary = z.strictObject({
  /** A nota da empresa no Google: a da loja ou, com mais de uma, a média das lojas pesada pelo total de cada uma. */
  rating: z.number().min(1).max(5).nullable(),
  /** Todas as avaliações que o Google conta, e não só as que o Liame guardou. */
  review_count: Contagem.nullable(),
  /** Entre as avaliações guardadas (as que mudaram nos últimos 12 meses): quantas seguem sem resposta, e a mais antiga delas. */
  unanswered: Contagem,
  oldest_unanswered_at: z.iso.datetime().nullable(),
  /** As avaliações feitas nos últimos 30 dias: quantas e a nota média delas (nula sem nenhuma). */
  last_30_days: z.strictObject({ count: Contagem, average: z.number().min(1).max(5).nullable() }),
});
export type ReviewsSummary = z.infer<typeof ReviewsSummary>;

/**
 * Onde está a sugestão de resposta do Social media de uma avaliação sem resposta (A6, Z6, parte 4a; protótipo P31), para
 * a tela Avaliações, em código: `escrevendo` (a vez espera a rotina do Social media), `limite_dia` ou `limite_mes` (o
 * teto de gasto de IA da empresa, do dia ou do mês, foi atingido, e a vez espera) ou `barrada` (a conferência barrou as
 * sugestões, e nenhuma aparece). A sugestão que passou é o pedido em `pending_replies`. A lista pode crescer.
 */
export const ReviewSuggestionTurn = z.strictObject({
  review_id: z.uuid(),
  state: Slug,
  /** Quando a rotina olha esta avaliação de novo; nulo na barrada. */
  next_at: z.iso.datetime().nullable(),
  /**
   * Na barrada, as regras da conferência que barraram, em código (`regras_da_resposta`, `regras_da_liame`,
   * `regras_da_marca`, `numeros`, `politica_da_empresa`); nulo nas outras. A lista pode crescer.
   */
  barred_by: z.array(Slug).nullable(),
});
export type ReviewSuggestionTurn = z.infer<typeof ReviewSuggestionTurn>;

/** As sugestões de resposta do Social media nesta marca (A6, Z6, parte 4a; P31). */
export const ReviewSuggestions = z.strictObject({
  /**
   * `ligadas`; ou, em código, por que não estão: `funcao_desligada` (as sugestões não estão ligadas para a empresa),
   * `ia_desligada` (a IA da empresa) ou `funcionario_desligado` (o Social media está desligado nesta marca, em Sua
   * equipe). A lista pode crescer.
   */
  state: Slug,
  /** As avaliações sem resposta cuja sugestão ainda espera ou não saiu; vazia com as sugestões desligadas. */
  turns: z.array(ReviewSuggestionTurn),
});
export type ReviewSuggestions = z.infer<typeof ReviewSuggestions>;

export const ReviewsResponse = z.strictObject({
  brand_id: z.uuid(),
  /**
   * O que a tela mostra: `desligada` (a função não está ligada para a empresa); `sem_perfil` (nenhuma loja do perfil
   * ligada: o caminho é Contas conectadas); `sem_permissao` (o Google está conectado, mas a autorização não inclui o
   * perfil); `esperando_google` (a empresa autorizou, e o Google ainda não liberou o acesso do Liame ao perfil); ou
   * `pronta` (há loja ligada: as listas abaixo valem).
   */
  state: Slug,
  stores: z.array(ReviewStore),
  /** Nulo fora do estado `pronta`. */
  summary: ReviewsSummary.nullable(),
  /** As sem resposta primeiro, das notas mais baixas para as mais altas; depois as outras, da mais recente para a mais antiga. */
  reviews: z.array(ReviewItem),
  /** Há mais avaliações guardadas do que as devolvidas (a lista traz até 200). */
  has_more: z.boolean(),
  /**
   * As respostas que esperam a aprovação de uma pessoa (A6, Z2): a avaliação, o pedido em Aprovações
   * (`/aprovacoes?pedido={action_id}`) e se só o dono decide. Vazia com a função de responder desligada.
   */
  pending_replies: z
    .array(
      z.strictObject({
        review_id: z.uuid(),
        action_id: z.uuid(),
        owner_only: z.boolean(),
        /** Quantas sugestões do Social media o pedido traz, as da rodada mais nova (A6, Z6; P31); nulo no pedido de uma pessoa. */
        suggestions: z.int().min(1).max(2).nullable().optional(),
      }),
    )
    .optional(),
  /**
   * Responder pelo Liame está ligado para a marca (a função `perfil_google_write`, A6 · Z2): a tela oferece
   * "Responder" a quem pode pedir ações. Desligado, a resposta é dada no próprio Google.
   */
  can_reply: z.boolean().optional(),
  /**
   * As sugestões de resposta do Social media (A6, Z6, parte 4a; P31): se estão ligadas nesta marca, ou por que não, e a
   * vez de cada avaliação sem resposta. Nulo quando responder pelo Liame está desligado (`can_reply` falso): aí a
   * resposta é dada no Google, e nada é sugerido.
   */
  suggestions: ReviewSuggestions.nullable().optional(),
  generated_at: z.iso.datetime(),
});
export type ReviewsResponse = z.infer<typeof ReviewsResponse>;

/**
 * Quem avaliou, lido do Google na hora, só para a tela: **o Liame não guarda o nome nem a foto** (D-A6-5). A foto nem
 * é lida. Avaliação que o Google não devolveu agora fica sem nome.
 */
export const ReviewAuthorsResponse = z.strictObject({
  /** `ok`; `parcial` (alguma loja não respondeu); `indisponivel` (o Google não respondeu, ou pediu para esperar); `desligada`. */
  status: Slug,
  items: z.array(z.strictObject({ review_id: z.uuid(), name: z.string().max(200) })),
});
export type ReviewAuthorsResponse = z.infer<typeof ReviewAuthorsResponse>;
