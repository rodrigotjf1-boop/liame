import { type Database, type Tx, withSystem } from '@liame/database';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { type SQL, sql } from 'drizzle-orm';
import type { TipoDePagina } from '../ai/pesquisador/leitura.js';
import { PESQUISADOR } from '../ai/pesquisador/prompt.js';
import { activeTraceId, writeAudit } from '../audit/audit.js';
import { DATABASE } from '../database/database.module.js';
import { FlagService } from '../flags/flag.service.js';
import { type JobScope, tenantFilter } from './outbox-publisher.js';
import { type PedidoDeLeitura, PesquisadorService, type ResultadoDaLeitura } from './pesquisa.service.js';

/** O pedido reservado volta para a fila depois disto se o worker cair no meio. */
const RESERVA = '10 minutes';
/** Depois de tantas falhas (site fora do ar, modelo fora do ar), o pedido fecha como `falhou`. */
export const TENTATIVAS_DA_LEITURA = 5;
/** Quando volta o pedido que não foi lido por um motivo que não é falha (IA desligada, sem rota, teto). */
const VOLTA: Record<string, string> = {
  ia_desligada: '1 hour',
  desligada: '1 hour',
  travada: '1 hour',
  funcionario_desligado: '6 hours',
  'sem-rota': '6 hours',
  teto: '6 hours',
  'limite-usuario': '1 minute',
};

export type VezDaLeitura = { id: string; tenantId: string; status: ResultadoDaLeitura['status'] | 'falhou_de_vez'; motivo?: string };

type Reservado = { id: string; tenant_id: string; brand_id: string; kind: TipoDePagina; url: string; requested_by: string | null };

/** O código do motivo como a coluna guarda (`sem-rota` vira `sem_rota`). */
const codigo = (motivo: string) => motivo.replace(/[^a-z_]/g, '_').slice(0, 40);

/**
 * A fila do Pesquisador (A3, I12): reserva os pedidos de leitura, com SKIP LOCKED na mesma linha que a reserva
 * altera (V35), e lê cada um (`PesquisadorService`). Só para a empresa com a flag `ia` ligada; sem ela, o pedido volta
 * para a fila. A recusa fecha o pedido; a falha tenta de novo, cada vez mais tarde, até desistir.
 */
@Injectable()
export class PesquisaLoop {
  private readonly logger = new Logger('pesquisador');

  constructor(
    @Inject(DATABASE) private readonly database: Database | null,
    private readonly flags: FlagService,
    private readonly pesquisador: PesquisadorService,
  ) {}

