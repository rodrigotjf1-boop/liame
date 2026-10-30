// Os números de cada post nas redes (A6, Z7, parte c; D-A6-16 e as decisões técnicas D-A6-50 a D-A6-52): o alcance, as
// visualizações e as interações de cada canal publicado, lidos da Meta como apoio (o resultado do post é o pedido pelo
// link dele). Funções puras: as métricas que se pedem a cada rede, a leitura da resposta e a próxima leitura. A conta
// segue as páginas oficiais conferidas em 29/10/2026 (base de conhecimento §2.2).

/** Os números de um canal, com o nome do Liame; nulo o que a rede não dá (o Instagram não tem cliques; a Página, salvos). */
export type NumerosDoPost = {
  /** As vezes em que o post foi visto (Instagram `views`; Página `post_media_view`). */
  views: number | null;
  /** As pessoas (contas) diferentes que viram, estimado pela rede (Instagram `reach`; Página `post_total_media_view_unique`). */
  reach: number | null;
  likes: number | null;
  comments: number | null;
  shares: number | null;
  saves: number | null;
  clicks: number | null;
  /** As reações da Página, somadas por tipo (curtir, amei, uau…). */
  reactions: number | null;
};

/** As métricas do post do feed no Instagram (`GET /{ig-media-id}/insights`). */
export const METRICAS_DO_INSTAGRAM = ['views', 'reach', 'likes', 'comments', 'saved', 'shares'] as const;
/** As métricas do post da Página (`GET /{page-post-id}/insights`). */
export const METRICAS_DA_PAGINA = ['post_media_view', 'post_total_media_view_unique', 'post_clicks', 'post_reactions_by_type_total'] as const;

/** Por quantos dias depois de sair o post é lido (depois disso, fica o último número lido). */
export const DIAS_DE_LEITURA = 30;
/** De quanto em quanto tempo o post é lido de novo: a Página atualiza uma vez por dia, e o Instagram atrasa até 48 horas. */
export const INTERVALO_DE_LEITURA_H = 24;
/** A primeira leitura, depois de o post sair. */
export const PRIMEIRA_LEITURA_MIN = 60;
/** A próxima tentativa depois de uma falha passageira (a rede fora do ar, o limite de chamadas). */
export const NOVA_TENTATIVA_MIN = 60;

const HORA_MS = 3_600_000;
const DIA_MS = 24 * HORA_MS;

/** Inteiro não negativo, ou nulo. */
const inteiro = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.round(v) : null);

/**
 * O valor de uma métrica da resposta (`data[]`, cada uma com `name` e `values[0].value` ou `total_value.value`): o
 * número; o objeto por tipo (as reações da Página) vira a soma dos números dele.
 */
function valorDe(item: Record<string, unknown>): number | null {
  const valores = Array.isArray(item.values) ? (item.values as Array<Record<string, unknown> | null>) : [];
  const total = item.total_value && typeof item.total_value === 'object' ? (item.total_value as Record<string, unknown>).value : undefined;
  const v = valores[0]?.value ?? total;
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    const partes = Object.values(v as Record<string, unknown>).map(inteiro).filter((n): n is number => n !== null);
    return partes.length ? partes.reduce((a, b) => a + b, 0) : null;
  }
  return inteiro(v);
}

/** As métricas da resposta, pelo nome; vazia quando a rede ainda não tem o dado (ela manda lista vazia, não zero). */
function metricas(resposta: unknown): Map<string, number | null> {
  const data = (resposta as { data?: unknown } | null)?.data;
  const m = new Map<string, number | null>();
  if (!Array.isArray(data)) return m;
  for (const item of data as Array<Record<string, unknown> | null>) {
    if (item && typeof item.name === 'string') m.set(item.name, valorDe(item));
  }
  return m;
}

const vazio = (): NumerosDoPost => ({ views: null, reach: null, likes: null, comments: null, shares: null, saves: null, clicks: null, reactions: null });
const temAlgum = (n: NumerosDoPost) => Object.values(n).some((v) => v !== null);

/** Os números do post do Instagram; nulo quando a resposta não tem nenhum (o dado ainda não chegou). */
export function numerosDoInstagram(resposta: unknown): NumerosDoPost | null {
  const m = metricas(resposta);
  const n = { ...vazio(), views: m.get('views') ?? null, reach: m.get('reach') ?? null, likes: m.get('likes') ?? null, comments: m.get('comments') ?? null, shares: m.get('shares') ?? null, saves: m.get('saved') ?? null };
  return temAlgum(n) ? n : null;
}

/** Os números do post da Página; nulo quando a resposta não tem nenhum (a Página com menos de 100 curtidas não tem). */
export function numerosDaPagina(resposta: unknown): NumerosDoPost | null {
  const m = metricas(resposta);
  const n = { ...vazio(), views: m.get('post_media_view') ?? null, reach: m.get('post_total_media_view_unique') ?? null, clicks: m.get('post_clicks') ?? null, reactions: m.get('post_reactions_by_type_total') ?? null };
  return temAlgum(n) ? n : null;
}

/** A próxima leitura do canal: a cada 24 horas, até 30 dias depois de o post sair; depois, nenhuma (nulo). */
export function proximaLeitura(publicadoEm: Date, agora: Date): Date | null {
  const fim = publicadoEm.getTime() + DIAS_DE_LEITURA * DIA_MS;
  if (agora.getTime() >= fim) return null;
  return new Date(Math.min(agora.getTime() + INTERVALO_DE_LEITURA_H * HORA_MS, fim));
}
