import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IMAGENS_POR_PEDIDO_MAXIMAS, LADO_MAIOR_DA_IMAGEM } from '../ai/imagens.js';
import { type ChamadaDoFf, chamarPeloRemotion, filtroDaImagem, sondarVideo } from './redutor.js';

// Os quadros de um vídeo de Fotos para o Social media escolher os cortes (A6, o item 7 do pedido do dono de 07/11/2026:
// o vídeo com os melhores momentos; D-A6-82). O ffmpeg que vem com o Remotion, no serviço `liame-render`, tira N quadros
// espalhados pelo vídeo, girados como aparecem, nas cores do SDR (o HDR do iPhone convertido, como na cópia do
// Instagram), com o lado maior em até 768 px e em JPEG. O quadro que não sai é pulado: quem chama trabalha com os que
// vierem. Os quadros não são guardados: voltam para a memória, e a pasta temporária sai no fim.

/** O lado maior do quadro: o teto do gateway para o que vai à IA (`ai/imagens.ts`), uma fonte só. */
export const LADO_MAIOR_DO_QUADRO = LADO_MAIOR_DA_IMAGEM;
/** Quantos quadros um pedido tira, no máximo: o teto do gateway por pedido. */
export const QUADROS_MAXIMOS = IMAGENS_POR_PEDIDO_MAXIMAS;
/** Cada quadro tem até 30 segundos (o `-ss` antes do `-i` pula direto para o tempo). */
const TEMPO_DO_QUADRO_MS = 30_000;

export type QuadroDoVideo = { tempoMs: number; jpeg: Uint8Array };

/** As medidas do quadro: o lado maior em até 768 px, na mesma proporção, sempre com os lados pares. */
export function medidasDoQuadro(largura: number, altura: number): { largura: number; altura: number } {
  const maior = Math.max(largura, altura);
  const escala = maior > LADO_MAIOR_DO_QUADRO ? LADO_MAIOR_DO_QUADRO / maior : 1;
  const par = (n: number) => Math.max(2, 2 * Math.round((n * escala) / 2));
  return { largura: par(largura), altura: par(altura) };
}

/** Os tempos dos quadros, em milissegundos: no meio de cada fatia, (i + 0,5) × duração / N. */
export function temposDosQuadros(duracaoMs: number, quantos: number): number[] {
  const n = Math.max(1, Math.min(QUADROS_MAXIMOS, Math.floor(quantos)));
  if (!(duracaoMs > 0)) return [];
  return Array.from({ length: n }, (_, i) => Math.round(((i + 0.5) * duracaoMs) / n));
}

/** Os argumentos do ffmpeg para um quadro: pula para o tempo, tira um quadro, reduz e grava em JPEG (qualidade ~80). */
export function argumentosDoQuadro(entrada: string, saida: string, tempoMs: number, filtro: string): string[] {
  return [
    '-hide_banner',
    '-nostdin',
    '-v',
    'error',
    '-y',
    '-ss',
    (tempoMs / 1000).toFixed(3),
    '-i',
    entrada,
    '-frames:v',
    '1',
    '-an',
    '-vf',
    filtro,
    '-c:v',
    'mjpeg',
    '-q:v',
    '4',
    '-pix_fmt',
    'yuvj420p',
    '-map_metadata',
    '-1',
    saida,
  ];
}

const ehJpeg = (b: Uint8Array): boolean => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;

/**
 * N quadros espalhados do vídeo em `arquivo` (o arquivo local, do `baixarParaArquivo`), de 1 a 16. A duração é a da
 * sondagem que quem chama já tem; as medidas, a rotação e o HDR são lidos aqui. O vídeo que o ffprobe não abre derruba o
 * pedido (`VideoQueNaoReduz`); o quadro que não sai num tempo é pulado.
 */
export async function quadrosDoVideo(arquivo: string, opcoes: { quantos: number; duracaoMs: number }, chamar: ChamadaDoFf = chamarPeloRemotion): Promise<QuadroDoVideo[]> {
  const tempos = temposDosQuadros(opcoes.duracaoMs, opcoes.quantos);
  if (!tempos.length) return [];
  const s = await sondarVideo(arquivo, chamar);
  const { largura, altura } = medidasDoQuadro(s.largura, s.altura);
  const filtro = filtroDaImagem(s, largura, altura);
  const pasta = await mkdtemp(join(tmpdir(), 'liame-quadros-'));
  const quadros: QuadroDoVideo[] = [];
  try {
    for (const [i, tempoMs] of tempos.entries()) {
      const saida = join(pasta, `quadro-${i}.jpg`);
      try {
        await chamar('ffmpeg', argumentosDoQuadro(arquivo, saida, tempoMs, filtro), TEMPO_DO_QUADRO_MS);
        const jpeg = new Uint8Array(await readFile(saida));
        if (ehJpeg(jpeg)) quadros.push({ tempoMs, jpeg });
      } catch {
        // O tempo que não deu um quadro (depois do fim, um trecho corrompido): pula, e os outros seguem.
      }
    }
  } finally {
    await rm(pasta, { recursive: true, force: true }).catch(() => undefined);
  }
  return quadros;
}
