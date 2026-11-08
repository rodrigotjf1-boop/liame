import { z } from 'zod';

// Comentários (A6, Z11; protótipo P38, D-A6-84 a D-A6-94). O que a tela Comentários lê: os comentários dos posts dos
// últimos 30 dias do Instagram e da Página ligados à marca, que a rotina `comentarios` do worker guardou. O Liame guarda
// o texto, o @ (Instagram) ou o nome (Página) de quem comentou, a hora, as curtidas e se está oculto, por 90 dias; sem a
// foto do perfil. Responder e ocultar vêm à parte (Z11, parte 2), sempre por pedido.

const Slug = z.string().regex(/^[a-z0-9_]+$/).max(60);

/** A lista mostra até este tanto de comentários (o que pede resposta primeiro). */
export const COMMENTS_LIST_LIMIT = 200;
/** "Ler agora": uma vez por janela de 5 minutos (alinhada ao relógio) por marca. */
export const COMMENTS_REFRESH_WINDOW_S = 300;

export const CommentsQuery = z.strictObject({
  brand_id: z.uuid(),
  /**
   * O que a lista mostra: `pedem` (perguntas e reclamações sem resposta da marca), `ocultar` (ofensivo ou golpe, à
   * vista), `respondidos`, `ocultos` ou `todos` (o padrão).
   */
  filter: z.enum(['pedem', 'ocultar', 'respondidos', 'ocultos', 'todos']).optional(),
  /** Só um canal: `instagram` ou `facebook` (a Página). */
  channel: z.enum(['instagram', 'facebook']).optional(),
  /** Busca no texto e no nome de quem comentou (sem diferença de maiúsculas). */
  q: z.string().trim().min(1).max(100).optional(),
});
export type CommentsQuery = z.infer<typeof CommentsQuery>;

/** Uma resposta a um comentário (da marca ou de outra pessoa). */
export const CommentReply = z.strictObject({
  id: z.string().min(1).max(120),
  /** O @ ou o nome de quem respondeu; nulo quando a rede não manda. */
  author: z.string().nullable(),
  /** A resposta é da própria marca (pelo app da rede ou pelo Liame). */
  by_brand: z.boolean(),
  message: z.string(),
  published_at: z.iso.datetime(),
  hidden: z.boolean(),
});
export type CommentReply = z.infer<typeof CommentReply>;

export const SocialComment = z.strictObject({
  /** O id do comentário na rede. */
  id: z.string().min(1).max(120),
  /** `instagram` ou `facebook`. A lista pode crescer (V23). */
  channel: Slug,
  /** O post de onde veio (em `posts`). */
  post_id: z.string().min(1).max(80),
  /** O @ (Instagram) ou o nome (Página) de quem comentou; nulo quando a rede não manda. */
  author: z.string().nullable(),
  message: z.string(),
  published_at: z.iso.datetime(),
  like_count: z.int().min(0).nullable(),
  reply_count: z.int().min(0).nullable(),
  hidden: z.boolean(),
  /**
   * O tipo: `pergunta`, `reclamacao`, `elogio`, `marcacao`, `ofensivo` ou `golpe`; nulo enquanto não decidido. A lista
   * pode crescer (V23).
   */
  kind: Slug.nullable(),
  /** Quem decidiu o tipo: `regra` (o servidor) ou `ia`. */
  kind_source: Slug.nullable(),
  /**
   * A situação: `pede_resposta` (pergunta ou reclamação sem resposta da marca), `para_ocultar` (ofensivo ou golpe, à
   * vista), `respondido` (a marca já respondeu), `oculto` ou `sem_resposta` (o resto). A lista pode crescer (V23).
   */
  situation: Slug,
  /** As respostas, da mais antiga para a mais nova (até 20). */
  replies: z.array(CommentReply),
  /** A conta da rede ligada à marca de onde veio o comentário (o Instagram ou a Página): é a do pedido de responder. */
  account_id: z.uuid(),
  /**
   * O pedido em aberto sobre este comentário (A6, Z11, parte 2c), o mais novo: responder, apagar a resposta, ocultar ou
   * mostrar, esperando a aprovação, aprovado ou em execução (`status`: `aguardando_aprovacao`, `aprovada` ou
   * `executando`; a lista pode crescer, V23). Nulo quando não há. A tela mostra "Pedido em Aprovações" em vez de pedir de
   * novo.
   */
  request: z.strictObject({ id: z.uuid(), tool: z.string().regex(/^[a-z_]{2,60}$/), status: z.string().regex(/^[a-z_]{2,40}$/) }).nullable(),
});
export type SocialComment = z.infer<typeof SocialComment>;

