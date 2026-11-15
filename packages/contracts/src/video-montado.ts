import { z } from 'zod';

// O vídeo montado pelo Liame (A6 · Z15, parte 2a; P43 aprovado em 11/11/2026; D-A6-133 a D-A6-138): a pessoa escolhe o
// modelo, as fotos ou o vídeo de Fotos, o formato, os textos (conferidos pelo Compliance), a logo, a duração e o som; o
// pedido entra na fila e o serviço de montagem (`liame-render`) monta um por vez. O vídeo pronto entra em Fotos.

export const VIDEO_TEMPLATES = ['destaque', 'combo', 'novidade', 'momentos'] as const;
/**
 * `destaque` (uma foto, o nome e o preço), `combo` (de 2 a 4 fotos e o preço no fim), `novidade` (uma foto ou um vídeo, a
 * faixa "Novidade" e a chamada), `momentos` ("Os melhores momentos", A6 · Z16: de 1 a 4 vídeos, os cortes escolhidos pelo
 * Social media em sequência, com a legenda de cada um; só com a função `video_momentos`).
 */
export const VideoTemplate = z.enum(VIDEO_TEMPLATES);
export type VideoTemplate = z.infer<typeof VideoTemplate>;

export const VIDEO_FORMATS = ['9x16', '4x5', '1x1'] as const;
/** `9x16` (Reels e Story, 1080 × 1920), `4x5` (Feed, 1080 × 1350), `1x1` (Quadrado, 1080 × 1080). */
export const VideoFormat = z.enum(VIDEO_FORMATS);
export type VideoFormat = z.infer<typeof VideoFormat>;

export const VIDEO_MONTAGE_LIMITS = {
  title: 40,
  priceLine: 24,
  cta: 30,
  /** Vídeos por marca por dia (o que não deu não conta; o limite volta à meia-noite, no fuso da empresa). */
  perDay: 10,
} as const;

/**
 * Quantas fotos ou vídeos cada modelo leva, se aceita vídeo (`video`), se leva só vídeo (`onlyVideo`), a linha do preço,
 * as durações e se leva o título e a chamada (os "Melhores momentos" levam a legenda de cada corte no lugar deles).
 */
export const VIDEO_TEMPLATE_RULES: Record<
  VideoTemplate,
  { min: number; max: number; video: boolean; onlyVideo: boolean; price: boolean; durations: readonly number[]; texts: boolean }
> = {
  destaque: { min: 1, max: 1, video: false, onlyVideo: false, price: true, durations: [6, 10, 15], texts: true },
  combo: { min: 2, max: 4, video: false, onlyVideo: false, price: true, durations: [6, 10, 15], texts: true },
  novidade: { min: 1, max: 1, video: true, onlyVideo: false, price: false, durations: [6, 10, 15], texts: true },
  momentos: { min: 1, max: 4, video: true, onlyVideo: true, price: false, durations: [10, 15, 20], texts: false },
};

/** O título com que "Os melhores momentos" ficam na lista (o modelo não leva título; A6 · Z16). */
export const VIDEO_MOMENTS_TITLE = 'Os melhores momentos';

/**
 * Um corte dos "Melhores momentos" (A6 · Z16; D-A6-150 e D-A6-152): o vídeo de Fotos (um dos `media_ids`), o começo e o
 * fim em milissegundos e a legenda (até 40 letras). A ordem da lista é a ordem do vídeo; o servidor confere cada corte
 * dentro do vídeo, de 1,5 a 8 segundos, sem repetir pedaço, o total perto da duração e as legendas pelo Compliance.
 */
export const VideoCut = z.strictObject({
  media_id: z.uuid(),
  start_ms: z.int().min(0),
  end_ms: z.int().min(1),
  caption: z.string().trim().min(1).max(40),
});
export type VideoCut = z.infer<typeof VideoCut>;

