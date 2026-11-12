import { deflateRawSync } from 'node:zlib';

// Um .zip montado na memória para os testes da região (o leitor não confere o CRC: fica zero).

export function zipCom(arquivos: Array<{ nome: string; conteudo: Buffer; guardado?: boolean }>): Buffer {
  const locais: Buffer[] = [];
  const centrais: Buffer[] = [];
  let deslocamento = 0;
  for (const a of arquivos) {
    const nome = Buffer.from(a.nome, 'utf8');
    const dados = a.guardado ? a.conteudo : deflateRawSync(a.conteudo);
    const metodo = a.guardado ? 0 : 8;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(metodo, 8);
    local.writeUInt32LE(dados.length, 18);
    local.writeUInt32LE(a.conteudo.length, 22);
    local.writeUInt16LE(nome.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(metodo, 10);
    central.writeUInt32LE(dados.length, 20);
    central.writeUInt32LE(a.conteudo.length, 24);
    central.writeUInt16LE(nome.length, 28);
    central.writeUInt32LE(deslocamento, 42);
    locais.push(local, nome, dados);
    centrais.push(central, nome);
    deslocamento += local.length + nome.length + dados.length;
  }
  const diretorio = Buffer.concat(centrais);
  const fim = Buffer.alloc(22);
  fim.writeUInt32LE(0x06054b50, 0);
  fim.writeUInt16LE(arquivos.length, 8);
  fim.writeUInt16LE(arquivos.length, 10);
  fim.writeUInt32LE(diretorio.length, 12);
  fim.writeUInt32LE(deslocamento, 16);
  return Buffer.concat([...locais, diretorio, fim]);
}

/**
 * Um .zip de um arquivo só com o cabeçalho local no formato zip64 (os tamanhos em 0xFFFFFFFF e o campo extra 0x0001
 * com o tamanho e o comprimido, 8 bytes cada), como o `Estabelecimentos0.zip` da Receita, que passa de 4 GB. O que vem
 * depois dos dados (o diretório central) é só enfeite: a leitura em fluxo para no fim dos dados.
 */
export function zip64Com(nome: string, conteudo: Buffer, bandeiras = 0): Buffer {
  const n = Buffer.from(nome, 'utf8');
  const dados = deflateRawSync(conteudo);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(45, 4);
  local.writeUInt16LE(bandeiras, 6);
  local.writeUInt16LE(8, 8);
  local.writeUInt32LE(0xffffffff, 18);
  local.writeUInt32LE(0xffffffff, 22);
  local.writeUInt16LE(n.length, 26);
  local.writeUInt16LE(20, 28);
  const extra = Buffer.alloc(20);
  extra.writeUInt16LE(0x0001, 0);
  extra.writeUInt16LE(16, 2);
  extra.writeBigUInt64LE(BigInt(conteudo.length), 4);
  extra.writeBigUInt64LE(BigInt(dados.length), 12);
  const enfeite = Buffer.from([0x50, 0x4b, 0x01, 0x02, 0, 0, 0, 0]);
  return Buffer.concat([local, n, extra, dados, enfeite]);
}
