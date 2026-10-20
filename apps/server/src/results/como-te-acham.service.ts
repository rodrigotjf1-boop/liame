import type { GoogleVisibilityAccount, GoogleVisibilityPeriod, GoogleVisibilityProfile, GoogleVisibilityQuery, GoogleVisibilityResponse, GoogleVisibilitySite } from '@liame/contracts';
import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { estadoSemLoja } from '../avaliacoes/avaliacoes.service.js';
import { DATASET_NUMEROS } from '../avaliacoes/sincronizador-do-perfil.js';
import { DATASET_DIAS, somarDias } from '../buscas/sincronizador-das-buscas.js';
import { contaConectada } from '../connections/conectada.js';
import { FLAG_PERFIL_GOOGLE, PROVEDOR_PERFIL_GOOGLE } from '../connectors/google-business/perfil-google.js';
import { FLAG_SEARCH_CONSOLE, PROVEDOR_SEARCH_CONSOLE } from '../connectors/search-console/search-console.js';
import type { AuthContext } from '../context/request-context.js';
import { currentTx } from '../context/request-context.js';
import { AppProblem } from '../errors/problems.js';
import { FlagService } from '../flags/flag.service.js';

// Como te acham no Google (P18, aprovado pelo dono em 15/10/2026): o que o Liame guardou do perfil da empresa no Google
// (A6 · Z1) e do site no Search Console (A6 · Z3), para o cartão de Resultados. Só leitura, do banco do Liame, na
// transação da requisição, sob a RLS da empresa.
//
// O período acaba no último dia que o Google já informou (ele entrega os números com 2 a 3 dias de atraso), em cada
// parte: o perfil e o site podem acabar em dias diferentes, e a tela escreve a data de cada um. As duas partes não se
// somam (contagens diferentes do Google).

/** As buscas da semana que a tela recebe: 5 no modo simples ("Ver as 10 buscas"), 10 no Pro. */
export const BUSCAS_NA_TELA = 10;

type LinhaConta = { id: string; name: string; status: string; last_success_at: Date | string | null };
type LinhaPeriodo = { ultimo: string | null };

const isoOuNulo = (v: Date | string | null) => (v == null ? null : new Date(v).toISOString());
/** A posição média com até duas casas ("6.8"); nula sem nenhuma vez. */
export function posicaoEmTexto(v: string | number | null): string | null {
  if (v == null) return null;
  const n = Math.round(Number(v) * 100) / 100;
  return Number.isFinite(n) && n >= 1 ? String(n) : null;
}
/** O período de `dias` dias que acaba em `ultimo`, e o de antes, do mesmo tamanho. */
export function periodos(ultimo: string, dias: number): { atual: GoogleVisibilityPeriod; antes: GoogleVisibilityPeriod } {
  const from = somarDias(ultimo, -(dias - 1));
  return { atual: { from, to: ultimo }, antes: { from: somarDias(from, -dias), to: somarDias(from, -1) } };
}
const contas = (linhas: LinhaConta[]): GoogleVisibilityAccount[] =>
  linhas.map((c) => ({ connected_account_id: c.id, name: c.name, status: c.status, last_success_at: isoOuNulo(c.last_success_at) }));

const PERFIL_VAZIO: GoogleVisibilityProfile = {
  enabled: false,
  waiting_google: false,
  accounts: [],
  period: null,
  views_search: '0',
  views_maps: '0',
  previous_views: null,
  direction_requests: '0',
  call_clicks: '0',
  website_clicks: '0',
  menu_clicks: '0',
};
const SITE_VAZIO: GoogleVisibilitySite = {
  enabled: false,
  accounts: [],
  period: null,
  clicks: '0',
  impressions: '0',
  position: null,
  previous_clicks: null,
  daily: [],
  queries: null,
};

@Injectable()
export class ComoTeAchamService {
  constructor(private readonly flags: FlagService) {}

