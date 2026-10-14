// O Search Console (A6, Z3; base de conhecimento §3.3): o que o Liame tira das respostas da API, sem rede e sem banco.
// Duas leituras: os sites que a autorização alcança e as buscas no Google que levaram a um site (cliques, vezes em
// que ele apareceu e a posição média), por dia ou por busca. **Só leitura** (critério A6-6): o Liame não tem escrita
// no Search Console, e a permissão pedida é a de só leitura.
//
// O que o Google devolve são contagens do site, sem dado de pessoa: a busca feita por poucas pessoas nunca aparece
// como linha (ela só entra no total quando a leitura não separa por busca). Por isso a soma das buscas fica abaixo do
// total do dia, e as duas leituras não se misturam.

import { MAX_URL_LIDA } from '../tipos.js';

/** A permissão de só leitura do Search Console. Só entra na autorização da empresa com a função ligada, como a do Perfil (D-A6-17). */
export const ESCOPO_SEARCH_CONSOLE = 'https://www.googleapis.com/auth/webmasters.readonly';
/** O código do site do Search Console entre as contas ligadas (`connected_account.provider`). */
export const PROVEDOR_SEARCH_CONSOLE = 'search_console';

/** O tamanho máximo do endereço do site (o mesmo das outras URLs lidas). */
const TAMANHO_DO_SITE = MAX_URL_LIDA;
/** O tamanho máximo de um nome de domínio. */
const TAMANHO_DO_DOMINIO = 253;
/** O tamanho máximo de uma busca guardada: a mais comprida fica de fora, nunca cortada (duas buscas cortadas iguais virariam uma). */
export const TAMANHO_DA_BUSCA = 500;

/**
 * Até onde a empresa pode ver os dados do site no Search Console. O relatório de desempenho abre para os três; quem
 * não verificou o site não vê dado nenhum, e o site fica de fora da lista.
 */
export type PermissaoNoSite = 'dono' | 'completo' | 'restrito';
/** As duas grafias do Google (a da referência e a do documento de descoberta da API). */
const PERMISSOES: Record<string, PermissaoNoSite> = {
  siteOwner: 'dono',
  SITE_OWNER: 'dono',
  siteFullUser: 'completo',
  SITE_FULL_USER: 'completo',
  siteRestrictedUser: 'restrito',
  SITE_RESTRICTED_USER: 'restrito',
};

export type SiteDoSearchConsole = {
  /** O site como o Google o escreve: `sc-domain:exemplo.com` (o domínio inteiro) ou `https://www.exemplo.com/` (um começo de endereço). */
  site: string;
  /** Como a tela mostra: o domínio, ou o endereço sem o `https://` e sem a barra do fim. */
  nome: string;
  permissao: PermissaoNoSite;
};

const ehLetraOuDigito = (c: string) => (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9');

/** Um nome de domínio em minúsculas: letras, dígitos, hífen e ponto, com ao menos um ponto e sem ponto ou hífen nas pontas de cada parte. */
function dominioValido(d: string): boolean {
  if (d.length < 3 || d.length > TAMANHO_DO_DOMINIO) return false;
  const partes = d.split('.');
  if (partes.length < 2) return false;
  for (const p of partes) {
    if (p.length === 0 || p.length > 63) return false;
    if (!ehLetraOuDigito(p[0]!) || !ehLetraOuDigito(p[p.length - 1]!)) return false;
    for (const c of p) if (!ehLetraOuDigito(c) && c !== '-') return false;
  }
  return true;
}

const PREFIXO_DE_DOMINIO = 'sc-domain:';

/**
 * O site como o Google o escreve, conferido antes de ir para o caminho do endereço: o domínio inteiro
 * (`sc-domain:exemplo.com`) ou um começo de endereço `http`/`https` sem usuário, senha, consulta nem âncora, terminado
 * em barra e já na forma canônica. Qualquer outra coisa é nula.
 */
export function siteValido(v: unknown): string | null {
  if (typeof v !== 'string' || v.length === 0 || v.length > TAMANHO_DO_SITE) return null;
  if (v.startsWith(PREFIXO_DE_DOMINIO)) return dominioValido(v.slice(PREFIXO_DE_DOMINIO.length)) ? v : null;
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  if (u.username || u.password || u.search || u.hash || !u.pathname.endsWith('/')) return null;
  if (u.href !== v || !dominioValido(u.hostname)) return null;
  return v;
}

/** O nome do site para a tela: `exemplo.com`, ou `www.exemplo.com/cardapio` (sem o esquema e sem a barra do fim). */
export function nomeDoSite(site: string): string {
  if (site.startsWith(PREFIXO_DE_DOMINIO)) return site.slice(PREFIXO_DE_DOMINIO.length);
  const u = new URL(site);
  return u.pathname === '/' ? u.host : `${u.host}${u.pathname.slice(0, -1)}`;
}

/** O site no caminho do endereço da API: codificado inteiro (`sc-domain%3Aexemplo.com`, `https%3A%2F%2Fwww.exemplo.com%2F`). */
export function siteNoCaminho(site: string): string {
  return encodeURIComponent(site);
}

/**
 * Os sites da resposta de `sites.list` que a empresa pode ler: os que ela verificou (dono) ou em que foi incluída
 * (completo ou restrito). O site sem verificação, o endereço que não confere e o repetido ficam de fora.
 */
export function sitesDoGoogle(corpo: unknown): SiteDoSearchConsole[] {
  const lista = (corpo as { siteEntry?: unknown } | null)?.siteEntry;
  if (!Array.isArray(lista)) return [];
  const vistos = new Set<string>();
  const sites: SiteDoSearchConsole[] = [];
  for (const item of lista) {
    const e = item as { siteUrl?: unknown; permissionLevel?: unknown } | null;
    const site = siteValido(e?.siteUrl);
    const permissao = typeof e?.permissionLevel === 'string' ? PERMISSOES[e.permissionLevel] : undefined;
    if (!site || !permissao || vistos.has(site)) continue;
    vistos.add(site);
    sites.push({ site, nome: nomeDoSite(site), permissao });
  }
  return sites;
}

/** Cliques e vezes em que o site apareceu (contagens) e a posição média dele nas buscas (1 é o primeiro lugar). */
export type NumerosDaBusca = { cliques: number; vezes: number; posicao: number | null };
export type DiaDaBusca = NumerosDaBusca & { dia: string };
export type BuscaLida = NumerosDaBusca & { busca: string };

const contagem = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.round(v) : null);
const posicao = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= 1 ? v : null);

