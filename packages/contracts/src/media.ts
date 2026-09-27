import { z } from 'zod';

// Dados de mídia lidos das plataformas (A2, G7): frescor de cada conta e o último valor de cada métrica.
// Todo número sai com o frescor da fonte (A2-5). Listas que crescem vão como texto nas respostas (V23).

const Slug = z.string().regex(/^[a-z0-9_]+$/);
const Dia = z.iso.date();

export const MediaFreshnessQuery = z.strictObject({ brand_id: z.uuid().optional() });
export type MediaFreshnessQuery = z.infer<typeof MediaFreshnessQuery>;

export const DatasetFreshness = z.strictObject({
  /** `metricas` ou `entidades`. */
  dataset: Slug,
  /** `fresh`, `delayed`, `stale` ou `unknown` (nunca sincronizou). */
  freshness: Slug,
  last_success_at: z.string().nullable(),
  last_attempt_at: z.string().nullable(),
  /** Motivo curto da última falha, sem dado da plataforma. */
  last_error: z.string().nullable(),
  /** Próxima leitura prevista. */
  next_at: z.string().nullable(),
});
export type DatasetFreshness = z.infer<typeof DatasetFreshness>;

export const AccountFreshness = z.strictObject({
  connected_account_id: z.uuid(),
  brand_id: z.uuid(),
  provider: Slug,
  name: z.string(),
  status: Slug,
  status_reason: z.string().nullable(),
  datasets: z.array(DatasetFreshness),
});
export type AccountFreshness = z.infer<typeof AccountFreshness>;

export const MediaFreshnessResponse = z.strictObject({ items: z.array(AccountFreshness) });
export type MediaFreshnessResponse = z.infer<typeof MediaFreshnessResponse>;

export const MediaMetricsQuery = z.strictObject({
  from: Dia,
  to: Dia,
  brand_id: z.uuid().optional(),
  connected_account_id: z.uuid().optional(),
  level: z.enum(['account', 'campaign', 'ad_group', 'ad']).optional(),
  /** Um nome de métrica (ex.: `spend`); sem ele, todas. */
  metric: z.string().regex(/^[a-z0-9_.:]+$/).max(120).optional(),
  limit: z.coerce.number().int().min(1).max(5000).default(1000),
  offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
});
export type MediaMetricsQuery = z.infer<typeof MediaMetricsQuery>;

export const MediaMetricPoint = z.strictObject({
  connected_account_id: z.uuid(),
  provider: Slug,
  level: Slug,
  external_entity_id: z.string(),
  entity_id: z.uuid().nullable(),
  metric_date: z.string(),
  metric_name: z.string(),
  /** Janela de atribuição declarada; vazio = métrica sem janela. */
  attribution_window: z.string(),
  /** Valor exato em texto (sem perder precisão). */
  value: z.string(),
  currency: z.string().nullable(),
  /** `ok`, `parcial` ou `estimado`. */
  quality: Slug,
  /** Última leitura e última vez que o número mudou. */
  observed_at: z.string(),
  changed_at: z.string(),
  /** Frescor da fonte deste número (`fresh`, `delayed`, `stale`, `unknown`). */
  freshness: Slug,
});
export type MediaMetricPoint = z.infer<typeof MediaMetricPoint>;

export const MediaMetricsResponse = z.strictObject({
  items: z.array(MediaMetricPoint),
  has_more: z.boolean(),
});
export type MediaMetricsResponse = z.infer<typeof MediaMetricsResponse>;

export const MediaAttentionQuery = z.strictObject({ brand_id: z.uuid().optional() });
export type MediaAttentionQuery = z.infer<typeof MediaAttentionQuery>;

export const AttentionItem = z.strictObject({
  /** `conta_desconectada`, `conta_sem_permissao`, `conta_com_erro`, `dado_atrasado`, `reconectar_em_breve`, `gasto_fora_do_normal`, `campanha_parou` ou `versao_api`. */
  kind: Slug,
  /** `critica`, `atencao` ou `info`. */
  severity: Slug,
  title: z.string(),
  detail: z.string(),
  /** O que fazer, em uma frase. */
  action: z.string(),
  connected_account_id: z.uuid().nullable(),
  campaign_id: z.uuid().nullable(),
  provider: Slug.nullable(),
});
export type AttentionItem = z.infer<typeof AttentionItem>;

export const MediaAttentionResponse = z.strictObject({
  /** Mais grave primeiro. */
  items: z.array(AttentionItem),
  generated_at: z.string(),
});
export type MediaAttentionResponse = z.infer<typeof MediaAttentionResponse>;
