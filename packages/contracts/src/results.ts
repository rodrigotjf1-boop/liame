import { z } from 'zod';
import { AttentionItem } from './media.js';

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
   * Receita dos pedidos com a margem conhecida (a base de `margin_coverage_pct`). O custo conhecido dos produtos é
   * esta receita menos `margin_known_micros`; o resto da receita é de pedido com item sem custo (desconhecido ≠
   * zero). A rota manda sempre; só falta em respostas guardadas antes de 07/10/2026 (casos de eval).
   */
  revenue_with_margin_micros: Micros.optional(),
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

/**
 * O cupom de cada mensagem é só dela: é por ele que o pedido se liga à mensagem, sem nome e sem telefone de ninguém.
 * O pedido que tem o cupom de uma mensagem E prova de anúncio fica com o anúncio (decisão do dono em 10/10/2026).
 */
export const MessageTotals = z.strictObject({
  /** Confirmados, com o cupom de uma mensagem e sem prova de anúncio, de qualquer canal. */
  orders: z.number().int().min(0),
  revenue_micros: Micros,
  /** Os de `orders` que são do cardápio e do WhatsApp: já saíram de `without_origin` (a origem deles é a mensagem). */
  own_channel_orders: z.number().int().min(0),
  /** Usaram o cupom de uma mensagem e têm prova de anúncio: contam em `confirmed`, e não em `orders`. */
  with_ad_orders: z.number().int().min(0),
});
export type MessageTotals = z.infer<typeof MessageTotals>;

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
    /**
     * Os pedidos que vieram pelo cupom de uma mensagem de WhatsApp (A5, D-A5-16; protótipo P15, parte C). Só vem
     * quando a marca tem cupom de mensagem valendo em algum dia do período, ou pedido com ele; sem isso, o campo
     * falta e a resposta é a de sempre. Mensagem não é anúncio: nada aqui entra em `confirmed`.
     */
    messages: MessageTotals.optional(),
  }),
  platforms: z.array(PlatformResult),
  campaigns: z.array(CampaignResult),
  sources: z.array(SourceFreshness),
  generated_at: z.string(),
});
export type ClosedLoopResponse = z.infer<typeof ClosedLoopResponse>;

// A linha dos dias (07/10/2026, resultados em gráficos). Rota à parte de `closed-loop`, que também serve as rotinas
// internas: quem não desenha o gráfico não paga por ele. A consulta é a mesma (`ClosedLoopQuery`).
export const DailyResult = z.strictObject({
  /** Dia (AAAA-MM-DD): o do faturamento do pedido, no fuso da loja; o do gasto, no fuso de cada conta de anúncio. */
  date: z.string(),
  spend_micros: Micros,
  /** Pedidos confirmados com evidência alta ou média (os mesmos de `totals.confirmed` em `closed-loop`). */
  orders: z.number().int().min(0),
  revenue_micros: Micros,
});
export type DailyResult = z.infer<typeof DailyResult>;

export const DailyResultsResponse = z.strictObject({
  period: z.strictObject({ from: z.string(), to: z.string(), timezone: z.string() }),
  currency: z.string(),
  /** Um item por dia do período, em ordem, com zero onde não houve gasto nem pedido. */
  days: z.array(DailyResult),
  /** O período de mesmo tamanho logo antes, somado: para dizer se o retorno subiu ou caiu. */
  previous: z.strictObject({
    from: z.string(),
    to: z.string(),
    spend_micros: Micros,
    orders: z.number().int().min(0),
    revenue_micros: Micros,
    /** Receita confirmada com evidência ÷ gasto; nulo sem gasto. */
    roas: Razao,
  }),
  generated_at: z.string(),
});
export type DailyResultsResponse = z.infer<typeof DailyResultsResponse>;

// ------------------------------------------------------------ Como os anúncios rodaram (P23)
// O que a Meta e o Google informam da entrega dos anúncios, na contagem deles: impressões, alcance, cliques, gasto e o
// resultado que a plataforma conta. O caixa continua em `closed-loop`; o gasto é o mesmo nos dois.

/** Contagem inteira, em texto (cabe em numeric sem ponto flutuante). */
const Contagem = z.string().regex(/^\d+$/);

export const AdDeliveryQuery = z.strictObject({
  brand_id: z.uuid(),
  /** Dias no fuso da conta de anúncio (AAAA-MM-DD), inclusive, como em `closed-loop`. */
  from: z.iso.date(),
  to: z.iso.date(),
});
export type AdDeliveryQuery = z.infer<typeof AdDeliveryQuery>;

/** O que a plataforma conta como resultado da campanha, na janela dela. */
export const AdDeliveryResult = z.strictObject({
  /** `purchases` (compras, Meta), `conversations` (conversas iniciadas, Meta) ou `conversions` (Google Ads). */
  kind: Slug,
  /** Pode ter casas decimais no Google (o modelo de atribuição divide a conversão). */
  value: z.string().regex(/^\d+(\.\d{1,2})?$/),
  /** `7d_click` (Meta, 7 dias depois do clique) ou `padrao` (Google Ads: a janela de cada ação de conversão). */
  window: Slug,
});
export type AdDeliveryResult = z.infer<typeof AdDeliveryResult>;

