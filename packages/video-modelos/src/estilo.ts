import type { VideoFormat } from '@liame/contracts';
import { Easing, interpolate } from 'remotion';

// O desenho dos modelos (P43 aprovado em 11/11/2026, `mockups/prototipo-video-montado.html`): as cores, as fontes e os
// tamanhos do quadro da prévia, que tinha 260 px de largura no 9:16 e 280 px no 4:5 e no 1:1. Cada medida do protótipo
// (em px) é multiplicada pela escala do formato (a largura do vídeo dividida pela da prévia).

export const COR = { claro: '#FFFFFF', tinta: '#0B0D17', preco: '#FFC24B', faixa: '#FF6B6B' } as const;
export const FONTE = { texto: 'Poppins', numero: '"JetBrains Mono"' } as const;

const LARGURA_DA_PREVIA: Record<VideoFormat, number> = { '9x16': 260, '4x5': 280, '1x1': 280 };

/** A escala do formato: quantos pixels do vídeo valem 1 px do quadro da prévia. */
export function escala(formato: VideoFormat, largura: number): number {
  return largura / LARGURA_DA_PREVIA[formato];
}

/** A curva do protótipo (`--ease`). */
const CURVA = Easing.bezier(0.2, 0.8, 0.2, 1);
/** O texto entra em 0,35 s, como no protótipo. */
const ENTRADA_S = 0.35;

/** O texto que entra no segundo `inicio`: aparece e sobe 8 px (da prévia), como no protótipo. */
export function entrada(quadro: number, fps: number, inicio: number, s: number): { opacity: number; transform: string } {
  const p = interpolate(quadro, [inicio * fps, (inicio + ENTRADA_S) * fps], [0, 1], {
    easing: CURVA,
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  return { opacity: p, transform: `translateY(${((1 - p) * 8 * s).toFixed(2)}px)` };
}
