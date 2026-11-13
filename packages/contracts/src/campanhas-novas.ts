import { z } from 'zod';

// A campanha nova na Meta, criada pausada (A4, X5, parte 1; P10 aprovado em 05/10/2026; D-A4-31, D-A4-35, D-A4-40 e
// D-A4-41): a peça de texto aprovada em Criativos, com a foto ou o vídeo da loja (Fotos), vira um pedido de criar a
// campanha, o conjunto e o anúncio na Meta, tudo pausado. O pedido espera a aprovação com o código do app em Aprovações;
// ativar é outro pedido (a parte 3).

export const NEW_CAMPAIGN_OBJECTIVES = ['cardapio', 'whatsapp', 'alcance', 'seguidores'] as const;
/**
 * O que a pessoa quer do anúncio: pedidos pelo cardápio da loja, conversas no WhatsApp da Página e, da R6 do plano da
 * região (D-RG-48), ser conhecido no raio (`alcance`: o botão leva ao cardápio, no máximo 2 vezes por pessoa a cada 7
 * dias) e seguidores no Instagram (`seguidores`: o destino é o perfil do Instagram ligado à Página). Alcance e
 * seguidores dividem até 25% do teto do mês (D-RG-49).
 */
export const NewCampaignObjective = z.enum(NEW_CAMPAIGN_OBJECTIVES);
export type NewCampaignObjective = z.infer<typeof NewCampaignObjective>;

export const NEW_CAMPAIGN_STATUSES = ['pedida', 'criando', 'criada', 'nao_criada', 'cancelada'] as const;
/**
 * `pedida` (espera a aprovação, ou aprovada e esperando a vez), `criando` (o Liame cria na Meta, passo a passo), `criada`
 * (a campanha, o conjunto e o anúncio existem na Meta, pausados), `nao_criada` (a Meta recusou, ou a mídia saiu: o
 * porquê em `error`; o que já existia ficou pausado) ou `cancelada` (o pedido foi recusado ou expirou).
 */
export const NewCampaignStatus = z.enum(NEW_CAMPAIGN_STATUSES);
export type NewCampaignStatus = z.infer<typeof NewCampaignStatus>;

/** O id de uma publicação no Instagram (só algarismos). */
const InstagramMediaId = z.string().regex(/^[0-9]{1,40}$/, 'o id da publicação no Instagram tem só algarismos');

/**
 * A campanha nova sai de uma de duas origens, nunca das duas: a peça aprovada em Criativos com uma foto ou um vídeo de
 * Fotos (`piece_id` e `media_id`), ou um Reels já publicado no Instagram da Página (`instagram_media_id`; A4, X5, parte
 * 6; D-A4-46), que vai como está no post: o vídeo e a legenda; o Liame põe o botão e o rastreio.
 */
export const CreateNewCampaignRequest = z
  .strictObject({
    brand_id: z.uuid(),
    /** Uma peça aprovada em Criativos; vai a versão atual dela. Junto com `media_id`. */
    piece_id: z.uuid().optional(),
    /** Uma foto ou um vídeo pronto de Fotos, da marca. Junto com `piece_id`. */
    media_id: z.uuid().optional(),
    /** Um Reels de Fotos › Do seu Instagram, do Instagram ligado à Página da marca. Sem `piece_id` e `media_id`. */
    instagram_media_id: InstagramMediaId.optional(),
    /** A loja do raio: o ponto dela precisa estar no endereço (D-A4-41; D-RG-14). */
    unit_id: z.uuid(),
    /** O nome da campanha na Meta e em Resultados. */
    name: z.string().trim().min(1).max(80),
    objective: NewCampaignObjective,
    /** O raio em volta da loja, de 1 a 15 km, em passos de 0,5 km. */
    radius_km: z
      .number()
      .min(1)
      .max(15)
      .refine((v) => Number.isInteger(v * 2), 'o raio vai em passos de 0,5 km'),
    /** A verba diária, em micros da moeda da conta de anúncios (R$ 30,00 = 30000000), sem fração de centavo. */
    daily_budget_micros: z.int().min(10_000).max(100_000_000_000),
    /** O último dia, no fuso da empresa; ausente, a campanha não tem data de fim. */
    end_date: z.iso.date().optional(),
  })
  .refine(
    (b) =>
      b.instagram_media_id === undefined ? b.piece_id !== undefined && b.media_id !== undefined : b.piece_id === undefined && b.media_id === undefined,
    { error: 'Mande a peça com a foto ou o vídeo de Fotos, ou o Reels do Instagram: um dos dois.' },
  );
