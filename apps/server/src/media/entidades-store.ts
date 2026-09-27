import { type Tx, uuidv7 } from '@liame/database';
import { sql } from 'drizzle-orm';
import type { EntidadesLidas } from '../connectors/tipos.js';

// Gravação das entidades lidas (A2, G7; data-model §3): uma instrução por tipo e lote (set-based),
// upsert pela chave (conta, id na plataforma). Os pais se resolvem por junção no próprio banco
// (campanha → grupo → anúncio; criativo → anúncio). Entidade que some da plataforma fica, com o
// `last_seen_at` da última leitura. Roda na transação de quem chama, sob a RLS da empresa.

const LOTE = 2000;

export type ContextoEntidades = { tenantId: string; connectedAccountId: string; provider: string };

function lotes<T>(itens: T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < itens.length; i += LOTE) out.push(itens.slice(i, i + LOTE));
  return out;
}

/** Grava campanhas, criativos, grupos e anúncios; devolve quantas linhas foram inseridas ou atualizadas. */
export async function gravarEntidades(tx: Tx, ctx: ContextoEntidades, e: EntidadesLidas): Promise<number> {
  let escritas = 0;
  const conta = ctx.connectedAccountId;

  for (const lote of lotes(e.campaigns)) {
    const linhas = lote.map((c) => ({
      id: uuidv7(),
      external_id: c.externalId,
      name: c.name,
      status: c.status,
      provider_status: c.providerStatus,
      objective: c.objective ?? null,
      daily_budget_micros: c.dailyBudgetMicros ?? null,
      lifetime_budget_micros: c.lifetimeBudgetMicros ?? null,
      provider_attributes: c.providerAttributes ?? {},
    }));
    const r = await tx.execute(sql`
      insert into liame.campaign (id, tenant_id, connected_account_id, provider, external_id, name, status, provider_status, objective,
                                  daily_budget_micros, lifetime_budget_micros, provider_attributes)
      select x.id, ${ctx.tenantId}, ${conta}, ${ctx.provider}, x.external_id, x.name, x.status, x.provider_status, x.objective,
             x.daily_budget_micros, x.lifetime_budget_micros, coalesce(x.provider_attributes, '{}'::jsonb)
        from jsonb_to_recordset(${JSON.stringify(linhas)}::jsonb) as x (
          id uuid, external_id text, name text, status text, provider_status text, objective text,
          daily_budget_micros bigint, lifetime_budget_micros bigint, provider_attributes jsonb)
      on conflict (connected_account_id, external_id) do update
         set name = excluded.name, status = excluded.status, provider_status = excluded.provider_status, objective = excluded.objective,
             daily_budget_micros = excluded.daily_budget_micros, lifetime_budget_micros = excluded.lifetime_budget_micros,
             provider_attributes = excluded.provider_attributes, last_seen_at = now()`);
    escritas += r.rowCount ?? 0;
  }

  for (const lote of lotes(e.creatives)) {
    const linhas = lote.map((c) => ({
      id: uuidv7(),
      external_id: c.externalId,
      name: c.name,
      kind: c.kind,
      thumbnail_url: c.thumbnailUrl,
      provider_attributes: c.providerAttributes ?? {},
    }));
    const r = await tx.execute(sql`
      insert into liame.creative (id, tenant_id, connected_account_id, provider, external_id, name, kind, thumbnail_url, provider_attributes)
      select x.id, ${ctx.tenantId}, ${conta}, ${ctx.provider}, x.external_id, x.name, x.kind, x.thumbnail_url, coalesce(x.provider_attributes, '{}'::jsonb)
        from jsonb_to_recordset(${JSON.stringify(linhas)}::jsonb) as x (
          id uuid, external_id text, name text, kind text, thumbnail_url text, provider_attributes jsonb)
      on conflict (connected_account_id, external_id) do update
         set name = excluded.name, kind = excluded.kind, thumbnail_url = excluded.thumbnail_url,
             provider_attributes = excluded.provider_attributes, last_seen_at = now()`);
    escritas += r.rowCount ?? 0;
  }

  for (const lote of lotes(e.adGroups)) {
    const linhas = lote.map((g) => ({
      id: uuidv7(),
      external_id: g.externalId,
      parent: g.parentExternalId ?? null,
      name: g.name,
      status: g.status,
      provider_status: g.providerStatus,
      daily_budget_micros: g.dailyBudgetMicros ?? null,
      provider_attributes: g.providerAttributes ?? {},
    }));
    const r = await tx.execute(sql`
      insert into liame.ad_group (id, tenant_id, connected_account_id, campaign_id, provider, external_id, name, status, provider_status,
                                  daily_budget_micros, provider_attributes)
      select x.id, ${ctx.tenantId}, ${conta}, c.id, ${ctx.provider}, x.external_id, x.name, x.status, x.provider_status,
             x.daily_budget_micros, coalesce(x.provider_attributes, '{}'::jsonb)
        from jsonb_to_recordset(${JSON.stringify(linhas)}::jsonb) as x (
          id uuid, external_id text, parent text, name text, status text, provider_status text, daily_budget_micros bigint, provider_attributes jsonb)
        left join liame.campaign c on c.connected_account_id = ${conta} and c.external_id = x.parent
      on conflict (connected_account_id, external_id) do update
         set campaign_id = excluded.campaign_id, name = excluded.name, status = excluded.status, provider_status = excluded.provider_status,
             daily_budget_micros = excluded.daily_budget_micros, provider_attributes = excluded.provider_attributes, last_seen_at = now()`);
    escritas += r.rowCount ?? 0;
  }

  for (const lote of lotes(e.ads)) {
    const linhas = lote.map((a) => ({
      id: uuidv7(),
      external_id: a.externalId,
      parent: a.parentExternalId ?? null,
      creative: a.creativeExternalId ?? null,
      name: a.name,
      status: a.status,
      provider_status: a.providerStatus,
      provider_attributes: a.providerAttributes ?? {},
    }));
    const r = await tx.execute(sql`
      insert into liame.ad (id, tenant_id, connected_account_id, ad_group_id, creative_id, provider, external_id, name, status, provider_status,
                            provider_attributes)
      select x.id, ${ctx.tenantId}, ${conta}, g.id, cr.id, ${ctx.provider}, x.external_id, x.name, x.status, x.provider_status,
             coalesce(x.provider_attributes, '{}'::jsonb)
        from jsonb_to_recordset(${JSON.stringify(linhas)}::jsonb) as x (
          id uuid, external_id text, parent text, creative text, name text, status text, provider_status text, provider_attributes jsonb)
        left join liame.ad_group g on g.connected_account_id = ${conta} and g.external_id = x.parent
        left join liame.creative cr on cr.connected_account_id = ${conta} and cr.external_id = x.creative
      on conflict (connected_account_id, external_id) do update
         set ad_group_id = excluded.ad_group_id, creative_id = excluded.creative_id, name = excluded.name, status = excluded.status,
             provider_status = excluded.provider_status, provider_attributes = excluded.provider_attributes, last_seen_at = now()`);
    escritas += r.rowCount ?? 0;
  }
  return escritas;
}

/** Id interno de cada anúncio e campanha da conta, para ligar as métricas às entidades. */
export async function idsDasEntidades(tx: Tx, contaId: string): Promise<{ ad: Map<string, string>; campaign: Map<string, string> }> {
  const r = await tx.execute<{ nivel: 'ad' | 'campaign'; external_id: string; id: string }>(sql`
    select 'ad' as nivel, external_id, id from liame.ad where connected_account_id = ${contaId}
    union all
    select 'campaign', external_id, id from liame.campaign where connected_account_id = ${contaId}`);
  const out = { ad: new Map<string, string>(), campaign: new Map<string, string>() };
  for (const l of r.rows) out[l.nivel].set(l.external_id, l.id);
  return out;
}
