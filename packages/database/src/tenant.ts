import { sql } from 'drizzle-orm';
import type { Db } from './client.js';

export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Roda `fn` numa transação com o tenant no contexto da RLS (ADR-003).
 *
 * `set_config(..., true)` vale só até o fim da transação: a conexão volta ao pool sem tenant.
 * Nunca usar `SET` de sessão (LIC-004). O tenant vem do token, nunca de argumento do cliente.
 */
export async function withTenant<T>(db: Db, tenantId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  if (!UUID.test(tenantId)) {
    throw new Error('withTenant: tenantId precisa ser um UUID');
  }
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.tenant_id', ${tenantId}, true)`);
    return fn(tx);
  });
}
