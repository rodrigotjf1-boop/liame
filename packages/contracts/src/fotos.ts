import { z } from 'zod';

// Fotos dos produtos (A6, Z4; ADR-021; protótipo P20, aprovado em 21/10/2026). As fotos de verdade que a empresa envia
// para os posts. O Liame guarda uma cópia em JPEG, com o lado maior em até 2.048 px e sem os dados do celular (como a
// localização), e uma miniatura para a grade. O nome do arquivo não é guardado. A foto se vê por um endereço assinado,
// que vale poucos minutos (`urls_expire_at`). Listas que crescem vão como texto na resposta (V23).

const Slug = z.string().regex(/^[a-z0-9_]+$/).max(60);

/** Os limites da foto (ADR-021, item 3; aprovados pelo dono em 21/10/2026). A tela e o servidor usam os mesmos. */
export const BRAND_PHOTO_LIMITS = {
  /** O arquivo enviado: até 10 MB. */
  maxBytes: 10 * 1024 * 1024,
  /** O lado menor do arquivo enviado: 600 px ou mais. */
  minShortSide: 600,
  /** O lado maior do arquivo enviado: até 10.000 px. */
  maxLongSide: 10_000,
  /** O lado maior da cópia guardada. */
  storedLongSide: 2048,
  /** A largura com que o Instagram mostra a foto: abaixo dela, o aviso de nitidez. */
  instagramWidth: 1080,
  /** Quantas fotos a tela envia de uma vez (cada uma num pedido). */
  perBatch: 20,
  /** O que aparece na foto: até 120 letras. */
  descriptionMax: 120,
} as const;

/**
 * Os limites do vídeo das Fotos (A6 · Z10; D-A6-68, aprovada pelo dono em 04/11/2026): MP4 ou MOV, de 3 a 90 segundos
 * (os 90 s são o máximo do Reels da Página: um arquivo só serve para os dois Reels, o TikTok e o YouTube Shorts), até
 * 300 MB. O 4K do celular entra (até 4.096 px no lado maior): a redução para os 1.920 px do Reels é feita quando o
 * vídeo vai à Meta (parte 3). O vídeo vai como a loja gravou: em H.264 ou HEVC, com o áudio em AAC.
 */
export const BRAND_VIDEO_LIMITS = {
  maxBytes: 300 * 1024 * 1024,
  minDurationMs: 3_000,
  maxDurationMs: 90_000,
  /** O lado maior que entra em Fotos (o 4K do celular). */
  maxLongSide: 4096,
  /** O lado maior do Reels: o vídeo maior que isso vai reduzido, na mesma proporção (D-A6-68). */
  reelsLongSide: 1920,
  /** Quanto vale o endereço de envio direto (o bucket recusa assinatura com mais de 10 minutos). */
  uploadSeconds: 600,
} as const;

/**
 * O vídeo no post (A6, Z10; as especificações da Meta, conferidas em 06/11/2026): o Reels do Instagram aceita o arquivo
 * com até 1.920 px de largura e até 25 Mbps (o maior, o servidor ainda não reduz: vai só na Página); o Reels da Página, em
 * pé a partir de 540 × 960 (deitado, ou menor, sai como vídeo comum). As mesmas contas no servidor e na tela (V74).
 */
export const REELS_LIMITS = { instagramMaxWidth: 1920, instagramMaxBitrate: 25_000_000, pageMinWidth: 540, pageMinHeight: 960 } as const;

/** A taxa média do arquivo, em bits por segundo (o som junto); sem a duração, infinita. */
export function reelsBitrate(bytes: number, durationMs: number): number {
  if (!(durationMs > 0)) return Number.POSITIVE_INFINITY;
  return (bytes * 8) / (durationMs / 1000);
}

/** O vídeo vai ao Reels do Instagram como está (a largura gravada e a taxa no limite)? */
export function fitsInstagramReels(width: number, bytes: number, durationMs: number): boolean {
  return width > 0 && width <= REELS_LIMITS.instagramMaxWidth && reelsBitrate(bytes, durationMs) <= REELS_LIMITS.instagramMaxBitrate;
}

/** Como o vídeo sai na Página: `reels` (em pé, a partir de 540 × 960) ou `video` (o vídeo comum: deitado ou menor). */
export function pageVideoFormat(width: number, height: number): 'reels' | 'video' {
  if (width > height) return 'video';
  return width >= REELS_LIMITS.pageMinWidth && height >= REELS_LIMITS.pageMinHeight ? 'reels' : 'video';
}

/** Os formatos do vídeo: o tipo que o navegador manda no envio (e que vai na assinatura). */
export const BrandVideoMediaType = z.enum(['video/mp4', 'video/quicktime']);

/** Pedir o envio de um vídeo (com a função `videos` ligada): o servidor guarda o pedido e devolve o endereço de envio. */
export const CreateBrandVideoRequest = z.strictObject({
  brand_id: z.uuid(),
  media_type: BrandVideoMediaType,
  /**
   * O tamanho exato do arquivo, em bytes (até 300 MB): entra na assinatura do endereço de envio, e o armazenamento
   * recusa o arquivo de outro tamanho. Conferido de novo quando o envio termina.
   */
  bytes: z.int().min(1).max(BRAND_VIDEO_LIMITS.maxBytes),
});
export type CreateBrandVideoRequest = z.infer<typeof CreateBrandVideoRequest>;

