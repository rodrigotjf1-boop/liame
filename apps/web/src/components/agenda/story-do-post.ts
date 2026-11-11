import type { BrandPhoto, PostResponse } from '@liame/contracts';
import { duracaoCurta } from '@/components/fotos/textos';
import { ehVideoPronto, type VideoDasFotos } from './video-do-post';

// O Story (P41, aprovado pelo dono em 11/11/2026; A6, Z13, parte 2; D-A6-126 a D-A6-129): no novo post, o formato "Post ou
// Story"; o Story leva a foto ou o vídeo das Fotos, sai no Instagram e na Página, sem texto, sem link e sem figurinha, e
// fica 24 horas no ar. Aqui ficam as regras da tela: os limites da Meta (o servidor confere de novo), os canais, as
// frases e o "no ar até".

export type FormatoDoNovo = 'post' | 'story';

/** O post é um Story (o servidor manda `format: 'story'`; o post de sempre vem sem a chave). */
export const ehStory = (p: Pick<PostResponse, 'format'>): boolean => p.format === 'story';

/** Os limites da Meta para o Story (D-A6-128), os mesmos do servidor. */
export const STORY_DO_INSTAGRAM = { fotoBytes: 8 * 1024 * 1024, videoMs: 60_000, videoBytes: 100 * 1024 * 1024 } as const;
export const STORY_DA_PAGINA = { fotoBytes: 10 * 1024 * 1024, videoMs: 90_000 } as const;

/** Quantas horas o Story fica no ar (D-A6-129). */
export const HORAS_NO_AR = 24;

/** A frase do Story sem texto (D-A6-127), no novo post, na prévia e em Aprovações. */
export const NOTA_DO_STORY =
  'O Story sai sem texto, sem link e sem figurinha: a Meta não deixa pôr pela API. O que a marca quer dizer vai na própria foto ou no vídeo. Para pôr o link ou uma enquete, publique pelo app.';

/** As medidas da mídia como ela aparece: as do vídeo gravado, ou as da foto. */
function medidas(m: BrandPhoto): { largura: number; altura: number } {
  return ehVideoPronto(m) ? { largura: m.video.width, altura: m.video.height } : { largura: m.width, altura: m.height };
}

/** Em pé o bastante para o Story ocupar a tela (9:16, ou mais alta): o resto aparece inteiro, com faixas. */
export function emPeNoStory(m: BrandPhoto): boolean {
  const { largura, altura } = medidas(m);
  return largura / altura <= 0.6;
}

/** Por que a mídia não cabe no Story de um canal (D-A6-128), ou nulo. */
export function foraDoStory(canal: string, m: BrandPhoto | null): string | null {
  if (!m) return null;
  const video: VideoDasFotos | null = ehVideoPronto(m) ? m : null;
  if (canal === 'instagram') {
    if (video && (video.video.duration_ms > STORY_DO_INSTAGRAM.videoMs || video.bytes > STORY_DO_INSTAGRAM.videoBytes)) {
      return `Este vídeo tem ${duracaoCurta(video.video.duration_ms)}: o Story do Instagram vai até 60 segundos e 100 MB.`;
    }
    if (!video && m.bytes > STORY_DO_INSTAGRAM.fotoBytes) return 'Esta foto passa de 8 MB, o limite do Story do Instagram.';
    return null;
  }
  if (canal === 'facebook') {
    if (video && video.video.duration_ms > STORY_DA_PAGINA.videoMs) return 'Este vídeo passa de 90 segundos, o limite do Story da Página.';
    if (!video && m.bytes > STORY_DA_PAGINA.fotoBytes) return 'Esta foto passa de 10 MB, o limite do Story da Página.';
  }
  return null;
}

/** O canal no novo Story: o nome, a dica e, quando a mídia não cabe, por que não. */
export function canalNoStory(canal: string, m: BrandPhoto | null): { nome: string; dica: string; fora: string | null } {
  const fora = foraDoStory(canal, m);
  if (canal === 'instagram') return { nome: 'Instagram, como Story', dica: 'Aparece no círculo do perfil, para quem segue.', fora };
  return { nome: 'Página do Facebook, como Story', dica: 'Aparece no topo da Página, para quem segue.', fora };
}

/** A dica da mídia no novo Story. */
export function dicaDaMidiaDoStory(video: boolean): string {
  return video
    ? 'Os vídeos da tela Fotos: no Story do Instagram, até 60 segundos; na Página, até 90.'
    : 'As fotos da tela Fotos. Em pé (9:16) fica melhor: as outras aparecem inteiras, com faixas.';
}

/** O aviso da mídia que não é em pé, no novo Story e na prévia. */
export function avisoDasFaixas(m: BrandPhoto): string {
  return `${ehVideoPronto(m) ? 'Este vídeo' : 'Esta foto'} não é em pé (9:16): no Story, aparece inteir${ehVideoPronto(m) ? 'o' : 'a'}, com faixas em cima e embaixo.`;
}

/** Quando o Story publicado sai do ar: 24 horas depois de sair no primeiro canal; nulo antes de sair. */
export function fimDoStory(post: Pick<PostResponse, 'channels'>): Date | null {
  const saiu = post.channels
    .filter((c) => c.status === 'publicado' && c.published_at)
    .map((c) => new Date(c.published_at!).getTime())
    .sort((a, b) => a - b)[0];
  return saiu === undefined ? null : new Date(saiu + HORAS_NO_AR * 3_600_000);
}

/** O Story publicado ainda está no ar agora? */
export function storyNoAr(post: Pick<PostResponse, 'channels'>, agora: Date): boolean {
  const fim = fimDoStory(post);
  return fim !== null && fim.getTime() > agora.getTime();
}
