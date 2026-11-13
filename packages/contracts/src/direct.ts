import { z } from 'zod';
import { ChaveNoLugarDoCodigo } from './passkeys.js';

// Direct do Instagram (A6, Z12, parte 1; protótipo P39, aprovado em 11/11/2026; D-A6-106 a D-A6-115). O que a tela
// Direct lê: as conversas do Direct da conta do Instagram ligada à marca, que a rotina `direct` do worker guardou a cada
// minuto (D-A6-108), e o ajuste da marca (ligar o Direct, com o código do app). O Liame guarda o texto das mensagens, o
// @ de quem escreveu e a hora, por 90 dias; foto, vídeo, áudio e story ficam só na Meta (D-A6-112). Quando a Central do
// Regem atende o Direct da conta, o do Liame fica desligado nela (D-A6-107). Responder, com o atendimento aberto, é a
// parte 2 (D-A6-117); a tela, a parte 3.

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

/**
 * O Messenger da Página na caixa do Direct (A6, Z14, parte 1; D-A6-120 e D-A6-121): liga separado do Direct, com a
 * função `messenger`, a Página conectada e a confirmação de que nenhum outro programa responde aquele Messenger.
 */
export const DirectMessengerSettings = z.strictObject({
  /** A função `messenger` liberada para a empresa. */
  available: z.boolean(),
  /** Ligado na marca (nasce desligado). */
  enabled: z.boolean(),
  no_other_app: z.boolean(),
  /** A Página da marca que o Messenger lê (nula: a marca sem Página conectada). */
  page: z.strictObject({ id: z.uuid(), name: z.string().max(200) }).nullable(),
  /** A conferência com o Regem pela Página (como a do Direct; a lista pode crescer, V23). */
  regem: Codigo,
  regem_checked_at: z.iso.datetime().nullable(),
  /** A leitura (como a do Direct; a lista pode crescer, V23). */
  reading: Codigo,
  read_at: z.iso.datetime().nullable(),
  updated_at: z.iso.datetime().nullable(),
  updated_by: z.strictObject({ id: z.uuid(), name: z.string() }).nullable(),
});
export type DirectMessengerSettings = z.infer<typeof DirectMessengerSettings>;

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
  /** O Messenger da Página (A6, Z14): o ajuste dele, separado do Direct. */
  messenger: DirectMessengerSettings,
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
  /** Só um canal (A6, Z14): `instagram` ou `messenger`; sem ele, os dois. As contagens seguem o canal. */
  channel: z.enum(['instagram', 'messenger']).optional(),
});
export type DirectConversationsQuery = z.infer<typeof DirectConversationsQuery>;

/** O id de uma conversa na Meta, no caminho da rota (`/v1/direct/conversations/{id}`). */
export const DirectConversationId = z.string().min(1).max(200).regex(/^[A-Za-z0-9_=.:-]+$/);

