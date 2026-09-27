import { boolean, date, integer, numeric, primaryKey, text, timestamp } from 'drizzle-orm/pg-core';
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
