import { z } from 'zod';

// Os posts da marca (A6, Z5; protótipo P19, aprovado pelo dono em 21/10/2026): a foto das Fotos, os canais (o Instagram
// e a Página do Facebook, ligados à marca em Contas conectadas), o texto de cada canal e a hora. O post vira um pedido em
// Aprovações, como os outros: só sai com a aprovação de uma pessoa, com o código do app (D-A6-3), na hora marcada, que o
// Liame segura (D-A6-8). A aprovação vale para o conjunto: mudar o texto, a foto ou os canais é um post novo (D-A6-7).

/** Os canais onde o Liame publica nesta fase. */
export const POST_CHANNELS = ['instagram', 'facebook'] as const;
export const PostChannel = z.enum(POST_CHANNELS);
export type PostChannel = z.infer<typeof PostChannel>;

/** O limite do texto de cada canal: a legenda do Instagram até 2.200 caracteres; a Página, o do Liame. */
export const POST_TEXT_LIMITS = { instagram: 2200, facebook: 10000 } as const;

export const CreatePostRequest = z.strictObject({
  brand_id: z.uuid(),
  /** Uma foto pronta das Fotos da marca (D-A6-6: só a foto de verdade, como ela é). */
  photo_id: z.uuid(),
  /** A hora marcada, com o fuso. Entre 8h e 22h no fuso da empresa, depois de agora e até 60 dias. */
  publish_at: z.iso.datetime({ offset: true }),
  /**
   * A posição do recorte do Instagram (D-A6-21), de 0 a 100 ao longo do lado comprido da foto (0 = o começo, 50 = o
   * centro). Só quando o Instagram está entre os canais e a foto é mais alta que 4:5 ou mais larga que 1,91:1; ausente,
   * o recorte é no centro.
   */
  crop_pos: z.int().min(0).max(100).optional(),
  /** Um ou dois canais, cada um com o texto dele (sem repetir o canal). */
  channels: z
    .array(z.strictObject({ channel: PostChannel, text: z.string().trim().min(1).max(10000) }))
    .min(1)
    .max(POST_CHANNELS.length),
});
export type CreatePostRequest = z.infer<typeof CreatePostRequest>;

export const PostChannelResponse = z.strictObject({
  /** `instagram` ou `facebook` (a lista pode crescer: o Threads e o Perfil no Google). */
  channel: z.string().regex(/^[a-z_]{2,30}$/),
  /** A conta ligada do canal e o nome dela; nulos quando ela foi desligada da marca depois. */
  account_id: z.uuid().nullable(),
  account_name: z.string().nullable(),
  text: z.string(),
  /**
   * `aguardando` (o pedido espera a aprovação ou a hora), `publicando`, `publicado`, `falhou`, `cancelado` ou `apagado`
   * (a lista pode crescer).
   */
  status: z.string().regex(/^[a-z_]{2,30}$/),
  /** O endereço do post publicado na rede. */
  permalink: z.string().nullable(),
  /** Por que não saiu neste canal, em palavras do Liame. */
  error: z.string().nullable(),
  published_at: z.iso.datetime().nullable(),
});
export type PostChannelResponse = z.infer<typeof PostChannelResponse>;

export const PostResponse = z.strictObject({
  id: z.uuid(),
  brand_id: z.uuid(),
  /** A foto das Fotos; nula quando ela foi apagada depois (o post não sai). */
  photo_id: z.uuid().nullable(),
  crop_pos: z.int().min(0).max(100).nullable(),
  publish_at: z.iso.datetime(),
  /** O pedido em Aprovações. */
  action_id: z.uuid().nullable(),
  /**
   * A situação do post: `esperando_aprovacao`, `agendado` (aprovado, espera a hora), `publicando`, `publicado`,
   * `em_parte` (saiu num canal e não no outro), `nao_saiu`, `cancelado`, `recusado` ou `expirado` (ninguém aprovou no
   * prazo). A lista pode crescer.
   */
  status: z.string().regex(/^[a-z_]{2,30}$/),
  created_at: z.iso.datetime(),
  channels: z.array(PostChannelResponse),
});
export type PostResponse = z.infer<typeof PostResponse>;

/** Os posts da marca num período (a Agenda): de `from` a `to`, os dois dias inclusive, até 62 dias. */
export const PostListQuery = z.strictObject({ brand_id: z.uuid(), from: z.iso.date(), to: z.iso.date() });
export type PostListQuery = z.infer<typeof PostListQuery>;

export const PostListResponse = z.strictObject({
  /** A função dos posts (`social_write`) ligada para a empresa; desligada, a lista vem vazia. */
  enabled: z.boolean(),
  items: z.array(PostResponse),
});
export type PostListResponse = z.infer<typeof PostListResponse>;
