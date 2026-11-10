import { type Database, withSystem } from '@liame/database';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { recursoDoComentario } from '../actions/comentario-na-rede.js';
import { SOCIAL } from '../ai/social/prompt.js';
import { FERRAMENTA_DA_OPERACAO } from '../comentarios/pedidos.js';
import { DATABASE } from '../database/database.module.js';
import { naOrdemDaFila, vezNaFila } from './ordem-da-fila.js';
import { type JobScope, tenantFilter } from './outbox-publisher.js';
import { PedidosDosComentariosService, type VezDaRetiradaDoComentario, type VezDoPedido } from './pedidos-dos-comentarios.service.js';

/** A vez reservada volta para a fila depois disto se o worker cair no meio (o modelo e a leitura na Meta cabem com folga). */
const RESERVA = '15 minutes';

export type VezDoComentario = { id: string; tenantId: string; feito: VezDoPedido };

/** A vez reservada, com a posição dela na fila: o lote é tratado nessa ordem (ERR-135). */
type Reservada = { id: string; tenant_id: string; vez: string };

/** A posição na fila, como texto que se ordena: a mais atrasada primeiro, a mesma ordem do `order by` da reserva (V127). */
const vezDoPedido = vezNaFila(sql`coalesce(s.next_attempt_at, s.created_at)`);

/**
 * A fila dos pedidos do Social media para os comentários (A6, Z11, parte 2d-2; migration 0125): os comentários que esperam
 * e cuja vez chegou, de qualquer empresa, o mais atrasado primeiro. Quem abre a vez é a leitura dos comentários, com a
 * função ligada para a marca. Reserva com SKIP LOCKED na mesma linha que a reserva altera (V35), empurrando
 * `next_attempt_at` (se o worker cair no meio, a vez volta sozinha), e pede ao serviço que trate cada uma, na ordem da
 * fila (V127). Toda vez deixa rastro na linha: o pedido em Aprovações, o fim dela, a tentativa contada ou a espera (V106).
 */
@Injectable()
export class PedidosDosComentariosLoop {
  private readonly logger = new Logger('pedidos-dos-comentarios');

  constructor(
    @Inject(DATABASE) private readonly database: Database | null,
    private readonly pedidos: PedidosDosComentariosService,
  ) {}

  async executarLote(limite = 3, scope: JobScope = {}, agora?: Date): Promise<VezDoComentario[]> {
    if (!this.database) return [];
    const quando = agora ?? new Date();
    const ref = sql`${quando.toISOString()}::timestamptz`;
    const reservadas = await withSystem(this.database.db, async (tx) =>
      (
        await tx.execute<Reservada>(sql`
          with devidas as materialized (
            select s.id, ${vezDoPedido} as vez
              from liame.comment_suggestion s
             where s.status = 'esperando'
               and (s.next_attempt_at is null or s.next_attempt_at <= ${ref})
               ${tenantFilter(scope, sql`s.tenant_id`)}
             order by coalesce(s.next_attempt_at, s.created_at), s.id
             limit ${limite}
             for update of s skip locked
          )
          update liame.comment_suggestion s
             set next_attempt_at = ${ref} + ${RESERVA}::interval, updated_at = ${ref}
            from devidas x
           where s.id = x.id
          returning s.id, s.tenant_id, x.vez`)
      ).rows,
    );

    const vezes: VezDoComentario[] = [];
    for (const l of naOrdemDaFila(reservadas)) {
      const alvo = { tenantId: l.tenant_id, id: l.id };
      let feito: VezDoPedido;
      try {
        feito = await this.pedidos.pedir(alvo, quando);
      } catch (err) {
        // Falha fora do previsto: conta como tentativa; se nem isso gravar, a reserva vence e a vez volta (LIC-001).
        this.logger.error(`pedido ${l.id}: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
        try {
          feito = await this.pedidos.falhou(alvo, 'erro', quando);
        } catch (err2) {
          this.logger.error(`pedido ${l.id}: não foi possível registrar a falha: ${err2 instanceof Error ? err2.message : String(err2)}`);
          feito = { status: 'falhou', motivo: 'erro', deVez: false };
        }
      }
      vezes.push({ id: l.id, tenantId: l.tenant_id, feito });
    }
    return vezes;
  }

  /**
   * A conferência da retirada (A6, Z11, parte 2d-5; D-A6-102): os pedidos do Social media sobre comentários que ainda
   * esperam a decisão e cujo comentário a leitura trouxe de novo desde a última conferência (`read_at` depois do
   * `updated_at` da vez), ou cujo comentário saiu do Liame (a vez sai com ele, em cascata), de qualquer empresa, o mais
   * antigo primeiro. Não reserva: o Action Service trava o pedido e não retira o que já não espera, e a conferência que
   * não acha mudança marca a vez como olhada (a linha sai daqui até a próxima leitura, V106).
   */
  async executarRetiradas(limite = 10, scope: JobScope = {}, agora?: Date): Promise<Array<{ pedido: string; tenantId: string; feito: VezDaRetiradaDoComentario }>> {
    if (!this.database) return [];
    const quando = agora ?? new Date();
    const prefixo = recursoDoComentario('');
    const candidatos = await withSystem(this.database.db, async (tx) =>
      (
        await tx.execute<{ id: string; tenant_id: string }>(sql`
          select a.id, a.tenant_id
            from liame.action_request a
            left join liame.comment_suggestion s on s.action_id = a.id and s.status = 'pronta'
            left join liame.social_comment c on c.connected_account_id = s.connected_account_id and c.comment_id = s.comment_id
           where a.status = 'aguardando_aprovacao' and a.actor_type = 'agent' and a.agent_key = ${SOCIAL.key}
             and a.tool in (${FERRAMENTA_DA_OPERACAO.responder}, ${FERRAMENTA_DA_OPERACAO.ocultar})
             and a.resource_id like ${`${prefixo}%`}
             -- Com a vez: o comentário relido depois da última conferência. Sem a vez: só o pedido cujo comentário saiu
             -- do Liame (a vez sai com ele); qualquer outro sem vez não teria o que marcar e voltaria sempre (V106).
             and (c.read_at > s.updated_at
                  or (s.id is null
                      and not exists (select 1 from liame.social_comment o
                                       where o.connected_account_id::text = a.account_id
                                         and ${prefixo} || o.comment_id = a.resource_id)))
             ${tenantFilter(scope, sql`a.tenant_id`)}
           order by a.created_at, a.id
           limit ${limite}`)
      ).rows,
    );
    const feitos: Array<{ pedido: string; tenantId: string; feito: VezDaRetiradaDoComentario }> = [];
    for (const l of candidatos) {
      let feito: VezDaRetiradaDoComentario;
      try {
        feito = await this.pedidos.retirarSeMudou({ tenantId: l.tenant_id, actionId: l.id }, quando);
      } catch (err) {
        // Falha fora do previsto: o pedido fica, e a próxima volta confere de novo.
        this.logger.error(`retirada ${l.id}: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
        feito = { status: 'fora' };
      }
      feitos.push({ pedido: l.id, tenantId: l.tenant_id, feito });
    }
    return feitos;
  }
}
