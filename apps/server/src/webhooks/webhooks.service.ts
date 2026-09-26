import type {
  CreatedWebhookEndpointResponse,
  CreateWebhookEndpointRequest,
  EventType,
  WebhookDeliveryResponse,
  WebhookEndpointResponse,
} from '@liame/contracts';
import { uuidv7 } from '@liame/database';
import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { APP_CONFIG, type AppConfig } from '../config.js';
import { type AuthContext, currentTx } from '../context/request-context.js';
import { AppProblem, ValidationProblem } from '../errors/problems.js';
import { emitEvent } from '../events/outbox.js';
import { assertSafeUrl, UnsafeUrlError } from '../events/safe-http.js';
import { newWebhookSecret } from '../events/standard-webhooks.js';
import { VaultService } from '../vault/vault.service.js';

type EndpointRow = {
  id: string;
  url: string;
  description: string | null;
  event_types: EventType[];
  created_at: Date | string;
  disabled_at: Date | string | null;
};

type DeliveryRow = {
  id: string;
  endpoint_id: string;
  event_id: string;
  event_type: EventType;
  status: 'pendente' | 'entregue' | 'morta';
  attempts: number;
  next_attempt_at: Date | string;
  last_status_code: number | null;
  last_error: string | null;
  delivered_at: Date | string | null;
  created_at: Date | string;
};

const MAX_ENDPOINTS = 10;
const notFound = () => new AppProblem(404, 'nao-encontrado', 'Não encontramos', 'Endpoint ou entrega não encontrado nesta empresa.');
const iso = (v: Date | string) => new Date(v).toISOString();
const isoOrNull = (v: Date | string | null) => (v === null ? null : iso(v));

/** Webhooks de saída da empresa ativa (ADR-004). Roda na transação da requisição. */
@Injectable()
export class WebhooksService {
  constructor(
    private readonly vault: VaultService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async list(auth: AuthContext): Promise<WebhookEndpointResponse[]> {
    const r = await currentTx().execute<EndpointRow>(sql`
      select id, url, description, event_types, created_at, disabled_at from liame.webhook_endpoint
       where tenant_id = ${tenantOf(auth)} order by created_at desc`);
    return r.rows.map(toEndpoint);
  }

  async create(auth: AuthContext, input: CreateWebhookEndpointRequest): Promise<CreatedWebhookEndpointResponse> {
    const tx = currentTx();
    const tenantId = tenantOf(auth);
    try {
      assertSafeUrl(input.url, this.config.webhookAllowPrivateNetwork);
    } catch (err) {
      if (err instanceof UnsafeUrlError) throw new ValidationProblem([{ path: 'url', message: `URL recusada: ${err.message}.` }]);
      throw err;
    }
    const count = await tx.execute<{ n: number }>(sql`
      select count(*)::int as n from liame.webhook_endpoint where tenant_id = ${tenantId} and disabled_at is null`);
    if ((count.rows[0]?.n ?? 0) >= MAX_ENDPOINTS) {
      throw new AppProblem(409, 'limite-de-endpoints', 'Limite de endpoints', `Cada empresa pode ter até ${MAX_ENDPOINTS} endpoints ativos.`);
    }
    const secret = newWebhookSecret();
    const secretId = await this.vault.putSecret(tx, { tenantId, purpose: 'webhook_saida', plaintext: secret });
    const id = uuidv7();
    const types = [...new Set(input.event_types)];
    const r = await tx.execute<EndpointRow>(sql`
      insert into liame.webhook_endpoint (id, tenant_id, url, description, event_types, secret_id, created_by)
      values (${id}, ${tenantId}, ${input.url}, ${input.description ?? null},
              ${`{${types.join(',')}}`}::text[], ${secretId}, ${auth.userId})
      returning id, url, description, event_types, created_at, disabled_at`);
    return { ...toEndpoint(r.rows[0]!), secret };
  }

  async disable(auth: AuthContext, id: string): Promise<void> {
    const tx = currentTx();
    const r = await tx.execute<{ secret_id: string }>(sql`
      update liame.webhook_endpoint set disabled_at = now()
       where id = ${id} and tenant_id = ${tenantOf(auth)} and disabled_at is null
       returning secret_id`);
    const row = r.rows[0];
    if (!row) throw notFound();
    await this.vault.revokeSecret(tx, row.secret_id);
  }

  /** Evento de teste só para este endpoint: confirma URL e assinatura do lado de quem recebe. */
  async sendTest(auth: AuthContext, id: string): Promise<void> {
    const tx = currentTx();
    const tenantId = tenantOf(auth);
    const r = await tx.execute(sql`
      select 1 from liame.webhook_endpoint where id = ${id} and tenant_id = ${tenantId} and disabled_at is null`);
    if (!r.rows[0]) throw notFound();
    await emitEvent(tx, { tenantId, type: 'liame.webhook.test', subject: id, data: { endpoint_id: id, message: 'Teste do Liame' } });
  }

  async deliveries(auth: AuthContext, status?: 'pendente' | 'entregue' | 'morta'): Promise<WebhookDeliveryResponse[]> {
    const r = await currentTx().execute<DeliveryRow>(sql`
      select d.id, d.endpoint_id, d.event_id, e.type as event_type, d.status, d.attempts, d.next_attempt_at,
             d.last_status_code, d.last_error, d.delivered_at, d.created_at
        from liame.webhook_delivery d join liame.outbox_event e on e.id = d.event_id
       where d.tenant_id = ${tenantOf(auth)} ${status ? sql`and d.status = ${status}` : sql``}
       order by d.created_at desc limit 100`);
    return r.rows.map(toDelivery);
  }

  /** Reenvio manual: a entrega volta para a fila agora, com as tentativas zeradas. */
  async retry(auth: AuthContext, id: string): Promise<void> {
    const r = await currentTx().execute(sql`
      update liame.webhook_delivery set status = 'pendente', attempts = 0, next_attempt_at = now(), last_error = null
       where id = ${id} and tenant_id = ${tenantOf(auth)} and status <> 'entregue'
         and exists (select 1 from liame.webhook_endpoint e where e.id = endpoint_id and e.disabled_at is null)`);
    if (r.rowCount !== 1) throw notFound();
  }
}

function tenantOf(auth: AuthContext): string {
  if (!auth.tenantId) throw new AppProblem(403, 'sem-empresa-ativa', 'Escolha uma empresa', 'Selecione uma empresa com acesso ativo.');
  return auth.tenantId;
}

function toEndpoint(r: EndpointRow): WebhookEndpointResponse {
  return {
    id: r.id,
    url: r.url,
    description: r.description,
    event_types: r.event_types,
    created_at: iso(r.created_at),
    disabled_at: isoOrNull(r.disabled_at),
  };
}

function toDelivery(r: DeliveryRow): WebhookDeliveryResponse {
  return {
    id: r.id,
    endpoint_id: r.endpoint_id,
    event_id: r.event_id,
    event_type: r.event_type,
    status: r.status,
    attempts: r.attempts,
    next_attempt_at: r.status === 'pendente' ? iso(r.next_attempt_at) : null,
    last_status_code: r.last_status_code,
    last_error: r.last_error,
    delivered_at: isoOrNull(r.delivered_at),
    created_at: iso(r.created_at),
  };
}
