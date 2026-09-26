import * as events from './events.js';
import * as identity from './identity.js';
import * as vault from './vault.js';

export * from './events.js';
export * from './identity.js';
export * from './vault.js';

/** Todas as tabelas espelhadas, para o teste que compara o schema TypeScript com o banco. */
export const allTables = [
  identity.organization,
  identity.appUser,
  identity.membership,
  identity.invitation,
  identity.role,
  identity.rolePermission,
  identity.brand,
  identity.unit,
  identity.session,
  identity.userToken,
  identity.rateLimit,
  identity.recoveryCode,
  events.outboxEvent,
  events.webhookEndpoint,
  events.webhookDelivery,
  events.inboxEvent,
  events.idempotencyKey,
  vault.secret,
  vault.tenantKey,
];
