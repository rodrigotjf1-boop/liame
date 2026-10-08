import { type Database, withSystem } from '@liame/database';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { APP_CONFIG, type AppConfig } from '../config.js';
import { ConversoesGoogle, type ResultadoConversoes } from '../conversoes/conversoes-google.js';
import { DATABASE } from '../database/database.module.js';
import { FlagService } from '../flags/flag.service.js';
import { KillSwitchService } from '../kill-switch/kill-switch.service.js';
import { VaultService } from '../vault/vault.service.js';
import { type JobScope, tenantFilter } from './outbox-publisher.js';

/** Reserva da conta: se o worker cair no meio, ela volta para a fila depois disto. */
const RESERVA = '30 minutes';

/**
 * Conversões para o Google (A5, Y1): reserva as contas do Google Ads com destino escolhido e devidas, a mais atrasada
 * primeiro, de qualquer empresa, com SKIP LOCKED na mesma linha que a reserva altera (V35), e faz uma passagem por
 * cada uma (`ConversoesGoogle`). Fica no worker porque reserva em escopo de sistema; a passagem roda na empresa. A
 * flag da empresa, a parada e a autorização do Google são conferidas na passagem, com a conta já reservada: a conta
 * que não pode enviar agora só volta para a fila mais tarde.
 */
@Injectable()
export class ConversoesLoop {
  private readonly logger = new Logger('conversoes-google');

  constructor(
    @Inject(DATABASE) private readonly database: Database | null,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly vault: VaultService,
    private readonly flags: FlagService,
    private readonly switches: KillSwitchService,
  ) {}

  async executarLote(limite = 2, scope: JobScope = {}, agora?: Date): Promise<ResultadoConversoes[]> {
    if (!this.database) return [];
    const db = this.database.db;
    const referencia = agora ? sql`${agora.toISOString()}::timestamptz` : sql`now()`;
    const reservadas = await withSystem(db, async (tx) => {
      const r = await tx.execute<{ id: string; tenant_id: string }>(sql`
        with devidas as materialized (
          select d.connected_account_id
            from liame.conversion_destination d
            join liame.connected_account a on a.id = d.connected_account_id
           where d.stopped_at is null and d.next_run_at <= ${referencia}
             and a.provider = 'google_ads' and a.disconnected_at is null
             ${tenantFilter(scope, sql`d.tenant_id`)}
           order by d.next_run_at
           limit ${limite}
           for update of d skip locked
        )
        update liame.conversion_destination d
           set next_run_at = ${referencia} + ${RESERVA}::interval, updated_at = now()
          from devidas v
         where d.connected_account_id = v.connected_account_id
        returning d.connected_account_id as id, d.tenant_id`);
      return r.rows;
    });
    const passagem = new ConversoesGoogle(db, this.vault, this.config, this.flags, this.switches);
    const resultados: ResultadoConversoes[] = [];
    for (const c of reservadas) {
      try {
        resultados.push(await passagem.executar(c.id, c.tenant_id, agora));
      } catch (err) {
        // Falha fora do previsto (banco): a reserva vence e a conta volta para a fila (LIC-001).
        this.logger.error(`conta ${c.id}: ${err instanceof Error ? err.message : String(err)}`);
        resultados.push({ status: 'falhou', novos: 0, desistiu: 0, enviados: 0, aceitos: 0, recusados: 0, corrigidos: 0, erro: 'erro interno' });
      }
    }
    return resultados;
  }
}
