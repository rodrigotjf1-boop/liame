import { z } from 'zod';

// Links de campanha (A2.5, F5; plano-a25 §3; protótipo P3 aprovado em 29/09/2026): o link do cardápio da loja
// com o código do Liame (`lk`) e os parâmetros de cada plataforma para colar no anúncio — o Liame não escreve
// na Meta nem no Google —, o QR para material impresso e a conferência dos anúncios ativos (o que vira o
// aviso "anúncio ativo sem rastreio" da Atenção, F9). Listas que crescem vão como texto nas respostas (V23).

const Slug = z.string().regex(/^[a-z0-9_]+$/);
const Contagem = z.number().int().min(0);

export const LinkListQuery = z.strictObject({
  brand_id: z.uuid(),
  /** Loja do Liame: sem ela, os links de todas as lojas da marca. */
  unit_id: z.uuid().optional(),
  campaign_id: z.uuid().optional(),
});
export type LinkListQuery = z.infer<typeof LinkListQuery>;

export const LinkOptionsQuery = z.strictObject({ brand_id: z.uuid() });
export type LinkOptionsQuery = z.infer<typeof LinkOptionsQuery>;

export const TrackingCheckQuery = z.strictObject({ brand_id: z.uuid() });
export type TrackingCheckQuery = z.infer<typeof TrackingCheckQuery>;

export const CreateTrackingLinkRequest = z.strictObject({
  /** Loja do Liame cujo cardápio (do Regem) é o destino. */
  unit_id: z.uuid(),
  /** Campanha da Meta ou do Google Ads, da mesma marca da loja. */
  campaign_id: z.uuid(),
  /** Anúncio da campanha; sem ele, o link vale para todos os anúncios da campanha. */
  ad_id: z.uuid().nullable().optional(),
  name: z.string().trim().min(1).max(60),
  /**
   * Página dentro do cardápio da loja (padrão: o próprio cardápio). Só https, na mesma origem e dentro do
   * caminho do cardápio, sem usuário e senha e sem parâmetro de rastreio: o resto é recusado (V33).
   */
  destination_url: z.string().min(8).max(1024).optional(),
});
export type CreateTrackingLinkRequest = z.infer<typeof CreateTrackingLinkRequest>;

export const PlatformParams = z.strictObject({
  /** Onde colar: `url_tags` (Meta, campo "Parâmetros de URL" do anúncio) ou `final_url_suffix` (Google Ads, "Sufixo do URL final"). */
  field: Slug,
  /** O texto para colar, sem o `?`, com os parâmetros dinâmicos que a plataforma troca no clique. */
  value: z.string(),
});
export type PlatformParams = z.infer<typeof PlatformParams>;

export const TrackingLink = z.strictObject({
  id: z.uuid(),
  brand_id: z.uuid(),
  unit: z.strictObject({ id: z.uuid(), name: z.string() }).nullable(),
  name: z.string(),
  /** O código do link (`lk`), o mesmo no link, nos parâmetros e no QR. */
  code: z.string(),
  /** `meta_ads` ou `google_ads`. */
  provider: Slug,
  /** Nula se a campanha saiu da conta conectada. */
  campaign: z.strictObject({ id: z.uuid(), name: z.string(), status: Slug }).nullable(),
  /** Anúncio do link; nulo = todos os anúncios da campanha. */
  ad: z.strictObject({ id: z.uuid(), name: z.string() }).nullable(),
  /** Cardápio da loja (ou página dentro dele). */
  destination_url: z.string(),
  /** Link com rastreio para a bio, o WhatsApp da loja e o QR impresso. */
  tracking_url: z.string(),
  /** Parâmetros para colar no anúncio da plataforma da campanha (nulo para plataforma sem regra de parâmetros). */
  platform_params: PlatformParams.nullable(),
  /** Pedidos confirmados nos últimos 7 dias que chegaram com o código deste link e ficaram com a campanha (pedido com cupom exclusivo conta pelo cupom). */
  orders_7d: Contagem,
  created_at: z.string(),
});
export type TrackingLink = z.infer<typeof TrackingLink>;

export const TrackingLinkListResponse = z.strictObject({ items: z.array(TrackingLink) });
export type TrackingLinkListResponse = z.infer<typeof TrackingLinkListResponse>;

export const TrackingLinkDetailResponse = TrackingLink.extend({
  /** QR do `tracking_url` em SVG (módulo escuro sobre fundo branco, margem de 4 módulos); o PNG sai dele no navegador. */
  qr_svg: z.string(),
});
export type TrackingLinkDetailResponse = z.infer<typeof TrackingLinkDetailResponse>;

