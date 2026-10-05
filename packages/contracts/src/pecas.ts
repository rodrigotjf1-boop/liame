import { z } from 'zod';

// Peças do Criativo (A4, X6; `plano-a4.md` D-A4-28 a D-A4-34, propostas; protótipo P10, aguardando aprovação; sem tela
// ainda). Quem opera campanhas pede peças para uma oferta de Minha marca; o Criativo (um funcionário de IA) escreve o
// título, o texto principal e o botão; o código confere cada peça, item por item, antes de ela aparecer. O que barra
// impede aprovar; o tamanho acima do recomendado só avisa. Nada vai para a Meta por aqui. Listas que crescem vão como
// texto na resposta (V23); no pedido, a lista fechada.

const Slug = z.string().regex(/^[a-z0-9_]+$/).max(60);
const Pessoa = z.strictObject({ id: z.uuid(), name: z.string() });

/** Para onde o anúncio leva: o cardápio online da loja (com o rastreio do Liame) ou uma conversa no WhatsApp. */
export const AD_PIECE_DESTINATIONS = ['cardapio', 'whatsapp'] as const;
export const AdPieceDestination = z.enum(AD_PIECE_DESTINATIONS);
export type AdPieceDestination = z.infer<typeof AdPieceDestination>;

export const AD_PIECE_STATUSES = ['decidir', 'aprovada', 'recusada'] as const;
export const AdPieceStatus = z.enum(AD_PIECE_STATUSES);
export type AdPieceStatus = z.infer<typeof AdPieceStatus>;

/** Quantas peças um pedido pode trazer, e o tamanho da instrução. */
export const AD_PIECE_LIMITS = { variations_min: 1, variations_max: 4, instruction_max: 300 } as const;

/** Pedir peças novas para uma oferta de Minha marca. */
export const CreateAdPieceRequest = z.strictObject({
  brand_id: z.uuid(),
  /** A oferta, exatamente como está escrita em Minha marca (parte Ofertas). */
  offer: z.string().trim().min(1).max(160),
  destination: AdPieceDestination,
  /** Quantas peças, de 1 a 4. */
  variations: z.number().int().min(AD_PIECE_LIMITS.variations_min).max(AD_PIECE_LIMITS.variations_max),
  /** O que a peça precisa dizer ou evitar (opcional). O preço não muda por aqui: é o da oferta. */
  instruction: z.string().trim().min(1).max(AD_PIECE_LIMITS.instruction_max).optional(),
  /** Um anúncio da própria marca que já trouxe pedidos, para o Criativo partir dele (opcional). */
  reference_ad_id: z.uuid().optional(),
});
export type CreateAdPieceRequest = z.infer<typeof CreateAdPieceRequest>;

export const AdPieceRequestResponse = z.strictObject({
  id: z.uuid(),
  brand_id: z.uuid(),
  /** `texto` (título, texto principal e botão). */
  kind: Slug,
  offer: z.string(),
  /** A versão de Minha marca de onde a oferta veio. */
  dossier_version: z.number().int().min(1),
  /** `cardapio` ou `whatsapp`. */
  destination: Slug,
  variations: z.number().int().min(1),
  instruction: z.string().nullable(),
  /** O anúncio de referência, com o nome que ele tinha na hora do pedido. */
  reference: z.strictObject({ ad_id: z.uuid().nullable(), name: z.string() }).nullable(),
  /** A peça que este pedido refaz ("pedir outra"); nula no pedido de peças novas. */
  piece_id: z.uuid().nullable(),
  /** `pendente` (na fila), `gerando`, `concluido`, `recusado` (o Criativo não escreve sobre aquilo, ou nenhuma peça serviu) ou `falhou`. */
  status: Slug,
  /** O porquê, quando recusado ou falhou: `politica`, `bebida_alcoolica`, `categoria_proibida`, `sem_peca`, `formato`, `ia_fora_do_ar`… */
  reason: Slug.nullable(),
  /** Quantas peças saíram deste pedido. */
  pieces: z.number().int().min(0),
  requested_by: Pessoa.nullable(),
  created_at: z.string(),
  finished_at: z.string().nullable(),
});
export type AdPieceRequestResponse = z.infer<typeof AdPieceRequestResponse>;

export const AdPieceRequestListQuery = z.strictObject({ brand_id: z.uuid() });
export type AdPieceRequestListQuery = z.infer<typeof AdPieceRequestListQuery>;

export const AdPieceRequestListResponse = z.strictObject({ items: z.array(AdPieceRequestResponse) });
export type AdPieceRequestListResponse = z.infer<typeof AdPieceRequestListResponse>;

/** Um achado da conferência: o que foi achado, em que campo e o trecho (nunca um dado pessoal). */
export const AdPieceFinding = z.strictObject({
  /** `preco_fora`, `numero_fora`, `gratis_fora`, o nome da regra de texto, `link`, `bebida_alcoolica`, `concorrente`, `regra_da_marca` ou `acima_do_recomendado`. */
  kind: Slug,
  /** `titulo` ou `texto`. */
  field: Slug,
  excerpt: z.string(),
});
export type AdPieceFinding = z.infer<typeof AdPieceFinding>;

