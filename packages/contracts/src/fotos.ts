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
  /** As medidas e o tamanho da cópia guardada. */
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
