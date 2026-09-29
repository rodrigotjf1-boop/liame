import type { CampaignResult, ClosedLoopQuery, ClosedLoopResponse, OrderOriginQuery, OrderOriginResponse, PlatformReport, SourceFreshness } from '@liame/contracts';
import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { MODELO_PADRAO } from '../attribution/motor.js';
import { currentTx } from '../context/request-context.js';
import { AppProblem } from '../errors/problems.js';
import { frescor } from '../media/frescor.js';

// Resultados do ciclo fechado (A2.5, F8; ADR-020, D-A2.5-6 a 8). Tudo na transação da requisição, sob
// a RLS da empresa, em poucas consultas de conjunto. O gasto e o que a plataforma informa vêm das métricas
// da A2 (cada plataforma com a janela dela); pedidos, receita e margem vêm do caixa do Regem, pelo dia do
// faturamento no fuso da loja. Dinheiro em micros com BigInt, nunca ponto flutuante.

/** Um trimestre por consulta, como as métricas de mídia. */
const MAX_DIAS = 92;
const FUSO_PADRAO = 'America/Sao_Paulo';
/** "Dá lucro / dá prejuízo" só com a margem conhecida em pelo menos 80% da receita confirmada (D-A2.5-7). */
const COBERTURA_MINIMA_POR_MIL = 800n;

/** Janela de cada plataforma na comparação: a Meta com 7 dias do clique (a do modelo); o Google, a da ação de conversão. */
const JANELA_PLATAFORMA: Record<string, string> = { meta_ads: '7d_click', google_ads: 'padrao' };

type Acumulado = { spend: bigint; value: bigint | null; conversions: bigint | null; conversations: bigint | null };
type Confirmado = { orders: number; revenue: bigint; margin: bigint; revenueWithMargin: bigint; marginOrders: number };

const zeroConfirmado = (): Confirmado => ({ orders: 0, revenue: 0n, margin: 0n, revenueWithMargin: 0n, marginOrders: 0 });

/** Razão com duas casas, arredondada para o mais próximo (metade para cima). */
export function razao(numerador: bigint, denominador: bigint): string | null {
  if (denominador <= 0n) return null;
  const negativo = numerador < 0n;
  const n = negativo ? -numerador : numerador;
  const centesimos = (n * 1000n / denominador + 5n) / 10n;
  const texto = `${centesimos / 100n}.${(centesimos % 100n).toString().padStart(2, '0')}`;
  return negativo && centesimos > 0n ? `-${texto}` : texto;
}

/** Porcentagem com uma casa ("83.4"), de 0 a 100. */
export function porcento(parte: bigint, todo: bigint): string | null {
  if (todo <= 0n) return null;
  const decimos = (parte * 10000n / todo + 5n) / 10n;
  const limitado = decimos > 1000n ? 1000n : decimos;
  return `${limitado / 10n}.${limitado % 10n}`;
}

const valorEmMicros = (texto: string | null | undefined): bigint | null => (texto === null || texto === undefined ? null : BigInt(texto));

function relatorioDaPlataforma(provider: string, a: Acumulado | undefined): PlatformReport {
  const spend = a?.spend ?? 0n;
  const value = a?.value ?? null;
  const conversas = a?.conversations ?? null;
  return {
    spend_micros: spend.toString(),
    value_micros: value === null ? null : value.toString(),
    roas: value === null ? null : razao(value, spend),
    window: JANELA_PLATAFORMA[provider] ?? 'padrao',
    conversions: a?.conversions === null || a?.conversions === undefined ? null : a.conversions.toString(),
    conversations: conversas === null ? null : conversas.toString(),
    cost_per_conversation_micros: conversas && conversas > 0n ? (spend / conversas).toString() : null,
  };
}

