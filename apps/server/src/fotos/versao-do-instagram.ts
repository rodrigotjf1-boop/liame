import { fitsInstagramReels, type InstagramVideoVersion } from '@liame/contracts';

// A versão do vídeo para o Instagram (A6, Z10, parte 3b; D-A6-149). O Reels e o Story do Instagram aceitam o arquivo com
// até 1.920 px de largura e até 25 Mbps; o vídeo maior (o 4K do celular) ganha uma cópia reduzida, feita pelo serviço de
// montagem (`liame-render`) e guardada ao lado do arquivo. A regra mora aqui, uma só para a lista de Fotos, o novo post e
// a publicação; a tela recebe a situação decidida (`instagram_version`).

/** As situações da cópia no banco (`brand_photo.instagram_status`; nulo: o vídeo cabe como está, ou é foto). */
export type SituacaoDaCopia = 'na_fila' | 'reduzindo' | 'pronta' | 'nao_deu';

/** A chave da cópia para o Instagram: `{id}-instagram.mp4`, ao lado do arquivo (a limpeza apaga os dois juntos). */
export function chaveDaVersaoDoInstagram(chave: string): string {
  for (const final of ['.mp4', '.mov']) if (chave.endsWith(final)) return `${chave.slice(0, -final.length)}-instagram.mp4`;
  return `${chave}-instagram.mp4`;
}

/** O vídeo como o banco o guarda, com a cópia. */
export type VideoComCopia = {
  object_key: string;
  width: number;
  height: number;
  bytes: number | string;
  duration_ms: number | null;
  instagram_status: string | null;
  instagram_bytes: number | string | null;
  instagram_width: number | null;
  instagram_height: number | null;
};

/** O arquivo que vai ao Instagram: o próprio vídeo (cabe como está) ou a cópia reduzida. */
export type ArquivoDoInstagram = { chave: string; largura: number; altura: number; bytes: number; reduzida: boolean };

/** O vídeo cabe no Instagram como a loja gravou (a conta dos contratos, a mesma da tela: V74). */
export function cabeComoEsta(v: Pick<VideoComCopia, 'width' | 'bytes' | 'duration_ms'>): boolean {
  return fitsInstagramReels(v.width, Number(v.bytes), v.duration_ms ?? 0);
}

/**
 * A situação do vídeo no Instagram, como a tela lê: `como_esta` (cabe); `preparando` (na fila ou reduzindo);
 * `reduzida` (a cópia pronta); `nao_deu` (a cópia não saiu, ou o vídeo grande que nunca entrou na fila).
 */
export function versaoDoInstagram(v: VideoComCopia): InstagramVideoVersion {
  if (cabeComoEsta(v)) return 'como_esta';
  if (v.instagram_status === 'na_fila' || v.instagram_status === 'reduzindo') return 'preparando';
  if (v.instagram_status === 'pronta' && arquivoDaCopia(v)) return 'reduzida';
  return 'nao_deu';
}

function arquivoDaCopia(v: VideoComCopia): ArquivoDoInstagram | null {
  if (v.instagram_status !== 'pronta' || !v.instagram_width || !v.instagram_height || !v.instagram_bytes) return null;
  return { chave: chaveDaVersaoDoInstagram(v.object_key), largura: v.instagram_width, altura: v.instagram_height, bytes: Number(v.instagram_bytes), reduzida: true };
}

/** O arquivo que vai ao Instagram agora; nulo quando a cópia ainda não está pronta (ou não deu). */
export function arquivoDoInstagram(v: VideoComCopia): ArquivoDoInstagram | null {
  if (cabeComoEsta(v)) return { chave: v.object_key, largura: v.width, altura: v.height, bytes: Number(v.bytes), reduzida: false };
  return arquivoDaCopia(v);
}

/** A situação inicial da cópia quando o vídeo fica pronto em Fotos: na fila, se não cabe; nula, se cabe. */
export function copiaAoEntrar(v: Pick<VideoComCopia, 'width' | 'bytes' | 'duration_ms'>): SituacaoDaCopia | null {
  return cabeComoEsta(v) ? null : 'na_fila';
}

/** As frases de quando o vídeo ainda não pode ir ao Instagram (o novo post e a publicação). */
export const SEM_VERSAO_DO_INSTAGRAM = {
  preparando:
    'O Instagram aceita o vídeo com até 1.920 px de largura e até 25 Mbps, e o Liame está preparando a versão reduzida deste vídeo (leva alguns minutos). Tente de novo daqui a pouco, ou publique só na Página do Facebook.',
  nao_deu:
    'O Instagram aceita o vídeo com até 1.920 px de largura e até 25 Mbps, e não deu para preparar a versão reduzida deste vídeo. Grave em 1080p e envie de novo, ou publique só na Página do Facebook.',
} as const;
