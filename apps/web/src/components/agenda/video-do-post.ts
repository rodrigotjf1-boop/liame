import { type BrandPhoto, fitsInstagramReels, type PostResponse, pageVideoFormat } from '@liame/contracts';
import { deitado, duracaoCurta, duracaoPorExtenso } from '@/components/fotos/textos';

// O vídeo no novo post (A6, Z10, parte 4a; P37, parte B, aprovado pelo dono em 04/11/2026; D-A6-68 a D-A6-70). Funções
// puras, sem a tela: o que é vídeo, o que cabe no Reels (a mesma conta do servidor, nos contratos: V74), como sai em cada
// canal, os quadros da capa e os textos do P37.

/** O que o post leva: a foto ou o vídeo. */
export type MidiaDoPost = 'foto' | 'video';

/** O vídeo pronto das Fotos e vídeos, com o bloco do vídeo (sem ele, a lista não sabe a duração nem as medidas gravadas). */
export type VideoDasFotos = BrandPhoto & { video: NonNullable<BrandPhoto['video']> };

export const ehVideoPronto = (f: BrandPhoto): f is VideoDasFotos => f.kind === 'video' && Boolean(f.video);

/** As medidas como a loja gravou (as que o Reels confere; as de `width`/`height` são as do Reels, já reduzidas). */
const gravado = (v: VideoDasFotos) => ({ width: v.video.width, height: v.video.height });

/** O vídeo vai ao Reels do Instagram como está (até 1.920 px de largura e 25 Mbps; a redução do maior ainda não existe)? */
export const cabeNoInstagram = (v: VideoDasFotos): boolean => fitsInstagramReels(v.video.width, v.bytes, v.video.duration_ms);

/** Como o vídeo sai na Página: `reels` (em pé, a partir de 540 × 960) ou `video` (o vídeo comum). */
export const comoSaiNaPagina = (v: VideoDasFotos): 'reels' | 'video' => pageVideoFormat(v.video.width, v.video.height);

export const videoDeitado = (v: VideoDasFotos): boolean => deitado(gravado(v));

/**
 * Os quadros que a tela oferece para a capa (D-A6-70; P37: no começo, a um quarto, no meio, a três quartos e perto do
 * fim). O do meio (o terceiro) é a capa guardada com o vídeo, e vem marcado.
 */
export const PARTES_DOS_QUADROS = [0, 0.25, 0.5, 0.75, 0.95] as const;
export const QUADRO_DO_MEIO = 2;

/** O tempo de cada quadro, em milissegundos (o do meio é a metade, a mesma conta da capa guardada e do servidor). */
export function temposDosQuadros(duracaoMs: number): number[] {
  return PARTES_DOS_QUADROS.map((p) => Math.round(duracaoMs * p));
}

/** A capa no novo post: um quadro do vídeo (pelo índice) ou uma das Fotos (pelo id). */
export type CapaDoNovo = { modo: 'quadro'; quadro: number } | { modo: 'foto'; foto: string | null };

/**
 * O que vai no pedido para a capa: a foto (`cover_photo_id`); o quadro escolhido (`cover_offset_ms`); ou nada, para o
 * quadro do meio, que é a capa guardada com o vídeo (sem ela, o servidor usa o quadro do meio do mesmo jeito).
 */
export function capaNoPedido(capa: CapaDoNovo, v: VideoDasFotos): { cover_photo_id?: string; cover_offset_ms?: number } {
  if (capa.modo === 'foto') return capa.foto ? { cover_photo_id: capa.foto } : {};
  if (capa.quadro === QUADRO_DO_MEIO) return {};
  const t = temposDosQuadros(v.video.duration_ms)[capa.quadro];
  return t === undefined ? {} : { cover_offset_ms: t };
}

/** A capa como a tela a mostra: a imagem pronta (a foto, a capa guardada) ou o quadro do próprio vídeo, pelo tempo. */
export type CapaNaTela = { imagem: string } | { video: string; tempoMs: number };

export function capaNaTela(capa: CapaDoNovo, v: VideoDasFotos, fotos: readonly BrandPhoto[]): CapaNaTela {
  if (capa.modo === 'foto') {
    const f = fotos.find((x) => x.id === capa.foto);
    if (f) return { imagem: f.thumbnail_url };
  }
  const quadro = capa.modo === 'quadro' ? capa.quadro : QUADRO_DO_MEIO;
  if (quadro === QUADRO_DO_MEIO && v.video.has_cover) return { imagem: v.thumbnail_url };
  return { video: v.url, tempoMs: temposDosQuadros(v.video.duration_ms)[quadro] ?? 0 };
}

