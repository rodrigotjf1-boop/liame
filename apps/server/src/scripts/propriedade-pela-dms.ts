import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { createDatabase } from '@liame/database';
import { z } from 'zod';
import { chavePrivadaDaDms } from '../auth/recuperacao/lacre.js';
import {
  abrirDocumentosDaPropriedade,
  aprovarPropriedade,
  conferirPropriedade,
  listarPropriedades,
  type PropriedadeNaDistribuicao,
  recusarPropriedade,
} from '../auth/recuperacao/propriedade-pela-dms.js';

// A DMS decide os pedidos da propriedade quando o Dono não está mais (A7, W8, parte 6a; D-A7-63, D-A7-64; D-A7-86). Usa o
// papel dono do banco (`liame_owner`), informado só na hora pelo NOME da variável, e a chave PRIVADA da DMS (a mesma da
// recuperação da conta, que fica só no computador da DMS).
//
//   Os pedidos em andamento (--todos: os dos últimos 60 dias)
//     node --env-file=.env.nuvem apps/server/dist/scripts/propriedade-pela-dms.js --url-env NUVEM_DATABASE_URL_OWNER --listar
//   Abrir os dois documentos para conferir (grava na pasta; apague depois de conferir)
//     ... --ver PROP-2026-0001 --chave <arquivo .pem> --pasta <pasta>
//   Depois de conferir os documentos, o quadro de sócios pelo CNPJ e a videochamada: começa a espera de 14 dias
//     ... --conferir PROP-2026-0001 --por "Nome" --documento --empresa --socios --videochamada
//   Depois da espera (e, se o Dono respondeu, depois de falar com os dois): aprovar ou recusar
//     ... --aprovar PROP-2026-0001 --por "Nome" --motivo "O Dono não respondeu; quadro de sócios atualizado."
//     ... --recusar PROP-2026-0001 --por "Nome" --motivo "O documento da empresa não mostra quem pede como representante."

const USO =
  'uso: propriedade-pela-dms [--url-env <variável>] (--listar [--todos] | --ver <protocolo> --chave <arquivo .pem> --pasta <pasta> | --conferir <protocolo> --por "<quem>" --documento --empresa --socios --videochamada | --aprovar <protocolo> --por "<quem>" --motivo "<motivo>" | --recusar <protocolo> --por "<quem>" --motivo "<motivo>")';

const Protocolo = z.string().regex(/^PROP-\d{4}-\d{4,}$/);
const EXTENSAO: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'application/pdf': 'pdf' };

