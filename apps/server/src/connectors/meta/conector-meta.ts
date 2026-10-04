import { createHmac } from 'node:crypto';
import { setTimeout as esperar } from 'node:timers/promises';
import type { Db } from '@liame/database';
import { Logger } from '@nestjs/common';
import type { AppConfig } from '../../config.js';
import type { PontoMetrica } from '../../media/metric-store.js';
import { type ClienteConector, ErroConector } from '../cliente-http.js';
import { dataValida, diasNaJanela, fatias } from '../janela.js';
import {
  type ConectorLeitura,
  type ContaDescoberta,
  type ContextoConta,
  type Credencial,
  type EntidadesLidas,
  juntarDestinos,
  type RastreioLido,
  type StatusCanonico,
  textoDeUrl,
  versaoRegistrada,
} from '../tipos.js';
import { orcamentoEmMicros, SEM_DECIMAIS } from './verba.js';

// Conector de LEITURA da Meta Marketing API (A2, G4; base de conhecimento §2.1). Versão vinda do
// Capability Registry. O token vai no cabeçalho (fora da URL, dos logs e dos traces); com o segredo do
// app configurado, cada chamada leva o appsecret_proof. Números da Meta chegam como texto e seguem
// como texto (precisão do numeric). Janela curta (incremental) = insights síncronos em fatias de 7
// dias; janela longa (carga inicial) = relatório assíncrono em fatias de 30 dias.

type Pagina<T> = { data?: T[]; paging?: { next?: string } };

const CAMPOS_INSIGHTS = ['ad_id', 'adset_id', 'campaign_id', 'date_start', 'spend', 'impressions', 'reach', 'clicks', 'inline_link_clicks', 'actions', 'action_values'];
const JANELAS = ['7d_click', '1d_view'];
const MAX_PAGINAS = 200;

export type OpcoesMeta = {
  /** Acima de quantos dias a janela vai pelo relatório assíncrono. */
  diasSincrono?: number;
  /** Intervalo entre as consultas ao relatório assíncrono. */
  intervaloRelatorioMs?: number;
  /** Quanto esperar o relatório antes de devolver para o job tentar depois. */
  prazoRelatorioMs?: number;
};

const PADRAO: Required<OpcoesMeta> = { diasSincrono: 14, intervaloRelatorioMs: 5_000, prazoRelatorioMs: 10 * 60_000 };

// A conta da verba (menor unidade da moeda ↔ micros) mora em `verba.ts`; sai por aqui também, para quem já importava.
export { orcamentoEmMicros, SEM_DECIMAIS };

function statusCanonico(status: string | undefined): StatusCanonico {
  switch (status) {
    case 'ACTIVE':
      return 'ativa';
    case 'PAUSED':
      return 'pausada';
    case 'ARCHIVED':
      return 'arquivada';
    case 'DELETED':
      return 'removida';
    default:
      return 'desconhecida';
  }
}

/** Nome de métrica específica da Meta: `meta:acao:<tipo>` (o que não tem equivalente canônico). */
function nomeProvider(prefixo: string, tipo: string): string {
  return `meta:${prefixo}:${tipo.toLowerCase().replace(/[^a-z0-9_.:]/g, '_')}`;
}

/** Aliases canônicos das ações, em ordem de preferência (a primeira presente vence). */
const CANONICAS: Record<string, string[]> = {
  conversations_started: ['onsite_conversion.messaging_conversation_started_7d'],
  purchases: ['purchase', 'omni_purchase', 'offsite_conversion.fb_pixel_purchase'],
  leads: ['lead', 'offsite_conversion.fb_pixel_lead'],
  landing_page_views: ['landing_page_view'],
};
const VALORES_CANONICOS: Record<string, string[]> = {
  purchase_value: ['purchase', 'omni_purchase', 'offsite_conversion.fb_pixel_purchase'],
};

type Acao = { action_type: string; value?: string } & Record<string, string | undefined>;