export const CreateVideoMontageRequest = z.strictObject({
  brand_id: z.uuid(),
  template: VideoTemplate,
  format: VideoFormat,
  /** 6, 10 ou 15 segundos; nos "Melhores momentos", 10, 15 ou 20 (o vídeo dura a soma dos cortes). */
  duration_s: z.union([z.literal(6), z.literal(10), z.literal(15), z.literal(20)]),
  /** As fotos ou o vídeo de Fotos, na ordem em que entram no vídeo. */
  media_ids: z.array(z.uuid()).min(1).max(4),
  /** O título (obrigatório nos modelos com texto; os "Melhores momentos" não levam). */
  title: z.string().trim().min(1).max(VIDEO_MONTAGE_LIMITS.title).optional(),
  /** A linha do preço (só nos modelos com preço); o preço é o de uma oferta em vigor em Minha marca. */
  price_line: z.string().trim().min(1).max(VIDEO_MONTAGE_LIMITS.priceLine).optional(),
  /** A chamada (obrigatória nos modelos com texto; os "Melhores momentos" não levam). */
  cta: z.string().trim().min(1).max(VIDEO_MONTAGE_LIMITS.cta).optional(),
  /** Os cortes, na ordem do vídeo (só nos "Melhores momentos", e obrigatórios nele; de 2 a 6). */
  cuts: z.array(VideoCut).min(2).max(6).optional(),
  /** A logo de Minha marca no selo (só com a logo guardada). */
  with_logo: z.boolean().default(false),
  /** `sem` (o padrão) ou `original` (o som do vídeo da loja, só na "Novidade" com vídeo). */
  sound: z.enum(['sem', 'original']).default('sem'),
});
export type CreateVideoMontageRequest = z.infer<typeof CreateVideoMontageRequest>;

export const VIDEO_MONTAGE_STATUSES = ['na_fila', 'montando', 'pronto', 'nao_deu'] as const;
export const VideoMontageStatus = z.enum(VIDEO_MONTAGE_STATUSES);
export type VideoMontageStatus = z.infer<typeof VideoMontageStatus>;

export const VideoMontageResponse = z.strictObject({
  id: z.uuid(),
  brand_id: z.uuid(),
  template: VideoTemplate,
  format: VideoFormat,
  duration_s: z.int(),
  media_ids: z.array(z.uuid()),
  title: z.string(),
  price_line: z.string().nullable(),
  cta: z.string(),
  /** Os cortes dos "Melhores momentos", na ordem do vídeo; nulo nos outros modelos. */
  cuts: z.array(VideoCut).nullable().optional(),
  with_logo: z.boolean(),
  sound: z.enum(['sem', 'original']),
  status: VideoMontageStatus,
  /** O andamento da montagem, de 0 a 100. */
  progress: z.int().min(0).max(100),
  /** O porquê de `nao_deu`, em palavras. */
  error: z.string().nullable(),
  /** Quantos vídeos (de todas as marcas) estão na frente deste na fila; nulo fora da fila. */
  queue_ahead: z.int().min(0).nullable(),
  /** O vídeo pronto em Fotos. */
  photo_id: z.uuid().nullable(),
  created_at: z.iso.datetime({ offset: true }),
  started_at: z.iso.datetime({ offset: true }).nullable(),
  finished_at: z.iso.datetime({ offset: true }).nullable(),
});
export type VideoMontageResponse = z.infer<typeof VideoMontageResponse>;

export const VideoMontageListQuery = z.strictObject({ brand_id: z.uuid() });
export type VideoMontageListQuery = z.infer<typeof VideoMontageListQuery>;

export const VideoMontageListResponse = z.strictObject({
  /** A função `video_montado` ligada para a marca. */
  enabled: z.boolean(),
  /** A função `video_momentos` ligada para a marca: "Os melhores momentos" aparecem na gaveta (A6 · Z16). */
  moments_enabled: z.boolean(),
  /** Os vídeos de hoje que contam no limite, o limite e quando ele volta (meia-noite no fuso da empresa). */
  today: z.strictObject({ used: z.int().min(0), limit: z.int().min(1), resets_at: z.iso.datetime({ offset: true }) }),
  /** Minha marca tem a logo do restaurante: a opção da logo fica disponível. */
  has_logo: z.boolean(),
  /** Os pedidos mais recentes da marca (até 20). */
  items: z.array(VideoMontageResponse),
});
export type VideoMontageListResponse = z.infer<typeof VideoMontageListResponse>;

/** O pedido dos textos ao Social media (A6 · Z15, parte 3b; D-A6-135): o modelo e as fotos ou o vídeo escolhidos. */
export const VideoTextsRequest = z.strictObject({
  brand_id: z.uuid(),
  template: VideoTemplate,
  /** As fotos ou o vídeo de Fotos desta marca, na ordem do vídeo: o produto e a descrição de cada um vão ao Social media. */
  media_ids: z.array(z.uuid()).min(1).max(4),
});
export type VideoTextsRequest = z.infer<typeof VideoTextsRequest>;

export const VIDEO_TEXTS_NO_AI_REASONS = [
  'funcao_desligada',
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
] as const;