export const AdDeliveryCampaign = z.strictObject({
  campaign_id: z.uuid(),
  provider: Slug,
  name: z.string(),
  status: Slug,
  /** O objetivo como a plataforma o guarda (`OUTCOME_TRAFFIC`, `SEARCH`…); nulo sem ele. */
  objective: z.string().nullable(),
  impressions: Contagem,
  /**
   * Pessoas diferentes que viram os anúncios da campanha no período: só a Meta informa, e só para hoje, 7 e 30 dias
   * (o período lido como um número só). Nulo no Google e em outro período. Não se soma entre campanhas.
   */
  reach: Contagem.nullable(),
  /** Todos os cliques no anúncio. */
  clicks: Contagem,
  /** Cliques no link (só a Meta); nulo no Google. */
  link_clicks: Contagem.nullable(),
  spend_micros: Micros,
  result: AdDeliveryResult.nullable(),
});
export type AdDeliveryCampaign = z.infer<typeof AdDeliveryCampaign>;

export const AdDeliveryAccount = z.strictObject({
  connected_account_id: z.uuid(),
  /** `meta_ads` ou `google_ads`. */
  provider: Slug,
  name: z.string(),
  /** `ativa`, `desconectada`, `sem_permissao` ou `erro`. */
  status: Slug,
  /** A última leitura que deu certo; nula antes da primeira. */
  last_success_at: z.string().nullable(),
  /** A última tentativa (deu certo ou não); nula antes da primeira. */
  last_attempt_at: z.string().nullable(),
  /** O erro da última tentativa, quando ela falhou (texto para quem cuida do Liame; a tela usa `status`). */
  last_error: z.string().nullable(),
});
export type AdDeliveryAccount = z.infer<typeof AdDeliveryAccount>;

export const AdDeliveryResponse = z.strictObject({
  /** A função ligada para a empresa (`desempenho_anuncios`); desligada, o resto vem vazio e a tela não mostra o cartão. */
  enabled: z.boolean(),
  period: z.strictObject({ from: z.string(), to: z.string() }),
  accounts: z.array(AdDeliveryAccount),
  totals: z.strictObject({
    impressions: Contagem,
    clicks: Contagem,
    spend_micros: Micros,
    /** Pessoas diferentes na Meta, pela conta, no período (soma das contas da Meta da marca); nulo sem ele. */
    meta_reach: Contagem.nullable(),
  }),
  campaigns: z.array(AdDeliveryCampaign),
  /** "Ler agora": uma vez a cada 15 minutos por empresa. `next_at` = quando dá para pedir de novo (nulo = já dá). */
  refresh: z.strictObject({ available: z.boolean(), next_at: z.string().nullable() }),
});
export type AdDeliveryResponse = z.infer<typeof AdDeliveryResponse>;

export const AdDeliveryRefreshRequest = z.strictObject({ brand_id: z.uuid() });
export type AdDeliveryRefreshRequest = z.infer<typeof AdDeliveryRefreshRequest>;

export const AdDeliveryRefreshResponse = z.strictObject({
  /** A hora do pedido: a leitura terminou quando o `last_success_at` de cada conta passa dela. */
  requested_at: z.string(),
  /** Quantas contas de anúncio da marca foram mandadas ler. */
  accounts: z.number().int().min(0),
  next_at: z.string(),
});
export type AdDeliveryRefreshResponse = z.infer<typeof AdDeliveryRefreshResponse>;

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
  /**
   * A mensagem de WhatsApp cujo cupom o pedido usou (protótipo P15, parte C); falta ou é nula quando o pedido não
   * usou cupom de mensagem. Com `attribution.counted`, o pedido fica com o anúncio; sem, a origem dele é a mensagem.
   */
  message: z
    .strictObject({
      /** O nome que a loja deu à mensagem. */
      name: z.string(),
      coupon_code: z.string(),
      /** Quando o cupom nasceu, junto com o envio. */
      sent_at: z.string(),
    })
    .nullable()
    .optional(),
});
export type OrderOrigin = z.infer<typeof OrderOrigin>;

export const OrderOriginResponse = z.strictObject({ items: z.array(OrderOrigin) });
export type OrderOriginResponse = z.infer<typeof OrderOriginResponse>;

// Atenção do ciclo fechado (A2.5, F9): os avisos que cruzam a mídia com as vendas confirmadas, no mesmo
// formato dos avisos de mídia (`AttentionItem`), para a tela Atenção juntar os dois. Calculados na hora.
export const ClosedLoopAttentionQuery = z.strictObject({ brand_id: z.uuid().optional() });
export type ClosedLoopAttentionQuery = z.infer<typeof ClosedLoopAttentionQuery>;

export const ClosedLoopAttentionResponse = z.strictObject({
  /** Mais grave primeiro. */
  items: z.array(AttentionItem),
  generated_at: z.string(),
});
export type ClosedLoopAttentionResponse = z.infer<typeof ClosedLoopAttentionResponse>;
