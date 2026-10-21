import { createHash } from 'node:crypto';
import { BRAND_PHOTO_LIMITS as L } from '@liame/contracts';
import sharp, { type Metadata, type OutputInfo } from 'sharp';
import { conferirMedidas, medidasOrientadas, type MotivoDaRecusa, tipoPeloConteudo } from './conferencia.js';

// O processamento da foto enviada (ADR-021, item 3): o tipo é lido do conteúdo; as medidas são conferidas antes de
// abrir a imagem inteira; a foto é regravada pelo servidor em JPEG, com o lado maior em até 2.048 px, depois de
// aplicar a orientação da câmera. Regravar tira os metadados (a foto do celular traz a localização) e qualquer coisa
// que não seja imagem. A miniatura (para a grade) sai da cópia, com o lado menor em até 480 px.

// Sem cache de arquivos abertos: cada foto é aberta uma vez, e o cache só gastaria memória.
sharp.cache(false);

/** O lado menor da miniatura: a grade mostra a foto em quadrado de até uns 220 px, em tela de densidade 2. */
export const LADO_DA_MINIATURA = 480;

/** Fotos abertas ao mesmo tempo neste processo: uma PNG grande ocupa centenas de MB enquanto é lida. */
const AO_MESMO_TEMPO = 2;

export class RecusaDaFoto extends Error {
  constructor(readonly motivo: MotivoDaRecusa) {
    super(`foto recusada: ${motivo}`);
  }
}

export interface ImagemGravada {
  bytes: Buffer;
  largura: number;
  altura: number;
}

export interface FotoProcessada {
  /** O sha256 do arquivo enviado: a mesma foto não entra duas vezes na marca. */
  sha256: string;
  copia: ImagemGravada;
  miniatura: ImagemGravada;
}

let emUso = 0;
const esperando: Array<() => void> = [];

async function naVez<T>(fn: () => Promise<T>): Promise<T> {
  if (emUso >= AO_MESMO_TEMPO) await new Promise<void>((r) => esperando.push(r));
  emUso += 1;
  try {
    return await fn();
  } finally {
    emUso -= 1;
    esperando.shift()?.();
  }
}

/** Confere e regrava a foto. Recusa com `RecusaDaFoto` (o motivo vira o problema 422 da rota). */
export async function processarFoto(entrada: Buffer): Promise<FotoProcessada> {
  const tipo = tipoPeloConteudo(entrada);
  if (tipo === 'heic') throw new RecusaDaFoto('heic');
  if (tipo === 'outro') throw new RecusaDaFoto('formato');
  return naVez(async () => {
    const abrir = () => sharp(entrada, { failOn: 'error', limitInputPixels: L.maxLongSide * L.maxLongSide });
    let meta: Metadata;
    try {
      meta = await abrir().metadata();
    } catch {
      throw new RecusaDaFoto('nao_abre');
    }
    // O formato que a biblioteca leu tem de ser o mesmo dos primeiros bytes (um PNG com cara de JPEG não passa).
    if (meta.format !== tipo) throw new RecusaDaFoto('nao_abre');
    const { largura, altura } = medidasOrientadas(meta);
    const motivo = conferirMedidas(largura, altura);
    if (motivo) throw new RecusaDaFoto(motivo);
    let copia: { data: Buffer; info: OutputInfo };
    try {
      copia = await abrir()
        .rotate()
        .resize({ width: L.storedLongSide, height: L.storedLongSide, fit: 'inside', withoutEnlargement: true })
        .flatten({ background: '#ffffff' })
        .jpeg({ quality: 85, mozjpeg: true })
        .toBuffer({ resolveWithObject: true });
    } catch {
      throw new RecusaDaFoto('nao_abre');
    }
    const mini = await sharp(copia.data)
      .resize({ width: LADO_DA_MINIATURA, height: LADO_DA_MINIATURA, fit: 'outside', withoutEnlargement: true })
      .jpeg({ quality: 78, mozjpeg: true })
      .toBuffer({ resolveWithObject: true });
    return {
      sha256: createHash('sha256').update(entrada).digest('hex'),
      copia: { bytes: copia.data, largura: copia.info.width, altura: copia.info.height },
      miniatura: { bytes: mini.data, largura: mini.info.width, altura: mini.info.height },
    };
  });
}
