import { createDatabase, type Database } from '@liame/database';
import { sql } from 'drizzle-orm';
import pg from 'pg';
import { PgBoss, fromDrizzle } from 'pg-boss';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { APP_URL, OWNER_URL, appRole, hasDb, ident } from './env.js';

// ADR-005: o pg-boss fica numa conexão em sessão (dono do schema); a aplicação enfileira pela
// própria transação, com a role dela. Commit cria o job; rollback desfaz.
describe.skipIf(!hasDb)('pg-boss: envio na transação da aplicação', () => {
  const schema = 'pgboss_spike';
  const queue = 'spike-transacional';
  let boss: PgBoss;
  let database: Database;

  beforeAll(async () => {
    boss = new PgBoss({ connectionString: OWNER_URL, schema, application_name: 'liame-test-boss' });
    boss.on('error', (err: Error) => console.error('[pg-boss]', err.message));
    await boss.start();
    await boss.createQueue(queue);

    const owner = new pg.Client({ connectionString: OWNER_URL });
    await owner.connect();
    try {
      // O RETURNING do envio exige SELECT além de INSERT. O desenho fino dos GRANTs fica para a A1.
      const role = ident(appRole());
      await owner.query(`grant usage on schema ${schema} to ${role}`);
      await owner.query(`grant select, insert on all tables in schema ${schema} to ${role}`);
    } finally {
      await owner.end();
    }
    database = createDatabase({ connectionString: APP_URL, max: 2, applicationName: 'liame-test' });
  });

  afterAll(async () => {
    await database?.close();
    await boss?.stop({ graceful: false });
    const owner = new pg.Client({ connectionString: OWNER_URL });
    await owner.connect();
    try {
      await owner.query(`drop schema if exists ${schema} cascade`);
    } finally {
      await owner.end();
    }
  });

  it('o job nasce junto com o commit', async () => {
    const id = await database.db.transaction((tx) => boss.send(queue, { passo: 1 }, { db: fromDrizzle(tx, sql) }));
    expect(id).toBeTruthy();
    expect(await boss.findJobs(queue, { id: id as string })).toHaveLength(1);
  });

  it('o rollback desfaz o job', async () => {
    let id: string | null = null;
    await expect(
      database.db.transaction(async (tx) => {
        id = await boss.send(queue, { passo: 2 }, { db: fromDrizzle(tx, sql) });
        throw new Error('rollback proposital');
      }),
    ).rejects.toThrow('rollback proposital');
    expect(id).toBeTruthy();
    expect(await boss.findJobs(queue, { id: id as unknown as string })).toHaveLength(0);
  });
});
