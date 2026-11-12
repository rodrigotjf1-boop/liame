// O público nas redes (plano da região, R4, parte 3; D-RG-40 a D-RG-43; base §19.7): o que o Instagram e a Página do
// Facebook da marca dizem da conta inteira, não de um post — os seguidores e como mudam, os toques nos botões do perfil,
// as visitas à Página e de que cidades são os seguidores do Instagram. Contas puras, sem banco nem rede: a rotina do
// worker (`worker/regiao-publico.service.ts`) chama a Graph API e grava; o retrato (`regiao.service.ts`) lê. Nada de
// pessoa: a Meta só entrega somas da conta, e nenhum seguidor aparece por nome.

/** O conjunto do `sync_state` desta leitura (uma linha por conta do Instagram ou Página ligada). */
export const DATASET_DO_PUBLICO = 'regiao_publico';
/** Uma leitura por dia (D-RG-42): a Meta atualiza os números da conta uma vez por dia (até 48 h no Instagram). */
export const INTERVALO_DO_PUBLICO_MIN = 24 * 60;
/** A cidade dos seguidores é relida uma vez por semana (D-RG-40). */
export const DIAS_DAS_CIDADES = 7;
/** O Instagram só informa quem seguiu e deixou de seguir e a cidade a partir de 100 seguidores. */
export const MINIMO_DE_SEGUIDORES = 100;
/** As cidades que o Instagram informa (as 45 maiores) e as que a seção mostra. */
export const CIDADES_DO_INSTAGRAM = 45;
export const CIDADES_NA_SECAO = 5;

/** As métricas da Página, por dia (base §19.7; a cidade da Página saiu em 15/11/2025). */
export const METRICAS_DA_PAGINA_NA_REGIAO = ['page_daily_follows_unique', 'page_daily_unfollows_unique', 'page_views_total'] as const;

/** Os toques nos botões do perfil do Instagram, pelo botão (`contact_button_type`). */
export type ToquesDoPerfil = { como_chegar: number; ligar: number; mensagem: number; outros: number };
/** Uma cidade dos seguidores, como o Instagram escreve ("Rio de Janeiro, Rio de Janeiro"). */
export type CidadeDoPublico = { cidade: string; seguidores: number };

const inteiroNaoNegativo = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : Number.NaN;
  return Number.isFinite(n) && n >= 0 ? Math.trunc(n) : null;
};

/** O `followers_count` do nó (o Instagram ou a Página); nulo fora do formato. */
export function seguidoresDoNo(corpo: unknown): number | null {
  return inteiroNaoNegativo((corpo as { followers_count?: unknown } | null)?.followers_count);
}

/** A métrica pedida na resposta de `/insights` (a lista `data`); nula quando não veio. */
function metricaDaResposta(corpo: unknown, nome: string): Record<string, unknown> | null {
  const data = (corpo as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) return null;
  const m = (data as Array<Record<string, unknown> | null>).find((x) => x?.name === nome);
  return m ?? null;
}

/**
 * Os valores de uma métrica `total_value` com uma quebra (o primeiro elemento de `dimension_values` de cada resultado →
 * o valor). Nulo quando a métrica não veio (a conta com menos de 100 seguidores, por exemplo).
 */
export function porQuebra(corpo: unknown, nome: string): Map<string, number> | null {
  const m = metricaDaResposta(corpo, nome);
  const total = m?.total_value as { value?: unknown; breakdowns?: unknown } | undefined;
  if (!total) return null;
  const mapa = new Map<string, number>();
  const quebras = Array.isArray(total.breakdowns) ? (total.breakdowns as Array<{ results?: unknown } | null>) : [];
  for (const q of quebras) {
    for (const r of Array.isArray(q?.results) ? (q.results as Array<{ dimension_values?: unknown; value?: unknown } | null>) : []) {
      const chave = Array.isArray(r?.dimension_values) && typeof r.dimension_values[0] === 'string' ? r.dimension_values[0] : null;
      const valor = inteiroNaoNegativo(r?.value);
      if (chave !== null && valor !== null) mapa.set(chave, (mapa.get(chave) ?? 0) + valor);
    }
  }
  return mapa;
}

/** Quem seguiu (`FOLLOWER`) e quem deixou de seguir (`NON_FOLLOWER`) na janela; nulo sem a métrica. */
export function seguiramEDeixaram(corpo: unknown): { seguiram: number; deixaram: number } | null {
  const q = porQuebra(corpo, 'follows_and_unfollows');
  if (!q) return null;
  return { seguiram: q.get('FOLLOWER') ?? 0, deixaram: q.get('NON_FOLLOWER') ?? 0 };
}

