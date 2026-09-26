import { bigint, boolean, inet, integer, pgSchema, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core';

// Espelho TypeScript das tabelas da migration 0002 (o SQL é a fonte; um teste compara os dois).
export const liame = pgSchema('liame');

const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();
const updatedAt = () => timestamp('updated_at', { withTimezone: true }).notNull().defaultNow();

export const organization = liame.table('organization', {
  id: uuid('id').primaryKey(),
  name: text('name').notNull(),
  cnpj: text('cnpj'),
  timezone: text('timezone').notNull().default('America/Sao_Paulo'),
  status: text('status').notNull().default('ativa'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const appUser = liame.table('app_user', {
  id: uuid('id').primaryKey(),
  email: text('email').notNull(),
  name: text('name').notNull(),
  passwordHash: text('password_hash').notNull(),
  emailVerifiedAt: timestamp('email_verified_at', { withTimezone: true }),
  disabledAt: timestamp('disabled_at', { withTimezone: true }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const membership = liame.table('membership', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  userId: uuid('user_id').notNull(),
  roleKey: text('role_key').notNull(),
  approveLimitMicros: bigint('approve_limit_micros', { mode: 'number' }),
  dualApproval: boolean('dual_approval').notNull().default(true),
  billingAccess: boolean('billing_access').notNull().default(false),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  invitedBy: uuid('invited_by'),
  createdAt: createdAt(),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
});

export const brand = liame.table('brand', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  name: text('name').notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const unit = liame.table('unit', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  brandId: uuid('brand_id').notNull(),
  name: text('name').notNull(),
  timezone: text('timezone').notNull().default('America/Sao_Paulo'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const session = liame.table('session', {
  id: uuid('id').primaryKey(),
  tokenHash: text('token_hash').notNull(),
  userId: uuid('user_id').notNull(),
  activeTenantId: uuid('active_tenant_id'),
  mfaVerifiedAt: timestamp('mfa_verified_at', { withTimezone: true }),
  ip: inet('ip'),
  userAgent: text('user_agent'),
  createdAt: createdAt(),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
});

export const userToken = liame.table('user_token', {
  id: uuid('id').primaryKey(),
  userId: uuid('user_id').notNull(),
  purpose: text('purpose').notNull(),
  tokenHash: text('token_hash').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  usedAt: timestamp('used_at', { withTimezone: true }),
  createdAt: createdAt(),
});

export const rateLimit = liame.table(
  'rate_limit',
  {
    key: text('key').notNull(),
    windowStart: timestamp('window_start', { withTimezone: true }).notNull(),
    hits: integer('hits').notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.key, t.windowStart] })],
);
