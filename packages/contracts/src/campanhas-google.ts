import { z } from 'zod';
import { NewCampaignBlock, NewCampaignStatus, NewCampaignUnitOption } from './campanhas-novas.js';

// A campanha nova no Google, criada pausada (A5, Y9, parte 2; P45 pré-aprovado em 12/11/2026; D-A5-21 a D-A5-26): a
// peça aprovada em Criativos, com os textos nos tamanhos do Google e uma foto da loja recortada, vira um pedido de criar
// uma campanha Performance Max, pausada. O pedido espera a aprovação com o código do app em Aprovações; a criação no
// Google é uma requisição só (o Google cria tudo ou nada) e ativar é outro pedido. Os tamanhos do Google (de 3 a 15
// títulos de até 30 caracteres, de 1 a 5 títulos longos de até 90, de 2 a 5 descrições de até 90, o nome da loja com até
// 25) são conferidos pela rota, que recusa com as palavras da tela (422 `textos-do-google`, no campo de cada um).

export const CreateGoogleCampaignRequest = z.strictObject({
  brand_id: z.uuid(),
  /** Uma peça aprovada em Criativos; vai a versão atual dela. */
  piece_id: z.uuid(),
  /** Uma foto pronta de Fotos, da marca (o Liame recorta nas proporções do Google; a pequena é recusada). */
  media_id: z.uuid(),
  /** A loja do raio: o ponto dela precisa estar no endereço (D-A4-41; D-RG-14). */
  unit_id: z.uuid(),
  /** O nome da campanha no Google Ads e em Resultados. */
  name: z.string().trim().min(1).max(80),
  /** Os títulos (o Google pede de 3 a 15, de até 30 caracteres). */
  headlines: z.array(z.string().max(200)).min(1).max(20),
  /** Os títulos longos (de 1 a 5, de até 90 caracteres). */
  long_headlines: z.array(z.string().max(200)).min(1).max(10),
  /** As descrições (de 2 a 5, de até 90 caracteres). */
  descriptions: z.array(z.string().max(200)).min(1).max(10),
  /** O nome da loja que o Google mostra no anúncio (até 25 caracteres). */
  business_name: z.string().trim().min(1).max(60),
  /** O raio em volta da loja, de 1 a 15 km, em passos de 0,5 km. */
  radius_km: z
    .number()
    .min(1)
    .max(15)
    .refine((v) => Number.isInteger(v * 2), 'o raio vai em passos de 0,5 km'),
  /** A verba diária, em micros da moeda da conta (R$ 30,00 = 30000000), sem fração de centavo. */
  daily_budget_micros: z.int().min(10_000).max(100_000_000_000),
  /** O último dia, no fuso da empresa; ausente, a campanha não tem data de fim. */
  end_date: z.iso.date().optional(),
});
export type CreateGoogleCampaignRequest = z.infer<typeof CreateGoogleCampaignRequest>;

export const GoogleCampaignResponse = z.strictObject({
  id: z.uuid(),
  brand_id: z.uuid(),
  piece_id: z.uuid(),
  piece_version: z.int().min(1),
  media_id: z.uuid(),
  unit_id: z.uuid(),
  name: z.string(),
  headlines: z.array(z.string()),
  long_headlines: z.array(z.string()),
  descriptions: z.array(z.string()),
  business_name: z.string(),
  radius_km: z.number(),
  daily_budget_micros: z.int(),
  end_date: z.iso.date().nullable(),
  /** O cardápio da loja, o destino do anúncio (D-A5-26). */
  link: z.string(),
  status: NewCampaignStatus,
  /** O pedido em Aprovações. */
  action_id: z.uuid().nullable(),
  /** O porquê de `nao_criada`, em palavras. */
  error: z.string().nullable(),
  active: z.boolean(),
  activated_at: z.iso.datetime({ offset: true }).nullable(),
  /** O que existe no Google (os ids) e a conta do Google Ads (para o link). A criação é uma só: ou os três, ou nenhum. */
  google: z.strictObject({
    account_id: z.string().nullable(),
    budget_id: z.string().nullable(),
    campaign_id: z.string().nullable(),
    asset_group_id: z.string().nullable(),
  }),
  created_at: z.iso.datetime({ offset: true }),
});
export type GoogleCampaignResponse = z.infer<typeof GoogleCampaignResponse>;

