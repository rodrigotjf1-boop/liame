import { z } from 'zod';
import { ExplanationResponse } from './ai.js';
import { AttentionItem } from './media.js';

// Revisão da semana (A3, I7; protótipo P4): o que vendeu, o que cada campanha trouxe no caixa, o que mudou e
// o que precisa de decisão, numa semana fechada da loja (de segunda a domingo, no fuso dela). Ela é gerada
// uma vez, na segunda-feira de manhã, e fica guardada como foi gerada: a tela e o e-mail mostram os mesmos
// números, mesmo que a plataforma reveja os dela depois. Dinheiro em micros (texto), razões com duas casas
// (texto), listas que crescem como texto (V23). Nenhum dado pessoal.
//
// A revisão guardada é lida por este mesmo contrato: campo novo aqui nasce OPCIONAL ou com valor padrão,
// para a revisão de uma semana antiga continuar abrindo.

const Slug = z.string().regex(/^[a-z0-9_]+$/);
const Dia = z.iso.date();
/** Valor em micros da moeda (1 real = 1.000.000), em texto. */
const Micros = z.string().regex(/^-?\d+$/);
/** Razão com duas casas ("3.80"), em texto; nula quando não dá para calcular. */
const Razao = z.string().regex(/^-?\d+\.\d{2}$/).nullable();

export const WeeklyReviewQuery = z.strictObject({
  brand_id: z.uuid(),
  /** A segunda-feira da semana pedida (AAAA-MM-DD); sem ela, a revisão mais recente da marca. */
  week: Dia.optional(),
});
export type WeeklyReviewQuery = z.infer<typeof WeeklyReviewQuery>;

/** Um número da semana ao lado do da semana anterior. A conta é do servidor; a tela e o e-mail só escrevem. */
export const WeeklyReviewChange = z.strictObject({
  /** `investimento`, `pedidos_de_anuncios`, `receita_confirmada`, `roas_confirmado`, `roas_da_campanha` ou `pedidos_sem_origem`. */
  kind: Slug,
  /** A campanha, quando o número é de uma. */
  campaign: z.strictObject({ id: z.uuid(), name: z.string(), provider: Slug }).nullable(),
  /** Como ler `before` e `now`: `dinheiro` (micros), `contagem` (inteiro) ou `razao` (duas casas). */
  unit: Slug,
  /** Nulo quando não havia o que comparar na semana anterior (ou o número não existe, como o ROAS sem investimento). */
  before: z.string().nullable(),
  now: z.string().nullable(),
  /** Variação sobre a semana anterior, com sinal e uma casa ("+12.8", "-34.2", "0.0"); nula sem valor antes. */
  change_pct: z.string().regex(/^[+-]?\d+\.\d$/).nullable(),
});
export type WeeklyReviewChange = z.infer<typeof WeeklyReviewChange>;

/** Uma linha de "O que cada campanha trouxe no caixa". */
export const WeeklyReviewCampaign = z.strictObject({
  campaign_id: z.uuid(),
  provider: Slug,
  name: z.string(),
  /** Situação da campanha na geração (`ativa`, `pausada`…). */
  status: Slug,
  spend_micros: Micros,
  /** Pedidos e receita confirmados no caixa com origem provada nesta campanha. */
  orders: z.number().int().min(0),
  revenue_micros: Micros,
  roas: Razao,
  /** `lucro`, `empata` ou `prejuizo`; nulo com margem incompleta ou sem investimento. */
  verdict: Slug.nullable(),
});
export type WeeklyReviewCampaign = z.infer<typeof WeeklyReviewCampaign>;

export const WeeklyReview = z.strictObject({
  id: z.uuid(),
  brand_id: z.uuid(),
  /** A semana da revisão e a anterior, usada na comparação (dias no fuso da loja, inclusive). */
  week: z.strictObject({ from: Dia, to: Dia }),
  previous_week: z.strictObject({ from: Dia, to: Dia }),
  timezone: z.string(),
  currency: z.string(),
  generated_at: z.string(),
  /** Os quatro números do topo: investimento, pedidos de anúncios, receita confirmada e ROAS confirmado. */
  totals: z.array(WeeklyReviewChange),
  /** O resultado da semana pela regra do sistema (`lucro`, `empata`, `prejuizo`); nulo com margem incompleta. */
  verdict: Slug.nullable(),
  /** As campanhas com investimento ou pedido na semana, a de maior investimento primeiro. */
  campaigns: z.array(WeeklyReviewCampaign),
  /** Pedidos provados só na plataforma (sem a campanha): contam no total, fora das campanhas. */
  platform_only: z.array(z.strictObject({ provider: Slug, orders: z.number().int().min(0), revenue_micros: Micros.nullable() })),
  improved: z.array(WeeklyReviewChange),
  worsened: z.array(WeeklyReviewChange),
  /**
   * O que precisa de decisão, no formato dos avisos da Atenção: a campanha em prejuízo pela segunda semana
   * seguida (`prejuizo_seguido`) e os avisos críticos e de atenção que estavam ativos na geração.
   */
  decisions: z.array(AttentionItem),
  /** A leitura da semana: da LIA ou, sem ela, do sistema, com o motivo. O mesmo formato do Explicar. */
  reading: ExplanationResponse,
  email: z.strictObject({
    /** `enviado`, `pendente`, `desligado` (o envio não está ligado para a empresa) ou `sem_destinatario`. */
    status: Slug,
    sent_at: z.string().nullable(),
    /** Para quantas pessoas a revisão foi enviada. */
    recipients: z.number().int().min(0),
  }),
});
export type WeeklyReview = z.infer<typeof WeeklyReview>;

