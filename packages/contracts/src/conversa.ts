import { z } from 'zod';
import { ExplanationNumber, ExplanationSegment } from './ai.js';
import { CouponRequest } from './coupons.js';
import { ProblemDetails } from './problem.js';

// Conversa com a LIA (A3, I10; protótipo P5, aguardando aprovação): a pessoa escreve, a LIA lê os números da
// empresa pelas mesmas rotas das telas (com a permissão de quem pergunta) e responde em blocos que o código já
// conferiu: todo número está no que ela leu (A3-5), o texto passou pelo Compliance e pelo que a marca não diz.
// A resposta chega por um fluxo de eventos (`text/event-stream`): primeiro o que a LIA está lendo, depois a
// resposta inteira, já conferida. Texto que não passou na conferência nunca chega à tela.
//
// A conversa é de quem a abriu: só a própria pessoa vê as dela. Conversa e mensagens ficam 30 dias; a demanda
// que a LIA registra fica depois disso. O que a pessoa escreve é guardado sem dado pessoal (telefone, e-mail,
// documento e CEP saem antes de qualquer coisa, trocados por `[telefone]`, `[email]`…). Listas que crescem vão
// como texto (V23): tipo, situação ou aviso desconhecido se trata como o mais neutro.

const Slug = z.string().regex(/^[a-z0-9_]+$/).max(60);

/** Tamanho máximo de uma mensagem da pessoa, em caracteres. */
export const CONVERSATION_MESSAGE_MAX = 2000;
/** Quantos dias a conversa fica guardada depois da última mensagem (D-A3-4). */
export const CONVERSATION_RETENTION_DAYS = 30;

export const SendConversationMessageRequest = z.strictObject({
  /**
   * Gerado pela tela (UUID v7), um por mensagem: o mesmo envio repetido não duplica a mensagem nem a resposta
   * (volta 409 `mensagem-repetida`; a tela recarrega a conversa).
   */
  message_id: z.uuid(),
  brand_id: z.uuid(),
  /** A conversa em que a mensagem entra; sem ela, a mensagem abre uma conversa nova. */
  conversation_id: z.uuid().optional(),
  text: z.string().trim().min(1, { error: 'Escreva a mensagem' }).max(CONVERSATION_MESSAGE_MAX),
});
export type SendConversationMessageRequest = z.infer<typeof SendConversationMessageRequest>;

export const ConversationListQuery = z.strictObject({ brand_id: z.uuid() });
export type ConversationListQuery = z.infer<typeof ConversationListQuery>;

export const ConversationSummary = z.strictObject({
  id: z.uuid(),
  brand_id: z.uuid(),
  /** A primeira mensagem da pessoa, sem dado pessoal, cortada em 120 caracteres. */
  title: z.string(),
  created_at: z.string(),
  last_message_at: z.string(),
  /** Quando a conversa sai da lista (30 dias depois da última mensagem). */
  expires_at: z.string(),
  /** Respostas da LIA na conversa e o máximo: no máximo, a conversa não aceita mensagem nova (comece outra). */
  lia_answers: z.number().int().min(0),
  max_lia_answers: z.number().int().min(1),
  /** Alguma demanda saiu desta conversa (a lista mostra o selo "Demanda aberta"). */
  has_demand: z.boolean(),
});
export type ConversationSummary = z.infer<typeof ConversationSummary>;

/** O contato do atendimento da Liame ("Falar com uma pessoa"; Termos de Uso 12.2). */
export const SupportContact = z.strictObject({
  email: z.string(),
  /** "de segunda a sexta-feira, das 9h às 18h (horário de Brasília)". */
  hours: z.string(),
  /** "em até 1 dia útil". */
  response_time: z.string(),
});
export type SupportContact = z.infer<typeof SupportContact>;

export const ConversationListResponse = z.strictObject({
  items: z.array(ConversationSummary),
  /**
   * A LIA conversa nesta empresa e nesta marca: a IA está ligada e a LIA, ativa. Falso: a tela mostra "A LIA
   * está desligada nesta empresa" e o caminho para falar com uma pessoa.
   */
  lia: z.boolean(),
  retention_days: z.number().int().min(1),
  max_lia_answers: z.number().int().min(1),
  contact: SupportContact,
});
export type ConversationListResponse = z.infer<typeof ConversationListResponse>;