/** Os números de uma linha do Google, ou nulo quando a contagem não confere (a linha fica de fora, nunca vira zero). */
function numerosDaLinha(l: { clicks?: unknown; impressions?: unknown; position?: unknown }): NumerosDaBusca | null {
  const cliques = contagem(l.clicks);
  const vezes = contagem(l.impressions);
  if (cliques === null || vezes === null || cliques > vezes) return null;
  return { cliques, vezes, posicao: vezes > 0 ? posicao(l.position) : null };
}

type Linha = { keys?: unknown; clicks?: unknown; impressions?: unknown; position?: unknown };
const linhasDa = (corpo: unknown): Linha[] => {
  const rows = (corpo as { rows?: unknown } | null)?.rows;
  return Array.isArray(rows) ? (rows as Linha[]) : [];
};
const primeiraChave = (l: Linha): unknown => (Array.isArray(l.keys) ? l.keys[0] : undefined);

/** "2026-10-09" de verdade (o mês 13 e o dia 32 não passam). */
function diaValido(v: unknown): v is string {
  if (typeof v !== 'string' || v.length !== 10 || v[4] !== '-' || v[7] !== '-') return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

/**
 * Os números do site por dia (a leitura agrupada por `date`), só os dias da janela pedida, do mais antigo ao mais
 * novo. O dia em que o site não apareceu não vem na resposta, e o Liame não o inventa.
 */
export function diasDoGoogle(corpo: unknown, janela: { inicio: string; fim: string }): DiaDaBusca[] {
  const porDia = new Map<string, DiaDaBusca>();
  for (const l of linhasDa(corpo)) {
    const dia = primeiraChave(l);
    if (!diaValido(dia) || dia < janela.inicio || dia > janela.fim || porDia.has(dia)) continue;
    const n = numerosDaLinha(l);
    if (n) porDia.set(dia, { dia, ...n });
  }
  return [...porDia.values()].sort((a, b) => (a.dia < b.dia ? -1 : 1));
}

/**
 * As buscas que levaram ao site (a leitura agrupada por `query`), na ordem do Google (mais cliques primeiro), até
 * `maximo`. A busca vazia, a comprida demais e a repetida ficam de fora; o texto é o que a pessoa buscou, sem os
 * espaços das pontas.
 */
export function buscasDoGoogle(corpo: unknown, maximo: number): BuscaLida[] {
  const vistas = new Set<string>();
  const buscas: BuscaLida[] = [];
  for (const l of linhasDa(corpo)) {
    if (buscas.length >= maximo) break;
    const bruta = primeiraChave(l);
    const busca = typeof bruta === 'string' ? bruta.trim() : '';
    if (!busca || busca.length > TAMANHO_DA_BUSCA || vistas.has(busca)) continue;
    const n = numerosDaLinha(l);
    if (!n) continue;
    vistas.add(busca);
    buscas.push({ busca, ...n });
  }
  return buscas;
}
