import type { EventType } from '@liame/contracts';
import { type Tx, uuidv7 } from '@liame/database';
import { sql } from 'drizzle-orm';

// Outbox (ADR-004): o evento é gravado na MESMA transação da mutação. Se a transação desfizer, o
// evento some junto; se gravar, o publicador do worker entrega pelo menos uma vez.

export interface DomainEvent {
  tenantId: string;
  type: EventType;
  /** O recurso do evento (CloudEvents `subject`), ex.: o id da marca. */
  subject?: string;
  /** Sem dado pessoal além do necessário: ids, níveis e valores (webhook sai para fora). */
  data: Record<string, unknown>;
}

export async function emitEvent(tx: Tx, event: DomainEvent): Promise<string> {
  const id = uuidv7();
  await tx.execute(sql`
    insert into liame.outbox_event (id, tenant_id, type, subject, data)
    values (${id}, ${event.tenantId}, ${event.type}, ${event.subject ?? null}, ${JSON.stringify(event.data)}::jsonb)`);
  return id;
}

/** Envelope CloudEvents 1.0 do evento, como sai nos webhooks. */
export function cloudEvent(row: {
  id: string;
  tenant_id: string | null;
  type: string;
  subject: string | null;
  data: unknown;
  occurred_at: Date | string;
}): Record<string, unknown> {
  return {
    specversion: '1.0',
    id: row.id,
    source: 'urn:liame',
    type: row.type,
    ...(row.subject ? { subject: row.subject } : {}),
    time: new Date(row.occurred_at).toISOString(),
    datacontenttype: 'application/json',
    tenantid: row.tenant_id,
    data: row.data,
  };
}
