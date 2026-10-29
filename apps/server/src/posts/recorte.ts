import type SharpDoPacote from 'sharp';
import { recorteDoInstagram } from '../fotos/conferencia.js';
import { carregarSharp } from '../fotos/processar.js';

// O recorte do post do Instagram (A6 · Z5b, parte 2; D-A6-21): a foto que não cabe na proporção do Instagram (de 4:5,
// em pé, a 1,91:1, deitada) vai recortada, na posição que a pessoa escolheu no novo post e aprovou. O recorte sai da
// cópia que as Fotos guardam (ADR-021: JPEG com o lado maior em até 2.048 px, já girada e sem os dados do celular).

type Sharp = typeof SharpDoPacote;

export type AreaDoRecorte = { left: number; top: number; width: number; height: number };

/**
 * A área da foto que vai ao Instagram: a alta demais vira 4:5 (em pé), com a largura inteira; a larga demais vira
 * 1,91:1 (deitada), com a altura inteira. A posição vai de 0 a 100 ao longo do lado comprido (0 = o topo ou a esquerda;
 * 50, o centro). A foto que cabe: nulo (vai inteira).
 */
export function areaDoRecorte(largura: number, altura: number, posicao: number): AreaDoRecorte | null {
  if (!(largura > 0) || !(altura > 0)) return null;
  const tipo = recorteDoInstagram(largura, altura);
  if (tipo === 'nenhum') return null;
  const pos = Math.min(100, Math.max(0, Math.round(Number.isFinite(posicao) ? posicao : 50)));
  if (tipo === 'alta') {
    const h = Math.min(altura, Math.floor((largura * 5) / 4));
    return { left: 0, top: Math.round(((altura - h) * pos) / 100), width: largura, height: h };
  }
  const w = Math.min(largura, Math.floor(altura * 1.91));
  return { left: Math.round(((largura - w) * pos) / 100), top: 0, width: w, height: altura };
}

/**
 * Recorta a foto para o Instagram, em JPEG. Nulo quando ela cabe inteira (as medidas são as da própria imagem, não as
 * guardadas na linha). Sem o sharp, `SemSharp` (o binário não abriu): quem chama trata como falha passageira.
 */
export async function recortarParaOInstagram(bytes: Buffer, posicao: number, carregar: () => Promise<Sharp> = carregarSharp): Promise<Buffer | null> {
  const sharp = await carregar();
  const meta = await sharp(bytes, { failOn: 'error' }).metadata();
  const area = areaDoRecorte(meta.width ?? 0, meta.height ?? 0, posicao);
  if (!area) return null;
  return sharp(bytes, { failOn: 'error' }).extract(area).jpeg({ quality: 88, mozjpeg: true }).toBuffer();
}
