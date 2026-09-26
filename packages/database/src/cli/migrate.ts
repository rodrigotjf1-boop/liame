// Aplica as migrations: `pnpm db:migrate` (DATABASE_URL_OWNER) ou `pnpm db:migrate:test`
// (TEST_DATABASE_URL_OWNER). Na nuvem, o dono roda o mesmo comando com a URL do liame_owner em modo sessão.
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { MigrationError, runMigrations } from '../migrate.js';

const args = process.argv.slice(2);
const i = args.indexOf('--url-env');
const urlEnv = i >= 0 ? (args[i + 1] ?? '') : 'DATABASE_URL_OWNER';

const envLocal = resolve(import.meta.dirname, '../../../../.env.local');
if (existsSync(envLocal)) process.loadEnvFile(envLocal);

const url = process.env[urlEnv];
if (!url) {
  console.error(`migrate: defina ${urlEnv} (URL do liame_owner, conexão direta ou em modo sessão)`);
  process.exit(1);
}

const target = new URL(url);
console.log(`migrate: ${target.hostname}:${target.port || '5432'}/${target.pathname.slice(1)} como ${decodeURIComponent(target.username)}`);

try {
  const { applied, skipped } = await runMigrations({
    connectionString: url,
    dir: resolve(import.meta.dirname, '../../migrations'),
    log: (line) => console.log(`migrate: ${line}`),
  });
  console.log(`migrate: ${applied.length} aplicada(s), ${skipped.length} já estava(m) aplicada(s)`);
} catch (err) {
  console.error(`migrate: ${err instanceof MigrationError ? err.message : String(err)}`);
  process.exit(1);
}
