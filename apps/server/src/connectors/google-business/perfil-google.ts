// O Perfil da Empresa no Google (A6, Z1; base de conhecimento §3.3): o que o Liame tira das respostas da API, sem
// rede e sem banco. Duas coisas: as avaliações e os números do perfil por dia.
//
// Das avaliações, o Liame guarda a nota, as datas, o texto e a situação da resposta (D-A6-5). **O nome e a foto de
// quem avaliou não passam daqui:** o tipo que sai não tem campo para eles, e o que a sincronização grava é esse tipo
// (critério A6-1). A foto que a pessoa anexou à avaliação também fica de fora.

import type { TipoErroConector } from '../cliente-http.js';

/** A função, por empresa, desligada de fábrica: ligada, o Liame pede a permissão do Perfil e lê as lojas dele (D-A6-17). */
export const FLAG_PERFIL_GOOGLE = 'perfil_google';
/** A permissão que todas as leituras do Perfil pedem. Só entra na autorização da empresa com a função ligada. */
export const ESCOPO_PERFIL_GOOGLE = 'https://www.googleapis.com/auth/business.manage';
/** O código da loja do Perfil entre as contas ligadas (`connected_account.provider`). */
export const PROVEDOR_PERFIL_GOOGLE = 'google_business';

/**
 * Como terminou a procura das lojas do Perfil numa autorização do Google (`oauth_connection.discovery_notes`):
 * `ok` (com quantas lojas, que pode ser zero); `limite`, a cota acabou ou o Google ainda não liberou o acesso do Liame
 * à API (até lá a cota é zero); `sem_permissao`, o Google recusou a leitura; `falhou`, o resto.
 */
export const RESULTADOS_DA_PROCURA = ['ok', 'limite', 'sem_permissao', 'falhou'] as const;
export type ResultadoDaProcura = (typeof RESULTADOS_DA_PROCURA)[number];
export type ProcuraDoPerfil = { resultado: ResultadoDaProcura; em: string; lojas: number };

/** A falha da procura, pelo tipo do erro do conector (nulo = erro que não veio do conector). */
export function falhaDaProcura(tipo: TipoErroConector | null): Exclude<ResultadoDaProcura, 'ok'> {
  if (tipo === 'limite') return 'limite';
  if (tipo === 'permissao') return 'sem_permissao';
  return 'falhou';
}

/** A anotação da procura como está guardada: só o que tem o formato certo vale (o resto é "não procurou"). */
export function procuraGuardada(notas: unknown): ProcuraDoPerfil | null {
  const n = notas && typeof notas === 'object' ? (notas as Record<string, unknown>)[PROVEDOR_PERFIL_GOOGLE] : null;
  if (!n || typeof n !== 'object') return null;
  const { resultado, em, lojas } = n as Record<string, unknown>;
  if (typeof resultado !== 'string' || !(RESULTADOS_DA_PROCURA as readonly string[]).includes(resultado)) return null;
  if (typeof em !== 'string' || Number.isNaN(new Date(em).getTime())) return null;
  return { resultado: resultado as ResultadoDaProcura, em, lojas: typeof lojas === 'number' && Number.isInteger(lojas) && lojas >= 0 ? lojas : 0 };
}

/** A situação da resposta, como o Google a diz (`ReviewReplyState`), em palavras do Liame. */
export const SITUACOES_DA_RESPOSTA = ['pendente', 'aprovada', 'recusada', 'desconhecida'] as const;
export type SituacaoDaResposta = (typeof SITUACOES_DA_RESPOSTA)[number];

export type RespostaLida = {
  texto: string;
  /** Quando a resposta foi escrita ou mudada, se o Google disser. */
  atualizadaEm: string | null;
  /** `pendente`: o Google ainda confere; `recusada`: ele não publicou; `aprovada`: está no ar. */
  situacao: SituacaoDaResposta;
  /** Por que o Google recusou a resposta (`policyViolation`), como código; nulo quando ele não diz. */
  violacao: string | null;
};

export type AvaliacaoLida = {
  /** O id da avaliação no Google (`reviewId`). */
  id: string;
  estrelas: 1 | 2 | 3 | 4 | 5;
  /** O que a pessoa escreveu; nulo quando ela só deu a nota. */
  texto: string | null;
  criadaEm: string;
  atualizadaEm: string;
  resposta: RespostaLida | null;
};

