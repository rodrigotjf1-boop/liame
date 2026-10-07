import { z } from 'zod';
import { AttentionItem } from './media.js';
import { SourceFreshness } from './results.js';

// Resumo (A3, I13c; protótipo P8, aguardando aprovação): a página inicial do Lite. O dinheiro do marketing nos últimos
// 7 dias completos (as vendas confirmadas no caixa que vieram dos anúncios, o gasto e o que sobrou), com a semana
// anterior; o veredito pela regra de Resultados, com as campanhas que deram lucro e prejuízo; os pedidos; de onde
// vieram; e o que precisa da pessoa (avisos e aprovações). Os números são os de Resultados, ditos pelo código, com o
// frescor de cada fonte; "o que a equipe fez" vem de `/v1/team`. Dinheiro em micros (texto); porcentagem com uma casa.

const Slug = z.string().regex(/^[a-z0-9_]+$/).max(60);
/** Valor em micros da moeda (1 real = 1.000.000), em texto. */
const Micros = z.string().regex(/^-?\d+$/);
/** Porcentagem com uma casa ("83.4"). */
const Porcento = z.string().regex(/^\d{1,3}\.\d$/).nullable();
const CampanhaDoVeredito = z.strictObject({ campaign_id: z.uuid(), name: z.string(), provider: Slug });

export const SummaryQuery = z.strictObject({ brand_id: z.uuid() });
export type SummaryQuery = z.infer<typeof SummaryQuery>;

export const SummaryResponse = z.strictObject({
  brand_id: z.uuid(),
  /** `ok`; `sem_regem` (a marca não tem loja do Regem conectada: sem as vendas); `primeira_semana` (as contas foram conectadas depois do começo do período). */
  state: Slug,
  /** Os últimos 7 dias completos, no fuso da loja, e os 7 antes. */
  period: z.strictObject({ from: z.iso.date(), to: z.iso.date(), timezone: z.string() }),
  previous: z.strictObject({ from: z.iso.date(), to: z.iso.date() }),
  money: z.strictObject({
    /** As vendas confirmadas no caixa com origem nos anúncios. */
    revenue_micros: z.strictObject({ now: Micros, before: Micros.nullable() }),
    spend_micros: z.strictObject({ now: Micros, before: Micros.nullable() }),
    /** Margem conhecida − gasto; nulo com a margem conhecida abaixo de 80% da receita (não dá para dizer). */
    left_micros: z.strictObject({ now: Micros.nullable(), before: Micros.nullable() }),
    margin_known_micros: Micros.nullable(),
    margin_coverage_pct: Porcento,
    /**
     * A receita dos pedidos com margem conhecida: o custo conhecido dos produtos é ela menos a margem, e o resto da
     * receita é de itens sem custo cadastrado. É o que a barra "para onde foi cada real vendido" precisa. Opcional:
     * resposta de antes de 07/10/2026 não a traz.
     */
    revenue_with_margin_micros: Micros.optional(),
    /** `lucro`, `empata` ou `prejuizo`, pela regra de Resultados; nulo com a margem incompleta ou sem gasto. */
    verdict: Slug.nullable(),
  }),
  /** As campanhas que deram lucro e as que deram prejuízo no período (até 3 cada, maior gasto primeiro). */
  campaigns: z.strictObject({ profit: z.array(CampanhaDoVeredito), loss: z.array(CampanhaDoVeredito) }),
  orders: z.strictObject({
    /** Pedidos confirmados com origem nos anúncios. */
    marketing: z.int().min(0),
    /** Receita ÷ pedidos do marketing; nulo sem pedido. */
    average_micros: Micros.nullable(),
    all_channels: z.int().min(0),
    /** Do cardápio e do WhatsApp, sem origem provada. */
    without_origin: z.int().min(0),
  }),
  /**
   * Por plataforma de anúncio: os pedidos com origem nela, o que sobrou (nulo com a margem incompleta ou sem pedido) e
   * o gasto dela no período (opcional: resposta de antes de 07/10/2026 não o traz).
   */
  platforms: z.array(z.strictObject({ provider: Slug, orders: z.int().min(0), left_micros: Micros.nullable(), spend_micros: Micros.optional() })),
  needs_you: z.strictObject({
    critical: z.int().min(0),
    attention: z.int().min(0),
    /** Os avisos críticos e de atenção, mais grave primeiro (até 5); os de mídia só para quem acompanha as campanhas. */
    items: z.array(AttentionItem),
    /** O que espera decisão: ações (Aprovações), planos do Estrategista e propostas de autonomia. */
    approvals: z.strictObject({ actions: z.int().min(0), plans: z.int().min(0), autonomy: z.int().min(0) }),
  }),
  sources: z.array(SourceFreshness),
  generated_at: z.iso.datetime(),
});
export type SummaryResponse = z.infer<typeof SummaryResponse>;
