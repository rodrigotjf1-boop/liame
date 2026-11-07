import { createHash } from 'node:crypto';
import { enderecoNaPagina, horaDoInstagram, idDoPostDaPagina } from '../connectors/meta/publicacao.js';
import { publicacoesDaLista, textoGuardavel } from '../fotos/do-seu-instagram.js';

// Comentários (A6 · Z11, parte 1; protótipo P38, D-A6-84 a D-A6-94): a leitura dos comentários dos posts dos últimos 30
// dias do Instagram e da Página ligados à marca. Funções puras: o que se pede à Meta, a leitura das respostas, a fila de
// cada post e o tipo do comentário pela regra. As referências seguidas (base de conhecimento §2.2, lidas em 07/11/2026):
//   - Instagram, `GET /{ig-media-id}/comments` (`…/instagram-graph-api/reference/ig-media/comments`): até 50 por consulta,
//     do mais novo para o mais velho; só os de primeiro nível (as respostas pelo campo `replies`); sem filtro por data;
//   - o comentário do Instagram (`…/reference/ig-comment`): `id`, `text`, `timestamp`, `username` (com a permissão
//     `instagram_manage_comments`), `from` (o `id` de quem comentou, o IGSID, e o `username`), `like_count`, `hidden`,
//     `parent_id` e `replies`;
//   - Página, `GET /{page-id}/posts` (`…/graph-api/reference/page/feed`): até 100 por consulta, com o agendado e o
//     rascunho (`is_published`); e `GET /{page-post-id}/comments` (`…/docs/pages-api/comments-mentions` e
//     `…/graph-api/reference/object/comments`): com o token da Página de quem pode MODERATE; `filter=stream` traz todos os
//     níveis, com o `parent`; o `from` (o nome e o id) não tem regra escrita de quando vem: o pior caso é não vir (V125).

/** A função da empresa (desligada; antes de ligar, o texto da Política, V172). */
export const FLAG_DOS_COMENTARIOS = 'comentarios';
/** O conjunto da leitura em `sync_state` (uma linha por conta: o Instagram e a Página). */
export const DATASET_DOS_COMENTARIOS = 'comentarios';
/** A conta é lida a cada 15 minutos (D-A6-85); o post de 8 a 30 dias, de hora em hora (`postDevido`). */
export const INTERVALO_DOS_COMENTARIOS_MIN = 15;
/** Os posts lidos: os publicados nos últimos 30 dias. */
export const DIAS_DOS_POSTS = 30;
/** O post de até 7 dias é lido a cada vez da conta. */
export const DIAS_DA_LEITURA_RAPIDA = 7;
/**
 * O post de 8 a 30 dias, de hora em hora: relido quando a última leitura dele tem 55 minutos ou mais (a conta é lida a
 * cada 15; com 60, a leitura das 11h que começa um instante antes da hora cheia ficaria para as 11h15).
 */
export const RELEITURA_LENTA_MIN = 55;
/** O máximo de páginas de comentários lidas de um post por vez (50 no Instagram, 100 na Página, cada uma). */
export const PAGINAS_POR_POST = 10;
export const POR_PAGINA_NO_INSTAGRAM = 50;
export const POR_PAGINA_NA_PAGINA = 100;
/** O comentário guardado sai 90 dias depois de feito (D-A6-86; o expurgo `comentario` do worker). */
export const DIAS_DO_COMENTARIO = 90;

/** Os campos do comentário do Instagram, com as respostas (até 50 de cada um). */
export const CAMPOS_DO_COMENTARIO_NO_INSTAGRAM = 'id,text,timestamp,username,from,like_count,hidden,replies.limit(50){id,text,timestamp,username,from,like_count,hidden}';
/** Os campos do comentário da Página (`filter=stream`: todos os níveis, com o `parent`). */
export const CAMPOS_DO_COMENTARIO_NA_PAGINA = 'id,message,created_time,from,like_count,comment_count,is_hidden,parent{id}';
/** Os campos do post da Página. */
export const CAMPOS_DO_POST_DA_PAGINA = 'id,created_time,message,permalink_url,full_picture,is_published';

