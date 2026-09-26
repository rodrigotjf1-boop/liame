import { randomBytes } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { afterEach, describe, expect, it } from 'vitest';
import { listMigrations, MigrationError, runMigrations } from '../src/migrate.js';

const OWNER_URL = process.env.TEST_DATABASE_URL_OWNER ?? '';

// Cada teste usa uma pasta e dois schemas descartáveis: um de controle e um para os objetos.
async function scenario(files: Record<string, string>) {
  const id = randomBytes(4).toString('hex');
  const dir = await mkdtemp(join(tmpdir(), 'liame-mig-'));
  for (const [name, sql] of Object.entries(files)) {
    await writeFile(join(dir, name), sql.replaceAll('{obj}', `mig_obj_${id}`), 'utf8');
  }
  return { dir, control: `mig_ctl_${id}`, objects: `mig_obj_${id}` };
}

async function query<T extends pg.QueryResultRow>(sql: string, params: unknown[] = []): Promise<T[]> {
  const client = new pg.Client({ connectionString: OWNER_URL });
  await client.connect();
  try {
    return (await client.query<T>(sql, params)).rows;
  } finally {
    await client.end();
  }
}

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0)) await fn();
});

function track(s: { dir: string; control: string; objects: string }) {
  cleanup.push(async () => {
    await rm(s.dir, { recursive: true, force: true });
    if (OWNER_URL) await query(`drop schema if exists ${s.control} cascade; drop schema if exists ${s.objects} cascade`);
  });
  return s;
}

describe('listMigrations: a pasta segue o padrão', () => {
  it('aceita 0001..N em sequência e calcula o mesmo checksum com CRLF ou LF', async () => {
    const lf = track(await scenario({ '0001_a.sql': 'select 1;\nselect 2;\n', '0002_b.sql': 'select 3;\n' }));
    const crlf = track(await scenario({ '0001_a.sql': 'select 1;\r\nselect 2;\r\n', '0002_b.sql': 'select 3;\r\n' }));
    const [a, b] = [await listMigrations(lf.dir), await listMigrations(crlf.dir)];
    expect(a.map((m) => m.name)).toEqual(['0001_a.sql', '0002_b.sql']);
    expect(a.map((m) => m.checksum)).toEqual(b.map((m) => m.checksum));
  });

  it('recusa número pulado', async () => {
    const s = track(await scenario({ '0001_a.sql': 'select 1;', '0003_c.sql': 'select 1;' }));
    await expect(listMigrations(s.dir)).rejects.toThrow(/esperado 0002/);
  });

  it('recusa número repetido', async () => {
    const s = track(await scenario({ '0001_a.sql': 'select 1;', '0001_b.sql': 'select 1;' }));
    await expect(listMigrations(s.dir)).rejects.toThrow(/fora de sequência/);
  });

  it('recusa nome fora do padrão', async () => {
    const s = track(await scenario({ '1_a.sql': 'select 1;' }));
    await expect(listMigrations(s.dir)).rejects.toThrow(/fora do padrão/);
  });
});

describe.skipIf(!OWNER_URL)('runMigrations: aplica como na nuvem', () => {
  it('aplica em ordem, registra e não reaplica', async () => {
    const s = track(
      await scenario({
        '0001_schema.sql': 'create schema {obj};',
        '0002_tabela.sql': 'create table {obj}.nota (id int primary key, texto text not null);',
      }),
    );
    const first = await runMigrations({ connectionString: OWNER_URL, dir: s.dir, controlSchema: s.control });
    expect(first).toEqual({ applied: ['0001_schema.sql', '0002_tabela.sql'], skipped: [] });

    const second = await runMigrations({ connectionString: OWNER_URL, dir: s.dir, controlSchema: s.control });
    expect(second).toEqual({ applied: [], skipped: ['0001_schema.sql', '0002_tabela.sql'] });

    const rows = await query<{ name: string }>(`select name from ${s.control}.applied order by name`);
    expect(rows.map((r) => r.name)).toEqual(['0001_schema.sql', '0002_tabela.sql']);
  });

  it('erro no meio do arquivo desfaz o arquivo inteiro e para', async () => {
    const s = track(
      await scenario({
        '0001_schema.sql': 'create schema {obj};',
        '0002_quebrada.sql': 'create table {obj}.metade (id int);\nselect * from tabela_que_nao_existe;',
        '0003_depois.sql': 'create table {obj}.depois (id int);',
      }),
    );
    const erro = await runMigrations({ connectionString: OWNER_URL, dir: s.dir, controlSchema: s.control }).catch(
      (e: unknown) => e,
    );
    expect(erro).toBeInstanceOf(MigrationError);
    expect((erro as MigrationError).migration).toBe('0002_quebrada.sql');

    const tabelas = await query<{ t: string | null; d: string | null }>(
      `select to_regclass('${s.objects}.metade')::text as t, to_regclass('${s.objects}.depois')::text as d`,
    );
    expect(tabelas[0]).toEqual({ t: null, d: null });
    const aplicadas = await query<{ name: string }>(`select name from ${s.control}.applied`);
    expect(aplicadas.map((r) => r.name)).toEqual(['0001_schema.sql']);
  });

  it('arquivo alterado depois de aplicado é erro, nunca reaplicação', async () => {
    const s = track(await scenario({ '0001_schema.sql': 'create schema {obj};' }));
    await runMigrations({ connectionString: OWNER_URL, dir: s.dir, controlSchema: s.control });
    await writeFile(join(s.dir, '0001_schema.sql'), `create schema ${s.objects}; -- editada`, 'utf8');
    await expect(runMigrations({ connectionString: OWNER_URL, dir: s.dir, controlSchema: s.control })).rejects.toThrow(
      /mudou depois de aplicado/,
    );
  });

  it('duas execuções ao mesmo tempo aplicam cada arquivo uma vez só', async () => {
    const s = track(
      await scenario({
        '0001_schema.sql': 'create schema {obj};',
        '0002_tabela.sql': 'create table {obj}.nota (id int primary key);',
        '0003_dado.sql': 'insert into {obj}.nota values (1);',
      }),
    );
    const run = () => runMigrations({ connectionString: OWNER_URL, dir: s.dir, controlSchema: s.control });
    const [a, b] = await Promise.all([run(), run()]);
    expect([...a.applied, ...b.applied].sort()).toEqual(['0001_schema.sql', '0002_tabela.sql', '0003_dado.sql']);
    const linhas = await query<{ n: string }>(`select count(*)::text as n from ${s.objects}.nota`);
    expect(linhas[0]?.n).toBe('1');
  });
});
