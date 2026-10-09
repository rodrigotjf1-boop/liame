import { z } from 'zod';

// Mensageria (A5, Y4; `plano-a5.md` D-A5-10 e D-A5-12; protótipo P15, aprovado em 09/10/2026). O que a
// tela Mensagens lê: se a conta do WhatsApp pode enviar, o teto de gasto de mensagens que o dono definiu no RegemCast,
// quantos modelos aprovados e públicos há, e as campanhas de mensagens com os números. Tudo é lido do RegemCast na hora
// e nada é guardado no Liame. Só números e textos escritos pela loja ou pelo RegemCast: nenhum telefone e nenhum nome
// de contato. Listas que crescem vão como texto na resposta (V23).

const Slug = z.string().regex(/^[a-zà-ú0-9_]+$/).max(60);
const Contagem = z.int().min(0);
/** Dinheiro em centavos inteiros, como o RegemCast informa. */
const Centavos = z.int().min(0);

export const MessagingWhatsapp = z.strictObject({
  /** Como foi esta leitura: `ok`; `sem_permissao` (a conexão com o RegemCast não inclui esta leitura); `indisponivel` (o RegemCast não respondeu agora). */
  status: Slug,
  /** A conta tem um número de WhatsApp conectado no RegemCast (nulo sem a leitura). */
  connected: z.boolean().nullable(),
  /** `pode_enviar`, `com_restricao`, `bloqueado` ou `desconhecido`; nulo sem WhatsApp conectado ou sem a leitura. */
  signal: Slug.nullable(),
  title: z.string().nullable(),
  summary: z.string().nullable(),
  /** Quando o RegemCast leu a situação na Meta. */
  checked_at: z.iso.datetime().nullable(),
  /** O que a Meta aponta e o que resolve, como o RegemCast escreve. */
  problems: z.array(z.strictObject({ where: z.string(), title: z.string(), explanation: z.string(), action: z.string().nullable() })),
});
export type MessagingWhatsapp = z.infer<typeof MessagingWhatsapp>;

export const MessagingBudgetPeriod = z.strictObject({
  /** `dia`, `semana` ou `mes`. */
  period: Slug,
  label: z.string(),
  limit_cents: Centavos,
  spent_cents: Centavos,
  /** Quanto do teto já saiu, em por cento (pode passar de 100). */
  percent: z.number().min(0),
  /** `ok`, `atencao` ou `cheio`. */
  signal: Slug,
});
export type MessagingBudgetPeriod = z.infer<typeof MessagingBudgetPeriod>;

/** Os tetos de gasto de mensagens que o dono da conta definiu no RegemCast. Sem teto definido, `periods` vem vazia. */
export const MessagingBudget = z.strictObject({
  status: Slug,
  currency: z.string().nullable(),
  periods: z.array(MessagingBudgetPeriod),
  notices: z.array(z.string()),
});
export type MessagingBudget = z.infer<typeof MessagingBudget>;

/** O que há pronto para uma mensagem: modelos e públicos. Só contagens. */
export const MessagingReady = z.strictObject({
  templates_status: Slug,
  /** Modelos que a Meta aprovou e que podem ser enviados. */
  approved_templates: Contagem.nullable(),
  templates: Contagem.nullable(),
  audiences_status: Slug,
  /** Listas, públicos prontos e perfis da base, somados. */
  audiences: Contagem.nullable(),
  /** Quantas pessoas podem receber no maior deles. */
  largest_audience: Contagem.nullable(),
});
export type MessagingReady = z.infer<typeof MessagingReady>;

/**
 * O cupom de uma mensagem que o Liame montou (A5, Y5; D-A5-16): é por ele que o resultado é medido no caixa. Os pedidos
 * e a receita são os confirmados na loja do cupom, com o cupom, desde que ele nasceu; vêm nulos para quem não vê as
 * vendas. O RegemCast não diz quem recebeu nem quem comprou: a conta é só pelo cupom.
 */
export const MessagingCoupon = z.strictObject({
  code: z.string(),
  orders: Contagem.nullable(),
  /** A receita confirmada (já sem o que foi devolvido), em centavos. */
  revenue_cents: Centavos.nullable(),
});
export type MessagingCoupon = z.infer<typeof MessagingCoupon>;

