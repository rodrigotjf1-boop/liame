import { type Database, withSystem } from '@liame/database';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { MotivoDaMensagem } from '../ai/crm/mensagem.js';
import { DATABASE } from '../database/database.module.js';
import { proximaOlhada, type ResultadoDoOlhar } from '../mensageria/rotina-do-crm.js';
import { type JobScope, tenantFilter } from './outbox-publisher.js';
import { type Olhada, RotinaDoCrmService } from './rotina-do-crm.service.js';

/** A linha reservada volta para a fila depois disto se o worker cair no meio da olhada. */
const RESERVA = '15 minutes';

export type VezDoOlhar = { id: string; tenantId: string; brandId: string; motivo: MotivoDaMensagem; resultado: ResultadoDoOlhar; proposta?: string };

type Reservada = { id: string; tenant_id: string; brand_id: string; motive: MotivoDaMensagem };

/**
 * A fila do olhar da rotina do CRM e mensageria (A5, Y6; migration 0064). Cada marca com o RegemCast conectado tem
 * uma linha por tipo de mensagem; o laço reserva as devidas (SKIP LOCKED na mesma linha que a reserva altera, V35),
 * pede ao serviço que olhe cada uma e grava o que ele decidiu e quando olha de novo. A olhada sempre deixa registro:
 * a marca que não tem o que propor sai da frente da fila até a próxima vez, e não tira a vez das outras (V106).
 */
@Injectable()
export class RotinaDoCrmLoop {
  private readonly logger = new Logger('rotina-do-crm');

  constructor(
    @Inject(DATABASE) private readonly database: Database | null,
    private readonly rotina: RotinaDoCrmService,
  ) {}

  async olharLote(limite = 5, scope: JobScope = {}, agora?: Date): Promise<VezDoOlhar[]> {
    if (!this.database) return [];
    const db = this.database.db;
    const quando = agora ?? new Date();
    const ref = sql`${quando.toISOString()}::timestamptz`;
    const reservadas = await withSystem(db, async (tx) => {
      // As marcas com o RegemCast conectado ganham as duas linhas, uma vez só: é por elas que a fila anda.
      await tx.execute(sql`
        insert into liame.message_routine (id, tenant_id, brand_id, motive, next_check_at)
        select gen_random_uuid(), c.tenant_id, c.brand_id, m.motive, ${ref}
          from (select distinct a.tenant_id, a.brand_id
                  from liame.connected_account a
                 where a.provider = 'regemcast' and a.disconnected_at is null and a.brand_id is not null
                   ${tenantFilter(scope, sql`a.tenant_id`)}) c
         cross join (values ('promocao'), ('volte_a_pedir')) as m (motive)
        on conflict (brand_id, motive) do nothing`);
      return (
        await tx.execute<Reservada>(sql`
          with devidas as materialized (
            select r.id
              from liame.message_routine r
             where r.next_check_at <= ${ref}
               ${tenantFilter(scope, sql`r.tenant_id`)}
             order by r.next_check_at, r.id
             limit ${limite}
             for update of r skip locked
          )
          update liame.message_routine r
             set next_check_at = ${ref} + ${RESERVA}::interval, updated_at = now()
            from devidas x
           where r.id = x.id
          returning r.id, r.tenant_id, r.brand_id, r.motive`)
      ).rows;
    });

    const vezes: VezDoOlhar[] = [];
    for (const l of reservadas) {
      let olhada: Olhada;
      try {
        olhada = await this.rotina.olhar({ tenantId: l.tenant_id, brandId: l.brand_id, motivo: l.motive }, quando);
      } catch (err) {
        // Falha fora do previsto: a causa fica no log e a olhada fica marcada, para ele tentar de novo em 1 hora.
        this.logger.error(`marca ${l.brand_id} (${l.motive}): ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
        olhada = { resultado: 'erro' };
      }
      try {
        const volta = proximaOlhada(olhada.resultado, quando, olhada.ate);
        await withSystem(db, (tx) =>
          tx.execute(sql`
            update liame.message_routine
               set checked_at = ${ref}, outcome = ${olhada.resultado}, next_check_at = ${volta.toISOString()}::timestamptz, updated_at = now()
             where id = ${l.id} and tenant_id = ${l.tenant_id}`),
        );
      } catch (err) {
        // Se nem isso gravar, a reserva vence e a linha volta sozinha (LIC-001).
        this.logger.error(`marca ${l.brand_id} (${l.motive}): não foi possível registrar a olhada: ${err instanceof Error ? err.message : String(err)}`);
      }
      vezes.push({ id: l.id, tenantId: l.tenant_id, brandId: l.brand_id, motivo: l.motive, resultado: olhada.resultado, ...(olhada.proposta ? { proposta: olhada.proposta } : {}) });
    }
    return vezes;
  }
}
