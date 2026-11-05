// O cabeçalho do vídeo (A6 · Z10, parte 1; D-A6-68): o que o Liame confere no arquivo que a loja enviou, sem baixar o
// vídeo inteiro e sem ffmpeg. O MP4 e o MOV são caixas (ISO BMFF / QuickTime): cada uma começa pelo tamanho e por um
// nome de 4 letras. A `moov` guarda a duração (`mvhd`) e as faixas (`trak`: a `tkhd` com as medidas e a rotação; a
// `mdia/hdlr` com o tipo, `vide` ou `soun`; a `mdia/minf/stbl/stsd` com o codec). A `moov` pode vir antes ou depois dos
// dados (`mdat`): o leitor anda pelas caixas do nível de cima lendo só o cabeçalho de cada uma, e lê a `moov` inteira
// quando a acha. Funções puras sobre a leitura de trechos (o armazenamento lê; os testes montam o arquivo na memória).

/** Lê os bytes de `inicio` a `fim` (inclusive) do arquivo. */
export type LerTrecho = (inicio: number, fim: number) => Promise<Buffer>;

export type CabecalhoDoVideo = {
  /** A marca principal da caixa `ftyp` (`isom`, `mp42`, `qt  `…). */
  marca: string;
  duracaoMs: number;
  /** As medidas na orientação em que o vídeo aparece (a rotação da faixa já aplicada). */
  largura: number;
  altura: number;
  /** O codec da faixa de vídeo (`avc1`, `hvc1`…). */
  codec: string;
  temAudio: boolean;
  /** O codec da primeira faixa de áudio (`mp4a`…), ou nulo sem áudio. */
  codecDoAudio: string | null;
};

/** O arquivo não é um vídeo que o Liame consegue ler. */
export class VideoIlegivel extends Error {
  constructor(readonly motivo: 'nao_e_video' | 'sem_moov' | 'sem_faixa_de_video' | 'cabecalho_grande') {
    super(`vídeo ilegível: ${motivo}`);
  }
}

/** A maior `moov` que o leitor aceita (a de um vídeo de 90 s tem bem menos que isso). */
export const MAIOR_MOOV_BYTES = 8 * 1024 * 1024;
/** Quantas caixas do nível de cima o leitor percorre antes de desistir (um MP4 normal tem menos de dez). */
const MAIS_CAIXAS = 64;

const nome = (b: Buffer, de: number): string => b.toString('latin1', de, de + 4);

/** O cabeçalho de uma caixa em `pos`: o tamanho total e o tamanho do cabeçalho (8, ou 16 com o tamanho de 64 bits). */
function cabecalhoDaCaixa(b: Buffer, pos: number, ateOFim: number): { tamanho: number; cabecalho: number; tipo: string } | null {
  if (pos + 8 > b.length) return null;
  const t32 = b.readUInt32BE(pos);
  const tipo = nome(b, pos + 4);
  if (t32 === 1) {
    if (pos + 16 > b.length) return null;
    const t64 = b.readBigUInt64BE(pos + 8);
    if (t64 > BigInt(Number.MAX_SAFE_INTEGER)) return null;
    return { tamanho: Number(t64), cabecalho: 16, tipo };
  }
  // Tamanho zero: a caixa vai até o fim do arquivo (ou da caixa de fora).
  return { tamanho: t32 === 0 ? ateOFim - pos : t32, cabecalho: 8, tipo };
}

/** As caixas filhas dentro de `b` (de `de` até `ate`), com o começo do conteúdo de cada uma. */
function filhas(b: Buffer, de: number, ate: number): Array<{ tipo: string; inicio: number; fim: number }> {
  const lista: Array<{ tipo: string; inicio: number; fim: number }> = [];
  let pos = de;
  for (let n = 0; pos + 8 <= ate && n < 512; n++) {
    const c = cabecalhoDaCaixa(b, pos, ate);
    if (!c || c.tamanho < c.cabecalho || pos + c.tamanho > ate) break;
    lista.push({ tipo: c.tipo, inicio: pos + c.cabecalho, fim: pos + c.tamanho });
    pos += c.tamanho;
  }
  return lista;
}

const filha = (b: Buffer, de: number, ate: number, tipo: string) => filhas(b, de, ate).find((c) => c.tipo === tipo) ?? null;

/** Um número 16.16 (as medidas e a matriz da `tkhd`). */
const fixo1616 = (b: Buffer, pos: number): number => b.readInt32BE(pos) / 65536;

type Faixa = { tipo: string; codec: string | null; largura: number; altura: number; girada: boolean };

