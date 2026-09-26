import { AsyncLocalStorage } from 'node:async_hooks';
import type { Tx } from '@liame/database';
import type { RoleKey } from '@liame/contracts';

/** Quem está pedindo: resolvido pelo guard a partir da sessão, em toda rota que não é pública. */
export interface AuthContext {
  userId: string;
  sessionId: string;
  email: string;
  name: string;
  /** Empresa ativa da sessão e o vínculo da pessoa com ela (nulos se não houver). */
  tenantId: string | null;
  roleKey: RoleKey | null;
  mfaVerifiedAt: Date | null;
}

interface RequestStore {
  tx: Tx;
}

/** Transação da requisição (unidade de trabalho), com o contexto da RLS já aplicado. */
export const requestStore = new AsyncLocalStorage<RequestStore>();

/** A transação da requisição atual. Fora de uma rota autenticada, é erro de programação. */
export function currentTx(): Tx {
  const store = requestStore.getStore();
  if (!store) throw new Error('sem transação da requisição: use withContext ou withSystem explicitamente');
  return store.tx;
}
