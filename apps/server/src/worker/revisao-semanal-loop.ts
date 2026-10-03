import { type Database, withSystem } from '@liame/database';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { type SQL, sql } from 'drizzle-orm';
import { DATABASE } from '../database/database.module.js';
import { HORA_DE_GERAR } from '../results/revisao-semanal.js';
import { type JobScope, tenantFilter } from './outbox-publisher.js';
import { type ResultadoDaRevisao, type ResultadoDoEnvio, RevisaoSemanalService } from './revisao-semanal.service.js';

/** Reserva da marca (ou do envio): se o worker cair no meio, ela volta para a fila depois disto. */
const RESERVA = '30 minutes';
/** A leitura da manhã ainda não chegou: olha de novo depois disto. */
const ESPERA_DA_LEITURA = '20 minutes';
/** Sem as fontes, ou sem nada para revisar: a marca pode conectar ou vender; olha de novo depois disto. */
const SEM_O_QUE_REVISAR = '6 hours';

export type VezDaRevisao = { brandId: string; tenantId: string; status: ResultadoDaRevisao['status'] | 'falhou' };
export type VezDoEnvio = { reviewId: string; status: ResultadoDoEnvio['status'] | 'falhou'; enviados: number };

/**
 * A revisão da semana (A3, I7), marca por marca: reserva as marcas com as vendas conectadas cuja vez
 * chegou, com SKIP LOCKED na mesma linha que a reserva altera (`weekly_review_state`, V35), a mais atrasada
 * primeiro. A rotina em si está em `RevisaoSemanalService`. O envio por e-mail é um segundo laço, sobre as
 * revisões que esperam envio.
 */
@Injectable()
export class RevisaoSemanalLoop {
  private readonly logger = new Logger('revisao-semanal');

  constructor(
    @Inject(DATABASE) private readonly database: Database | null,
    private readonly revisao: RevisaoSemanalService,
  ) {}

  async executarLote(limite = 3, scope: JobScope = {}, agora?: Date): Promise<VezDaRevisao[]> {
    if (!this.database) return [];
    const db = this.database.db;
    const referencia = agora ? sql`${agora.toISOString()}::timestamptz` : sql`now()`;
    const reservadas = await withSystem(db, async (tx) => {
      await tx.execute(sql`
        insert into liame.weekly_review_state (brand_id, tenant_id, next_at)
        select b.id, b.tenant_id, ${referencia}
          from liame.brand b
         where b.archived_at is null ${tenantFilter(scope, sql`b.tenant_id`)}
           and exists (select 1 from liame.connected_account a where a.brand_id = b.id and a.provider = 'regem' and a.disconnected_at is null)
           and not exists (select 1 from liame.weekly_review_state s where s.brand_id = b.id)
        on conflict (brand_id) do nothing`);
      const r = await tx.execute<{ brand_id: string; tenant_id: string }>(sql`
        with devidas as materialized (
          select s.brand_id
            from liame.weekly_review_state s
            join liame.brand b on b.id = s.brand_id
           where s.next_at <= ${referencia} and b.archived_at is null ${tenantFilter(scope, sql`s.tenant_id`)}
           order by s.next_at
           limit ${limite}
           for update of s skip locked
        )
        update liame.weekly_review_state s
           set last_attempt_at = ${referencia}, next_at = ${referencia} + ${RESERVA}::interval, updated_at = now()
          from devidas d
         where s.brand_id = d.brand_id
        returning s.brand_id, s.tenant_id`);
      return r.rows;
    });

    const vezes: VezDaRevisao[] = [];
    for (const m of reservadas) {
      const alvo = { brandId: m.brand_id, tenantId: m.tenant_id };
      try {
        const r = await this.revisao.gerar(alvo, agora);
        await this.fechar(m.brand_id, r, referencia);
        if (r.status === 'gerada') this.logger.log(`marca ${m.brand_id}: revisão da semana de ${r.semana} gerada (leitura: ${r.leitura})`);
        vezes.push({ ...alvo, status: r.status });
      } catch (err) {
        // Falha fora do previsto: a reserva vence e a marca volta para a fila (LIC-001).
        this.logger.error(`marca ${m.brand_id}: ${err instanceof Error ? err.message : String(err)}`);
        vezes.push({ ...alvo, status: 'falhou' });
      }
    }
    return vezes;
  }

