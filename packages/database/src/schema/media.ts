import { bigint, date, integer, jsonb, numeric, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { liame } from './identity.js';

// Espelho das tabelas da migration 0017 (modelo de mídia, A2 G1; data-model §3).
const ts = (name: string) => timestamp(name, { withTimezone: true });
const micros = (name: string) => bigint(name, { mode: 'number' });

export const connectedAccount = liame.table('connected_account', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  brandId: uuid('brand_id').notNull(),
  unitId: uuid('unit_id'),
  provider: text('provider').notNull(),
  externalId: text('external_id').notNull(),
  name: text('name').notNull(),
  currency: text('currency'),
  timezone: text('timezone'),
  status: text('status').notNull().default('ativa'),
  statusReason: text('status_reason'),
  credentialSecretId: uuid('credential_secret_id'),
  connectionId: uuid('connection_id'),
  providerAttributes: jsonb('provider_attributes').notNull().default({}),
  connectedBy: uuid('connected_by'),
  connectedAt: ts('connected_at').notNull().defaultNow(),
  disconnectedAt: ts('disconnected_at'),
  createdAt: ts('created_at').notNull().defaultNow(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

const entidade = {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  connectedAccountId: uuid('connected_account_id').notNull(),
  provider: text('provider').notNull(),
  externalId: text('external_id').notNull(),
  providerAttributes: jsonb('provider_attributes').notNull().default({}),
  rawRef: uuid('raw_ref'),
  firstSeenAt: ts('first_seen_at').notNull().defaultNow(),
  lastSeenAt: ts('last_seen_at').notNull().defaultNow(),
};

export const campaign = liame.table('campaign', {
  ...entidade,
  name: text('name').notNull(),
  status: text('status').notNull(),
  providerStatus: text('provider_status'),
  objective: text('objective'),
  dailyBudgetMicros: micros('daily_budget_micros'),
  lifetimeBudgetMicros: micros('lifetime_budget_micros'),
  providerCreatedAt: ts('provider_created_at'),
  providerUpdatedAt: ts('provider_updated_at'),
});

export const adGroup = liame.table('ad_group', {
  ...entidade,
  campaignId: uuid('campaign_id'),
  name: text('name').notNull(),
  status: text('status').notNull(),
  providerStatus: text('provider_status'),
  dailyBudgetMicros: micros('daily_budget_micros'),
});

export const creative = liame.table('creative', {
  ...entidade,
  name: text('name'),
  kind: text('kind'),
  thumbnailUrl: text('thumbnail_url'),
});

export const ad = liame.table('ad', {
  ...entidade,
  adGroupId: uuid('ad_group_id'),
  creativeId: uuid('creative_id'),
  name: text('name').notNull(),
  status: text('status').notNull(),
  providerStatus: text('provider_status'),
});

export const metricObservation = liame.table('metric_observation', {
  id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
  tenantId: uuid('tenant_id').notNull(),
  brandId: uuid('brand_id').notNull(),
  connectedAccountId: uuid('connected_account_id').notNull(),
  provider: text('provider').notNull(),
  level: text('level').notNull(),
  entityId: uuid('entity_id'),
  externalEntityId: text('external_entity_id').notNull(),
  metricDate: date('metric_date').notNull(),
  metricName: text('metric_name').notNull(),
  attributionWindow: text('attribution_window').notNull().default(''),
  metricValue: numeric('metric_value').notNull(),
  currency: text('currency'),
  timezone: text('timezone'),
  observedAt: ts('observed_at').notNull(),
  syncRunId: uuid('sync_run_id'),
  sourceVersion: text('source_version'),
  quality: text('quality').notNull().default('ok'),
});

export const metricLatest = liame.table(
  'metric_latest',
  {
    connectedAccountId: uuid('connected_account_id').notNull(),
    level: text('level').notNull(),
    externalEntityId: text('external_entity_id').notNull(),
    metricDate: date('metric_date').notNull(),
    metricName: text('metric_name').notNull(),
    attributionWindow: text('attribution_window').notNull().default(''),
    tenantId: uuid('tenant_id').notNull(),
    brandId: uuid('brand_id').notNull(),
    provider: text('provider').notNull(),
    entityId: uuid('entity_id'),
    metricValue: numeric('metric_value').notNull(),
    currency: text('currency'),
    timezone: text('timezone'),
    observedAt: ts('observed_at').notNull(),
    changedAt: ts('changed_at').notNull(),
    syncRunId: uuid('sync_run_id'),
    sourceVersion: text('source_version'),
    quality: text('quality').notNull().default('ok'),
  },
  (t) => [primaryKey({ columns: [t.connectedAccountId, t.level, t.externalEntityId, t.metricDate, t.metricName, t.attributionWindow] })],
);

export const metricMapping = liame.table(
  'metric_mapping',
  {
    provider: text('provider').notNull(),
    providerMetric: text('provider_metric').notNull(),
    canonicalMetric: text('canonical_metric').notNull(),
    transform: text('transform').notNull().default('identidade'),
    confidence: text('confidence').notNull().default('alta'),
    notes: text('notes'),
  },
  (t) => [primaryKey({ columns: [t.provider, t.providerMetric] })],
);

export const rawPayload = liame.table('raw_payload', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  connectedAccountId: uuid('connected_account_id').notNull(),
  provider: text('provider').notNull(),
  endpoint: text('endpoint').notNull(),
  apiVersion: text('api_version'),
  fetchedAt: ts('fetched_at').notNull().defaultNow(),
  hash: text('hash').notNull(),
  body: jsonb('body').notNull(),
});

export const syncRun = liame.table('sync_run', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  connectedAccountId: uuid('connected_account_id').notNull(),
  dataset: text('dataset').notNull(),
  kind: text('kind').notNull(),
  windowStart: date('window_start'),
  windowEnd: date('window_end'),
  status: text('status').notNull().default('rodando'),
  apiVersion: text('api_version'),
  calls: integer('calls').notNull().default(0),
  entitiesWritten: integer('entities_written').notNull().default(0),
  observationsNew: integer('observations_new').notNull().default(0),
  error: text('error'),
  startedAt: ts('started_at').notNull().defaultNow(),
  finishedAt: ts('finished_at'),
});

export const syncState = liame.table(
  'sync_state',
  {
    connectedAccountId: uuid('connected_account_id').notNull(),
    dataset: text('dataset').notNull(),
    tenantId: uuid('tenant_id').notNull(),
    expectedEveryMinutes: integer('expected_every_minutes').notNull(),
    lastSuccessAt: ts('last_success_at'),
    lastAttemptAt: ts('last_attempt_at'),
    lastError: text('last_error'),
    cursor: jsonb('cursor').notNull().default({}),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.connectedAccountId, t.dataset] })],
);