export type CanalDoComentario = 'instagram' | 'facebook';
export type TipoDoComentario = 'pergunta' | 'reclamacao' | 'elogio' | 'marcacao' | 'ofensivo' | 'golpe';

/** Um post lido, pronto para gravar. */
export type PostComentado = {
  post_id: string;
  channel: CanalDoComentario;
  kind: string | null;
  caption: string;
  permalink: string | null;
  thumbnail_url: string | null;
  published_at: string;
  comment_count: number | null;
};

/** Um comentário lido, pronto para gravar. */
export type ComentarioLido = {
  comment_id: string;
  parent_comment_id: string | null;
  author_name: string | null;
  author_key: string | null;
  by_brand: boolean;
  message: string;
  published_at: string;
  like_count: number | null;
  reply_count: number | null;
  hidden: boolean;
  kind: TipoDoComentario | null;
};

/** Uma página da lista de comentários: os lidos, o cursor da próxima e se alguma lista de respostas ficou pela metade. */
export type PaginaDeComentarios = { comentarios: ComentarioLido[]; proxima: string | null; respostasIncompletas: boolean };

const TEXTO_MAX = 8000;
const AUTOR_MAX = 200;
const ID_MAX = 120;
const DIA_MS = 24 * 3_600_000;

const textoOuNulo = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);
const contagem = (v: unknown): number | null => (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : null);
/** Id da rede: texto de 1 a 120 caracteres, só com dígitos e `_` (o comentário da Página é `{post}_{comentário}`). */
function idDaRede(v: unknown): string | null {
  if (typeof v !== 'string' || v.length === 0 || v.length > ID_MAX) return null;
  for (const c of v) if ((c < '0' || c > '9') && c !== '_') return null;
  return v;
}

/**
 * O resumo do id de quem comentou (SHA-256, hexadecimal): só para não responder duas vezes à mesma pessoa no mesmo post.
 * Sem o id, pelo @; sem nenhum dos dois, nulo.
 */
export function chaveDoAutor(canal: CanalDoComentario, id: string | null, usuario: string | null): string | null {
  const base = id ? `${canal}:${id}` : usuario ? `${canal}:@${usuario.toLowerCase()}` : null;
  return base ? createHash('sha256').update(base).digest('hex') : null;
}

/** Os posts do Instagram publicados nos últimos 30 dias, da lista da conta (a mesma leitura de "Do seu Instagram"). */
export function postsDoInstagram(resposta: unknown, agora: Date): PostComentado[] {
  const desde = agora.getTime() - DIAS_DOS_POSTS * DIA_MS;
  return publicacoesDaLista(resposta)
    .filter((p) => Date.parse(p.published_at) >= desde)
    .map((p) => ({
      post_id: p.media_id,
      channel: 'instagram',
      kind: p.kind,
      caption: p.caption,
      permalink: p.permalink,
      thumbnail_url: p.thumbnail_url,
      published_at: p.published_at,
      comment_count: p.comments,
    }));
}

/** Um endereço `https` de imagem da Meta, dentro do tamanho; senão, nulo. */
function imagem(v: unknown): string | null {
  if (typeof v !== 'string' || v.length > 2000) return null;
  try {
    const u = new URL(v);
    return u.protocol === 'https:' && !u.username && !u.password ? v : null;
  } catch {
    return null;
  }
}

/**
 * Os posts publicados da Página nos últimos 30 dias, da resposta de `GET /{page-id}/posts`. O agendado e o rascunho
 * (`is_published` falso) ficam de fora; o que não tem id ou data também (V43).
 */