export type CreateNewCampaignRequest = z.infer<typeof CreateNewCampaignRequest>;

export const NewCampaignResponse = z.strictObject({
  id: z.uuid(),
  brand_id: z.uuid(),
  /** A peça e a versão dela; nulas na campanha a partir de um Reels. */
  piece_id: z.uuid().nullable(),
  piece_version: z.int().min(1).nullable(),
  /** A foto ou o vídeo de Fotos; nulo na campanha a partir de um Reels. */
  media_id: z.uuid().nullable(),
  /** O Reels de onde a campanha saiu (D-A4-46); nulo na campanha com a peça. */
  instagram_media_id: z.string().nullable(),
  /**
   * O Reels como o Liame leu do Instagram (a legenda, o link, a miniatura e o dia); nulo na campanha com a peça, ou
   * quando o post saiu da leitura do Instagram da marca.
   */
  reels: z
    .strictObject({ caption: z.string(), permalink: z.string().nullable(), thumbnail_url: z.string().nullable(), published_at: z.iso.datetime() })
    .nullable(),
  unit_id: z.uuid(),
  name: z.string(),
  objective: NewCampaignObjective,
  radius_km: z.number(),
  daily_budget_micros: z.int(),
  end_date: z.iso.date().nullable(),
  /** O cardápio da loja (o destino de "pedidos pelo cardápio" e de "ser conhecido no raio"); nulo no WhatsApp e em seguidores. */
  link: z.string().nullable(),
  /** A estimativa de público da Meta no raio quando a pessoa pediu (R6, D-RG-50): o mínimo e o máximo; nula sem estimativa. */
  audience: z.strictObject({ lower: z.int(), upper: z.int() }).nullable(),
  status: NewCampaignStatus,
  /** O pedido em Aprovações. */
  action_id: z.uuid().nullable(),
  /** O porquê de `nao_criada`, em palavras. */
  error: z.string().nullable(),
  /** Ativada pelo Liame (A4, X5, parte 3): rodando na Meta, depois da revisão dela. A volta é pausar. */
  active: z.boolean(),
  activated_at: z.iso.datetime({ offset: true }).nullable(),
  /** O pedido de ativar (ou a volta, pausar) que ainda espera a decisão ou a execução, se houver. */
  pending_action_id: z.uuid().nullable(),
  /** O que já existe na Meta (os ids), na ordem em que o Liame cria; e a conta de anúncios (para o link do Gerenciador). */
  meta: z.strictObject({
    account_id: z.string().nullable(),
    campaign_id: z.string().nullable(),
    adset_id: z.string().nullable(),
    video_id: z.string().nullable(),
    creative_id: z.string().nullable(),
    ad_id: z.string().nullable(),
  }),
  created_at: z.iso.datetime({ offset: true }),
});
export type NewCampaignResponse = z.infer<typeof NewCampaignResponse>;

// ---------------------------------------------------------------- as opções da gaveta (A4, X5, parte 2; P42)

export const NewCampaignOptionsQuery = z.strictObject({ brand_id: z.uuid() });
export type NewCampaignOptionsQuery = z.infer<typeof NewCampaignOptionsQuery>;

/** O que impede pedir a campanha nova agora: o mesmo `code` e as mesmas palavras da recusa de `POST /v1/new-campaigns`. */
export const NewCampaignBlock = z.strictObject({ code: z.string(), title: z.string(), detail: z.string() });
export type NewCampaignBlock = z.infer<typeof NewCampaignBlock>;

