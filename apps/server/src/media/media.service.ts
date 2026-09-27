import type { AccountFreshness, MediaFreshnessResponse, MediaMetricsQuery, MediaMetricsResponse } from '@liame/contracts';
import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { currentTx } from '../context/request-context.js';
import { AppProblem } from '../errors/problems.js';
import { frescor } from './frescor.js';

// Leitura dos dados de mídia (A2, G7): tudo na transação da requisição, sob a RLS da empresa.

/** Janela máxima de uma consulta de métricas (um trimestre). */
const MAX_DIAS = 92;

const iso = (v: Date | string) => new Date(v).toISOString();
const isoOuNulo = (v: Date | string | null) => (v ? iso(v) : null);

type LinhaEstado = {
  id: string;
  brand_id: string;
  provider: string;
  name: string;
  status: string;
  status_reason: string | null;
  dataset: string | null;
  expected_every_minutes: number | null;
  last_success_at: Date | string | null;
  last_attempt_at: Date | string | null;
  last_error: string | null;
  proxima: string | null;
};

type LinhaMetrica = {
  connected_account_id: string;
  provider: string;
  level: string;
  external_entity_id: string;
  entity_id: string | null;
  metric_date: string;
  metric_name: string;
  attribution_window: string;
  metric_value: string;
  currency: string | null;
  quality: string;
  observed_at: Date | string;
  changed_at: Date | string;
  expected_every_minutes: number | null;
  last_success_at: Date | string | null;
};

@Injectable()
export class MediaService {
  /** Frescor de cada conta ligada (e de cada conjunto de dados dela). */
  async frescor(brandId: string | undefined, agora = new Date()): Promise<MediaFreshnessResponse> {
    const r = await currentTx().execute<LinhaEstado>(sql`
      select a.id, a.brand_id, a.provider, a.name, a.status, a.status_reason, s.dataset, s.expected_every_minutes,
             s.last_success_at, s.last_attempt_at, s.last_error, s.cursor->>'proxima' as proxima
        from liame.connected_account a
        left join liame.sync_state s on s.connected_account_id = a.id
       where a.disconnected_at is null ${brandId ? sql`and a.brand_id = ${brandId}` : sql``}
       order by a.name, a.id, s.dataset`);
    const contas = new Map<string, AccountFreshness>();
    for (const l of r.rows) {
      let c = contas.get(l.id);
      if (!c) {
        c = { connected_account_id: l.id, brand_id: l.brand_id, provider: l.provider, name: l.name, status: l.status, status_reason: l.status_reason, datasets: [] };
        contas.set(l.id, c);
      }
      if (!l.dataset) continue;
      c.datasets.push({
        dataset: l.dataset,
        freshness: frescor({ lastSuccessAt: l.last_success_at, expectedEveryMinutes: l.expected_every_minutes ?? 1440 }, agora),
        last_success_at: isoOuNulo(l.last_success_at),
        last_attempt_at: isoOuNulo(l.last_attempt_at),
        last_error: l.last_error,
        next_at: l.proxima ? iso(l.proxima) : null,
      });
    }
    // Conta ligada que ainda não sincronizou aparece como "unknown", nunca como vazia.
    for (const c of contas.values()) {
      if (!c.datasets.length) c.datasets.push({ dataset: 'metricas', freshness: 'unknown', last_success_at: null, last_attempt_at: null, last_error: null, next_at: null });
    }
    return { items: [...contas.values()] };
  }

  /** Último valor de cada métrica no período, cada ponto com o frescor da conta de onde veio. */
  async metricas(q: MediaMetricsQuery, agora = new Date()): Promise<MediaMetricsResponse> {
    const dias = (Date.parse(`${q.to}T00:00:00Z`) - Date.parse(`${q.from}T00:00:00Z`)) / 86_400_000 + 1;
    if (dias < 1 || dias > MAX_DIAS) {
      throw new AppProblem(422, 'periodo-invalido', 'Período inválido', `O período vai de 1 a ${MAX_DIAS} dias, com o início antes do fim.`);
    }
    const r = await currentTx().execute<LinhaMetrica>(sql`
      select l.connected_account_id, l.provider, l.level, l.external_entity_id, l.entity_id, l.metric_date::text as metric_date, l.metric_name,
             l.attribution_window, l.metric_value::text as metric_value, l.currency, l.quality, l.observed_at, l.changed_at,
             s.expected_every_minutes, s.last_success_at
        from liame.metric_latest l
        join liame.connected_account a on a.id = l.connected_account_id and a.disconnected_at is null
        left join liame.sync_state s on s.connected_account_id = l.connected_account_id and s.dataset = 'metricas'
       where l.metric_date between ${q.from}::date and ${q.to}::date
         ${q.brand_id ? sql`and l.brand_id = ${q.brand_id}` : sql``}
         ${q.connected_account_id ? sql`and l.connected_account_id = ${q.connected_account_id}` : sql``}
         ${q.level ? sql`and l.level = ${q.level}` : sql``}
         ${q.metric ? sql`and l.metric_name = ${q.metric}` : sql``}
       order by l.metric_date, l.connected_account_id, l.level, l.external_entity_id, l.metric_name, l.attribution_window
       limit ${q.limit + 1} offset ${q.offset}`);
    const linhas = r.rows.slice(0, q.limit);
    return {
      items: linhas.map((l) => ({
        connected_account_id: l.connected_account_id,
        provider: l.provider,
        level: l.level,
        external_entity_id: l.external_entity_id,
        entity_id: l.entity_id,
        metric_date: l.metric_date,
        metric_name: l.metric_name,
        attribution_window: l.attribution_window,
        value: l.metric_value,
        currency: l.currency,
        quality: l.quality,
        observed_at: iso(l.observed_at),
        changed_at: iso(l.changed_at),
        freshness: frescor({ lastSuccessAt: l.last_success_at, expectedEveryMinutes: l.expected_every_minutes ?? 1440 }, agora),
      })),
      has_more: r.rows.length > q.limit,
    };
  }
}
