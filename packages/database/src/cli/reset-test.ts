// Zera o banco de teste local: `pnpm db:reset:test` (apaga os schemas do Liame em TEST_DATABASE_URL_OWNER e roda as
// migrations de novo). Só em host local e em banco terminado em `_test`; nunca imprime a URL.
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { ResetError, resetTestDatabase } from '../reset-test.js';

const args = process.argv.slice(2);
const i = args.indexOf('--url-env');
const urlEnv = i >= 0 ? (args[i + 1] ?? '') : 'TEST_DATABASE_URL_OWNER';

const envLocal = resolve(import.meta.dirname, '../../../../.env.local');
if (existsSync(envLocal)) process.loadEnvFile(envLocal);

const url = process.env[urlEnv];
if (!url) {
  console.error(`reset-test: defina ${urlEnv} (URL do liame_owner no banco de teste local)`);
  process.exit(1);
}

try {
  const { database, before, after } = await resetTestDatabase(url);
  console.log(`reset-test: ${database} zerado (${before} → ${after}); as migrations recriam tudo`);
} catch (err) {
  // Só a mensagem: o erro do pg não leva a senha, mas o objeto inteiro poderia levar a URL.
  const mensagem = err instanceof ResetError ? err.message : err instanceof Error ? `${err.name}: ${err.message}` : 'erro desconhecido';
  console.error(`reset-test: ${mensagem.replaceAll(url, '[URL]')}`);
  process.exit(1);
}
