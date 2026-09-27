import { integer, jsonb, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { liame } from './identity.js';

// Espelho da tabela da migration 0019 (conectar contas por OAuth, A2 G3).
const ts = (name: string) => timestamp(name, { withTimezone: true });

export const oauthConnection = liame.table('oauth_connection', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  brandId: uuid('brand_id').notNull(),
  provider: text('provider').notNull(),
  status: text('status').notNull().default('aguardando_autorizacao'),
  requestedBy: uuid('requested_by'),
  stateHash: text('state_hash').notNull().unique(),
  redirectUri: text('redirect_uri').notNull(),
  pkceVerifierEnc: text('pkce_verifier_enc'),
  codeEnc: text('code_enc'),
  credentialSecretId: uuid('credential_secret_id'),
  scopes: text('scopes').array().notNull().default([]),
  discovered: jsonb('discovered').notNull().default([]),
  errorCode: text('error_code'),
  attempts: integer('attempts').notNull().default(0),
  refreshExpiresAt: ts('refresh_expires_at'),
  expiresAt: ts('expires_at').notNull(),
  lockedAt: ts('locked_at'),
  completedAt: ts('completed_at'),
  revokedAt: ts('revoked_at'),
  createdAt: ts('created_at').notNull().defaultNow(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});
