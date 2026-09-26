import { type Database, uuidv7, withSystem } from '@liame/database';
import { Inject, Injectable } from '@nestjs/common';
import { type SQL, sql } from 'drizzle-orm';
import { DATABASE } from '../database/database.module.js';

type EventRow = { id: string; tenant_id: string | null; type: string; subject: string | null };
type EndpointRow = { id: string; tenant_id: string; event_types: string[] };

/** Escopo explícito para testes num banco compartilhado (LIC-083): só os tenants que a spec criou. */
export interface JobScope {
  tenantIds?: string[];
}

/**
 * Publicador da outbox (ADR-004): pega os eventos ainda não publicados (SKIP LOCKED, vários workers
 * em paralelo sem pegar o mesmo), cria as entregas de webhook de cada endpoint interessado e marca o
 * evento como publicado — tudo na mesma transação. Entrega pelo menos uma vez.
 */
@Injectable()
export class OutboxPublisher {
  constructor(@Inject(DATABASE) private readonly database: Database | null) {}

  async publishBatch(limit = 100, scope: JobScope = {}): Promise<number> {
    if (!this.database) return 0;
    return withSystem(this.database.db, async (tx) => {
      const events = await tx.execute<EventRow>(sql`
        select id, tenant_id, type, subject from liame.outbox_event
         where published_at is null ${tenantFilter(scope, sql`tenant_id`)}
         order by created_at limit ${limit}
         for update skip locked`);
      if (!events.rows.length) return 0;

      const tenantIds = [...new Set(events.rows.map((e) => e.tenant_id).filter((t): t is string => t !== null))];
      const endpoints = tenantIds.length
        ? (
            await tx.execute<EndpointRow>(sql`
              select id, tenant_id, event_types from liame.webhook_endpoint
               where disabled_at is null and tenant_id in ${tenantIds}`)
          ).rows
        : [];

      const deliveries: SQL[] = [];
      for (const ev of events.rows) {
        for (const ep of endpoints) {
          if (ep.tenant_id !== ev.tenant_id) continue;
          // O evento de teste vai só para o endpoint pedido; os demais seguem o filtro de tipos (vazio = todos).
          const wants = ev.type === 'liame.webhook.test' ? ep.id === ev.subject : ep.event_types.length === 0 || ep.event_types.includes(ev.type);
          if (wants) deliveries.push(sql`(${uuidv7()}, ${ev.tenant_id}, ${ep.id}, ${ev.id})`);
        }
      }
      if (deliveries.length) {
        await tx.execute(sql`
          insert into liame.webhook_delivery (id, tenant_id, endpoint_id, event_id)
          values ${sql.join(deliveries, sql`, `)}
          on conflict (endpoint_id, event_id) do nothing`);
      }
      await tx.execute(sql`update liame.outbox_event set published_at = now() where id in ${events.rows.map((e) => e.id)}`);
      return events.rows.length;
    });
  }
}

export function tenantFilter(scope: JobScope, column: SQL): SQL {
  if (!scope.tenantIds) return sql``;
  // Lista vazia no escopo = nada a fazer (e o Drizzle não aceita `in ()`, ERR-007).
  if (!scope.tenantIds.length) return sql`and false`;
  return sql`and ${column} in ${scope.tenantIds}`;
}
