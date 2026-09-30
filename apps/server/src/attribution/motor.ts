import { type Tx, uuidv7 } from '@liame/database';
import { sql } from 'drizzle-orm';

// Motor de atribuição (A2.5, F2; ADR-020): determinístico, sem IA, em SQL de conjunto. Uma execução
// calcula, numa instrução, todos os pedidos pedidos: junta as evidências (cupom exclusivo, clique, conversa
// por anúncio), aplica a janela e os canais do modelo — lidos do próprio modelo gravado no banco, que é
// dado versionado — e escolhe pela hierarquia; no mesmo nível, o toque mais recente; no empate, o menor
// id. O resultado do pedido para aquela versão de modelo é substituído (upsert), nunca duplicado.

/** Último toque v1 (migration 0022): o modelo padrão da distribuição. */
export const MODELO_PADRAO = '0199a000-0000-7000-8000-000000000001';

export type Gatilho = 'pedidos' | 'toques' | 'cupons' | 'periodo' | 'modelo' | 'manual';

export type ResumoAtribuicao = {
  runId: string | null;
  considerados: number;
  atribuidos: number;
  plataforma: number;
  semOrigem: number;
};

const LOTE = 5000;

/** Atribui (ou reatribui) os pedidos informados da empresa. Pedido de outra empresa é ignorado pela RLS e pelo filtro. */
export async function atribuirPedidos(
  tx: Tx,
  alvo: { tenantId: string; orderIds: string[]; gatilho: Gatilho; modelId?: string },
): Promise<ResumoAtribuicao> {
  const ids = [...new Set(alvo.orderIds)];
  const total: ResumoAtribuicao = { runId: null, considerados: 0, atribuidos: 0, plataforma: 0, semOrigem: 0 };
  if (!ids.length) return total;
  const modelId = alvo.modelId ?? MODELO_PADRAO;
  const runId = uuidv7();
  await tx.execute(sql`
    insert into liame.attribution_run (id, tenant_id, model_id, trigger) values (${runId}, ${alvo.tenantId}, ${modelId}, ${alvo.gatilho})`);
  total.runId = runId;

  for (let i = 0; i < ids.length; i += LOTE) {
    const lote = ids.slice(i, i + LOTE);
    const r = await tx.execute<{ status: string; n: string }>(sql`
      with modelo as (
        select m.id, m.window_days, m.rules from liame.attribution_model m where m.id = ${modelId}
      ),
      hierarquia as (
        select h.evidencia, h.nivel
          from modelo m, jsonb_array_elements_text(m.rules -> 'hierarquia') with ordinality as h(evidencia, nivel)
      ),
      pedidos as (
        select o.id, o.tenant_id, o.brand_id, o.connected_account_id, o.external_id, o.status, o.coupon_code,
               o.customer_ref_id, o.confirmed_at,
               o.channel_group in (select jsonb_array_elements_text(m.rules -> 'canais_so_cupom') from modelo m) as so_cupom
          from liame.order_fact o
         where o.tenant_id = ${alvo.tenantId}
           and o.id in (select value::uuid from jsonb_array_elements_text(${JSON.stringify(lote)}::jsonb))
      ),
      -- Cupom exclusivo ligado à campanha no momento do pedido.
      cupom as (
        select p.id as order_id, 'cupom'::text as evidencia, c.provider, cc.campaign_id, null::uuid as ad_id,
               null::uuid as touchpoint_id, cc.id as campaign_coupon_id, p.confirmed_at as touch_at
          from pedidos p
          join liame.coupon cp on cp.connected_account_id = p.connected_account_id and cp.code = p.coupon_code
          join liame.campaign_coupon cc on cc.coupon_id = cp.id and cc.exclusive
               and p.confirmed_at >= cc.linked_at and (cc.unlinked_at is null or p.confirmed_at < cc.unlinked_at)
          join liame.campaign c on c.id = cc.campaign_id
         where p.coupon_code is not null
      ),
      -- Clique captado na sessão do pedido: link do Liame > anúncio > grupo > campanha; sem nenhum deles,
      -- só a plataforma (id de clique).
      cliques as (
        select p.id as order_id,
               case when coalesce(tl.campaign_id, ra.campaign_id, rg.campaign_id, rc.campaign_id) is not null
                    then 'clique_campanha' else 'clique_plataforma' end as evidencia,
               coalesce(tl.provider, ra.provider, rg.provider, rc.provider, t.provider) as provider,
               coalesce(tl.campaign_id, ra.campaign_id, rg.campaign_id, rc.campaign_id) as campaign_id,
               coalesce(tl.ad_id, ra.ad_id) as ad_id,
               t.id as touchpoint_id, null::uuid as campaign_coupon_id, t.occurred_at as touch_at
          from pedidos p
          join liame.touchpoint t on t.connected_account_id = p.connected_account_id and t.order_external_id = p.external_id and t.kind = 'clique'
          left join liame.tracking_link tl on tl.tenant_id = p.tenant_id and tl.code = t.link_code
          left join lateral (
            select a.id as ad_id, g.campaign_id, a.provider from liame.ad a left join liame.ad_group g on g.id = a.ad_group_id
             where a.tenant_id = p.tenant_id and a.external_id = t.ad_external_id and (t.provider is null or a.provider = t.provider)
             order by a.last_seen_at desc, a.id limit 1) ra on true
          left join lateral (
            select g.campaign_id, g.provider from liame.ad_group g
             where g.tenant_id = p.tenant_id and g.external_id = t.ad_group_external_id and (t.provider is null or g.provider = t.provider)
             order by g.last_seen_at desc, g.id limit 1) rg on true
          left join lateral (
            select c.id as campaign_id, c.provider from liame.campaign c
             where c.tenant_id = p.tenant_id and c.external_id = t.campaign_external_id and (t.provider is null or c.provider = t.provider)
             order by c.last_seen_at desc, c.id limit 1) rc on true
         where coalesce(tl.provider, ra.provider, rg.provider, rc.provider, t.provider) is not null
      ),
      -- Conversa aberta por anúncio com o mesmo cliente pseudonimizado.
      conversas as (
        select p.id as order_id,
               case when coalesce(ra.campaign_id, rc.campaign_id) is not null then 'conversa_anuncio' else 'conversa_plataforma' end as evidencia,
               coalesce(ra.provider, rc.provider, t.provider) as provider,
               coalesce(ra.campaign_id, rc.campaign_id) as campaign_id,
               ra.ad_id, t.id as touchpoint_id, null::uuid as campaign_coupon_id, t.occurred_at as touch_at
          from pedidos p
          join liame.touchpoint t on t.tenant_id = p.tenant_id and t.kind = 'conversa' and t.customer_ref_id = p.customer_ref_id
          left join lateral (
            select a.id as ad_id, g.campaign_id, a.provider from liame.ad a left join liame.ad_group g on g.id = a.ad_group_id
             where a.tenant_id = p.tenant_id and a.external_id = t.ad_external_id and (t.provider is null or a.provider = t.provider)
             order by a.last_seen_at desc, a.id limit 1) ra on true
          left join lateral (
            select c.id as campaign_id, c.provider from liame.campaign c
             where c.tenant_id = p.tenant_id and c.external_id = t.campaign_external_id and (t.provider is null or c.provider = t.provider)
             order by c.last_seen_at desc, c.id limit 1) rc on true
         where p.customer_ref_id is not null and coalesce(ra.provider, rc.provider, t.provider) is not null
      ),
      todas as (
        select * from cupom union all select * from cliques union all select * from conversas
      ),
      validas as (
        select a.*, h.nivel
          from todas a
          join pedidos p on p.id = a.order_id
          join hierarquia h on h.evidencia = a.evidencia
          cross join modelo m
         where (not p.so_cupom or a.evidencia = 'cupom')
           and a.touch_at <= p.confirmed_at
           and a.touch_at > p.confirmed_at - make_interval(days => m.window_days)
      ),
      escolhida as (
        select distinct on (order_id) * from validas
         order by order_id, nivel, touch_at desc, coalesce(touchpoint_id, campaign_coupon_id)
      ),
      motivo as (
        select p.id as order_id,
               case when p.so_cupom then 'canal_sem_clique'
                    when exists (select 1 from todas a join hierarquia h on h.evidencia = a.evidencia where a.order_id = p.id) then 'fora_da_janela'
                    when exists (select 1 from liame.touchpoint t
                                  where t.connected_account_id = p.connected_account_id and t.order_external_id = p.external_id and t.kind = 'clique') then 'sem_id'
                    else 'sem_evidencia' end as reason
          from pedidos p
      ),
      gravados as (
        insert into liame.attribution_result (
          order_id, model_id, tenant_id, brand_id, run_id, status, provider, campaign_id, ad_id, evidence, confidence,
          touchpoint_id, campaign_coupon_id, touch_at, window_days, counted, reason, computed_at)
        select p.id, m.id, p.tenant_id, p.brand_id, ${runId},
               case when e.order_id is null then 'sem_origem' when e.campaign_id is null then 'plataforma' else 'atribuido' end,
               e.provider, e.campaign_id, e.ad_id, e.evidencia, m.rules -> 'confianca' ->> e.evidencia,
               e.touchpoint_id, e.campaign_coupon_id, e.touch_at, m.window_days,
               p.status = 'confirmado' and coalesce(m.rules -> 'confianca' ->> e.evidencia, '') in ('alta', 'media'),
               case when p.status = 'cancelado' then 'cancelado' when p.status = 'removido' then 'removido' when e.order_id is null then mo.reason end,
               now()
          from pedidos p
          cross join modelo m
          left join escolhida e on e.order_id = p.id
          left join motivo mo on mo.order_id = p.id
        on conflict (order_id, model_id) do update
           set run_id = excluded.run_id, status = excluded.status, provider = excluded.provider,
               campaign_id = excluded.campaign_id, ad_id = excluded.ad_id, evidence = excluded.evidence,
               confidence = excluded.confidence, touchpoint_id = excluded.touchpoint_id,
               campaign_coupon_id = excluded.campaign_coupon_id, touch_at = excluded.touch_at,
               window_days = excluded.window_days, counted = excluded.counted, reason = excluded.reason,
               computed_at = excluded.computed_at
        returning status
      )
      select status, count(*)::text as n from gravados group by status`);
    for (const row of r.rows) {
      const n = Number(row.n);
      total.considerados += n;
      if (row.status === 'atribuido') total.atribuidos += n;
      else if (row.status === 'plataforma') total.plataforma += n;
      else total.semOrigem += n;
    }
  }

  await tx.execute(sql`
    update liame.attribution_run
       set orders_considered = ${total.considerados}, attributed = ${total.atribuidos},
           platform_only = ${total.plataforma}, without_origin = ${total.semOrigem}, finished_at = now()
     where id = ${runId}`);
  return total;
}