/** O tamanho que o Liame aceita guardar de um texto de avaliação e de uma resposta (a resposta do Google vai até 4.096 bytes). */
export const TAMANHO_DO_TEXTO = 5000;

const ESTRELAS: Record<string, AvaliacaoLida['estrelas']> = { ONE: 1, TWO: 2, THREE: 3, FOUR: 4, FIVE: 5 };
const SITUACAO: Record<string, SituacaoDaResposta> = { PENDING: 'pendente', APPROVED: 'aprovada', REJECTED: 'recusada' };
const LETRAS_DE_CODIGO = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ_';

const texto = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim().slice(0, TAMANHO_DO_TEXTO) : null);
/** Um instante que o Google mandou (RFC 3339), de volta em ISO; nulo se não é uma data. */
const instante = (v: unknown): string | null => {
  if (typeof v !== 'string' || v.length > 40) return null;
  const ms = Date.parse(v);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
};
/** Um código do Google (letras maiúsculas e sublinhado), conferido letra a letra; o que não é código vira nulo. */
const codigo = (v: unknown): string | null => (typeof v === 'string' && v.length >= 2 && v.length <= 60 && [...v].every((c) => LETRAS_DE_CODIGO.includes(c)) ? v : null);

/**
 * Uma avaliação como a API a devolve vira o que o Liame guarda. Nula quando falta o que identifica ou classifica a
 * avaliação (o id, a nota de 1 a 5 ou as datas): essa não entra. O `reviewer` (nome, foto) e as fotos anexadas são
 * ignorados de propósito.
 */
export function avaliacaoDoGoogle(bruta: unknown): AvaliacaoLida | null {
  if (!bruta || typeof bruta !== 'object') return null;
  const r = bruta as Record<string, unknown>;
  const id = typeof r.reviewId === 'string' && r.reviewId.length >= 1 && r.reviewId.length <= 200 ? r.reviewId : null;
  const estrelas = typeof r.starRating === 'string' ? ESTRELAS[r.starRating] : undefined;
  const criadaEm = instante(r.createTime);
  const atualizadaEm = instante(r.updateTime) ?? criadaEm;
  if (!id || !estrelas || !criadaEm || !atualizadaEm) return null;
  const resposta = r.reviewReply && typeof r.reviewReply === 'object' ? (r.reviewReply as Record<string, unknown>) : null;
  const textoDaResposta = resposta ? texto(resposta.comment) : null;
  return {
    id,
    estrelas,
    texto: texto(r.comment),
    criadaEm,
    atualizadaEm,
    // A resposta sem texto não é uma resposta.
    resposta:
      resposta && textoDaResposta
        ? {
            texto: textoDaResposta,
            atualizadaEm: instante(resposta.updateTime),
            situacao: typeof resposta.reviewReplyState === 'string' ? (SITUACAO[resposta.reviewReplyState] ?? 'desconhecida') : 'desconhecida',
            violacao: codigo(resposta.policyViolation),
          }
        : null,
  };
}

/** A nota média que o Google informa da loja, de 1 a 5; nula quando não vem ou não faz sentido. */
export function notaMedia(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v >= 1 && v <= 5 ? Math.round(v * 100) / 100 : null;
}

/** Quantas avaliações a loja tem no Google; nulo quando não vem. */
export function totalDeAvaliacoes(v: unknown): number | null {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 100_000_000 ? v : null;
}

// ---------------------------------------------------------------- os números do perfil

/**
 * As métricas do perfil que o Liame lê (`DailyMetric`, conferidas na referência em 11/10/2026) e o nome de cada uma no
 * Liame. As impressões contam uma por pessoa por dia. `BUSINESS_CONVERSATIONS` e `BUSINESS_FOOD_ORDERS` estão
 * descontinuadas e ficam de fora.
 */