/** O endereço do vídeo num tempo (o fragmento de mídia `#t=`, em segundos), para o navegador mostrar aquele quadro. */
export function videoNoTempo(url: string, tempoMs: number): string {
  // O primeiro quadro (0 s) pode vir preto em alguns navegadores: um décimo de segundo depois.
  const s = Math.max(0.1, tempoMs / 1000);
  return `${url}#t=${s.toFixed(1)}`;
}

/** O nome do vídeo na lista, para quem usa leitor de tela (P37): o produto, o que aparece, a duração e a posição. */
export function rotuloDoVideoNoPost(v: VideoDasFotos): string {
  const nome = v.product ?? 'Sem produto';
  const desc = v.description ? `: ${v.description}` : '';
  return `${nome}${desc}, ${duracaoPorExtenso(v.video.duration_ms)}, ${videoDeitado(v) ? 'deitado' : 'em pé'}`;
}

export const duracaoDoVideo = (v: VideoDasFotos) => duracaoCurta(v.video.duration_ms);

/** O aviso do vídeo deitado no novo post (P37). */
export const AVISO_DO_DEITADO =
  'Este vídeo está deitado. No Instagram, ele sai assim mesmo, mas o Reels é feito para vídeo em pé (9:16); na Página do Facebook, sai como vídeo comum.';

/** O nome e a dica de cada canal do Liame no post com vídeo (P37). */
export function canalNoVideo(canal: string, v: VideoDasFotos | null): { nome: string; dica: string } | null {
  if (canal === 'instagram') {
    if (v && !cabeNoInstagram(v)) {
      return {
        nome: 'Instagram, como Reels',
        dica: 'Este vídeo passa do que o Reels do Instagram aceita como está (até 1.920 px de largura). Por enquanto, ele sai só na Página: o Liame ainda não reduz o vídeo.',
      };
    }
    return { nome: 'Instagram, como Reels', dica: 'Pode aparecer no Feed e na aba Reels.' };
  }
  if (canal === 'facebook') {
    return v && comoSaiNaPagina(v) === 'video'
      ? {
          nome: 'Página do Facebook, como vídeo',
          dica: videoDeitado(v)
            ? 'Deitado, ele sai como vídeo comum: o Reels da Página só aceita vídeo em pé.'
            : 'Pequeno para o Reels da Página (a partir de 540 × 960): sai como vídeo comum.',
        }
      : { nome: 'Página do Facebook, como Reels', dica: 'O mesmo vídeo, com o texto da Página.' };
  }
  return null;
}

/** Os canais do pacote (o TikTok e o YouTube) ainda não levam vídeo: o porquê, ao lado deles. */
export const PACOTE_SEM_VIDEO = 'No vídeo, o pacote do TikTok e do YouTube chega numa próxima parte: por enquanto, só o Instagram e a Página.';

/** A dica da capa (P37), pelo modo. */
export function dicaDaCapa(modo: CapaDoNovo['modo']): string {
  return modo === 'quadro'
    ? 'Vem marcado o quadro do meio. A capa é o que aparece antes de o vídeo tocar.'
    : 'No Instagram, a foto vira a capa do Reels, recortada em pé no centro. Na Página do Facebook, a capa é a que a Meta escolhe.';
}

/** O nome de cada quadro (o tempo), para o botão. */
export const rotuloDoQuadro = (tempoMs: number) => `Quadro de ${duracaoCurta(tempoMs)}`;

// ---- O post com vídeo já feito: em Aprovações e na Agenda (A6, Z10, parte 4b; P37, parte B) ----------------------------

/** O post leva um vídeo (o servidor manda `media` só no post com vídeo). */
export const ehPostComVideo = (p: Pick<PostResponse, 'media'>): boolean => p.media === 'video';

type CapaDoPostFeito = Pick<PostResponse, 'cover_photo_id' | 'cover_offset_ms'>;

/**
 * A capa do post como ele foi pedido: uma das Fotos (`cover_photo_id`, quando ela ainda está na lista), o quadro escolhido
 * pelo tempo (`cover_offset_ms`) ou a capa guardada com o vídeo (sem ela, o quadro do meio, como o servidor faz).
 */
export function capaDoPost(post: CapaDoPostFeito, v: VideoDasFotos, capaFoto: BrandPhoto | null): CapaNaTela {
  if (post.cover_photo_id && capaFoto) return { imagem: capaFoto.thumbnail_url };
  if (typeof post.cover_offset_ms === 'number') return { video: v.url, tempoMs: post.cover_offset_ms };
  if (v.video.has_cover) return { imagem: v.thumbnail_url };
  return { video: v.url, tempoMs: temposDosQuadros(v.video.duration_ms)[QUADRO_DO_MEIO] ?? 0 };
}