/** Campos numéricos da linha de insights que viram métrica canônica direto. */
const DIRETAS = [
  ['spend', 'spend'],
  ['impressions', 'impressions'],
  ['reach', 'reach'],
  ['clicks', 'clicks'],
  ['inline_link_clicks', 'link_clicks'],
] as const;

type LinhaInsights = { ad_id: string; date_start: string; actions?: Acao[]; action_values?: Acao[] } & Partial<Record<(typeof DIRETAS)[number][0], string>>;

/** Nomes canônicos que este conector pode gravar (o mapa da distribuição precisa conhecer todos). */
export const METRICAS_CANONICAS_META = [...DIRETAS.map(([, nome]) => nome), ...Object.keys(CANONICAS), ...Object.keys(VALORES_CANONICOS)];

function janelasDe(a: Acao): [string, string][] {
  const out: [string, string][] = [];
  if (a.value !== undefined) out.push(['padrao', a.value]);
  for (const j of JANELAS) if (a[j] !== undefined) out.push([j, a[j] as string]);
  return out;
}

/** O id da conta entra no caminho da URL: só `act_` + dígitos. */
function contaValida(id: string): void {
  if (!/^act_\d{1,20}$/.test(id)) throw new ErroConector('definitivo', 'meta_ads', 'conta da Meta com id inválido');
}

// Campos lidos das entidades. Os de URL servem à conferência do rastreio (A2.5, F5; base §2.1, referência
// v26.0 conferida em 29/09/2026): os parâmetros de URL do criativo (`url_tags`), o link do anúncio de link
// e dos cartões do carrossel, o do botão do vídeo, os links do criativo dinâmico (cada um com os próprios
// parâmetros) e o destino do conjunto (site, WhatsApp…). Mesma permissão de leitura (`ads_read`).
const CAMPOS_CONJUNTO = 'id,name,status,effective_status,campaign_id,daily_budget';
const CAMPOS_CONJUNTO_DESTINO = `${CAMPOS_CONJUNTO},destination_type`;
const CAMPOS_CRIATIVO = 'id,name,object_type,thumbnail_url';
const CAMPOS_CRIATIVO_URL = `${CAMPOS_CRIATIVO},url_tags,object_url,object_story_spec{link_data{link,child_attachments{link}},video_data{call_to_action}},asset_feed_spec{link_urls}`;

/** O criativo como a Meta devolve, com os campos de URL (quando lidos). */
export type CriativoMeta = {
  id: string;
  name?: string;
  object_type?: string;
  thumbnail_url?: string;
  url_tags?: string;
  object_url?: string;
  object_story_spec?: {
    link_data?: { link?: string; child_attachments?: { link?: string }[] };
    video_data?: { call_to_action?: { type?: string; value?: { link?: string } } };
  };
  asset_feed_spec?: { link_urls?: { website_url?: string; url_tags?: string }[] };
};

const lista = <T>(v: T[] | undefined): T[] => (Array.isArray(v) ? v : []);

/** Para onde o criativo leva e os parâmetros de URL dele (conferência do rastreio, F5). */
export function rastreioMeta(c: CriativoMeta): RastreioLido {
  const spec = c.object_story_spec;
  return {
    url_tags: textoDeUrl(c.url_tags),
    destinos: juntarDestinos([
      { url: spec?.link_data?.link },
      ...lista(spec?.link_data?.child_attachments).map((a) => ({ url: a?.link })),
      { url: spec?.video_data?.call_to_action?.value?.link },
      ...lista(c.asset_feed_spec?.link_urls).map((l) => ({ url: l?.website_url, urlTags: l?.url_tags })),
      { url: c.object_url },
    ]),
    sufixo: null,
    sufixo_nivel: null,
    modelo: null,
    modelo_nivel: null,
  };
}

export class ConectorMeta implements ConectorLeitura {
  readonly provider = 'meta_ads' as const;
  private readonly logger = new Logger('conector-meta');
  private readonly opcoes: Required<OpcoesMeta>;

  constructor(
    private readonly cliente: ClienteConector,
    private readonly base: string,
    readonly apiVersion: string,
    private readonly appSecret: string | null,
    opcoes: OpcoesMeta = {},
  ) {
    this.opcoes = { ...PADRAO, ...opcoes };
  }