  async ler(auth: AuthContext, q: GoogleVisibilityQuery): Promise<GoogleVisibilityResponse> {
    const tx = currentTx();
    const marca = await tx.execute<{ id: string }>(sql`select id from liame.brand where id = ${q.brand_id} and archived_at is null`);
    if (!marca.rows[0]) throw new AppProblem(404, 'nao-encontrado', 'Não encontramos', 'Marca não encontrada nesta empresa.');
    const dias = Number(q.days);
    const ctx = this.flags.context({ tenantId: auth.tenantId, userId: auth.userId, brandId: q.brand_id });
    const comPerfil = await this.flags.isEnabled(FLAG_PERFIL_GOOGLE, ctx);
    const comSite = await this.flags.isEnabled(FLAG_SEARCH_CONSOLE, ctx);
    const profile = comPerfil ? await this.perfil(q.brand_id, dias) : PERFIL_VAZIO;
    const site = comSite ? await this.site(q.brand_id, dias) : SITE_VAZIO;
    return { enabled: comPerfil || comSite, days: dias, profile, site };
  }

  /** As contas ligadas à marca de um provedor, com a última leitura boa do conjunto que traz os números. */
  private async contasDaMarca(brandId: string, provedor: string, dataset: string): Promise<LinhaConta[]> {
    const r = await currentTx().execute<LinhaConta>(sql`
      select a.id, a.name, a.status, s.last_success_at
        from liame.connected_account a
        left join liame.sync_state s on s.connected_account_id = a.id and s.dataset = ${dataset}
       where a.brand_id = ${brandId} and a.provider = ${provedor} and ${contaConectada('a')}
       order by a.name, a.id`);
    return r.rows;
  }

  private async perfil(brandId: string, dias: number): Promise<GoogleVisibilityProfile> {
    const tx = currentTx();
    const lojas = await this.contasDaMarca(brandId, PROVEDOR_PERFIL_GOOGLE, DATASET_NUMEROS);
    if (!lojas.length) {
      const conexoes = await tx.execute<{ scopes: string[] | null; discovery_notes: unknown; lojas: number }>(sql`
        select c.scopes, c.discovery_notes,
               (select count(*)::int from jsonb_array_elements(c.discovered) as d where d ->> 'provider' = ${PROVEDOR_PERFIL_GOOGLE}) as lojas
          from liame.oauth_connection c
         where c.brand_id = ${brandId} and c.provider = 'google' and c.status in ('ativa', 'aguardando_escolha')`);
      const estado = estadoSemLoja(conexoes.rows.map((c) => ({ scopes: c.scopes ?? [], discovery_notes: c.discovery_notes, lojas: c.lojas })));
      return { ...PERFIL_VAZIO, enabled: true, waiting_google: estado === 'esperando_google' };
    }
    const ids = lojas.map((l) => l.id);
    const [ultimo] = (await tx.execute<LinhaPeriodo>(sql`select max(day)::text as ultimo from liame.profile_metric_daily where connected_account_id in ${ids}`)).rows;
    if (!ultimo?.ultimo) return { ...PERFIL_VAZIO, enabled: true, accounts: contas(lojas) };
    const { atual, antes } = periodos(ultimo.ultimo, dias);
    const [n] = (
      await tx.execute<{
        busca: string | null;
        maps: string | null;
        antes: string | null;
        rotas: string | null;
        ligacoes: string | null;
        site: string | null;
        cardapio: string | null;
      }>(sql`
        select sum(value) filter (where day >= ${atual.from}::date and metric in ('profile_views_search_desktop', 'profile_views_search_mobile'))::text as busca,
               sum(value) filter (where day >= ${atual.from}::date and metric in ('profile_views_maps_desktop', 'profile_views_maps_mobile'))::text as maps,
               sum(value) filter (where day <= ${antes.to}::date and metric like 'profile_views_%')::text as antes,
               sum(value) filter (where day >= ${atual.from}::date and metric = 'direction_requests')::text as rotas,
               sum(value) filter (where day >= ${atual.from}::date and metric = 'call_clicks')::text as ligacoes,
               sum(value) filter (where day >= ${atual.from}::date and metric = 'website_clicks')::text as site,
               sum(value) filter (where day >= ${atual.from}::date and metric = 'menu_clicks')::text as cardapio
          from liame.profile_metric_daily
         where connected_account_id in ${ids} and day between ${antes.from}::date and ${atual.to}::date`)
    ).rows;
    return {
      enabled: true,
      waiting_google: false,
      accounts: contas(lojas),
      period: atual,
      views_search: n?.busca ?? '0',
      views_maps: n?.maps ?? '0',
      previous_views: n?.antes ?? null,
      direction_requests: n?.rotas ?? '0',
      call_clicks: n?.ligacoes ?? '0',
      website_clicks: n?.site ?? '0',
      menu_clicks: n?.cardapio ?? '0',
    };
  }

