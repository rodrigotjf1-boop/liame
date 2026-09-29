import { sql } from 'drizzle-orm';
import { bigint, boolean, numeric, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { liame } from './identity.js';

// Espelho das tabelas da migration 0021 (modelo de vendas, A2.5 F1; data-model §4; ADR-019).
const ts = (name: string) => timestamp(name, { withTimezone: true });
const micros = (name: string) => bigint(name, { mode: 'number' });

export const customerRef = liame.table('customer_ref', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  phoneIndex: text('phone_index'),
  firstSeenAt: ts('first_seen_at').notNull().defaultNow(),
  lastSeenAt: ts('last_seen_at').notNull().defaultNow(),
});

export const customerRefLink = liame.table(
  'customer_ref_link',
  {
    connectedAccountId: uuid('connected_account_id').notNull(),
    externalId: text('external_id').notNull(),
    tenantId: uuid('tenant_id').notNull(),
    customerRefId: uuid('customer_ref_id').notNull(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.connectedAccountId, t.externalId] })],
);

export const orderFact = liame.table('order_fact', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  brandId: uuid('brand_id').notNull(),
  unitId: uuid('unit_id'),
  connectedAccountId: uuid('connected_account_id').notNull(),
  provider: text('provider').notNull(),
  externalId: text('external_id').notNull(),
  channel: text('channel').notNull(),
  channelGroup: text('channel_group').notNull(),
  status: text('status').notNull(),
  currency: text('currency').notNull(),
  timezone: text('timezone').notNull(),
  revenueMicros: micros('revenue_micros').notNull(),
  discountMicros: micros('discount_micros').notNull().default(0),
  refundedMicros: micros('refunded_micros').notNull().default(0),
  couponCode: text('coupon_code'),
  customerRefId: uuid('customer_ref_id'),
  isNewCustomer: boolean('is_new_customer'),
  placedAt: ts('placed_at'),
  confirmedAt: ts('confirmed_at').notNull(),
  cancelledAt: ts('cancelled_at'),
  sourceVersion: bigint('source_version', { mode: 'number' }).notNull(),
  sourceUpdatedAt: ts('source_updated_at').notNull(),
  rawRef: uuid('raw_ref'),
  firstSeenAt: ts('first_seen_at').notNull().defaultNow(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

export const orderItemFact = liame.table('order_item_fact', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  orderId: uuid('order_id').notNull(),
  externalId: text('external_id').notNull(),
  productExternalId: text('product_external_id'),
  name: text('name').notNull(),
  quantity: numeric('quantity', { precision: 14, scale: 3 }).notNull(),
  revenueMicros: micros('revenue_micros').notNull(),
  costMicros: micros('cost_micros'),
  costKnown: boolean('cost_known').generatedAlwaysAs(sql`cost_micros is not null`),
  removedAt: ts('removed_at'),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});
