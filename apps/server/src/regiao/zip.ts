import { Transform, type TransformCallback } from 'node:stream';
import { inflateRawSync } from 'node:zlib';

// O leitor de .zip dos arquivos do Censo por bairro (plano da região, R2): o IBGE publica cada arquivo como um .zip com
// um .csv dentro. Só o necessário: o diretório central, os métodos "guardado" (0) e "deflate" (8), sem senha, e um teto
// para o que sai descompactado (um .zip pequeno não pode virar gigabytes na memória do worker).

const FIM_DO_DIRETORIO = 0x06054b50;
const ENTRADA_DO_DIRETORIO = 0x02014b50;
const CABECALHO_LOCAL = 0x04034b50;

export interface ArquivoDoZip {
  nome: string;
  conteudo: Buffer;
}

export class ZipInvalido extends Error {}

/** Os arquivos do .zip, descompactados, até `limiteBytes` cada; formato que não é o esperado vira `ZipInvalido`. */
export function arquivosDoZip(buf: Buffer, limiteBytes: number): ArquivoDoZip[] {
  // O fim do diretório central fica nos últimos 22 bytes (mais um comentário de até 64 KB).
  let fim = buf.length - 22;
  const parada = Math.max(0, buf.length - 22 - 65_535);
  while (fim >= parada && buf.readUInt32LE(fim) !== FIM_DO_DIRETORIO) fim--;
  if (fim < parada) throw new ZipInvalido('sem o fim do diretório central');
  const total = buf.readUInt16LE(fim + 10);
  let p = buf.readUInt32LE(fim + 16);
  const arquivos: ArquivoDoZip[] = [];
  for (let i = 0; i < total; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== ENTRADA_DO_DIRETORIO) throw new ZipInvalido('entrada do diretório fora do lugar');
    const bandeiras = buf.readUInt16LE(p + 8);
    const metodo = buf.readUInt16LE(p + 10);
    const comprimido = buf.readUInt32LE(p + 20);
    const tamanho = buf.readUInt32LE(p + 24);
    const n = buf.readUInt16LE(p + 28);
    const extra = buf.readUInt16LE(p + 30);
    const comentario = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const nome = buf.subarray(p + 46, p + 46 + n).toString('utf8');
    p += 46 + n + extra + comentario;
    if (nome.endsWith('/')) continue;
    if (bandeiras & 1) throw new ZipInvalido('arquivo com senha');
    if (tamanho > limiteBytes) throw new ZipInvalido(`arquivo grande demais: ${nome}`);
    if (local + 30 > buf.length || buf.readUInt32LE(local) !== CABECALHO_LOCAL) throw new ZipInvalido('cabeçalho local fora do lugar');
    const inicio = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    if (inicio + comprimido > buf.length) throw new ZipInvalido('arquivo cortado');
    const dados = buf.subarray(inicio, inicio + comprimido);
    let conteudo: Buffer;
    if (metodo === 0) conteudo = Buffer.from(dados);
    else if (metodo === 8) conteudo = inflateRawSync(dados, { maxOutputLength: limiteBytes });
    else throw new ZipInvalido(`método de compressão ${metodo} não aceito`);
    if (conteudo.length !== tamanho) throw new ZipInvalido('tamanho descompactado diferente do anunciado');
    arquivos.push({ nome, conteudo });
  }
  return arquivos;
}

/** O que o cabeçalho local diz do primeiro arquivo do .zip (o que a leitura em fluxo confere no fim). */
export interface CabecalhoDoZip {
  nome: string;
  metodo: 0 | 8;
  comprimido: number;
  tamanho: number;
}

const ZIP64_EXTRA = 0x0001;
const NAO_CABE_EM_32 = 0xffffffff;

/**
 * O primeiro arquivo de um .zip lido EM FLUXO (os arquivos do CNPJ da Receita, plano da região, R2, parte 4: um .zip
 * de até 2,3 GB com um .csv só, que passa de 4 GB descompactado). Lê o cabeçalho local (com o campo zip64 quando o
 * tamanho não cabe em 32 bits) e deixa passar exatamente os bytes comprimidos do arquivo, para o `inflateRaw` (método
 * 8) ou direto (método 0). O que vem depois (o diretório central) é descartado. Sem o descritor de dados (bandeira 3):
 * sem o tamanho no cabeçalho, não dá para saber onde o arquivo acaba. O fluxo que acaba antes do fim é `ZipInvalido`.
 */
