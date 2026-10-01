import { z } from 'zod';

// Cupons de campanha (A2.5, F6; plano-a25 §3; protótipo P3 com a plataforma de pedidos, aprovado em
// 30/09/2026). Só o cupom EXCLUSIVO de uma campanha prova de onde veio o pedido (ADR-020): ele vale no
// cardápio, no WhatsApp, no balcão e nas plataformas de pedidos que chegam ao Regem sem o clique do anúncio
// (Anota AI, CardápioWeb). Os cupons do Regem vêm da leitura; o de outra plataforma a empresa informa aqui
// (o Liame não cria nem muda nada nela). Dinheiro em micros da moeda, em texto (V23).

const Slug = z.string().regex(/^[a-z0-9_]+$/);
const Micros = z.string().regex(/^-?\d+$/);
const Contagem = z.number().int().min(0);
/** Dia no fuso da loja (AAAA-MM-DD). */
const Dia = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/** Onde a loja recebe os pedidos online. */
export const ORDER_PLATFORMS = ['regem', 'anotaai', 'cardapioweb', 'brendi', 'outra'] as const;
export const OrderPlatform = z.enum(ORDER_PLATFORMS);
export type OrderPlatform = z.infer<typeof OrderPlatform>;

/** Plataformas cujos pedidos chegam ao Regem pela integração, com o código do cupom: o cupom delas pode ser informado. */
export const EXTERNAL_COUPON_PLATFORMS = ['anotaai', 'cardapioweb'] as const;
export const ExternalCouponPlatform = z.enum(EXTERNAL_COUPON_PLATFORMS);
export type ExternalCouponPlatform = z.infer<typeof ExternalCouponPlatform>;

/**
 * Código de cupom como as plataformas aceitam e o Regem repassa (3 a 60 letras, números, ponto, hífen ou
 * sublinhado, sem espaço). A comparação com o pedido ignora maiúsculas e minúsculas.
 */
export const CouponCode = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{2,59}$/, 'Use de 3 a 60 letras, números, ponto, hífen ou sublinhado, sem espaço.');

export const CouponListQuery = z.strictObject({ brand_id: z.uuid() });
export type CouponListQuery = z.infer<typeof CouponListQuery>;

export const CouponStore = z.strictObject({
  /** A loja no Regem (conta conectada): de onde vêm os cupons e os pedidos. */
  connected_account_id: z.uuid(),
  /** Loja do Liame ligada a ela; nula enquanto não for ligada em Contas conectadas (sem ela, não dá para informar a plataforma nem cupom de outra plataforma). */
  unit: z.strictObject({ id: z.uuid(), name: z.string() }).nullable(),
  store_name: z.string(),
  /** Fuso da loja: os dias do vínculo e a validade dos cupons são dias nele. */
  timezone: z.string(),
  /** Plataforma de pedidos informada pela empresa; nula = não informada. */
  order_platform: OrderPlatform.nullable(),
  /** Endereço do cardápio, quando a plataforma é `outra`. */
  order_platform_url: z.string().nullable(),
  order_platform_set_at: z.string().nullable(),
  /** Última leitura com sucesso dos cupons desta loja no Regem. */
  coupons_read_at: z.string().nullable(),
  /** `fresh`, `delayed`, `stale` ou `unknown`. */
  coupons_freshness: Slug,
  /** Motivo da última leitura que falhou (`sem_permissao`, erro), sem dado da loja. */
  coupons_error: z.string().nullable(),
  /** A loja liberou "criar cupom de campanha" na autorização do Regem (sem isso, o Liame não pede a criação). */
  can_create: z.boolean(),
});
export type CouponStore = z.infer<typeof CouponStore>;

export const CouponCampaign = z.strictObject({
  id: z.uuid(),
  name: z.string(),
  /** `meta_ads` ou `google_ads`. */
  provider: Slug,
  status: Slug,
});
export type CouponCampaign = z.infer<typeof CouponCampaign>;