function resultadoConfirmado(c: Confirmado, spend: bigint) {
  return {
    orders: c.orders,
    revenue_micros: c.revenue.toString(),
    roas: razao(c.revenue, spend),
    cost_per_order_micros: c.orders > 0 && spend > 0n ? (spend / BigInt(c.orders)).toString() : null,
    margin_known_micros: c.marginOrders > 0 ? c.margin.toString() : null,
    margin_coverage_pct: porcento(c.revenueWithMargin, c.revenue),
  };
}

@Injectable()
export class ResultsService {
  async closedLoop(q: ClosedLoopQuery, agora = new Date()): Promise<ClosedLoopResponse> {
    const tx = currentTx();
    const { fuso, modelo } = await this.contexto(q);

    // 1. Mídia: gasto e o que a plataforma informa, por campanha, na janela de cada uma.
    const midia = await tx.execute<{ provider: string; campaign_id: string | null; metric_name: string; micros: string; bruto: string }>(sql`
      with contas as (
        select id, provider from liame.connected_account where brand_id = ${q.brand_id} and provider in ('meta_ads', 'google_ads')
      )
      select c.provider, coalesce(g.campaign_id, cd.id) as campaign_id, ml.metric_name,
             round(sum(ml.metric_value) * 1000000)::bigint::text as micros, sum(ml.metric_value)::text as bruto
        from liame.metric_latest ml
        join contas c on c.id = ml.connected_account_id
        left join liame.ad a on ml.level = 'ad' and a.id = ml.entity_id
        left join liame.ad_group g on g.id = a.ad_group_id
        left join liame.campaign cd on ml.level = 'campaign' and cd.id = ml.entity_id
       where ml.metric_date between ${q.from}::date and ${q.to}::date
         and ((c.provider = 'meta_ads' and ml.level = 'ad') or (c.provider = 'google_ads' and ml.level = 'campaign'))
         and ((ml.metric_name = 'spend' and ml.attribution_window = '')
           or (c.provider = 'meta_ads' and ml.attribution_window = '7d_click' and ml.metric_name in ('purchase_value', 'purchases', 'conversations_started'))
           or (c.provider = 'google_ads' and ml.attribution_window = 'padrao' and ml.metric_name in ('conversions_value', 'conversions')))
       group by 1, 2, 3`);
    const porProvider = new Map<string, Acumulado>();
    const porCampanha = new Map<string, Acumulado>();
    const acumular = (mapa: Map<string, Acumulado>, chave: string, nome: string, micros: bigint, bruto: string) => {
      const a = mapa.get(chave) ?? { spend: 0n, value: null, conversions: null, conversations: null };
      if (nome === 'spend') a.spend += micros;
      else if (nome === 'purchase_value' || nome === 'conversions_value') a.value = (a.value ?? 0n) + micros;
      else if (nome === 'purchases' || nome === 'conversions') a.conversions = (a.conversions ?? 0n) + BigInt(Math.round(Number(bruto)));
      else if (nome === 'conversations_started') a.conversations = (a.conversations ?? 0n) + BigInt(Math.round(Number(bruto)));
      mapa.set(chave, a);
    };
    const provedorDaCampanha = new Map<string, string>();
    for (const l of midia.rows) {
      const micros = BigInt(l.micros);
      acumular(porProvider, l.provider, l.metric_name, micros, l.bruto);
      if (l.campaign_id) {
        acumular(porCampanha, l.campaign_id, l.metric_name, micros, l.bruto);
        provedorDaCampanha.set(l.campaign_id, l.provider);
      }
    }

    // 2. Caixa: pedidos do período (dia do faturamento no fuso da loja), atribuição e margem.
    const caixa = await tx.execute<{
      status: string;
      channel_group: string;
      a_status: string | null;
      provider: string | null;
      campaign_id: string | null;
      counted: boolean | null;
      reason: string | null;
      n: string;
      receita: string;
      receita_bruta: string;
      margem: string | null;
      receita_com_margem: string;
      pedidos_com_margem: string;
    }>(sql`
      with pedidos as (
        select o.id, o.status, o.channel_group, o.revenue_micros, o.revenue_micros - o.refunded_micros as liquido
          from liame.order_fact o
         where o.brand_id = ${q.brand_id} ${q.unit_id ? sql`and o.unit_id = ${q.unit_id}` : sql``}
           and o.status <> 'removido'
           and coalesce(o.billed_at, o.confirmed_at) >= (${q.from}::date - 1)::timestamp at time zone ${fuso}
           and coalesce(o.billed_at, o.confirmed_at) < (${q.to}::date + 2)::timestamp at time zone ${fuso}
           and (coalesce(o.billed_at, o.confirmed_at) at time zone ${fuso})::date between ${q.from}::date and ${q.to}::date
      ),
      custos as (
        select i.order_id, sum(i.cost_micros) as custo, bool_and(i.cost_known) as conhecido, count(*) as n
          from liame.order_item_fact i join pedidos p on p.id = i.order_id
         where i.removed_at is null
         group by 1
      ),
      base as (
        select p.*, r.status as a_status, r.provider, r.campaign_id, r.counted, r.reason,
               case when c.conhecido and c.n > 0 then p.liquido - c.custo end as margem
          from pedidos p
          left join liame.attribution_result r on r.order_id = p.id and r.model_id = ${modelo.id}
          left join custos c on c.order_id = p.id
      )
      select status, channel_group, a_status, provider, campaign_id, counted, reason, count(*)::text as n,
             sum(liquido)::text as receita, sum(revenue_micros)::text as receita_bruta, sum(margem)::text as margem,
             coalesce(sum(liquido) filter (where margem is not null), 0)::text as receita_com_margem,
             count(*) filter (where margem is not null)::text as pedidos_com_margem
        from base group by 1, 2, 3, 4, 5, 6, 7`);

    let pedidosConfirmados = 0;
    let receitaConfirmada = 0n;
    const confirmado = zeroConfirmado();
    const semOrigem = { orders: 0, revenue: 0n };
    const cancelados = { orders: 0, revenue: 0n };
    const semClique = new Map<string, { orders: number; revenue: bigint }>();
    const confirmadoPorCampanha = new Map<string, Confirmado>();
    const confirmadoPorProvider = new Map<string, Confirmado>();
    const soPlataforma = new Map<string, number>();
    const somar = (c: Confirmado, l: (typeof caixa.rows)[number]) => {
      c.orders += Number(l.n);
      c.revenue += BigInt(l.receita);
      c.margin += l.margem === null ? 0n : BigInt(l.margem);
      c.revenueWithMargin += BigInt(l.receita_com_margem);
      c.marginOrders += Number(l.pedidos_com_margem);
    };
    for (const l of caixa.rows) {
      if (l.status === 'cancelado') {
        cancelados.orders += Number(l.n);
        cancelados.revenue += BigInt(l.receita_bruta);
        continue;
      }
      pedidosConfirmados += Number(l.n);
      receitaConfirmada += BigInt(l.receita);
      if (l.counted) {
        somar(confirmado, l);
        if (l.provider) {
          const p = confirmadoPorProvider.get(l.provider) ?? zeroConfirmado();
          somar(p, l);
          confirmadoPorProvider.set(l.provider, p);
          if (l.a_status === 'plataforma') soPlataforma.set(l.provider, (soPlataforma.get(l.provider) ?? 0) + Number(l.n));
        }
        if (l.campaign_id) {
          const c = confirmadoPorCampanha.get(l.campaign_id) ?? zeroConfirmado();
          somar(c, l);
          confirmadoPorCampanha.set(l.campaign_id, c);
          if (l.provider) provedorDaCampanha.set(l.campaign_id, provedorDaCampanha.get(l.campaign_id) ?? l.provider);
        }
      } else if (l.reason === 'canal_sem_clique') {
        const s = semClique.get(l.channel_group) ?? { orders: 0, revenue: 0n };
        s.orders += Number(l.n);
        s.revenue += BigInt(l.receita);
        semClique.set(l.channel_group, s);
      } else {
        semOrigem.orders += Number(l.n);
        semOrigem.revenue += BigInt(l.receita);
      }
    }

    // 3. Campanhas: nome e situação das que gastaram ou venderam no período.
    const idsCampanhas = [...new Set([...porCampanha.keys(), ...confirmadoPorCampanha.keys()])];
    const campanhas = idsCampanhas.length
      ? (
          await tx.execute<{ id: string; name: string; status: string; provider: string }>(sql`
            select id, name, status, provider from liame.campaign where id in ${idsCampanhas}`)
        ).rows
      : [];
    const gastoTotal = [...porProvider.values()].reduce((s, a) => s + a.spend, 0n);
    const itensCampanha: CampaignResult[] = campanhas
      .map((c) => ({
        campaign_id: c.id,
        provider: c.provider,
        name: c.name,
        status: c.status,
        platform: relatorioDaPlataforma(c.provider, porCampanha.get(c.id)),
        confirmed: resultadoConfirmado(confirmadoPorCampanha.get(c.id) ?? zeroConfirmado(), porCampanha.get(c.id)?.spend ?? 0n),
      }))
      .sort((a, b) => Number(BigInt(b.platform.spend_micros) - BigInt(a.platform.spend_micros)) || a.name.localeCompare(b.name, 'pt-BR'));

    const provedores = [...new Set([...porProvider.keys(), ...confirmadoPorProvider.keys()])].sort();
    const cobertura = confirmado.revenue > 0n ? (confirmado.revenueWithMargin * 1000n) / confirmado.revenue : 0n;
    const veredito = confirmado.marginOrders > 0 && cobertura >= COBERTURA_MINIMA_POR_MIL ? (confirmado.margin - gastoTotal >= 0n ? 'lucro' : 'prejuizo') : null;

    return {
      period: { from: q.from, to: q.to, timezone: fuso, account_timezones: await this.fusosDasContas(q.brand_id) },
      model: modelo.resposta,
      currency: 'BRL',
      totals: {
        spend_micros: gastoTotal.toString(),
        orders_confirmed: pedidosConfirmados,
        revenue_micros: receitaConfirmada.toString(),
        confirmed: resultadoConfirmado(confirmado, gastoTotal),
        // A porcentagem é sobre os pedidos dos canais próprios com clique (cardápio e WhatsApp): os canais
        // sem clique ficam à parte e não entram na conta.
        without_origin: {
          orders: semOrigem.orders,
          revenue_micros: semOrigem.revenue.toString(),
          share_pct: porcento(BigInt(semOrigem.orders), BigInt(pedidosConfirmados - [...semClique.values()].reduce((n, x) => n + x.orders, 0))),
        },
        no_click_channels: [...semClique.entries()]
          .map(([channel_group, s]) => ({ channel_group, orders: s.orders, revenue_micros: s.revenue.toString() }))
          .sort((a, b) => a.channel_group.localeCompare(b.channel_group)),
        cancelled: { orders: cancelados.orders, revenue_micros: cancelados.revenue.toString() },
        verdict: veredito,
      },
      platforms: provedores.map((p) => ({
        provider: p,
        platform: relatorioDaPlataforma(p, porProvider.get(p)),
        confirmed: resultadoConfirmado(confirmadoPorProvider.get(p) ?? zeroConfirmado(), porProvider.get(p)?.spend ?? 0n),
        platform_only_orders: soPlataforma.get(p) ?? 0,
      })),
      campaigns: itensCampanha,
      sources: await this.fontes(q.brand_id, q.unit_id, agora),
      generated_at: agora.toISOString(),
    };
  }

