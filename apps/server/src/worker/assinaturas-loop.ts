import { type Database, withSystem } from '@liame/database';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { FLAG_COBRANCA, type VezDaAssinatura, vezDaAssinatura } from '../cobranca/assinatura.js';
import { DATABASE } from '../database/database.module.js';
import { FlagService } from '../flags/flag.service.js';
import { type JobScope, tenantFilter } from './outbox-publisher.js';

/**
 * Reserva da assinatura: se o worker cair no meio, ou a vez falhar, ela volta para a fila depois disto. É também a
 * espera da empresa com a função `cobranca` desligada: a rotina olha de novo em uma hora (V132).
 */
const RESERVA = '1 hour';

export type VezDaRotina = { assinatura: string; tenantId: string; resultado: VezDaAssinatura | 'desligada' | 'falhou' };

/**
 * A rotina da cobrança (A7, W1): cada assinatura viva passa uma vez por dia, no começo do dia da empresa, e a que espera
 * o primeiro pagamento passa no fim do prazo dele. Reserva com SKIP LOCKED na mesma linha que a reserva altera
 * (`subscription.next_check_at`, V35), a mais atrasada primeiro (a ordem do lote não importa: cada assinatura é
 * independente). A vez de cada uma é `vezDaAssinatura`, numa transação própria (a assinatura e as faturas mudam juntas
 * ou não mudam). Com a função `cobranca` desligada para a empresa, nada muda: a assinatura fica parada onde estava.
 */
@Injectable()
export class AssinaturasLoop {
  private readonly logger = new Logger('assinaturas');

  constructor(
    @Inject(DATABASE) private readonly database: Database | null,
    private readonly flags: FlagService,
  ) {}

  async executarLote(limite = 20, scope: JobScope = {}, agora?: Date): Promise<VezDaRotina[]> {
    if (!this.database) return [];
    const db = this.database.db;
    const relogio = agora ?? new Date();
    const referencia = sql`${relogio.toISOString()}::timestamptz`;
    const reservadas = await withSystem(db, async (tx) => {
      const r = await tx.execute<{ id: string; tenant_id: string; brand_id: string }>(sql`
        with devidas as materialized (
          select s.id
            from liame.subscription s
           where s.status <> 'encerrada' and s.next_check_at <= ${referencia} ${tenantFilter(scope, sql`s.tenant_id`)}
           order by s.next_check_at
           limit ${limite}
           for update of s skip locked
        )
        update liame.subscription s
           set next_check_at = ${referencia} + ${RESERVA}::interval
          from devidas d
         where s.id = d.id
        returning s.id, s.tenant_id, s.brand_id`);
      return r.rows;
    });

    const vezes: VezDaRotina[] = [];
    for (const a of reservadas) {
      try {
        const ligada = await this.flags.isEnabled(FLAG_COBRANCA, this.flags.context({ tenantId: a.tenant_id, brandId: a.brand_id }));
        if (!ligada) {
          vezes.push({ assinatura: a.id, tenantId: a.tenant_id, resultado: 'desligada' });
          continue;
        }
        const resultado = await withSystem(db, (tx) => vezDaAssinatura(tx, a.id, relogio));
        vezes.push({ assinatura: a.id, tenantId: a.tenant_id, resultado });
      } catch (err) {
        this.logger.error(`assinatura ${a.id}: ${err instanceof Error ? err.message : String(err)}`);
        vezes.push({ assinatura: a.id, tenantId: a.tenant_id, resultado: 'falhou' });
      }
    }
    return vezes;
  }
}
