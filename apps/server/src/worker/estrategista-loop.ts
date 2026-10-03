import type { PlanKind } from '@liame/contracts';
import { type Database, withSystem } from '@liame/database';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { type SQL, sql } from 'drizzle-orm';
import { DATABASE } from '../database/database.module.js';
import { FlagService } from '../flags/flag.service.js';
import { EstrategistaService, type ItemDoEstrategista, type ResultadoDoEstrategista } from './estrategista.service.js';
import { type JobScope, tenantFilter } from './outbox-publisher.js';

/** A demanda reservada (ou o plano em nova análise) volta para a fila depois disto se o worker cair no meio. */
const RESERVA = '30 minutes';
/** Depois de tantas falhas, o Estrategista desiste: a demanda fica aberta (a pessoa vê e cancela) e o plano volta à decisão. */
export const TENTATIVAS = 5;
/** Quando volta o item que não foi atendido por um motivo que não é falha do Estrategista. */
const VOLTA: Record<string, string> = {
  ia_desligada: '1 hour',
  desligada: '1 hour',
  travada: '1 hour',
  funcionario_desligado: '6 hours',
  'sem-rota': '6 hours',
  teto: '6 hours',
  // A hora em que o limite da pessoa libera já vem do gateway: só um minuto de folga.
  'limite-usuario': '1 minute',
};

/** O tipo de demanda que vira plano, e qual plano. */
const PLANO_DA_DEMANDA: Record<string, PlanKind> = { promocao: 'oferta', pauta: 'pauta', plano: 'noventa_dias' };

export type VezDoEstrategista = Pick<ItemDoEstrategista, 'tipo' | 'id' | 'tenantId'> & { status: ResultadoDoEstrategista['status'] | 'falhou'; motivo?: string };

type Reservado = { id: string; tenant_id: string; brand_id: string; kind: string };

/**
 * A fila do Estrategista (A3, I11): reserva as demandas abertas que viram plano (promoção, pauta, plano) e os planos com
 * nova análise pedida, com SKIP LOCKED na mesma linha que a reserva altera (V35), o que espera há mais tempo primeiro.
 * Só chama o Estrategista para a empresa com a flag `ia` ligada; sem ela, a demanda volta a ficar aberta. A geração em
 * si está em `EstrategistaService`.
 */
@Injectable()
export class EstrategistaLoop {
  private readonly logger = new Logger('estrategista');

  constructor(
    @Inject(DATABASE) private readonly database: Database | null,
    private readonly flags: FlagService,
    private readonly estrategista: EstrategistaService,
  ) {}

  async executarLote(limite = 3, scope: JobScope = {}, agora?: Date): Promise<VezDoEstrategista[]> {
    if (!this.database) return [];
    const ref = agora ? sql`${agora.toISOString()}::timestamptz` : sql`now()`;
    const reservados = await withSystem(this.database.db, async (tx) => {
      const demandas = await tx.execute<Reservado>(sql`
        with devidas as materialized (
          select d.id
            from liame.demand d
           where d.assignee_agent = 'estrategista' and d.kind in ('promocao', 'pauta', 'plano') and d.attempts < ${TENTATIVAS}
             and ((d.status = 'aberta' and (d.next_attempt_at is null or d.next_attempt_at <= ${ref}))
               or (d.status = 'em_andamento' and d.next_attempt_at <= ${ref}))
             ${tenantFilter(scope, sql`d.tenant_id`)}
           order by coalesce(d.next_attempt_at, d.created_at), d.id
           limit ${limite}
           for update of d skip locked
        )
        update liame.demand d
           set status = 'em_andamento', next_attempt_at = ${ref} + ${RESERVA}::interval, updated_at = now()
          from devidas x
         where d.id = x.id
        returning d.id, d.tenant_id, d.brand_id, d.kind`);
      const planos = await tx.execute<Reservado>(sql`
        with devidos as materialized (
          select p.id
            from liame.plan p
           where p.status = 'nova_analise' and (p.next_attempt_at is null or p.next_attempt_at <= ${ref})
             ${tenantFilter(scope, sql`p.tenant_id`)}
           order by coalesce(p.next_attempt_at, p.updated_at), p.id
           limit ${limite}
           for update of p skip locked
        )
        update liame.plan p
           set next_attempt_at = ${ref} + ${RESERVA}::interval
          from devidos x
         where p.id = x.id
        returning p.id, p.tenant_id, p.brand_id, p.kind`);
      return [
        ...demandas.rows.map((d): ItemDoEstrategista => ({ tipo: 'demanda', id: d.id, tenantId: d.tenant_id, brandId: d.brand_id, kind: PLANO_DA_DEMANDA[d.kind]! })),
        ...planos.rows.map((p): ItemDoEstrategista => ({ tipo: 'nova_analise', id: p.id, tenantId: p.tenant_id, brandId: p.brand_id, kind: p.kind as PlanKind })),
      ];
    });

    const vezes: VezDoEstrategista[] = [];
    for (const item of reservados) {
      const vez = { tipo: item.tipo, id: item.id, tenantId: item.tenantId };
      try {
        if (!(await this.flags.isEnabled('ia', this.flags.context({ tenantId: item.tenantId, brandId: item.brandId })))) {
          await this.devolver(item, 'ia_desligada', ref);
          vezes.push({ ...vez, status: 'sem_ia', motivo: 'ia_desligada' });
          continue;
        }
        const r = await this.estrategista.gerar(item, agora);
        if (r.status === 'sem_ia') await this.devolver(item, r.motivo, r.voltaEm ? sql`greatest(${ref}, ${r.voltaEm.toISOString()}::timestamptz)` : ref);
        else if (r.status === 'recusado') await this.falhou(item, r.motivo, ref);
        else if (r.status === 'descartado') await this.desistir(item, r.motivo);
        else this.logger.log(`${item.tipo} ${item.id}: plano ${r.planId}, versão ${r.version}, em Aprovações`);
        vezes.push({ ...vez, status: r.status, ...(r.status === 'proposto' ? {} : { motivo: r.motivo }) });
      } catch (err) {
        // Falha fora do previsto: conta como tentativa; se nem isso gravar, a reserva vence e o item volta (LIC-001).
        this.logger.error(`${item.tipo} ${item.id}: ${err instanceof Error ? err.message : String(err)}`);
        try {
          await this.falhou(item, 'erro', ref);
        } catch (err2) {
          this.logger.error(`${item.tipo} ${item.id}: não foi possível registrar a falha: ${err2 instanceof Error ? err2.message : String(err2)}`);
        }
        vezes.push({ ...vez, status: 'falhou' });
      }
    }
    return vezes;
  }

