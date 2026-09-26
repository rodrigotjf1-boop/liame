import * as actions from './actions.js';
import * as audit from './audit.js';
import * as control from './control.js';
import * as events from './events.js';
import * as identity from './identity.js';
import * as vault from './vault.js';

export * from './actions.js';
export * from './audit.js';
export * from './control.js';
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
  audit.auditChain,
  audit.auditEvent,
  audit.auditAnchor,
  control.featureFlag,
  control.featureFlagRule,
  control.killSwitch,
  control.policy,
  control.purgeCertificate,
  actions.sandboxResource,
  actions.actionRequest,
  actions.approval,
  actions.budgetPolicy,
  actions.budgetLedgerEntry,
  actions.actionExecution,
  actions.workflowRun,
  actions.workflowStep,
  vault.secret,
  vault.tenantKey,
];
