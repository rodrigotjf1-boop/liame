import { z } from 'zod';

// A campanha nova na Meta, criada pausada (A4, X5, parte 1; P10 aprovado em 05/10/2026; D-A4-31, D-A4-35, D-A4-40 e
// D-A4-41): a peça de texto aprovada em Criativos, com a foto ou o vídeo da loja (Fotos), vira um pedido de criar a
// campanha, o conjunto e o anúncio na Meta, tudo pausado. O pedido espera a aprovação com o código do app em Aprovações;
// ativar é outro pedido (a parte 3).

export const NEW_CAMPAIGN_OBJECTIVES = ['cardapio', 'whatsapp'] as const;
/** O que a pessoa quer do anúncio: pedidos pelo cardápio da loja ou conversas no WhatsApp da Página. */
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

export const CreateNewCampaignRequest = z.strictObject({
  brand_id: z.uuid(),
  /** Uma peça aprovada em Criativos; vai a versão atual dela. */
  piece_id: z.uuid(),
  /** Uma foto ou um vídeo pronto de Fotos, da marca. */
  media_id: z.uuid(),
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
});
export type CreateNewCampaignRequest = z.infer<typeof CreateNewCampaignRequest>;

export const NewCampaignResponse = z.strictObject({
  id: z.uuid(),
  brand_id: z.uuid(),
  piece_id: z.uuid(),
  piece_version: z.int().min(1),
  media_id: z.uuid(),
  unit_id: z.uuid(),
  name: z.string(),
  objective: NewCampaignObjective,
  radius_km: z.number(),
  daily_budget_micros: z.int(),
  end_date: z.iso.date().nullable(),
  /** O cardápio da loja (o destino de "pedidos pelo cardápio"); nulo no WhatsApp. */
  link: z.string().nullable(),
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
  /** A campanha nova mais recente de cada peça da marca (a cancelada fica fora): a tela mostra em que pé ela está. */
  by_piece: z.array(
    z.strictObject({ piece_id: z.uuid(), campaign_id: z.uuid(), status: NewCampaignStatus, active: z.boolean(), action_id: z.uuid().nullable() }),
  ),
});
export type NewCampaignOptionsResponse = z.infer<typeof NewCampaignOptionsResponse>;
