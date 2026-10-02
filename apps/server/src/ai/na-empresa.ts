import { type Database, withContext } from '@liame/database';
import { requestStore } from '../context/request-context.js';

/**
 * Roda uma leitura dos serviços de domínio fora de uma rota, do mesmo jeito que a rota roda: numa
 * transação com a empresa e a pessoa no contexto da RLS, com a "unidade de trabalho" que os serviços
 * esperam (`currentTx()`). É curta de propósito: a chamada ao modelo acontece DEPOIS dela, sem
 * transação aberta.
 */
export function naTransacaoDaEmpresa<T>(database: Database, quem: { tenantId: string; userId: string | null }, fn: () => Promise<T>): Promise<T> {
  return withContext(database.db, { tenantId: quem.tenantId, userId: quem.userId }, (tx) => requestStore.run({ tx, afterCommit: [] }, fn));
}
