import { z } from 'zod';
import { AutonomyMode, BudgetImpact, PolicyDecision, RiskLevel } from './policy.js';

// Pedido de ação (ADR-007): toda escrita fora do Liame passa por aqui. Risco, impacto e valores vêm
// do registro de ferramentas e do estado lido no provedor, nunca de quem pede.

const Slug = z.string().regex(/^[a-z0-9_]+$/).max(60);
const Ref = z.string().min(1).max(100);
const Micros = z.int().min(0).max(Number.MAX_SAFE_INTEGER);

export const ActionStatus = z.enum(['sombra', 'aguardando_aprovacao', 'aprovada', 'executando', 'executada', 'falhou', 'cancelada', 'expirada']);
export type ActionStatus = z.infer<typeof ActionStatus>;

export const CreateActionRequest = z.strictObject({
  tool: Slug,
  brand_id: z.uuid().nullable().optional(),
  provider: Slug,
  account_id: Ref,
  resource_id: Ref,
  params: z.record(z.string(), z.unknown()),
});
export type CreateActionRequest = z.infer<typeof CreateActionRequest>;

export const UpdateActionRequest = z.strictObject({ params: z.record(z.string(), z.unknown()) });
export type UpdateActionRequest = z.infer<typeof UpdateActionRequest>;

/** Aprovar exige o código do app autenticador agora (fora do chat, ADR-007) e o hash do plano visto. */
export const ApproveActionRequest = z.strictObject({
  plan_hash: z.string().regex(/^[0-9a-f]{64}$/),
  code: z.string().regex(/^\d{6}$/, { error: 'Digite os 6 números do app' }),
});
export type ApproveActionRequest = z.infer<typeof ApproveActionRequest>;

export const ActionApproval = z.strictObject({
  approved_by: z.uuid(),
  approver_name: z.string(),
  approver_role: z.string(),
  sufficient: z.boolean(),
  /** A aprovação foi para o plano atual (se o plano mudou depois, ela não vale). */
  current_plan: z.boolean(),
  created_at: z.string(),
});

export const ActionResponse = z.strictObject({
  id: z.uuid(),
  tool: z.string(),
  action: z.string(),
  brand_id: z.uuid().nullable(),
  provider: z.string(),
  account_id: z.string(),
  resource_id: z.string(),
  params: z.record(z.string(), z.unknown()),
  risk_level: RiskLevel,
  budget_impact: BudgetImpact,
  value_micros: Micros.nullable(),
  current_value_micros: Micros.nullable(),
  reserved_micros: Micros,
  plan_hash: z.string(),
  mode: AutonomyMode,
  status: ActionStatus,
  status_reason: z.string().nullable(),
  policy: PolicyDecision,
  approvals: z.array(ActionApproval),
  expires_at: z.string(),
  created_at: z.string(),
});
export type ActionResponse = z.infer<typeof ActionResponse>;

export const ActionListResponse = z.strictObject({ items: z.array(ActionResponse) });
export type ActionListResponse = z.infer<typeof ActionListResponse>;

export const ActionListQuery = z.strictObject({ status: ActionStatus.optional() });
export type ActionListQuery = z.infer<typeof ActionListQuery>;

// ------------------------------------------------------------------ orçamento

export const BudgetPolicyRequest = z.strictObject({ brand_id: z.uuid().nullable().default(null), limit_micros: Micros });
export type BudgetPolicyRequest = z.infer<typeof BudgetPolicyRequest>;

export const BudgetEnvelope = z.strictObject({
  brand_id: z.uuid().nullable(),
  limit_micros: Micros,
  /** Reservado e ainda não liberado (inclui o já executado). */
  committed_micros: Micros,
  executed_micros: Micros,
  available_micros: z.int(),
});

export const BudgetResponse = z.strictObject({ period: z.string(), envelopes: z.array(BudgetEnvelope) });
export type BudgetResponse = z.infer<typeof BudgetResponse>;

// ------------------------------------------------------------------ sandbox

export const SandboxResourceRequest = z.strictObject({ account_id: Ref, resource_id: Ref, state: z.record(z.string(), z.unknown()) });
export type SandboxResourceRequest = z.infer<typeof SandboxResourceRequest>;

export const SandboxResourceResponse = z.strictObject({
  account_id: z.string(),
  resource_id: z.string(),
  state: z.record(z.string(), z.unknown()),
  version: z.int(),
});
export type SandboxResourceResponse = z.infer<typeof SandboxResourceResponse>;