  private endereco(credencial: Credencial, caminho: string, params: Record<string, string>): string {
    const query = new URLSearchParams(params);
    if (this.appSecret) query.set('appsecret_proof', createHmac('sha256', this.appSecret).update(credencial.accessToken).digest('hex'));
    return `${this.base}/${this.apiVersion}/${caminho}?${query.toString()}`;
  }

  private chamar<T>(credencial: Credencial, conta: string, url: string, endpoint: string, metodo: 'GET' | 'POST' = 'GET') {
    return this.cliente.requisitar<T>({
      provider: this.provider,
      conta,
      url,
      metodo,
      endpoint,
      apiVersion: this.apiVersion,
      cabecalhos: { authorization: `Bearer ${credencial.accessToken}` },
    });
  }

  /** Segue o `paging.next` (dentro dos endereços liberados, conferido pelo cliente) até o fim. */
  private async paginas<T>(credencial: Credencial, conta: string, caminho: string, params: Record<string, string>, endpoint: string): Promise<T[]> {
    let url: string | undefined = this.endereco(credencial, caminho, params);
    const itens: T[] = [];
    for (let i = 0; url; i++) {
      if (i === MAX_PAGINAS) throw new ErroConector('definitivo', this.provider, `${endpoint}: mais de ${MAX_PAGINAS} páginas`);
      const r: { corpo: Pagina<T> } = await this.chamar<Pagina<T>>(credencial, conta, url, endpoint);
      itens.push(...(r.corpo.data ?? []));
      url = r.corpo.paging?.next;
    }
    return itens;
  }

  async descobrirContas(credencial: Credencial): Promise<ContaDescoberta[]> {
    type Conta = { id: string; name: string; currency?: string; timezone_name?: string; account_status?: number };
    const contas = await this.paginas<Conta>(credencial, 'me', 'me/adaccounts', { fields: 'id,account_id,name,currency,timezone_name,account_status', limit: '200' }, 'adaccounts');
    return contas.map((c) => ({
      externalId: c.id,
      name: c.name,
      currency: c.currency ?? null,
      timezone: c.timezone_name ?? null,
      providerAttributes: { account_status: c.account_status ?? null },
    }));
  }

  /**
   * Lê com os campos de URL (F5); se a Meta recusar esses campos (pedido definitivo) ou falhar com eles
   * (transitório: o "Please reduce the amount of data you're asking for" vem com o código 1, e o criativo
   * com os links pesa mais), lê sem eles e segue: a leitura das campanhas e das métricas nunca para por causa
   * da conferência do rastreio (o anúncio fica "não verificado" até a próxima leitura). Limite, permissão e
   * autenticação não são da consulta: seguem para quem chama, como antes.
   */
  private async comReserva<T>(ler: (fields: string) => Promise<T[]>, completo: string, basico: string, aresta: string): Promise<{ itens: T[]; completo: boolean }> {
    try {
      return { itens: await ler(completo), completo: true };
    } catch (err) {
      if (!(err instanceof ErroConector) || (err.tipo !== 'definitivo' && err.tipo !== 'transitorio')) throw err;
      this.logger.warn(`${aresta}: a leitura com os campos de URL falhou (${err.tipo}: ${err.message}); lido sem eles`);
      return { itens: await ler(basico), completo: false };
    }
  }