  async executarLote(limite = 3, scope: JobScope = {}, agora?: Date): Promise<VezDaLeitura[]> {
    if (!this.database) return [];
    const ref = agora ? sql`${agora.toISOString()}::timestamptz` : sql`now()`;
    const reservados = await withSystem(this.database.db, async (tx) =>
      (
        await tx.execute<Reservado>(sql`
          with devidos as materialized (
            select r.id
              from liame.research_request r
             where r.attempts < ${TENTATIVAS_DA_LEITURA}
               and ((r.status = 'pendente' and (r.next_attempt_at is null or r.next_attempt_at <= ${ref}))
                 or (r.status = 'lendo' and r.next_attempt_at <= ${ref}))
               ${tenantFilter(scope, sql`r.tenant_id`)}
             order by coalesce(r.next_attempt_at, r.created_at), r.id
             limit ${limite}
             for update of r skip locked
          )
          update liame.research_request r
             set status = 'lendo', next_attempt_at = ${ref} + ${RESERVA}::interval, updated_at = now()
            from devidos x
           where r.id = x.id
          returning r.id, r.tenant_id, r.brand_id, r.kind, r.url, r.requested_by`)
      ).rows,
    );

    const vezes: VezDaLeitura[] = [];
    for (const l of reservados) {
      const p: PedidoDeLeitura = { id: l.id, tenantId: l.tenant_id, brandId: l.brand_id, kind: l.kind, url: l.url, requestedBy: l.requested_by };
      try {
        if (!(await this.flags.isEnabled('ia', this.flags.context({ tenantId: l.tenant_id, brandId: l.brand_id })))) {
          await this.devolver(p, 'ia_desligada', ref);
          vezes.push({ id: l.id, tenantId: l.tenant_id, status: 'sem_ia', motivo: 'ia_desligada' });
          continue;
        }
        const r = await this.pesquisador.ler(p, agora);
        if (r.status === 'concluida') {
          vezes.push({ id: l.id, tenantId: l.tenant_id, status: 'concluida' });
          continue;
        }
        if (r.status === 'recusada') await this.fechar(p, r.motivo, r.usageId ?? null, ref);
        else if (r.status === 'sem_ia') await this.devolver(p, r.motivo, r.voltaEm ? sql`greatest(${ref}, ${r.voltaEm.toISOString()}::timestamptz)` : ref);
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

  /** O pedido volta para a fila sem contar tentativa. */
  private async devolver(p: PedidoDeLeitura, motivo: string, base: SQL): Promise<void> {
    await withSystem(this.database!.db, (tx) =>
      tx.execute(sql`
        update liame.research_request
           set status = 'pendente', reason = ${codigo(motivo)}, next_attempt_at = ${base} + ${VOLTA[motivo] ?? '1 hour'}::interval, updated_at = now()
         where id = ${p.id} and tenant_id = ${p.tenantId} and status = 'lendo'`),
    );
  }

  /** A auditoria do pedido que fechou sem leitura (recusado, ou falhou de vez). */
  private auditar(tx: Tx, p: PedidoDeLeitura, acao: 'pesquisa.recusar' | 'pesquisa.falhar', motivo: string) {
    return writeAudit(tx, {
      tenantId: p.tenantId,
      actorType: 'agent',
      actorId: null,
      actorLabel: 'Pesquisador',
      action: acao,
      resourceType: 'research_request',
      resourceId: p.id,
      after: { kind: p.kind, host: new URL(p.url).hostname, reason: codigo(motivo) },
      traceId: activeTraceId(),
      origin: 'worker',
      agent: PESQUISADOR.key,
    });
  }

  /** Fecha o pedido recusado, com o motivo e a auditoria: tentar de novo não muda nada. */
  private async fechar(p: PedidoDeLeitura, motivo: string, usageId: string | null, ref: SQL): Promise<void> {
    await withSystem(this.database!.db, async (tx) => {
      const r = await tx.execute(sql`
        update liame.research_request
           set status = 'recusada', reason = ${codigo(motivo)}, usage_id = coalesce(${usageId}::uuid, usage_id), next_attempt_at = null,
               finished_at = ${ref}, updated_at = now()
         where id = ${p.id} and tenant_id = ${p.tenantId} and status = 'lendo'`);
      if (r.rowCount) await this.auditar(tx, p, 'pesquisa.recusar', motivo);
    });
  }

  /**
   * Uma tentativa que falhou: espera 15 minutos × 2^tentativas, até um dia; na última, o pedido fecha como `falhou`,
   * com a auditoria. Devolve se fechou. Na instrução, `attempts` à direita é o valor de antes.
   */
  private async falhou(p: PedidoDeLeitura, motivo: string, ref: SQL): Promise<boolean> {
    return withSystem(this.database!.db, async (tx) => {
      const r = await tx.execute<{ status: string }>(sql`
        update liame.research_request
           set attempts = attempts + 1, reason = ${codigo(motivo)}, updated_at = now(),
               status = case when attempts + 1 >= ${TENTATIVAS_DA_LEITURA} then 'falhou' else 'pendente' end,
               next_attempt_at = case when attempts + 1 >= ${TENTATIVAS_DA_LEITURA} then null
                                      else ${ref} + (least(15 * power(2, attempts), 1440) || ' minutes')::interval end,
               finished_at = case when attempts + 1 >= ${TENTATIVAS_DA_LEITURA} then ${ref} else null end
         where id = ${p.id} and tenant_id = ${p.tenantId} and status = 'lendo'
        returning status`);
      const deVez = r.rows[0]?.status === 'falhou';
      if (deVez) await this.auditar(tx, p, 'pesquisa.falhar', motivo);
      return deVez;
    });
  }
}
