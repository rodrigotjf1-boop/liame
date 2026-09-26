import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { createDatabase, type Database, runMigrations, schema, uuidv7, withContext } from '@liame/database';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ownerQuery } from '../helpers/api.js';
import { APP_URL, OWNER_URL, hasDb } from './env.js';

// ADR-003 e critérios A1-2 e A1-5, nas tabelas reais: RLS forçada, contexto por transação, sem vazamento no pool.
describe.skipIf(!hasDb)('RLS forçada com contexto por transação (tabelas reais)', () => {
  const tenantA = uuidv7();
  const tenantB = uuidv7();
  let database: Database;

  beforeAll(async () => {
    await runMigrations({ connectionString: OWNER_URL, dir: resolve(process.cwd(), '../../packages/database/migrations') });
    await ownerQuery(`insert into liame.organization (id, name) values ($1, 'Org A RLS'), ($2, 'Org B RLS')`, [tenantA, tenantB]);
    database = createDatabase({ connectionString: APP_URL, max: 2, applicationName: 'liame-test' });
  });

  afterAll(async () => {
    await database?.close();
    await ownerQuery(`delete from liame.organization where id in ($1, $2)`, [tenantA, tenantB]);
  });

  it('A1-2: o papel da aplicação não é superusuário nem tem BYPASSRLS', async () => {
    const r = await database.pool.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
      'select rolsuper, rolbypassrls from pg_roles where rolname = current_user',
    );
    expect(r.rows[0]).toEqual({ rolsuper: false, rolbypassrls: false });
  });

  it('cada tenant só enxerga as próprias marcas', async () => {
    await withContext(database.db, { tenantId: tenantA }, (tx) =>
      tx.insert(schema.brand).values({ id: uuidv7(), tenantId: tenantA, name: 'Marca A' }),
    );
    await withContext(database.db, { tenantId: tenantB }, (tx) =>
      tx.insert(schema.brand).values({ id: uuidv7(), tenantId: tenantB, name: 'Marca B' }),
    );
    const deA = await withContext(database.db, { tenantId: tenantA }, (tx) => tx.select({ name: schema.brand.name }).from(schema.brand));
    const deB = await withContext(database.db, { tenantId: tenantB }, (tx) => tx.select({ name: schema.brand.name }).from(schema.brand));
    expect(deA).toEqual([{ name: 'Marca A' }]);
    expect(deB).toEqual([{ name: 'Marca B' }]);
  });

  it('sem contexto, não lê nada e não grava', async () => {
    const semContexto = await database.db.select().from(schema.brand);
    expect(semContexto).toEqual([]);
    await expect(database.db.insert(schema.brand).values({ id: uuidv7(), tenantId: tenantA, name: 'intrusa' })).rejects.toThrow();
  });

  it('não grava linha de outro tenant mesmo com contexto', async () => {
    await expect(
      withContext(database.db, { tenantId: tenantA }, (tx) =>
        tx.insert(schema.brand).values({ id: uuidv7(), tenantId: tenantB, name: 'cruzada' }),
      ),
    ).rejects.toThrow();
  });

  it('não altera nem apaga linha de outro tenant', async () => {
    const alterou = await withContext(database.db, { tenantId: tenantA }, (tx) =>
      tx.update(schema.brand).set({ name: 'sequestrada' }).where(eq(schema.brand.tenantId, tenantB)).returning(),
    );
    const apagou = await withContext(database.db, { tenantId: tenantA }, (tx) =>
      tx.delete(schema.brand).where(eq(schema.brand.tenantId, tenantB)).returning(),
    );
    expect(alterou).toEqual([]);
    expect(apagou).toEqual([]);
  });

  it('A1-5: o contexto morre com a transação (a conexão volta ao pool sem tenant)', async () => {
    const solo = createDatabase({ connectionString: APP_URL, max: 1 });
    try {
      await withContext(solo.db, { tenantId: tenantA, userId: randomUUID() }, (tx) => tx.execute(sql`select 1`));
      const r = await solo.db.execute(sql`select coalesce(current_setting('app.tenant_id', true), '') as tenant,
                                                  coalesce(current_setting('app.scope', true), '') as scope`);
      expect(r.rows[0]).toEqual({ tenant: '', scope: '' });
    } finally {
      await solo.close();
    }
  });

  it('A1-5: transações concorrentes no mesmo pool não misturam tenants', async () => {
    const ler = (tenantId: string) =>
      withContext(database.db, { tenantId }, async (tx) => {
        await tx.execute(sql`select pg_sleep(0.05)`);
        const r = await tx.execute<{ tenant: string }>(sql`select liame.current_tenant_id()::text as tenant`);
        return r.rows[0]?.tenant;
      });
    const vistos = await Promise.all([ler(tenantA), ler(tenantB), ler(tenantA), ler(tenantB)]);
    expect(vistos).toEqual([tenantA, tenantB, tenantA, tenantB]);
  });
});