  async lerEntidades(conta: ContextoConta): Promise<EntidadesLidas> {
    contaValida(conta.externalId);
    const ler = <T>(aresta: string, fields: string) =>
      this.paginas<T>(conta.credencial, conta.externalId, `${conta.externalId}/${aresta}`, { fields, limit: '200' }, aresta);
    type Campanha = { id: string; name: string; status?: string; effective_status?: string; objective?: string; daily_budget?: string; lifetime_budget?: string; created_time?: string; updated_time?: string };
    type Conjunto = { id: string; name: string; status?: string; effective_status?: string; campaign_id?: string; daily_budget?: string; destination_type?: string };
    type Anuncio = { id: string; name: string; status?: string; effective_status?: string; adset_id?: string; creative?: { id?: string } };
    const [campanhas, conjuntos, anuncios, criativos] = await Promise.all([
      ler<Campanha>('campaigns', 'id,name,status,effective_status,objective,daily_budget,lifetime_budget,created_time,updated_time'),
      this.comReserva((f) => ler<Conjunto>('adsets', f), CAMPOS_CONJUNTO_DESTINO, CAMPOS_CONJUNTO, 'adsets'),
      ler<Anuncio>('ads', 'id,name,status,effective_status,adset_id,creative{id}'),
      this.comReserva((f) => ler<CriativoMeta>('adcreatives', f), CAMPOS_CRIATIVO_URL, CAMPOS_CRIATIVO, 'adcreatives'),
    ]);
    return {
      campaigns: campanhas.map((c) => ({
        externalId: c.id,
        name: c.name,
        status: statusCanonico(c.status),
        providerStatus: c.effective_status ?? c.status ?? null,
        objective: c.objective ?? null,
        dailyBudgetMicros: orcamentoEmMicros(c.daily_budget, conta.currency),
        lifetimeBudgetMicros: orcamentoEmMicros(c.lifetime_budget, conta.currency),
        providerAttributes: { created_time: c.created_time ?? null, updated_time: c.updated_time ?? null },
      })),
      adGroups: conjuntos.itens.map((s) => ({
        externalId: s.id,
        name: s.name,
        status: statusCanonico(s.status),
        providerStatus: s.effective_status ?? s.status ?? null,
        parentExternalId: s.campaign_id ?? null,
        dailyBudgetMicros: orcamentoEmMicros(s.daily_budget, conta.currency),
        // Para onde o conjunto leva (WEBSITE, WHATSAPP…): anúncio que não leva a um site não leva link.
        ...(conjuntos.completo ? { providerAttributes: { destination_type: s.destination_type ?? null } } : {}),
      })),
      ads: anuncios.map((a) => ({
        externalId: a.id,
        name: a.name,
        status: statusCanonico(a.status),
        providerStatus: a.effective_status ?? a.status ?? null,
        parentExternalId: a.adset_id ?? null,
        creativeExternalId: a.creative?.id ?? null,
      })),
      creatives: criativos.itens.map((c) => ({
        externalId: c.id,
        name: c.name ?? null,
        kind: c.object_type ?? null,
        thumbnailUrl: c.thumbnail_url ?? null,
        ...(criativos.completo ? { providerAttributes: { rastreio: rastreioMeta(c) } } : {}),
      })),
    };
  }

  async lerMetricas(conta: ContextoConta, janela: { inicio: string; fim: string }): Promise<PontoMetrica[]> {
    contaValida(conta.externalId);
    dataValida(this.provider, janela.inicio);
    dataValida(this.provider, janela.fim);
    const assincrono = diasNaJanela(janela.inicio, janela.fim) > this.opcoes.diasSincrono;
    const pontos: PontoMetrica[] = [];
    for (const fatia of fatias(janela.inicio, janela.fim, assincrono ? 30 : 7)) {
      const params = {
        level: 'ad',
        time_increment: '1',
        time_range: JSON.stringify(fatia),
        fields: CAMPOS_INSIGHTS.join(','),
        action_attribution_windows: JSON.stringify(JANELAS),
      };
      const linhas = assincrono
        ? await this.relatorioAssincrono(conta, params)
        : await this.paginas<LinhaInsights>(conta.credencial, conta.externalId, `${conta.externalId}/insights`, { ...params, limit: '500' }, 'insights');
      for (const l of linhas) pontos.push(...pontosDaLinha(l));
    }
    return pontos;
  }