/** Os toques nos botões do perfil na janela, por botão; nulo sem a métrica. */
export function toquesDoPerfil(corpo: unknown): ToquesDoPerfil | null {
  const q = porQuebra(corpo, 'profile_links_taps');
  if (!q) return null;
  const t: ToquesDoPerfil = { como_chegar: 0, ligar: 0, mensagem: 0, outros: 0 };
  for (const [botao, n] of q) {
    if (botao === 'DIRECTION') t.como_chegar += n;
    else if (botao === 'CALL') t.ligar += n;
    else if (botao === 'TEXT') t.mensagem += n;
    else t.outros += n;
  }
  return t;
}

/** As cidades dos seguidores (`follower_demographics` com `breakdown=city`), da maior para a menor, até 45. */
export function cidadesDosSeguidores(corpo: unknown): CidadeDoPublico[] | null {
  const q = porQuebra(corpo, 'follower_demographics');
  if (!q) return null;
  return [...q]
    .filter(([cidade, n]) => cidade.trim().length > 0 && cidade.length <= 200 && n > 0)
    .map(([cidade, seguidores]) => ({ cidade: cidade.trim(), seguidores }))
    .sort((a, b) => b.seguidores - a.seguidores || a.cidade.localeCompare(b.cidade, 'pt-BR'))
    .slice(0, CIDADES_DO_INSTAGRAM);
}

/** A soma dos valores diários de uma métrica da Página (`period=day`) na janela; nula quando a métrica não veio. */
export function somaDaPagina(corpo: unknown, nome: string): number | null {
  const m = metricaDaResposta(corpo, nome);
  if (!m || !Array.isArray(m.values)) return null;
  let soma = 0;
  for (const v of m.values as Array<{ value?: unknown } | null>) soma += inteiroNaoNegativo(v?.value) ?? 0;
  return soma;
}

/** O deslocamento do fuso, em minutos, num instante ("GMT-03:00" → -180). */
function deslocamentoMin(instante: Date, fuso: string): number {
  const parte = new Intl.DateTimeFormat('en-US', { timeZone: fuso, timeZoneName: 'longOffset' }).formatToParts(instante).find((p) => p.type === 'timeZoneName')?.value ?? 'GMT';
  const m = /GMT([+-])(\d{2}):(\d{2})/.exec(parte);
  return m ? (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3])) : 0;
}

/** O começo do dia "AAAA-MM-DD" no fuso, em segundos Unix (o `since`/`until` da Graph API). */
export function inicioDoDiaEmSegundos(dia: string, fuso: string): number {
  const meiaNoiteUtc = Date.parse(`${dia}T00:00:00Z`);
  return Math.floor((meiaNoiteUtc - deslocamentoMin(new Date(meiaNoiteUtc + 12 * 3_600_000), fuso) * 60_000) / 1000);
}

