import { type BrandPhoto, fitsInstagramReels, pageVideoFormat } from '@liame/contracts';
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