export const CreatedTrackingLinkResponse = TrackingLinkDetailResponse.extend({
  /** Falso quando o mesmo link (loja, campanha, anúncio e destino) já existia: ele volta como estava, com o mesmo código. */
  created: z.boolean(),
});
export type CreatedTrackingLinkResponse = z.infer<typeof CreatedTrackingLinkResponse>;

export const LinkDestination = z.strictObject({
  /** A loja no Regem (conta conectada). */
  connected_account_id: z.uuid(),
  /** Loja do Liame ligada a ela; nula enquanto não for ligada em Contas conectadas. */
  unit: z.strictObject({ id: z.uuid(), name: z.string() }).nullable(),
  store_name: z.string(),
  /** Cardápio online informado pelo Regem; nulo sem cardápio ou com endereço que não serve (só https). */
  menu_url: z.string().nullable(),
  usable: z.boolean(),
  /** Por que não dá para criar link: `sem_loja` ou `sem_cardapio`. */
  reason: Slug.nullable(),
});
export type LinkDestination = z.infer<typeof LinkDestination>;

export const LinkCampaignOption = z.strictObject({
  id: z.uuid(),
  name: z.string(),
  /** `meta_ads` ou `google_ads`. */
  provider: Slug,
  status: Slug,
  /** `site`, `mensagens` (o anúncio abre o WhatsApp: sem link do cardápio), `outro` (fica na plataforma) ou `desconhecido`. */
  destination_kind: Slug,
  ads: z.array(z.strictObject({ id: z.uuid(), name: z.string(), status: Slug })),
});
export type LinkCampaignOption = z.infer<typeof LinkCampaignOption>;

export const LinkSource = z.strictObject({
  connected_account_id: z.uuid(),
  provider: Slug,
  name: z.string(),
  /** Última leitura das campanhas e anúncios da conta. */
  read_at: z.string().nullable(),
  /** `fresh`, `delayed`, `stale` ou `unknown`. */
  freshness: Slug,
});
export type LinkSource = z.infer<typeof LinkSource>;

export const LinkOptionsResponse = z.strictObject({
  destinations: z.array(LinkDestination),
  /** Campanhas ativas e pausadas da Meta e do Google Ads da marca, com os anúncios. */
  campaigns: z.array(LinkCampaignOption),
  sources: z.array(LinkSource),
});
export type LinkOptionsResponse = z.infer<typeof LinkOptionsResponse>;

export const TrackingCheckItem = z.strictObject({
  /** `sem_rastreio` ou `nao_verificavel`. */
  status: Slug,
  /**
   * `sem_rastreio`: `sem_parametros`, `parametros_de_outra_plataforma`, `link_desconhecido`,
   * `link_de_outra_campanha`, `ids_de_outro_anuncio` ou `destino_fora_do_cardapio`; `nao_verificavel`:
   * `leitura_pendente` ou `sem_link`.
   */
  reason: Slug,
  title: z.string(),
  detail: z.string(),
  /** O que fazer, em uma frase. */
  action: z.string(),
  provider: Slug,
  connected_account_id: z.uuid(),
  campaign: z.strictObject({ id: z.uuid(), name: z.string() }),
  ad: z.strictObject({ id: z.uuid(), name: z.string(), external_id: z.string() }),
  /** Para onde o anúncio leva, quando é o motivo (fora do cardápio). */
  destination_url: z.string().nullable(),
  /** Desde quando o Liame vê o anúncio. */
  first_seen_at: z.string(),
  /** Link desta campanha para colar no anúncio (o do anúncio, senão o da campanha); nulo sem link. */
  suggested_link_id: z.uuid().nullable(),
});
export type TrackingCheckItem = z.infer<typeof TrackingCheckItem>;

export const TrackingCheckResponse = z.strictObject({
  summary: z.strictObject({
    /** Anúncios ativos na última leitura (campanha, grupo e anúncio ativos). */
    active_ads: Contagem,
    with_tracking: Contagem,
    without_tracking: Contagem,
    not_verifiable: Contagem,
    /** Anúncios que não levam a site (abrem o WhatsApp, formulário…): fora da conferência. */
    not_applicable: Contagem,
  }),
  /** Sem rastreio primeiro, depois os não verificados; por campanha e anúncio. */
  items: z.array(TrackingCheckItem),
  sources: z.array(LinkSource),
  generated_at: z.string(),
});
export type TrackingCheckResponse = z.infer<typeof TrackingCheckResponse>;