export function postsDaPagina(resposta: unknown, agora: Date): PostComentado[] {
  const data = (resposta as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) return [];
  const desde = agora.getTime() - DIAS_DOS_POSTS * DIA_MS;
  const vistos = new Set<string>();
  const lista: PostComentado[] = [];
  for (const item of data) {
    if (!item || typeof item !== 'object') continue;
    const p = item as Record<string, unknown>;
    const id = idDoPostDaPagina(p.id);
    const hora = horaDoInstagram(p.created_time);
    if (!id || vistos.has(id) || Number.isNaN(hora) || hora < desde || p.is_published === false) continue;
    vistos.add(id);
    lista.push({
      post_id: id,
      channel: 'facebook',
      kind: null,
      caption: textoGuardavel(p.message, 2200),
      permalink: enderecoNaPagina(p.permalink_url),
      thumbnail_url: imagem(p.full_picture),
      published_at: new Date(hora).toISOString(),
      comment_count: null,
    });
  }
  return lista;
}

/** O post entra nesta leitura? Até 7 dias, sempre; de 8 a 30, de hora em hora; o nunca lido e o "Ler agora", sempre. */
export function postDevido(publicadoEm: string, lidoEm: string | null, agora: Date, tudo: boolean): boolean {
  if (tudo || !lidoEm) return true;
  if (agora.getTime() - Date.parse(publicadoEm) <= DIAS_DA_LEITURA_RAPIDA * DIA_MS) return true;
  return agora.getTime() - Date.parse(lidoEm) >= RELEITURA_LENTA_MIN * 60_000;
}

/** O cursor da próxima página (`paging.cursors.after`), só quando a rede diz que há mais (`paging.next`). */
function proximaPagina(resposta: unknown): string | null {
  const paging = (resposta as { paging?: { next?: unknown; cursors?: { after?: unknown } } } | null)?.paging;
  if (!paging || typeof paging.next !== 'string') return null;
  const after = paging.cursors?.after;
  return typeof after === 'string' && after.length > 0 && after.length <= 500 ? after : null;
}

type ContaDaLeitura = { id: string; usuario: string | null };

/** Um comentário do Instagram (o de primeiro nível ou a resposta), ou nulo quando falta o id ou a data. */
function doInstagram(m: Record<string, unknown>, pai: string | null, conta: ContaDaLeitura): ComentarioLido | null {
  const id = idDaRede(m.id);
  const hora = horaDoInstagram(m.timestamp);
  if (!id || Number.isNaN(hora)) return null;
  const de = m.from && typeof m.from === 'object' ? (m.from as Record<string, unknown>) : {};
  const quemId = textoOuNulo(de.id);
  const usuario = textoOuNulo(m.username) ?? textoOuNulo(de.username);
  const daMarca = (quemId !== null && quemId === conta.id) || (usuario !== null && conta.usuario !== null && usuario.toLowerCase() === conta.usuario.toLowerCase());
  const texto = textoGuardavel(m.text, TEXTO_MAX);
  return {
    comment_id: id,
    parent_comment_id: pai,
    author_name: usuario ? usuario.slice(0, AUTOR_MAX) : null,
    author_key: chaveDoAutor('instagram', quemId, usuario),
    by_brand: daMarca,
    message: texto,
    published_at: new Date(hora).toISOString(),
    like_count: contagem(m.like_count),
    reply_count: null,
    hidden: m.hidden === true,
    kind: pai === null && !daMarca ? tipoPorRegra(texto, conta.usuario) : null,
  };
}

/**
 * Uma página da lista de comentários de um post do Instagram (`data[]`, cada um com as respostas em `replies.data[]`).
 * A lista de respostas que diz que tem mais (`replies.paging.next`) marca `respostasIncompletas`: as respostas daquele post
 * que não vieram não são tiradas do Liame.
 */