const dataHora = (d: Date | null): string => (d ? d.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' }) : '—');

function mostrar(p: PropriedadeNaDistribuicao): string {
  return [
    `${p.protocol} · ${p.status} · enviado em ${dataHora(p.sent_at)}`,
    `  empresa: ${p.empresa.name} (CNPJ ${p.empresa.cnpj ?? 'sem CNPJ'})`,
    `  quem pede: ${p.quem_pede.name} <${p.quem_pede.email}>`,
    `  dono: ${p.dono.name ?? '—'} <${p.dono.email ?? '—'}>`,
    `  motivo: ${p.reason}${p.note ? ` · nota: ${p.note}` : ''}`,
    ...(p.checked_at ? [`  conferido em ${dataHora(p.checked_at)}; a decisão sai a partir de ${dataHora(p.decide_from)}`] : []),
    ...(p.contested_at ? [`  o Dono respondeu em ${dataHora(p.contested_at)}: fale com os dois antes de decidir`] : []),
  ].join('\n');
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      'url-env': { type: 'string', default: 'DATABASE_URL_OWNER' },
      listar: { type: 'boolean', default: false },
      todos: { type: 'boolean', default: false },
      ver: { type: 'string' },
      chave: { type: 'string' },
      pasta: { type: 'string' },
      conferir: { type: 'string' },
      aprovar: { type: 'string' },
      recusar: { type: 'string' },
      por: { type: 'string' },
      motivo: { type: 'string' },
      documento: { type: 'boolean', default: false },
      empresa: { type: 'boolean', default: false },
      socios: { type: 'boolean', default: false },
      videochamada: { type: 'boolean', default: false },
    },
  });
  const variavel = z.string().regex(/^[A-Z][A-Z0-9_]{2,60}$/).safeParse(values['url-env']);
  if (!variavel.success) throw new Error(USO);
  const acoes = [values.listar, values.ver, values.conferir, values.aprovar, values.recusar].filter(Boolean).length;
  if (acoes !== 1) throw new Error(USO);
  const url = new Map(Object.entries(process.env)).get(variavel.data);
  if (!url) throw new Error(`defina ${variavel.data}: o endereço do banco com o papel liame_owner (o mesmo das migrations)`);

  const database = createDatabase({ connectionString: url, max: 1, applicationName: 'liame-propriedade-pela-dms' });
  try {
    if (values.listar) {
      const pedidos = await listarPropriedades(database.db, { todos: values.todos });
      console.log(pedidos.length ? pedidos.map(mostrar).join('\n\n') : 'Nenhum pedido da propriedade em andamento.');
      return;
    }
    if (values.ver) {
      const protocolo = Protocolo.safeParse(values.ver);
      if (!protocolo.success || !values.chave || !values.pasta) throw new Error(USO);
      const privada = chavePrivadaDaDms(readFileSync(resolve(values.chave), 'utf8'));
      const { pedido, arquivos } = await abrirDocumentosDaPropriedade(database.db, protocolo.data, privada);
      const pasta = resolve(values.pasta);
      mkdirSync(pasta, { recursive: true });
      console.log(mostrar(pedido));
      for (const a of arquivos) {
        const caminho = join(pasta, `${pedido.protocol}-${a.kind}.${EXTENSAO[a.media_type] ?? 'bin'}`);
        writeFileSync(caminho, a.bytes, { mode: 0o600 });
        console.log(`  ${a.kind}: ${caminho}`);
      }
      console.log('Confira os documentos, o quadro de sócios pelo CNPJ e faça a videochamada. Depois, APAGUE os arquivos desta pasta.');
      return;
    }
    if (values.conferir) {
      const protocolo = Protocolo.safeParse(values.conferir);
      if (!protocolo.success || !values.por) throw new Error(USO);
      const r = await conferirPropriedade(database.db, {
        protocolo: protocolo.data,
        por: values.por,
        documento: values.documento,
        empresa: values.empresa,
        socios: values.socios,
        videochamada: values.videochamada,
      });
      console.log(`${protocolo.data} conferido. O worker avisa o Dono e quem pediu; a decisão sai a partir de ${dataHora(r.decideFrom)}.`);
      return;
    }
    if (values.aprovar) {
      const protocolo = Protocolo.safeParse(values.aprovar);
      if (!protocolo.success || !values.por || !values.motivo) throw new Error(USO);
      await aprovarPropriedade(database.db, { protocolo: protocolo.data, por: values.por, motivo: values.motivo });
      console.log(`${protocolo.data} aprovado: quem pediu é o dono agora, e o acesso do Dono antigo saiu. O worker avisa os dois.`);
      return;
    }
    const protocolo = Protocolo.safeParse(values.recusar);
    if (!protocolo.success || !values.por || !values.motivo) throw new Error(USO);
    await recusarPropriedade(database.db, { protocolo: protocolo.data, por: values.por, motivo: values.motivo });
    console.log(`${protocolo.data} recusado. O worker avisa quem pediu, com o motivo.`);
  } finally {
    await database.close();
  }
}

main().catch((err: unknown) => {
  // Só a mensagem: o erro do banco pode trazer o endereço da conexão.
  console.error(`[propriedade-pela-dms] ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`);
  process.exitCode = 1;
});
