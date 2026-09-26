import pg from 'pg';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';

export type Db = NodePgDatabase;

export interface DatabaseOptions {
  connectionString: string;
  /** Conexões do pool. No Supabase, o pooler em modo transação é o caminho da aplicação (ADR-005). */
  max?: number;
  applicationName?: string;
  connectionTimeoutMillis?: number;
}

export interface Database {
  pool: pg.Pool;
  db: Db;
  close(): Promise<void>;
}

/**
 * Cria o pool e o Drizzle da aplicação.
 *
 * - Nenhuma query em `pool.on('connect')` e nenhum `SET` de sessão: o contexto do tenant vai
 *   por transação (`withTenant`), porque o pooler reaproveita conexões (LIC-004, ADR-003).
 * - Sem `schema` no Drizzle: o `db.query` (RQB v1) sai no Drizzle 1.0 (ADR-001).
 */
export function createDatabase(options: DatabaseOptions): Database {
  const pool = new pg.Pool({
    connectionString: options.connectionString,
    max: options.max ?? 10,
    application_name: options.applicationName ?? 'liame',
    // Banco fora do ar não pode prender a requisição (nem o health) indefinidamente.
    connectionTimeoutMillis: options.connectionTimeoutMillis ?? 5000,
  });
  // Erro numa conexão ociosa derruba o processo se ninguém escutar; loga a causa e segue (LIC-003).
  pool.on('error', (err) => {
    console.error('[database] erro em conexão ociosa do pool:', err.message);
  });
  const db = drizzle({ client: pool });
  return { pool, db, close: () => pool.end() };
}
