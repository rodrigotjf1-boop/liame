import type { Db } from '@liame/database';
import { Logger } from '@nestjs/common';
import type { AppConfig } from '../../config.js';
import type { PontoMetrica } from '../../media/metric-store.js';
import { type ClienteConector, ErroConector } from '../cliente-http.js';
import { dataValida, fatias } from '../janela.js';
import {
  type ConectorLeitura,
  type ContaDescoberta,
  type ContextoConta,
  type Credencial,
  type EntidadesLidas,
  juntarDestinos,
  type NivelUrlGoogle,
  type RastreioLido,
  type StatusCanonico,
  textoDeUrl,
  versaoRegistrada,
} from '../tipos.js';
import { soDigitos } from '../validacao.js';

// Conector de LEITURA do Google Ads (A2, G5; base de conhecimento §3.1). GAQL por REST com
// `googleAds:searchStream` (a resposta é uma lista de lotes, campos em camelCase, int64 como texto).
// Sem developer token: foi encerrado em 09/09/2026 e o cabeçalho é ignorado (será recusado numa major
// futura); o acesso é do projeto Google Cloud da credencial OAuth. Conta acessada por uma gerente leva o
// `login-customer-id`. Valores em micros viram unidade da moeda com conta exata (sem ponto flutuante).

type Lote<T> = { results?: T[]; fieldMask?: string; requestId?: string };

const METRICAS_GAQL = [
  'metrics.cost_micros',
  'metrics.impressions',
  'metrics.clicks',
  'metrics.interactions',
  'metrics.conversions',
  'metrics.conversions_value',
  'metrics.all_conversions',
  'metrics.all_conversions_value',
];

type Metricas = Partial<Record<'costMicros' | 'impressions' | 'clicks' | 'interactions' | 'conversions' | 'conversionsValue' | 'allConversions' | 'allConversionsValue', string | number>>;

/**
 * Métrica pedida e ausente na linha vale zero (o JSON do protobuf omite o zero); por isso cada métrica
 * pedida sempre vira ponto: a conversão reatribuída para zero também precisa ser gravada.
 */
const MAPA: { campo: keyof Metricas; nome: string; janela?: string; micros?: boolean }[] = [
  { campo: 'costMicros', nome: 'spend', micros: true },
  { campo: 'impressions', nome: 'impressions' },
  { campo: 'clicks', nome: 'clicks' },
  { campo: 'interactions', nome: 'google:interactions' },
  { campo: 'conversions', nome: 'conversions', janela: 'padrao' },
  { campo: 'conversionsValue', nome: 'conversions_value', janela: 'padrao' },
  { campo: 'allConversions', nome: 'google:all_conversions', janela: 'padrao' },
  { campo: 'allConversionsValue', nome: 'google:all_conversions_value', janela: 'padrao' },
];

/** Nomes canônicos que este conector pode gravar (o mapa da distribuição precisa conhecer todos). */
export const METRICAS_CANONICAS_GOOGLE_ADS = MAPA.map((m) => m.nome).filter((n) => !n.startsWith('google:'));

/** Micros (int64 em texto) → unidade da moeda, exata: "48370000" → "48.37". */
export function microsParaUnidade(micros: string | number): string {
  const n = BigInt(typeof micros === 'number' ? Math.trunc(micros) : micros);
  const negativo = n < 0n;
  const a = negativo ? -n : n;
  const fracao = (a % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '');
  return `${negativo ? '-' : ''}${a / 1_000_000n}${fracao ? `.${fracao}` : ''}`;
}

function statusCanonico(status: string | undefined): StatusCanonico {
  switch (status) {
    case 'ENABLED':
      return 'ativa';
    case 'PAUSED':
      return 'pausada';
    case 'REMOVED':
      return 'removida';
    default:
      return 'desconhecida';
  }
}

const idNumerico = (id: string | number | undefined): string | null => (id === undefined || id === null ? null : String(id));

/** O id do cliente entra no caminho da URL e no cabeçalho: só dígitos. */
function clienteValido(id: string | null | undefined, campo: string): string {
  if (!soDigitos(id)) throw new ErroConector('definitivo', 'google_ads', `${campo} do Google Ads inválido`);
  return id;
}

