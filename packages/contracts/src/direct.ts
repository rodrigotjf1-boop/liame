import { z } from 'zod';
import { ChaveNoLugarDoCodigo } from './passkeys.js';

// Direct do Instagram (A6, Z12, parte 1; protótipo P39, aprovado em 11/11/2026; D-A6-106 a D-A6-115). O que a tela
// Direct lê: as conversas do Direct da conta do Instagram ligada à marca, que a rotina `direct` do worker guardou a cada
// minuto (D-A6-108), e o ajuste da marca (ligar o Direct, com o código do app). O Liame guarda o texto das mensagens, o
// @ de quem escreveu e a hora, por 90 dias; foto, vídeo, áudio e story ficam só na Meta (D-A6-112). Quando a Central do
// Regem atende o Direct da conta, o do Liame fica desligado nela (D-A6-107). Responder vem à parte (Z12, parte 3).

const Codigo = z.string().regex(/^[a-z_]{2,40}$/);

/** A lista mostra até este tanto de conversas (a que fecha a janela antes primeiro). */
export const DIRECT_LIST_LIMIT = 100;
/** Uma conversa mostra até este tanto de mensagens (as mais novas). */
export const DIRECT_MESSAGES_LIMIT = 100;
/** A janela da Meta para responder: horas depois da última mensagem da pessoa (D-A6-111). */
export const DIRECT_WINDOW_HOURS = 24;

export const DirectSettingsQuery = z.strictObject({ brand_id: z.uuid() });
export type DirectSettingsQuery = z.infer<typeof DirectSettingsQuery>;

/** A conta do Instagram da marca que o Direct lê (nula: a marca sem Instagram conectado). */
export const DirectAccount = z.strictObject({
  id: z.uuid(),
  /** O @, sem o "@"; nulo quando a Meta não mandou. */
  username: z.string().max(100).nullable(),
});
export type DirectAccount = z.infer<typeof DirectAccount>;

export const DirectSettingsResponse = z.strictObject({
  brand_id: z.uuid(),
  /** A função `direct` liberada para a empresa. Sem ela, nada é lido, e a tela só explica. */
  available: z.boolean(),
  /** Ligado na marca (nasce desligado). */
  enabled: z.boolean(),
  /** Quem ligou confirmou que nenhum outro programa responde aquele Direct (D-A6-107). */
  no_other_app: z.boolean(),
  /** Quem vê pode ligar: o Dono ou um Administrador, com o código do app. */
  can_enable: z.boolean(),
  /** Quem vê pode desligar, na hora e sem código: quem aprova. */
  can_disable: z.boolean(),
  account: DirectAccount.nullable(),
  /**
   * A conferência com o Regem (D-A6-107): `livre` (o Regem não atende o Direct desta conta), `atende` (atende: o Direct
   * do Liame fica desligado nela), `sem_regem` (a marca não usa o Regem), `nao_conferido` (o Regem está ligado, mas a
   * autorização não deixa conferir: conecte o Regem de novo) e `pendente` (ainda não conferido). A lista pode crescer (V23).
   */
  regem: Codigo,
  regem_checked_at: z.iso.datetime().nullable(),
  /**
   * A leitura: `desligada`, `nunca`, `ok`, `sem_permissao` (falta a permissão de mensagens, ou o Instagram não libera as
   * mensagens para as ferramentas conectadas) e `falhou`. A lista pode crescer (V23).
   */
  reading: Codigo,
  read_at: z.iso.datetime().nullable(),
  updated_at: z.iso.datetime().nullable(),
  updated_by: z.strictObject({ id: z.uuid(), name: z.string() }).nullable(),
});
export type DirectSettingsResponse = z.infer<typeof DirectSettingsResponse>;

/**
 * Ligar ou desligar o Direct na marca. Ligar pede o Dono ou um Administrador, a confirmação de que nenhum outro programa
 * responde aquele Direct e a confirmação de quem é (o código do app ou a chave de acesso); desligar, não.
 */
