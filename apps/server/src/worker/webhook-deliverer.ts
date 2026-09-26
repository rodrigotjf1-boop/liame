import { type Database, withSystem } from '@liame/database';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { APP_CONFIG, type AppConfig } from '../config.js';
import { DATABASE } from '../database/database.module.js';
import { cloudEvent } from '../events/outbox.js';
import { safePost } from '../events/safe-http.js';
import { webhookHeaders } from '../events/standard-webhooks.js';
import { VaultService } from '../vault/vault.service.js';
import { type JobScope, tenantFilter } from './outbox-publisher.js';

/** Espera depois de cada falha: cerca de 3 dias no total (ADR-004). Depois, fila de mortos. */
export const RETRY_DELAYS_SECONDS = [5, 300, 1_800, 7_200, 18_000, 36_000, 50_400, 72_000, 86_400];
export const MAX_ATTEMPTS = RETRY_DELAYS_SECONDS.length + 1;
/** Enquanto a tentativa está no ar, a entrega fica reservada para este worker. */
const LEASE_SECONDS = 120;

type Claim = {
  id: string;
  attempts: number;
  url: string;
  secret_id: string;
  event_id: string;
  tenant_id: string | null;
  type: string;
  subject: string | null;
  data: unknown;
  occurred_at: Date | string;
};

/**
 * Entregador dos webhooks de saída. Reserva um lote (SKIP LOCKED + prazo de reserva), fecha a
 * transação e só então faz as chamadas HTTP: transação curta, nada de rede com o banco travado.
 */
@Injectable()
export class WebhookDeliverer {
  private readonly logger = new Logger('webhooks');

  constructor(
    @Inject(DATABASE) private readonly database: Database | null,
    private readonly vault: VaultService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async deliverBatch(limit = 20, scope: JobScope = {}): Promise<number> {
    const database = this.database;
    if (!database) return 0;
    const claimed = await withSystem(database.db, async (tx) => {
      const r = await tx.execute<Claim>(sql`
        select d.id, d.attempts, e.url, e.secret_id, ev.id as event_id, ev.tenant_id, ev.type, ev.subject, ev.data, ev.occurred_at
          from liame.webhook_delivery d
          join liame.webhook_endpoint e on e.id = d.endpoint_id
          join liame.outbox_event ev on ev.id = d.event_id
         where d.status = 'pendente' and d.next_attempt_at <= now() and e.disabled_at is null
               ${tenantFilter(scope, sql`d.tenant_id`)}
         order by d.next_attempt_at limit ${limit}
         for update of d skip locked`);
      if (!r.rows.length) return [];
      await tx.execute(sql`
        update liame.webhook_delivery set next_attempt_at = now() + make_interval(secs => ${LEASE_SECONDS})
         where id in ${r.rows.map((c) => c.id)}`);
      // O segredo é decifrado aqui e vive só na memória desta rodada.
      const out: Array<Claim & { secret: string | null }> = [];
      for (const c of r.rows) out.push({ ...c, secret: await this.vault.readSecret(tx, c.secret_id) });
      return out;
    });
    await Promise.all(claimed.map((c) => this.deliverOne(database, c)));
    return claimed.length;
  }

  private async deliverOne(database: Database, c: Claim & { secret: string | null }): Promise<void> {
    let status: number | null = null;
    let error: string | null = null;
    if (!c.secret) {
      error = 'segredo de assinatura indisponível';
    } else {
      const body = JSON.stringify(cloudEvent({ ...c, id: c.event_id }));
      // webhook-id = id do evento: o mesmo em todas as tentativas, para quem recebe deduplicar.
      const headers = { ...webhookHeaders(c.secret, c.event_id, body) };
      try {
        status = (await safePost(c.url, body, headers, { allowPrivateNetwork: this.config.webhookAllowPrivateNetwork })).status;
        if (status < 200 || status >= 300) error = `HTTP ${status}`;
      } catch (err) {
        error = err instanceof Error ? err.message : String(err);
      }
    }
    const attempts = c.attempts + 1;
    await withSystem(database.db, async (tx) => {
      if (!error) {
        await tx.execute(sql`
          update liame.webhook_delivery
             set status = 'entregue', attempts = ${attempts}, last_status_code = ${status}, last_error = null, delivered_at = now()
           where id = ${c.id}`);
        return;
      }
      if (attempts >= MAX_ATTEMPTS) {
        await tx.execute(sql`
          update liame.webhook_delivery set status = 'morta', attempts = ${attempts}, last_status_code = ${status},
                 last_error = ${error.slice(0, 500)}
           where id = ${c.id}`);
        this.logger.warn(`entrega ${c.id} foi para a fila de mortos depois de ${attempts} tentativas: ${error}`);
        return;
      }
      const delay = RETRY_DELAYS_SECONDS[attempts - 1]!;
      await tx.execute(sql`
        update liame.webhook_delivery set attempts = ${attempts}, last_status_code = ${status}, last_error = ${error.slice(0, 500)},
               next_attempt_at = now() + make_interval(secs => ${delay})
         where id = ${c.id}`);
    });
  }
}