/** Um bloco da resposta da LIA, na ordem da leitura. */
export const ConversationBlock = z.strictObject({
  /** `paragrafo`, `item` (de uma lista), `risco` (com `risk`) ou `fazer` (o que fazer). Desconhecido: parágrafo. */
  kind: Slug,
  /** O texto, com cada número marcado e a posição dele em `numbers`. */
  text: z.array(ExplanationSegment),
  /** Só no `risco`: `baixo`, `medio` ou `alto`. */
  risk: Slug.nullable(),
});
export type ConversationBlock = z.infer<typeof ConversationBlock>;

export const DemandResponse = z.strictObject({
  id: z.uuid(),
  brand_id: z.uuid(),
  /** `promocao`, `plano`, `pauta`, `analise` ou `outro`. */
  kind: Slug,
  title: z.string(),
  /** O pedido, sem dado pessoal. */
  detail: z.string(),
  /** O que a LIA deixou anotado para quem cuida (números já lidos), quando houver. */
  notes: z.string().nullable(),
  /** Quem cuida: um funcionário de IA (`estrategista`), com o nome que a tela mostra. */
  assignee: z.strictObject({ agent: Slug, name: z.string() }),
  /** Para quando a pessoa pediu (AAAA-MM-DD), quando disse. */
  due_on: z.string().nullable(),
  /** `aberta`, `em_andamento`, `entregue` ou `cancelada`. */
  status: Slug,
  requested_by: z.strictObject({ id: z.uuid(), name: z.string() }).nullable(),
  /** Quem registrou em nome da pessoa: `lia`; nulo quando a pessoa abriu por uma tela. */
  opened_by_agent: Slug.nullable(),
  conversation_id: z.uuid().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
  cancelled_at: z.string().nullable(),
});
export type DemandResponse = z.infer<typeof DemandResponse>;

/** Uma voz da reunião de decisão, com o texto marcado (os números estão na mesma lista `numbers` da resposta). */
export const ConversationMeetingVoice = z.strictObject({
  /** `analista`, `estrategista` ou `voz_contraria`. A lista cresce. */
  agent: Slug,
  /** Como a tela chama a voz ("Voz contrária") e o papel dela na reunião ("discorda de propósito"). */
  name: z.string(),
  role: z.string(),
  text: z.array(ExplanationSegment),
});
export type ConversationMeetingVoice = z.infer<typeof ConversationMeetingVoice>;

/**
 * A reunião de decisão (protótipo P5): numa decisão grande (pausar campanha, mudar a verba), as vozes da equipe,
 * com uma contrária de propósito, a recomendação e o risco. É um ritual da resposta: quem decide é a pessoa.
 */
export const ConversationMeeting = z.strictObject({
  /** A pauta ("pausar a Delivery noite?"). */
  topic: z.array(ExplanationSegment),
  voices: z.array(ConversationMeetingVoice),
  recommendation: z.array(ExplanationSegment),
  /** `baixo`, `medio` ou `alto`. */
  risk: Slug,
  /** Por que o risco é esse: começa em minúscula, para vir depois do selo ("Risco médio"). */
  risk_reason: z.array(ExplanationSegment),
});
export type ConversationMeeting = z.infer<typeof ConversationMeeting>;

/** A proposta de cupom que a LIA mandou para Aprovações: o pedido no Action Service e a loja dele. */
export const ConversationCouponProposal = z.strictObject({
  request: CouponRequest,
  store_name: z.string(),
});
export type ConversationCouponProposal = z.infer<typeof ConversationCouponProposal>;

/** Um cartão dentro da resposta da LIA: o registro de algo que ela fez em nome da pessoa, ou a reunião de decisão. */
export const ConversationCard = z.strictObject({
  /**
   * `demanda` (o pedido registrado para a equipe), `proposta_cupom` (o cupom pedido, esperando aprovação em
   * Aprovações; `cancelada` quando quem pediu desistiu) ou `reuniao` (a reunião de decisão). A lista cresce.
   */
  kind: Slug,
  demand: DemandResponse.nullable(),
  coupon: ConversationCouponProposal.nullable(),
  meeting: ConversationMeeting.nullable(),
});
export type ConversationCard = z.infer<typeof ConversationCard>;

/** Uma fonte que não estava em dia quando a LIA leu: com ela, a LIA não cita os números dessa leitura. */
export const ConversationStaleSource = z.strictObject({
  platform: z.string().nullable(),
  name: z.string(),
  /** Como a tela escreve: "atrasado", "parado", "nunca leu". */
  freshness: z.string(),
  /** DD/MM/AAAA HH:MM no fuso da loja; nulo se nunca leu. */
  last_read: z.string().nullable(),
});
export type ConversationStaleSource = z.infer<typeof ConversationStaleSource>;

