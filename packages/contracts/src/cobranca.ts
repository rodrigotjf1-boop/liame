import { z } from 'zod';

// Plano e cobrança (A7, W1; protótipo P26, aprovado em 22/10/2026; `plano-a7.md` D-A7-4, D-A7-13 a D-A7-26). Os
// planos do produto, a assinatura de cada marca e as faturas. Os valores vão em centavos, como texto (cabem em bigint).
// Nenhum dado de cartão passa por aqui (A7-1): o cartão é digitado no meio de pagamento (W2). As datas são dias do
// calendário da empresa (no fuso dela). Listas que crescem vão como texto na resposta (V23); no pedido, a lista fechada.

const Slug = z.string().regex(/^[a-z0-9_]+$/).max(60);
/** Centavos em texto (cabe em bigint). */
const Centavos = z.string().regex(/^\d+$/);
const Dia = z.iso.date();
/** O código de 6 dígitos do app autenticador (D-A7-14). */
const CodigoDoApp = z.string().regex(/^\d{6}$/);

/** As formas de pagar que a assinatura aceita hoje. O Pix Automático entra com a função própria (W2; D-A7-17). */
export const BILLING_METHODS = ['cartao', 'pix'] as const;
export const BillingMethod = z.enum(BILLING_METHODS);
export type BillingMethod = z.infer<typeof BillingMethod>;

export const BillingPlan = z.strictObject({
  /** `essencial` ou `completo`. */
  key: Slug,
  /** A versão do plano: um preço novo é uma versão nova (D-A7-20). */
  version: z.int().min(1),
  name: z.string(),
  /** Por mês, em centavos. */
  price_cents: Centavos,
  currency: z.literal('BRL'),
  /** Os funcionários de IA incluídos, pelas chaves de Sua equipe (`lia`, `trafego`…), na ordem do plano. */
  agents: z.array(Slug),
});
export type BillingPlan = z.infer<typeof BillingPlan>;

export const BillingPlansResponse = z.strictObject({
  /** A função `cobranca` está ligada para a empresa. */
  enabled: z.boolean(),
  /** Os planos que uma assinatura nova recebe, na ordem da tela. */
  items: z.array(BillingPlan),
});
export type BillingPlansResponse = z.infer<typeof BillingPlansResponse>;

export const BillingInvoice = z.strictObject({
  id: z.uuid(),
  /** `mensalidade` (um período) ou `diferenca` (a troca para um plano maior, pelos dias que faltam). */
  kind: Slug,
  plan_key: Slug,
  plan_name: z.string(),
  /** O período coberto; nulo na primeira mensalidade, até ela ser paga (o período começa no dia do pagamento). */
  period_start: Dia.nullable(),
  period_end: Dia.nullable(),
  due_date: Dia,
  amount_cents: Centavos,
  /** `aberta`, `paga`, `cancelada` ou `devolvida`. */
  status: Slug,
  paid_at: z.iso.datetime().nullable(),
  /** `cartao`, `pix` ou `pix_automatico`. */
  paid_method: Slug.nullable(),
  /** Na desistência em 7 dias: quando a devolução foi pedida (a confirmação muda a situação para `devolvida`). */
  refund_requested_at: z.iso.datetime().nullable(),
});
export type BillingInvoice = z.infer<typeof BillingInvoice>;

export const BrandSubscription = z.strictObject({
  id: z.uuid(),
  /** A versão do plano em vigor. */
  plan: BillingPlan,
  /** O plano que entra no período seguinte, quando o Dono desceu de plano; nulo sem troca marcada. */
  next_plan: BillingPlan.nullable(),
  /** `aguardando_pagamento`, `ativa`, `em_atraso`, `acoes_paradas`, `suspensa` ou `encerrada`. */
  status: Slug,
  /** A forma das próximas cobranças: `cartao`, `pix` ou `pix_automatico`. */
  method: Slug,
  /** O período em vigor (nulo antes do primeiro pagamento): `period_end` é o próximo vencimento. */
  period_start: Dia.nullable(),
  period_end: Dia.nullable(),
  /** Até quando o primeiro pagamento é esperado (só em `aguardando_pagamento`). */
  first_payment_until: Dia.nullable(),
  /**
   * A mensalidade em atraso, quando há: o vencimento, os dias de atraso e as datas dos próximos passos (Termos 10.4):
   * o dia em que as ações dos funcionários param e o da suspensão.
   */
  overdue: z
    .strictObject({
      due_date: Dia,
      days: z.int().min(1),
      actions_stop_on: Dia,
      suspends_on: Dia,
    })
    .nullable(),
  /** O Dono cancelou: a assinatura termina no fim do período pago (`period_end`). */
  cancel_at_period_end: z.boolean(),
  /** Até quando o Dono pode desistir com a devolução integral (só na primeira contratação, Termos 11.1); nulo: não pode. */
  withdraw_until: Dia.nullable(),
  ended_at: z.iso.datetime().nullable(),
  /** `cancelada`, `desistencia`, `nao_paga` ou `substituida`. */
  end_reason: Slug.nullable(),
  /**
   * O protocolo da desistência em 7 dias ("L-2026-1A2B3C4D"; D-A7-19, D-A7-43), quando a assinatura terminou nela: o
   * mesmo da auditoria e do e-mail de confirmação. Nulo nos outros casos.
   */
  withdraw_protocol: z.string().nullable(),
});
export type BrandSubscription = z.infer<typeof BrandSubscription>;

export const BillingQuery = z.strictObject({ brand_id: z.uuid() });
export type BillingQuery = z.infer<typeof BillingQuery>;

