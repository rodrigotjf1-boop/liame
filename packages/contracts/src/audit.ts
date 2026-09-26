import { z } from 'zod';

// Auditoria da empresa ativa (security-model §7): só leitura, com a verificação da cadeia.

export const AuditEventResponse = z.strictObject({
  id: z.uuid(),
  seq: z.int(),
  occurred_at: z.string(),
  actor_type: z.enum(['human', 'agent', 'integration', 'system', 'partner']),
  /** Quem era no momento ("Juliana, Administrador"). */
  actor_label: z.string().nullable(),
  action: z.string(),
  resource_type: z.string().nullable(),
  resource_id: z.string().nullable(),
  before: z.record(z.string(), z.unknown()).nullable(),
  after: z.record(z.string(), z.unknown()).nullable(),
  reason: z.string().nullable(),
  trace_id: z.string().nullable(),
});
export type AuditEventResponse = z.infer<typeof AuditEventResponse>;

export const AuditEventListResponse = z.strictObject({
  items: z.array(AuditEventResponse),
  /** Passe em `before_seq` para a página seguinte (mais antiga); nulo quando acabou. */
  next_before_seq: z.int().nullable(),
});
export type AuditEventListResponse = z.infer<typeof AuditEventListResponse>;

export const AuditEventQuery = z.strictObject({
  before_seq: z.coerce.number().int().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export type AuditEventQuery = z.infer<typeof AuditEventQuery>;

export const AuditVerifyResponse = z.strictObject({
  ok: z.boolean(),
  events_checked: z.int(),
  head_seq: z.int(),
  /** Primeiro evento que não confere. */
  broken_at_seq: z.int().nullable(),
  reason: z.string().nullable(),
});
export type AuditVerifyResponse = z.infer<typeof AuditVerifyResponse>;