export function comentariosDoInstagram(resposta: unknown, conta: ContaDaLeitura): PaginaDeComentarios {
  const data = (resposta as { data?: unknown } | null)?.data;
  const comentarios: ComentarioLido[] = [];
  let respostasIncompletas = false;
  if (!Array.isArray(data)) return { comentarios, proxima: null, respostasIncompletas };
  const vistos = new Set<string>();
  for (const item of data) {
    if (!item || typeof item !== 'object') continue;
    const m = item as Record<string, unknown>;
    const c = doInstagram(m, null, conta);
    if (!c || vistos.has(c.comment_id)) continue;
    vistos.add(c.comment_id);
    const replies = m.replies && typeof m.replies === 'object' ? (m.replies as { data?: unknown; paging?: { next?: unknown } }) : null;
    const filhas = Array.isArray(replies?.data) ? (replies.data as unknown[]) : [];
    if (typeof replies?.paging?.next === 'string') respostasIncompletas = true;
    let lidas = 0;
    const respostas: ComentarioLido[] = [];
    for (const f of filhas) {
      if (!f || typeof f !== 'object') continue;
      const r = doInstagram(f as Record<string, unknown>, c.comment_id, conta);
      if (!r || vistos.has(r.comment_id)) continue;
      vistos.add(r.comment_id);
      respostas.push(r);
      lidas += 1;
    }
    comentarios.push({ ...c, reply_count: lidas }, ...respostas);
  }
  return { comentarios, proxima: proximaPagina(resposta), respostasIncompletas };
}

/**
 * Uma página da lista de comentários de um post da Página (`filter=stream`: todos os níveis, cada resposta com o
 * `parent`). Sem o `from`, o comentário vem sem o nome e sem a chave (o pior caso, V125); o da própria Página é da marca.
 */
export function comentariosDaPagina(resposta: unknown, paginaId: string): PaginaDeComentarios {
  const data = (resposta as { data?: unknown } | null)?.data;
  const comentarios: ComentarioLido[] = [];
  if (!Array.isArray(data)) return { comentarios, proxima: null, respostasIncompletas: false };
  const vistos = new Set<string>();
  for (const item of data) {
    if (!item || typeof item !== 'object') continue;
    const m = item as Record<string, unknown>;
    const id = idDaRede(m.id);
    const hora = horaDoInstagram(m.created_time);
    if (!id || vistos.has(id) || Number.isNaN(hora)) continue;
    vistos.add(id);
    const de = m.from && typeof m.from === 'object' ? (m.from as Record<string, unknown>) : {};
    const quemId = textoOuNulo(de.id);
    const nome = textoOuNulo(de.name);
    const pai = m.parent && typeof m.parent === 'object' ? idDaRede((m.parent as Record<string, unknown>).id) : null;
    const daMarca = quemId !== null && quemId === paginaId;
    const texto = textoGuardavel(m.message, TEXTO_MAX);
    comentarios.push({
      comment_id: id,
      parent_comment_id: pai,
      author_name: nome ? nome.slice(0, AUTOR_MAX) : null,
      author_key: chaveDoAutor('facebook', quemId, null),
      by_brand: daMarca,
      message: texto,
      published_at: new Date(hora).toISOString(),
      like_count: contagem(m.like_count),
      reply_count: contagem(m.comment_count),
      hidden: m.is_hidden === true,
      kind: pai === null && !daMarca ? tipoPorRegra(texto, null) : null,
    });
  }
  return { comentarios, proxima: proximaPagina(resposta), respostasIncompletas: false };
}

// ---- O tipo pela regra (D-A6-87) ------------------------------------------------------------------------------------
// A regra decide o que é claro; o resto fica sem tipo (nulo) e, na parte seguinte, vai para a IA com o modelo econômico.
// Ordem: golpe, reclamação, ofensivo, marcação, pergunta, elogio. A reclamação vem antes do ofensivo: a reclamação com
// palavrão continua pedindo resposta (ocultar uma reclamação legítima esconderia o problema). Sem expressão regular: o
// texto é de fora (V41, V116).

