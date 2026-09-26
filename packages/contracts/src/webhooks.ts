import { z } from 'zod';

// Webhooks de saída (ADR-004): eventos em CloudEvents 1.0, assinados no padrão Standard Webhooks.

/** Tipos de evento publicados (CloudEvents `type`). */
export const EventType = z.enum([
  'liame.brand.created',
  'liame.invitation.created',
  'liame.member.joined',
  'liame.member.updated',
  'liame.member.removed',
  'liame.webhook.test',
]);
export type EventType = z.infer<typeof EventType>;

export const WebhookEndpointResponse = z.strictObject({
  id: z.uuid(),
  url: z.string(),
  description: z.string().nullable(),
  /** Vazio = todos os tipos. */
  event_types: z.array(EventType),
  created_at: z.string(),
  disabled_at: z.string().nullable(),
});
export type WebhookEndpointResponse = z.infer<typeof WebhookEndpointResponse>;

export const CreatedWebhookEndpointResponse = WebhookEndpointResponse.extend({
  /** Segredo de assinatura (`whsec_...`), mostrado uma única vez. */
  secret: z.string(),
});
export type CreatedWebhookEndpointResponse = z.infer<typeof CreatedWebhookEndpointResponse>;

export const WebhookEndpointListResponse = z.strictObject({ items: z.array(WebhookEndpointResponse) });
export type WebhookEndpointListResponse = z.infer<typeof WebhookEndpointListResponse>;

export const CreateWebhookEndpointRequest = z.strictObject({
  url: z.url({ protocol: /^https?$/, error: 'Use uma URL https' }).max(2000),
  description: z.string().trim().max(200).optional(),
  event_types: z.array(EventType).max(50).default([]),
});
export type CreateWebhookEndpointRequest = z.infer<typeof CreateWebhookEndpointRequest>;

export const WebhookDeliveryStatus = z.enum(['pendente', 'entregue', 'morta']);

export const WebhookDeliveryResponse = z.strictObject({
  id: z.uuid(),
  endpoint_id: z.uuid(),
  event_id: z.uuid(),
  event_type: EventType,
  status: WebhookDeliveryStatus,
  attempts: z.int(),
  next_attempt_at: z.string().nullable(),
  last_status_code: z.int().nullable(),
  last_error: z.string().nullable(),
  delivered_at: z.string().nullable(),
  created_at: z.string(),
});
export type WebhookDeliveryResponse = z.infer<typeof WebhookDeliveryResponse>;

export const WebhookDeliveryListResponse = z.strictObject({ items: z.array(WebhookDeliveryResponse) });
export type WebhookDeliveryListResponse = z.infer<typeof WebhookDeliveryListResponse>;

/** Provedor na rota da inbox (`/v1/inbox/{provider}`). */
export const InboxProvider = z.string().regex(/^[a-z0-9_-]{1,40}$/, { error: 'Provedor inválido' });

export const WebhookDeliveryQuery = z.strictObject({ status: WebhookDeliveryStatus.optional() });
export type WebhookDeliveryQuery = z.infer<typeof WebhookDeliveryQuery>;
