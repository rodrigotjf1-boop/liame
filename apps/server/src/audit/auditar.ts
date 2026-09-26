import { SetMetadata } from '@nestjs/common';

// Toda rota que muda dado declara o que audita (A1-6). Sem declaração, o app não sobe.
export const AUDIT_KEY = 'liame:auditoria';

export type AuditDeclaration =
  | {
      kind: 'auditar';
      action: string;
      /** `empresa` (padrão): cadeia da empresa ativa; `pessoa`: cadeia da própria pessoa (entrar, segundo fator). */
      scope: 'empresa' | 'pessoa';
      resourceType: string | null;
      /** O serviço grava o evento na própria transação (rotas públicas ou que mudam de empresa). */
      manual: boolean;
    }
  | { kind: 'sem-auditoria'; reason: string };

export const Auditar = (
  action: string,
  options: { escopo?: 'empresa' | 'pessoa'; recurso?: string; manual?: boolean } = {},
) =>
  SetMetadata(AUDIT_KEY, {
    kind: 'auditar',
    action,
    scope: options.escopo ?? 'empresa',
    resourceType: options.recurso ?? null,
    manual: options.manual ?? false,
  } satisfies AuditDeclaration);

/** Mutação que não gera evento de auditoria, com o motivo explícito (revisado em PR). */
export const SemAuditoria = (reason: string) => SetMetadata(AUDIT_KEY, { kind: 'sem-auditoria', reason } satisfies AuditDeclaration);
