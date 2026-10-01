import { parseArgs } from 'node:util';
import { createDatabase } from '@liame/database';
import { z } from 'zod';
import { definirFlagDaEmpresa } from '../flags/distribuicao-flags.js';

// A distribuição liga ou desliga uma função para UMA empresa (ADR-012). O papel do aplicativo no banco não
// grava regra de flag, de propósito: este comando usa o papel dono do banco (`liame_owner`), o mesmo das
// migrations, informado só na hora de rodar e nunca guardado no contêiner da API.
//
//   node --env-file=.env.nuvem apps/server/dist/scripts/ligar-flag.js --url-env NUVEM_DATABASE_URL_OWNER \
//     --flag regem_write --empresa <uuid> --ligar --por "Nome" --motivo "piloto do cupom de campanha"
//   (para desligar: --desligar no lugar de --ligar)
//
// Vale em até 15 segundos (a leitura das flags fica em memória por esse tempo), na API e no worker. Fica na
// auditoria da empresa quem decidiu e por quê. Os argumentos não levam segredo: o endereço do banco vem do
// ambiente, pelo NOME da variável.

const USO =
  'uso: ligar-flag [--url-env <variável com o endereço do banco, papel liame_owner>] --flag <chave> --empresa <uuid da empresa no Liame> (--ligar | --desligar) --por "<quem decidiu>" --motivo "<por quê>"';

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      'url-env': { type: 'string', default: 'DATABASE_URL_OWNER' },
      flag: { type: 'string' },
      empresa: { type: 'string' },
      ligar: { type: 'boolean', default: false },
      desligar: { type: 'boolean', default: false },
      por: { type: 'string' },
      motivo: { type: 'string' },
    },
  });
  const variavel = z.string().regex(/^[A-Z][A-Z0-9_]{2,60}$/).safeParse(values['url-env']);
  const flag = z.string().regex(/^[a-z0-9_]{2,60}$/).safeParse(values.flag);
  const empresa = z.uuid().safeParse(values.empresa);
  if (!variavel.success || !flag.success || !empresa.success || values.ligar === values.desligar || !values.por || !values.motivo) throw new Error(USO);
  const url = new Map(Object.entries(process.env)).get(variavel.data);
  if (!url) throw new Error(`defina ${variavel.data}: o endereço do banco com o papel liame_owner (o mesmo das migrations)`);

  const database = createDatabase({ connectionString: url, max: 1, applicationName: 'liame-ligar-flag' });
  try {
    const r = await definirFlagDaEmpresa(database.db, { flag: flag.data, tenantId: empresa.data, ligada: values.ligar, por: values.por, motivo: values.motivo });
    const estado = r.valeAgora ? 'LIGADA' : 'DESLIGADA';
    console.log(r.mudou ? `${flag.data} agora está ${estado} para ${r.empresa}. Vale em até 15 segundos.` : `${flag.data} já estava ${estado} para ${r.empresa}: nada mudou.`);
  } finally {
    await database.close();
  }
}

main().catch((err: unknown) => {
  // Só a mensagem: o erro do banco pode trazer o endereço da conexão.
  console.error(`[ligar-flag] ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`);
  process.exitCode = 1;
});
