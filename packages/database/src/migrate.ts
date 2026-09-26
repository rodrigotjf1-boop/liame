import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import pg from 'pg';

// Executor de migrations (ADR-018): SQL escrito à mão, uma transação por arquivo, checksum,
// o mesmo comando no local, no CI e na nuvem.

export interface Migration {
  name: string;
  number: number;
  sql: string;
  checksum: string;
  transactional: boolean;
}

export interface MigrateOptions {
  connectionString: string;
  dir: string;
  /** Schema da tabela de controle. Os testes usam um schema próprio. */
  controlSchema?: string;
  /** Papel que pode ler qual migration está aplicada (o health da API). */
  readerRole?: string;
  lockTimeout?: string;
  statementTimeout?: string;
  log?: (line: string) => void;
}

export interface MigrateResult {
  applied: string[];
  skipped: string[];
}

export class MigrationError extends Error {
  constructor(
    readonly migration: string,
    cause: unknown,
  ) {
    super(`migration ${migration} falhou: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
    this.name = 'MigrationError';
  }
}

const NAME = /^(\d{4})_[a-z0-9_]+\.sql$/;
const NO_TRANSACTION = /^--\s*liame:sem-transacao\s*$/m;
const IDENT = /^[a-z_][a-z0-9_]*$/;
const DURATION = /^\d+(ms|s|min)$/;

function ident(name: string): string {
  if (!IDENT.test(name)) throw new Error(`identificador inválido: ${name}`);
  return name;
}

function duration(value: string): string {
  if (!DURATION.test(value)) throw new Error(`duração inválida: ${value}`);
  return value;
}

/** Lê e valida a pasta: nomes `NNNN_nome.sql`, numeração 0001..N sem pular nem repetir. */
export async function listMigrations(dir: string): Promise<Migration[]> {
  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  const migrations: Migration[] = [];
  for (const [i, name] of files.entries()) {
    const match = NAME.exec(name);
    if (!match) throw new Error(`nome de migration fora do padrão NNNN_nome.sql: ${name}`);
    const number = Number(match[1]);
    if (number !== i + 1) {
      throw new Error(`numeração fora de sequência em ${name}: esperado ${String(i + 1).padStart(4, '0')}`);
    }
    // Normaliza BOM e fim de linha: o mesmo arquivo tem o mesmo checksum no Windows e no Linux.
    const sql = (await readFile(join(dir, name), 'utf8')).replace(/^﻿/, '').replace(/\r\n/g, '\n');
    if (!sql.trim()) throw new Error(`migration vazia: ${name}`);
    const checksum = createHash('sha256').update(sql).digest('hex');
    migrations.push({ name, number, sql, checksum, transactional: !NO_TRANSACTION.test(sql) });
  }
  return migrations;
}

export async function runMigrations(options: MigrateOptions): Promise<MigrateResult> {
  const log = options.log ?? (() => {});
  const control = ident(options.controlSchema ?? 'liame_migrations');
  const reader = ident(options.readerRole ?? 'liame_app');
  const lockTimeout = duration(options.lockTimeout ?? '10s');
  const statementTimeout = duration(options.statementTimeout ?? '10min');
  const migrations = await listMigrations(options.dir);

  // Conexão única e dedicada (não é pool): em modo sessão ou direta, nunca pelo pooler em modo transação.
  const client = new pg.Client({ connectionString: options.connectionString, application_name: 'liame-migrate' });
  await client.connect();
  const result: MigrateResult = { applied: [], skipped: [] };
  try {
    // Criar o controle ao mesmo tempo em duas execuções colide no catálogo do Postgres ("create ... if not
    // exists" não é atômico). O lock é da transação (sai no commit), não de sessão (LIC-004).
    await client.query('begin');
    try {
      await client.query('select pg_advisory_xact_lock(hashtext($1))', [`liame-migrate:${control}`]);
      await client.query(`create schema if not exists ${control}`);
      await client.query(
        `create table if not exists ${control}.applied (
           name text primary key,
           checksum text not null,
           applied_at timestamptz not null default now(),
           duration_ms integer not null
         )`,
      );
      const readerExists = await client.query('select 1 from pg_roles where rolname = $1', [reader]);
      if (readerExists.rowCount) {
        await client.query(`grant usage on schema ${control} to ${reader}`);
        await client.query(`grant select on ${control}.applied to ${reader}`);
      }
      await client.query('commit');
    } catch (err) {
      await client.query('rollback').catch(() => undefined);
      throw err;
    }

    for (const m of migrations) {
      const started = Date.now();
      try {
        if (m.transactional) {
          await client.query('begin');
          await client.query(`set local lock_timeout = '${lockTimeout}'`);
          await client.query(`set local statement_timeout = '${statementTimeout}'`);
          // Serializa execuções concorrentes: quem chega depois espera e encontra a migration aplicada.
          await client.query(`lock table ${control}.applied in share row exclusive mode`);
        }
        const done = await client.query<{ checksum: string }>(`select checksum from ${control}.applied where name = $1`, [
          m.name,
        ]);
        if (done.rowCount) {
          if (done.rows[0]?.checksum !== m.checksum) {
            throw new Error('o arquivo mudou depois de aplicado; crie uma migration nova em vez de editar esta');
          }
          if (m.transactional) await client.query('commit');
          result.skipped.push(m.name);
          continue;
        }
        await client.query(m.sql);
        await client.query(`insert into ${control}.applied (name, checksum, duration_ms) values ($1, $2, $3)`, [
          m.name,
          m.checksum,
          Date.now() - started,
        ]);
        if (m.transactional) await client.query('commit');
        result.applied.push(m.name);
        log(`aplicada ${m.name} (${Date.now() - started} ms)`);
      } catch (err) {
        if (m.transactional) await client.query('rollback').catch(() => undefined);
        throw new MigrationError(m.name, err);
      }
    }
  } finally {
    await client.end();
  }
  return result;
}