const LINKS = ['http://', 'https://', 'www.', 'wa.me/', 'bit.ly/', 't.me/', 'linktr.ee'];
const DOMINIOS = ['.com', '.net', '.site', '.online', '.shop', '.store', '.link', '.ly/'];
const GOLPE = [
  'ganhe seguidores', 'seguidores gratis', 'renda extra', 'trabalhe de casa', 'ganhar dinheiro', 'bitcoin', 'cripto', 'forex',
  'pix premiado', 'link na bio', 'clique no link', 'divulgue seu', 'divulgacao paga', 'promova sua', 'chama no direct', 'chama no dm',
];
const RECLAMACAO_FRASES = [
  'veio sem', 'nao chegou', 'nunca chegou', 'nunca mais', 'dinheiro de volta', 'passei mal', 'salgado demais', 'mal atendido',
  'veio errado', 'veio frio', 'pedido errado', 'nao recomendo',
];
const RECLAMACAO = new Set([
  'demorou', 'demora', 'atrasou', 'atrasado', 'atraso', 'frio', 'fria', 'errado', 'errada', 'faltou', 'faltando', 'pessimo', 'pessima',
  'horrivel', 'ruim', 'decepcao', 'decepcionado', 'decepcionada', 'cancelaram', 'cancelado', 'reembolso', 'estorno', 'intoxicacao',
  'cabelo', 'cru', 'crua', 'queimado', 'queimada', 'grosseria', 'grosso', 'grossa', 'descaso', 'vergonha', 'reclamacao', 'procon',
]);
const OFENSAS = new Set([
  'lixo', 'merda', 'porra', 'caralho', 'bosta', 'idiota', 'otario', 'otaria', 'imbecil', 'vagabundo', 'vagabunda', 'fdp', 'vsf',
  'pqp', 'arrombado', 'arrombada', 'desgraca', 'desgracado', 'desgracada', 'nojento', 'nojenta', 'babaca',
]);
const PERGUNTA_INICIO = new Set(['quanto', 'quantos', 'quantas', 'qual', 'quais', 'onde', 'quando', 'como', 'voces', 'vcs']);
const PERGUNTA_FRASES = [
  'que horas', 'qual o valor', 'qual o preco', 'quanto custa', 'tem delivery', 'faz entrega', 'fazem entrega', 'aceita pix',
  'aceitam pix', 'aceita cartao', 'ta aberto', 'esta aberto', 'abre hoje', 'abrem hoje',
];
const ELOGIO = new Set([
  'delicia', 'delicioso', 'deliciosa', 'top', 'maravilhoso', 'maravilhosa', 'perfeito', 'perfeita', 'amei', 'amo', 'melhor',
  'sensacional', 'show', 'incrivel', 'espetacular', 'gostoso', 'gostosa', 'parabens', 'sucesso', 'lindo', 'linda', 'brabo', 'braba',
]);
const ELOGIO_FRASES = ['muito bom', 'bom demais', 'top demais', 'que delicia'];
const EMOJIS_BONS = new Set([
  0x2764, 0x2728, 0x1f60d, 0x1f525, 0x1f44f, 0x1f60b, 0x1f924, 0x1f4af, 0x1f64c, 0x1f44d, 0x1f970, 0x1f63b, 0x1f49b, 0x1f9e1,
  0x1f49a, 0x1f499, 0x1f49c, 0x1f929, 0x1f600, 0x1f601, 0x1f603, 0x1f604, 0x1f618, 0x1f496, 0x1f497, 0x1f493, 0x1f495, 0x1f60a,
  0x1f642, 0x1f602, 0x1f923, 0x1f44c,
]);
const EMOJIS_RUINS = new Set([0x1f621, 0x1f92c, 0x1f44e, 0x1f92e, 0x1f922, 0x1f624, 0x1f620, 0x1f612, 0x1f61e, 0x1f494]);

/** Minúsculas e sem acento (as marcas de acento, U+0300 a U+036F, saem depois da decomposição). */
function normalizado(texto: string): string {
  let s = '';
  for (const ch of texto.normalize('NFD')) {
    const c = ch.codePointAt(0) ?? 0;
    if (c >= 0x300 && c <= 0x36f) continue;
    s += ch.toLowerCase();
  }
  return s;
}

