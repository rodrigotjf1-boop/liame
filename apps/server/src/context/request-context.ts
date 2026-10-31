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
  /** Situação da empresa ativa: em encerramento (`suspensa`), só leitura, exportar e reativar (ADR-014). */
  tenantStatus: 'ativa' | 'suspensa' | 'encerrada' | null;
  /**
   * Marcas da empresa ativa com a assinatura suspensa (30º dia de atraso; `plano-a7.md` D-A7-40): nelas, só o Dono
   * entra, para pagar ou exportar os dados. Não confundir com `tenantStatus = 'suspensa'` (a empresa em encerramento).
   */
  suspendedBrands: ReadonlySet<string>;
  /** Todas as marcas vivas da empresa ativa estão suspensas: a conta inteira fica suspensa (D-A7-40). */
  allBrandsSuspended: boolean;
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
  /** Detalhes que o serviço acrescenta ao evento de auditoria automático da rota. */
  audit?: AuditDetail;
}

export interface AuditDetail {
  resourceId?: string;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
  reason?: string;
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

/** Acrescenta detalhes (recurso, antes, depois, motivo) ao evento de auditoria da rota atual. */
export function auditDetail(detail: AuditDetail): void {
  const store = requestStore.getStore();
  if (!store) throw new Error('sem transação da requisição: auditDetail só vale dentro de uma rota autenticada');
  store.audit = { ...store.audit, ...detail };
}
