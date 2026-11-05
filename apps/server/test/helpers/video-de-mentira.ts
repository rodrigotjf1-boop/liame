// Um MP4 (ou MOV) de mentira, montado caixa por caixa, para os testes do vídeo das Fotos (A6 · Z10): a `ftyp`, a `moov`
// (com a duração e as faixas de vídeo e de áudio) e a `mdat` (os dados, aqui só zeros), em qualquer ordem. Só o que o
// leitor do cabeçalho lê; o arquivo não toca num reprodutor.

const u32 = (n: number): Buffer => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n);
  return b;
};

/** Uma caixa: o tamanho (32 bits), o nome de 4 letras e o conteúdo. */
export function caixa(tipo: string, ...conteudo: Buffer[]): Buffer {
  const corpo = Buffer.concat(conteudo);
  const cabecalho = Buffer.alloc(8);
  cabecalho.writeUInt32BE(8 + corpo.length);
  cabecalho.write(tipo, 4, 'latin1');
  return Buffer.concat([cabecalho, corpo]);
}

/** A `mdat` com o tamanho de 64 bits (o campo de 32 bits vale 1), como nos arquivos grandes. */
export function mdat64(bytes: number): Buffer {
  const cabecalho = Buffer.alloc(16);
  cabecalho.writeUInt32BE(1);
  cabecalho.write('mdat', 4, 'latin1');
  cabecalho.writeBigUInt64BE(BigInt(16 + bytes), 8);
  return Buffer.concat([cabecalho, Buffer.alloc(bytes)]);
}

export const ftyp = (marca = 'isom'): Buffer => caixa('ftyp', Buffer.from(marca, 'latin1'), u32(512), Buffer.from('isomiso2avc1mp41', 'latin1'));

function mvhd(escala: number, duracao: number, versao: 0 | 1): Buffer {
  if (versao === 1) {
    const d = Buffer.alloc(8);
    d.writeBigUInt64BE(BigInt(duracao));
    return caixa('mvhd', Buffer.from([1, 0, 0, 0]), Buffer.alloc(16), u32(escala), d, Buffer.alloc(80));
  }
  return caixa('mvhd', Buffer.from([0, 0, 0, 0]), u32(0), u32(0), u32(escala), u32(duracao), Buffer.alloc(80));
}

function tkhd(largura: number, altura: number, girada: boolean): Buffer {
  const c = Buffer.alloc(84); // versão 0
  // A matriz (a, b, u, c, d, v, x, y, w): u, v e w em 2.30; o resto em 16.16. Girada: 90 graus.
  const m = girada ? [0, 1, 0, -1, 0, 0, 0, 0, 1] : [1, 0, 0, 0, 1, 0, 0, 0, 1];
  m.forEach((v, i) => c.writeInt32BE(i === 2 || i === 5 || i === 8 ? v * 0x40000000 : v * 65536, 40 + i * 4));
  c.writeInt32BE(largura * 65536, 76);
  c.writeInt32BE(altura * 65536, 80);
  return caixa('tkhd', c);
}

const hdlr = (tipo: string): Buffer => caixa('hdlr', u32(0), u32(0), Buffer.from(tipo, 'latin1'), Buffer.alloc(12), Buffer.from('faixa\0', 'latin1'));
const stsd = (codec: string): Buffer => caixa('stsd', u32(0), u32(1), caixa(codec, Buffer.alloc(78)));

/** Uma faixa (`trak`) de vídeo (`vide`) ou de áudio (`soun`), com o codec e as medidas. */
export function faixa(tipo: 'vide' | 'soun', codec: string, largura = 0, altura = 0, girada = false): Buffer {
  return caixa('trak', tkhd(largura, altura, girada), caixa('mdia', caixa('mdhd', Buffer.alloc(24)), hdlr(tipo), caixa('minf', caixa('stbl', stsd(codec)))));
}

export type VideoDeMentira = {
  segundos?: number;
  largura?: number;
  altura?: number;
  girada?: boolean;
  codec?: string;
  /** O codec do áudio; nulo = sem faixa de áudio. */
  audio?: string | null;
  marca?: string;
  /** A `moov` depois dos dados (o arquivo sem "faststart"). */
  moovNoFim?: boolean;
  /** Os bytes dos dados (a `mdat`). */
  dados?: number;
  versaoDoMvhd?: 0 | 1;
};

/** O arquivo inteiro: por padrão, 30 segundos em pé (1080 x 1920), H.264 com áudio AAC, a `moov` antes dos dados. */
export function videoDeMentira(v: VideoDeMentira = {}): Buffer {
  const escala = 600;
  const faixas = [faixa('vide', v.codec ?? 'avc1', v.largura ?? 1080, v.altura ?? 1920, v.girada ?? false)];
  const audio = v.audio === undefined ? 'mp4a' : v.audio;
  if (audio) faixas.push(faixa('soun', audio));
  const moov = caixa('moov', mvhd(escala, Math.round((v.segundos ?? 30) * escala), v.versaoDoMvhd ?? 0), ...faixas);
  const dados = caixa('mdat', Buffer.alloc(v.dados ?? 4096));
  return Buffer.concat(v.moovNoFim ? [ftyp(v.marca), dados, moov] : [ftyp(v.marca), moov, dados]);
}

/** A leitura de trechos sobre o arquivo na memória, contando os bytes lidos (para provar que a `mdat` não é lida). */
export function leitorDe(arquivo: Buffer): { ler: (inicio: number, fim: number) => Promise<Buffer>; lidos: () => number } {
  let lidos = 0;
  return {
    ler: async (inicio, fim) => {
      const parte = arquivo.subarray(inicio, fim + 1);
      lidos += parte.length;
      return Buffer.from(parte);
    },
    lidos: () => lidos,
  };
}