/** Uma campanha de mensagens: os números, sem a lista de quem recebeu. */
export const MessagingCampaign = z.strictObject({
  id: z.string(),
  name: z.string(),
  /** `rascunho`, `agendada`, `enviando`, `pausada`, `concluida` ou `cancelada`. */
  status: Slug,
  pause_reason: z.string().nullable(),
  /** O nome do modelo da mensagem. */
  template: z.string(),
  category: z.string().nullable(),
  audience: z.string().nullable(),
  recipients: Contagem,
  queued: Contagem,
  sent: Contagem,
  delivered: Contagem,
  read: Contagem,
  failed: Contagem,
  replied: Contagem,
  created_at: z.iso.datetime().nullable(),
  started_at: z.iso.datetime().nullable(),
  finished_at: z.iso.datetime().nullable(),
  /** O cupom da mensagem, quando o Liame a montou com um e ele já nasceu no Regem; nulo nas outras campanhas. */
  coupon: MessagingCoupon.nullable().optional(),
});
export type MessagingCampaign = z.infer<typeof MessagingCampaign>;

/** As campanhas mais novas da conta (até 20). `total` é o de todas. */
export const MessagingCampaigns = z.strictObject({ status: Slug, total: Contagem.nullable(), items: z.array(MessagingCampaign) });
export type MessagingCampaigns = z.infer<typeof MessagingCampaigns>;

export const MessagingAccount = z.strictObject({
  connected_account_id: z.uuid(),
  name: z.string(),
  /**
   * `ok`; `sem_autorizacao` (o RegemCast recusou o token desta conta, ou ela está sem token: é conectar o RegemCast de
   * novo); `indisponivel` (o Liame está sem o endereço do RegemCast). Fora do `ok`, as partes vêm sem dado.
   */
  status: Slug,
  whatsapp: MessagingWhatsapp,
  budget: MessagingBudget,
  ready: MessagingReady,
  campaigns: MessagingCampaigns,
});
export type MessagingAccount = z.infer<typeof MessagingAccount>;

export const MessagingResponse = z.strictObject({
  brand_id: z.uuid(),
  /** A função está ligada para a empresa. Desligada, `accounts` vem vazia e nada é lido do RegemCast. */
  enabled: z.boolean(),
  /** Quando esta leitura foi feita. */
  read_at: z.iso.datetime(),
  /** As contas do RegemCast conectadas à marca (até 5). Vazia: o RegemCast não está conectado. */
  accounts: z.array(MessagingAccount),
});
export type MessagingResponse = z.infer<typeof MessagingResponse>;

export const MessagingQuery = z.strictObject({ brand_id: z.uuid() });
export type MessagingQuery = z.infer<typeof MessagingQuery>;

/** O id de uma campanha no RegemCast. */
export const MessagingCampaignId = z.string().regex(/^[A-Za-z0-9_-]{1,100}$/);
export type MessagingCampaignId = z.infer<typeof MessagingCampaignId>;

export const MessagingCampaignQuery = z.strictObject({ connected_account_id: z.uuid() });
export type MessagingCampaignQuery = z.infer<typeof MessagingCampaignQuery>;

/** O custo na Meta, como o RegemCast informa: o que já foi gasto e o que ainda pode sair. Estimativa e teto, não preço fechado. */
export const MessagingCost = z.strictObject({
  currency: z.string().nullable(),
  spent_cents: Centavos.nullable(),
  to_spend_cents: Centavos.nullable(),
  lines: z.array(z.strictObject({ label: z.string(), value: z.string(), detail: z.string().nullable() })),
  notices: z.array(z.string()),
});
export type MessagingCost = z.infer<typeof MessagingCost>;

/** Uma campanha de perto: por que está pausada ou esperando, as falhas por motivo (com o que fazer) e o custo. Não diz quem recebeu. */
export const MessagingCampaignDetailResponse = z.strictObject({
  connected_account_id: z.uuid(),
  campaign: MessagingCampaign,
  pause: z.strictObject({ reason: z.string(), explanation: z.string().nullable(), resumes_at: z.iso.datetime().nullable() }).nullable(),
  waiting: z.strictObject({ reason: z.string(), until: z.iso.datetime().nullable() }).nullable(),
  failures: z.array(z.strictObject({ messages: Contagem, title: z.string(), explanation: z.string(), action: z.string().nullable() })),
  /** Nulo quando a conta não tem preço para estimar. */
  cost: MessagingCost.nullable(),
  /** O descanso entre mensagens de marketing que a conta tem no RegemCast, em dias. */
  rest_days: z.int().min(0).nullable(),
});
export type MessagingCampaignDetailResponse = z.infer<typeof MessagingCampaignDetailResponse>;
