import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { createDatabase } from '@liame/database';
import { z } from 'zod';
import { abrirDocumentos, conferirPedido, listarPedidos, type PedidoNaDistribuicao, recusarPedido } from '../auth/recuperacao/distribuicao.js';
import { chavePrivadaDaDms, gerarChaves } from '../auth/recuperacao/lacre.js';

// A DMS decide os pedidos de recuperação da conta do Dono (A7, W8, parte 4a; D-A7-62, D-A7-64; D-A7-85). Usa o papel
// dono do banco (`liame_owner`), o mesmo das migrations, informado só na hora pelo NOME da variável, e a chave PRIVADA
// da DMS, que fica só no computador da DMS (nunca no servidor, nunca no repositório).
//
//   Uma vez: gerar o par de chaves (a privada fica na pasta; a pública vai para a variável RECUPERACAO_CHAVE_PUBLICA da API)
//     node apps/server/dist/scripts/recuperacao-da-conta.js --gerar-chaves --pasta <pasta fora do repositório>
//   Os pedidos em andamento (--todos: os dos últimos 60 dias)
//     node --env-file=.env.nuvem apps/server/dist/scripts/recuperacao-da-conta.js --url-env NUVEM_DATABASE_URL_OWNER --listar
//   Abrir o documento para conferir (grava na pasta; apague depois de conferir)
//     ... --ver REC-2026-0001 --chave <arquivo .pem> --pasta <pasta>
//   Depois de conferir o documento, o nome no quadro de sócios pelo CNPJ e a videochamada
//     ... --conferir REC-2026-0001 --por "Nome" --documento --socios --videochamada
//   Ou recusar, com o motivo que a pessoa lê
//     ... --recusar REC-2026-0001 --por "Nome" --motivo "O nome do documento não está no quadro de sócios."

const USO =
  'uso: recuperacao-da-conta (--gerar-chaves --pasta <pasta> | [--url-env <variável>] (--listar [--todos] | --ver <protocolo> --chave <arquivo .pem> --pasta <pasta> | --conferir <protocolo> --por "<quem>" --documento --socios --videochamada | --recusar <protocolo> --por "<quem>" --motivo "<motivo>"))';

const Protocolo = z.string().regex(/^REC-\d{4}-\d{4,}$/);
const EXTENSAO: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'application/pdf': 'pdf' };

const dataHora = (d: Date | null): string => (d ? d.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' }) : '—');

function mostrar(p: PedidoNaDistribuicao): string {
  const empresas = p.companies.map((c) => `${c.name} (CNPJ ${c.cnpj ?? 'sem CNPJ'})`).join('; ') || 'nenhuma';
  return [
    `${p.protocol} · ${p.status} · pedido em ${dataHora(p.created_at)}`,
    `  pessoa: ${p.pessoa.name} <${p.pessoa.email}>`,
    `  dona de: ${empresas}`,
    `  motivo: ${p.reason} · documentos: ${p.documentos}`,
    ...(p.checked_at ? [`  conferido em ${dataHora(p.checked_at)}; o app antigo sai em ${dataHora(p.applies_at)}`] : []),
  ].join('\n');
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      'gerar-chaves': { type: 'boolean', default: false },
      'url-env': { type: 'string', default: 'DATABASE_URL_OWNER' },
      listar: { type: 'boolean', default: false },
      todos: { type: 'boolean', default: false },
      ver: { type: 'string' },
      chave: { type: 'string' },
      pasta: { type: 'string' },
      conferir: { type: 'string' },
      recusar: { type: 'string' },
      por: { type: 'string' },
      motivo: { type: 'string' },
      documento: { type: 'boolean', default: false },
      socios: { type: 'boolean', default: false },
      videochamada: { type: 'boolean', default: false },
    },
  });

  if (values['gerar-chaves']) {
    if (!values.pasta) throw new Error(USO);
    const pasta = resolve(values.pasta);
    const arquivo = join(pasta, 'recuperacao-privada.pem');
    if (existsSync(arquivo)) throw new Error(`já existe ${arquivo}: não sobrescrevo a chave privada (os documentos lacrados com ela não abririam mais)`);
    mkdirSync(pasta, { recursive: true });
    const par = gerarChaves();
    writeFileSync(arquivo, par.privadaPem, { mode: 0o600, flag: 'wx' });
    console.log(`Chave privada gravada em ${arquivo} (impressão digital ${par.keyId}). Guarde só neste computador e numa cópia de segurança fora do repositório.`);
    console.log('Ponha esta linha na variável RECUPERACAO_CHAVE_PUBLICA da API (não é segredo):');
    console.log(par.publica);
    return;
  }

  const variavel = z.string().regex(/^[A-Z][A-Z0-9_]{2,60}$/).safeParse(values['url-env']);
  if (!variavel.success) throw new Error(USO);
  const acoes = [values.listar, values.ver, values.conferir, values.recusar].filter(Boolean).length;
  if (acoes !== 1) throw new Error(USO);
  const url = new Map(Object.entries(process.env)).get(variavel.data);
  if (!url) throw new Error(`defina ${variavel.data}: o endereço do banco com o papel liame_owner (o mesmo das migrations)`);

  const database = createDatabase({ connectionString: url, max: 1, applicationName: 'liame-recuperacao-da-conta' });
  try {
    if (values.listar) {
      const pedidos = await listarPedidos(database.db, { todos: values.todos });
      console.log(pedidos.length ? pedidos.map(mostrar).join('\n\n') : 'Nenhum pedido de recuperação em andamento.');
      return;
    }
    if (values.ver) {
      const protocolo = Protocolo.safeParse(values.ver);
      if (!protocolo.success || !values.chave || !values.pasta) throw new Error(USO);
      const privada = chavePrivadaDaDms(readFileSync(resolve(values.chave), 'utf8'));
      const { pedido, arquivos } = await abrirDocumentos(database.db, protocolo.data, privada);
      const pasta = resolve(values.pasta);
      mkdirSync(pasta, { recursive: true });
      console.log(mostrar(pedido));
      arquivos.forEach((a, i) => {
        const caminho = join(pasta, `${pedido.protocol}-${i + 1}.${EXTENSAO[a.media_type] ?? 'bin'}`);
        writeFileSync(caminho, a.bytes, { mode: 0o600 });
        console.log(`  documento ${i + 1}: ${caminho}`);
      });
      console.log('Confira o documento, o nome no quadro de sócios pelo CNPJ e faça a videochamada. Depois, APAGUE os arquivos desta pasta.');
      return;
    }
    if (values.conferir) {
      const protocolo = Protocolo.safeParse(values.conferir);
      if (!protocolo.success || !values.por) throw new Error(USO);
      const r = await conferirPedido(database.db, {
        protocolo: protocolo.data,
        por: values.por,
        documento: values.documento,
        socios: values.socios,
        videochamada: values.videochamada,
      });
      console.log(`${protocolo.data} conferido. Se nada mudar, o app antigo sai em ${dataHora(r.appliesAt)}. O worker avisa a pessoa e os Administradores.`);
      return;
    }
    const protocolo = Protocolo.safeParse(values.recusar);
    if (!protocolo.success || !values.por || !values.motivo) throw new Error(USO);
    await recusarPedido(database.db, { protocolo: protocolo.data, por: values.por, motivo: values.motivo });
    console.log(`${protocolo.data} recusado. O worker avisa a pessoa, com o motivo.`);
  } finally {
    await database.close();
  }
}

main().catch((err: unknown) => {
  // Só a mensagem: o erro do banco pode trazer o endereço da conexão.
  console.error(`[recuperacao-da-conta] ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`);
  process.exitCode = 1;
});