export const BillingResponse = z.strictObject({
  brand_id: z.uuid(),
  /** A função `cobranca` está ligada para a empresa. Desligada, a assinatura e as faturas vêm vazias. */
  enabled: z.boolean(),
  /** Quem pede muda o contrato (assinar, trocar de plano, cancelar, desistir): só o Dono (D-A7-13). */
  can_manage: z.boolean(),
  /** Quem pede paga e troca a forma de pagamento: o Dono e o Administrador com a cobrança liberada (D-A7-13). */
  can_pay: z.boolean(),
  /** O dia de hoje no fuso da empresa: as datas da tela contam dele. */
  today: Dia,
  /** A assinatura viva da marca; sem ela, a última que terminou; nula se a marca nunca assinou. */
  subscription: BrandSubscription.nullable(),
  /** As faturas da marca, a mais nova primeiro (até 36). */
  invoices: z.array(BillingInvoice),
});
export type BillingResponse = z.infer<typeof BillingResponse>;

/** Uma pessoa que cuida da cobrança da empresa (P26: "A cobrança fica com o Dono"; D-A7-13). */
export const BillingContact = z.strictObject({
  name: z.string(),
  /** O nível dela na empresa: `dono` ou o de quem tem a cobrança liberada (`administrador`). */
  role: Slug,
});
export type BillingContact = z.infer<typeof BillingContact>;

/**
 * Uma marca com mensalidade em atraso, para a faixa no alto das telas (D-A7-15). Quem paga a vê desde o 1º dia, com o
 * valor e a fatura para pagar; o resto da equipe, só a partir do 10º dia (as ações paradas), sem o valor nem a fatura.
 */
export const BillingOverdue = z.strictObject({
  brand_id: z.uuid(),
  brand_name: z.string(),
  /** `em_atraso`, `acoes_paradas` ou `suspensa`. */
  status: Slug,
  plan_name: z.string(),
  /** O vencimento da mensalidade mais antiga em aberto, os dias de atraso e os próximos passos (Termos 10.4). */
  due_date: Dia,
  days: z.int().min(1),
  actions_stop_on: Dia,
  suspends_on: Dia,
  /** Só para quem paga: o valor e a fatura em aberto (o PIX dela abre da faixa). */
  amount_cents: Centavos.nullable(),
  invoice_id: z.uuid().nullable(),
});
export type BillingOverdue = z.infer<typeof BillingOverdue>;

/**
 * Quem cuida da cobrança e a situação dela para todos da empresa (A7 · W5; D-A7-15, D-A7-40, D-A7-41, D-A7-42): é o
 * que a tela mostra a quem não vê a cobrança ("Fale com um deles"), a faixa do atraso no alto das telas e a tela da
 * conta suspensa para quem não é o Dono ("Quem resolve"). Com a função `cobranca` desligada, `enabled` é `false`, as
 * listas vêm vazias e `all_suspended` é `false`.
 */
export const BillingContactsResponse = z.strictObject({
  enabled: z.boolean(),
  /** O Dono primeiro; depois, quem tem a cobrança liberada, pelo nome (até 20). */
  items: z.array(BillingContact),
  /** As marcas da empresa com a conta suspensa (30º dia de atraso) e o dia em que a suspensão começou. */
  suspended: z.array(z.strictObject({ brand_id: z.uuid(), brand_name: z.string(), since: Dia })),
  /** Todas as marcas vivas da empresa estão suspensas: quem não é o Dono não entra em nada da empresa (D-A7-40). */
  all_suspended: z.boolean(),
  /** As marcas em atraso que a pessoa pode ver na faixa (D-A7-15), a mais atrasada primeiro. */
  overdue: z.array(BillingOverdue),
});
export type BillingContactsResponse = z.infer<typeof BillingContactsResponse>;

export const SubscribeRequest = z.strictObject({
  brand_id: z.uuid(),
  /** A chave de um dos planos oferecidos (`essencial`, `completo`). */
  plan: Slug,
  method: BillingMethod,
});
export type SubscribeRequest = z.infer<typeof SubscribeRequest>;

export const ChangePlanRequest = z.strictObject({
  brand_id: z.uuid(),
  plan: Slug,
  code: CodigoDoApp,
});
export type ChangePlanRequest = z.infer<typeof ChangePlanRequest>;

export const CancelSubscriptionRequest = z.strictObject({
  brand_id: z.uuid(),
  code: CodigoDoApp,
});
export type CancelSubscriptionRequest = z.infer<typeof CancelSubscriptionRequest>;

export const KeepSubscriptionRequest = z.strictObject({ brand_id: z.uuid() });
export type KeepSubscriptionRequest = z.infer<typeof KeepSubscriptionRequest>;

export const WithdrawSubscriptionRequest = z.strictObject({
  brand_id: z.uuid(),
  code: CodigoDoApp,
});
export type WithdrawSubscriptionRequest = z.infer<typeof WithdrawSubscriptionRequest>;

/** O PIX de uma fatura (A7, W2a; D-A7-30): o QR Code da cobrança no meio de pagamento, criada na hora se ainda não existe. */
export const BillingPixResponse = z.strictObject({
  invoice_id: z.uuid(),
  /** O valor e o vencimento da fatura do Liame. */
  amount_cents: Centavos,
  due_date: Dia,
  /** A imagem do QR Code, em PNG (base64). */
  qr_code_png_base64: z.string().min(1),
  /** O código "copia e cola" do PIX. */
  copy_paste: z.string().min(1),
  /** Até quando o QR Code vale, como o meio de pagamento informa; nulo quando ele não diz. */
  expires_at: z.string().nullable(),
  /** A fatura na página do meio de pagamento: outro jeito de pagar o mesmo PIX. */
  invoice_url: z.string().nullable(),
});
export type BillingPixResponse = z.infer<typeof BillingPixResponse>;
