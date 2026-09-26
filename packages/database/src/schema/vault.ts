import { integer, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { liame } from './identity.js';

// Espelho das tabelas da migration 0003 (cofre).
export const secret = liame.table('secret', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id'),
  ownerUserId: uuid('owner_user_id'),
  purpose: text('purpose').notNull(),
  keyVersion: integer('key_version').notNull(),
  wrappedDek: text('wrapped_dek').notNull(),
  iv: text('iv').notNull(),
  ciphertext: text('ciphertext').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  rotatedAt: timestamp('rotated_at', { withTimezone: true }),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
});

export const tenantKey = liame.table('tenant_key', {
  tenantId: uuid('tenant_id').primaryKey(),
  keyRef: text('key_ref').notNull(),
  wrappedDek: text('wrapped_dek').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  destroyedAt: timestamp('destroyed_at', { withTimezone: true }),
});
