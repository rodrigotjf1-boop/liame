import type { Db } from '@liame/database';
import type { AppConfig } from '../../config.js';
import { type ClienteConector, ErroConector } from '../cliente-http.js';
import type { Balde } from '../cota.js';
import { dataValida } from '../janela.js';
import { type Credencial, versaoRegistrada } from '../tipos.js';
import { soDigitos } from '../validacao.js';
import {
  type AvaliacaoLida,
  avaliacaoDoGoogle,
  idDaAvaliacao,
  METRICAS_DO_PERFIL,
  notaMedia,
  numerosDoPerfil,
  type PontoDoPerfil,
  type QuemAvaliou,
  quemAvaliou,
  type RespostaLida,
  respostaDoGoogle,
  textoDaResposta,
  totalDeAvaliacoes,
} from './perfil-google.js';

// Conector do Perfil da Empresa no Google (A6, Z1 e Z2; base de conhecimento §3.3). Quatro APIs, cada uma no endereço
// e na versão dela (as versões vêm do registro de capacidades):
//   - as contas que a autorização alcança (Account Management API);
//   - as lojas de cada conta (Business Information API);
//   - as avaliações de uma loja, das mais recentes para as mais antigas (My Business API v4);
//   - os números do perfil por dia (Business Profile Performance API).
// **A única escrita é a resposta a uma avaliação** (`responderAvaliacao` e `apagarResposta`, Z2): quem chama é só o
// trilho de ação, depois de uma pessoa aprovar com o código do app. Horário, endereço e cardápio não são tocados
// (D-A6-18).
//
// A cota é do app do Liame no Google, e não da empresa: todas as empresas dividem as mesmas 300 chamadas por minuto
// de cada API, e antes de o Google liberar o acesso a cota é zero. Por isso toda chamada sai pela mesma chave de
// cota, num balde abaixo do limite; e quando o Google responde que a cota acabou, o conector devolve "limite", com
// quanto esperar, e não insiste (critério A6-2): quem agenda a nova leitura é o job.

const PROVIDER = 'google_business' as const;
/** Uma chave de cota só, para todas as empresas: a cota do Google é do projeto. */
const CHAVE_DA_COTA = 'projeto';
/** O balde do cliente HTTP deste conector: 240 chamadas por minuto, abaixo das 300 do Google. */
export const BALDE_DO_PERFIL_GOOGLE: Balde = { capacidade: 60, porSegundo: 4 };

const PAGINA_DE_CONTAS = 20;
const PAGINA_DE_LOJAS = 100;
const PAGINA_DE_AVALIACOES = 50;
/** O que o Liame lê de cada loja ao listar (o `readMask` é obrigatório). */
const CAMPOS_DA_LOJA = 'name,title,websiteUri,metadata';

export type LojaDoPerfil = {
  /** A conta do Perfil da Empresa (`accounts/123`). */
  conta: string;
  /** A loja (`locations/456`). */
  loja: string;
  nome: string;
  site: string | null;
  /** O id do lugar no Google Maps e o endereço dele no Maps, quando o Google os informa. */
  placeId: string | null;
  mapsUri: string | null;
};

export type AvaliacoesLidas = {
  avaliacoes: AvaliacaoLida[];
  /** A nota média e o total de avaliações da loja, como o Google informa na primeira página. */
  media: number | null;
  total: number | null;
  /** Falso quando a leitura parou no teto (`maximo`) antes de chegar ao fim ou ao corte (`desde`). */
  completa: boolean;
};

export type OpcoesDeAvaliacoes = {
  /** Só as avaliações criadas ou mudadas desde este instante (a lista vem da mais recente para a mais antiga). */
  desde?: Date;
  /** Quantas avaliações ler no máximo (padrão 500). */
  maximo?: number;
};

/** Uma avaliação de uma loja: a conta (`accounts/123`), a loja (`locations/456`) e o id da avaliação no Google. */
export type AlvoDaAvaliacao = { conta: string; loja: string; avaliacao: string };

