import { z } from 'zod';

// Resultados do ciclo fechado (A2.5, F8; ADR-020, D-A2.5-6 a 8): o ROAS que a plataforma informa, com a
// janela dela, ao lado do ROAS confirmado no caixa do Regem, com a janela do modelo. Dinheiro em micros
// (texto: cabe em bigint sem ponto flutuante); razões com 2 casas (texto). Nenhum dado pessoal: pedido
// aparece pelo id da origem, canal e valores. Listas que crescem vão como texto (V23).

const Slug = z.string().regex(/^[a-z0-9_]+$/);
/** Valor em micros da moeda (1 real = 1.000.000), em texto. */
const Micros = z.string().regex(/^-?\d+$/);
/** Razão com duas casas ("3.80"), em texto; nulo quando não dá para calcular (sem gasto, sem valor). */
const Razao = z.string().regex(/^-?\d+\.\d{2}$/).nullable();
/** Porcentagem com uma casa ("83.4"). */
const Porcento = z.string().regex(/^\d{1,3}\.\d$/).nullable();

export const ClosedLoopQuery = z.strictObject({
  brand_id: z.uuid(),
  /** Loja do Liame: sem ela, todas as lojas da marca. */
  unit_id: z.uuid().optional(),
  /** Dias no fuso da loja (AAAA-MM-DD), inclusive. */
  from: z.iso.date(),
  to: z.iso.date(),
});
export type ClosedLoopQuery = z.infer<typeof ClosedLoopQuery>;

export const SourceFreshness = z.strictObject({
  connected_account_id: z.uuid(),
  /** `meta_ads`, `google_ads`, `regem`… */
  provider: Slug,
  name: z.string(),
  /** Conjunto de dados que conta para a tela (`metricas` na mídia, `pedidos` no Regem). */
  dataset: Slug,
  /** `fresh`, `delayed`, `stale` ou `unknown`. */
  freshness: Slug,
  last_success_at: z.string().nullable(),
  /** `ativa`, `desconectada`, `sem_permissao` ou `erro`. */
  status: Slug,
  timezone: z.string().nullable(),
});
export type SourceFreshness = z.infer<typeof SourceFreshness>;

/** O que a plataforma informa, com a janela dela (nunca misturada com a do caixa). */
export const PlatformReport = z.strictObject({
  spend_micros: Micros,
  /** Valor de venda que a plataforma atribui; nulo quando ela não informa (campanha de mensagem). */
  value_micros: Micros.nullable(),
  roas: Razao,
  /** Ex.: `7d_click` (Meta, 7 dias depois do clique) ou `padrao` (Google Ads: a janela de cada ação de conversão). */
  window: Slug,
  conversions: z.string().nullable(),
  conversations: z.string().nullable(),
  cost_per_conversation_micros: Micros.nullable(),
});
export type PlatformReport = z.infer<typeof PlatformReport>;

/** O que o caixa confirma, com o modelo de atribuição (último toque, 7 dias, sem visualização). */
export const ConfirmedResult = z.strictObject({
  orders: z.number().int().min(0),
  revenue_micros: Micros,
  roas: Razao,
  cost_per_order_micros: Micros.nullable(),
  /** Margem dos pedidos com o custo de todos os itens conhecido; nula sem nenhum (margem desconhecida ≠ zero). */
  margin_known_micros: Micros.nullable(),
  /** Parte da receita confirmada com margem conhecida. */
  margin_coverage_pct: Porcento,
  /**
   * `lucro`, `empata` ou `prejuizo`: (margem conhecida − investimento) ÷ investimento acima de +10%, entre
   * −10% e +10% ou abaixo de −10% (regra dos protótipos aprovados). Nulo com cobertura de margem abaixo de
   * 80% (a tela mostra "margem incompleta") ou sem investimento.
   */
  verdict: Slug.nullable(),
});
export type ConfirmedResult = z.infer<typeof ConfirmedResult>;

export const PlatformResult = z.strictObject({
  provider: Slug,
  platform: PlatformReport,
  confirmed: ConfirmedResult,
  /** Pedidos provados só na plataforma (id de clique sem campanha): entram aqui, não em campanha nenhuma. */
  platform_only_orders: z.number().int().min(0),
});
export type PlatformResult = z.infer<typeof PlatformResult>;