  /** O item volta para a fila sem contar tentativa (IA desligada, sem rota, teto): a demanda fica aberta de novo. */
  private async devolver(item: ItemDoEstrategista, motivo: string, base: SQL): Promise<void> {
    const volta = sql`${base} + ${VOLTA[motivo] ?? '1 hour'}::interval`;
    await withSystem(this.database!.db, (tx) =>
      item.tipo === 'demanda'
        ? tx.execute(sql`
            update liame.demand set status = 'aberta', next_attempt_at = ${volta}, last_error = ${motivo}, updated_at = now()
             where id = ${item.id} and tenant_id = ${item.tenantId} and status = 'em_andamento'`)
        : tx.execute(sql`
            update liame.plan set next_attempt_at = ${volta}, last_error = ${motivo}
             where id = ${item.id} and tenant_id = ${item.tenantId} and status = 'nova_analise'`),
    );
  }

  /**
   * Uma tentativa que falhou: espera 15 minutos × 2^tentativas, até um dia. Na última, o Estrategista desiste: a demanda
   * fica aberta (fora da fila) e o plano volta a esperar a decisão na versão que já tinha, com pelo menos um dia de prazo.
   * Na instrução, `attempts` à direita é o valor de antes.
   */
  private async falhou(item: ItemDoEstrategista, motivo: string, ref: SQL): Promise<void> {
    await withSystem(this.database!.db, (tx) =>
      item.tipo === 'demanda'
        ? tx.execute(sql`
            update liame.demand
               set status = 'aberta', attempts = attempts + 1, last_error = ${motivo}, updated_at = now(),
                   next_attempt_at = ${ref} + (least(15 * power(2, attempts), 1440) || ' minutes')::interval
             where id = ${item.id} and tenant_id = ${item.tenantId} and status = 'em_andamento'`)
        : tx.execute(sql`
            update liame.plan
               set attempts = attempts + 1, last_error = ${motivo},
                   next_attempt_at = ${ref} + (least(15 * power(2, attempts), 1440) || ' minutes')::interval,
                   status = case when attempts + 1 >= ${TENTATIVAS} then 'pendente' else status end,
                   expires_at = case when attempts + 1 >= ${TENTATIVAS} then greatest(expires_at, ${ref} + interval '24 hours') else expires_at end,
                   updated_at = now()
             where id = ${item.id} and tenant_id = ${item.tenantId} and status = 'nova_analise'`),
    );
  }

  /** O item não está mais com o Estrategista (a demanda mudou, a marca foi arquivada): sai da fila sem mexer no resto. */
  private async desistir(item: ItemDoEstrategista, motivo: string): Promise<void> {
    await withSystem(this.database!.db, (tx) =>
      item.tipo === 'demanda'
        ? tx.execute(sql`
            update liame.demand set status = 'aberta', attempts = ${TENTATIVAS}, next_attempt_at = null, last_error = ${motivo.slice(0, 200)}, updated_at = now()
             where id = ${item.id} and tenant_id = ${item.tenantId} and status = 'em_andamento'`)
        : tx.execute(sql`
            update liame.plan set status = 'pendente', next_attempt_at = null, last_error = ${motivo.slice(0, 200)}, updated_at = now()
             where id = ${item.id} and tenant_id = ${item.tenantId} and status = 'nova_analise'`),
    );
  }
}