/** `accounts/123` ou `locations/456`: o prefixo certo e só dígitos depois (vai para o caminho do endereço). */
function recurso(prefixo: 'accounts' | 'locations', valor: string): string {
  const [p, id, ...resto] = valor.split('/');
  if (p !== prefixo || resto.length > 0 || !soDigitos(id, 30)) throw new ErroConector('definitivo', PROVIDER, `${prefixo === 'accounts' ? 'conta' : 'loja'} do Perfil no Google inválida`);
  return `${prefixo}/${id}`;
}

const textoCurto = (v: unknown, max: number): string | null => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);

export class ConectorPerfilGoogle {
  readonly provider = PROVIDER;

  /**
   * `chaveDaCota`: a chave do balde e do disjuntor. Em produção é sempre a do projeto; só o teste que esvazia o balde
   * de propósito passa outra, para não deixar sem ficha os testes que rodam ao mesmo tempo no mesmo banco.
   */
  constructor(
    private readonly cliente: ClienteConector,
    private readonly bases: AppConfig['plataformas']['perfilGoogle'],
    /** A versão de cada API, do registro de capacidades (quem lê anota a versão na execução). */
    readonly versoes: { contas: string; lojas: string; avaliacoes: string; numeros: string },
    private readonly chaveDaCota: string = CHAVE_DA_COTA,
  ) {}

  private pedir<T>(url: string, endpoint: string, apiVersion: string, credencial: Credencial) {
    return this.cliente.requisitar<T>({ provider: PROVIDER, conta: this.chaveDaCota, url, endpoint, apiVersion, cabecalhos: { authorization: `Bearer ${credencial.accessToken}` } });
  }

  /**
   * As lojas de todas as contas do Perfil da Empresa que a autorização alcança. A conta que recusa a leitura das
   * lojas fica de fora, sem derrubar as outras; o limite de cota sobe.
   */
  async descobrirLojas(credencial: Credencial): Promise<LojaDoPerfil[]> {
    type Contas = { accounts?: { name?: string }[]; nextPageToken?: string };
    const contas: string[] = [];
    let token: string | undefined;
    for (let i = 0; i === 0 || token; i++) {
      if (i === 50) throw new ErroConector('definitivo', PROVIDER, 'accounts: mais de 50 páginas');
      const q = new URLSearchParams({ pageSize: String(PAGINA_DE_CONTAS), ...(token ? { pageToken: token } : {}) });
      const r = await this.pedir<Contas>(`${this.bases.contas}/${this.versoes.contas}/accounts?${q.toString()}`, 'accounts.list', this.versoes.contas, credencial);
      for (const c of r.corpo.accounts ?? []) {
        const [p, id] = (c.name ?? '').split('/');
        if (p === 'accounts' && soDigitos(id, 30)) contas.push(`accounts/${id}`);
      }
      token = r.corpo.nextPageToken || undefined;
    }

    type Lojas = { locations?: { name?: string; title?: string; websiteUri?: string; metadata?: { placeId?: string; mapsUri?: string } }[]; nextPageToken?: string };
    const lojas: LojaDoPerfil[] = [];
    for (const conta of contas) {
      let pagina: string | undefined;
      try {
        for (let i = 0; i === 0 || pagina; i++) {
          if (i === 100) throw new ErroConector('definitivo', PROVIDER, 'locations: mais de 100 páginas');
          const q = new URLSearchParams({ readMask: CAMPOS_DA_LOJA, pageSize: String(PAGINA_DE_LOJAS), ...(pagina ? { pageToken: pagina } : {}) });
          const r = await this.pedir<Lojas>(`${this.bases.lojas}/${this.versoes.lojas}/${conta}/locations?${q.toString()}`, 'locations.list', this.versoes.lojas, credencial);
          for (const l of r.corpo.locations ?? []) {
            const [p, id] = (l.name ?? '').split('/');
            if (p !== 'locations' || !soDigitos(id, 30)) continue;
            lojas.push({
              conta,
              loja: `locations/${id}`,
              nome: textoCurto(l.title, 300) ?? `locations/${id}`,
              site: textoCurto(l.websiteUri, 2048),
              placeId: textoCurto(l.metadata?.placeId, 300),
              mapsUri: textoCurto(l.metadata?.mapsUri, 2048),
            });
          }
          pagina = r.corpo.nextPageToken || undefined;
        }
      } catch (err) {
        if (err instanceof ErroConector && (err.tipo === 'permissao' || err.tipo === 'definitivo')) continue;
        throw err;
      }
    }
    return lojas;
  }