export const CampaignResult = z.strictObject({
  campaign_id: z.uuid(),
  provider: Slug,
  name: z.string(),
  status: Slug,
  platform: PlatformReport,
  confirmed: ConfirmedResult,
});
export type CampaignResult = z.infer<typeof CampaignResult>;

export const ChannelTotals = z.strictObject({
  /** `marketplace`, `presencial`, `outro`… */
  channel_group: Slug,
  orders: z.number().int().min(0),
  revenue_micros: Micros,
});

export const ClosedLoopResponse = z.strictObject({
  period: z.strictObject({
    from: z.string(),
    to: z.string(),
    /** Fuso da loja: corta o dia dos pedidos. */
    timezone: z.string(),
    /** Fusos das contas de anúncio: cortam o dia do gasto (declarados quando diferem, V34). */
    account_timezones: z.array(z.string()),
  }),
  model: z.strictObject({ id: z.uuid(), key: Slug, version: z.number().int(), window_days: z.number().int(), counts_views: z.boolean() }),
  currency: z.string(),
  totals: z.strictObject({
    spend_micros: Micros,
    /** Todos os pedidos confirmados (e não cancelados) do período. */
    orders_confirmed: z.number().int().min(0),
    revenue_micros: Micros,
    /** Confirmados com evidência alta ou média (campanha ou só plataforma). */
    confirmed: ConfirmedResult,
    /** Canais próprios sem evidência: sem origem; a porcentagem é sobre os pedidos dos canais com clique (sem os canais sem clique). */
    without_origin: z.strictObject({ orders: z.number().int().min(0), revenue_micros: Micros, share_pct: Porcento }),
    /** Marketplaces, balcão e outros canais sem clique: à parte do ROAS de mídia própria (D-A2.5-11). */
    no_click_channels: z.array(ChannelTotals),
    /** Confirmados no período e cancelados depois: saem das contas. */
    cancelled: z.strictObject({ orders: z.number().int().min(0), revenue_micros: Micros }),
  }),
  platforms: z.array(PlatformResult),
  campaigns: z.array(CampaignResult),
  sources: z.array(SourceFreshness),
  generated_at: z.string(),
});
export type ClosedLoopResponse = z.infer<typeof ClosedLoopResponse>;

export const OrderOriginQuery = z.strictObject({
  brand_id: z.uuid(),
  unit_id: z.uuid().optional(),
  from: z.iso.date(),
  to: z.iso.date(),
  campaign_id: z.uuid().optional(),
  /** Situação da atribuição. */
  status: z.enum(['atribuido', 'plataforma', 'sem_origem']).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type OrderOriginQuery = z.infer<typeof OrderOriginQuery>;

/** Por que um pedido é (ou não) de uma campanha: evidência, momento, janela e confiança. Sem dado pessoal. */
export const OrderOrigin = z.strictObject({
  order_id: z.uuid(),
  external_id: z.string(),
  channel: Slug,
  channel_group: Slug,
  /** `confirmado` ou `cancelado`. */
  status: Slug,
  confirmed_at: z.string(),
  revenue_micros: Micros,
  margin_micros: Micros.nullable(),
  attribution: z.strictObject({
    /** `atribuido`, `plataforma` ou `sem_origem`. */
    status: Slug,
    /** `cupom`, `clique_campanha`, `conversa_anuncio`, `clique_plataforma`, `conversa_plataforma`. */
    evidence: Slug.nullable(),
    confidence: Slug.nullable(),
    provider: Slug.nullable(),
    campaign: z.strictObject({ id: z.uuid(), name: z.string() }).nullable(),
    ad: z.strictObject({ id: z.uuid(), name: z.string() }).nullable(),
    touch_at: z.string().nullable(),
    /** Horas entre o toque e a confirmação do pedido. */
    hours_before: z.number().nullable(),
    window_days: z.number().int(),
    counted: z.boolean(),
    /** Para sem origem: `sem_evidencia`, `fora_da_janela`, `canal_sem_clique`, `sem_id`; ou `cancelado`. */
    reason: Slug.nullable(),
  }),
});
export type OrderOrigin = z.infer<typeof OrderOrigin>;

export const OrderOriginResponse = z.strictObject({ items: z.array(OrderOrigin) });
export type OrderOriginResponse = z.infer<typeof OrderOriginResponse>;
