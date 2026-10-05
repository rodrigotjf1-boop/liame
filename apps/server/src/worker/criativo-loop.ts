import { type Database, type Tx, withSystem } from '@liame/database';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { type SQL, sql } from 'drizzle-orm';
import type { DestinoDaPeca } from '../ai/criativo/peca.js';
import { CRIATIVO } from '../ai/criativo/prompt.js';
import { activeTraceId, writeAudit } from '../audit/audit.js';
import { DATABASE } from '../database/database.module.js';
import { FlagService } from '../flags/flag.service.js';
import { CriativoService, type PedidoNaFila, type ResultadoDaGeracao } from './criativo.service.js';
import { type JobScope, tenantFilter } from './outbox-publisher.js';

/** O pedido reservado volta para a fila depois disto se o worker cair no meio. */
const RESERVA = '10 minutes';
/** Depois de tantas falhas passageiras (modelo fora do ar, resposta fora do formato), o pedido fecha como `falhou`. */
export const TENTATIVAS_DA_GERACAO = 3;

export type VezDaGeracao = { id: string; tenantId: string; status: ResultadoDaGeracao['status'] | 'falhou_de_vez'; motivo?: string };

type Reservado = {
  id: string;
  tenant_id: string;
  brand_id: string;
  offer: string;
  dossier_version: number;
  destination: DestinoDaPeca;
  variations: number;
  instruction: string | null;
  reference_name: string | null;
  requested_by: string | null;
};

/** O código do motivo como a coluna guarda (`sem-rota` vira `sem_rota`). */
const codigo = (motivo: string) => motivo.replace(/[^a-z_]/g, '_').slice(0, 40);

/**
 * A fila do Criativo (A4, X6): reserva os pedidos de peças novas, com SKIP LOCKED na mesma linha que a reserva altera
 * (V35), e gera as peças de cada um (`CriativoService`). Quem pediu está esperando, e a marca só tem um pedido na fila
 * de cada vez; por isso nada fica preso: o pedido que não pode ser atendido agora (a IA ou o Criativo desligados, sem
 * rota de modelo, limite de IA atingido) fecha como `falhou`, com o motivo, e a pessoa pede de novo quando der. A
 * recusa do Criativo fecha como `recusado`. Só a falha passageira (modelo fora do ar, resposta fora do formato) tenta
 * de novo, poucas vezes e logo.
 */
@Injectable()
export class CriativoLoop {
  private readonly logger = new Logger('criativo');

  constructor(
    @Inject(DATABASE) private readonly database: Database | null,
    private readonly flags: FlagService,
    private readonly criativo: CriativoService,
  ) {}

  async executarLote(limite = 3, scope: JobScope = {}, agora?: Date): Promise<VezDaGeracao[]> {
    if (!this.database) return [];
    const ref = agora ? sql`${agora.toISOString()}::timestamptz` : sql`now()`;
    const reservados = await withSystem(this.database.db, async (tx) =>
      (
        await tx.execute<Reservado>(sql`
          with devidos as materialized (
            select r.id
              from liame.ad_piece_request r
             where r.attempts < ${TENTATIVAS_DA_GERACAO} and r.piece_id is null
               and ((r.status = 'pendente' and (r.next_attempt_at is null or r.next_attempt_at <= ${ref}))
                 or (r.status = 'gerando' and r.next_attempt_at <= ${ref}))
               ${tenantFilter(scope, sql`r.tenant_id`)}
             order by coalesce(r.next_attempt_at, r.created_at), r.id
             limit ${limite}
             for update of r skip locked
          )
          update liame.ad_piece_request r
             set status = 'gerando', next_attempt_at = ${ref} + ${RESERVA}::interval, updated_at = now()
            from devidos x
           where r.id = x.id
          returning r.id, r.tenant_id, r.brand_id, r.offer, r.dossier_version, r.destination, r.variations, r.instruction, r.reference_name, r.requested_by`)
      ).rows,
    );

    const vezes: VezDaGeracao[] = [];
    for (const l of reservados) {
      const p: PedidoNaFila = {
        id: l.id,
        tenantId: l.tenant_id,
        brandId: l.brand_id,
        offer: l.offer,
        dossierVersion: l.dossier_version,
        destination: l.destination,
        variations: l.variations,
        instruction: l.instruction,
        referenceName: l.reference_name,
        requestedBy: l.requested_by,
      };
      try {
        const contexto = this.flags.context({ tenantId: l.tenant_id, brandId: l.brand_id });
        const desligada = !(await this.flags.isEnabled('ia', contexto)) ? 'ia_desligada' : !(await this.flags.isEnabled('criativo', contexto)) ? 'criativo_desligado' : null;
        if (desligada) {
          await this.encerrar(p, 'falhou', desligada, null, ref);
          vezes.push({ id: l.id, tenantId: l.tenant_id, status: 'sem_ia', motivo: desligada });
          continue;
        }
        const r = await this.criativo.gerar(p, agora);
        if (r.status === 'concluido') {
          vezes.push({ id: l.id, tenantId: l.tenant_id, status: 'concluido' });
          continue;
        }
        if (r.status === 'recusado') await this.encerrar(p, 'recusado', r.motivo, r.usageId ?? null, ref);
        else if (r.status === 'sem_ia') await this.encerrar(p, 'falhou', r.motivo, null, ref);
        else if (r.status === 'falhou') {
          const deVez = await this.falhou(p, r.motivo, ref);
          vezes.push({ id: l.id, tenantId: l.tenant_id, status: deVez ? 'falhou_de_vez' : 'falhou', motivo: r.motivo });
          continue;
        }
        vezes.push({ id: l.id, tenantId: l.tenant_id, status: r.status, motivo: r.motivo });
      } catch (err) {
        // Falha fora do previsto: conta como tentativa; se nem isso gravar, a reserva vence e o pedido volta (LIC-001).
        this.logger.error(`pedido ${l.id}: ${err instanceof Error ? err.message : String(err)}`);
        try {
          await this.falhou(p, 'erro', ref);
        } catch (err2) {
          this.logger.error(`pedido ${l.id}: não foi possível registrar a falha: ${err2 instanceof Error ? err2.message : String(err2)}`);
        }
        vezes.push({ id: l.id, tenantId: l.tenant_id, status: 'falhou', motivo: 'erro' });
      }
    }
    return vezes;
  }

