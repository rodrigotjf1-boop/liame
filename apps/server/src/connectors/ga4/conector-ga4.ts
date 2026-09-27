import type { Db } from '@liame/database';
import type { AppConfig } from '../../config.js';
import type { PontoMetrica } from '../../media/metric-store.js';
import { type ClienteConector, ErroConector } from '../cliente-http.js';
import { dataValida } from '../janela.js';
import { type ConectorLeitura, type ContaDescoberta, type ContextoConta, type Credencial, type EntidadesLidas, versaoRegistrada } from '../tipos.js';
import { soDigitos } from '../validacao.js';

// Conector de LEITURA do GA4 (A2, G6; base de conhecimento §3.3). Admin API lista as propriedades;
// Data API `runReport` traz o dia a dia da propriedade (nível `account`) e o recorte por
// origem / mídia / campanha (nível `campaign`, com a combinação como chave), a ponte com os anúncios no
// ciclo fechado. Cada resposta traz a cota da propriedade (`returnPropertyQuota`); com pouca cota
// sobrando, para antes de gastar o resto e devolve "limite" para o job tentar depois. Relatório com
// limiar de privacidade ou linha "(other)" grava qualidade `parcial`; com amostragem, `estimado`.

type Cota = { consumed?: number; remaining?: number };
type CotaPropriedade = Partial<Record<'tokensPerDay' | 'tokensPerHour' | 'tokensPerProjectPerHour' | 'concurrentRequests' | 'serverErrorsPerProjectPerHour' | 'potentiallyThresholdedRequestsPerHour', Cota>>;

type Relatorio = {
  dimensionHeaders?: { name: string }[];
  metricHeaders?: { name: string; type?: string }[];
  rows?: { dimensionValues?: { value?: string }[]; metricValues?: { value?: string }[] }[];
  rowCount?: number;
  metadata?: { currencyCode?: string; timeZone?: string; dataLossFromOtherRow?: boolean; subjectToThresholding?: boolean; samplingMetadatas?: unknown[] };
  propertyQuota?: CotaPropriedade;
};

/** Métrica do GA4 → nome canônico (a sessão já carrega a atribuição do GA4: sem janela). */
const METRICAS: [string, string][] = [
  ['sessions', 'sessions'],
  ['totalUsers', 'users'],
  ['newUsers', 'new_users'],
  ['engagedSessions', 'engaged_sessions'],
  ['keyEvents', 'key_events'],
  ['ecommercePurchases', 'purchases'],
  ['purchaseRevenue', 'purchase_value'],
];

/** Nomes canônicos que este conector pode gravar (o mapa da distribuição precisa conhecer todos). */
export const METRICAS_CANONICAS_GA4 = METRICAS.map(([, nome]) => nome);

const RECORTE = ['sessionSource', 'sessionMedium', 'sessionCampaignName'];
const TAMANHO_CHAVE = 300;

export type OpcoesGa4 = {
  /** Linhas por página do runReport (padrão 10.000; máximo da API 250.000). */
  linhasPorPagina?: number;
  /** Fração mínima de cada cota de fichas que precisa sobrar para seguir (padrão 5%). */
  reservaCota?: number;
  agora?: () => Date;
};

/** Pouca cota sobrando em alguma das cotas de fichas: quanto esperar, ou null para seguir. */
export function esperaPelaCota(q: CotaPropriedade | undefined, reserva: number, agora: Date): { esperarMs: number; qual: string } | null {
  if (!q) return null;
  const baixa = (c: Cota | undefined) => {
    if (!c || c.remaining === undefined) return false;
    const total = (c.consumed ?? 0) + c.remaining;
    return total > 0 && c.remaining < total * reserva;
  };
  const proximaHora = 3_600_000 - (agora.getTime() % 3_600_000);
  if (baixa(q.tokensPerDay)) return { esperarMs: 6 * 3_600_000, qual: 'tokensPerDay' };
  if (baixa(q.tokensPerHour)) return { esperarMs: proximaHora, qual: 'tokensPerHour' };
  if (baixa(q.tokensPerProjectPerHour)) return { esperarMs: proximaHora, qual: 'tokensPerProjectPerHour' };
  return null;
}

