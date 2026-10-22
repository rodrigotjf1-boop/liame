import { type Database, withSystem } from '@liame/database';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { type SQL, sql } from 'drizzle-orm';
import { DATABASE } from '../database/database.module.js';
import { HORA_DE_GERAR } from '../results/relatorio-mensal.js';
import { type JobScope, tenantFilter } from './outbox-publisher.js';
import { RelatorioMensalService, type ResultadoDoRelatorio } from './relatorio-mensal.service.js';

/** Reserva da marca: se o worker cair no meio, ela volta para a fila depois disto. */
const RESERVA = '30 minutes';
/** A leitura da manhã ainda não chegou: olha de novo depois disto. */
const ESPERA_DA_LEITURA = '20 minutes';
/** Sem as fontes, ou sem nada para relatar: a marca pode conectar ou vender até o dia 7; olha de novo depois disto. */
const SEM_O_QUE_RELATAR = '6 hours';

export type VezDoRelatorio = { brandId: string; tenantId: string; status: ResultadoDoRelatorio['status'] | 'falhou' };

/**
 * O relatório do mês (A3, I7; P24), marca por marca: reserva as marcas com as vendas conectadas cuja vez chegou,
 * com SKIP LOCKED na mesma linha que a reserva altera (`monthly_report_state`, V35), a mais atrasada primeiro. A
 * rotina em si está em `RelatorioMensalService`. Como a revisão da semana (`revisao-semanal-loop.ts`).
 */
@Injectable()
export class RelatorioMensalLoop {
  private readonly logger = new Logger('relatorio-mensal');

  constructor(
    @Inject(DATABASE) private readonly database: Database | null,
    private readonly relatorio: RelatorioMensalService,
  ) {}

  async executarLote(limite = 3, scope: JobScope = {}, agora?: Date): Promise<VezDoRelatorio[]> {
    if (!this.database) return [];
    const db = this.database.db;
    const referencia = agora ? sql`${agora.toISOString()}::timestamptz` : sql`now()`;
    const reservadas = await withSystem(db, async (tx) => {
      await tx.execute(sql`
        insert into liame.monthly_report_state (brand_id, tenant_id, next_at)
        select b.id, b.tenant_id, ${referencia}
          from liame.brand b
         where b.archived_at is null ${tenantFilter(scope, sql`b.tenant_id`)}
           and exists (select 1 from liame.connected_account a where a.brand_id = b.id and a.provider = 'regem' and a.disconnected_at is null)
           and not exists (select 1 from liame.monthly_report_state s where s.brand_id = b.id)
        on conflict (brand_id) do nothing`);
      const r = await tx.execute<{ brand_id: string; tenant_id: string }>(sql`
        with devidas as materialized (
          select s.brand_id
            from liame.monthly_report_state s
            join liame.brand b on b.id = s.brand_id
           where s.next_at <= ${referencia} and b.archived_at is null ${tenantFilter(scope, sql`s.tenant_id`)}
           order by s.next_at
           limit ${limite}
           for update of s skip locked
        )
        update liame.monthly_report_state s
           set last_attempt_at = ${referencia}, next_at = ${referencia} + ${RESERVA}::interval, updated_at = now()
          from devidas d
         where s.brand_id = d.brand_id
        returning s.brand_id, s.tenant_id`);
      return r.rows;
    });

    const vezes: VezDoRelatorio[] = [];
    for (const m of reservadas) {
      const alvo = { brandId: m.brand_id, tenantId: m.tenant_id };
      try {
        const r = await this.relatorio.gerar(alvo, agora);
        await this.fechar(m.brand_id, r, referencia);
        if (r.status === 'gerado') this.logger.log(`marca ${m.brand_id}: relatório do mês de ${r.mes} gerado (leitura: ${r.leitura})`);
        vezes.push({ ...alvo, status: r.status });
      } catch (err) {
        // Falha fora do previsto: a reserva vence e a marca volta para a fila (LIC-001).
        this.logger.error(`marca ${m.brand_id}: ${err instanceof Error ? err.message : String(err)}`);
        vezes.push({ ...alvo, status: 'falhou' });
      }
    }
    return vezes;
  }

  /** Quando a marca volta para a fila, conforme o que aconteceu na vez dela. */
  private async fechar(brandId: string, r: ResultadoDoRelatorio, referencia: SQL): Promise<void> {
    const local = sql`(${referencia} at time zone ${r.fuso})`;
    const hora = sql`make_interval(hours => ${HORA_DE_GERAR})`;
    // O próximo mês fecha no último dia deste: a vez seguinte é o dia 1º do mês que vem, na hora de gerar.
    const proximoMes = sql`((date_trunc('month', ${local}) + interval '1 month' + ${hora}) at time zone ${r.fuso})`;
    const volta: Record<ResultadoDoRelatorio['status'], SQL> = {
      gerado: proximoMes,
      ja_tem: proximoMes,
      fora_do_prazo: proximoMes,
      // É dia 1º, antes da hora: volta hoje, na hora de gerar.
      cedo: sql`((date_trunc('day', ${local}) + ${hora}) at time zone ${r.fuso})`,
      aguardando_leitura: sql`${referencia} + ${ESPERA_DA_LEITURA}::interval`,
      sem_fontes: sql`${referencia} + ${SEM_O_QUE_RELATAR}::interval`,
      sem_movimento: sql`${referencia} + ${SEM_O_QUE_RELATAR}::interval`,
      // Relatórios desligado pela empresa nesta marca (I13b): ligado de novo, a vez volta em até uma hora.
      desligado_pela_empresa: sql`${referencia} + interval '1 hour'`,
    };
    const comRelatorio = r.status === 'gerado' || r.status === 'ja_tem';
    await withSystem(this.database!.db, (tx) =>
      tx.execute(sql`
        update liame.monthly_report_state
           set last_status = ${r.status}, last_month_from = ${comRelatorio ? sql`${r.mes}::date` : sql`last_month_from`}, next_at = ${volta[r.status]}, updated_at = now()
         where brand_id = ${brandId}`),
    );
  }
}