  /**
   * As avaliações de uma loja, da mais recente para a mais antiga, sem o nome e sem a foto de quem avaliou. Com
   * `desde`, para quando chega às que não mudaram desde então (a leitura do dia a dia); sem ele, lê até o teto.
   */
  async lerAvaliacoes(credencial: Credencial, alvo: { conta: string; loja: string }, opcoes: OpcoesDeAvaliacoes = {}): Promise<AvaliacoesLidas> {
    const conta = recurso('accounts', alvo.conta);
    const loja = recurso('locations', alvo.loja);
    const maximo = Math.max(1, Math.min(5000, Math.trunc(opcoes.maximo ?? 500)));
    const corte = opcoes.desde ? opcoes.desde.toISOString() : null;
    type Pagina = { reviews?: unknown[]; averageRating?: unknown; totalReviewCount?: unknown; nextPageToken?: string };
    const lidas: AvaliacoesLidas = { avaliacoes: [], media: null, total: null, completa: true };
    let token: string | undefined;
    for (let i = 0; i === 0 || token; i++) {
      const q = new URLSearchParams({ pageSize: String(PAGINA_DE_AVALIACOES), orderBy: 'updateTime desc', ...(token ? { pageToken: token } : {}) });
      const r = await this.pedir<Pagina>(`${this.bases.avaliacoes}/${this.versoes.avaliacoes}/${conta}/${loja}/reviews?${q.toString()}`, 'reviews.list', this.versoes.avaliacoes, credencial);
      if (i === 0) {
        lidas.media = notaMedia(r.corpo.averageRating);
        lidas.total = totalDeAvaliacoes(r.corpo.totalReviewCount);
      }
      for (const bruta of r.corpo.reviews ?? []) {
        const a = avaliacaoDoGoogle(bruta);
        if (!a) continue;
        // A lista vem por data de mudança: a primeira que não mudou desde o corte encerra a leitura.
        if (corte && a.atualizadaEm < corte) return lidas;
        if (lidas.avaliacoes.length === maximo) return { ...lidas, completa: false };
        lidas.avaliacoes.push(a);
      }
      token = r.corpo.nextPageToken || undefined;
    }
    return lidas;
  }

  /**
   * Quem fez as avaliações mais recentes de uma loja (o id da avaliação e o nome), **só para a tela, na hora**: quem
   * chama não guarda. Poucas páginas, e sem insistir: a pessoa está esperando a tela, e a cota é de todas as empresas.
   */
  async lerQuemAvaliou(credencial: Credencial, alvo: { conta: string; loja: string }, opcoes: { maximo?: number; tempoLimiteMs?: number } = {}): Promise<QuemAvaliou[]> {
    const conta = recurso('accounts', alvo.conta);
    const loja = recurso('locations', alvo.loja);
    const maximo = Math.max(1, Math.min(200, Math.trunc(opcoes.maximo ?? 100)));
    type Pagina = { reviews?: unknown[]; nextPageToken?: string };
    const nomes: QuemAvaliou[] = [];
    let token: string | undefined;
    let lidas = 0;
    for (let i = 0; (i === 0 || token) && lidas < maximo; i++) {
      const q = new URLSearchParams({ pageSize: String(PAGINA_DE_AVALIACOES), orderBy: 'updateTime desc', ...(token ? { pageToken: token } : {}) });
      const r = await this.cliente.requisitar<Pagina>({
        provider: PROVIDER,
        conta: this.chaveDaCota,
        url: `${this.bases.avaliacoes}/${this.versoes.avaliacoes}/${conta}/${loja}/reviews?${q.toString()}`,
        endpoint: 'reviews.list',
        apiVersion: this.versoes.avaliacoes,
        cabecalhos: { authorization: `Bearer ${credencial.accessToken}` },
        ...(opcoes.tempoLimiteMs ? { tempoLimiteMs: opcoes.tempoLimiteMs } : {}),
      });
      for (const bruta of r.corpo.reviews ?? []) {
        if (lidas === maximo) break;
        lidas++;
        const q2 = quemAvaliou(bruta);
        if (q2) nomes.push(q2);
      }
      token = r.corpo.nextPageToken || undefined;
    }
    return nomes;
  }

