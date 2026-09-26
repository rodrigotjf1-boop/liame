import type { InvitableRole, RoleKey } from '@liame/contracts';
import { ROLE_RANK } from '../auth/permissions.js';
import { AppProblem, ValidationProblem } from '../errors/problems.js';

// Regras de concessão do acesso delegado (ADR-017): ninguém dá mais poder do que tem.

/** Níveis que aprovam gasto e, por isso, têm limite por ação. */
export const APPROVER_ROLES: ReadonlySet<RoleKey> = new Set<RoleKey>(['administrador', 'gestor', 'aprovador']);

export const ROLE_LABEL: Record<RoleKey, string> = {
  dono: 'Dono',
  administrador: 'Administrador',
  gestor: 'Gestor',
  aprovador: 'Aprovador',
  somente_leitura: 'Somente leitura',
  so_relatorios: 'Só relatórios por e-mail',
};

/** Quem concede: o nível e o limite do próprio vínculo na empresa ativa. */
export interface Grantor {
  role: RoleKey;
  approveLimitMicros: number | null;
}

/** Um acesso: o que vale hoje ou o que vai valer depois da concessão. */
export interface Grant {
  role: InvitableRole;
  /** Nulo = sem limite; indefinido = não informado (erro para quem aprova). */
  approveLimitMicros: number | null | undefined;
  dualApproval: boolean;
  billingAccess: boolean;
}

export type CheckedGrant = Grant & { approveLimitMicros: number | null };

/**
 * Confere e normaliza a concessão. `current` é o acesso de hoje (nulo num convite novo): só o que muda
 * passa pelas travas, então o que o dono já concedeu continua valendo quando um administrador mexe em
 * outro campo.
 */
export function checkGrant(by: Grantor, next: Grant, current: CheckedGrant | null): CheckedGrant {
  const isOwner = by.role === 'dono';
  const approver = APPROVER_ROLES.has(next.role);
  const roleChanged = !current || current.role !== next.role;
  const becameApprover = roleChanged && approver && (!current || !APPROVER_ROLES.has(current.role));
  const limitChanged = becameApprover || (current !== null && current.approveLimitMicros !== next.approveLimitMicros);
  const dualChanged = current ? current.dualApproval !== next.dualApproval : !next.dualApproval;
  const billingChanged = current ? current.billingAccess !== next.billingAccess : next.billingAccess;

  if (roleChanged && ROLE_RANK[next.role] > ROLE_RANK[by.role]) {
    throw new AppProblem(403, 'nivel-acima-do-seu', 'Nível acima do seu', 'Você não pode dar um nível de acesso acima do seu.');
  }
  if (next.billingAccess && next.role !== 'administrador') {
    throw new ValidationProblem([{ path: 'billing_access', message: 'Acesso à cobrança é só para o nível Administrador.' }]);
  }
  if (!isOwner && billingChanged) {
    throw new AppProblem(403, 'cobranca-so-o-dono', 'Só o dono', 'Só o dono libera ou tira o acesso à cobrança.');
  }

  if (!approver) {
    // Quem não aprova não tem limite nem cobrança.
    return { role: next.role, approveLimitMicros: null, dualApproval: true, billingAccess: false };
  }
  if (next.approveLimitMicros === undefined) {
    throw new ValidationProblem([{ path: 'approve_limit_micros', message: 'Informe o limite de aprovação por ação.' }]);
  }
  if (!isOwner && dualChanged && !next.dualApproval) {
    throw new AppProblem(403, 'aprovacao-dupla-so-o-dono', 'Só o dono', 'Só o dono dispensa a aprovação dele acima do limite.');
  }
  if (!isOwner && limitChanged && exceeds(next.approveLimitMicros, by.approveLimitMicros)) {
    throw new AppProblem(403, 'limite-acima-do-seu', 'Limite acima do seu', 'Você não pode dar um limite de aprovação maior que o seu.');
  }
  return { ...next, approveLimitMicros: next.approveLimitMicros };
}

/** Nulo é "sem limite": só cabe dentro de outro "sem limite". */
function exceeds(limit: number | null, ceiling: number | null): boolean {
  if (ceiling === null) return false;
  return limit === null || limit > ceiling;
}
