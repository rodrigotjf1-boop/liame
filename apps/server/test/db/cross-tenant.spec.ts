import { resolve } from 'node:path';
import { createDatabase, type Database, runMigrations, withContext } from '@liame/database';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ownerQuery, resetIpRateLimits, signupAndLogin, startApi, type TestApi } from '../helpers/api.js';
import { APP_URL, OWNER_URL, hasDb } from './env.js';

// A1-3, nível SQL, gerado do catálogo: para CADA tabela com tenant_id, sob o contexto da empresa A,
// nenhuma linha de outra empresa aparece, é alterada ou é apagada. Tabela nova entra no teste sozinha.
describe.skipIf(!hasDb)('A1-3: isolamento entre empresas em toda tabela com tenant_id', () => {
  let api: TestApi;
  let database: Database;
  let tenantA = '';
  let userA = '';
  let tables: Array<{ table: string; hasUserId: boolean; canUpdate: boolean; canDelete: boolean }> = [];

  beforeAll(async () => {
    await runMigrations({ connectionString: OWNER_URL, dir: resolve(process.cwd(), '../../packages/database/migrations') });
    api = await startApi();
    await resetIpRateLimits();
    // Duas empresas de verdade, com dados em todas as tabelas que o cadastro preenche.
    const a = await signupAndLogin(api);
    await signupAndLogin(api);
    tenantA = a.me.active_organization_id;
    userA = a.me.user.id;
    tables = await ownerQuery(`
      select c.relname as table,
             exists (select 1 from pg_attribute a where a.attrelid = c.oid and a.attname = 'user_id' and not a.attisdropped) as "hasUserId",
             has_table_privilege('liame_app', c.oid, 'update') as "canUpdate",
             has_table_privilege('liame_app', c.oid, 'delete') as "canDelete"
        from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'liame' and c.relkind in ('r', 'p')
         and exists (select 1 from pg_attribute a where a.attrelid = c.oid and a.attname = 'tenant_id' and not a.attisdropped)
       order by 1`);
    database = createDatabase({ connectionString: APP_URL, max: 2, applicationName: 'liame-test' });
  });

  afterAll(async () => {
    await database?.close();
    await api?.close();
  });

  it('há tabelas com tenant_id e dados de mais de uma empresa', async () => {
    expect(tables.length).toBeGreaterThanOrEqual(3);
    const [r] = await ownerQuery<{ n: string }>(`select count(distinct tenant_id)::text as n from liame.membership`);
    expect(Number(r?.n)).toBeGreaterThanOrEqual(2);
  });

  it('nenhuma tabela mostra linha de outra empresa', async () => {
    for (const t of tables) {
      // O vínculo da própria pessoa em outra empresa é visível para ela (seletor de empresa): é esperado.
      const ownRows = t.hasUserId ? sql` and not (user_id = ${userA}::uuid)` : sql``;
      const r = await withContext(database.db, { tenantId: tenantA, userId: userA }, (tx) =>
        tx.execute<{ n: string }>(sql`select count(*)::text as n from ${sql.identifier('liame')}.${sql.identifier(t.table)}
                                       where tenant_id <> ${tenantA}::uuid${ownRows}`),
      );
      expect({ tabela: t.table, vazadas: r.rows[0]?.n }).toEqual({ tabela: t.table, vazadas: '0' });
    }
  });

  it('nenhuma tabela deixa alterar ou apagar linha de outra empresa', async () => {
    for (const t of tables) {
      const table = sql`${sql.identifier('liame')}.${sql.identifier(t.table)}`;
      if (t.canUpdate) {
        const r = await withContext(database.db, { tenantId: tenantA, userId: userA }, (tx) =>
          tx.execute(sql`update ${table} set tenant_id = tenant_id where tenant_id <> ${tenantA}::uuid`),
        );
        expect({ tabela: t.table, alteradas: r.rowCount }).toEqual({ tabela: t.table, alteradas: 0 });
      }
      if (t.canDelete) {
        const r = await withContext(database.db, { tenantId: tenantA, userId: userA }, (tx) =>
          tx.execute(sql`delete from ${table} where tenant_id <> ${tenantA}::uuid`),
        );
        expect({ tabela: t.table, apagadas: r.rowCount }).toEqual({ tabela: t.table, apagadas: 0 });
      }
    }
  });
});