export const METRICAS_DO_PERFIL: ReadonlyArray<readonly [string, string]> = [
  ['BUSINESS_IMPRESSIONS_DESKTOP_MAPS', 'profile_views_maps_desktop'],
  ['BUSINESS_IMPRESSIONS_DESKTOP_SEARCH', 'profile_views_search_desktop'],
  ['BUSINESS_IMPRESSIONS_MOBILE_MAPS', 'profile_views_maps_mobile'],
  ['BUSINESS_IMPRESSIONS_MOBILE_SEARCH', 'profile_views_search_mobile'],
  ['BUSINESS_DIRECTION_REQUESTS', 'direction_requests'],
  ['CALL_CLICKS', 'call_clicks'],
  ['WEBSITE_CLICKS', 'website_clicks'],
  ['BUSINESS_BOOKINGS', 'bookings'],
  ['BUSINESS_FOOD_MENU_CLICKS', 'menu_clicks'],
];
/** Os nomes que este conector pode devolver. */
export const METRICAS_CANONICAS_DO_PERFIL = METRICAS_DO_PERFIL.map(([, nome]) => nome);

export type PontoDoPerfil = { dia: string; metrica: string; valor: number };

const doisDigitos = (n: number) => String(n).padStart(2, '0');

/** A data como o Google a manda (`{ year, month, day }`) em AAAA-MM-DD; nula se falta o dia (seria um mês) ou não é data. */
function diaDoGoogle(d: unknown): string | null {
  if (!d || typeof d !== 'object') return null;
  const { year, month, day } = d as { year?: unknown; month?: unknown; day?: unknown };
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return null;
  const [a, m, dia] = [year as number, month as number, day as number];
  if (a < 2000 || a > 2100 || m < 1 || m > 12 || dia < 1 || dia > 31) return null;
  const iso = `${a}-${doisDigitos(m)}-${doisDigitos(dia)}`;
  return new Date(`${iso}T00:00:00Z`).toISOString().slice(0, 10) === iso ? iso : null;
}

/** O valor de um dia: texto com um inteiro; **ausente quando é zero** (é assim que a API manda). */
function valorDoDia(v: unknown): number | null {
  if (v === undefined || v === null) return 0;
  if (typeof v !== 'string' && typeof v !== 'number') return null;
  const s = String(v);
  if (s.length === 0 || s.length > 15 || [...s].some((c) => c < '0' || c > '9')) return null;
  return Number(s);
}

/**
 * Os números do perfil por dia, da resposta de `fetchMultiDailyMetricsTimeSeries`. Só entram os dias que o Google
 * mandou: o dia que não veio ainda não foi fechado por ele, e não vira zero. O dia que veio sem valor é zero. A
 * métrica desconhecida, o detalhamento por subtipo e o que está fora da janela pedida ficam de fora.
 */
export function numerosDoPerfil(resposta: unknown, janela: { inicio: string; fim: string }): PontoDoPerfil[] {
  const series = (resposta as { multiDailyMetricTimeSeries?: unknown } | null)?.multiDailyMetricTimeSeries;
  if (!Array.isArray(series)) return [];
  const pontos = new Map<string, PontoDoPerfil>();
  for (const grupo of series) {
    const linhas = (grupo as { dailyMetricTimeSeries?: unknown } | null)?.dailyMetricTimeSeries;
    if (!Array.isArray(linhas)) continue;
    for (const linha of linhas) {
      const l = linha as { dailyMetric?: unknown; dailySubEntityType?: unknown; timeSeries?: { datedValues?: unknown } } | null;
      const nome = METRICAS_DO_PERFIL.find(([doGoogle]) => doGoogle === l?.dailyMetric)?.[1];
      // Com detalhamento (por dia da semana, por hora), a linha é um recorte da métrica: o total é a linha sem ele.
      if (!nome || l?.dailySubEntityType !== undefined) continue;
      const valores = l?.timeSeries?.datedValues;
      if (!Array.isArray(valores)) continue;
      for (const v of valores) {
        const dia = diaDoGoogle((v as { date?: unknown } | null)?.date);
        const valor = valorDoDia((v as { value?: unknown } | null)?.value);
        if (!dia || valor === null || dia < janela.inicio || dia > janela.fim) continue;
        pontos.set(`${dia}/${nome}`, { dia, metrica: nome, valor });
      }
    }
  }
  return [...pontos.values()].sort((a, b) => (a.dia === b.dia ? a.metrica.localeCompare(b.metrica) : a.dia < b.dia ? -1 : 1));
}
