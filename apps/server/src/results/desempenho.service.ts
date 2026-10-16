import type { AdDeliveryCampaign, AdDeliveryQuery, AdDeliveryRefreshRequest, AdDeliveryRefreshResponse, AdDeliveryResponse } from '@liame/contracts';
import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { RateLimitService } from '../auth/rate-limit.service.js';
import { metricaDoPeriodo } from '../connectors/alcance-do-periodo.js';
import type { AuthContext } from '../context/request-context.js';
import { currentTx } from '../context/request-context.js';
import { AppProblem } from '../errors/problems.js';
import { FlagService } from '../flags/flag.service.js';
import { hojeNoFuso } from '../media/sincronizador.js';

// Como os anúncios rodaram (P23, aprovado pelo dono em 16/10/2026): o que a Meta e o Google informam da entrega, por
// campanha (impressões, alcance, cliques, gasto e o resultado que a plataforma conta), e o "Ler agora", que adianta a
// leitura das contas de anúncio da marca. O gasto sai das mesmas contas e da mesma métrica de `closed-loop` (os dois
// cartões de Resultados mostram o mesmo número). Tudo na transação da requisição, sob a RLS da empresa.

export const FLAG_DESEMPENHO = 'desempenho_anuncios';
/** "Ler agora": uma vez por janela de 15 minutos por empresa. */
export const LER_AGORA_JANELA_S = 900;
const MAX_DIAS = 92;
const FUSO_PADRAO = 'America/Sao_Paulo';

/** A vez do "Ler agora" é da empresa: sem empresa na sessão, não há vez (a rota exige uma, pela permissão). */
function chaveDoLerAgora(tenantId: string | null): string {
  if (!tenantId) throw new AppProblem(403, 'sem-empresa', 'Sem empresa', 'Esta sessão não está numa empresa.');
  return `ler-agora:${tenantId}`;
}
const micros = (v: string | null) => (v == null ? '0' : v);

type LinhaCampanha = {
  campaign_id: string;
  provider: string;
  name: string;
  status: string;
  objective: string | null;
  impressions: string | null;
  clicks: string | null;
  link_clicks: string | null;
  spend_micros: string | null;
  purchases: string | null;
  conversations: string | null;
  conversions: string | null;
  reach: string | null;
};

/** O resultado que a plataforma conta para a campanha: compras ou conversas (Meta, 7 dias do clique), conversões (Google). */
export function resultadoDaCampanha(l: Pick<LinhaCampanha, 'provider' | 'objective' | 'purchases' | 'conversations' | 'conversions'>): AdDeliveryCampaign['result'] {
  if (l.provider === 'google_ads') return l.conversions == null ? null : { kind: 'conversions', value: duasCasas(l.conversions), window: 'padrao' };
  if (l.provider !== 'meta_ads') return null;
  const compras = Number(l.purchases ?? 0);
  const conversas = Number(l.conversations ?? 0);
  if (l.purchases == null && l.conversations == null) return null;
  // A de mensagem conta conversas; a de venda ou de tráfego, compras. Sem nenhum dos dois no período, pelo objetivo.
  const mensagem = conversas > compras || (compras === 0 && conversas === 0 && /ENGAGEMENT|MESSAGES/i.test(l.objective ?? ''));
  return mensagem ? { kind: 'conversations', value: String(Math.round(conversas)), window: '7d_click' } : { kind: 'purchases', value: String(Math.round(compras)), window: '7d_click' };
}

/** Até duas casas, sem zero à direita ("12", "3.5", "0.33"). */
function duasCasas(v: string): string {
  const n = Math.round(Number(v) * 100) / 100;
  return Number.isFinite(n) && n >= 0 ? String(n) : '0';
}

@Injectable()
export class DesempenhoService {
  constructor(
    private readonly flags: FlagService,
    private readonly limite: RateLimitService,
  ) {}

  private async ligada(auth: AuthContext, brandId: string): Promise<boolean> {
    return this.flags.isEnabled(FLAG_DESEMPENHO, this.flags.context({ tenantId: auth.tenantId, userId: auth.userId, brandId }));
  }

