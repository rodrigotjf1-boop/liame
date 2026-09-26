import { z } from 'zod';

// Motor de políticas determinístico (ADR-007, A1-11): políticas como dado, versionadas; o código decide.
// Campos em inglês (contrato); códigos de ação em português, como as permissões (`orcamento.aumentar`).

export const AutonomyMode = z.enum(['SHADOW', 'SUGGEST', 'APPROVAL', 'LIMITED_AUTO', 'AUTO', 'ESCALATE']);
export type AutonomyMode = z.infer<typeof AutonomyMode>;

export const RiskLevel = z.enum(['R0', 'R1', 'R2', 'R3']);
export type RiskLevel = z.infer<typeof RiskLevel>;

export const BudgetImpact = z.enum(['none', 'increase', 'decrease', 'new_spend']);
export type BudgetImpact = z.infer<typeof BudgetImpact>;

/** `orcamento.aumentar`, ou `orcamento.*` para todas as ações do recurso. */
const ActionPattern = z.string().regex(/^[a-z_]+\.([a-z_]+|\*)$/, { error: 'Use recurso.acao ou recurso.*' });
const Slug = z.string().regex(/^[a-z0-9_]+$/).max(60);
const Micros = z.int().min(0).max(Number.MAX_SAFE_INTEGER);
const Hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, { error: 'Use HH:MM' });

export const PolicyRule = z.discriminatedUnion('type', [
  /** Teto por ação: o valor pedido não passa disto. */
  z.strictObject({ type: z.literal('max_value'), action: ActionPattern.optional(), max_micros: Micros }),
  /** Variação máxima em relação ao valor atual (por padrão, só para aumento). */
  z.strictObject({
    type: z.literal('max_change_percent'),
    action: ActionPattern.optional(),
    max_percent: z.number().min(0).max(1000),
    direction: z.enum(['increase', 'decrease', 'both']).default('increase'),
  }),
  /** Janela de horário no fuso da empresa (pode passar da meia-noite). Dias: 0 = domingo. */
  z.strictObject({
    type: z.literal('allowed_hours'),
    action: ActionPattern.optional(),
    days: z.array(z.int().min(0).max(6)).min(1).max(7).optional(),
    start: Hhmm,
    end: Hhmm,
  }),
  /** Só estas contas do provedor podem ser mexidas. */
  z.strictObject({ type: z.literal('allowed_accounts'), provider: Slug, accounts: z.array(z.string().min(1).max(100)).min(1).max(500) }),
  /** Escopo: só estas ferramentas e/ou ações. */
  z.strictObject({
    type: z.literal('allowed_scope'),
    tools: z.array(Slug).max(200).optional(),
    actions: z.array(ActionPattern).max(200).optional(),
  }),
  /** Categorias de conteúdo proibidas (ex.: `politica`, `saude`, `apostas`). */
  z.strictObject({ type: z.literal('forbidden_categories'), categories: z.array(Slug).min(1).max(100) }),
  /** Palavras e alegações proibidas no texto (sem diferença de maiúsculas e acentos). */
  z.strictObject({ type: z.literal('forbidden_words'), words: z.array(z.string().trim().min(2).max(100)).min(1).max(500) }),
  /** No máximo `max` execuções da ação na janela (a contagem vem de quem pede). */
  z.strictObject({
    type: z.literal('rate_limit'),
    action: ActionPattern.optional(),
    provider: Slug.optional(),
    max: z.int().min(1).max(10_000),
    window_minutes: z.int().min(1).max(44_640),
  }),
  /** Modo de autonomia quando a regra casa; a mais específica vence e ESCALATE vence sempre. */
  z.strictObject({
    type: z.literal('autonomy'),
    action: ActionPattern.optional(),
    tool: Slug.optional(),
    account: z.string().min(1).max(100).optional(),
    risk: RiskLevel.optional(),
    /** Casa só se a variação for no máximo este %. */
    up_to_percent: z.number().min(0).max(1000).optional(),
    /** Casa só se o valor passar disto. */
    above_micros: Micros.optional(),
    mode: AutonomyMode,
  }),
]);
export type PolicyRule = z.infer<typeof PolicyRule>;

export const PolicyDocument = z.strictObject({ rules: z.array(PolicyRule).max(500) });
export type PolicyDocument = z.infer<typeof PolicyDocument>;

/** O que alguém (pessoa, agente, automação) quer fazer. */
export const ActionProposal = z.strictObject({
  tool: Slug,
  action: z.string().regex(/^[a-z_]+\.[a-z_]+$/),
  brand_id: z.uuid().nullable().optional(),
  provider: Slug.nullable().optional(),
  account_id: z.string().min(1).max(100).nullable().optional(),
  risk_level: RiskLevel,
  budget_impact: BudgetImpact,
  /** Valor pedido (ex.: orçamento novo) e o atual, em micros. */
  value_micros: Micros.nullable().optional(),
  current_value_micros: Micros.nullable().optional(),
  categories: z.array(Slug).max(50).default([]),
  text: z.string().max(20_000).nullable().optional(),
  /** Execuções recentes da mesma ação (para `rate_limit`), contadas por quem pede. */
  recent_count: z.int().min(0).default(0),
});
export type ActionProposal = z.infer<typeof ActionProposal>;

export const PolicyViolation = z.strictObject({
  source: z.enum(['platform', 'tenant', 'brand']),
  rule_index: z.int(),
  type: z.string(),
  message: z.string(),
});
export type PolicyViolation = z.infer<typeof PolicyViolation>;

export const PolicyDecision = z.strictObject({
  allowed: z.boolean(),
  mode: AutonomyMode,
  violations: z.array(PolicyViolation),
  /** Versões avaliadas: `plataforma@1`, `empresa@3`, `marca@2`. */
  versions: z.array(z.string()),
});
export type PolicyDecision = z.infer<typeof PolicyDecision>;

export const PolicyVersionResponse = z.strictObject({
  id: z.uuid(),
  brand_id: z.uuid().nullable(),
  version: z.int(),
  status: z.enum(['ativa', 'arquivada']),
  document: PolicyDocument,
  created_at: z.string(),
});
export type PolicyVersionResponse = z.infer<typeof PolicyVersionResponse>;

export const PolicyListResponse = z.strictObject({
  /** Política da distribuição, que vale para todas as empresas e não pode ser removida. */
  platform: z.strictObject({ version: z.int(), document: PolicyDocument }),
  items: z.array(PolicyVersionResponse),
});
export type PolicyListResponse = z.infer<typeof PolicyListResponse>;

export const PublishPolicyRequest = z.strictObject({
  brand_id: z.uuid().nullable().default(null),
  document: PolicyDocument,
});
export type PublishPolicyRequest = z.infer<typeof PublishPolicyRequest>;