const ehLetraOuDigito = (ch: string): boolean => (ch >= '0' && ch <= '9') || ch.toLowerCase() !== ch.toUpperCase();
const ehDoUsuario = (ch: string): boolean => (ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9') || ch === '.' || ch === '_';

type Partes = { palavras: string[]; mencoes: string[]; bons: number; ruins: number; interrogacao: boolean };

/** As palavras, os @ (sem o da marca), os emojis bons e ruins e se tem ponto de interrogação, numa passada. */
function partesDo(t: string, usuarioDaMarca: string | null): Partes {
  const p: Partes = { palavras: [], mencoes: [], bons: 0, ruins: 0, interrogacao: false };
  const marca = usuarioDaMarca ? normalizado(usuarioDaMarca) : null;
  const letras = [...t];
  let i = 0;
  while (i < letras.length) {
    const ch = letras[i]!;
    if (ch === '@') {
      let u = '';
      i += 1;
      while (i < letras.length && ehDoUsuario(letras[i]!)) u += letras[i++];
      if (u && u !== marca) p.mencoes.push(u);
      continue;
    }
    if (ehLetraOuDigito(ch)) {
      let w = '';
      while (i < letras.length && ehLetraOuDigito(letras[i]!)) w += letras[i++];
      p.palavras.push(w);
      continue;
    }
    const c = ch.codePointAt(0) ?? 0;
    if (ch === '?') p.interrogacao = true;
    else if (EMOJIS_BONS.has(c)) p.bons += 1;
    else if (EMOJIS_RUINS.has(c)) p.ruins += 1;
    i += 1;
  }
  return p;
}

/** Um domínio no texto (`algo.com`, `algo.shop`): a letra antes e o fim, o espaço, a barra ou o ponto depois. */
function temDominio(t: string): boolean {
  for (const d of DOMINIOS) {
    let k = t.indexOf(d);
    while (k >= 0) {
      const depois = t[k + d.length];
      if (k > 0 && ehLetraOuDigito(t[k - 1]!) && (depois === undefined || depois === ' ' || depois === '/' || depois === '.' || d.endsWith('/'))) return true;
      k = t.indexOf(d, k + 1);
    }
  }
  return false;
}

const algumaFrase = (t: string, frases: readonly string[]): boolean => frases.some((f) => t.includes(f));
const algumaPalavra = (palavras: readonly string[], lista: ReadonlySet<string>): boolean => palavras.some((w) => lista.has(w));

/**
 * O tipo do comentário de primeiro nível, pela regra (D-A6-87), ou nulo quando a regra não decide. `usuarioDaMarca`: o @
 * da conta do Instagram (marcar a própria marca não é marcação de amigo).
 */
export function tipoPorRegra(texto: string, usuarioDaMarca: string | null): TipoDoComentario | null {
  const t = normalizado(texto.slice(0, 2200)).trim();
  if (!t) return null;
  const p = partesDo(t, usuarioDaMarca);
  if (LINKS.some((l) => t.includes(l)) || temDominio(t) || algumaFrase(t, GOLPE)) return 'golpe';
  if (algumaFrase(t, RECLAMACAO_FRASES) || algumaPalavra(p.palavras, RECLAMACAO)) return 'reclamacao';
  if (p.palavras.length === 0 && p.mencoes.length === 0 && p.ruins > 0 && p.bons === 0) return 'reclamacao';
  if (algumaPalavra(p.palavras, OFENSAS)) return 'ofensivo';
  if (p.mencoes.length > 0 && p.palavras.length <= 4) return 'marcacao';
  if (p.interrogacao || PERGUNTA_INICIO.has(p.palavras[0] ?? '') || algumaFrase(t, PERGUNTA_FRASES)) return 'pergunta';
  if (algumaPalavra(p.palavras, ELOGIO) || algumaFrase(t, ELOGIO_FRASES)) return 'elogio';
  if (p.palavras.length === 0 && p.bons > 0) return 'elogio';
  return null;
}