/** A janela das 4 semanas até ontem em segundos: do começo do primeiro dia ao começo de hoje, no fuso. */
export function janelaEmSegundos(janela: { inicio: string; fim: string }, fuso: string): { since: number; until: number } {
  const hoje = new Date(Date.parse(`${janela.fim}T12:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
  return { since: inicioDoDiaEmSegundos(janela.inicio, fuso), until: inicioDoDiaEmSegundos(hoje, fuso) };
}

/** A cidade sem o estado ("Rio de Janeiro, Rio de Janeiro" → "Rio de Janeiro"). */
export function nomeDaCidade(cidade: string): string {
  return cidade.split(',')[0]!.trim() || cidade.trim();
}

const semAcento = (s: string): string =>
  s
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .trim();

/** A cidade do Instagram é o município da loja (pelo nome, sem acento nem caixa)? */
export function ehOMunicipio(cidade: string, municipio: string | null): boolean {
  return municipio !== null && semAcento(nomeDaCidade(cidade)) === semAcento(municipio);
}

/** A parte de `n` sobre o total, em porcento inteiro; nula sem total. */
export const parteDe = (n: number, total: number | null): number | null => (total && total > 0 ? Math.round((n * 100) / total) : null);

/** A espera depois de uma falha, pelo tipo (a mesma régua da mídia na região). */
export function esperaDaFalhaDoPublico(tipo: string, esperarMs: number | null): number {
  const HORA = 3_600_000;
  if (tipo === 'permissao' || tipo === 'autenticacao') return 24 * HORA;
  if (tipo === 'limite') return Math.max(esperarMs ?? 0, HORA);
  if (tipo === 'definitivo') return 6 * HORA;
  return HORA;
}

/** A cidade é relida quando nunca foi lida ou foi lida há 7 dias ou mais. */
export function cidadesDevidas(lidasEm: Date | string | null, agora: Date): boolean {
  if (lidasEm === null) return true;
  return agora.getTime() - new Date(lidasEm).getTime() >= DIAS_DAS_CIDADES * 86_400_000 - 3_600_000;
}

/** Uma conta conectada da marca e a última leitura dela (nula: ainda não lida), como o retrato lê do banco. */
export type LinhaDoPublico = {
  provider: string;
  name: string;
  day_from: string | null;
  day_to: string | null;
  followers: string | number | null;
  follows: string | number | null;
  unfollows: string | number | null;
  taps: ToquesDoPerfil | null;
  page_views: string | number | null;
  cities: CidadeDoPublico[] | null;
  cities_read_at: Date | string | null;
  read_at: Date | string | null;
  /** Os seguidores na série do Liame no começo da janela (ou antes); nulo sem a série. */
  base: string | number | null;
};

const numeroOuNulo = (v: string | number | null): number | null => (v === null ? null : Number(v));
const iso = (v: Date | string): string => (v instanceof Date ? v : new Date(v)).toISOString();

/** A mudança na janela: quem seguiu menos quem saiu; sem isso, os seguidores de agora menos os da série no começo. */
function mudanca(seguidores: number | null, seguiram: number | null, deixaram: number | null, base: number | null): number | null {
  if (seguiram !== null && deixaram !== null) return seguiram - deixaram;
  return seguidores !== null && base !== null ? seguidores - base : null;
}

/** O bloco do Instagram no retrato. */
function doInstagram(l: LinhaDoPublico & { read_at: Date | string }, municipio: string | null) {
  const seguidores = numeroOuNulo(l.followers);
  const seguiram = numeroOuNulo(l.follows);
  const deixaram = numeroOuNulo(l.unfollows);
  const t = l.taps;
  const cidades = (l.cities ?? []).slice(0, CIDADES_NA_SECAO).map((c) => ({
    name: nomeDaCidade(c.cidade),
    full_name: c.cidade,
    followers: c.seguidores,
    followers_pct: parteDe(c.seguidores, seguidores),
    store_city: ehOMunicipio(c.cidade, municipio),
  }));
  return {
    name: l.name,
    read_at: iso(l.read_at),
    followers: seguidores,
    follows: seguiram,
    unfollows: deixaram,
    followers_change: mudanca(seguidores, seguiram, deixaram, numeroOuNulo(l.base)),
    taps: t ? { total: t.como_chegar + t.ligar + t.mensagem + t.outros, directions: t.como_chegar, call: t.ligar, message: t.mensagem, other: t.outros } : null,
    cities_status: seguidores !== null && seguidores < MINIMO_DE_SEGUIDORES ? 'poucos_seguidores' : l.cities_read_at === null ? 'lendo' : 'disponivel',
    cities: cidades,
  };
}

/** O bloco da Página no retrato. */
function daPagina(l: LinhaDoPublico & { read_at: Date | string }) {
  const seguidores = numeroOuNulo(l.followers);
  const seguiram = numeroOuNulo(l.follows);
  const deixaram = numeroOuNulo(l.unfollows);
  return {
    name: l.name,
    read_at: iso(l.read_at),
    followers: seguidores,
    follows: seguiram,
    unfollows: deixaram,
    followers_change: mudanca(seguidores, seguiram, deixaram, numeroOuNulo(l.base)),
    views: numeroOuNulo(l.page_views),
  };
}

/**
 * O público nas redes no retrato: a primeira conta de cada rede (a mais recente lida). Sem conta conectada, `sem_redes`;
 * conectada sem nenhuma leitura, `lendo`. A janela é a da leitura mais nova.
 */
export function retratoDoPublico(linhas: readonly LinhaDoPublico[], municipio: string | null) {
  if (!linhas.length) return { status: 'sem_redes' as const, publico: null };
  const lidas = linhas.filter((l): l is LinhaDoPublico & { read_at: Date | string; day_from: string; day_to: string } => l.read_at !== null && l.day_from !== null && l.day_to !== null);
  if (!lidas.length) return { status: 'lendo' as const, publico: null };
  const primeira = (provider: string) => lidas.filter((l) => l.provider === provider).sort((a, b) => iso(b.read_at).localeCompare(iso(a.read_at)))[0] ?? null;
  const ig = primeira('instagram');
  const pg = primeira('facebook_page');
  const maisNova = [ig, pg].filter((l) => l !== null).sort((a, b) => iso(b.read_at).localeCompare(iso(a.read_at)))[0]!;
  return {
    status: 'disponivel' as const,
    publico: {
      from: maisNova.day_from,
      to: maisNova.day_to,
      instagram: ig ? doInstagram(ig, municipio) : null,
      page: pg ? daPagina(pg) : null,
    },
  };
}