/**
 * Uma mensagem da conversa. `role`: `pessoa`, `lia` ou `sistema` (aviso escrito pelo código, nunca pela IA).
 * Cada papel usa os campos dele; os outros vêm vazios ou nulos.
 */
export const ConversationMessage = z.strictObject({
  id: z.uuid(),
  role: Slug,
  created_at: z.string(),
  /** Na resposta da LIA: `ok` ou `parada` (a pessoa parou antes de a resposta ficar pronta). Nos outros: `ok`. */
  status: Slug,
  /** Da pessoa: o texto como foi guardado, com o dado pessoal já trocado (`[telefone]`, `[email]`…). */
  text: z.string().nullable(),
  /** Da pessoa: quantos dados pessoais saíram antes de a mensagem ir para a LIA (a tela avisa). */
  removed_personal_data: z.number().int().min(0).nullable(),
  /** Da LIA: os blocos da resposta, já conferidos. */
  blocks: z.array(ConversationBlock),
  /** Da LIA: cada número citado e de onde ele veio (quem diz a fonte é o código, não a IA). */
  numbers: z.array(ExplanationNumber),
  /** Da LIA: o que ela leu para responder ("Resultados de 22/09/2026 a 28/09/2026"). */
  read: z.array(z.string()),
  /**
   * Da LIA: o que ela fez em nome da pessoa (a demanda aberta, a proposta de cupom, a reunião de decisão). No aviso do
   * sistema que ficou no lugar de uma resposta: o que ela já tinha registrado antes (a demanda, a proposta), que
   * continua valendo.
   */
  cards: z.array(ConversationCard),
  /** Da LIA: respondeu com o modelo econômico (perto do limite de uso do dia; a tela avisa que as respostas estão mais curtas). */
  economy: z.boolean(),
  /** Da LIA: a chamada que gerou a resposta; é o que o retorno (`POST /v1/ai/feedback`) referencia. */
  usage_id: z.uuid().nullable(),
  /**
   * Do sistema: o aviso. `pessoa` (falar com uma pessoa, com `contact`), `politico` (pedido político ou eleitoral,
   * recusado por regra), `desligada` (a IA ou a LIA desligada), `pausada` (a IA parada pela Liame), `dado_velho`
   * (com `stale_sources`), `recusada` (a resposta não passou na conferência), `fora_do_ar`, `limite_pessoa` (com
   * `retry_at`) e `teto` (com `budget_window`). Desconhecido: `fora_do_ar`.
   */
  notice: Slug.nullable(),
  contact: SupportContact.nullable(),
  retry_at: z.string().nullable(),
  budget_window: Slug.nullable(),
  stale_sources: z.array(ConversationStaleSource),
});
export type ConversationMessage = z.infer<typeof ConversationMessage>;

export const ConversationResponse = z.strictObject({
  conversation: ConversationSummary,
  /** Na ordem em que aconteceram, só as dos últimos 30 dias. */
  messages: z.array(ConversationMessage),
});
export type ConversationResponse = z.infer<typeof ConversationResponse>;

/** O que a LIA está fazendo agora: uma leitura ("Lendo os resultados de 22/09/2026 a 28/09/2026") ou a abertura de uma demanda. */
export const ConversationStep = z.strictObject({
  id: z.string(),
  label: z.string(),
  /** `lendo`, `ok` ou `falhou`. */
  status: Slug,
});
export type ConversationStep = z.infer<typeof ConversationStep>;

/**
 * Um evento do fluxo da resposta (cada um é uma linha `event:` com o `type` e uma linha `data:` com este JSON).
 * Na ordem: `inicio` (a conversa e a mensagem da pessoa, como foram guardadas), zero ou mais `passo`, uma
 * `mensagem` (a resposta da LIA ou o aviso do sistema) e `fim` (a conversa com as contas novas). Se algo
 * quebrar depois do começo: `erro`, com o problema. Linhas que começam por `:` só mantêm a conexão aberta.
 */
export const ConversationStreamEvent = z.strictObject({
  /** `inicio`, `passo`, `mensagem`, `fim` ou `erro`. */
  type: Slug,
  conversation: ConversationSummary.nullable(),
  message: ConversationMessage.nullable(),
  step: ConversationStep.nullable(),
  problem: ProblemDetails.nullable(),
});
export type ConversationStreamEvent = z.infer<typeof ConversationStreamEvent>;