  private async site(brandId: string, dias: number): Promise<GoogleVisibilitySite> {
    const tx = currentTx();
    const sites = await this.contasDaMarca(brandId, PROVEDOR_SEARCH_CONSOLE, DATASET_DIAS);
    if (!sites.length) return { ...SITE_VAZIO, enabled: true };
    const ids = sites.map((s) => s.id);
    const base = { ...SITE_VAZIO, enabled: true, accounts: contas(sites) };
    const [ultimo] = (await tx.execute<LinhaPeriodo>(sql`select max(day)::text as ultimo from liame.search_console_daily where connected_account_id in ${ids}`)).rows;
    const queries = await this.buscasDaSemana(ids);
    if (!ultimo?.ultimo) return { ...base, queries };
    const { atual, antes } = periodos(ultimo.ultimo, dias);
    const [n] = (
      await tx.execute<{ cliques: string | null; vezes: string | null; posicao: string | null; antes: string | null }>(sql`
        select sum(clicks) filter (where day >= ${atual.from}::date)::text as cliques,
               sum(impressions) filter (where day >= ${atual.from}::date)::text as vezes,
               (sum(position * impressions) filter (where day >= ${atual.from}::date and position is not null)
                 / nullif(sum(impressions) filter (where day >= ${atual.from}::date and position is not null), 0))::text as posicao,
               sum(clicks) filter (where day <= ${antes.to}::date)::text as antes
          from liame.search_console_daily
         where connected_account_id in ${ids} and day between ${antes.from}::date and ${atual.to}::date`)
    ).rows;
    const porDia = await tx.execute<{ day: string; clicks: string }>(sql`
      select d.day::date::text as day, coalesce(sum(s.clicks), 0)::text as clicks
        from generate_series(${atual.from}::date, ${atual.to}::date, interval '1 day') as d(day)
        left join liame.search_console_daily s on s.day = d.day::date and s.connected_account_id in ${ids}
       group by d.day
       order by d.day`);
    return {
      ...base,
      period: atual,
      clicks: n?.cliques ?? '0',
      impressions: n?.vezes ?? '0',
      position: posicaoEmTexto(n?.posicao ?? null),
      previous_clicks: n?.antes ?? null,
      daily: porDia.rows.map((d) => ({ day: d.day, clicks: d.clicks })),
      queries,
    };
  }

  /** As buscas da última semana lida (as semanas guardadas são só as fechadas): as que mais trouxeram cliques. */
  private async buscasDaSemana(ids: string[]): Promise<GoogleVisibilitySite['queries']> {
    const tx = currentTx();
    const [semana] = (await tx.execute<{ inicio: string | null }>(sql`select max(week_start)::text as inicio from liame.search_console_query_week where connected_account_id in ${ids}`)).rows;
    if (!semana?.inicio) return null;
    const linhas = await tx.execute<{ query: string; clicks: string; impressions: string; position: string | null }>(sql`
      select query, sum(clicks)::text as clicks, sum(impressions)::text as impressions,
             (sum(position * impressions) filter (where position is not null) / nullif(sum(impressions) filter (where position is not null), 0))::text as position
        from liame.search_console_query_week
       where connected_account_id in ${ids} and week_start = ${semana.inicio}::date
       group by query
       order by sum(clicks) desc, sum(impressions) desc, query collate "C"
       limit ${BUSCAS_NA_TELA}`);
    return {
      week: { from: semana.inicio, to: somarDias(semana.inicio, 6) },
      items: linhas.rows.map((l) => ({ query: l.query, clicks: l.clicks, impressions: l.impressions, position: posicaoEmTexto(l.position) })),
    };
  }
}