/**
 * Pedidos que um toque novo ou alterado pode mudar: o pedido do clique e, para a conversa, os pedidos do
 * mesmo cliente confirmados até 90 dias depois dela (a maior janela que um modelo aceita).
 */
export async function pedidosDosToques(tx: Tx, tenantId: string, touchpointIds: string[]): Promise<string[]> {
  if (!touchpointIds.length) return [];
  const r = await tx.execute<{ id: string }>(sql`
    with t as (
      select * from liame.touchpoint
       where tenant_id = ${tenantId} and id in (select value::uuid from jsonb_array_elements_text(${JSON.stringify(touchpointIds)}::jsonb))
    )
    select o.id from t join liame.order_fact o
      on t.kind = 'clique' and o.connected_account_id = t.connected_account_id and o.external_id = t.order_external_id
    union
    select o.id from t join liame.order_fact o
      on t.kind = 'conversa' and o.tenant_id = t.tenant_id and o.customer_ref_id = t.customer_ref_id
     and o.confirmed_at >= t.occurred_at and o.confirmed_at < t.occurred_at + interval '90 days'`);
  return r.rows.map((x) => x.id);
}

/** Pedidos com o código de um cupom ligado (ou desligado) de uma campanha, desde o início da ligação. */
export async function pedidosDoCupomDeCampanha(tx: Tx, tenantId: string, campaignCouponIds: string[]): Promise<string[]> {
  if (!campaignCouponIds.length) return [];
  const r = await tx.execute<{ id: string }>(sql`
    select distinct o.id
      from liame.campaign_coupon cc
      join liame.coupon cp on cp.id = cc.coupon_id
      join liame.order_fact o on o.connected_account_id = cp.connected_account_id and o.coupon_code = cp.code
     where cc.tenant_id = ${tenantId} and o.confirmed_at >= cc.linked_at
       and cc.id in (select value::uuid from jsonb_array_elements_text(${JSON.stringify(campaignCouponIds)}::jsonb))`);
  return r.rows.map((x) => x.id);
}

