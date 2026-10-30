import { type Database, withSystem } from '@liame/database';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { DATABASE } from '../database/database.module.js';
import { naOrdemDaFila, vezNaFila } from './ordem-da-fila.js';
import { type JobScope, tenantFilter } from './outbox-publisher.js';
import { PostsSugeridosService, type VezDoPost } from './posts-sugeridos.service.js';

/** A vez reservada volta para a fila depois disto se o worker cair no meio (o modelo e a gravação cabem com folga). */
const RESERVA = '15 minutes';

export type VezDoDia = { id: string; tenantId: string; feito: VezDoPost };

/** A vez reservada, com a posição dela na fila: o lote é tratado nessa ordem (ERR-135). */
type Reservada = { id: string; tenant_id: string; vez: string };

/** A posição na fila dos posts, como texto que se ordena: o dia mais cedo primeiro, e a vez mais atrasada dentro dele (V127). */
const vezDoPost = sql`to_char(s.day, 'YYYY-MM-DD') || ${vezNaFila(sql`coalesce(s.next_attempt_at, s.created_at)`)}`;

/**
 * A fila dos posts do Social media (A6, Z6, os posts; migration 0093): os dias que esperam e cuja vez chegou, de qualquer
 * empresa, o dia mais cedo primeiro. Quem abre a vez é a própria rotina, de hora em hora (`abrir`), com a função ligada
 * para a marca. Reserva com SKIP LOCKED na mesma linha que a reserva altera (V35), empurrando `next_attempt_at` (se o
 * worker cair no meio, a vez volta sozinha), e pede ao serviço que trate cada uma, na ordem da fila (V127). Toda vez
 * deixa rastro na linha: o post e o pedido, o fim dela, a tentativa contada ou a espera (V106).
 */
@Injectable()
export class PostsSugeridosLoop {
  private readonly logger = new Logger('posts-sugeridos');

  constructor(
    @Inject(DATABASE) private readonly database: Database | null,
    private readonly posts: PostsSugeridosService,
  ) {}

  /** Abre a vez dos dias de amanhã e de depois de amanhã que têm item na pauta aprovada (D-A6-60). */
  async abrir(marcasPorPagina = 200, agora?: Date): Promise<number> {
    if (!this.database) return 0;
    return this.posts.abrirVezes(marcasPorPagina, agora ?? new Date());
  }

  async executarLote(limite = 3, scope: JobScope = {}, agora?: Date): Promise<VezDoDia[]> {
    if (!this.database) return [];
    const quando = agora ?? new Date();
    const ref = sql`${quando.toISOString()}::timestamptz`;
    const reservadas = await withSystem(this.database.db, async (tx) =>
      (
        await tx.execute<Reservada>(sql`
          with devidas as materialized (
            select s.id, ${vezDoPost} as vez
              from liame.post_suggestion s
             where s.status = 'esperando'
               and (s.next_attempt_at is null or s.next_attempt_at <= ${ref})
               ${tenantFilter(scope, sql`s.tenant_id`)}
             order by s.day, coalesce(s.next_attempt_at, s.created_at), s.id
             limit ${limite}
             for update of s skip locked
          )
          update liame.post_suggestion s
             set next_attempt_at = ${ref} + ${RESERVA}::interval, updated_at = ${ref}
            from devidas x
           where s.id = x.id
          returning s.id, s.tenant_id, x.vez`)
      ).rows,
    );

    const vezes: VezDoDia[] = [];
    for (const l of naOrdemDaFila(reservadas)) {
      const alvo = { tenantId: l.tenant_id, id: l.id };
      let feito: VezDoPost;
      try {
        feito = await this.posts.propor(alvo, quando);
      } catch (err) {
        // Falha fora do previsto: conta como tentativa; se nem isso gravar, a reserva vence e a vez volta (LIC-001).
        this.logger.error(`post ${l.id}: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
        try {
          feito = await this.posts.falhou(alvo, 'erro', quando);
        } catch (err2) {
          this.logger.error(`post ${l.id}: não foi possível registrar a falha: ${err2 instanceof Error ? err2.message : String(err2)}`);
          feito = { status: 'falhou', motivo: 'erro', deVez: false };
        }
      }
      vezes.push({ id: l.id, tenantId: l.tenant_id, feito });
    }
    return vezes;
  }
}
