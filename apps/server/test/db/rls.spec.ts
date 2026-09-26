import { randomUUID } from 'node:crypto';
import { createDatabase, withTenant, type Database } from '@liame/database';
import { eq, sql } from 'drizzle-orm';
import { pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { APP_URL, OWNER_URL, appRole, hasDb, ident } from './env.js';

// Tabela só do spike: prova RLS forçada + contexto por transação (ADR-003, critérios A1-1 a A1-5).
const spikeNote = pgTable('spike_note', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  body: text('body').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

const FIXTURE = (role: string) => `
  create table if not exists spike_note (
    id uuid primary key default gen_random_uuid(),
    tenant_id uuid not null,
    body text not null,
    created_at timestamptz not null default now()
  );
  alter table spike_note enable row level security;
  alter table spike_note force row level security;
  drop policy if exists spike_note_tenant_isolation on spike_note;
  create policy spike_note_tenant_isolation on spike_note
    using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
    with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
  grant select, insert, update, delete on spike_note to ${ident(role)};
`;

describe.skipIf(!hasDb)('RLS forçada com contexto de tenant por transação', () => {
  const tenantA = randomUUID();
  const tenantB = randomUUID();
  let database: Database;

  beforeAll(async () => {
    const owner = new pg.Client({ connectionString: OWNER_URL });
    await owner.connect();
    try {
      await owner.query(FIXTURE(appRole()));
    } finally {
      await owner.end();
    }
    database = createDatabase({ connectionString: APP_URL, max: 2, applicationName: 'liame-test' });
  });

  afterAll(async () => {
    if (!database) return;
    for (const tenant of [tenantA, tenantB]) {
      await withTenant(database.db, tenant, (tx) => tx.delete(spikeNote).where(eq(spikeNote.tenantId, tenant)));
    }
    await database.close();
  });

  it('a role da aplicação não é superusuário nem tem BYPASSRLS', async () => {
    const r = await database.pool.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
      'select rolsuper, rolbypassrls from pg_roles where rolname = current_user',
    );
    expect(r.rows[0]).toEqual({ rolsuper: false, rolbypassrls: false });
  });

  it('cada tenant só enxerga o que é seu', async () => {
    await withTenant(database.db, tenantA, (tx) => tx.insert(spikeNote).values({ tenantId: tenantA, body: 'nota A' }));
    await withTenant(database.db, tenantB, (tx) => tx.insert(spikeNote).values({ tenantId: tenantB, body: 'nota B' }));

    const deA = await withTenant(database.db, tenantA, (tx) => tx.select({ body: spikeNote.body }).from(spikeNote));
    const deB = await withTenant(database.db, tenantB, (tx) => tx.select({ body: spikeNote.body }).from(spikeNote));
    expect(deA).toEqual([{ body: 'nota A' }]);
    expect(deB).toEqual([{ body: 'nota B' }]);
  });

  it('sem contexto, não lê nada e não grava', async () => {
    const semContexto = await database.db.select().from(spikeNote);
    expect(semContexto).toEqual([]);
    await expect(database.db.insert(spikeNote).values({ tenantId: tenantA, body: 'intrusa' })).rejects.toThrow();
  });

  it('não grava linha de outro tenant mesmo com contexto', async () => {
    await expect(
      withTenant(database.db, tenantA, (tx) => tx.insert(spikeNote).values({ tenantId: tenantB, body: 'cruzada' })),
    ).rejects.toThrow();
  });

  it('o contexto morre com a transação: a conexão volta ao pool sem tenant', async () => {
    const solo = createDatabase({ connectionString: APP_URL, max: 1 });
    try {
      await withTenant(solo.db, tenantA, (tx) => tx.execute(sql`select 1`));
      const r = await solo.db.execute(sql`select coalesce(current_setting('app.tenant_id', true), '') as tenant`);
      expect(r.rows[0]?.tenant).toBe('');
    } finally {
      await solo.close();
    }
  });

  it('transações concorrentes no mesmo pool não misturam tenants', async () => {
    const ler = (tenant: string) =>
      withTenant(database.db, tenant, async (tx) => {
        await tx.execute(sql`select pg_sleep(0.05)`);
        const r = await tx.execute(sql`select current_setting('app.tenant_id') as tenant`);
        return r.rows[0]?.tenant;
      });
    const vistos = await Promise.all([ler(tenantA), ler(tenantB), ler(tenantA), ler(tenantB)]);
    expect(vistos).toEqual([tenantA, tenantB, tenantA, tenantB]);
  });
});
