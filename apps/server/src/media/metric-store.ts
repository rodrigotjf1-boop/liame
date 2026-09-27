import type { Tx } from '@liame/database';
import { sql } from 'drizzle-orm';

// Gravação das métricas com modelo temporal (data-model §3.1, D-A2-7). Uma instrução por lote
// (set-based): a observação nova só entra quando o número mudou; o último valor por chave é sempre
// atualizado (observed_at = última leitura, changed_at = última mudança). Roda na transação de quem
// chama, sob a RLS da empresa.

export type NivelMetrica = 'account' | 'campaign' | 'ad_group' | 'ad';

export type PontoMetrica = {
  level: NivelMetrica;
  externalEntityId: string;
  entityId?: string | null;
  /** Dia a que o número se refere, no fuso da conta (AAAA-MM-DD). */
  metricDate: string;
  /** Canônica (spend, impressions…) ou do provider com prefixo (meta:link_click). */
  metricName: string;
  /** Janela declarada (7d_click_1d_view); vazio = métrica sem janela. */
  attributionWindow?: string;
  /** Valor exato: texto preserva a precisão do numeric. */
  value: number | string;
  quality?: 'ok' | 'parcial' | 'estimado';
};

export type ContextoMetricas = {
  tenantId: string;
  brandId: string;
  connectedAccountId: string;
  provider: string;
  syncRunId: string | null;
  sourceVersion: string | null;
  currency: string | null;
  timezone: string | null;
  /** Momento da leitura; o padrão é agora. */
  observedAt?: Date;
};

const LOTE = 2000;

function chave(p: PontoMetrica): string {
  return [p.level, p.externalEntityId, p.metricDate, p.metricName, p.attributionWindow ?? ''].join('|');
}

/** Grava os pontos lidos. Devolve quantas observações novas (números que mudaram) e quantos pontos lidos. */
export async function gravarMetricas(tx: Tx, ctx: ContextoMetricas, pontos: PontoMetrica[]): Promise<{ novas: number; lidas: number }> {
  // A mesma chave duas vezes no lote faria o upsert tocar a linha duas vezes: vale a última leitura.
  const unicos = [...new Map(pontos.map((p) => [chave(p), p])).values()];
  const observedAt = (ctx.observedAt ?? new Date()).toISOString();
  let novas = 0;
  for (let i = 0; i < unicos.length; i += LOTE) {
    const lote = unicos.slice(i, i + LOTE).map((p) => ({
      level: p.level,
      external_entity_id: p.externalEntityId,
      entity_id: p.entityId ?? null,
      metric_date: p.metricDate,
      metric_name: p.metricName,
      attribution_window: p.attributionWindow ?? '',
      metric_value: String(p.value),
      quality: p.quality ?? 'ok',
    }));
    const r = await tx.execute<{ novas: string }>(sql`
      with entrada as (
        select * from jsonb_to_recordset(${JSON.stringify(lote)}::jsonb) as p(
          level text, external_entity_id text, entity_id uuid, metric_date date, metric_name text,
          attribution_window text, metric_value numeric, quality text)
      ),
      mudou as (
        select e.* from entrada e
          left join liame.metric_latest l
            on l.connected_account_id = ${ctx.connectedAccountId} and l.level = e.level
           and l.external_entity_id = e.external_entity_id and l.metric_date = e.metric_date
           and l.metric_name = e.metric_name and l.attribution_window = e.attribution_window
         where l.metric_value is distinct from e.metric_value
      ),
      obs as (
        insert into liame.metric_observation (
          tenant_id, brand_id, connected_account_id, provider, level, entity_id, external_entity_id, metric_date,
          metric_name, attribution_window, metric_value, currency, timezone, observed_at, sync_run_id, source_version, quality)
        select ${ctx.tenantId}, ${ctx.brandId}, ${ctx.connectedAccountId}, ${ctx.provider}, m.level, m.entity_id, m.external_entity_id,
               m.metric_date, m.metric_name, m.attribution_window, m.metric_value, ${ctx.currency}, ${ctx.timezone},
               ${observedAt}::timestamptz, ${ctx.syncRunId}, ${ctx.sourceVersion}, m.quality
          from mudou m
        returning 1
      ),
      ultimo as (
        insert into liame.metric_latest (
          connected_account_id, level, external_entity_id, metric_date, metric_name, attribution_window, tenant_id, brand_id,
          provider, entity_id, metric_value, currency, timezone, observed_at, changed_at, sync_run_id, source_version, quality)
        select ${ctx.connectedAccountId}, e.level, e.external_entity_id, e.metric_date, e.metric_name, e.attribution_window,
               ${ctx.tenantId}, ${ctx.brandId}, ${ctx.provider}, e.entity_id, e.metric_value, ${ctx.currency}, ${ctx.timezone},
               ${observedAt}::timestamptz, ${observedAt}::timestamptz, ${ctx.syncRunId}, ${ctx.sourceVersion}, e.quality
          from entrada e
        on conflict (connected_account_id, level, external_entity_id, metric_date, metric_name, attribution_window) do update
           set changed_at = case when liame.metric_latest.metric_value is distinct from excluded.metric_value
                                 then excluded.observed_at else liame.metric_latest.changed_at end,
               metric_value = excluded.metric_value,
               entity_id = coalesce(excluded.entity_id, liame.metric_latest.entity_id),
               observed_at = excluded.observed_at,
               sync_run_id = excluded.sync_run_id,
               source_version = excluded.source_version,
               quality = excluded.quality
        returning 1
      )
      select (select count(*) from obs)::text as novas, (select count(*) from ultimo)::text as tocadas`);
    novas += Number(r.rows[0]?.novas ?? 0);
  }
  return { novas, lidas: unicos.length };
}

