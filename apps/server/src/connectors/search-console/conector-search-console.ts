import type { Db } from '@liame/database';
import type { AppConfig } from '../../config.js';
import { type ClienteConector, ErroConector } from '../cliente-http.js';
import type { Balde } from '../cota.js';
import { dataValida, diasNaJanela } from '../janela.js';
import { type Credencial, versaoRegistrada } from '../tipos.js';
import { type BuscaLida, buscasDoGoogle, type DiaDaBusca, diasDoGoogle, type SiteDoSearchConsole, siteNoCaminho, sitesDoGoogle, siteValido } from './search-console.js';

// Conector de LEITURA do Search Console (A6, Z3; base de conhecimento §3.3). Uma API, duas leituras, as duas na versão
// do registro de capacidades:
//   - os sites que a autorização alcança (`sites.list`);
//   - as buscas no Google que levaram a um site (`searchAnalytics.query`): por dia (o total, com as buscas raras que o
//     Google não mostra uma a uma) ou por busca (as que mais trouxeram cliques).
// **Não há escrita** (critério A6-6): o Liame só lê, e a permissão pedida é a de só leitura.
//
// O dado do Search Console fica pronto em 2 a 3 dias, e as datas são as do fuso do Pacífico, como o Google conta: quem
// chama escolhe a janela (só dias fechados) e lê o dado final, o padrão da API. A cota é por site (1.200 consultas por
// minuto por site e por usuário): o balde é por site, na metade disso.

const PROVIDER = 'search_console' as const;
/** O balde do cliente HTTP deste conector, por site: 600 consultas por minuto, metade das 1.200 do Google. */
export const BALDE_DO_SEARCH_CONSOLE: Balde = { capacidade: 20, porSegundo: 10 };

/** Até quantos dias uma leitura cobre: o Google guarda 16 meses (base §3.3). */
export const DIAS_NA_LEITURA = 490;
/** As linhas por pedido: o máximo da API (25.000). Por dia, uma janela inteira cabe num pedido só. */
const LINHAS_POR_PEDIDO = 25_000;
/** Quantas buscas ler de uma janela, no máximo (padrão 100; a API devolve as que mais trouxeram cliques primeiro). */
export const BUSCAS_POR_LEITURA = 100;

type Consulta = { rows?: unknown[]; responseAggregationType?: string };

function janelaValida(janela: { inicio: string; fim: string }): void {
  dataValida(PROVIDER, janela.inicio);
  dataValida(PROVIDER, janela.fim);
  const dias = diasNaJanela(janela.inicio, janela.fim);
  if (dias < 1 || dias > DIAS_NA_LEITURA) throw new ErroConector('definitivo', PROVIDER, `janela do Search Console fora do limite: ${dias} dias`);
}

function siteConferido(site: string): string {
  const s = siteValido(site);
  if (!s) throw new ErroConector('definitivo', PROVIDER, 'site do Search Console inválido');
  return s;
}

export class ConectorSearchConsole {
  readonly provider = PROVIDER;

  constructor(
    private readonly cliente: ClienteConector,
    private readonly base: string,
    /** A versão de cada leitura, do registro de capacidades (quem lê anota a versão na execução). */
    readonly versoes: { sites: string; buscas: string },
  ) {}

  private cabecalhos(credencial: Credencial) {
    return { authorization: `Bearer ${credencial.accessToken}` };
  }

  /** Os sites que a autorização alcança e que a empresa pode ler (dono, completo ou restrito). */
  async descobrirSites(credencial: Credencial): Promise<SiteDoSearchConsole[]> {
    const r = await this.cliente.requisitar<unknown>({
      provider: PROVIDER,
      // A lista é da pessoa que autorizou, e não de um site: a chave da cota é a da lista.
      conta: 'sites',
      url: `${this.base}/webmasters/${this.versoes.sites}/sites`,
      endpoint: 'sites.list',
      apiVersion: this.versoes.sites,
      cabecalhos: this.cabecalhos(credencial),
    });
    return sitesDoGoogle(r.corpo);
  }

  /** Os números do site por dia na janela (o total do dia, com as buscas raras), do mais antigo ao mais novo. */
  async lerDias(credencial: Credencial, site: string, janela: { inicio: string; fim: string }): Promise<DiaDaBusca[]> {
    const s = siteConferido(site);
    janelaValida(janela);
    const corpo = await this.consultar(credencial, s, { startDate: janela.inicio, endDate: janela.fim, dimensions: ['date'], type: 'web', rowLimit: LINHAS_POR_PEDIDO });
    return diasDoGoogle(corpo, janela);
  }

  /** As buscas que mais trouxeram cliques ao site na janela, até `maximo`. */
  async lerBuscas(credencial: Credencial, site: string, janela: { inicio: string; fim: string }, maximo = BUSCAS_POR_LEITURA): Promise<BuscaLida[]> {
    const s = siteConferido(site);
    janelaValida(janela);
    if (!Number.isInteger(maximo) || maximo < 1 || maximo > LINHAS_POR_PEDIDO) throw new ErroConector('definitivo', PROVIDER, 'quantidade de buscas fora do limite');
    const corpo = await this.consultar(credencial, s, { startDate: janela.inicio, endDate: janela.fim, dimensions: ['query'], type: 'web', rowLimit: maximo });
    return buscasDoGoogle(corpo, maximo);
  }

  private async consultar(credencial: Credencial, site: string, pedido: Record<string, unknown>): Promise<Consulta> {
    const r = await this.cliente.requisitar<Consulta>({
      provider: PROVIDER,
      conta: site,
      url: `${this.base}/webmasters/${this.versoes.buscas}/sites/${siteNoCaminho(site)}/searchAnalytics/query`,
      metodo: 'POST',
      corpo: pedido,
      endpoint: 'searchAnalytics.query',
      apiVersion: this.versoes.buscas,
      cabecalhos: this.cabecalhos(credencial),
    });
    return r.corpo;
  }
}

/** Monta o conector com as versões do registro de capacidades. */
export async function criarConectorSearchConsole(db: Db, cliente: ClienteConector, plataformas: AppConfig['plataformas']): Promise<ConectorSearchConsole> {
  const [sites, buscas] = await Promise.all([versaoRegistrada(db, PROVIDER, 'sites'), versaoRegistrada(db, PROVIDER, 'search_analytics')]);
  return new ConectorSearchConsole(cliente, plataformas.searchConsoleUrl, { sites, buscas });
}