export const CouponLink = z.strictObject({
  id: z.uuid(),
  campaign: CouponCampaign,
  /** Só o exclusivo prova a origem; o não exclusivo fica ligado para acompanhar os usos. */
  exclusive: z.boolean(),
  /** Início do vínculo (instante); no futuro = agendado. */
  starts_at: z.string(),
  /** Fim do vínculo (instante, exclusivo); nulo = até desligar. */
  ends_at: z.string().nullable(),
  /** Gasto da campanha nos últimos 7 dias (para o aviso "exclusivo sem uso, com gasto"); nulo sem leitura de gasto. */
  campaign_spend_7d_micros: Micros.nullable(),
});
export type CouponLink = z.infer<typeof CouponLink>;

export const CouponItem = z.strictObject({
  id: z.uuid(),
  /** Como o pedido traz (maiúsculas). */
  code: z.string(),
  /** `regem` (lido do Regem) ou `externo` (informado de outra plataforma de pedidos). */
  origin: Slug,
  /** Plataforma do cupom informado (`anotaai`, `cardapioweb`); nula para o do Regem. */
  platform: Slug.nullable(),
  connected_account_id: z.uuid(),
  /** Do Regem: `percentual`, `valor`, `frete_gratis` ou `outro`; o informado é `outro` (a regra fica na plataforma). */
  kind: Slug,
  percent: z.number().nullable(),
  value_micros: Micros.nullable(),
  min_order_micros: Micros.nullable(),
  max_discount_micros: Micros.nullable(),
  /** Validade (instantes; o fim é exclusivo), no Regem. Nula no informado. */
  valid_from: z.string().nullable(),
  valid_until: z.string().nullable(),
  /** Ativo no Regem (o informado é sempre ativo: vive na plataforma). */
  active: z.boolean(),
  /** Validade vencida. */
  expired: z.boolean(),
  /** Quando o Liame viu (do Regem) ou recebeu (informado) o cupom. */
  first_seen_at: z.string(),
  /** Pedidos confirmados nos últimos 7 dias com o código, na loja do cupom. */
  uses_7d: Contagem,
  /** Receita desses pedidos (menos o estornado). */
  revenue_7d_micros: Micros,
  /** A ligação em vigor ou agendada; nula = sem campanha. */
  link: CouponLink.nullable(),
});
export type CouponItem = z.infer<typeof CouponItem>;

export const DetectedPlatform = z.strictObject({
  platform: OrderPlatform,
  /** O endereço de onde saiu a sugestão (só o domínio). */
  host: z.string(),
  /** `meta_ads` ou `google_ads`. */
  provider: Slug,
  /** Anúncios ativos que levam a ele. */
  ads: Contagem,
});
export type DetectedPlatform = z.infer<typeof DetectedPlatform>;

/**
 * Pedido de criação de cupom no Regem (ADR-019 item 6): passa pela aprovação e só depois o Liame cria o cupom
 * na loja. Enquanto isso, o cupom ainda não existe no Regem.
 */
export const CouponRequest = z.strictObject({
  /** O pedido no Action Service: aprovar é por ele (`POST /v1/actions/{id}/approve`). */
  action_id: z.uuid(),
  code: z.string(),
  connected_account_id: z.uuid(),
  /** `percentual`, `valor` ou `frete_gratis`. */
  kind: Slug,
  percent: z.number().nullable(),
  value_micros: Micros.nullable(),
  min_order_micros: Micros.nullable(),
  /** Validade pedida, em dias do fuso da loja (o fim é inclusive). */
  valid_from: Dia,
  valid_until: Dia,
  /** A campanha do cupom; nula se ela saiu da lista depois do pedido. */
  campaign: CouponCampaign.nullable(),
  exclusive: z.boolean(),
  /** `aguardando_aprovacao`, `aprovada`, `executando` (o Liame está criando no Regem), `falhou`, `expirada` ou `recusada` (por quem aprova). */
  status: Slug,
  /** O motivo, quando o pedido falhou, expirou ou foi recusado (`recusada por <nome>: <motivo>`). */
  status_reason: z.string().nullable(),
  requested_by: z.strictObject({ id: z.uuid(), name: z.string() }),
  requested_at: z.string(),
  /** Sem aprovação até aqui, o pedido expira. */
  expires_at: z.string(),
});
export type CouponRequest = z.infer<typeof CouponRequest>;

