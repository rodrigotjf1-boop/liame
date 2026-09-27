import { boolean, date, integer, jsonb, numeric, primaryKey, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
import { liame } from './identity.js';

// Espelho das tabelas da migration 0018 (framework dos conectores, A2 G2; arquitetura §6).
const ts = (name: string) => timestamp(name, { withTimezone: true });

export const connectorCapability = liame.table(
  'connector_capability',
  {
    provider: text('provider').notNull(),
    capability: text('capability').notNull(),
    apiVersion: text('api_version').notNull(),
    read: boolean('read').notNull().default(true),
    write: boolean('write').notNull().default(false),
    requiredScope: text('required_scope').array().notNull().default([]),
    accessLevel: text('access_level'),
    deprecatedAt: date('deprecated_at'),
    sunsetAt: date('sunset_at'),
    replacement: text('replacement'),
    sourceUrl: text('source_url').notNull(),
    verifiedAt: date('verified_at').notNull(),
    notes: text('notes'),
  },
  (t) => [primaryKey({ columns: [t.provider, t.capability] })],
);

export const apiDeprecationNotice = liame.table(
  'api_deprecation_notice',
  {
    provider: text('provider').notNull(),
    endpoint: text('endpoint').notNull(),
    apiVersion: text('api_version').notNull().default(''),
    deprecation: text('deprecation'),
    sunset: text('sunset'),
    link: text('link'),
    firstSeenAt: ts('first_seen_at').notNull().defaultNow(),
    lastSeenAt: ts('last_seen_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.provider, t.endpoint, t.apiVersion] })],
);

export const quotaBucket = liame.table('quota_bucket', {
  bucketKey: text('bucket_key').primaryKey(),
  capacity: numeric('capacity').notNull(),
  refillPerSecond: numeric('refill_per_second').notNull(),
  tokens: numeric('tokens').notNull(),
  refilledAt: ts('refilled_at').notNull().defaultNow(),
});

export const circuitState = liame.table('circuit_state', {
  circuitKey: text('circuit_key').primaryKey(),
  failures: integer('failures').notNull().default(0),
  openedTimes: integer('opened_times').notNull().default(0),
  openUntil: ts('open_until'),
  lastError: text('last_error'),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

// Vigia de integrações (migration 0020, A2 G8; ADR-015).
export const watchSource = liame.table('watch_source', {
  id: uuid('id').primaryKey(),
  provider: text('provider').notNull(),
  kind: text('kind').notNull(),
  title: text('title').notNull(),
  url: text('url').notNull().unique(),
  active: boolean('active').notNull().default(true),
  lastCheckedAt: ts('last_checked_at'),
  lastOkAt: ts('last_ok_at'),
  lastError: text('last_error'),
  failures: integer('failures').notNull().default(0),
  createdAt: ts('created_at').notNull().defaultNow(),
});

export const watchSnapshot = liame.table('watch_snapshot', {
  sourceId: uuid('source_id').primaryKey(),
  fetchedAt: ts('fetched_at').notNull(),
  contentHash: text('content_hash').notNull(),
  sections: jsonb('sections').notNull(),
});

export const watchChange = liame.table('watch_change', {
  id: uuid('id').primaryKey(),
  sourceId: uuid('source_id').notNull(),
  detectedAt: ts('detected_at').notNull().defaultNow(),
  sectionTitle: text('section_title').notNull(),
  change: text('change').notNull(),
  oldHash: text('old_hash'),
  newHash: text('new_hash'),
  excerpt: text('excerpt'),
  reviewedAt: ts('reviewed_at'),
});

export const watchAlert = liame.table(
  'watch_alert',
  {
    id: uuid('id').primaryKey(),
    kind: text('kind').notNull(),
    provider: text('provider').notNull(),
    apiVersion: text('api_version').notNull().default(''),
    stage: text('stage').notNull().default(''),
    dueDate: date('due_date'),
    message: text('message').notNull(),
    sourceUrl: text('source_url'),
    createdAt: ts('created_at').notNull().defaultNow(),
    resolvedAt: ts('resolved_at'),
  },
  (t) => [unique().on(t.kind, t.provider, t.apiVersion, t.stage)],
);
