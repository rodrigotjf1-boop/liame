import { createDatabase, type Database, withSystem } from '@liame/database';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { naOrdemDaFila, vezNaFila } from '../../src/worker/ordem-da-fila.js';
import { APP_URL, hasDb } from './env.js';

// ERR-135: o `returning` de um `update … from` não volta na ordem da consulta que reservou o lote. Os laços que
// precisam da ordem da fila devolvem a vez de cada linha e ordenam o lote antes de tratá-lo. Aqui, a ordem em código e
// a vez como o banco a escreve (texto que se ordena como o instante, até o microssegundo).

describe('a ordem de um lote reservado na fila (ERR-135)', () => {
  it('a vez mais antiga primeiro; na mesma vez, o id; e a lista de quem chama não muda', () => {
    const lote = [
      { id: 'b0000000-0000-4000-8000-000000000002', vez: '2026-10-14T03:05:06.000002' },
      { id: 'b0000000-0000-4000-8000-000000000003', vez: '2026-10-14T03:05:06.000001' },
      { id: 'b0000000-0000-4000-8000-000000000001', vez: '2026-10-14T03:05:06.000002' },
      { id: 'a0000000-0000-4000-8000-000000000009', vez: '2026-10-13T23:59:59.999999' },
    ];
    expect(naOrdemDaFila(lote).map((l) => l.id.slice(-1))).toEqual(['9', '3', '1', '2']);
    expect(lote.map((l) => l.id.slice(-1))).toEqual(['2', '3', '1', '9']);
    expect(naOrdemDaFila([])).toEqual([]);
  });
});

describe.skipIf(!hasDb)('a vez na fila, escrita pelo banco', () => {
  let database: Database;
  beforeAll(() => {
    database = createDatabase({ connectionString: APP_URL, max: 2, applicationName: 'liame-test' });
  });
  afterAll(async () => {
    await database?.close();
  });

  it('é o instante em UTC, com os microssegundos, e se ordena como ele (também na virada do dia em outro fuso)', async () => {
    const vezes = await withSystem(database.db, async (tx) => {
      await tx.execute(sql`set local time zone 'America/Sao_Paulo'`);
      const r = await tx.execute<{ vez: string }>(sql`
        select ${vezNaFila(sql`t.instante`)} as vez
          from (values ('2026-10-14 02:30:00.5-03'::timestamptz), ('2026-10-13 23:59:59.999999-03'::timestamptz), ('2026-10-14 03:00:00.000001+00'::timestamptz)) as t (instante)`);
      return r.rows.map((l) => l.vez);
    });
    expect(vezes).toEqual(['2026-10-14T05:30:00.500000', '2026-10-14T02:59:59.999999', '2026-10-14T03:00:00.000001']);
    expect([...vezes].sort()).toEqual(['2026-10-14T02:59:59.999999', '2026-10-14T03:00:00.000001', '2026-10-14T05:30:00.500000']);
  });
});
