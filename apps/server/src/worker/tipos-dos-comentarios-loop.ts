import { type Database, withSystem } from '@liame/database';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { DATABASE } from '../database/database.module.js';
import { naOrdemDaFila, vezNaFila } from './ordem-da-fila.js';
import { type JobScope, tenantFilter } from './outbox-publisher.js';
import { TiposDosComentariosService, type VezDoTipo } from './tipos-dos-comentarios.service.js';

/** A vez reservada volta para a fila depois disto se o worker cair no meio (o modelo responde em segundos). */
const RESERVA = '15 minutes';

export type VezDoTipoNaFila = { id: string; tenantId: string; feito: VezDoTipo };

/** A vez reservada, com a posição dela na fila: o lote é tratado nessa ordem (ERR-135). */
type Reservada = { id: string; tenant_id: string; vez: string };

/** A posição na fila, como texto que se ordena: a mais atrasada primeiro, a mesma ordem do `order by` da reserva (V127). */
const vezDoTipo = vezNaFila(sql`coalesce(k.next_attempt_at, k.created_at)`);

/**
 * A fila do tipo do comentário pela IA (A6, Z11, parte 2d-4c; migration 0128): os comentários sem tipo que esperam e cuja
 * vez chegou, de qualquer empresa, o mais atrasado primeiro. Quem abre a vez é a leitura dos comentários, com os pedidos
 * do Social media ligados para a marca. Reserva com SKIP LOCKED na mesma linha que a reserva altera (V35), empurrando
 * `next_attempt_at` (se o worker cair no meio, a vez volta sozinha), e pede ao serviço que trate cada uma, na ordem da
 * fila (V127). Toda vez deixa rastro na linha: o tipo, o fim dela, a tentativa contada ou a espera (V106).
 */
@Injectable()
export class TiposDosComentariosLoop {
  private readonly logger = new Logger('tipos-dos-comentarios');

  constructor(
    @Inject(DATABASE) private readonly database: Database | null,
    private readonly tipos: TiposDosComentariosService,
  ) {}

  async executarLote(limite = 5, scope: JobScope = {}, agora?: Date): Promise<VezDoTipoNaFila[]> {
    if (!this.database) return [];
    const quando = agora ?? new Date();
    const ref = sql`${quando.toISOString()}::timestamptz`;
    const reservadas = await withSystem(this.database.db, async (tx) =>
      (
        await tx.execute<Reservada>(sql`
          with devidas as materialized (
            select k.id, ${vezDoTipo} as vez
              from liame.comment_kind_check k
             where k.status = 'esperando'
               and (k.next_attempt_at is null or k.next_attempt_at <= ${ref})
               ${tenantFilter(scope, sql`k.tenant_id`)}
             order by coalesce(k.next_attempt_at, k.created_at), k.id
             limit ${limite}
             for update of k skip locked
          )
          update liame.comment_kind_check k
             set next_attempt_at = ${ref} + ${RESERVA}::interval, updated_at = ${ref}
            from devidas x
           where k.id = x.id
          returning k.id, k.tenant_id, x.vez`)
      ).rows,
    );

    const vezes: VezDoTipoNaFila[] = [];
    for (const l of naOrdemDaFila(reservadas)) {
      const alvo = { tenantId: l.tenant_id, id: l.id };
      let feito: VezDoTipo;
      try {
        feito = await this.tipos.decidir(alvo, quando);
      } catch (err) {
        // Falha fora do previsto: conta como tentativa; se nem isso gravar, a reserva vence e a vez volta (LIC-001).
        this.logger.error(`tipo ${l.id}: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
        try {
          feito = await this.tipos.falhou(alvo, 'erro', quando);
        } catch (err2) {
          this.logger.error(`tipo ${l.id}: não foi possível registrar a falha: ${err2 instanceof Error ? err2.message : String(err2)}`);
          feito = { status: 'falhou', motivo: 'erro', deVez: false };
        }
      }
      vezes.push({ id: l.id, tenantId: l.tenant_id, feito });
    }
    return vezes;
  }
}