  /**
   * Relatório assíncrono (base §2.1): cria, acompanha até "Job Completed" e lê o resultado. Falhou,
   * expirou ou passou do prazo: erro passageiro, e o job tenta de novo mais tarde (o id expira em 30
   * dias e não é guardado).
   */
  private async relatorioAssincrono(conta: ContextoConta, params: Record<string, string>): Promise<LinhaInsights[]> {
    const { credencial, externalId } = conta;
    const criado = await this.chamar<{ report_run_id?: string | number }>(credencial, externalId, this.endereco(credencial, `${externalId}/insights`, params), 'insights_async', 'POST');
    const id = criado.corpo.report_run_id;
    if (id === undefined || !/^\d+$/.test(String(id))) throw new ErroConector('definitivo', this.provider, 'relatório assíncrono sem report_run_id');

    const prazo = Date.now() + this.opcoes.prazoRelatorioMs;
    for (;;) {
      type Estado = { async_status?: string; async_percent_completion?: number };
      const estado = await this.chamar<Estado>(credencial, externalId, this.endereco(credencial, String(id), { fields: 'async_status,async_percent_completion' }), 'insights_async');
      const status = estado.corpo.async_status;
      if (status === 'Job Completed' && (estado.corpo.async_percent_completion ?? 100) >= 100) break;
      if (status === 'Job Failed' || status === 'Job Skipped') {
        throw new ErroConector('transitorio', this.provider, `relatório assíncrono terminou em "${status}"`, null, 60_000);
      }
      if (Date.now() + this.opcoes.intervaloRelatorioMs > prazo) {
        throw new ErroConector('transitorio', this.provider, 'relatório assíncrono ainda em andamento', null, 5 * 60_000);
      }
      await esperar(this.opcoes.intervaloRelatorioMs);
    }
    return this.paginas<LinhaInsights>(credencial, externalId, `${id}/insights`, { limit: '500' }, 'insights_async');
  }
}

function pontosDaLinha(l: LinhaInsights): PontoMetrica[] {
  const base = { level: 'ad' as const, externalEntityId: l.ad_id, metricDate: l.date_start };
  const out: PontoMetrica[] = [];
  for (const [campo, nome] of DIRETAS) {
    const v = l[campo];
    if (v !== undefined) out.push({ ...base, metricName: nome, value: v });
  }

  const porTipo = (lista: Acao[] | undefined) => new Map((lista ?? []).map((a) => [a.action_type, a]));
  const acoes = porTipo(l.actions);
  const valores = porTipo(l.action_values);
  for (const a of acoes.values()) for (const [janela, v] of janelasDe(a)) out.push({ ...base, metricName: nomeProvider('acao', a.action_type), attributionWindow: janela, value: v });
  for (const a of valores.values()) for (const [janela, v] of janelasDe(a)) out.push({ ...base, metricName: nomeProvider('valor', a.action_type), attributionWindow: janela, value: v });
  const aliases = (mapa: Record<string, string[]>, fonte: Map<string, Acao>) => {
    for (const [canonica, tipos] of Object.entries(mapa)) {
      const a = tipos.map((t) => fonte.get(t)).find(Boolean);
      if (a) for (const [janela, v] of janelasDe(a)) out.push({ ...base, metricName: canonica, attributionWindow: janela, value: v });
    }
  };
  aliases(CANONICAS, acoes);
  aliases(VALORES_CANONICOS, valores);
  return out;
}

/**
 * Monta o conector com a versão do Capability Registry. As capacidades de leitura da Meta andam juntas
 * (uma versão da Graph API por vez); se o registro estiver no meio de uma troca, para aqui em vez de
 * misturar versões numa mesma sincronização.
 */
export async function criarConectorMeta(db: Db, cliente: ClienteConector, plataformas: AppConfig['plataformas'], opcoes?: OpcoesMeta): Promise<ConectorMeta> {
  const versoes = await Promise.all(['accounts', 'entities', 'insights_daily'].map((c) => versaoRegistrada(db, 'meta_ads', c)));
  const versao = versoes[0]!;
  if (versoes.some((v) => v !== versao)) throw new Error(`registro da Meta com versões diferentes (${versoes.join(', ')})`);
  return new ConectorMeta(cliente, plataformas.metaGraphUrl, versao, plataformas.metaAppSecret, opcoes);
}