// Consultas das entidades. Os campos de URL servem à conferência do rastreio (A2.5, F5; base §3.1): as URLs
// finais do anúncio e o sufixo do URL final e o modelo de acompanhamento de cada nível (anúncio, grupo,
// campanha e conta, lida pela campanha como recurso atribuído). Mesmo escopo de leitura.
const CAMPANHA = 'campaign.id, campaign.name, campaign.status, campaign.primary_status, campaign.advertising_channel_type, campaign_budget.amount_micros, campaign_budget.total_amount_micros';
const CAMPANHA_URL = 'campaign.final_url_suffix, campaign.tracking_url_template, customer.final_url_suffix, customer.tracking_url_template';
const GRUPO = 'ad_group.id, ad_group.name, ad_group.status, ad_group.type, campaign.id';
const GRUPO_URL = 'ad_group.final_url_suffix, ad_group.tracking_url_template';
const ANUNCIO = 'ad_group_ad.ad.id, ad_group_ad.ad.name, ad_group_ad.ad.type, ad_group_ad.status, ad_group.id';
const ANUNCIO_URL = 'ad_group_ad.ad.final_urls, ad_group_ad.ad.final_url_suffix, ad_group_ad.ad.tracking_url_template';

/** Uma ação de conversão da conta, como a tela a mostra: o id, o nome, a categoria do Google e se ela entra nos lances. */
export type AcaoDeConversao = { id: string; name: string; category: string | null; primary: boolean };

/** Teto de ações devolvidas: uma conta tem poucas; a lista é para uma pessoa escolher. */
const MAX_ACOES_DE_CONVERSAO = 200;

/** Sufixo e modelo de um nível, como o Google devolve (vazio ou ausente = o nível não define). */
export type UrlDoNivel = { finalUrlSuffix?: string; trackingUrlTemplate?: string };

/**
 * O que vale para o anúncio (base §3.1, "Serving URL expansion rules"): o sufixo do URL final e o modelo de
 * acompanhamento são resolvidos cada um por si, pelo nível mais específico que define (anúncio > grupo >
 * campanha > conta). Sufixo por palavra-chave, segmentação dinâmica e sitelink não são lidos.
 */
export function resolverUrlGoogle(
  niveis: { anuncio?: UrlDoNivel; grupo?: UrlDoNivel; campanha?: UrlDoNivel; conta?: UrlDoNivel },
  finalUrls: unknown,
): RastreioLido {
  const ordem: [NivelUrlGoogle, UrlDoNivel | undefined][] = [
    ['anuncio', niveis.anuncio],
    ['grupo', niveis.grupo],
    ['campanha', niveis.campanha],
    ['conta', niveis.conta],
  ];
  const primeiro = (campo: keyof UrlDoNivel): [string | null, NivelUrlGoogle | null] => {
    for (const [nivel, valor] of ordem) {
      const v = textoDeUrl(valor?.[campo]);
      if (v) return [v, nivel];
    }
    return [null, null];
  };
  const [sufixo, sufixoNivel] = primeiro('finalUrlSuffix');
  const [modelo, modeloNivel] = primeiro('trackingUrlTemplate');
  return {
    url_tags: null,
    destinos: juntarDestinos((Array.isArray(finalUrls) ? finalUrls : []).map((url: unknown) => ({ url }))),
    sufixo,
    sufixo_nivel: sufixoNivel,
    modelo,
    modelo_nivel: modeloNivel,
  };
}

export class ConectorGoogleAds implements ConectorLeitura {
  readonly provider = 'google_ads' as const;
  private readonly logger = new Logger('conector-google-ads');

  constructor(
    private readonly cliente: ClienteConector,
    private readonly base: string,
    readonly apiVersion: string,
  ) {}

  private cabecalhos(credencial: Credencial, loginCustomerId?: string | null): Record<string, string> {
    return {
      authorization: `Bearer ${credencial.accessToken}`,
      ...(loginCustomerId ? { 'login-customer-id': clienteValido(loginCustomerId, 'login-customer-id') } : {}),
    };
  }

  /** GAQL por `searchStream`: junta as linhas de todos os lotes da resposta. */
  private async consultar<T>(credencial: Credencial, clienteId: string, loginCustomerId: string | null | undefined, query: string): Promise<T[]> {
    const id = clienteValido(clienteId, 'cliente');
    const r = await this.cliente.requisitar<Lote<T>[]>({
      provider: this.provider,
      conta: id,
      url: `${this.base}/${this.apiVersion}/customers/${id}/googleAds:searchStream`,
      metodo: 'POST',
      corpo: { query },
      endpoint: 'searchStream',
      apiVersion: this.apiVersion,
      cabecalhos: this.cabecalhos(credencial, loginCustomerId),
    });
    if (!Array.isArray(r.corpo)) throw new ErroConector('definitivo', this.provider, 'searchStream sem a lista de lotes');
    return r.corpo.flatMap((lote) => lote.results ?? []);
  }

