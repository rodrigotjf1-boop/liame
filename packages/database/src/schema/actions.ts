import { bigint, boolean, integer, jsonb, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { liame } from './identity.js';

// Espelho das tabelas da migration 0011 (ações, aprovação, orçamento e sandbox, ADR-007).
const ts = (name: string) => timestamp(name, { withTimezone: true });
const money = (name: string) => bigint(name, { mode: 'number' });

export const sandboxResource = liame.table(
  'sandbox_resource',
  {
    tenantId: uuid('tenant_id').notNull(),
    accountId: text('account_id').notNull(),
    resourceId: text('resource_id').notNull(),
    state: jsonb('state').notNull(),
    version: integer('version').notNull().default(1),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.accountId, t.resourceId] })],
);

export const actionRequest = liame.table('action_request', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  brandId: uuid('brand_id'),
  tool: text('tool').notNull(),
  action: text('action').notNull(),
  provider: text('provider').notNull(),
  accountId: text('account_id').notNull(),
  resourceId: text('resource_id').notNull(),
  params: jsonb('params').notNull(),
  riskLevel: text('risk_level').notNull(),
  budgetImpact: text('budget_impact').notNull(),
  valueMicros: money('value_micros'),
  currentValueMicros: money('current_value_micros'),
  reservedMicros: money('reserved_micros').notNull().default(0),
  beforeState: jsonb('before_state'),
  beforeVersion: integer('before_version'),
  desiredState: jsonb('desired_state').notNull(),
  planHash: text('plan_hash').notNull(),
  actionFingerprint: text('action_fingerprint').notNull(),
  mode: text('mode').notNull(),
  policyDecision: jsonb('policy_decision').notNull(),
  status: text('status').notNull(),
  statusReason: text('status_reason'),
  actorType: text('actor_type').notNull().default('human'),
  requestedBy: uuid('requested_by').notNull(),
  traceContext: text('trace_context'),
  expiresAt: ts('expires_at').notNull(),
  createdAt: ts('created_at').notNull().defaultNow(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

export const approval = liame.table('approval', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  actionRequestId: uuid('action_request_id').notNull(),
  planHash: text('plan_hash').notNull(),
  approvedBy: uuid('approved_by').notNull(),
  approverRole: text('approver_role').notNull(),
  approverLimitMicros: money('approver_limit_micros'),
  sufficient: boolean('sufficient').notNull(),
  method: text('method').notNull(),
  createdAt: ts('created_at').notNull().defaultNow(),
});

export const budgetPolicy = liame.table('budget_policy', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  brandId: uuid('brand_id'),
  limitMicros: money('limit_micros').notNull(),
  createdBy: uuid('created_by').notNull(),
  createdAt: ts('created_at').notNull().defaultNow(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

export const budgetLedgerEntry = liame.table('budget_ledger_entry', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  brandId: uuid('brand_id'),
  period: text('period').notNull(),
  actionRequestId: uuid('action_request_id'),
  kind: text('kind').notNull(),
  amountMicros: money('amount_micros').notNull(),
  createdAt: ts('created_at').notNull().defaultNow(),
});

// Migration 0012 (execução e workflow durável, ADR-005).
export const actionExecution = liame.table('action_execution', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  actionRequestId: uuid('action_request_id').notNull(),
  planHash: text('plan_hash').notNull(),
  expectedState: jsonb('expected_state'),
  expectedVersion: integer('expected_version'),
  observedState: jsonb('observed_state'),
  desiredState: jsonb('desired_state').notNull(),
  resultState: jsonb('result_state'),
  providerVersion: integer('provider_version'),
  status: text('status').notNull(),
  error: text('error'),
  startedAt: ts('started_at').notNull(),
  finishedAt: ts('finished_at').notNull().defaultNow(),
});

export const workflowRun = liame.table('workflow_run', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  kind: text('kind').notNull(),
  subjectId: uuid('subject_id').notNull(),
  status: text('status').notNull(),
  currentStep: text('current_step'),
  createdAt: ts('created_at').notNull().defaultNow(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

export const workflowStep = liame.table('workflow_step', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  runId: uuid('run_id').notNull(),
  name: text('name').notNull(),
  status: text('status').notNull(),
  output: jsonb('output'),
  attempts: integer('attempts').notNull().default(0),
  startedAt: ts('started_at').notNull().defaultNow(),
  finishedAt: ts('finished_at'),
});