  /** A auditoria do pedido que fechou sem peça nenhuma. */
  private auditar(tx: Tx, p: PedidoNaFila, acao: 'peca.recusar_pedido' | 'peca.falhar', motivo: string) {
    return writeAudit(tx, {
      tenantId: p.tenantId,
      actorType: 'agent',
      actorId: null,
      actorLabel: 'Criativo',
      action: acao,
      resourceType: 'ad_piece_request',
      resourceId: p.id,
      after: { pedidas: p.variations, reason: codigo(motivo) },
      traceId: activeTraceId(),
      origin: 'worker',
      agent: CRIATIVO.key,
    });
  }

  /**
   * Fecha o pedido sem peça, com o motivo e a auditoria: `recusado` (o Criativo não escreve sobre aquilo, ou nenhuma
   * peça serviu) ou `falhou` (não deu para chamar a IA agora). Tentar de novo sozinho não muda nada.
   */
  private async encerrar(p: PedidoNaFila, status: 'recusado' | 'falhou', motivo: string, usageId: string | null, ref: SQL): Promise<void> {
    await withSystem(this.database!.db, async (tx) => {
      const r = await tx.execute(sql`
        update liame.ad_piece_request
           set status = ${status}, reason = ${codigo(motivo)}, usage_id = coalesce(${usageId}::uuid, usage_id), next_attempt_at = null,
               finished_at = ${ref}, updated_at = now()
         where id = ${p.id} and tenant_id = ${p.tenantId} and status = 'gerando'`);
      if (r.rowCount) await this.auditar(tx, p, status === 'recusado' ? 'peca.recusar_pedido' : 'peca.falhar', motivo);
    });
  }

  /**
   * Uma tentativa que falhou por motivo passageiro: espera 1 minuto × 2^tentativas; na última, o pedido fecha como
   * `falhou`, com a auditoria. Devolve se fechou. Na instrução, `attempts` à direita é o valor de antes.
   */
  private async falhou(p: PedidoNaFila, motivo: string, ref: SQL): Promise<boolean> {
    return withSystem(this.database!.db, async (tx) => {
      const r = await tx.execute<{ status: string }>(sql`
        update liame.ad_piece_request
           set attempts = attempts + 1, reason = ${codigo(motivo)}, updated_at = now(),
               status = case when attempts + 1 >= ${TENTATIVAS_DA_GERACAO} then 'falhou' else 'pendente' end,
               next_attempt_at = case when attempts + 1 >= ${TENTATIVAS_DA_GERACAO} then null
                                      else ${ref} + (power(2, attempts) || ' minutes')::interval end,
               finished_at = case when attempts + 1 >= ${TENTATIVAS_DA_GERACAO} then ${ref} else null end
         where id = ${p.id} and tenant_id = ${p.tenantId} and status = 'gerando'
        returning status`);
      const deVez = r.rows[0]?.status === 'falhou';
      if (deVez) await this.auditar(tx, p, 'peca.falhar', motivo);
      return deVez;
    });
  }
}
