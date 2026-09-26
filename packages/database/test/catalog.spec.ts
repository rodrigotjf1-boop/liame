import { resolve } from 'node:path';
import pg from 'pg';
import { beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../src/migrate.js';

const OWNER_URL = process.env.TEST_DATABASE_URL_OWNER ?? '';
const APP_URL = process.env.TEST_DATABASE_URL ?? '';
const MIGRATIONS = resolve(import.meta.dirname, '../migrations');

async function query<T extends pg.QueryResultRow>(url: string, sql: string, params: unknown[] = []): Promise<T[]> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    return (await client.query<T>(sql, params)).rows;
  } finally {
    await client.end();
  }
}

// As migrations reais, aplicadas no banco de teste com o mesmo executor da nuvem (ADR-018).
describe.skipIf(!OWNER_URL || !APP_URL)('migrations reais e catálogo do schema liame', () => {
  beforeAll(async () => {
    await runMigrations({ connectionString: OWNER_URL, dir: MIGRATIONS });
  });

  it('reaplicar não muda nada', async () => {
    const again = await runMigrations({ connectionString: OWNER_URL, dir: MIGRATIONS });
    expect(again.applied).toEqual([]);
  });

  it('o schema liame é do dono e a aplicação só usa (não cria)', async () => {
    const [r] = await query<{ owner: string; usage: boolean; create: boolean }>(
      OWNER_URL,
      `select pg_get_userbyid(n.nspowner) as owner,
              has_schema_privilege('liame_app', 'liame', 'usage') as usage,
              has_schema_privilege('liame_app', 'liame', 'create') as create
         from pg_namespace n where n.nspname = 'liame'`,
    );
    expect(r).toEqual({ owner: 'liame_owner', usage: true, create: false });
  });

  it('liame.current_tenant_id() lê o tenant da transação e some depois dela', async () => {
    const client = new pg.Client({ connectionString: APP_URL });
    await client.connect();
    try {
      const tenant = '0192f1d4-3c1a-7b2e-9a10-5f1e2d3c4b5a';
      await client.query('begin');
      await client.query(`select set_config('app.tenant_id', $1, true)`, [tenant]);
      const dentro = await client.query<{ t: string | null }>('select liame.current_tenant_id()::text as t');
      await client.query('commit');
      const fora = await client.query<{ t: string | null }>('select liame.current_tenant_id()::text as t');
      expect(dentro.rows[0]?.t).toBe(tenant);
      expect(fora.rows[0]?.t).toBeNull();
    } finally {
      await client.end();
    }
  });

  // A1-1: toda tabela com tenant_id tem ENABLE + FORCE ROW LEVEL SECURITY + política.
  it('A1-1: nenhuma tabela com tenant_id sem RLS forçada e política', async () => {
    const semRls = await query<{ tabela: string }>(
      OWNER_URL,
      `select c.relname as tabela
         from pg_class c
         join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'liame' and c.relkind in ('r', 'p')
          and exists (select 1 from pg_attribute a where a.attrelid = c.oid and a.attname = 'tenant_id' and not a.attisdropped)
          and (not c.relrowsecurity or not c.relforcerowsecurity
               or not exists (select 1 from pg_policies p where p.schemaname = 'liame' and p.tablename = c.relname))`,
    );
    expect(semRls).toEqual([]);
  });

  // A1-2: a aplicação não é superusuário, não tem BYPASSRLS e não é dona de tabela nenhuma.
  it('A1-2: o papel da aplicação não contorna a RLS', async () => {
    const [papel] = await query<{ rolsuper: boolean; rolbypassrls: boolean }>(
      OWNER_URL,
      `select rolsuper, rolbypassrls from pg_roles where rolname = 'liame_app'`,
    );
    expect(papel).toEqual({ rolsuper: false, rolbypassrls: false });
    const donas = await query<{ tabela: string }>(
      OWNER_URL,
      `select c.relname as tabela from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'liame' and pg_get_userbyid(c.relowner) = 'liame_app'`,
    );
    expect(donas).toEqual([]);
  });
});