export const DirectSettingsRequest = z.strictObject({
  brand_id: z.uuid(),
  enabled: z.boolean(),
  no_other_app: z.boolean(),
  code: z.string().regex(/^\d{6}$/, { error: 'Digite os 6 números do app' }).optional(),
  passkey: ChaveNoLugarDoCodigo,
});
export type DirectSettingsRequest = z.infer<typeof DirectSettingsRequest>;

export const DIRECT_STATUSES = ['espera', 'fechando', 'respondida', 'fora', 'todas'] as const;

export const DirectConversationsQuery = z.strictObject({
  brand_id: z.uuid(),
  /** A situação que filtra (a tela: Esperam resposta, Janela fechando, Respondidas, Fora da janela, Todas). */
  status: z.enum(DIRECT_STATUSES).default('espera'),
  /** Busca pelo @ ou pelo texto das mensagens. */
  q: z.string().trim().max(100).optional(),
});
export type DirectConversationsQuery = z.infer<typeof DirectConversationsQuery>;

/** O id de uma conversa na Meta, no caminho da rota (`/v1/direct/conversations/{id}`). */
export const DirectConversationId = z.string().min(1).max(200).regex(/^[A-Za-z0-9_=.:-]+$/);

export const DirectConversation = z.strictObject({
  id: z.string().min(1).max(200),
  /** O @ de quem escreveu, sem o "@"; nulo quando a Meta não mandou. */
  username: z.string().max(100).nullable(),
  /** `espera`, `respondida` ou `fora` (a janela da Meta fechou). A lista pode crescer (V23). */
  status: Codigo,
  /** Faltam menos de 2 horas para a janela fechar. */
  closing: z.boolean(),
  /** Até quando a Meta deixa a marca responder (24 horas depois da última mensagem da pessoa); nulo sem mensagem dela. */
  window_until: z.iso.datetime().nullable(),
  /** Chegou mensagem da pessoa que ninguém abriu no Liame. */
  unread: z.boolean(),
  last_message_at: z.iso.datetime(),
  /** A última mensagem: de quem (`entrada`, da pessoa; `saida`, da marca), o tipo e o texto (vazio no que não é texto). */
  last_message: z.strictObject({ direction: Codigo, kind: Codigo, text: z.string() }).nullable(),
});
export type DirectConversation = z.infer<typeof DirectConversation>;

export const DirectCounts = z.strictObject({
  espera: z.int().min(0),
  fechando: z.int().min(0),
  respondida: z.int().min(0),
  fora: z.int().min(0),
  todas: z.int().min(0),
});
export type DirectCounts = z.infer<typeof DirectCounts>;

export const DirectConversationsResponse = z.strictObject({
  brand_id: z.uuid(),
  account: DirectAccount.nullable(),
  counts: DirectCounts,
  items: z.array(DirectConversation).max(DIRECT_LIST_LIMIT),
});
export type DirectConversationsResponse = z.infer<typeof DirectConversationsResponse>;

export const DirectMessage = z.strictObject({
  id: z.string().min(1).max(300),
  /** `entrada` (da pessoa) ou `saida` (da marca). A lista pode crescer (V23). */
  direction: Codigo,
  /**
   * `texto`, ou o tipo do que só a Meta guarda: `imagem`, `video`, `audio`, `arquivo`, `compartilhamento`,
   * `story_resposta`, `story_mencao`, `reel` e `sem_suporte`. A lista pode crescer (V23).
   */
  kind: Codigo,
  text: z.string(),
  sent_at: z.iso.datetime(),
});
export type DirectMessage = z.infer<typeof DirectMessage>;

export const DirectConversationResponse = z.strictObject({
  brand_id: z.uuid(),
  conversation: DirectConversation,
  /** As mensagens guardadas, da mais velha para a mais nova. */
  messages: z.array(DirectMessage).max(DIRECT_MESSAGES_LIMIT),
});
export type DirectConversationResponse = z.infer<typeof DirectConversationResponse>;
