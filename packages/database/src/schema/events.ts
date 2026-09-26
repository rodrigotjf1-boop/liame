import { integer, jsonb, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { liame } from './identity.js';

// Espelho das tabelas da migration 0007 (eventos e idempotência, ADR-004).
const ts = (name: string) => timestamp(name, { withTimezone: true });

export const outboxEvent = liame.table('outbox_event', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id'),
  type: text('type').notNull(),
  subject: text('subject'),
  data: jsonb('data').notNull(),
  occurredAt: ts('occurred_at').notNull().defaultNow(),
  publishedAt: ts('published_at'),
  createdAt: ts('created_at').notNull().defaultNow(),
  traceContext: text('trace_context'),
});

export const webhookEndpoint = liame.table('webhook_endpoint', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  url: text('url').notNull(),
  description: text('description'),
  eventTypes: text('event_types').array().notNull().default([]),
  secretId: uuid('secret_id').notNull(),
  createdBy: uuid('created_by').notNull(),
  createdAt: ts('created_at').notNull().defaultNow(),
  disabledAt: ts('disabled_at'),
});

export const webhookDelivery = liame.table('webhook_delivery', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  endpointId: uuid('endpoint_id').notNull(),
  eventId: uuid('event_id').notNull(),
  status: text('status').notNull().default('pendente'),
  attempts: integer('attempts').notNull().default(0),
  nextAttemptAt: ts('next_attempt_at').notNull().defaultNow(),
  lastStatusCode: integer('last_status_code'),
  lastError: text('last_error'),
  deliveredAt: ts('delivered_at'),
  createdAt: ts('created_at').notNull().defaultNow(),
});

export const inboxEvent = liame.table('inbox_event', {
  id: uuid('id').primaryKey(),
  provider: text('provider').notNull(),
  externalEventId: text('external_event_id').notNull(),
  tenantId: uuid('tenant_id'),
  type: text('type'),
  headers: jsonb('headers').notNull().default({}),
  body: text('body').notNull(),
  receivedAt: ts('received_at').notNull().defaultNow(),
  processedAt: ts('processed_at'),
  attempts: integer('attempts').notNull().default(0),
  lastError: text('last_error'),
});

export const idempotencyKey = liame.table('idempotency_key', {
  userId: uuid('user_id').notNull(),
  tenantId: uuid('tenant_id'),
  key: text('key').notNull(),
  method: text('method').notNull(),
  path: text('path').notNull(),
  requestHash: text('request_hash').notNull(),
  responseStatus: integer('response_status').notNull(),
  responseBody: jsonb('response_body'),
  createdAt: ts('created_at').notNull().defaultNow(),
  expiresAt: ts('expires_at').notNull(),
});