  /** As revisões que esperam o envio por e-mail e cuja hora chegou. */
  async enviarLote(limite = 3, scope: JobScope = {}, agora?: Date): Promise<VezDoEnvio[]> {
    if (!this.database) return [];
    const referencia = agora ? sql`${agora.toISOString()}::timestamptz` : sql`now()`;
    const reservadas = await withSystem(this.database.db, async (tx) => {
      const r = await tx.execute<{ id: string }>(sql`
        with devidas as materialized (
          select w.id
            from liame.weekly_review w
           where w.email_status = 'pendente' and w.email_next_at <= ${referencia} ${tenantFilter(scope, sql`w.tenant_id`)}
           order by w.email_next_at
           limit ${limite}
           for update of w skip locked
        )
        update liame.weekly_review w
           set email_next_at = ${referencia} + ${RESERVA}::interval, updated_at = now()
          from devidas d
         where w.id = d.id
        returning w.id`);
      return r.rows;
    });

    const vezes: VezDoEnvio[] = [];
    for (const { id } of reservadas) {
      try {
        const r = await this.revisao.enviar(id, agora);
        if (r.enviados) this.logger.log(`revisão ${id}: enviada a ${r.enviados} pessoa(s) (${r.status})`);
        vezes.push({ reviewId: id, ...r });
      } catch (err) {
        this.logger.error(`revisão ${id}: ${err instanceof Error ? err.message : String(err)}`);
        vezes.push({ reviewId: id, status: 'falhou', enviados: 0 });
      }
    }
    return vezes;
  }

  /** Quando a marca volta para a fila, conforme o que aconteceu na vez dela. */
  private async fechar(brandId: string, r: ResultadoDaRevisao, referencia: SQL): Promise<void> {
    const local = sql`(${referencia} at time zone ${r.fuso})`;
    const hora = sql`make_interval(hours => ${HORA_DE_GERAR})`;
    const volta: Record<ResultadoDaRevisao['status'], SQL> = {
      // A próxima semana fecha no domingo: a vez seguinte é a segunda-feira que vem, na hora de gerar.
      gerada: sql`((date_trunc('week', ${local}) + interval '7 days' + ${hora}) at time zone ${r.fuso})`,
      ja_tem: sql`((date_trunc('week', ${local}) + interval '7 days' + ${hora}) at time zone ${r.fuso})`,
      // É segunda-feira, antes da hora: volta hoje, na hora de gerar.
      cedo: sql`((date_trunc('day', ${local}) + ${hora}) at time zone ${r.fuso})`,
      aguardando_leitura: sql`${referencia} + ${ESPERA_DA_LEITURA}::interval`,
      sem_fontes: sql`${referencia} + ${SEM_O_QUE_REVISAR}::interval`,
      sem_movimento: sql`${referencia} + ${SEM_O_QUE_REVISAR}::interval`,
      // Relatórios desligado pela empresa nesta marca (I13b): ligado de novo, a vez volta em até uma hora.
      desligada_pela_empresa: sql`${referencia} + interval '1 hour'`,
    };
    const comRevisao = r.status === 'gerada' || r.status === 'ja_tem';
    await withSystem(this.database!.db, (tx) =>
      tx.execute(sql`
        update liame.weekly_review_state
           set last_status = ${r.status}, last_week_from = ${comRevisao ? sql`${r.semana}::date` : sql`last_week_from`}, next_at = ${volta[r.status]}, updated_at = now()
         where brand_id = ${brandId}`),
    );
  }
}