export const WeeklyReviewResponse = z.strictObject({
  /** Nula quando a marca ainda não tem revisão (a primeira sai em `next_review_on`). */
  review: WeeklyReview.nullable(),
  /** A segunda-feira em que sai a próxima revisão, no fuso da loja. */
  next_review_on: Dia,
  timezone: z.string(),
});
export type WeeklyReviewResponse = z.infer<typeof WeeklyReviewResponse>;

// ---------------------------------------------------------------- o relatório do mês
//
// Relatório do mês (A3, I7; protótipo P24, decisões D-A3-18 a D-A3-22): a revisão da semana com o mês fechado da
// loja (do dia 1º ao último, no fuso dela), mais o que só o mês tem: cada semana cortada no mês. É gerado no dia
// 1º de manhã e guardado como foi gerado. As partes são as da revisão, no mesmo formato. O relatório guardado é
// lido por este mesmo contrato: campo novo aqui nasce OPCIONAL ou com valor padrão.

export const MonthlyReportQuery = z.strictObject({
  brand_id: z.uuid(),
  /** O mês pedido (AAAA-MM); sem ele, o relatório mais recente da marca. */
  month: z
    .string()
    .regex(/^\d{4}-(0[1-9]|1[0-2])$/)
    .optional(),
});
export type MonthlyReportQuery = z.infer<typeof MonthlyReportQuery>;

/** Uma semana do mês, de segunda a domingo, cortada no mês: o que foi investido e o que voltou no caixa. */
export const MonthlyReportWeek = z.strictObject({
  /** Os dias da semana que estão dentro do mês (as semanas das pontas ficam cortadas). */
  from: Dia,
  to: Dia,
  days: z.number().int().min(1).max(7),
  /** A semana inteira, de segunda a domingo: é a da revisão da semana. */
  week: z.strictObject({ from: Dia, to: Dia }),
  /** A revisão da semana inteira existe: a tela leva a ela. */
  has_review: z.boolean(),
  spend_micros: Micros,
  /** Pedidos e receita confirmados no caixa com origem provada em campanha, nos dias da semana dentro do mês. */
  orders: z.number().int().min(0),
  revenue_micros: Micros,
  roas: Razao,
  /** `lucro`, `empata` ou `prejuizo`; nulo com margem incompleta ou sem investimento. */
  verdict: Slug.nullable(),
});
export type MonthlyReportWeek = z.infer<typeof MonthlyReportWeek>;

export const MonthlyReport = z.strictObject({
  id: z.uuid(),
  brand_id: z.uuid(),
  /** O mês do relatório e o anterior, usado na comparação (dias no fuso da loja, inclusive). */
  month: z.strictObject({ from: Dia, to: Dia }),
  previous_month: z.strictObject({ from: Dia, to: Dia }),
  timezone: z.string(),
  currency: z.string(),
  generated_at: z.string(),
  /** Os quatro números do topo, cada um ao lado do do mês anterior (o formato da revisão da semana). */
  totals: z.array(WeeklyReviewChange),
  /** O resultado do mês pela regra do sistema (`lucro`, `empata`, `prejuizo`); nulo com margem incompleta. */
  verdict: Slug.nullable(),
  /** Cada semana do mês, da primeira à última. */
  weeks: z.array(MonthlyReportWeek),
  /** As campanhas com investimento ou pedido no mês, a de maior investimento primeiro. */
  campaigns: z.array(WeeklyReviewCampaign),
  /** Pedidos provados só na plataforma (sem a campanha): contam no total, fora das campanhas. */
  platform_only: z.array(z.strictObject({ provider: Slug, orders: z.number().int().min(0), revenue_micros: Micros.nullable() })),
  improved: z.array(WeeklyReviewChange),
  worsened: z.array(WeeklyReviewChange),
  /**
   * "Para o mês que vem", no formato dos avisos da Atenção: a campanha que deu prejuízo no mês (`prejuizo_no_mes`)
   * e os avisos críticos e de atenção que estavam ativos na geração.
   */
  decisions: z.array(AttentionItem),
  /** A leitura do mês: da LIA ou, sem ela, do sistema, com o motivo. O mesmo formato do Explicar. */
  reading: ExplanationResponse,
  email: z.strictObject({
    /** `enviado`, `pendente`, `desligado` (o envio não está ligado para a empresa), `sem_destinatario`, `falhou` ou `expirado`. */
    status: Slug,
    sent_at: z.string().nullable(),
    /** Para quantas pessoas o relatório foi enviado. */
    recipients: z.number().int().min(0),
  }),
});
export type MonthlyReport = z.infer<typeof MonthlyReport>;

export const MonthlyReportResponse = z.strictObject({
  /** Nulo quando a marca ainda não tem relatório (o primeiro sai em `next_report_on`). */
  report: MonthlyReport.nullable(),
  /** O dia 1º em que sai o próximo relatório, no fuso da loja. */
  next_report_on: Dia,
  timezone: z.string(),
});
export type MonthlyReportResponse = z.infer<typeof MonthlyReportResponse>;
