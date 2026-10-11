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
  pending_replies: z.array(z.strictObject({ review_id: z.uuid(), action_id: z.uuid(), owner_only: z.boolean() })).optional(),
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
