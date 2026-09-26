import { sql } from 'drizzle-orm';
import type { Db } from './client.js';

export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

export interface DbContext {
  /** Organização do request. */
  tenantId?: string | null;
  /** Pessoa que age. */
  userId?: string | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function check(label: string, value: string | null | undefined): string {
  if (value == null) return '';
  if (!UUID.test(value)) throw new Error(`contexto: ${label} precisa ser um UUID`);
  return value;
}

/**
 * Aplica o contexto da RLS na transação (ADR-003). `set_config(..., true)` vale só até o fim da
 * transação: a conexão volta ao pool limpa. Nunca `SET` de sessão (LIC-004).
 */
export async function applyContext(tx: Tx, ctx: DbContext & { system?: boolean }): Promise<void> {
  await tx.execute(
    sql`select set_config('app.tenant_id', ${check('tenantId', ctx.tenantId)}, true),
               set_config('app.user_id', ${check('userId', ctx.userId)}, true),
               set_config('app.scope', ${ctx.system ? 'sistema' : 'tenant'}, true)`,
  );
}

/** Transação com tenant e pessoa no contexto da RLS. */
export async function withContext<T>(db: Db, ctx: DbContext, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await applyContext(tx, ctx);
    return fn(tx);
  });
}

/** Transação com o tenant no contexto (sem pessoa): jobs e testes. */
export async function withTenant<T>(db: Db, tenantId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return withContext(db, { tenantId }, fn);
}

/**
 * Transação em **escopo de sistema**: enxerga além do tenant. Só para o que precisa agir antes de saber
 * o tenant (login, sessão, convite, agendador). Uso restrito por regra do Semgrep (`liame-escopo-sistema`).
 */
export async function withSystem<T>(db: Db, fn: (tx: Tx) => Promise<T>, ctx: DbContext = {}): Promise<T> {
  return db.transaction(async (tx) => {
    await applyContext(tx, { ...ctx, system: true });
    return fn(tx);
  });
}
