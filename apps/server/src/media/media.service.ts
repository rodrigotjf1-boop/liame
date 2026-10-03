import type { AccountFreshness, MediaAttentionResponse, MediaFreshnessResponse, MediaMetricsQuery, MediaMetricsResponse } from '@liame/contracts';
import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { currentTx } from '../context/request-context.js';
import { AppProblem } from '../errors/problems.js';
import { campanhaParou, gastoForaDoNormal, type ItemAtencao, nomePlataforma, ordenar } from './atencao.js';
import { frescor } from './frescor.js';
import { hojeNoFuso } from './sincronizador.js';

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

/** Entrega de uma campanha no período: somas das métricas que somam entre dias, e as razões calculadas aqui. */
export type EntregaDaCampanha = {
  campaign_id: string;
  provider: string;
  name: string;
  status: string;
  currency: string | null;
  /** Na moeda da conta, com duas casas ("1250.00"); nulo sem leitura da métrica no período. */
  spend: string | null;
  impressions: string | null;
  clicks: string | null;
  /** Só a Meta separa o clique no link dos demais cliques. */
  link_clicks: string | null;
  /** Cliques ÷ impressões, em %, com duas casas. */
  ctr_pct: string | null;
  /** Investimento ÷ cliques. */
  cpc: string | null;
  /** Investimento ÷ impressões × 1000. */
  cpm: string | null;
};

export type EntregaDoDia = { date: string; currency: string | null; spend: string | null; impressions: string | null; clicks: string | null };

export interface EntregaDeMidia {
  from: string;
  to: string;
  /** As de maior investimento primeiro; no máximo `ENTREGA_CAMPANHAS_MAXIMO`. */
  campaigns: EntregaDaCampanha[];
  days: EntregaDoDia[];
}