export const CouponListResponse = z.strictObject({
  /** Lojas da marca com o Regem conectado. */
  stores: z.array(CouponStore),
  /** Cupons das lojas da marca (sem os apagados na origem): ligados primeiro, depois por código. */
  items: z.array(CouponItem),
  /**
   * Pedidos de criação no Regem em andamento (esperando aprovação ou sendo criados) e os que falharam, expiraram
   * ou foram recusados nos últimos 3 dias sem que o cupom exista. Os mais novos primeiro.
   */
  requests: z.array(CouponRequest),
  /** Campanhas ativas e pausadas da Meta e do Google Ads da marca (para ligar e para a conferência de cupom). */
  campaigns: z.array(CouponCampaign),
  /** Plataforma de pedidos sugerida pelo destino dos anúncios ativos; nula quando não dá para dizer. */
  detected_platform: DetectedPlatform.nullable(),
  /** Criar cupom no Regem pelo Liame (com aprovação) está ligado para esta empresa e marca. Desligado, o cupom se cria no Regem. */
  create_in_regem: z.boolean(),
  generated_at: z.string(),
});
export type CouponListResponse = z.infer<typeof CouponListResponse>;

export const LinkCouponRequest = z.strictObject({
  campaign_id: z.uuid(),
  exclusive: z.boolean(),
  /** Primeiro dia do vínculo, no fuso da loja (padrão: hoje); não pode ser antes de hoje. */
  starts_on: Dia.optional(),
  /** Último dia do vínculo (inclusive); sem ele, até desligar. */
  ends_on: Dia.nullable().optional(),
});
export type LinkCouponRequest = z.infer<typeof LinkCouponRequest>;

export const CreateExternalCouponRequest = z.strictObject({
  /** Loja do Liame (com o Regem conectado) cujos pedidos trazem o cupom. */
  unit_id: z.uuid(),
  platform: ExternalCouponPlatform,
  code: CouponCode,
  campaign_id: z.uuid(),
  exclusive: z.boolean(),
});
export type CreateExternalCouponRequest = z.infer<typeof CreateExternalCouponRequest>;

/** Código do cupom que o Liame cria no Regem: de 4 a 20 letras ou números, sem espaço (vai em maiúsculas). */
export const RegemCouponCode = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z0-9]{4,20}$/, 'Use de 4 a 20 letras ou números, sem espaço nem acento.');

/** Tipos de desconto que o Liame pede ao Regem. */
export const REGEM_COUPON_KINDS = ['percentual', 'valor', 'frete_gratis'] as const;

export const CreateRegemCouponRequest = z.strictObject({
  /** Loja do Liame com o Regem conectado: o cupom nasce nela. */
  unit_id: z.uuid(),
  code: RegemCouponCode,
  kind: z.enum(REGEM_COUPON_KINDS),
  /** Só no `percentual`: de 1 a 100, inteiro. */
  percent: z.int().min(1).max(100).optional(),
  /** Só no `valor`: o desconto, em micros (centavo inteiro). */
  value_micros: Micros.optional(),
  /** Pedido mínimo, em micros (centavo inteiro); sem ele, não há mínimo. */
  min_order_micros: Micros.optional(),
  /** Primeiro e último dia da validade (inclusive), no fuso da loja. */
  valid_from: Dia,
  valid_until: Dia,
  campaign_id: z.uuid(),
  /** Só o cupom exclusivo da campanha prova de onde veio o pedido. */
  exclusive: z.boolean(),
});
export type CreateRegemCouponRequest = z.infer<typeof CreateRegemCouponRequest>;

export const CouponRequestResponse = z.strictObject({ request: CouponRequest });
export type CouponRequestResponse = z.infer<typeof CouponRequestResponse>;

export const SetOrderPlatformRequest = z.strictObject({
  platform: OrderPlatform,
  /** Só com `outra`: o endereço do cardápio (https). */
  url: z.string().trim().min(12).max(1024).nullable().optional(),
});
export type SetOrderPlatformRequest = z.infer<typeof SetOrderPlatformRequest>;

export const CouponResponse = z.strictObject({
  item: CouponItem,
  /** Pedidos que o motor recalculou por causa da mudança. */
  reattributed_orders: Contagem,
});
export type CouponResponse = z.infer<typeof CouponResponse>;

export const OrderPlatformResponse = z.strictObject({ store: CouponStore });
export type OrderPlatformResponse = z.infer<typeof OrderPlatformResponse>;