/**
 * A proposta do Social media, já conferida pelo Compliance (o preço só o de uma oferta em vigor, as regras do Liame e o
 * que a marca não diz). Sem a IA (desligada, sem rota, no teto, fora do ar ou com a proposta barrada), `origin` é
 * `sem_ia`, com o motivo, e a pessoa escreve os textos.
 */
export const VideoTextsResponse = z.strictObject({
  origin: z.enum(['ia', 'sem_ia']),
  reason: z.enum(VIDEO_TEXTS_NO_AI_REASONS).nullable(),
  texts: z
    .strictObject({
      title: z.string().min(1).max(VIDEO_MONTAGE_LIMITS.title),
      price_line: z.string().min(1).max(VIDEO_MONTAGE_LIMITS.priceLine).nullable(),
      cta: z.string().min(1).max(VIDEO_MONTAGE_LIMITS.cta),
    })
    .nullable(),
  /** A oferta de Minha marca de onde veio o preço, como está escrita; nula sem preço. */
  offer: z.string().nullable(),
  /** No teto de custo: quando a IA volta. */
  retry_at: z.iso.datetime({ offset: true }).nullable(),
  /** A chamada em `ai_usage` (para o retorno da pessoa); nula sem a IA. */
  usage_id: z.uuid().nullable(),
});
export type VideoTextsResponse = z.infer<typeof VideoTextsResponse>;

// Os melhores momentos (A6 · Z16, parte 3; P46; D-A6-150 a D-A6-154): a pessoa escolhe de 1 a 4 vídeos de Fotos e pede os
// cortes. O serviço de montagem (`liame-render`) tira os quadros dos vídeos e o worker os manda ao Social media, que propõe
// os cortes; a proposta passa pela régua (`cortesDaResposta`) antes de a pessoa ver.

/** As durações do vídeo dos melhores momentos, em segundos (D-A6-150). */
export const VIDEO_CUTS_DURATIONS = [10, 15, 20] as const;

export const VIDEO_CUTS_LIMITS = {
  /** Cada vídeo escolhido tem pelo menos 3 segundos (o corte mais curto tem 1,5). */
  minVideoMs: 3_000,
  /** Quantas vezes a pessoa pode "Pedir outros cortes" a partir de um pedido (D-A6-151). */
  others: 2,
  /** Pedidos de cortes por marca por dia (cada um gasta a IA com até 16 imagens; o limite volta à meia-noite, no fuso da empresa). */
  perDay: 10,
} as const;

export const CreateVideoCutsRequest = z.strictObject({
  brand_id: z.uuid(),
  /** Os vídeos de Fotos desta marca, na ordem, de 1 a 4, sem repetir. */
  media_ids: z
    .array(z.uuid())
    .min(1)
    .max(4)
    .refine((ids) => new Set(ids).size === ids.length, { error: 'Cada vídeo entra uma vez só' }),
  duration_s: z.union([z.literal(10), z.literal(15), z.literal(20)]),
  /** O pedido de antes, no "Pedir outros cortes" (até 2 vezes: `others_left`). */
  previous_id: z.uuid().optional(),
});
export type CreateVideoCutsRequest = z.infer<typeof CreateVideoCutsRequest>;

export const VIDEO_CUTS_STATUSES = ['pedido', 'quadros_prontos', 'lendo', 'pronta', 'falhou'] as const;
/** `pedido` (o serviço de montagem vai tirar os quadros), `quadros_prontos` (espera o Social media), `lendo`, `pronta` ou `falhou`. */
export const VideoCutsStatus = z.enum(VIDEO_CUTS_STATUSES);
export type VideoCutsStatus = z.infer<typeof VideoCutsStatus>;

/**
 * O porquê de `falhou`, hoje: o que a régua recusou na proposta (`quantidade`, `video_fora`, `tempo_fora`, `corte_curto`,
 * `corte_longo`, `repetido`, `total_fora`, `vazio`, `longo`, `emoji_ou_hashtag`, `dado_pessoal`, `compliance`), a resposta
 * fora do formato (`formato`), a IA que não respondeu (`ia_desligada`, `sem-rota`, `teto`, `limite-usuario`, `travada`,
 * `parada`, `indisponivel`, `entrada-grande`), o Social media desligado na marca (`funcionario_desligado`), os quadros que
 * não chegaram (`sem_quadros`) ou o pedido parado no caminho (`parado`). A lista pode crescer (o serviço de montagem
 * também pode dar por falho; V23): na resposta, o motivo vai como texto.
 */