function lerFaixa(b: Buffer, inicio: number, fim: number): Faixa | null {
  const tkhd = filha(b, inicio, fim, 'tkhd');
  const mdia = filha(b, inicio, fim, 'mdia');
  if (!tkhd || !mdia) return null;
  // tkhd: versão (1) e flags (3); na versão 1, as datas e a duração têm 64 bits.
  const v1 = b[tkhd.inicio] === 1;
  const matriz = tkhd.inicio + (v1 ? 52 : 40);
  if (matriz + 44 > tkhd.fim) return null;
  const a = fixo1616(b, matriz);
  const bb = fixo1616(b, matriz + 4);
  // A rotação de 90 ou 270 graus (o celular em pé grava deitado e manda girar): as medidas trocam de lugar.
  const girada = Math.abs(a) < 0.5 && Math.abs(bb) > 0.5;
  const largura = Math.round(fixo1616(b, matriz + 36));
  const altura = Math.round(fixo1616(b, matriz + 40));
  const hdlr = filha(b, mdia.inicio, mdia.fim, 'hdlr');
  const tipo = hdlr && hdlr.inicio + 12 <= hdlr.fim ? nome(b, hdlr.inicio + 8) : '';
  const minf = filha(b, mdia.inicio, mdia.fim, 'minf');
  const stbl = minf ? filha(b, minf.inicio, minf.fim, 'stbl') : null;
  const stsd = stbl ? filha(b, stbl.inicio, stbl.fim, 'stsd') : null;
  // stsd: versão e flags (4), o número de entradas (4) e a primeira entrada (tamanho, nome = o codec).
  const codec = stsd && stsd.inicio + 16 <= stsd.fim ? nome(b, stsd.inicio + 12) : null;
  return { tipo, codec, largura: girada ? altura : largura, altura: girada ? largura : altura, girada };
}

/** A duração do filme (`mvhd`), em milissegundos; nula se a caixa faltar ou a escala for zero. */
function duracaoDoFilme(b: Buffer, inicio: number, fim: number): number | null {
  const mvhd = filha(b, inicio, fim, 'mvhd');
  if (!mvhd) return null;
  const v1 = b[mvhd.inicio] === 1;
  const escala = b.readUInt32BE(mvhd.inicio + (v1 ? 20 : 12));
  const duracao = v1 ? Number(b.readBigUInt64BE(mvhd.inicio + 24)) : b.readUInt32BE(mvhd.inicio + 16);
  if (!escala) return null;
  return Math.round((duracao / escala) * 1000);
}

/**
 * Lê o cabeçalho do vídeo de `tamanho` bytes, pedindo só os trechos que precisa (os cabeçalhos das caixas do nível de
 * cima e a `moov`). Recusa com `VideoIlegivel` o que não é MP4/MOV, o que não tem a `moov` ou a faixa de vídeo, e a
 * `moov` grande demais.
 */
export async function lerCabecalhoDoVideo(ler: LerTrecho, tamanho: number): Promise<CabecalhoDoVideo> {
  if (tamanho < 16) throw new VideoIlegivel('nao_e_video');
  let pos = 0;
  let marca: string | null = null;
  for (let n = 0; pos < tamanho && n < MAIS_CAIXAS; n++) {
    const cab = await ler(pos, Math.min(pos + 15, tamanho - 1));
    const c = cabecalhoDaCaixa(cab, 0, tamanho - pos);
    if (!c || c.tamanho < c.cabecalho || pos + c.tamanho > tamanho) throw new VideoIlegivel(n === 0 ? 'nao_e_video' : 'sem_moov');
    if (n === 0) {
      // O arquivo começa pela `ftyp` (o MP4 e o MOV de hoje começam assim).
      if (c.tipo !== 'ftyp' || c.tamanho < 16) throw new VideoIlegivel('nao_e_video');
      marca = nome(await ler(pos + 8, pos + 11), 0);
    }
    if (c.tipo === 'moov') {
      if (c.tamanho > MAIOR_MOOV_BYTES) throw new VideoIlegivel('cabecalho_grande');
      const moov = await ler(pos, pos + c.tamanho - 1);
      return doFilme(moov, c.cabecalho, c.tamanho, marca ?? '');
    }
    pos += c.tamanho;
  }
  throw new VideoIlegivel('sem_moov');
}

function doFilme(moov: Buffer, inicio: number, fim: number, marca: string): CabecalhoDoVideo {
  const duracaoMs = duracaoDoFilme(moov, inicio, fim);
  const faixas = filhas(moov, inicio, fim)
    .filter((c) => c.tipo === 'trak')
    .map((c) => lerFaixa(moov, c.inicio, c.fim))
    .filter((f): f is Faixa => f !== null);
  const video = faixas.find((f) => f.tipo === 'vide');
  if (!video || duracaoMs === null) throw new VideoIlegivel('sem_faixa_de_video');
  const audio = faixas.find((f) => f.tipo === 'soun');
  return {
    marca,
    duracaoMs,
    largura: video.largura,
    altura: video.altura,
    codec: video.codec ?? '',
    temAudio: !!audio,
    codecDoAudio: audio?.codec ?? null,
  };
}