export const DirectConversation = z.strictObject({
  id: z.string().min(1).max(200),
  /** O @ de quem escreveu, sem o "@"; nulo quando a Meta não mandou (e no Messenger, que não tem @). */
  username: z.string().max(100).nullable(),
  /** O canal (A6, Z14): `instagram` (o Direct) ou `messenger` (a Página). A lista pode crescer (V23). */
  channel: Codigo,
  /** O nome que a Meta manda de quem escreveu (no Messenger, o nome do Facebook); nulo quando não mandou. */
  name: z.string().max(200).nullable(),
  /** `espera`, `respondida` ou `fora` (a janela da Meta fechou). A lista pode crescer (V23). */
  status: Codigo,
  /** Faltam menos de 2 horas para a janela fechar. */
  closing: z.boolean(),
  /** Até quando a Meta deixa a marca responder (24 horas depois da última mensagem da pessoa); nulo sem mensagem dela. */
  window_until: z.iso.datetime().nullable(),
  /** Chegou mensagem da pessoa que ninguém abriu no Liame. */
  unread: z.boolean(),
  /**
   * O tipo, pelo que a pessoa escreveu desde a última resposta da marca (A6, Z12, parte 4a; a regra dos comentários):
   * `pergunta`, `reclamacao`, `elogio`, `golpe`, `ofensivo` ou `mencao` (a menção no story); nulo quando a regra não
   * decide ou não há nada esperando. A lista pode crescer (V23).
   */
  kind: Codigo.nullable(),
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

/** O contador do menu (A6, Z12; P39): quantas conversas do Direct esperam resposta na empresa. */
export const DirectWaitingResponse = z.strictObject({
  /**
   * As conversas que esperam resposta, somadas as marcas da empresa com o Direct ligado e lido pelo Liame: a mesma regra
   * de "Esperam resposta" na tela (a última mensagem é da pessoa, dentro da janela de 24 horas, sem "concluir" depois).
   */
  waiting: z.int().min(0),
  /** Alguma marca da empresa com o Messenger da Página lido pelo Liame (A6, Z14): o menu diz "Direct e Messenger". */
  messenger: z.boolean(),
});
export type DirectWaitingResponse = z.infer<typeof DirectWaitingResponse>;

/** O atendimento aberto vale este tanto de horas (D-A6-109): depois, a próxima resposta pede o código de novo. */
export const DIRECT_ATTENDANCE_HOURS = 8;

/** O atendimento da pessoa (A6, Z12, parte 2): aberto ou não, até quando, e se ela pode responder no Direct. */
export const DirectAttendanceResponse = z.strictObject({
  open: z.boolean(),
  until: z.iso.datetime().nullable(),
  /** A pessoa pode responder no Direct (o Dono, os Administradores e quem aprova). */
  can_reply: z.boolean(),
});
export type DirectAttendanceResponse = z.infer<typeof DirectAttendanceResponse>;

/** Abrir o atendimento: a confirmação de quem é (o código do app ou a chave de acesso). */
export const DirectAttendanceRequest = z.strictObject({
  code: z.string().regex(/^\d{6}$/, { error: 'Digite os 6 números do app' }).optional(),
  passkey: ChaveNoLugarDoCodigo,
});
export type DirectAttendanceRequest = z.infer<typeof DirectAttendanceRequest>;

/** Mandar a resposta numa conversa (A6, Z12, parte 2; D-A6-109): o texto, até 1.000 de espaço na Meta. */
export const DirectReplyRequest = z.strictObject({
  brand_id: z.uuid(),
  text: z.string().trim().min(1).max(4000),
});
export type DirectReplyRequest = z.infer<typeof DirectReplyRequest>;

export const DirectReplyResponse = z.strictObject({
  /** O pedido no trilho de ações: nasce aprovado e sai na volta seguinte do executor. */
  action_id: z.uuid(),
  /** A situação do pedido (`aprovada`, `executando`, `executada`, `falhou`…). A lista pode crescer (V23). */
  status: Codigo,
  status_reason: z.string().nullable(),
});
export type DirectReplyResponse = z.infer<typeof DirectReplyResponse>;

/** Concluir uma conversa sem responder, ou marcá-la como lida: só a marca. */
export const DirectBrandRequest = z.strictObject({ brand_id: z.uuid() });
export type DirectBrandRequest = z.infer<typeof DirectBrandRequest>;

/**
 * A sugestão sem IA da conversa (A6, Z12, parte 4a): `pronta` (o agradecimento do elogio e da menção no story, em
 * `text`), `passos` (o "como proceder" da reclamação, em `steps`) ou `golpe` (o Liame não sugere resposta). A lista pode
 * crescer (V23).
 */
export const DirectSuggestion = z.strictObject({
  kind: Codigo,
  text: z.string().max(1000).nullable(),
  steps: z.array(z.string().max(300)).max(8),
});
export type DirectSuggestion = z.infer<typeof DirectSuggestion>;

export const DirectConversationResponse = z.strictObject({
  brand_id: z.uuid(),
  conversation: DirectConversation,
  /** As mensagens guardadas, da mais velha para a mais nova. */
  messages: z.array(DirectMessage).max(DIRECT_MESSAGES_LIMIT),
  /** A sugestão sem IA para o que espera resposta; nula quando não há (a pergunta espera o Social media, parte 4b). */
  suggestion: DirectSuggestion.nullable(),
});
export type DirectConversationResponse = z.infer<typeof DirectConversationResponse>;

// ---- A sugestão do Social media numa conversa (A6, Z12, parte 4b-2; P39; D-A6-110 e D-A6-145)

/** Quantas sugestões já vistas o "Pedir outra" manda de volta (uma na pergunta; três na reclamação). */
export const DIRECT_AI_SUGGESTIONS_MAX = 3;

/**
 * Pedir ao Social media a sugestão de resposta para uma conversa que espera resposta (a pergunta ou a reclamação).
 * `previous`: o "Pedir outra", com as sugestões que a pessoa já viu, para as novas serem outras.
 */
export const DirectAiSuggestionRequest = z.strictObject({
  brand_id: z.uuid(),
  previous: z
    .array(z.strictObject({ focus: z.string().trim().min(1).max(60), text: z.string().trim().min(1).max(600) }))
    .max(DIRECT_AI_SUGGESTIONS_MAX)
    .default([]),
});
export type DirectAiSuggestionRequest = z.infer<typeof DirectAiSuggestionRequest>;

/**
 * Por que o Social media não sugeriu. Os da IA (desligada, sem a rota do modelo, no teto, fora do ar, a entrada grande),
 * o funcionário desligado na marca, a resposta fora do formato, tudo barrado pela conferência, e `tipo_sem_ia`: a
 * conversa não é pergunta nem reclamação (o elogio e a menção têm a resposta pronta; o golpe, nenhuma). A lista pode
 * crescer (V23).
 */
export const DIRECT_AI_SUGGESTION_NO_AI_REASONS = [
  'ia_desligada',
  'funcionario_desligado',
  'sem-rota',
  'teto',
  'limite-usuario',
  'travada',
  'parada',
  'indisponivel',
  'entrada-grande',
  'formato',
  'barrado',
  'tipo_sem_ia',
] as const;

/**
 * A sugestão do Social media, já conferida (as regras da resposta, as da Liame e da marca e os números): a que a
 * conferência barra não volta (`dropped` conta). `kind`: o tipo da conversa (`pergunta` ou `reclamacao`). `answered`: na
 * pergunta, ele respondeu só com o que Minha marca diz; falso, "precisa de você", com o que faltou em `missing` (nulo
 * quando ele não disse de um jeito que a tela mostre). Sem a IA, `origin` é `sem_ia`, com o motivo, e a pessoa escreve.
 * Nada é guardado: a sugestão vive na tela de quem pediu.
 */
export const DirectAiSuggestionResponse = z.strictObject({
  origin: z.enum(['ia', 'sem_ia']),
  reason: z.enum(DIRECT_AI_SUGGESTION_NO_AI_REASONS).nullable(),
  kind: z.enum(['pergunta', 'reclamacao']).nullable(),
  suggestions: z.array(z.strictObject({ focus: z.string().min(1).max(60), text: z.string().min(1).max(600), check: z.enum(['passou', 'aviso']) })).max(DIRECT_AI_SUGGESTIONS_MAX),
  answered: z.boolean(),
  missing: z.string().max(80).nullable(),
  /** Quantas sugestões ficaram de fora (vazias, longas, repetidas, com dado pessoal ou barradas pela conferência). */
  dropped: z.int().min(0),
  /** No teto de custo: quando a IA volta. */
  retry_at: z.iso.datetime({ offset: true }).nullable(),
  /** A chamada em `ai_usage` (para o retorno da pessoa); nula sem a IA. */
  usage_id: z.uuid().nullable(),
});
export type DirectAiSuggestionResponse = z.infer<typeof DirectAiSuggestionResponse>;

// ---- O atendimento automático do Direct (A6, Z12, parte 5a; P39 versão 2; D-A6-115 e D-A6-119)

/**
 * Os tipos que o atendimento automático do Direct responde sozinho: `pronta` (o elogio, a resposta ao story e a menção
 * no story, com a resposta pronta, sem IA). A pergunta que ele sabe responder com certeza entra com o Social media (parte
 * 4b); a tabela já a aceita.
 */
export const DIRECT_AUTO_REPLY_KINDS = ['pronta'] as const;
/** No máximo tantas respostas sozinho por hora, por marca (P39); o que passar fica para uma pessoa. */
export const DIRECT_AUTO_REPLY_HOURLY_LIMIT = 30;
/** No máximo tantas respostas automáticas seguidas na mesma conversa; a seguinte vai para uma pessoa (P39). */
export const DIRECT_AUTO_REPLY_IN_A_ROW = 2;
/**
 * O aviso no fim de cada resposta automática do Direct, posto pelo código (Termos 5.5 e 6.3: o aviso de IA e o caminho
 * para uma pessoa; a Meta pede o aviso de automação). A tela reconhece por ele a resposta que saiu sozinha.
 */
export const DIRECT_AUTO_REPLY_NOTICE = '\n\nResposta automática · para falar com alguém da equipe, é só pedir aqui';

export const DirectAutoReplyResponse = z.strictObject({
  brand_id: z.uuid(),
  /** A função `direct_automatico` liberada para a empresa. Sem ela, nada responde sozinho, e a tela só explica. */
  available: z.boolean(),
  /** Ligado na marca (nasce desligado). */
  enabled: z.boolean(),
  /** Os tipos marcados: `pronta` hoje. A lista pode crescer (V23). */
  kinds: z.array(Codigo),
  /** Quem vê pode ligar e somar um tipo: o Dono ou um Administrador, com o código do app. */
  can_enable: z.boolean(),
  /** Quem vê pode desligar e tirar um tipo, na hora e sem código: quem aprova. */
  can_disable: z.boolean(),
  /** A última mudança e quem fez (cada uma fica também na auditoria). Nulos enquanto ninguém mudou. */
  updated_at: z.iso.datetime().nullable(),
  updated_by: z.strictObject({ id: z.uuid(), name: z.string() }).nullable(),
  /** As respostas automáticas da última hora (dadas ou saindo) e o teto por hora. */
  last_hour: z.int().min(0),
  hourly_limit: z.int().min(1),
});
export type DirectAutoReplyResponse = z.infer<typeof DirectAutoReplyResponse>;

/**
 * Ligar, desligar ou mudar os tipos. Ligar e somar um tipo pedem o Dono ou um Administrador e a confirmação (o código do
 * app ou a chave de acesso); desligar e tirar um tipo, não. Ligado pede pelo menos um tipo.
 */
export const DirectAutoReplyRequest = z.strictObject({
  brand_id: z.uuid(),
  enabled: z.boolean(),
  kinds: z.array(z.enum(DIRECT_AUTO_REPLY_KINDS)).max(DIRECT_AUTO_REPLY_KINDS.length),
  code: z.string().regex(/^\d{6}$/, { error: 'Digite os 6 números do app' }).optional(),
  passkey: ChaveNoLugarDoCodigo,
});
export type DirectAutoReplyRequest = z.infer<typeof DirectAutoReplyRequest>;

/** A prévia antes de ligar: até este tanto de exemplos. */
export const DIRECT_AUTO_REPLY_PREVIEW_LIMIT = 3;

/**
 * "Veja como ele teria respondido": as conversas das últimas 24 horas que esperam resposta e que ele sabe responder,
 * cada uma com a resposta que sairia, já com o aviso de resposta automática. Nada disto foi enviado.
 */
export const DirectAutoReplyPreviewResponse = z.strictObject({
  items: z
    .array(
      z.strictObject({
        conversation_id: z.string().min(1).max(200),
        /** O @ de quem escreveu, sem o "@"; nulo quando a Meta não mandou. */
        username: z.string().max(100).nullable(),
        /** O que a pessoa mandou (o texto, ou o tipo do que só a Meta guarda, como na lista). */
        message: z.string(),
        /** `elogio` ou `mencao`. A lista pode crescer (V23). */
        kind: Codigo,
        /** A resposta que sairia, com o aviso no fim. */
        reply: z.string(),
      }),
    )
    .max(DIRECT_AUTO_REPLY_PREVIEW_LIMIT),
});
export type DirectAutoReplyPreviewResponse = z.infer<typeof DirectAutoReplyPreviewResponse>;