/** De onde vem a capa, em palavras: "uma das Fotos (Smash duplo)", "o quadro de 0:05", "a capa guardada com o vídeo". */
export function deOndeVemACapa(post: CapaDoPostFeito, v: VideoDasFotos, capaFoto: BrandPhoto | null): string {
  if (post.cover_photo_id) return capaFoto?.product ? `uma das Fotos (${capaFoto.product})` : 'uma das Fotos';
  if (typeof post.cover_offset_ms === 'number') return `o quadro de ${duracaoCurta(post.cover_offset_ms)}`;
  return v.video.has_cover ? 'a capa guardada com o vídeo' : `o quadro de ${duracaoCurta(temposDosQuadros(v.video.duration_ms)[QUADRO_DO_MEIO] ?? 0)}`;
}

/** O fato do vídeo na gaveta do post (P37): "Smash duplo, 18 segundos, em pé; a capa: o quadro de 0:05". */
export function fatoDoVideo(post: CapaDoPostFeito, v: VideoDasFotos, capaFoto: BrandPhoto | null): string {
  return `${v.product ?? 'Sem produto'}, ${duracaoPorExtenso(v.video.duration_ms)}, ${videoDeitado(v) ? 'deitado' : 'em pé'}; a capa: ${deOndeVemACapa(post, v, capaFoto)}`;
}

/** O que foi conferido do vídeo, no pedido em Aprovações (P37): o vídeo como a loja gravou, como sai na Página e a capa. */
export function conferidoDoVideo(post: CapaDoPostFeito, v: VideoDasFotos, capaFoto: BrandPhoto | null): string {
  const pagina =
    comoSaiNaPagina(v) === 'reels'
      ? 'Está em pé (9:16): sai como Reels.'
      : videoDeitado(v)
        ? 'Está deitado: na Página, sai como vídeo comum.'
        : 'É pequeno para o Reels da Página (a partir de 540 × 960): lá, sai como vídeo comum.';
  return `O vídeo é um dos vídeos da tela Fotos, como a loja gravou: sem edição e sem imagem feita por IA. ${pagina} A capa: ${deOndeVemACapa(post, v, capaFoto)}.`;
}

/** A duração conferida (P37): "Cabe no que o Reels aceita: 18 segundos (de 3 a 90)…". */
export const CABE_NO_REELS = (v: VideoDasFotos) =>
  `Cabe no que o Reels aceita: ${duracaoPorExtenso(v.video.duration_ms)} (de 3 a 90), com o formato e o tamanho conferidos quando entrou em Fotos.`;

/** O preparo da Meta, antes de aprovar (P37; D-A6-69). */
export const PREPARO_ANTES =
  'Antes de publicar, a Meta prepara o vídeo: o Liame confere uma vez por minuto, por até 5 minutos, e só então publica. Se ela não terminar, o post não sai e aparece aqui, com "Tentar de novo".';

/** A Meta preparando o vídeo depois de aprovado (P37). */
export const PREPARANDO = {
  titulo: 'Aprovado. A Meta está preparando o vídeo.',
  texto: 'O Liame confere uma vez por minuto, por até 5 minutos, e publica assim que ela terminar, uma vez só em cada canal. Você não precisa fazer nada.',
  noCanal: 'a Meta está preparando o vídeo; o Liame publica assim que ela terminar.',
} as const;

/**
 * O vídeo que não saiu em nenhum canal e ainda pode "Tentar de novo": pela regra do servidor (D-A6-76), sem nenhum canal
 * no ar, só o preparo que a Meta não terminou em 5 minutos oferece a nova tentativa (os outros motivos pedem o outro canal
 * no ar). `podeTentar`: a conferência do prazo de cada canal, da mesma tela.
 */
export function videoSemPreparo(post: Pick<PostResponse, 'media' | 'status' | 'channels'>, podeTentar: (c: PostResponse['channels'][number]) => boolean): boolean {
  return ehPostComVideo(post) && post.status === 'nao_saiu' && post.channels.some((c) => c.status === 'falhou' && podeTentar(c));
}

/** O vídeo que não saiu porque a Meta não terminou de preparar (P37; na Página, ela ainda pode publicar: a frase do canal diz). */
export const SEM_PREPARO = {
  titulo: 'Não saiu: a Meta não terminou de preparar o vídeo a tempo.',
  texto: 'Veja abaixo em cada canal. Tentar de novo manda o mesmo vídeo aprovado, sem pedir o código outra vez.',
  nota: 'Se falhar de novo, o vídeo pode estar fora do que a Meta aceita. Confira em Fotos ou escolha outro vídeo num post novo.',
  /** O aviso depois do "Tentar de novo" (P37): a nova tentativa vale para os canais que faltam. */
  deNovo: 'Mandado de novo: a Meta prepara o vídeo, e o Liame publica assim que ela terminar.',
} as const;