export const NewCampaignUnitOption = z.strictObject({
  id: z.uuid(),
  name: z.string(),
  /** O endereço da loja numa linha (rua, número e bairro), quando há. */
  address: z.string().nullable(),
  /** O ponto da loja está no endereço: a campanha só nasce assim (D-A4-41; D-RG-14). */
  has_address: z.boolean(),
  /** O raio de entrega da loja, em km, quando a loja informou (a gaveta oferece como uma das opções do raio). */
  delivery_radius_km: z.number().nullable(),
  /** "Pedidos pelo cardápio" vale para esta loja; quando não, `menu_block` diz o porquê, com as palavras da recusa. */
  menu_available: z.boolean(),
  menu_block: z.string().nullable(),
});
export type NewCampaignUnitOption = z.infer<typeof NewCampaignUnitOption>;

export const NewCampaignOptionsResponse = z.strictObject({
  /** A função `campanha_nova` ligada para esta marca. Desligada, a tela não mostra o botão. */
  enabled: z.boolean(),
  /** O que impede pedir agora (a função, a conta de anúncios, a Página), na ordem em que a rota confere. Vazio: dá. */
  blocks: z.array(NewCampaignBlock),
  /** A conta de anúncios da Meta da marca (uma só), a Página que assina o anúncio e o Instagram ligado a ela. */
  ad_account: z.strictObject({ name: z.string(), currency: z.string().nullable() }).nullable(),
  page: z.strictObject({ name: z.string() }).nullable(),
  instagram: z.strictObject({ name: z.string() }).nullable(),
  units: z.array(NewCampaignUnitOption),
  /** O teto por campanha da Meta (a verba diária), quando a empresa definiu; a verba acima dele é recusada. */
  campaign_cap_micros: z.int().nullable(),
  /**
   * O teto de alcance e seguidores no mês (R6, D-RG-49): 25% do teto do mês da empresa (`cap_micros`), o que já está
   * reservado para campanhas assim, pedidas ou ativas, até o fim do mês (`used_micros`) e os dias que faltam, contando
   * hoje (`days_left`). Nulo quando a empresa ainda não definiu o teto do mês.
   */
  top_of_funnel: z.strictObject({ cap_micros: z.int(), used_micros: z.int(), days_left: z.int() }).nullable(),
  /** A campanha nova mais recente de cada peça da marca (a cancelada fica fora): a tela mostra em que pé ela está. */
  by_piece: z.array(
    z.strictObject({ piece_id: z.uuid(), campaign_id: z.uuid(), status: NewCampaignStatus, active: z.boolean(), action_id: z.uuid().nullable() }),
  ),
  /** O mesmo para cada Reels da marca que virou campanha nova (A4, X5, parte 6). */
  by_reels: z.array(
    z.strictObject({ instagram_media_id: z.string(), campaign_id: z.uuid(), status: NewCampaignStatus, active: z.boolean(), action_id: z.uuid().nullable() }),
  ),
});
export type NewCampaignOptionsResponse = z.infer<typeof NewCampaignOptionsResponse>;

// ---------------------------------------------------------------- a estimativa de público no raio (R6, parte 2; D-RG-50)

export const NewCampaignAudienceQuery = z.strictObject({
  brand_id: z.uuid(),
  /** A loja do raio (o ponto dela no endereço). */
  unit_id: z.uuid(),
  /** O raio em volta da loja, de 1 a 15 km, em passos de 0,5 km. */
  radius_km: z.coerce
    .number()
    .min(1)
    .max(15)
    .refine((v) => Number.isInteger(v * 2), 'o raio vai em passos de 0,5 km'),
});
export type NewCampaignAudienceQuery = z.infer<typeof NewCampaignAudienceQuery>;

/**
 * A estimativa da Meta para o raio (18 anos ou mais): `pronta` (com o mínimo e o máximo e se dá para a Meta entregar:
 * `enough`, o máximo a partir de `minimum` pessoas), `sem_estimativa` (a Meta não estimou: não quer dizer público vazio)
 * ou `indisponivel` (sem conta de anúncios, sem o ponto da loja, ou a Meta não respondeu agora).
 */
export const NewCampaignAudienceResponse = z.strictObject({
  status: z.enum(['pronta', 'sem_estimativa', 'indisponivel']),
  lower: z.int().nullable(),
  upper: z.int().nullable(),
  minimum: z.int(),
  enough: z.boolean().nullable(),
});
export type NewCampaignAudienceResponse = z.infer<typeof NewCampaignAudienceResponse>;
