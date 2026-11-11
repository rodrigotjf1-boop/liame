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