export const AdPieceReviewItem = z.strictObject({
  /** `oferta`, `regras_da_liame`, `regras_da_marca` ou `tamanho`. */
  item: Slug,
  /** `passou`, `aviso` ou `barrou`. */
  status: Slug,
  findings: z.array(AdPieceFinding),
});
export type AdPieceReviewItem = z.infer<typeof AdPieceReviewItem>;

/** A conferência de uma versão, item por item. Com um item barrado, a peça não pode ser aprovada. */
export const AdPieceReview = z.strictObject({
  /** A pior situação entre os itens: `passou`, `aviso` ou `barrou`. */
  status: Slug,
  items: z.array(AdPieceReviewItem),
  /** A peça cita algum valor (preço ou percentual)? */
  cites_value: z.boolean(),
  characters: z.strictObject({ title: z.number().int().min(0), body: z.number().int().min(0) }),
  /** O tamanho que a Meta recomenda para cada campo: passar disso só avisa. */
  recommended: z.strictObject({ title: z.number().int().min(1), body: z.number().int().min(1) }),
});
export type AdPieceReview = z.infer<typeof AdPieceReview>;

export const AdPieceVersion = z.strictObject({
  version: z.number().int().min(1),
  title: z.string(),
  body: z.string(),
  /** `pedir_agora`, `ver_cardapio` ou `enviar_mensagem`. */
  button: Slug,
  review: AdPieceReview,
  /** sha256 do título, do texto e do botão: a decisão vale para este hash. */
  content_hash: z.string().regex(/^[0-9a-f]{64}$/),
  /** `criativo` (a IA escreveu) ou `pessoa` (alguém editou). */
  author: Slug,
  created_by: Pessoa.nullable(),
  created_at: z.string(),
});
export type AdPieceVersion = z.infer<typeof AdPieceVersion>;

export const AdPieceResponse = z.strictObject({
  id: z.uuid(),
  brand_id: z.uuid(),
  request_id: z.uuid(),
  /** `decidir` (espera a pessoa), `aprovada` (na biblioteca) ou `recusada`. */
  status: Slug,
  /** A oferta e o destino do pedido de onde a peça nasceu. */
  offer: z.string(),
  destination: Slug,
  /** A peça nasceu do Criativo (um funcionário de IA): a tela mostra "feito com IA". */
  ai_generated: z.boolean(),
  /** A versão atual. */
  current: AdPieceVersion,
  /** Todas as versões, da mais nova para a mais antiga; só no detalhe. */
  versions: z.array(AdPieceVersion).optional(),
  decided_by: Pessoa.nullable(),
  decided_at: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});
export type AdPieceResponse = z.infer<typeof AdPieceResponse>;

export const AdPieceListQuery = z.strictObject({ brand_id: z.uuid(), status: AdPieceStatus.optional() });
export type AdPieceListQuery = z.infer<typeof AdPieceListQuery>;

export const AdPieceListResponse = z.strictObject({ items: z.array(AdPieceResponse) });
export type AdPieceListResponse = z.infer<typeof AdPieceListResponse>;

/** O que impede uma oferta de ir ao Criativo (`politico_eleitoral`, `categoria_proibida`, `bebida_alcoolica`, `dado_pessoal`…), com o trecho. */
export const AdPieceOfferProblem = z.strictObject({ reason: Slug, excerpt: z.string() });
export type AdPieceOfferProblem = z.infer<typeof AdPieceOfferProblem>;

/** O que a tela de pedir uma peça precisa: se dá para pedir agora, as ofertas de Minha marca e os anúncios que já trouxeram pedidos. */
export const AdPieceOptionsResponse = z.strictObject({
  brand_id: z.uuid(),
  /** Dá para pedir agora? */
  available: z.boolean(),
  /** O porquê, quando não dá: `criativo_desligado` (a IA ou o Criativo não estão ligados), `sem_dossie`, `sem_oferta` ou `lote_em_andamento`. */
  reason: Slug.nullable(),
  /** A versão atual de Minha marca; nula quando a marca ainda não tem dossiê. */
  dossier_version: z.number().int().min(1).nullable(),
  /** As ofertas de Minha marca, na ordem de lá. Com `problems` vazio, a oferta pode ir ao Criativo. */
  offers: z.array(
    z.strictObject({
      text: z.string(),
      /** A oferta escreve um preço (ou percentual) como preço? Sem isso, a peça sai sem preço. */
      has_value: z.boolean(),
      problems: z.array(AdPieceOfferProblem),
    }),
  ),
  /** Os anúncios da marca com pedidos confirmados nos últimos 7 dias completos, do que mais vendeu para o que menos (até 10). */
  reference_ads: z.array(z.strictObject({ ad_id: z.uuid(), name: z.string(), campaign: z.string().nullable(), orders: z.number().int().min(1) })),
  /** O período dos pedidos dos anúncios de referência. */
  reference_period: z.strictObject({ from: z.iso.date(), to: z.iso.date() }),
  limits: z.strictObject({ variations_min: z.number().int(), variations_max: z.number().int(), instruction_max: z.number().int() }),
  /** O pedido de peças novas que está na fila ou sendo feito, quando há. */
  in_progress: AdPieceRequestResponse.nullable(),
});
export type AdPieceOptionsResponse = z.infer<typeof AdPieceOptionsResponse>;

export const AdPieceOptionsQuery = z.strictObject({ brand_id: z.uuid() });
export type AdPieceOptionsQuery = z.infer<typeof AdPieceOptionsQuery>;
