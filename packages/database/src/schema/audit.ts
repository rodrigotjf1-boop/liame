import { bigint, date, integer, jsonb, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { liame } from './identity.js';

// Espelho das tabelas da migration 0008 (auditoria e âncora, ADR-011).
const ts = (name: string) => timestamp(name, { withTimezone: true });

export const auditChain = liame.table('audit_chain', {
  chainKey: uuid('chain_key').primaryKey(),
  lastSeq: bigint('last_seq', { mode: 'number' }).notNull().default(0),
  lastHash: text('last_hash').notNull(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

export const auditEvent = liame.table('audit_event', {
  id: uuid('id').primaryKey(),
  chainKey: uuid('chain_key').notNull(),
  chainSeq: bigint('chain_seq', { mode: 'number' }).notNull(),
  tenantId: uuid('tenant_id'),
  actorType: text('actor_type').notNull(),
  actorId: uuid('actor_id'),
  actorLabel: text('actor_label'),
  actorRole: text('actor_role'),
  action: text('action').notNull(),
  resourceType: text('resource_type'),
  resourceId: text('resource_id'),
  before: jsonb('before'),
  after: jsonb('after'),
  reason: text('reason'),
  approvalId: uuid('approval_id'),
  traceId: text('trace_id'),
  origin: text('origin').notNull(),
  tool: text('tool'),
  agent: text('agent'),
  model: text('model'),
  occurredAt: ts('occurred_at').notNull(),
  prevHash: text('prev_hash').notNull(),
  hash: text('hash').notNull(),
});

export const auditAnchor = liame.table('audit_anchor', {
  day: date('day').primaryKey(),
  rootHash: text('root_hash').notNull(),
  prevRootHash: text('prev_root_hash').notNull(),
  chains: integer('chains').notNull(),
  events: bigint('events', { mode: 'number' }).notNull(),
  createdAt: ts('created_at').notNull().defaultNow(),
  rekorLogIndex: bigint('rekor_log_index', { mode: 'number' }),
  rekorEntry: text('rekor_entry'),
  tsaResponse: text('tsa_response'),
  s3VersionId: text('s3_version_id'),
  publishedAt: ts('published_at'),
});