  async ler(auth: AuthContext, q: AdDeliveryQuery, agora = new Date()): Promise<AdDeliveryResponse> {
    const dias = (Date.parse(`${q.to}T00:00:00Z`) - Date.parse(`${q.from}T00:00:00Z`)) / 86_400_000 + 1;
    if (!(dias >= 1 && dias <= MAX_DIAS)) {
      throw new AppProblem(422, 'periodo-invalido', 'Período inválido', `O período vai de 1 a ${MAX_DIAS} dias, com o início antes do fim.`);
    }
    const vazio: AdDeliveryResponse = {
      enabled: false,
      period: { from: q.from, to: q.to },
      accounts: [],
      totals: { impressions: '0', clicks: '0', spend_micros: '0', meta_reach: null },
      campaigns: [],
      refresh: { available: false, next_at: null },
    };
    const tx = currentTx();
    const marca = await tx.execute<{ id: string }>(sql`select id from liame.brand where id = ${q.brand_id} and archived_at is null`);
    if (!marca.rows[0]) throw new AppProblem(404, 'nao-encontrado', 'Não encontramos', 'Marca não encontrada nesta empresa.');
    if (!(await this.ligada(auth, q.brand_id))) return vazio;

    // As contas de anúncio da marca: as mesmas de `closed-loop` (as desligadas entram pelo gasto que já leram).
    const contas = await tx.execute<{ id: string; provider: string; name: string; status: string; timezone: string | null; disconnected: boolean; last_success_at: Date | string | null; last_attempt_at: Date | string | null; last_error: string | null }>(sql`
      select a.id, a.provider, a.name, a.status, a.timezone, a.disconnected_at is not null as disconnected, s.last_success_at, s.last_attempt_at, s.last_error
        from liame.connected_account a
        left join liame.sync_state s on s.connected_account_id = a.id and s.dataset = 'metricas'
       where a.brand_id = ${q.brand_id} and a.provider in ('meta_ads', 'google_ads')
       order by a.provider, a.name, a.id`);
    const fusoDaMeta = contas.rows.find((c) => c.provider === 'meta_ads' && !c.disconnected)?.timezone ?? FUSO_PADRAO;
    const alcance = metricaDoPeriodo(q.from, q.to, hojeNoFuso(agora, fusoDaMeta));

    // Por campanha: a Meta lida por anúncio (sobe para a campanha pelo grupo) e o Google pela campanha, como `closed-loop`.
    const campanhas = await tx.execute<LinhaCampanha>(sql`
      with contas as (
        select id, provider from liame.connected_account where brand_id = ${q.brand_id} and provider in ('meta_ads', 'google_ads')
      ),
      pontos as (
        select coalesce(g.campaign_id, cd.id) as campaign_id, ml.metric_name, ml.attribution_window, ml.metric_value
          from liame.metric_latest ml
          join contas c on c.id = ml.connected_account_id
          left join liame.ad an on ml.level = 'ad' and an.id = ml.entity_id
          left join liame.ad_group g on g.id = an.ad_group_id
          left join liame.campaign cd on ml.level = 'campaign' and cd.id = ml.entity_id
         where ml.metric_date between ${q.from}::date and ${q.to}::date
           and ((c.provider = 'meta_ads' and ml.level = 'ad') or (c.provider = 'google_ads' and ml.level = 'campaign'))
           and ((ml.attribution_window = '' and ml.metric_name in ('spend', 'impressions', 'clicks', 'link_clicks'))
             or (c.provider = 'meta_ads' and ml.attribution_window = '7d_click' and ml.metric_name in ('purchases', 'conversations_started'))
             or (c.provider = 'google_ads' and ml.attribution_window = 'padrao' and ml.metric_name = 'conversions'))
      ),
      alcance as (
        select ml.entity_id as campaign_id, sum(ml.metric_value) as reach
          from liame.metric_latest ml
          join contas c on c.id = ml.connected_account_id and c.provider = 'meta_ads'
         where ${alcance ? sql`ml.level = 'campaign' and ml.metric_name = ${alcance.metrica} and ml.metric_date = ${alcance.dia}::date and ml.attribution_window = ''` : sql`false`}
         group by 1
      )
      select ca.id as campaign_id, ca.provider, ca.name, ca.status, ca.objective,
             round(sum(p.metric_value) filter (where p.metric_name = 'impressions'))::text as impressions,
             round(sum(p.metric_value) filter (where p.metric_name = 'clicks'))::text as clicks,
             round(sum(p.metric_value) filter (where p.metric_name = 'link_clicks'))::text as link_clicks,
             round(sum(p.metric_value) filter (where p.metric_name = 'spend') * 1000000)::bigint::text as spend_micros,
             sum(p.metric_value) filter (where p.metric_name = 'purchases')::text as purchases,
             sum(p.metric_value) filter (where p.metric_name = 'conversations_started')::text as conversations,
             sum(p.metric_value) filter (where p.metric_name = 'conversions')::text as conversions,
             round(max(r.reach))::text as reach
        from pontos p
        join liame.campaign ca on ca.id = p.campaign_id
        left join alcance r on r.campaign_id = ca.id
       group by ca.id, ca.provider, ca.name, ca.status, ca.objective
       order by sum(p.metric_value) filter (where p.metric_name = 'spend') desc nulls last, ca.name, ca.id`);

    // O alcance pela conta (pessoas diferentes na Meta no período): uma linha por conta da Meta da marca.
    const daConta = alcance
      ? await tx.execute<{ reach: string | null }>(sql`
          select round(sum(ml.metric_value))::text as reach
            from liame.metric_latest ml
            join liame.connected_account a on a.id = ml.connected_account_id and a.brand_id = ${q.brand_id} and a.provider = 'meta_ads'
           where ml.level = 'account' and ml.metric_name = ${alcance.metrica} and ml.metric_date = ${alcance.dia}::date and ml.attribution_window = ''`)
      : null;

    const lista: AdDeliveryCampaign[] = campanhas.rows
      .filter((l) => Number(l.impressions ?? 0) > 0 || Number(l.spend_micros ?? 0) > 0)
      .map((l) => ({
        campaign_id: l.campaign_id,
        provider: l.provider,
        name: l.name,
        status: l.status,
        objective: l.objective,
        impressions: l.impressions ?? '0',
        reach: l.provider === 'meta_ads' ? l.reach : null,
        clicks: l.clicks ?? '0',
        link_clicks: l.provider === 'meta_ads' ? (l.link_clicks ?? '0') : null,
        spend_micros: micros(l.spend_micros),
        result: resultadoDaCampanha(l),
      }));
    const soma = (f: (c: AdDeliveryCampaign) => string) => lista.reduce((a, c) => a + BigInt(f(c)), 0n).toString();
    const proxima = await this.limite.proximaVez(chaveDoLerAgora(auth.tenantId), 1, LER_AGORA_JANELA_S);
    const iso = (v: Date | string | null) => (v == null ? null : new Date(v).toISOString());
    return {
      enabled: true,
      period: { from: q.from, to: q.to },
      accounts: contas.rows
        .filter((c) => !c.disconnected)
        .map((c) => ({ connected_account_id: c.id, provider: c.provider, name: c.name, status: c.status, last_success_at: iso(c.last_success_at), last_attempt_at: iso(c.last_attempt_at), last_error: c.last_error })),
      totals: { impressions: soma((c) => c.impressions), clicks: soma((c) => c.clicks), spend_micros: soma((c) => c.spend_micros), meta_reach: daConta?.rows[0]?.reach ?? null },
      campaigns: lista,
      refresh: { available: proxima === null, next_at: proxima?.toISOString() ?? null },
    };
  }