  /**
   * Contas que a credencial alcança: as de acesso direto e, nas gerentes, as clientes do primeiro nível
   * (acessadas com o `login-customer-id` da gerente). Gerentes não entram na lista (não têm anúncios).
   * Conta que recusa a consulta (desativada, sem permissão) fica de fora sem derrubar as outras.
   */
  async descobrirContas(credencial: Credencial): Promise<ContaDescoberta[]> {
    const r = await this.cliente.requisitar<{ resourceNames?: string[] }>({
      provider: this.provider,
      conta: 'listAccessibleCustomers',
      url: `${this.base}/${this.apiVersion}/customers:listAccessibleCustomers`,
      endpoint: 'listAccessibleCustomers',
      apiVersion: this.apiVersion,
      cabecalhos: this.cabecalhos(credencial),
    });
    const diretas = (r.corpo.resourceNames ?? []).map((n) => n.replace(/^customers\//, '')).filter((id) => soDigitos(id));

    type Cliente = { customerClient: { id: string; descriptiveName?: string; currencyCode?: string; timeZone?: string; manager?: boolean; level?: string | number; status?: string } };
    const contas = new Map<string, ContaDescoberta>();
    for (const raiz of diretas) {
      let linhas: Cliente[];
      try {
        linhas = await this.consultar<Cliente>(
          credencial,
          raiz,
          raiz,
          'SELECT customer_client.id, customer_client.descriptive_name, customer_client.currency_code, customer_client.time_zone, customer_client.manager, customer_client.level, customer_client.status FROM customer_client WHERE customer_client.level <= 1',
        );
      } catch (err) {
        if (err instanceof ErroConector && (err.tipo === 'permissao' || err.tipo === 'definitivo')) continue;
        throw err;
      }
      // A própria raiz vem no nível 0: numa gerente, o nome dela é o "via" das clientes (em geral, a agência).
      const gerente = linhas.find(({ customerClient: c }) => String(c.id) === raiz && c.manager)?.customerClient;
      const via = gerente ? (gerente.descriptiveName ?? raiz) : null;
      for (const { customerClient: c } of linhas) {
        if (c.manager) continue;
        const id = String(c.id);
        const direta = String(c.level ?? '0') === '0';
        // Acesso direto vence o acesso pela gerente (menos dependência de terceiro).
        if (contas.has(id) && !direta) continue;
        contas.set(id, {
          externalId: id,
          name: c.descriptiveName ?? id,
          currency: c.currencyCode ?? null,
          timezone: c.timeZone ?? null,
          providerAttributes: { login_customer_id: direta ? id : raiz, status: c.status ?? null, via: direta ? null : via },
        });
      }
    }
    return [...contas.values()];
  }

  /**
   * Consulta com os campos de URL (F5); se o Google recusar a consulta (pedido definitivo) ou falhar com ela
   * (transitório), consulta sem eles e segue: a leitura das campanhas e das métricas nunca para por causa da
   * conferência do rastreio. Limite, permissão e autenticação seguem para quem chama, como antes.
   */
  private async comReserva<T>(q: (query: string) => Promise<T[]>, completa: string, basica: string, recurso: string): Promise<{ itens: T[]; completo: boolean }> {
    try {
      return { itens: await q(completa), completo: true };
    } catch (err) {
      if (!(err instanceof ErroConector) || (err.tipo !== 'definitivo' && err.tipo !== 'transitorio')) throw err;
      this.logger.warn(`${recurso}: a consulta com os campos de URL falhou (${err.tipo}: ${err.message}); lido sem eles`);
      return { itens: await q(basica), completo: false };
    }
  }

  async lerEntidades(conta: ContextoConta): Promise<EntidadesLidas> {
    const q = <T>(query: string) => this.consultar<T>(conta.credencial, conta.externalId, conta.loginCustomerId, query);
    type Campanha = {
      campaign: { id: string; name: string; status?: string; primaryStatus?: string; advertisingChannelType?: string } & UrlDoNivel;
      campaignBudget?: { amountMicros?: string; totalAmountMicros?: string };
      customer?: UrlDoNivel;
    };
    type Grupo = { adGroup: { id: string; name: string; status?: string; type?: string } & UrlDoNivel; campaign?: { id?: string } };
    type Anuncio = { adGroupAd: { status?: string; ad: { id: string; name?: string; type?: string; finalUrls?: string[] } & UrlDoNivel }; adGroup?: { id?: string } };
    const [campanhas, grupos, anuncios] = await Promise.all([
      this.comReserva((x) => q<Campanha>(x), `SELECT ${CAMPANHA}, ${CAMPANHA_URL} FROM campaign`, `SELECT ${CAMPANHA} FROM campaign`, 'campaign'),
      this.comReserva((x) => q<Grupo>(x), `SELECT ${GRUPO}, ${GRUPO_URL} FROM ad_group`, `SELECT ${GRUPO} FROM ad_group`, 'ad_group'),
      this.comReserva((x) => q<Anuncio>(x), `SELECT ${ANUNCIO}, ${ANUNCIO_URL} FROM ad_group_ad`, `SELECT ${ANUNCIO} FROM ad_group_ad`, 'ad_group_ad'),
    ]);
    // O que vale para cada anúncio só é conhecido com os quatro níveis lidos.
    const urlCompleta = campanhas.completo && grupos.completo && anuncios.completo;
    const urlDaConta = campanhas.itens.find((c) => c.customer)?.customer;
    const urlDaCampanha = new Map(campanhas.itens.map(({ campaign: c }) => [String(c.id), c]));
    const grupoDoAnuncio = new Map(grupos.itens.map(({ adGroup: g, campaign }) => [String(g.id), { url: g, campanha: idNumerico(campaign?.id) }]));
    const micros = (v: string | undefined) => (v === undefined ? null : Number(v));
    return {
      campaigns: campanhas.itens.map(({ campaign: c, campaignBudget: b }) => ({
        externalId: String(c.id),
        name: c.name,
        status: statusCanonico(c.status),
        providerStatus: c.primaryStatus ?? c.status ?? null,
        objective: c.advertisingChannelType ?? null,
        dailyBudgetMicros: micros(b?.amountMicros),
        lifetimeBudgetMicros: micros(b?.totalAmountMicros),
        providerAttributes: { advertising_channel_type: c.advertisingChannelType ?? null },
      })),
      adGroups: grupos.itens.map(({ adGroup: g, campaign }) => ({
        externalId: String(g.id),
        name: g.name,
        status: statusCanonico(g.status),
        providerStatus: g.status ?? null,
        parentExternalId: idNumerico(campaign?.id),
        providerAttributes: { type: g.type ?? null },
      })),
      // No Google Ads o anúncio é o próprio criativo: um criativo por anúncio, com o mesmo id.
      ads: anuncios.itens.map(({ adGroupAd: a, adGroup }) => {
        const grupo = adGroup?.id === undefined ? undefined : grupoDoAnuncio.get(String(adGroup.id));
        const campanha = grupo?.campanha ? urlDaCampanha.get(grupo.campanha) : undefined;
        return {
          externalId: String(a.ad.id),
          name: a.ad.name ?? `Anúncio ${a.ad.id}`,
          status: statusCanonico(a.status),
          providerStatus: a.status ?? null,
          parentExternalId: idNumerico(adGroup?.id),
          creativeExternalId: String(a.ad.id),
          ...(urlCompleta
            ? { providerAttributes: { rastreio: resolverUrlGoogle({ anuncio: a.ad, grupo: grupo?.url, campanha, conta: urlDaConta }, a.ad.finalUrls) } }
            : {}),
        };
      }),
      creatives: anuncios.itens.map(({ adGroupAd: a }) => ({ externalId: String(a.ad.id), name: a.ad.name ?? null, kind: a.ad.type ?? null, thumbnailUrl: null })),
    };
  }

  /**
   * Métricas por anúncio e por campanha (a Performance Max não tem anúncio em `ad_group_ad`: o total dela
   * só existe no nível da campanha). Fatias de 30 dias; a data é a do fuso da conta.
   */
  async lerMetricas(conta: ContextoConta, janela: { inicio: string; fim: string }): Promise<PontoMetrica[]> {
    clienteValido(conta.externalId, 'cliente');
    dataValida(this.provider, janela.inicio);
    dataValida(this.provider, janela.fim);
    type Linha = { metrics?: Metricas; segments: { date: string }; adGroupAd?: { ad?: { id?: string } }; campaign?: { id?: string } };
    const pontos: PontoMetrica[] = [];
    for (const f of fatias(janela.inicio, janela.fim, 30)) {
      const onde = `WHERE segments.date BETWEEN '${dataValida(this.provider, f.since)}' AND '${dataValida(this.provider, f.until)}'`;
      const [porAnuncio, porCampanha] = await Promise.all([
        this.consultar<Linha>(conta.credencial, conta.externalId, conta.loginCustomerId, `SELECT ad_group_ad.ad.id, segments.date, ${METRICAS_GAQL.join(', ')} FROM ad_group_ad ${onde}`),
        this.consultar<Linha>(conta.credencial, conta.externalId, conta.loginCustomerId, `SELECT campaign.id, segments.date, ${METRICAS_GAQL.join(', ')} FROM campaign ${onde}`),
      ]);
      for (const l of porAnuncio) if (l.adGroupAd?.ad?.id !== undefined) pontos.push(...pontosDaLinha('ad', String(l.adGroupAd.ad.id), l));
      for (const l of porCampanha) if (l.campaign?.id !== undefined) pontos.push(...pontosDaLinha('campaign', String(l.campaign.id), l));
    }
    return pontos;
  }

  /**
   * As ações de conversão ATIVAS da conta que recebem venda importada por clique (`UPLOAD_CLICKS`), por nome: é entre
   * elas que uma pessoa escolhe onde o Liame informa as vendas (A5, Y1; base de conhecimento §3.2). Mesmo escopo de
   * leitura das campanhas. O filtro vai na consulta e é conferido de novo aqui: o que não for desse tipo, ou não
   * estiver ativo, não entra, mesmo que a plataforma devolva.
   */
  async lerAcoesDeConversao(conta: ContextoConta): Promise<AcaoDeConversao[]> {
    type Linha = { conversionAction?: { id?: string | number; name?: string; status?: string; type?: string; category?: string; primaryForGoal?: boolean } };
    const linhas = await this.consultar<Linha>(
      conta.credencial,
      conta.externalId,
      conta.loginCustomerId,
      "SELECT conversion_action.id, conversion_action.name, conversion_action.status, conversion_action.type, conversion_action.category, conversion_action.primary_for_goal FROM conversion_action WHERE conversion_action.type = 'UPLOAD_CLICKS' AND conversion_action.status = 'ENABLED' ORDER BY conversion_action.name",
    );
    const acoes: AcaoDeConversao[] = [];
    for (const { conversionAction: a } of linhas) {
      const id = idNumerico(a?.id);
      if (!a || !soDigitos(id) || a.type !== 'UPLOAD_CLICKS' || a.status !== 'ENABLED') continue;
      const nome = typeof a.name === 'string' ? a.name.trim().slice(0, 200) : '';
      acoes.push({ id, name: nome || `Conversão ${id}`, category: typeof a.category === 'string' && a.category ? a.category.slice(0, 60) : null, primary: a.primaryForGoal === true });
    }
    return acoes.sort((x, y) => x.name.localeCompare(y.name, 'pt-BR') || x.id.localeCompare(y.id)).slice(0, MAX_ACOES_DE_CONVERSAO);
  }
}

function pontosDaLinha(level: 'ad' | 'campaign', externalEntityId: string, l: { metrics?: Metricas; segments: { date: string } }): PontoMetrica[] {
  const m = l.metrics ?? {};
  return MAPA.map(({ campo, nome, janela, micros }) => {
    const bruto = m[campo] ?? 0;
    return {
      level,
      externalEntityId,
      metricDate: l.segments.date,
      metricName: nome,
      ...(janela ? { attributionWindow: janela } : {}),
      value: micros ? microsParaUnidade(bruto) : String(bruto),
    };
  });
}

/** Monta o conector com a versão do Capability Registry (as capacidades do Google Ads andam juntas). */
export async function criarConectorGoogleAds(db: Db, cliente: ClienteConector, plataformas: AppConfig['plataformas']): Promise<ConectorGoogleAds> {
  const versoes = await Promise.all(['accounts', 'entities', 'metrics_daily'].map((c) => versaoRegistrada(db, 'google_ads', c)));
  const versao = versoes[0]!;
  if (versoes.some((v) => v !== versao)) throw new Error(`registro do Google Ads com versões diferentes (${versoes.join(', ')})`);
  return new ConectorGoogleAds(cliente, plataformas.googleAdsUrl, versao);
}