export const VIDEO_CUTS_FAIL_REASONS = [
  'quantidade',
  'video_fora',
  'tempo_fora',
  'corte_curto',
  'corte_longo',
  'repetido',
  'total_fora',
  'vazio',
  'longo',
  'emoji_ou_hashtag',
  'dado_pessoal',
  'compliance',
  'formato',
  'ia_desligada',
  'sem-rota',
  'teto',
  'limite-usuario',
  'travada',
  'parada',
  'indisponivel',
  'entrada-grande',
  'funcionario_desligado',
  'sem_quadros',
  'parado',
] as const;
export type VideoCutsFailReason = (typeof VIDEO_CUTS_FAIL_REASONS)[number];

/**
 * Um corte dos "Melhores momentos" (A6 · Z16; D-A6-150 e D-A6-152): o vídeo de Fotos (um dos `media_ids`), o começo e o
 * fim em milissegundos e a legenda (até 40 letras). A ordem da lista é a ordem do vídeo; o servidor confere cada corte
 * dentro do vídeo, de 1,5 a 8 segundos, sem repetir pedaço, o total perto da duração e as legendas pelo Compliance.
 */
export const VideoCut = z.strictObject({
  media_id: z.uuid(),
  start_ms: z.int().min(0),
  end_ms: z.int().min(1),
  caption: z.string().trim().min(1).max(40),
});
export type VideoCut = z.infer<typeof VideoCut>;

export const VideoCutsResponse = z.strictObject({
  id: z.uuid(),
  brand_id: z.uuid(),
  media_ids: z.array(z.uuid()),
  duration_s: z.int(),
  status: VideoCutsStatus,
  /** Os cortes na ordem do vídeo, conferidos pela régua; nulo até ficar pronta. */
  cuts: z.array(VideoCut).nullable(),
  /** A soma dos cortes, em milissegundos; nula até ficar pronta. */
  total_ms: z.int().min(0).nullable(),
  /** O porquê de `falhou` (os de hoje em `VIDEO_CUTS_FAIL_REASONS`); texto, porque a lista pode crescer (V23). */
  reason: z
    .string()
    .regex(/^[a-z][a-z_-]{1,40}$/)
    .nullable()
    .describe('O porquê de `falhou` (a lista cresce; ignore o que não conhecer): `quantidade`, `video_fora`, `tempo_fora`, `corte_curto`, `corte_longo`, `repetido`, `total_fora`, `vazio`, `longo`, `emoji_ou_hashtag`, `dado_pessoal`, `compliance`, `formato`, `ia_desligada`, `sem-rota`, `teto`, `limite-usuario`, `travada`, `parada`, `indisponivel`, `entrada-grande`, `funcionario_desligado`, `sem_quadros` ou `parado`. Nulo nas outras situações.'),
  /** Quantos "Pedir outros cortes" restam a partir deste pedido (2 menos os pedidos de antes dele). */
  others_left: z.int().min(0).max(VIDEO_CUTS_LIMITS.others),
  created_at: z.iso.datetime({ offset: true }),
});
export type VideoCutsResponse = z.infer<typeof VideoCutsResponse>;

/**
 * O que o serviço de montagem (`liame-render`, A6 · Z15 parte 2b; D-A6-139) passa ao modelo do Remotion
 * (`packages/video-modelos`). Interno: não sai na API. As fotos, o vídeo e a logo vão por endereços de leitura assinados
 * e curtos do armazenamento; os textos já passaram pelo Compliance no pedido.
 */
export type VideoRenderProps = {
  template: VideoTemplate;
  format: VideoFormat;
  duration_s: 6 | 10 | 15 | 20;
  /** Na ordem do pedido. */
  media: { url: string; kind: 'foto' | 'video' }[];
  title: string;
  price_line: string | null;
  cta: string;
  logo_url: string | null;
  sound: 'sem' | 'original';
  /**
   * Os cortes dos "Melhores momentos" (A6 · Z16), na ordem do vídeo: `media` é a posição do vídeo em `media`, o começo e o
   * fim em milissegundos e a legenda já conferida. O vídeo dura a soma dos cortes. Ausente nos outros modelos.
   */
  cuts?: { media: number; start_ms: number; end_ms: number; caption: string }[];
};

/** As medidas de cada formato, em pixels, e os quadros por segundo do vídeo montado. */
export const VIDEO_RENDER_SIZES: Record<VideoFormat, { width: number; height: number }> = {
  '9x16': { width: 1080, height: 1920 },
  '4x5': { width: 1080, height: 1350 },
  '1x1': { width: 1080, height: 1080 },
};
export const VIDEO_RENDER_FPS = 30;
