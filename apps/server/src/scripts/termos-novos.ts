import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { createDatabase } from '@liame/database';
import { z } from 'zod';
import { declararVersao, DeclaracaoDeVersao, listarVersoes, retirarVersao } from '../auth/termos/distribuicao.js';
import { diaEmBrasilia } from '../auth/termos/versoes.js';

// A distribuição muda os Termos (A7, W14, parte 14a; D-A7-88, D-A7-89; D-A7-100): só por aqui, nunca pela empresa nem
// por uma tela. Usa o papel dono do banco (`liame_owner`), informado só na hora pelo NOME da variável.
//
//   Declarar a versão nova (os textos já publicados no site; o arquivo JSON diz a versão, o tipo, o dia, os endereços e
//   o que muda, ou o motivo do ajuste de redação)
//     node --env-file=.env.nuvem apps/server/dist/scripts/termos-novos.js --url-env NUVEM_DATABASE_URL_OWNER \
//       --declarar --arquivo <versao.json> --por "Nome"
//   As versões e quantas pessoas aceitaram cada uma
//     ... --listar
//   Retirar a versão relevante que ainda não vale (nada muda; o aceite dado fica sem efeito)
//     ... --retirar 2026-12-02 --por "Nome" --motivo "O advogado pediu outra redação para o item 4.5."

const USO =
  'uso: termos-novos [--url-env <variável>] (--declarar --arquivo <versao.json> --por "<quem>" | --listar | --retirar <versão> --por "<quem>" --motivo "<por quê>")';

const Versao = z.string().regex(/^[0-9]{4}-[0-9]{2}-[0-9]{2}(-[a-z0-9]{1,10})?$/);

/** Baixa o texto publicado: só https, 15 segundos, sem seguir para outro endereço. */
async function baixar(url: string): Promise<string> {
  if (!url.startsWith('https://')) throw new Error(`o endereço é https: ${url}`);
  const r = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(15_000) });
  if (r.status !== 200) throw new Error(`o texto de ${url} respondeu ${r.status}: publique antes de declarar`);
  return r.text();
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      'url-env': { type: 'string', default: 'DATABASE_URL_OWNER' },
      declarar: { type: 'boolean', default: false },
      arquivo: { type: 'string' },
      listar: { type: 'boolean', default: false },
      retirar: { type: 'string' },
      por: { type: 'string' },
      motivo: { type: 'string' },
    },
  });
  const variavel = z.string().regex(/^[A-Z][A-Z0-9_]{2,60}$/).safeParse(values['url-env']);
  if (!variavel.success) throw new Error(USO);
  if ([values.declarar, values.listar, values.retirar].filter(Boolean).length !== 1) throw new Error(USO);
  const url = new Map(Object.entries(process.env)).get(variavel.data);
  if (!url) throw new Error(`defina ${variavel.data}: o endereço do banco com o papel liame_owner (o mesmo das migrations)`);

  const database = createDatabase({ connectionString: url, max: 1, applicationName: 'liame-termos-novos' });
  try {
    if (values.listar) {
      const versoes = await listarVersoes(database.db);
      if (!versoes.length) {
        console.log('Nenhuma versão declarada: vale a do ambiente (TERMS_VERSION).');
        return;
      }
      for (const v of versoes) {
        const situacao = v.withdrawn_at ? `retirada em ${diaEmBrasilia(v.withdrawn_at)}` : v.effective_at > new Date() ? 'espera o dia' : 'vale';
        console.log(`${v.version} · ${v.kind} · avisada em ${diaEmBrasilia(v.notice_at)} · vale em ${diaEmBrasilia(v.effective_at)} · ${situacao} · ${v.aceites} aceite(s)`);
      }
      return;
    }
    if (values.declarar) {
      if (!values.arquivo || !values.por) throw new Error(USO);
      const lido = DeclaracaoDeVersao.safeParse(JSON.parse(readFileSync(values.arquivo, 'utf8')));
      if (!lido.success) throw new Error(`o arquivo não está certo: ${lido.error.issues.map((i) => `${i.path.join('.') || '(raiz)'}: ${i.message}`).join('; ')}`);
      const r = await declararVersao(database.db, lido.data, { por: values.por, baixar });
      console.log(
        lido.data.tipo === 'relevante'
          ? `${lido.data.versao} declarada: vale em ${r.effectiveOn}. Com a função termos_novos ligada, o aviso sai pelo worker e a faixa aparece para todos.`
          : `${lido.data.versao} (ajuste de redação) declarada: vale desde já, sem aviso e sem aceite.`,
      );
      return;
    }
    const versao = Versao.safeParse(values.retirar);
    if (!versao.success || !values.por || !values.motivo) throw new Error(USO);
    await retirarVersao(database.db, { versao: versao.data, por: values.por, motivo: values.motivo });
    console.log(`${versao.data} retirada. Nada muda; com a função ligada, o worker avisa quem tinha recebido o aviso.`);
  } finally {
    await database.close();
  }
}

main().catch((err: unknown) => {
  // Só a mensagem: o erro do banco pode trazer o endereço da conexão.
  console.error(`[termos-novos] ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`);
  process.exitCode = 1;
});
