import { INSTAGRAM_MEDIA_LIMIT } from '@liame/contracts';
import { horaDoInstagram } from '../connectors/meta/publicacao.js';
import { DIAS_DE_LEITURA } from '../posts/numeros-do-post.js';

// "Do seu Instagram" (A6 · Z10, parte 5; D-A6-71 e D-A6-83): o que a loja já publicou na conta do Instagram ligada à
// marca, lido uma vez por dia. Funções puras: o que se pede à Meta, a leitura da lista e quando reler os números. A
// referência seguida é a do objeto de mídia do Instagram (`developers.facebook.com/docs/instagram-platform/reference/
// instagram-media`, lida em 07/11/2026): `media_product_type` (`AD`, `FEED`, `STORY`, `REELS`) e `caption` só pela
// API com o login do Facebook, que é o do Liame; `media_url` não vem quando o vídeo tem áudio protegido ou licenciado
// (a música do Instagram); `thumbnail_url` só no vídeo; `like_count` some quando a conta esconde as curtidas.

/** O conjunto da leitura em `sync_state`. */
export const DATASET_DO_INSTAGRAM = 'instagram_publicacoes';
/** Uma leitura por dia: os números chegam com até 48 horas de atraso, e a lista é do que a própria loja publica. */
export const INTERVALO_DO_INSTAGRAM_MIN = 1440;
/** Os campos da lista (`GET /{ig-user-id}/media`). */
export const CAMPOS_DA_LISTA = 'id,caption,media_type,media_product_type,media_url,permalink,thumbnail_url,timestamp,like_count,comments_count';

/** O tipo da publicação no Liame. */
export type TipoDaPublicacao = 'reels' | 'foto' | 'carrossel' | 'video';

/** Uma publicação lida da lista, pronta para gravar. */
export type PublicacaoDoInstagram = {
  media_id: string;
  kind: TipoDaPublicacao;
  caption: string;
  permalink: string | null;
  thumbnail_url: string | null;
  has_file: boolean;
  published_at: string;
  likes: number | null;
  comments: number | null;
};

const LEGENDA_MAX = 2200;
const ENDERECO_MAX = 500;
const MINIATURA_MAX = 2000;
const ID_MAX = 40;

/**
 * O tipo pela resposta: o Reels pelo `media_product_type`; o resto pelo `media_type`. O Story e o anúncio ficam de
 * fora (nulo): "Do seu Instagram" mostra o que está no perfil.
 */
export function tipoDaPublicacao(mediaType: unknown, produto: unknown): TipoDaPublicacao | null {
  if (produto === 'STORY' || produto === 'AD') return null;
  if (produto === 'REELS') return 'reels';
  if (mediaType === 'CAROUSEL_ALBUM') return 'carrossel';
  if (mediaType === 'VIDEO') return 'video';
  if (mediaType === 'IMAGE') return 'foto';
  return null;
}

/** Um endereço `https` dentro do tamanho; senão, nulo. */
function endereco(v: unknown, maximo: number): string | null {
  if (typeof v !== 'string' || v.length > maximo) return null;
  try {
    const u = new URL(v);
    return u.protocol === 'https:' && !u.username && !u.password ? v : null;
  } catch {
    return null;
  }
}

/** Contagem inteira e não negativa; senão, nulo (a conta que esconde as curtidas não manda o campo). */
function contagem(v: unknown): number | null {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : null;
}

/**
 * Texto sem o caractere nulo e sem metade de par de surrogates (o Postgres não guarda nenhum dos dois, como em
 * `orders/regem-leitura.ts`), cortado no limite sem partir um emoji ao meio. Os comentários (Z11) usam a mesma.
 */
export function textoGuardavel(v: unknown, maximo: number): string {
  if (typeof v !== 'string') return '';
  const limpo = v.replaceAll('\u0000', '').toWellFormed();
  let saida = '';
  for (const letra of limpo) {
    if (saida.length + letra.length > maximo) break;
    saida += letra;
  }
  return saida;
}

/**
 * As publicações da resposta da lista (`data[]`), as mais novas primeiro, até o limite do Liame. A que não tem id, data
 * ou tipo que o Liame mostra fica de fora (V43: o que o banco recusaria nem chega à gravação).
 */
export function publicacoesDaLista(resposta: unknown): PublicacaoDoInstagram[] {
  const data = (resposta as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) return [];
  const vistas = new Set<string>();
  const lista: PublicacaoDoInstagram[] = [];
  for (const item of data) {
    if (!item || typeof item !== 'object') continue;
    const m = item as Record<string, unknown>;
    const id = typeof m.id === 'string' ? m.id : '';
    if (!id || id.length > ID_MAX || vistas.has(id)) continue;
    const kind = tipoDaPublicacao(m.media_type, m.media_product_type);
    const hora = horaDoInstagram(m.timestamp);
    if (!kind || Number.isNaN(hora)) continue;
    const ehVideo = kind === 'reels' || kind === 'video';
    const arquivo = endereco(m.media_url, MINIATURA_MAX);
    vistas.add(id);
    lista.push({
      media_id: id,
      kind,
      caption: textoGuardavel(m.caption, LEGENDA_MAX),
      permalink: endereco(m.permalink, ENDERECO_MAX),
      // A miniatura: a capa no vídeo; a própria imagem na foto (no carrossel, a Meta manda a da primeira).
      thumbnail_url: ehVideo ? endereco(m.thumbnail_url, MINIATURA_MAX) : arquivo,
      has_file: arquivo !== null,
      published_at: new Date(hora).toISOString(),
      likes: contagem(m.like_count),
      comments: contagem(m.comments_count),
    });
    if (lista.length >= INSTAGRAM_MEDIA_LIMIT) break;
  }
  return lista;
}

/**
 * Os números da publicação se releem a cada leitura nos primeiros 30 dias (como os do post do Liame, D-A6-51) e uma vez
 * para a que nunca foi lida; depois, ficam os últimos lidos (as curtidas e os comentários seguem vindo na lista).
 */
export function releDosNumeros(publicadaEm: string, numerosLidosEm: string | null, agora: Date): boolean {
  if (!numerosLidosEm) return true;
  return agora.getTime() - Date.parse(publicadaEm) < DIAS_DE_LEITURA * 24 * 3_600_000;
}

/** Quanto esperar depois de uma falha da leitura: sem permissão, um dia; cota, a espera pedida ou 1 hora; o resto, 1 hora (definitivo, 6). */
export function esperaDaFalhaDoInstagram(tipo: string, esperarMs: number | null): number {
  const HORA = 3_600_000;
  if (tipo === 'permissao' || tipo === 'autenticacao') return 24 * HORA;
  if (tipo === 'limite') return Math.max(esperarMs ?? 0, HORA);
  if (tipo === 'definitivo') return 6 * HORA;
  return HORA;
}
