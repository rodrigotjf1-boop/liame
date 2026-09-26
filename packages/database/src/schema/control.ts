import { boolean, date, integer, jsonb, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { liame } from './identity.js';

// Espelho das tabelas da migration 0009 (feature flags e kill switch, ADR-012 e ADR-007).
const ts = (name: string) => timestamp(name, { withTimezone: true });

export const featureFlag = liame.table('feature_flag', {
  key: text('key').primaryKey(),
  kind: text('kind').notNull(),
  defaultValue: jsonb('default_value').notNull(),
  description: text('description').notNull(),
  owner: text('owner').notNull(),
  isWrite: boolean('is_write').notNull().default(false),
  expiresOn: date('expires_on'),
  createdAt: ts('created_at').notNull().defaultNow(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

export const featureFlagRule = liame.table('feature_flag_rule', {
  id: uuid('id').primaryKey(),
  flagKey: text('flag_key').notNull(),
  scopeType: text('scope_type').notNull(),
  scopeId: text('scope_id').notNull(),
  value: jsonb('value').notNull(),
  rolloutPercent: integer('rollout_percent'),
  startsAt: ts('starts_at'),
  endsAt: ts('ends_at'),
  createdBy: text('created_by').notNull(),
  createdAt: ts('created_at').notNull().defaultNow(),
});

export const killSwitch = liame.table('kill_switch', {
  id: uuid('id').primaryKey(),
  level: text('level').notNull(),
  tenantId: uuid('tenant_id'),
  provider: text('provider'),
  brandId: uuid('brand_id'),
  accountId: text('account_id'),
  tool: text('tool'),
  reason: text('reason').notNull(),
  activatedBy: uuid('activated_by'),
  activatedAt: ts('activated_at').notNull().defaultNow(),
  deactivatedBy: uuid('deactivated_by'),
  deactivatedAt: ts('deactivated_at'),
});