  /** A origem de cada pedido do período (Pro): evidência, momento, janela e confiança; sem dado pessoal. */
  async orders(q: OrderOriginQuery): Promise<OrderOriginResponse> {
    const tx = currentTx();
    const { fuso, modelo } = await this.contexto(q);
    const r = await tx.execute<{
      id: string;
      external_id: string;
      channel: string;
      channel_group: string;
      status: string;
      confirmed_at: Date | string;
      liquido: string;
      margem: string | null;
      a_status: string | null;
      evidence: string | null;
      confidence: string | null;
      provider: string | null;
      campaign_id: string | null;
      campaign_name: string | null;
      ad_id: string | null;
      ad_name: string | null;
      touch_at: Date | string | null;
      window_days: number | null;
      counted: boolean | null;
      reason: string | null;
    }>(sql`
      with pedidos as (
        select o.* from liame.order_fact o
         where o.brand_id = ${q.brand_id} ${q.unit_id ? sql`and o.unit_id = ${q.unit_id}` : sql``}
           and o.status <> 'removido'
           and coalesce(o.billed_at, o.confirmed_at) >= (${q.from}::date - 1)::timestamp at time zone ${fuso}
           and coalesce(o.billed_at, o.confirmed_at) < (${q.to}::date + 2)::timestamp at time zone ${fuso}
           and (coalesce(o.billed_at, o.confirmed_at) at time zone ${fuso})::date between ${q.from}::date and ${q.to}::date
      )
      select p.id, p.external_id, p.channel, p.channel_group, p.status, p.confirmed_at,
             (p.revenue_micros - p.refunded_micros)::text as liquido,
             (select case when bool_and(i.cost_known) and count(*) > 0 then (p.revenue_micros - p.refunded_micros - sum(i.cost_micros))::text end
                from liame.order_item_fact i where i.order_id = p.id and i.removed_at is null) as margem,
             r.status as a_status, r.evidence, r.confidence, r.provider, r.campaign_id, c.name as campaign_name,
             r.ad_id, a.name as ad_name, r.touch_at, r.window_days, r.counted, r.reason
        from pedidos p
        left join liame.attribution_result r on r.order_id = p.id and r.model_id = ${modelo.id}
        left join liame.campaign c on c.id = r.campaign_id
        left join liame.ad a on a.id = r.ad_id
       where true ${q.campaign_id ? sql`and r.campaign_id = ${q.campaign_id}` : sql``}
             ${q.status ? sql`and coalesce(r.status, 'sem_origem') = ${q.status}` : sql``}
       order by p.confirmed_at desc, p.id
       limit ${q.limit}`);
    return {
      items: r.rows.map((l) => {
        const confirmado = new Date(l.confirmed_at);
        const toque = l.touch_at ? new Date(l.touch_at) : null;
        return {
          order_id: l.id,
          external_id: l.external_id,
          channel: l.channel,
          channel_group: l.channel_group,
          status: l.status,
          confirmed_at: confirmado.toISOString(),
          revenue_micros: l.liquido,
          margin_micros: l.margem,
          attribution: {
            status: l.a_status ?? 'sem_origem',
            evidence: l.evidence,
            confidence: l.confidence,
            provider: l.provider,
            campaign: l.campaign_id && l.campaign_name ? { id: l.campaign_id, name: l.campaign_name } : null,
            ad: l.ad_id && l.ad_name ? { id: l.ad_id, name: l.ad_name } : null,
            touch_at: toque?.toISOString() ?? null,
            hours_before: toque ? Math.round(((confirmado.getTime() - toque.getTime()) / 3_600_000) * 10) / 10 : null,
            window_days: l.window_days ?? modelo.resposta.window_days,
            counted: l.counted ?? false,
            reason: l.reason ?? (l.a_status ? null : 'sem_evidencia'),
          },
        };
      }),
    };
  }