export class PrimeiroArquivoDoZip extends Transform {
  private cabecalho: Buffer | null = Buffer.alloc(0);
  private resta = 0;
  private readonly soDeflate: boolean;
  info: CabecalhoDoZip | null = null;

  /** `soDeflate`: recusa o método 0 (quem vai descompactar com `inflateRaw` precisa do 8). */
  constructor(opcoes: { soDeflate?: boolean } = {}) {
    super();
    this.soDeflate = opcoes.soDeflate ?? false;
  }

  override _transform(pedaco: Buffer, _codificacao: BufferEncoding, pronto: TransformCallback): void {
    try {
      let dados = pedaco;
      if (this.cabecalho) {
        this.cabecalho = Buffer.concat([this.cabecalho, pedaco]);
        const fim = this.lerCabecalho(this.cabecalho);
        if (fim === null) return pronto();
        dados = this.cabecalho.subarray(fim);
        this.cabecalho = null;
      }
      if (this.resta > 0 && dados.length) {
        const parte = dados.subarray(0, Math.min(dados.length, this.resta));
        this.resta -= parte.length;
        this.push(parte);
      }
      pronto();
    } catch (err) {
      pronto(err as Error);
    }
  }

  override _flush(pronto: TransformCallback): void {
    if (this.cabecalho || this.resta > 0) return pronto(new ZipInvalido('arquivo cortado'));
    pronto();
  }

  /** O fim do cabeçalho local (onde começam os dados), ou `null` se ainda faltam bytes para lê-lo. */
  private lerCabecalho(b: Buffer): number | null {
    if (b.length < 30) return null;
    if (b.readUInt32LE(0) !== CABECALHO_LOCAL) throw new ZipInvalido('o arquivo não começa por um cabeçalho local');
    const bandeiras = b.readUInt16LE(6);
    const metodo = b.readUInt16LE(8);
    const n = b.readUInt16LE(26);
    const extra = b.readUInt16LE(28);
    if (b.length < 30 + n + extra) return null;
    if (bandeiras & 1) throw new ZipInvalido('arquivo com senha');
    if (bandeiras & 8) throw new ZipInvalido('arquivo sem o tamanho no cabeçalho (descritor de dados)');
    if ((metodo !== 0 || this.soDeflate) && metodo !== 8) throw new ZipInvalido(`método de compressão ${metodo} não aceito`);
    let tamanho = b.readUInt32LE(22);
    let comprimido = b.readUInt32LE(18);
    if (tamanho === NAO_CABE_EM_32 || comprimido === NAO_CABE_EM_32) {
      // O campo zip64 do cabeçalho local traz o tamanho e depois o comprimido (8 bytes cada). A especificação manda
      // os dois; quem grava só o que não coube grava só aquele, na mesma ordem.
      let p = 30 + n;
      const fimExtra = p + extra;
      let achou = false;
      while (p + 4 <= fimExtra) {
        const id = b.readUInt16LE(p);
        const t = b.readUInt16LE(p + 2);
        if (id === ZIP64_EXTRA) {
          const ambos = t >= 16;
          let q = p + 4;
          if (tamanho === NAO_CABE_EM_32 || ambos) {
            if (q + 8 > fimExtra) break;
            const v = Number(b.readBigUInt64LE(q));
            if (tamanho === NAO_CABE_EM_32) tamanho = v;
            q += 8;
          }
          if (comprimido === NAO_CABE_EM_32) {
            if (q + 8 > fimExtra) break;
            comprimido = Number(b.readBigUInt64LE(q));
          }
          achou = true;
          break;
        }
        p += 4 + t;
      }
      if (!achou) throw new ZipInvalido('tamanho grande sem o campo zip64');
    }
    this.info = { nome: b.subarray(30, 30 + n).toString('utf8'), metodo: metodo as 0 | 8, comprimido, tamanho };
    this.resta = comprimido;
    return 30 + n + extra;
  }
}