/** O post de onde vêm os comentários. */
export const CommentPost = z.strictObject({
  id: z.string().min(1).max(80),
  channel: Slug,
  /** No Instagram, `reels`, `foto`, `carrossel` ou `video`; na Página, nulo. */
  kind: Slug.nullable(),
  /** A legenda (no Instagram, como está lá; na Página, cortada em 2.200 caracteres). */
  caption: z.string(),
  permalink: z.string().nullable(),
  /** A miniatura no endereço da Meta (vence em alguns dias; a leitura traz uma nova); nula quando a rede não manda. */
  thumbnail_url: z.string().nullable(),
  published_at: z.iso.datetime(),
  comment_count: z.int().min(0).nullable(),
});
export type CommentPost = z.infer<typeof CommentPost>;

export const CommentsAccount = z.strictObject({
  /** `instagram` ou `facebook`. */
  channel: Slug,
  /** O nome da conta (o `@loja` ou o nome da Página). */
  name: z.string(),
  /**
   * A leitura desta conta: `primeira_leitura`, `lido`, `sem_permissao` (a autorização da Meta sem a permissão de ler os
   * comentários, ou sem a tarefa de moderar a Página) ou `falhou`. A lista pode crescer (V23).
   */
  situation: Slug,
  /** A última leitura que deu certo. */
  read_at: z.iso.datetime().nullable(),
});
export type CommentsAccount = z.infer<typeof CommentsAccount>;

/** Quantos comentários em cada situação, no canal escolhido (sem a busca). */
export const CommentsCounts = z.strictObject({
  pedem: z.int().min(0),
  ocultar: z.int().min(0),
  respondidos: z.int().min(0),
  ocultos: z.int().min(0),
  todos: z.int().min(0),
});
export type CommentsCounts = z.infer<typeof CommentsCounts>;

export const CommentsResponse = z.strictObject({
  brand_id: z.uuid(),
  /**
   * O que a tela mostra: `desligada` (a função não está ligada para a empresa), `sem_conta` (nem Instagram nem Página
   * ligados à marca: o caminho é Contas conectadas) ou `pronta`. A lista pode crescer (V23).
   */
  state: Slug,
  accounts: z.array(CommentsAccount),
  counts: CommentsCounts,
  /** Até 200 comentários de primeiro nível: os que pedem resposta, os para ocultar, o resto, os respondidos e os ocultos. */
  items: z.array(SocialComment),
  /** Os posts dos comentários da lista. */
  posts: z.array(CommentPost),
  /** O "Ler agora": se dá para pedir já e, se não, quando. */
  refresh: z.strictObject({ available: z.boolean(), next_at: z.iso.datetime().nullable() }),
});
export type CommentsResponse = z.infer<typeof CommentsResponse>;

export const CommentsRefreshRequest = z.strictObject({ brand_id: z.uuid() });
export type CommentsRefreshRequest = z.infer<typeof CommentsRefreshRequest>;

export const CommentsRefreshResponse = z.strictObject({
  requested_at: z.iso.datetime(),
  /** Quantas contas (o Instagram e a Página) vão ser lidas. */
  accounts: z.int().min(0),
  /** Quando dá para pedir de novo. */
  next_at: z.iso.datetime(),
});
export type CommentsRefreshResponse = z.infer<typeof CommentsRefreshResponse>;