function qualidade(m: Relatorio['metadata']): PontoMetrica['quality'] {
  if (m?.samplingMetadatas && m.samplingMetadatas.length > 0) return 'estimado';
  if (m?.subjectToThresholding || m?.dataLossFromOtherRow) return 'parcial';
  return 'ok';
}

/** "20260919" → "2026-09-19". */
function dataDoGa4(v: string | undefined): string | null {
  if (!v || v.length !== 8 || !soDigitos(v, 8)) return null;
  return `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}`;
}

function propriedadeValida(id: string | null | undefined): string {
  if (!soDigitos(id)) throw new ErroConector('definitivo', 'ga4', 'propriedade do GA4 inválida');
  return id;
}

export class ConectorGa4 implements ConectorLeitura {
  readonly provider = 'ga4' as const;
  private readonly opcoes: Required<OpcoesGa4>;

  constructor(
    private readonly cliente: ClienteConector,
    private readonly bases: { data: string; admin: string },
    readonly apiVersion: string,
    private readonly versaoAdmin: string,
    opcoes: OpcoesGa4 = {},
  ) {
    this.opcoes = { linhasPorPagina: 10_000, reservaCota: 0.05, agora: () => new Date(), ...opcoes };
  }

  private cabecalhos(credencial: Credencial) {
    return { authorization: `Bearer ${credencial.accessToken}` };
  }

