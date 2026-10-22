import { type Database, withSystem } from '@liame/database';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { DATABASE } from '../database/database.module.js';
import { naOrdemDaFila, vezNaFila } from './ordem-da-fila.js';
import { type JobScope, tenantFilter } from './outbox-publisher.js';
import { SOCIAL } from '../ai/social/prompt.js';
import { SugestoesDeRespostaService, type VezDaRetirada, type VezDaSugestao } from './sugestoes-de-resposta.service.js';

/** A vez reservada volta para a fila depois disto se o worker cair no meio (o modelo e a leitura do Google cabem com folga). */
const RESERVA = '15 minutes';

export type VezDaAvaliacao = { id: string; tenantId: string; feito: VezDaSugestao };

/** A vez reservada, com a posição dela na fila: o lote é tratado nessa ordem (ERR-135). */
type Reservada = { id: string; tenant_id: string; vez: string };

/**
 * A fila das sugestões de resposta do Social media (A6, Z6; migration 0079): as avaliações que esperam e cuja vez
 * chegou, a mais atrasada primeiro, de qualquer empresa. Quem abre a vez é a leitura do Google que trouxe a avaliação,
 * com a função ligada para a loja. Reserva com SKIP LOCKED na mesma linha que a reserva altera (V35), empurrando
 * `next_attempt_at` (se o worker cair no meio, a vez volta sozinha), e pede ao serviço que trate cada uma, na ordem da
 * fila (V127). Toda vez deixa rastro na linha: o pedido em Aprovações, o fim dela, a tentativa contada ou a espera
 * (V106). As duas rodadas passam por aqui: a da avaliação nova e a do "Pedir outras", que entra no pedido que já espera.
 */
@Injectable()
export class SugestoesDeRespostaLoop {
  private readonly logger = new Logger('sugestoes-de-resposta');

  constructor(
    @Inject(DATABASE) private readonly database: Database | null,
    private readonly sugestoes: SugestoesDeRespostaService,
  ) {}

  async executarLote(limite = 3, scope: JobScope = {}, agora?: Date): Promise<VezDaAvaliacao[]> {
    if (!this.database) return [];
    const quando = agora ?? new Date();
    const ref = sql`${quando.toISOString()}::timestamptz`;
    const reservadas = await withSystem(this.database.db, async (tx) =>
      (
        await tx.execute<Reservada>(sql`
          with devidas as materialized (
            select s.id, ${vezNaFila(sql`coalesce(s.next_attempt_at, s.created_at)`)} as vez
              from liame.review_suggestion s
             where s.status = 'esperando'
               and (s.next_attempt_at is null or s.next_attempt_at <= ${ref})
               ${tenantFilter(scope, sql`s.tenant_id`)}
             order by coalesce(s.next_attempt_at, s.created_at), s.id
             limit ${limite}
             for update of s skip locked
          )
          update liame.review_suggestion s
             set next_attempt_at = ${ref} + ${RESERVA}::interval, updated_at = ${ref}
            from devidas x
           where s.id = x.id
          returning s.id, s.tenant_id, x.vez`)
      ).rows,
    );

    const vezes: VezDaAvaliacao[] = [];
    for (const l of naOrdemDaFila(reservadas)) {
      const alvo = { tenantId: l.tenant_id, id: l.id };
      let feito: VezDaSugestao;
      try {
        feito = await this.sugestoes.sugerir(alvo, quando);
      } catch (err) {
        // Falha fora do previsto: conta como tentativa; se nem isso gravar, a reserva vence e a vez volta (LIC-001).
        this.logger.error(`sugestão ${l.id}: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
        try {
          feito = await this.sugestoes.falhou(alvo, 'erro', quando);
        } catch (err2) {
          this.logger.error(`sugestão ${l.id}: não foi possível registrar a falha: ${err2 instanceof Error ? err2.message : String(err2)}`);
          feito = { status: 'falhou', motivo: 'erro', deVez: false };
        }
      }
      vezes.push({ id: l.id, tenantId: l.tenant_id, feito });
    }
    return vezes;
  }

  /**
   * A retirada (P31): os pedidos do Social media que esperam a decisão, cuja avaliação o Google trouxe de novo depois da
   * última olhada (a leitura grava a avaliação a cada volta). A lista parte dos pedidos que esperam (no máximo três dias
   * de pedidos, pelo prazo deles), e não das vezes, que crescem com o tempo. Cada uma é olhada numa transação da empresa,
   * com a vez travada (`retirarSeMudou`); o que nada mudou fica marcado e só volta depois da próxima leitura.
   */
  async retirarLote(limite = 20, scope: JobScope = {}, agora?: Date): Promise<Array<{ id: string; tenantId: string; feito: VezDaRetirada }>> {
    if (!this.database) return [];
    const quando = agora ?? new Date();
    const devidas = await withSystem(this.database.db, async (tx) =>
      (
        await tx.execute<Reservada>(sql`
          select s.id, s.tenant_id, ${vezNaFila(sql`r.updated_at`)} as vez
            from liame.action_request q
            join liame.review_suggestion s on s.action_id = q.id and s.status = 'pronta' and s.round = 1
            join liame.profile_review r on r.id = s.review_id
           where q.status = 'aguardando_aprovacao' and q.tool = 'avaliacao_responder' and q.agent_key = ${SOCIAL.key}
             and r.updated_at > s.updated_at
             ${tenantFilter(scope, sql`q.tenant_id`)}
           order by r.updated_at, s.id
           limit ${limite}`)
      ).rows,
    );
    const vezes: Array<{ id: string; tenantId: string; feito: VezDaRetirada }> = [];
    for (const l of naOrdemDaFila(devidas)) {
      let feito: VezDaRetirada;
      try {
        feito = await this.sugestoes.retirarSeMudou({ tenantId: l.tenant_id, id: l.id }, quando);
      } catch (err) {
        // Falha fora do previsto: fica no log, e a vez é olhada de novo na próxima volta (nada foi gravado).
        this.logger.error(`sugestão ${l.id} (retirada): ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
        feito = { status: 'fora' };
      }
      vezes.push({ id: l.id, tenantId: l.tenant_id, feito });
    }
    return vezes;
  }
}