  /** Marca da empresa, loja (se veio), fuso que corta o dia e o modelo de atribuição em uso. */
  private async contexto(q: { brand_id: string; unit_id?: string; from: string; to: string }) {
    if (q.from > q.to) throw new AppProblem(422, 'periodo-invalido', 'Período inválido', 'A data inicial vem depois da final.');
    const dias = (Date.parse(`${q.to}T00:00:00Z`) - Date.parse(`${q.from}T00:00:00Z`)) / 86_400_000 + 1;
    if (dias > MAX_DIAS) throw new AppProblem(422, 'periodo-longo', 'Período longo demais', `Escolha até ${MAX_DIAS} dias.`);
    const tx = currentTx();
    const marca = await tx.execute<{ fuso: string | null; unidade_ok: boolean }>(sql`
      select (select u.timezone from liame.unit u where u.brand_id = b.id ${q.unit_id ? sql`and u.id = ${q.unit_id}` : sql``} order by u.created_at, u.id limit 1) as fuso,
             ${q.unit_id ? sql`exists (select 1 from liame.unit u where u.id = ${q.unit_id} and u.brand_id = b.id)` : sql`true`} as unidade_ok
        from liame.brand b where b.id = ${q.brand_id} and b.archived_at is null`);
    const m = marca.rows[0];
    if (!m) throw new AppProblem(404, 'nao-encontrado', 'Não encontramos', 'Marca não encontrada nesta empresa.');
    if (!m.unidade_ok) throw new AppProblem(404, 'nao-encontrado', 'Não encontramos', 'Loja não encontrada nesta marca.');
    const mod = await tx.execute<{ id: string; key: string; version: number; window_days: number; conta_visualizacao: boolean }>(sql`
      select id, key, version, window_days, coalesce((rules->>'conta_visualizacao')::boolean, false) as conta_visualizacao
        from liame.attribution_model where id = ${MODELO_PADRAO}`);
    const modelo = mod.rows[0];
    if (!modelo) throw new Error('modelo de atribuição padrão fora do banco');
    return {
      fuso: m.fuso ?? FUSO_PADRAO,
      modelo: { id: modelo.id, resposta: { id: modelo.id, key: modelo.key, version: modelo.version, window_days: modelo.window_days, counts_views: modelo.conta_visualizacao } },
    };
  }

