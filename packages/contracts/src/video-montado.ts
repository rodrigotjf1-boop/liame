import { z } from 'zod';

// O vídeo montado pelo Liame (A6 · Z15, parte 2a; P43 aprovado em 11/11/2026; D-A6-133 a D-A6-138): a pessoa escolhe o
// modelo, as fotos ou o vídeo de Fotos, o formato, os textos (conferidos pelo Compliance), a logo, a duração e o som; o
// pedido entra na fila e o serviço de montagem (`liame-render`) monta um por vez. O vídeo pronto entra em Fotos.

export const VIDEO_TEMPLATES = ['destaque', 'combo', 'novidade'] as const;
/** `destaque` (uma foto, o nome e o preço), `combo` (de 2 a 4 fotos e o preço no fim), `novidade` (uma foto ou um vídeo, a faixa "Novidade" e a chamada). */
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

/** Quantas fotos ou vídeos cada modelo leva, e se aceita vídeo e a linha do preço. */
export const VIDEO_TEMPLATE_RULES: Record<VideoTemplate, { min: number; max: number; video: boolean; price: boolean }> = {
  destaque: { min: 1, max: 1, video: false, price: true },
  combo: { min: 2, max: 4, video: false, price: true },
  novidade: { min: 1, max: 1, video: true, price: false },
};

export const CreateVideoMontageRequest = z.strictObject({
  brand_id: z.uuid(),
  template: VideoTemplate,
  format: VideoFormat,
  duration_s: z.union([z.literal(6), z.literal(10), z.literal(15)]),
  /** As fotos ou o vídeo de Fotos, na ordem em que entram no vídeo. */
  media_ids: z.array(z.uuid()).min(1).max(4),
  title: z.string().trim().min(1).max(VIDEO_MONTAGE_LIMITS.title),
  /** A linha do preço (só nos modelos com preço); o preço é o de uma oferta em vigor em Minha marca. */
  price_line: z.string().trim().min(1).max(VIDEO_MONTAGE_LIMITS.priceLine).optional(),
  cta: z.string().trim().min(1).max(VIDEO_MONTAGE_LIMITS.cta),
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

/**
 * O que o serviço de montagem (`liame-render`, A6 · Z15 parte 2b; D-A6-139) passa ao modelo do Remotion
 * (`packages/video-modelos`). Interno: não sai na API. As fotos, o vídeo e a logo vão por endereços de leitura assinados
 * e curtos do armazenamento; os textos já passaram pelo Compliance no pedido.
 */
export type VideoRenderProps = {
  template: VideoTemplate;
  format: VideoFormat;
  duration_s: 6 | 10 | 15;
  /** Na ordem do pedido. */
  media: { url: string; kind: 'foto' | 'video' }[];
  title: string;
  price_line: string | null;
  cta: string;
  logo_url: string | null;
  sound: 'sem' | 'original';
};

/** As medidas de cada formato, em pixels, e os quadros por segundo do vídeo montado. */
export const VIDEO_RENDER_SIZES: Record<VideoFormat, { width: number; height: number }> = {
  '9x16': { width: 1080, height: 1920 },
  '4x5': { width: 1080, height: 1350 },
  '1x1': { width: 1080, height: 1080 },
};
export const VIDEO_RENDER_FPS = 30;