/**
 * Pedidos que um cupom novo ou alterado pode mudar — o cupom que chega depois dos pedidos que o citam: os do
 * código dele, por cada ligação do cupom com uma campanha (`pedidosDoCupomDeCampanha`). Cupom sem ligação não
 * é evidência de nada (ADR-020) e não muda pedido nenhum.
 */
export async function pedidosDosCupons(tx: Tx, tenantId: string, couponIds: string[]): Promise<string[]> {
  if (!couponIds.length) return [];
  const r = await tx.execute<{ id: string }>(sql`
    select cc.id from liame.campaign_coupon cc
     where cc.tenant_id = ${tenantId}
       and cc.coupon_id in (select value::uuid from jsonb_array_elements_text(${JSON.stringify(couponIds)}::jsonb))`);
  return pedidosDoCupomDeCampanha(tx, tenantId, r.rows.map((x) => x.id));
}

/** Pedidos da empresa confirmados desde um instante (recálculo do período: campanha nova sincronizada, gclid resolvido). */
export async function pedidosDesde(tx: Tx, tenantId: string, desde: Date): Promise<string[]> {
  const r = await tx.execute<{ id: string }>(sql`
    select id from liame.order_fact where tenant_id = ${tenantId} and confirmed_at >= ${desde.toISOString()}::timestamptz`);
  return r.rows.map((x) => x.id);
}