  /** `accounts/1/locations/2/reviews/abc`: o nome da avaliação no Google, com cada parte conferida antes de virar endereço. */
  private nomeDaAvaliacao(alvo: AlvoDaAvaliacao): string {
    const conta = recurso('accounts', alvo.conta);
    const loja = recurso('locations', alvo.loja);
    if (!idDaAvaliacao(alvo.avaliacao)) throw new ErroConector('definitivo', PROVIDER, 'avaliação do Perfil no Google com um id que o Liame não usa em endereço');
    return `${conta}/${loja}/reviews/${alvo.avaliacao}`;
  }

  /**
   * Uma avaliação, lida agora: é o que o trilho confere antes de publicar a resposta aprovada (critério A6-4). Nula
   * quando o Google responde que ela não existe mais (quem escreveu apagou, ou o Google tirou).
   */
  async lerAvaliacao(credencial: Credencial, alvo: AlvoDaAvaliacao, opcoes: { tempoLimiteMs?: number } = {}): Promise<AvaliacaoLida | null> {
    return (await this.lerAvaliacaoComQuem(credencial, alvo, opcoes))?.avaliacao ?? null;
  }

  /**
   * A mesma leitura, com o nome de quem fez a avaliação À PARTE (nulo se ela é anônima): o trilho o usa só para
   * conferir, na hora do pedido, que a resposta não cita esse nome. **Quem chama não guarda o nome** (D-A6-5): ele não
   * entra no estado do pedido, na auditoria nem em registro.
   */
  async lerAvaliacaoComQuem(credencial: Credencial, alvo: AlvoDaAvaliacao, opcoes: { tempoLimiteMs?: number } = {}): Promise<{ avaliacao: AvaliacaoLida; quem: string | null } | null> {
    const nome = this.nomeDaAvaliacao(alvo);
    let corpo: unknown;
    try {
      const r = await this.cliente.requisitar<unknown>({
        provider: PROVIDER,
        conta: this.chaveDaCota,
        url: `${this.bases.avaliacoes}/${this.versoes.avaliacoes}/${nome}`,
        endpoint: 'reviews.get',
        apiVersion: this.versoes.avaliacoes,
        cabecalhos: { authorization: `Bearer ${credencial.accessToken}` },
        ...(opcoes.tempoLimiteMs ? { tempoLimiteMs: opcoes.tempoLimiteMs } : {}),
      });
      corpo = r.corpo;
    } catch (err) {
      if (err instanceof ErroConector && err.status === 404) return null;
      throw err;
    }
    const lida = avaliacaoDoGoogle(corpo);
    // O Google devolveu outra coisa: não é com ela que o trilho vai comparar o que foi aprovado.
    if (!lida || lida.id !== alvo.avaliacao) throw new ErroConector('definitivo', PROVIDER, 'o Google devolveu a avaliação sem o que a identifica, ou outra avaliação');
    return { avaliacao: lida, quem: quemAvaliou(corpo)?.nome ?? null };
  }