export const ENTREGA_CAMPANHAS_MAXIMO = 30;

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

  /**
   * Entrega por campanha e por dia (A3, I2): investimento, impressões e cliques somados no período, com
   * CTR, custo por clique e custo por mil impressões calculados aqui (a IA recebe o número pronto). Só
   * métricas que somam entre dias e sem janela de atribuição; o que depende de janela (conversões, valor)
   * está nos resultados do ciclo fechado. A Meta é lida por anúncio e sobe para a campanha; o Google Ads já
   * vem por campanha (o mesmo corte dos resultados).
   */
  async entrega(q: { brand_id?: string | undefined; from: string; to: string }): Promise<EntregaDeMidia> {
    const dias = (Date.parse(`${q.to}T00:00:00Z`) - Date.parse(`${q.from}T00:00:00Z`)) / 86_400_000 + 1;
    if (!(dias >= 1 && dias <= MAX_DIAS)) {
      throw new AppProblem(422, 'periodo-invalido', 'Período inválido', `O período vai de 1 a ${MAX_DIAS} dias, com o início antes do fim.`);
    }
    const tx = currentTx();
    const pontos = sql`
      select coalesce(g.campaign_id, cd.id) as campaign_id, ml.metric_date, ml.metric_name, ml.metric_value, a.currency
        from liame.metric_latest ml
        join liame.connected_account a on a.id = ml.connected_account_id and a.disconnected_at is null
        left join liame.ad an on ml.level = 'ad' and an.id = ml.entity_id
        left join liame.ad_group g on g.id = an.ad_group_id
        left join liame.campaign cd on ml.level = 'campaign' and cd.id = ml.entity_id
       where ml.metric_date between ${q.from}::date and ${q.to}::date
         and ((a.provider = 'meta_ads' and ml.level = 'ad') or (a.provider = 'google_ads' and ml.level = 'campaign'))
         and ml.attribution_window = '' and ml.metric_name in ('spend', 'impressions', 'clicks', 'link_clicks')
         ${q.brand_id ? sql`and ml.brand_id = ${q.brand_id}` : sql``}`;
    const soma = (metrica: string) => sql`sum(p.metric_value) filter (where p.metric_name = ${metrica})`;
    const campanhas = await tx.execute<EntregaDaCampanha>(sql`
      select c.id as campaign_id, c.provider, c.name, c.status, max(p.currency) as currency,
             round(${soma('spend')}, 2)::text as spend,
             round(${soma('impressions')})::text as impressions,
             round(${soma('clicks')})::text as clicks,
             round(${soma('link_clicks')})::text as link_clicks,
             round(${soma('clicks')} / nullif(${soma('impressions')}, 0) * 100, 2)::text as ctr_pct,
             round(${soma('spend')} / nullif(${soma('clicks')}, 0), 2)::text as cpc,
             round(${soma('spend')} / nullif(${soma('impressions')}, 0) * 1000, 2)::text as cpm
        from (${pontos}) p join liame.campaign c on c.id = p.campaign_id
       group by c.id, c.provider, c.name, c.status
       order by ${soma('spend')} desc nulls last, c.name, c.id
       limit ${ENTREGA_CAMPANHAS_MAXIMO}`);
    const porDia = await tx.execute<EntregaDoDia>(sql`
      select p.metric_date::text as date, p.currency,
             round(${soma('spend')}, 2)::text as spend,
             round(${soma('impressions')})::text as impressions,
             round(${soma('clicks')})::text as clicks
        from (${pontos}) p
       group by p.metric_date, p.currency
       order by p.metric_date, p.currency`);
    return { from: q.from, to: q.to, campaigns: campanhas.rows, days: porDia.rows };
  }

  /**
   * "Atenção de mídia": o que precisa de alguém agora, calculado na hora sobre os dados da empresa
   * (A2, G9). Conta que não lê, dado atrasado, autorização perto de vencer, gasto fora do normal,
   * campanha que parou de entregar e versão de API que a plataforma vai desligar.
   */
  async atencao(brandId: string | undefined, agora = new Date()): Promise<MediaAttentionResponse> {
    const tx = currentTx();
    const marca = brandId ? sql`and a.brand_id = ${brandId}` : sql``;
    const contas = await tx.execute<{
      id: string;
      brand_id: string;
      name: string;
      provider: string;
      currency: string | null;
      timezone: string | null;
      status: string;
      status_reason: string | null;
      last_success_at: Date | string | null;
      expected_every_minutes: number | null;
      refresh_expires_at: Date | string | null;
      connection_id: string | null;
      connection_provider: string | null;
    }>(sql`
      select a.id, a.brand_id, a.name, a.provider, a.currency, a.timezone, a.status, a.status_reason, s.last_success_at, s.expected_every_minutes, c.refresh_expires_at,
             a.connection_id, c.provider as connection_provider
        from liame.connected_account a
        left join liame.sync_state s on s.connected_account_id = a.id and s.dataset = 'metricas'
        left join liame.oauth_connection c on c.id = a.connection_id
       where a.disconnected_at is null and a.provider in ('meta_ads', 'google_ads', 'ga4') ${marca}
       order by a.name, a.id`);

    const itens: ItemAtencao[] = [];
    const frescas = new Map<string, (typeof contas.rows)[number]>();
    // Autorização perto de vencer: um aviso por autorização (o Google cobre Ads e GA4), não um por conta.
    const vencendo = new Map<string, { vence: number; provider: string; contas: number }>();
    for (const c of contas.rows) {
      const plataforma = nomePlataforma(c.provider);
      const base = { connected_account_id: c.id, campaign_id: null, provider: c.provider };
      if (c.status === 'desconectada') {
        itens.push({ ...base, kind: 'conta_desconectada', severity: 'critica', title: `${c.name} está desconectada`, detail: c.status_reason ?? `A ${plataforma} recusou a autorização.`, action: `Conecte o ${plataforma} de novo em Contas conectadas.` });
        continue;
      }
      if (c.status === 'sem_permissao') {
        itens.push({ ...base, kind: 'conta_sem_permissao', severity: 'atencao', title: `Sem permissão para ler ${c.name}`, detail: c.status_reason ?? 'Falta permissão na plataforma.', action: `Peça a quem administra a conta no ${plataforma} para liberar o acesso de leitura.` });
        continue;
      }
      if (c.status === 'erro') {
        itens.push({ ...base, kind: 'conta_com_erro', severity: 'atencao', title: `A leitura de ${c.name} está falhando`, detail: c.status_reason ?? 'A última leitura falhou.', action: 'Nada a fazer por enquanto: tentamos de novo sozinhos. Se continuar amanhã, fale com o suporte.' });
      }
      const f = frescor({ lastSuccessAt: c.last_success_at, expectedEveryMinutes: c.expected_every_minutes ?? 1440 }, agora);
      if (f === 'delayed' || f === 'stale') {
        const quando = c.last_success_at ? new Date(c.last_success_at).toLocaleString('pt-BR', { timeZone: c.timezone ?? 'America/Sao_Paulo', dateStyle: 'short', timeStyle: 'short' }) : 'nunca';
        itens.push({ ...base, kind: 'dado_atrasado', severity: f === 'stale' ? 'critica' : 'atencao', title: `Os números de ${c.name} estão atrasados`, detail: `Última leitura completa: ${quando}.`, action: 'Os números desta conta podem não refletir hoje; confira na plataforma antes de decidir.' });
      } else if (f === 'fresh' && c.status === 'ativa') {
        frescas.set(c.id, c);
      }
      if (c.refresh_expires_at && c.connection_id) {
        const vence = new Date(c.refresh_expires_at).getTime();
        if (vence > agora.getTime() && vence - agora.getTime() <= 2 * 86_400_000) {
          const atual = vencendo.get(c.connection_id);
          vencendo.set(c.connection_id, { vence, provider: c.connection_provider ?? c.provider, contas: (atual?.contas ?? 0) + 1 });
        }
      }
    }
    for (const v of vencendo.values()) {
      const quem = v.provider === 'meta' ? 'da Meta' : 'do Google';
      const contasTxt = v.contas === 1 ? '1 conta para de ler' : `${v.contas} contas param de ler`;
      itens.push({
        kind: 'reconectar_em_breve',
        severity: 'atencao',
        title: `A autorização ${quem} vence logo`,
        detail: `Vence em ${new Date(v.vence).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', dateStyle: 'short', timeStyle: 'short' })}; depois disso, ${contasTxt}.`,
        action: 'Conecte de novo em Contas conectadas para a leitura não parar.',
        connected_account_id: null,
        campaign_id: null,
        provider: v.provider,
      });
    }

    // Gasto e entrega só nas contas com dado fresco (sem leitura de ontem, não há o que comparar).
    if (frescas.size) {
      const ids = [...frescas.keys()];
      // Recorte pelo relógio da operação, não pelo current_date do banco (V34).
      const diaDeReferencia = agora.toISOString().slice(0, 10);
      const gastos = await tx.execute<{ conta: string; dia: string; valor: string }>(sql`
        select l.connected_account_id as conta, l.metric_date::text as dia, sum(l.metric_value)::text as valor
          from liame.metric_latest l join liame.connected_account a on a.id = l.connected_account_id
         where l.connected_account_id in ${ids} and l.metric_name = 'spend' and l.attribution_window = ''
           and l.metric_date >= ${diaDeReferencia}::date - 17
           and ((a.provider = 'google_ads' and l.level = 'campaign') or (a.provider = 'meta_ads' and l.level = 'ad'))
         group by 1, 2`);
      const porConta = new Map<string, Map<string, number>>();
      for (const g of gastos.rows) {
        if (!porConta.has(g.conta)) porConta.set(g.conta, new Map());
        porConta.get(g.conta)!.set(g.dia, Number(g.valor));
      }
      for (const [id, dias] of porConta) {
        const c = frescas.get(id)!;
        const ontem = new Date(Date.parse(`${hojeNoFuso(agora, c.timezone)}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
        const item = gastoForaDoNormal({ id, name: c.name, provider: c.provider, currency: c.currency }, dias, ontem);
        if (item) itens.push(item);
      }

      const impressoes = await tx.execute<{ campanha: string; nome: string; conta: string; provider: string; dia: string; valor: string }>(sql`
        select c.id as campanha, c.name as nome, c.connected_account_id as conta, c.provider, x.dia, sum(x.valor)::text as valor from (
          select g.campaign_id, l.metric_date::text as dia, l.metric_value as valor
            from liame.metric_latest l
            join liame.ad on ad.id = l.entity_id
            join liame.ad_group g on g.id = ad.ad_group_id
           where l.connected_account_id in ${ids} and l.level = 'ad' and l.provider = 'meta_ads' and l.metric_name = 'impressions'
             and l.metric_date >= ${diaDeReferencia}::date - 10
          union all
          select l.entity_id, l.metric_date::text, l.metric_value
            from liame.metric_latest l
           where l.connected_account_id in ${ids} and l.level = 'campaign' and l.provider = 'google_ads' and l.metric_name = 'impressions'
             and l.metric_date >= ${diaDeReferencia}::date - 10
        ) x join liame.campaign c on c.id = x.campaign_id
         where c.status = 'ativa'
         group by 1, 2, 3, 4, 5`);
      const porCampanha = new Map<string, { nome: string; conta: string; provider: string; dias: Map<string, number> }>();
      for (const i of impressoes.rows) {
        if (!porCampanha.has(i.campanha)) porCampanha.set(i.campanha, { nome: i.nome, conta: i.conta, provider: i.provider, dias: new Map() });
        porCampanha.get(i.campanha)!.dias.set(i.dia, Number(i.valor));
      }
      for (const [id, c] of porCampanha) {
        const conta = frescas.get(c.conta)!;
        const ontem = new Date(Date.parse(`${hojeNoFuso(agora, conta.timezone)}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
        const item = campanhaParou({ id, name: c.nome, connectedAccountId: c.conta, provider: c.provider }, c.dias, ontem);
        if (item) itens.push(item);
      }
    }

    // Versão de API que a plataforma vai desligar (Vigia): só das plataformas que a empresa usa. O Liame migra.
    const provedores = [...new Set(contas.rows.map((c) => c.provider))];
    if (provedores.length) {
      const versoes = await tx.execute<{ provider: string; api_version: string; kind: string; due_date: string | null }>(sql`
        select distinct on (provider, api_version) provider, api_version, kind, due_date::text as due_date
          from liame.watch_alert
         where resolved_at is null and kind in ('versao_expirando', 'versao_expirada') and provider in ${provedores}
         order by provider, api_version, created_at desc`);
      for (const v of versoes.rows) {
        const data = v.due_date ? `${v.due_date.slice(8, 10)}/${v.due_date.slice(5, 7)}/${v.due_date.slice(0, 4)}` : 'em breve';
        itens.push({
          kind: 'versao_api',
          severity: 'info',
          title: `A ${nomePlataforma(v.provider)} ${v.kind === 'versao_expirada' ? 'desligou' : 'vai desligar'} a versão ${v.api_version} da API`,
          detail: `Data de fim: ${data}.`,
          action: 'Nada a fazer: o Liame atualiza a integração antes.',
          connected_account_id: null,
          campaign_id: null,
          provider: v.provider,
        });
      }
    }
    // A marca de cada aviso é a da conta dele: é com ela que a tela pede a explicação (I4). O aviso da
    // autorização (que pode cobrir contas de várias marcas) e o da versão de API não têm marca.
    const marcaDaConta = new Map(contas.rows.map((c) => [c.id, c.brand_id]));
    return {
      items: ordenar(itens).map((i) => ({ ...i, brand_id: i.connected_account_id ? (marcaDaConta.get(i.connected_account_id) ?? null) : null })),
      generated_at: agora.toISOString(),
    };
  }
}