export const GoogleCampaignOptionsQuery = z.strictObject({ brand_id: z.uuid() });
export type GoogleCampaignOptionsQuery = z.infer<typeof GoogleCampaignOptionsQuery>;

export const GoogleCampaignOptionsResponse = z.strictObject({
  /** A função `campanha_google` ligada para esta marca. Desligada, a tela não mostra o botão. */
  enabled: z.boolean(),
  /** O que impede pedir agora (a função, a conta do Google Ads, a logo), com as palavras da recusa do pedido. */
  blocks: z.array(NewCampaignBlock),
  /** A conta do Google Ads da marca (uma só). */
  ad_account: z.strictObject({ name: z.string(), currency: z.string().nullable() }).nullable(),
  /** O nome da marca, como sugestão do nome da loja no anúncio (até 25 caracteres: o mais longo vem cortado). */
  business_name: z.string(),
  /** A logo de Minha marca (quadrada; o Google pede pelo menos 128 × 128); nula sem logo. */
  logo: z.strictObject({ width: z.int(), height: z.int() }).nullable(),
  units: z.array(NewCampaignUnitOption),
  /** O teto por campanha do Google (a verba diária), quando a empresa definiu. */
  campaign_cap_micros: z.int().nullable(),
  /** A campanha nova do Google mais recente de cada peça da marca (a cancelada fica fora). */
  by_piece: z.array(
    z.strictObject({ piece_id: z.uuid(), campaign_id: z.uuid(), status: NewCampaignStatus, active: z.boolean(), action_id: z.uuid().nullable() }),
  ),
});
export type GoogleCampaignOptionsResponse = z.infer<typeof GoogleCampaignOptionsResponse>;

/**
 * O pedido dos textos do Google ao Criativo (A5, Y9, parte 4; D-A5-22; P45, "Pedir ao Criativo"): a peça aprovada da
 * marca. O Criativo escreve, a partir dela, da oferta do pedido da peça e de Minha marca, uma proposta inteira nos
 * tamanhos do Google; a pessoa usa no lugar dos textos da gaveta, ou deixa como está.
 */
export const GoogleCampaignTextsRequest = z.strictObject({
  brand_id: z.uuid(),
  /** Uma peça aprovada em Criativos; vai a versão atual dela. */
  piece_id: z.uuid(),
});
export type GoogleCampaignTextsRequest = z.infer<typeof GoogleCampaignTextsRequest>;

export const GOOGLE_TEXTS_NO_AI_REASONS = [
  'ia_desligada',
  'funcionario_desligado',
  'sem-rota',
  'teto',
  'limite-usuario',
  'travada',
  'parada',
  'indisponivel',
  'entrada-grande',
  'formato',
  'barrado',
  'recusa',
] as const;

/**
 * A proposta do Criativo, já conferida: cada texto no tamanho do Google, sem repetir, sem dado pessoal e pelo Compliance
 * (o preço só o da oferta, as regras do Liame e o que a marca não diz); o que não passa sai da proposta (`dropped`
 * conta), e a proposta só volta com o mínimo do Google. Sem a IA (desligada, sem rota, no teto, fora do ar, com a
 * proposta que não chega ao mínimo, ou o Criativo recusou o assunto da peça), `origin` é `sem_ia`, com o motivo, e a
 * pessoa fica com os textos da gaveta.
 */
export const GoogleCampaignTextsResponse = z.strictObject({
  origin: z.enum(['ia', 'sem_ia']),
  reason: z.enum(GOOGLE_TEXTS_NO_AI_REASONS).nullable(),
  texts: z
    .strictObject({
      headlines: z.array(z.string().min(1).max(30)).min(3).max(15),
      long_headlines: z.array(z.string().min(1).max(90)).min(1).max(5),
      descriptions: z.array(z.string().min(1).max(90)).min(2).max(5),
    })
    .nullable(),
  /** Quantos textos da proposta ficaram de fora (longos, repetidos, com dado pessoal ou barrados pelo Compliance). */
  dropped: z.int().min(0),
  /** No teto de custo: quando a IA volta. */
  retry_at: z.iso.datetime({ offset: true }).nullable(),
  /** A chamada em `ai_usage` (para o retorno da pessoa); nula sem a IA. */
  usage_id: z.uuid().nullable(),
});
export type GoogleCampaignTextsResponse = z.infer<typeof GoogleCampaignTextsResponse>;
