// Atualiza a trava do registro da IA: `pnpm --filter @liame/server ia:lock` (depois do build) grava
// `apps/server/ia-registro.lock.json` com a versão e o hash de cada ferramenta, prompt e funcionário.
// Recusa quando o conteúdo mudou sem subir a versão: o que já foi ao ar com um número não muda (A3, I2).
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { conferirRegistro, conferirTrava, registroAtual, type Trava, travaDe } from '../ai/registro/definicoes.js';

const arquivo = resolve(process.cwd(), process.argv[2] ?? 'ia-registro.lock.json');
const registro = registroAtual();
const inconsistencias = conferirRegistro(registro);
if (inconsistencias.length) {
  console.error(`ia:lock: registro inconsistente\n- ${inconsistencias.join('\n- ')}`);
  process.exit(1);
}

const atual = travaDe(registro);
const gravada: Trava = existsSync(arquivo) ? (JSON.parse(readFileSync(arquivo, 'utf8')) as Trava) : { ferramentas: {}, prompts: {}, funcionarios: {} };
const semVersao = conferirTrava(atual, gravada).filter((p) => p.includes('sem subir a versão') || p.includes('a versão voltou'));
if (semVersao.length) {
  console.error(`ia:lock: suba a versão antes de atualizar a trava\n- ${semVersao.join('\n- ')}`);
  process.exit(1);
}

writeFileSync(arquivo, `${JSON.stringify(atual, null, 2)}\n`, 'utf8');
const n = (g: Record<string, unknown>) => Object.keys(g).length;
console.log(`ia:lock: ${n(atual.ferramentas)} ferramenta(s), ${n(atual.prompts)} prompt(s) e ${n(atual.funcionarios)} funcionário(s) em ${arquivo}`);
