// Cria (uma vez) os papéis e os bancos do Liame num Postgres onde temos um papel administrador.
// Usado no banco local e no CI. Na nuvem (Supabase) o equivalente é aplicado pelo dono, uma vez:
// lá não se cria banco, e o `postgres` não é superusuário.
//
//   node packages/database/scripts/bootstrap.mjs [opções]
//
//   --admin-env-file <arquivo>  lê a URL de administrador de um .env (chave DATABASE_URL, ou --admin-env-key)
//   --databases a,b             bancos a criar ou ajustar (padrão: liame_dev,liame_test)
//   --write-env                 grava as URLs no .env.local da raiz (fora do git)
//   --allow-remote              aceita host que não é localhost (padrão: recusa)
//
// Ambiente: ADMIN_DATABASE_URL (se não usar --admin-env-file), LIAME_OWNER_PASSWORD, LIAME_APP_PASSWORD
// (se ausentes: reaproveita as do .env.local ou gera). Nunca imprime senha. Idempotente.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import pg from 'pg';

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

const ROOT = resolve(import.meta.dirname, '../../..');
const ENV_LOCAL = resolve(ROOT, '.env.local');

function readEnvFile(file) {
  if (!existsSync(file)) return {};
  const out = {};
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return out;
}

const adminFile = option('--admin-env-file');
const adminUrl = adminFile
  ? readEnvFile(adminFile)[option('--admin-env-key') ?? 'DATABASE_URL']
  : process.env.ADMIN_DATABASE_URL;
if (!adminUrl) {
  console.error('bootstrap: faltou a URL de administrador (ADMIN_DATABASE_URL ou --admin-env-file)');
  process.exit(1);
}

const admin = new URL(adminUrl);
const local = ['localhost', '127.0.0.1', '::1', '[::1]'].includes(admin.hostname);
if (!local && !flag('--allow-remote')) {
  console.error(`bootstrap: o host ${admin.hostname} não é local; use --allow-remote se for mesmo isso`);
  process.exit(1);
}

const databases = (option('--databases') ?? 'liame_dev,liame_test').split(',').map((d) => d.trim()).filter(Boolean);
for (const db of databases) {
  if (!/^[a-z_][a-z0-9_]*$/.test(db)) throw new Error(`bootstrap: nome de banco inválido: ${db}`);
}

const previous = readEnvFile(ENV_LOCAL);
const passwordFrom = (url) => (url ? decodeURIComponent(new URL(url).password) : undefined);
const newPassword = () => randomBytes(24).toString('base64url');
const ownerPassword = process.env.LIAME_OWNER_PASSWORD ?? passwordFrom(previous.DATABASE_URL_OWNER) ?? newPassword();
const appPassword = process.env.LIAME_APP_PASSWORD ?? passwordFrom(previous.DATABASE_URL) ?? newPassword();

const literal = (s) => `'${s.replace(/'/g, "''")}'`;

async function withClient(database, fn) {
  const url = new URL(adminUrl);
  url.pathname = `/${database}`;
  const client = new pg.Client({ connectionString: url.toString(), application_name: 'liame-bootstrap' });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

// 1. Papéis: dono (migrations, sem superusuário) e aplicação (sem BYPASSRLS, não é dona de nada).
await withClient('postgres', async (c) => {
  for (const [role, password] of [
    ['liame_owner', ownerPassword],
    ['liame_app', appPassword],
  ]) {
    const exists = await c.query('select 1 from pg_roles where rolname = $1', [role]);
    const verb = exists.rowCount ? 'alter' : 'create';
    await c.query(
      `${verb} role ${role} login nosuperuser nocreatedb nocreaterole noreplication nobypassrls password ${literal(password)}`,
    );
  }
  // 2. Bancos: do dono; ninguém mais conecta além da aplicação.
  for (const db of databases) {
    const exists = await c.query('select 1 from pg_database where datname = $1', [db]);
    if (exists.rowCount) {
      await c.query(`alter database ${db} owner to liame_owner`);
    } else {
      await c.query(`create database ${db} owner liame_owner encoding 'UTF8' template template0`);
    }
  }
});

// 3. Dentro de cada banco: o schema public é do dono (pg_database_owner), sem CREATE para PUBLIC.
for (const db of databases) {
  await withClient(db, async (c) => {
    await c.query(`revoke all on database ${db} from public`);
    await c.query(`grant connect on database ${db} to liame_app`);
    await c.query('revoke create on schema public from public');
    await c.query('grant usage on schema public to liame_app');
  });
}

const version = await withClient(databases[0], async (c) => (await c.query('show server_version')).rows[0].server_version);

if (flag('--write-env')) {
  const host = `${admin.hostname}:${admin.port || '5432'}`;
  const url = (user, password, db) => `postgresql://${user}:${encodeURIComponent(password)}@${host}/${db}`;
  const dev = databases.find((d) => d.endsWith('_dev')) ?? databases[0];
  const test = databases.find((d) => d.endsWith('_test')) ?? databases[0];
  writeFileSync(
    ENV_LOCAL,
    [
      `# Local, fora do git. Gerado por packages/database/scripts/bootstrap.mjs em ${new Date().toISOString().slice(0, 10)}.`,
      '# Aplicação (liame_app: sem BYPASSRLS, não é dona das tabelas).',
      `DATABASE_URL=${url('liame_app', appPassword, dev)}`,
      '# Dono (liame_owner: migrations e fixtures; sem superusuário, como o postgres do Supabase).',
      `DATABASE_URL_OWNER=${url('liame_owner', ownerPassword, dev)}`,
      '# Filas (pg-boss): conexão em sessão (ADR-005).',
      `DATABASE_URL_JOBS=${url('liame_owner', ownerPassword, dev)}`,
      '# Testes (Vitest).',
      `TEST_DATABASE_URL=${url('liame_app', appPassword, test)}`,
      `TEST_DATABASE_URL_OWNER=${url('liame_owner', ownerPassword, test)}`,
      '',
    ].join('\n'),
    'utf8',
  );
}

console.log(
  `bootstrap ok: papéis liame_owner e liame_app; bancos ${databases.join(', ')} (PostgreSQL ${version})${flag('--write-env') ? '; URLs em .env.local' : ''}`,
);