/**
 * O endereço de envio direto: o navegador manda o arquivo (com exatamente os `bytes` do pedido) com `PUT` e o cabeçalho
 * `content-type` como está aqui, até `expires_at`; depois, pede a conferência (`POST /v1/brand-photos/{id}/video`).
 */
export const BrandVideoUploadResponse = z.strictObject({
  id: z.uuid(),
  upload: z.strictObject({
    url: z.string().min(1),
    method: z.string().regex(/^[A-Z]{3,6}$/),
    headers: z.strictObject({ 'content-type': z.string().min(1) }),
    expires_at: z.iso.datetime(),
  }),
});
export type BrandVideoUploadResponse = z.infer<typeof BrandVideoUploadResponse>;

export const BrandPhotosQuery = z.strictObject({ brand_id: z.uuid() });
export type BrandPhotosQuery = z.infer<typeof BrandPhotosQuery>;

export const BrandPhotoUploadQuery = z.strictObject({ brand_id: z.uuid() });
export type BrandPhotoUploadQuery = z.infer<typeof BrandPhotoUploadQuery>;

export const BrandPhoto = z.strictObject({
  id: z.uuid(),
  brand_id: z.uuid(),
  /** O produto de Minha marca que aparece na foto, como estava escrito lá; nulo = "Sem produto". */
  product: z.string().nullable(),
  /** O que aparece na foto, escrito por uma pessoa da empresa; vazio quando ninguém escreveu. */
  description: z.string(),
  /**
   * As medidas com que a mídia vai aos posts: a da cópia guardada da foto; no vídeo, a do Reels (o vídeo maior que
   * 1.920 px no lado maior vai reduzido, na mesma proporção; as medidas gravadas ficam em `video`). E o tamanho do
   * arquivo guardado (no vídeo, o arquivo como a loja gravou).
   */
  width: z.int().min(1).max(BRAND_PHOTO_LIMITS.storedLongSide),
  height: z.int().min(1).max(BRAND_PHOTO_LIMITS.storedLongSide),
  bytes: z.int().min(1),
  /** `quadrada`, `horizontal` ou `vertical`. */
  orientation: Slug,
  /** A largura da cópia fica abaixo da que o Instagram usa (1.080 px): lá, a foto pode sair sem nitidez. */
  narrow_for_instagram: z.boolean(),
  /**
   * O recorte que o Instagram vai pedir: `nenhum`; `alta` (mais alta que 4:5); `larga` (mais larga que 1,91:1). Como o
   * recorte é feito fica para o post (Z5).
   */
  instagram_crop: Slug,
  uploaded_at: z.iso.datetime(),
  /** Quem enviou; nulo quando a pessoa já não está na empresa. */
  uploaded_by: z.strictObject({ id: z.uuid(), name: z.string() }).nullable(),
  /** O endereço da foto e o da miniatura (para a grade), assinados: valem até `urls_expire_at`. */
  url: z.string().min(1),
  thumbnail_url: z.string().min(1),
  urls_expire_at: z.iso.datetime(),
  /**
   * O que é (A6 · Z10): `foto_produto` ou `video` (a lista pode crescer). No vídeo, `url` é o do arquivo, e
   * `thumbnail_url` o da capa (um quadro do vídeo; o do próprio arquivo enquanto a capa não chega). Opcional: a resposta
   * de antes de 05/11/2026 não traz.
   */
  kind: Slug.optional(),
  /**
   * O vídeo: as medidas como a loja gravou (até o 4K, na orientação em que ele aparece), a duração, o formato, se tem
   * som e se a capa já chegou; nulo na foto. Opcional, como o de cima.
   */
  video: z
    .strictObject({
      width: z.int().min(1).max(BRAND_VIDEO_LIMITS.maxLongSide),
      height: z.int().min(1).max(BRAND_VIDEO_LIMITS.maxLongSide),
      duration_ms: z.int().min(1),
      media_type: z.string().min(1),
      has_audio: z.boolean(),
      has_cover: z.boolean(),
    })
    .nullable()
    .optional(),
});
export type BrandPhoto = z.infer<typeof BrandPhoto>;

export const BrandPhotosResponse = z.strictObject({
  brand_id: z.uuid(),
  /** A função `fotos` está ligada para a empresa. Desligada, a lista vem vazia. */
  enabled: z.boolean(),
  /** Quem pede pode enviar, mudar o produto e apagar (`fotos.enviar`). */
  can_manage: z.boolean(),
  /** Os produtos de Minha marca, na ordem de lá: as opções do campo "Produto". */
  products: z.array(z.string()),
  /** A função `videos` está ligada para a empresa: a tela aceita vídeo (A6 · Z10). Opcional: a resposta de antes não traz. */
  videos_enabled: z.boolean().optional(),
  /** As fotos da marca, a mais nova primeiro (até 500). */
  items: z.array(BrandPhoto),
});
export type BrandPhotosResponse = z.infer<typeof BrandPhotosResponse>;

export const UpdateBrandPhotoRequest = z
  .strictObject({
    /** Um dos produtos de Minha marca, como está escrito lá; nulo tira o produto da foto. */
    product: z.string().trim().min(1).max(160).nullable().optional(),
    description: z.string().trim().max(BRAND_PHOTO_LIMITS.descriptionMax).optional(),
  })
  .refine((b) => b.product !== undefined || b.description !== undefined, { error: 'Mande o produto, o que aparece na foto, ou os dois.' });
export type UpdateBrandPhotoRequest = z.infer<typeof UpdateBrandPhotoRequest>;