/**
 * "Quanto a plataforma dizia naquela data?": o valor de cada chave de um dia como estava em `asOf`
 * (a última observação até lá). Usado para comparar hoje × o que se via antes.
 */
export async function metricasEm(tx: Tx, contaId: string, metricDate: string, asOf: Date) {
  const r = await tx.execute<{ level: string; external_entity_id: string; metric_name: string; attribution_window: string; metric_value: string }>(sql`
    select distinct on (level, external_entity_id, metric_name, attribution_window)
           level, external_entity_id, metric_name, attribution_window, metric_value::text as metric_value
      from liame.metric_observation
     where connected_account_id = ${contaId} and metric_date = ${metricDate} and observed_at <= ${asOf.toISOString()}::timestamptz
     order by level, external_entity_id, metric_name, attribution_window, observed_at desc, id desc`);
  return r.rows;
}

/**
 * Zera o que a plataforma deixou de devolver na janela relida por inteiro: a Meta e o GA4 omitem a
 * linha quando o número vira zero (conversão reatribuída, por exemplo). Toda chave lida nesta execução
 * ficou com `observed_at` = a hora da leitura; a que ficou para trás, dentro da janela e diferente de
 * zero, passa a valer zero, com observação nova (o "antes" continua consultável). Só depois de a
 * janela inteira ter sido lida sem erro.
 */
export async function zerarAusentes(tx: Tx, ctx: ContextoMetricas & { observedAt: Date }, janela: { inicio: string; fim: string }): Promise<number> {
  const r = await tx.execute<{ level: NivelMetrica; external_entity_id: string; entity_id: string | null; metric_date: string; metric_name: string; attribution_window: string }>(sql`
    select level, external_entity_id, entity_id, metric_date::text as metric_date, metric_name, attribution_window
      from liame.metric_latest
     where connected_account_id = ${ctx.connectedAccountId}
       and metric_date between ${janela.inicio}::date and ${janela.fim}::date
       and observed_at < ${ctx.observedAt.toISOString()}::timestamptz
       and metric_value <> 0`);
  if (!r.rows.length) return 0;
  const zeros: PontoMetrica[] = r.rows.map((l) => ({
    level: l.level,
    externalEntityId: l.external_entity_id,
    entityId: l.entity_id,
    metricDate: l.metric_date,
    metricName: l.metric_name,
    attributionWindow: l.attribution_window,
    value: 0,
  }));
  return (await gravarMetricas(tx, ctx, zeros)).novas;
}