  /**
   * Publica a resposta da empresa a uma avaliação (ou troca a que existe: o Google cria a resposta se ela não existir).
   * O texto vai inteiro ou não vai: nunca é cortado para caber. Devolve a resposta como o Google a gravou, com a
   * situação dela (ele confere antes de mostrar). Quem chama decide quantas vezes tentar: o trilho usa uma.
   */
  async responderAvaliacao(credencial: Credencial, alvo: AlvoDaAvaliacao, texto: string): Promise<RespostaLida> {
    const nome = this.nomeDaAvaliacao(alvo);
    const comentario = textoDaResposta(texto);
    if (!comentario) throw new ErroConector('definitivo', PROVIDER, 'resposta vazia ou maior do que o Liame publica');
    const r = await this.cliente.requisitar<unknown>({
      provider: PROVIDER,
      conta: this.chaveDaCota,
      url: `${this.bases.avaliacoes}/${this.versoes.avaliacoes}/${nome}/reply`,
      metodo: 'PUT',
      corpo: { comment: comentario },
      endpoint: 'reviews.updateReply',
      apiVersion: this.versoes.avaliacoes,
      cabecalhos: { authorization: `Bearer ${credencial.accessToken}` },
    });
    // Se o Google não devolver o texto, vale o que foi enviado, com a situação que ele ainda não disse.
    return respostaDoGoogle(r.corpo) ?? { texto: comentario, atualizadaEm: null, situacao: 'desconhecida', violacao: null };
  }

  /** Apaga a resposta da empresa a uma avaliação (a "volta" do pedido). A resposta que já não existe conta como apagada. */
  async apagarResposta(credencial: Credencial, alvo: AlvoDaAvaliacao): Promise<void> {
    const nome = this.nomeDaAvaliacao(alvo);
    try {
      await this.cliente.requisitar<unknown>({
        provider: PROVIDER,
        conta: this.chaveDaCota,
        url: `${this.bases.avaliacoes}/${this.versoes.avaliacoes}/${nome}/reply`,
        metodo: 'DELETE',
        endpoint: 'reviews.deleteReply',
        apiVersion: this.versoes.avaliacoes,
        cabecalhos: { authorization: `Bearer ${credencial.accessToken}` },
      });
    } catch (err) {
      if (err instanceof ErroConector && err.status === 404) return;
      throw err;
    }
  }

  /** Os números do perfil por dia, na janela [inicio, fim] (AAAA-MM-DD). O dia que o Google ainda não fechou não vem. */
  async lerNumeros(credencial: Credencial, alvo: { loja: string }, janela: { inicio: string; fim: string }): Promise<PontoDoPerfil[]> {
    const loja = recurso('locations', alvo.loja);
    const inicio = dataValida(PROVIDER, janela.inicio);
    const fim = dataValida(PROVIDER, janela.fim);
    if (fim < inicio) throw new ErroConector('definitivo', PROVIDER, 'janela dos números do perfil termina antes de começar');
    const q = new URLSearchParams();
    for (const [doGoogle] of METRICAS_DO_PERFIL) q.append('dailyMetrics', doGoogle);
    const partes = (prefixo: string, dia: string) => {
      q.set(`dailyRange.${prefixo}.year`, String(Number(dia.slice(0, 4))));
      q.set(`dailyRange.${prefixo}.month`, String(Number(dia.slice(5, 7))));
      q.set(`dailyRange.${prefixo}.day`, String(Number(dia.slice(8, 10))));
    };
    partes('start_date', inicio);
    partes('end_date', fim);
    const r = await this.pedir<unknown>(`${this.bases.numeros}/${this.versoes.numeros}/${loja}:fetchMultiDailyMetricsTimeSeries?${q.toString()}`, 'fetchMultiDailyMetricsTimeSeries', this.versoes.numeros, credencial);
    return numerosDoPerfil(r.corpo, { inicio, fim });
  }
}

/** Monta o conector com as versões do registro de capacidades (cada API do Perfil tem a dela). */
export async function criarConectorPerfilGoogle(db: Db, cliente: ClienteConector, plataformas: AppConfig['plataformas']): Promise<ConectorPerfilGoogle> {
  const [contas, lojas, avaliacoes, numeros] = await Promise.all([
    versaoRegistrada(db, PROVIDER, 'accounts'),
    versaoRegistrada(db, PROVIDER, 'locations'),
    versaoRegistrada(db, PROVIDER, 'reviews'),
    versaoRegistrada(db, PROVIDER, 'performance_daily'),
  ]);
  return new ConectorPerfilGoogle(cliente, plataformas.perfilGoogle, { contas, lojas, avaliacoes, numeros });
}