  private async fusosDasContas(brandId: string): Promise<string[]> {
    const r = await currentTx().execute<{ timezone: string }>(sql`
      select distinct timezone from liame.connected_account
       where brand_id = ${brandId} and provider in ('meta_ads', 'google_ads') and disconnected_at is null and timezone is not null
       order by 1`);
    return r.rows.map((l) => l.timezone);
  }

  /** Frescor de cada fonte da tela: mídia pelas métricas, Regem pelos pedidos. */
  private async fontes(brandId: string, unitId: string | undefined, agora: Date): Promise<SourceFreshness[]> {
    const r = await currentTx().execute<{
      id: string;
      provider: string;
      name: string;
      status: string;
      timezone: string | null;
      dataset: string;
      last_success_at: Date | string | null;
      expected_every_minutes: number | null;
    }>(sql`
      select a.id, a.provider, a.name, a.status, a.timezone,
             case when a.provider in ('regem', 'regemcast') then 'pedidos' else 'metricas' end as dataset,
             s.last_success_at, s.expected_every_minutes
        from liame.connected_account a
        left join liame.sync_state s on s.connected_account_id = a.id
             and s.dataset = case when a.provider in ('regem', 'regemcast') then 'pedidos' else 'metricas' end
       where a.brand_id = ${brandId} and a.disconnected_at is null and a.provider in ('meta_ads', 'google_ads', 'regem', 'regemcast')
             ${unitId ? sql`and (a.provider not in ('regem', 'regemcast') or a.unit_id = ${unitId})` : sql``}
       order by a.provider, a.name, a.id`);
    return r.rows.map((l) => ({
      connected_account_id: l.id,
      provider: l.provider,
      name: l.name,
      dataset: l.dataset,
      freshness: l.expected_every_minutes ? frescor({ lastSuccessAt: l.last_success_at, expectedEveryMinutes: l.expected_every_minutes }, agora) : 'unknown',
      last_success_at: l.last_success_at ? new Date(l.last_success_at).toISOString() : null,
      status: l.status,
      timezone: l.timezone,
    }));
  }
}