  /**
   * "Ler agora": adianta a próxima leitura de cada conta de anúncio da marca (a Meta e o Google), que o worker pega em
   * até meio minuto. Uma vez por janela de 15 minutos por empresa. A conta que já está sendo lida fica como está (a
   * leitura em andamento termina com os números de agora). A próxima leitura de todo dia conta a partir desta.
   */
  async lerAgora(auth: AuthContext, body: AdDeliveryRefreshRequest, agora = new Date()): Promise<AdDeliveryRefreshResponse> {
    const tx = currentTx();
    const marca = await tx.execute<{ id: string }>(sql`select id from liame.brand where id = ${body.brand_id} and archived_at is null`);
    if (!marca.rows[0]) throw new AppProblem(404, 'nao-encontrado', 'Não encontramos', 'Marca não encontrada nesta empresa.');
    if (!(await this.ligada(auth, body.brand_id))) {
      throw new AppProblem(409, 'funcao-desligada', 'Função desligada', 'Como os anúncios rodaram não está ligado para esta empresa.');
    }
    const chave = chaveDoLerAgora(auth.tenantId);
    try {
      await this.limite.consume(chave, 1, LER_AGORA_JANELA_S);
    } catch (err) {
      if (!(err instanceof AppProblem) || err.code !== 'muitas-tentativas') throw err;
      const quando = (await this.limite.proximaVez(chave, 1, LER_AGORA_JANELA_S)) ?? new Date(agora.getTime() + LER_AGORA_JANELA_S * 1000);
      const espera = Math.max(1, Math.ceil((quando.getTime() - agora.getTime()) / 1000));
      throw new AppProblem(429, 'leitura-recente', 'Leitura recente', 'A Meta e o Google acabaram de ser lidos. Dá para ler de novo daqui a pouco.', { 'retry-after': String(espera) });
    }
    const contas = await tx.execute<{ id: string }>(sql`
      select a.id from liame.connected_account a
       where a.brand_id = ${body.brand_id} and a.provider in ('meta_ads', 'google_ads') and a.disconnected_at is null`);
    const ids = contas.rows.map((c) => c.id);
    if (ids.length) {
      // Só adianta (nunca adia), e não mexe na conta com uma leitura em andamento (o worker a pegaria duas vezes).
      await tx.execute(sql`
        update liame.sync_state s set cursor = s.cursor || jsonb_build_object('proxima', ${agora.toISOString()}::text), updated_at = now()
         where s.dataset = 'metricas' and s.connected_account_id in ${ids}
           and coalesce((s.cursor->>'proxima')::timestamptz, '-infinity'::timestamptz) > ${agora.toISOString()}::timestamptz
           and not exists (select 1 from liame.sync_run r where r.connected_account_id = s.connected_account_id and r.dataset = 'metricas'
                            and r.status = 'rodando' and r.started_at > ${agora.toISOString()}::timestamptz - interval '30 minutes')`);
    }
    const proxima = (await this.limite.proximaVez(chave, 1, LER_AGORA_JANELA_S)) ?? new Date(agora.getTime() + LER_AGORA_JANELA_S * 1000);
    return { requested_at: agora.toISOString(), accounts: ids.length, next_at: proxima.toISOString() };
  }
}
