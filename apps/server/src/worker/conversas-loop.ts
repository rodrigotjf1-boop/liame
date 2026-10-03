import { type Database, withSystem } from '@liame/database';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { DATASET_CONVERSAS, INTERVALO_CONVERSAS_MIN, type ResultadoConversas, SincronizadorConversas } from '../attribution/sincronizador-conversas.js';
import { APP_CONFIG, type AppConfig } from '../config.js';
import { DATABASE } from '../database/database.module.js';
import { VaultService } from '../vault/vault.service.js';
import { type JobScope, tenantFilter } from './outbox-publisher.js';

/** Reserva da conta: se o worker cair no meio, ela volta para a fila depois disto. */
const RESERVA = '30 minutes';

/**
 * Leitura das conversas abertas por anúncio das contas do RegemCast (A2.5, F7). Reserva as contas devidas com
 * SKIP LOCKED na MESMA linha que a reserva altera (sync_state de `conversas_anuncio`, ERR-029), a mais
 * atrasada primeiro, de qualquer empresa; uma leitura por conta por vez. Fica no worker porque reserva em
 * escopo de sistema (V53); a leitura em si roda na empresa.
 */
@Injectable()
export class ConversasLoop {
  private readonly logger = new Logger('conversas');

  constructor(
    @Inject(DATABASE) private readonly database: Database | null,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly vault: VaultService,
  ) {}

  async executarLote(limite = 3, scope: JobScope = {}, agora?: Date): Promise<ResultadoConversas[]> {
    if (!this.database) return [];
    const db = this.database.db;
    const referencia = agora ? sql`${agora.toISOString()}::timestamptz` : sql`now()`;
    const elegivel = sql`a.provider = 'regemcast' and a.disconnected_at is null and a.status in ('ativa', 'erro') and a.credential_secret_id is not null`;
    const reservadas = await withSystem(db, async (tx) => {
      await tx.execute(sql`
        insert into liame.sync_state (connected_account_id, dataset, tenant_id, expected_every_minutes, cursor)
        select a.id, ${DATASET_CONVERSAS}, a.tenant_id, ${INTERVALO_CONVERSAS_MIN}, '{}'::jsonb
          from liame.connected_account a
         where ${elegivel} ${tenantFilter(scope, sql`a.tenant_id`)}
           and not exists (select 1 from liame.sync_state s where s.connected_account_id = a.id and s.dataset = ${DATASET_CONVERSAS})
        on conflict (connected_account_id, dataset) do nothing`);
      const r = await tx.execute<{ id: string; tenant_id: string }>(sql`
        with devidas as materialized (
          select s.connected_account_id
            from liame.sync_state s
            join liame.connected_account a on a.id = s.connected_account_id
           where s.dataset = ${DATASET_CONVERSAS} and ${elegivel}
             and coalesce((s.cursor->>'proxima')::timestamptz, '-infinity'::timestamptz) <= ${referencia}
             ${tenantFilter(scope, sql`a.tenant_id`)}
           order by coalesce((s.cursor->>'proxima')::timestamptz, '-infinity'::timestamptz)
           limit ${limite}
           for update of s skip locked
        )
        update liame.sync_state s
           set last_attempt_at = now(), cursor = s.cursor || jsonb_build_object('proxima', ${referencia} + ${RESERVA}::interval), updated_at = now()
          from devidas d
         where s.connected_account_id = d.connected_account_id and s.dataset = ${DATASET_CONVERSAS}
        returning s.connected_account_id as id, s.tenant_id`);
      return r.rows;
    });
    const sincronizador = new SincronizadorConversas(db, this.vault, this.config);
    const resultados: ResultadoConversas[] = [];
    for (const c of reservadas) {
      try {
        resultados.push(await sincronizador.sincronizar(c.id, c.tenant_id, agora));
      } catch (err) {
        // Falha fora do previsto (banco): a reserva vence e a conta volta para a fila (LIC-001).
        this.logger.error(`conta ${c.id}: ${err instanceof Error ? err.message : String(err)}`);
        resultados.push({ status: 'falhou', erro: 'erro interno' });
      }
    }
    return resultados;
  }
}