  /**
   * Propriedades de todas as contas do Analytics que a credencial alcança, com fuso e moeda. Propriedade
   * que recusa a leitura fica de fora sem derrubar as outras.
   */
  async descobrirContas(credencial: Credencial): Promise<ContaDescoberta[]> {
    type Resumos = {
      accountSummaries?: { account?: string; displayName?: string; propertySummaries?: { property?: string; displayName?: string; propertyType?: string }[] }[];
      nextPageToken?: string;
    };
    const resumos: NonNullable<Resumos['accountSummaries']> = [];
    let token: string | undefined;
    for (let i = 0; i === 0 || token; i++) {
      if (i === 50) throw new ErroConector('definitivo', this.provider, 'accountSummaries: mais de 50 páginas');
      const q = new URLSearchParams({ pageSize: '200', ...(token ? { pageToken: token } : {}) });
      const r = await this.cliente.requisitar<Resumos>({
        provider: this.provider,
        conta: 'accountSummaries',
        url: `${this.bases.admin}/${this.versaoAdmin}/accountSummaries?${q.toString()}`,
        endpoint: 'accountSummaries',
        apiVersion: this.versaoAdmin,
        cabecalhos: this.cabecalhos(credencial),
      });
      resumos.push(...(r.corpo.accountSummaries ?? []));
      token = r.corpo.nextPageToken || undefined;
    }

    type Propriedade = { displayName?: string; timeZone?: string; currencyCode?: string; propertyType?: string };
    const contas: ContaDescoberta[] = [];
    for (const conta of resumos) {
      for (const p of conta.propertySummaries ?? []) {
        const id = (p.property ?? '').replace(/^properties\//, '');
        if (!soDigitos(id)) continue;
        let detalhe: Propriedade;
        try {
          detalhe = (
            await this.cliente.requisitar<Propriedade>({
              provider: this.provider,
              conta: id,
              url: `${this.bases.admin}/${this.versaoAdmin}/properties/${id}`,
              endpoint: 'properties.get',
              apiVersion: this.versaoAdmin,
              cabecalhos: this.cabecalhos(credencial),
            })
          ).corpo;
        } catch (err) {
          if (err instanceof ErroConector && (err.tipo === 'permissao' || err.tipo === 'definitivo')) continue;
          throw err;
        }
        contas.push({
          externalId: id,
          name: detalhe.displayName ?? p.displayName ?? id,
          currency: detalhe.currencyCode ?? null,
          timezone: detalhe.timeZone ?? null,
          providerAttributes: { account: conta.account ?? null, account_name: conta.displayName ?? null, property_type: detalhe.propertyType ?? p.propertyType ?? null },
        });
      }
    }
    return contas;
  }

  /** O GA4 não tem campanhas, grupos nem anúncios próprios: o recorte por campanha vem nas métricas. */
  async lerEntidades(): Promise<EntidadesLidas> {
    return { campaigns: [], adGroups: [], ads: [], creatives: [] };
  }

  async lerMetricas(conta: ContextoConta, janela: { inicio: string; fim: string }): Promise<PontoMetrica[]> {
    const propriedade = propriedadeValida(conta.externalId);
    dataValida(this.provider, janela.inicio);
    dataValida(this.provider, janela.fim);
    const pontos: PontoMetrica[] = [];
    const cota = await this.relatorio(conta.credencial, propriedade, janela, [], (data, _d, valores, q) => {
      for (const [nome, valor] of valores) pontos.push({ level: 'account', externalEntityId: propriedade, metricDate: data, metricName: nome, value: valor, quality: q });
    });
    this.conferirCota(cota);
    await this.relatorio(conta.credencial, propriedade, janela, RECORTE, (data, d, valores, q) => {
      const chave = d.map((v) => v || '(not set)').join(' / ').slice(0, TAMANHO_CHAVE);
      for (const [nome, valor] of valores) pontos.push({ level: 'campaign', externalEntityId: chave, metricDate: data, metricName: nome, value: valor, quality: q });
    });
    return pontos;
  }

  private conferirCota(q: CotaPropriedade | undefined): void {
    const espera = esperaPelaCota(q, this.opcoes.reservaCota, this.opcoes.agora());
    if (espera) throw new ErroConector('limite', this.provider, `cota do GA4 quase no fim (${espera.qual})`, 429, espera.esperarMs);
  }

  /** runReport por data (+ dimensões do recorte), paginado por `offset`, conferindo a cota a cada página. Devolve a última cota lida. */
  private async relatorio(
    credencial: Credencial,
    propriedade: string,
    janela: { inicio: string; fim: string },
    recorte: string[],
    aoLer: (data: string, dimensoes: string[], valores: [string, string][], q: PontoMetrica['quality']) => void,
  ): Promise<CotaPropriedade | undefined> {
    const limite = this.opcoes.linhasPorPagina;
    for (let offset = 0, pagina = 0; ; offset += limite, pagina++) {
      if (pagina === 500) throw new ErroConector('definitivo', this.provider, 'runReport: mais de 500 páginas');
      const r = await this.cliente.requisitar<Relatorio>({
        provider: this.provider,
        conta: propriedade,
        url: `${this.bases.data}/${this.apiVersion}/properties/${propriedade}:runReport`,
        metodo: 'POST',
        corpo: {
          dateRanges: [{ startDate: janela.inicio, endDate: janela.fim }],
          dimensions: ['date', ...recorte].map((name) => ({ name })),
          metrics: METRICAS.map(([name]) => ({ name })),
          limit: limite,
          offset,
          returnPropertyQuota: true,
        },
        endpoint: 'runReport',
        apiVersion: this.apiVersion,
        cabecalhos: this.cabecalhos(credencial),
      });
      const rel = r.corpo;
      const nomesMetricas = (rel.metricHeaders ?? []).map((h) => METRICAS.find(([ga4]) => ga4 === h.name)?.[1] ?? null);
      const q = qualidade(rel.metadata);
      for (const linha of rel.rows ?? []) {
        const dims = (linha.dimensionValues ?? []).map((v) => v.value ?? '');
        const data = dataDoGa4(dims[0]);
        if (!data) continue;
        const valores: [string, string][] = [];
        (linha.metricValues ?? []).forEach((v, i) => {
          const nome = nomesMetricas[i];
          if (nome && v.value !== undefined) valores.push([nome, v.value]);
        });
        aoLer(data, dims.slice(1), valores, q);
      }
      const acabou = offset + limite >= (rel.rowCount ?? 0) || (rel.rows ?? []).length === 0;
      if (acabou) return rel.propertyQuota;
      this.conferirCota(rel.propertyQuota);
    }
  }
}

/** Monta o conector com as versões do Capability Registry (Admin API e Data API podem andar separadas). */
export async function criarConectorGa4(db: Db, cliente: ClienteConector, plataformas: AppConfig['plataformas'], opcoes?: OpcoesGa4): Promise<ConectorGa4> {
  const [admin, dados] = await Promise.all([versaoRegistrada(db, 'ga4', 'properties'), versaoRegistrada(db, 'ga4', 'report_daily')]);
  return new ConectorGa4(cliente, { data: plataformas.ga4DataUrl, admin: plataformas.ga4AdminUrl }, dados, admin, opcoes);
}
