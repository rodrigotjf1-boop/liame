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
  /** Permissões do papel na empresa ativa, lidas do banco (vazio sem empresa ativa). */
  permissions: ReadonlySet<string>;
  mfaVerifiedAt: Date | null;
  /** A pessoa tem app autenticador ativo. */
  mfaConfigured: boolean;
  /** Como a sessão provou o segundo fator. */
  mfaMethod: 'totp' | 'recuperacao' | null;
}

interface RequestStore {
  tx: Tx;
  /** Efeitos que só podem acontecer se a transação gravar (e-mail com link, aviso). */
  afterCommit: Array<() => Promise<void>>;
}

/** Transação da requisição (unidade de trabalho), com o contexto da RLS já aplicado. */
export const requestStore = new AsyncLocalStorage<RequestStore>();

/** A transação da requisição atual. Fora de uma rota autenticada, é erro de programação. */
export function currentTx(): Tx {
  const store = requestStore.getStore();
  if (!store) throw new Error('sem transação da requisição: use withContext ou withSystem explicitamente');
  return store.tx;
}

/**
 * Agenda um efeito para depois do commit da transação da requisição: se ela desfizer, o efeito não
 * acontece. A falha do efeito é registrada e não muda a resposta (LIC-001).
 */
export function afterCommit(effect: () => Promise<void>): void {
  const store = requestStore.getStore();
  if (!store) throw new Error('sem transação da requisição: afterCommit só vale dentro de uma rota autenticada');
  store.afterCommit.push(effect);
}
