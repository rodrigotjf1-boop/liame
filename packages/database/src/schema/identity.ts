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
  suspendedAt: timestamp('suspended_at', { withTimezone: true }),
  purgeAfter: timestamp('purge_after', { withTimezone: true }),
  purgeReason: text('purge_reason'),
  legalHoldAt: timestamp('legal_hold_at', { withTimezone: true }),
  legalHoldReason: text('legal_hold_reason'),
});

export const appUser = liame.table('app_user', {
  id: uuid('id').primaryKey(),
  email: text('email').notNull(),
  name: text('name').notNull(),
  passwordHash: text('password_hash').notNull(),
  emailVerifiedAt: timestamp('email_verified_at', { withTimezone: true }),
  disabledAt: timestamp('disabled_at', { withTimezone: true }),
  totpLastStep: bigint('totp_last_step', { mode: 'number' }),
  /** App autenticador ativo desde (migration 0015). */
  mfaEnabledAt: timestamp('mfa_enabled_at', { withTimezone: true }),
  /** Termos aceitos ao criar o login: versão e quando (migration 0016). */
  termsVersion: text('terms_version'),
  termsAcceptedAt: timestamp('terms_accepted_at', { withTimezone: true }),
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
  /** Último acesso nesta empresa (migration 0015). */
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
});

/** Papel (migration 0006, ADR-013). */
export const role = liame.table('role', {
  key: text('key').primaryKey(),
  name: text('name').notNull(),
  createdAt: createdAt(),
});

/** Permissões de um papel: padrão do Liame (tenant nulo) ou conjunto próprio da empresa. */
export const rolePermission = liame.table('role_permission', {
  tenantId: uuid('tenant_id'),
  roleKey: text('role_key').notNull(),
  permission: text('permission').notNull(),
  createdAt: createdAt(),
});

/** Convite por e-mail (migration 0005, ADR-017). */
export const invitation = liame.table('invitation', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  email: text('email').notNull(),
  roleKey: text('role_key').notNull(),
  approveLimitMicros: bigint('approve_limit_micros', { mode: 'number' }),
  dualApproval: boolean('dual_approval').notNull().default(true),
  billingAccess: boolean('billing_access').notNull().default(false),
  accessExpiresAt: timestamp('access_expires_at', { withTimezone: true }),
  tokenHash: text('token_hash').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  invitedBy: uuid('invited_by').notNull(),
  acceptedAt: timestamp('accepted_at', { withTimezone: true }),
  acceptedBy: uuid('accepted_by'),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  createdAt: createdAt(),
});

export const brand = liame.table('brand', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  name: text('name').notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
  archivedAt: timestamp('archived_at', { withTimezone: true }),
  purgeAfter: timestamp('purge_after', { withTimezone: true }),
  purgeReason: text('purge_reason'),
});

export const unit = liame.table('unit', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  brandId: uuid('brand_id').notNull(),
  name: text('name').notNull(),
  timezone: text('timezone').notNull().default('America/Sao_Paulo'),
  orderPlatform: text('order_platform'),
  orderPlatformUrl: text('order_platform_url'),
  orderPlatformSetAt: timestamp('order_platform_set_at', { withTimezone: true }),
  orderPlatformSetBy: uuid('order_platform_set_by'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const session = liame.table('session', {
  id: uuid('id').primaryKey(),
  tokenHash: text('token_hash').notNull(),
  userId: uuid('user_id').notNull(),
  activeTenantId: uuid('active_tenant_id'),
  mfaVerifiedAt: timestamp('mfa_verified_at', { withTimezone: true }),
  mfaMethod: text('mfa_method'),
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
  usableAfter: timestamp('usable_after', { withTimezone: true }),
  createdAt: createdAt(),
});

export const recoveryCode = liame.table('recovery_code', {
  id: uuid('id').primaryKey(),
  userId: uuid('user_id').notNull(),
  codeHash: text('code_hash').notNull(),
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
