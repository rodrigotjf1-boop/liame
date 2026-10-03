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
