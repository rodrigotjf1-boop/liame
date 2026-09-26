import { type Database, type Tx, withSystem } from '@liame/database';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { DATABASE } from '../database/database.module.js';

export type InboxRow = {
  id: string;
  provider: string;
  external_event_id: string;
  tenant_id: string | null;
  type: string | null;
  body: string;
  attempts: number;
};

/** Processador de um provedor. Roda numa transação própria (savepoint): falha não derruba o lote. */
export type InboxHandler = (tx: Tx, event: InboxRow) => Promise<void>;

export const INBOX_HANDLERS = Symbol('INBOX_HANDLERS');
const MAX_ATTEMPTS = 10;

/**
 * Processa, depois do ACK, o que a inbox guardou (ADR-004). Só pega provedores com processador
 * registrado: evento de provedor sem processador fica guardado até existir um (ou até o expurgo).
 */
@Injectable()
export class InboxProcessor {
  private readonly logger = new Logger('inbox');

  constructor(
    @Inject(DATABASE) private readonly database: Database | null,
    @Inject(INBOX_HANDLERS) private readonly handlers: ReadonlyMap<string, InboxHandler>,
  ) {}

  async processBatch(limit = 50, scope: { ids?: string[] } = {}): Promise<number> {
    const providers = [...this.handlers.keys()];
    if (!this.database || !providers.length) return 0;
    if (scope.ids && !scope.ids.length) return 0;
    return withSystem(this.database.db, async (tx) => {
      const r = await tx.execute<InboxRow>(sql`
        select id, provider, external_event_id, tenant_id, type, body, attempts from liame.inbox_event
         where processed_at is null and attempts < ${MAX_ATTEMPTS} and provider in ${providers}
               ${scope.ids ? sql`and id in ${scope.ids}` : sql``}
         order by received_at limit ${limit}
         for update skip locked`);
      for (const row of r.rows) {
        try {
          await tx.transaction((sp) => this.handlers.get(row.provider)!(sp, row));
          await tx.execute(sql`update liame.inbox_event set processed_at = now(), attempts = attempts + 1, last_error = null where id = ${row.id}`);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          this.logger.error(`evento ${row.provider}/${row.external_event_id} falhou: ${message}`);
          await tx.execute(sql`update liame.inbox_event set attempts = attempts + 1, last_error = ${message.slice(0, 500)} where id = ${row.id}`);
        }
      }
      return r.rows.length;
    });
  }
}
