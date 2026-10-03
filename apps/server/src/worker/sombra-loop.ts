import { type Database, withSystem } from '@liame/database';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { desligadoPelaEmpresa } from '../ai/registro/ativacao.js';
import { DATABASE } from '../database/database.module.js';
import { GESTOR_DE_TRAFEGO } from '../equipe/membros.js';
import { FlagService } from '../flags/flag.service.js';
import { type ResultadoDaSombra, SombraService } from './sombra.service.js';
import { type JobScope, tenantFilter } from './outbox-publisher.js';

/** Reserva da marca: se o worker cair no meio, ela volta para a fila depois disto. */
const RESERVA = '30 minutes';
/** Quando a marca volta, conforme o que aconteceu na vez dela. */
const VOLTA: Record<ResultadoDaSombra['status'] | 'desligada' | 'desligada_pela_empresa', string> = {
  feito: '3 hours',
  ja_rodou: '3 hours',
  // A leitura da manhã ainda não chegou (ou uma fonte está parada): tenta de novo em uma hora.
  dado_velho: '1 hour',
  desligada: '6 hours',
  // A empresa desligou o Gestor de tráfego nesta marca (I13b): ligado de novo, a vez volta em até uma hora.
  desligada_pela_empresa: '1 hour',
};

export type VezDaSombra = { brandId: string; tenantId: string; status: ResultadoDaSombra['status'] | 'desligada' | 'desligada_pela_empresa' | 'falhou' };

/**
 * A sombra de verdade (A3, I5), marca por marca: reserva as marcas com conta de anúncio cuja vez chegou,
 * com SKIP LOCKED na mesma linha que a reserva altera (`shadow_state`, V35), a mais atrasada primeiro.
 * Só roda para a empresa com a flag `sombra` ligada e com o Gestor de tráfego ligado na marca (a empresa pode
 * desligá-lo, I13b); a rotina em si está em `SombraService`.
 */
@Injectable()
export class SombraLoop {
  private readonly logger = new Logger('sombra');

  constructor(
    @Inject(DATABASE) private readonly database: Database | null,
    private readonly flags: FlagService,
    private readonly sombra: SombraService,
  ) {}

  async executarLote(limite = 3, scope: JobScope = {}, agora?: Date): Promise<VezDaSombra[]> {
    if (!this.database) return [];
    const db = this.database.db;
    const referencia = agora ? sql`${agora.toISOString()}::timestamptz` : sql`now()`;
    const reservadas = await withSystem(db, async (tx) => {
      await tx.execute(sql`
        insert into liame.shadow_state (brand_id, tenant_id, next_at)
        select b.id, b.tenant_id, ${referencia}
          from liame.brand b
         where b.archived_at is null ${tenantFilter(scope, sql`b.tenant_id`)}
           and exists (select 1 from liame.connected_account a
                        where a.brand_id = b.id and a.provider in ('meta_ads', 'google_ads') and a.disconnected_at is null)
           and not exists (select 1 from liame.shadow_state s where s.brand_id = b.id)
        on conflict (brand_id) do nothing`);
      const r = await tx.execute<{ brand_id: string; tenant_id: string; last_run_on: string | null }>(sql`
        with devidas as materialized (
          select s.brand_id
            from liame.shadow_state s
            join liame.brand b on b.id = s.brand_id
           where s.next_at <= ${referencia} and b.archived_at is null ${tenantFilter(scope, sql`s.tenant_id`)}
           order by s.next_at
           limit ${limite}
           for update of s skip locked
        )
        update liame.shadow_state s
           set last_attempt_at = ${referencia}, next_at = ${referencia} + ${RESERVA}::interval, updated_at = now()
          from devidas d
         where s.brand_id = d.brand_id
        returning s.brand_id, s.tenant_id, s.last_run_on::text as last_run_on`);
      return r.rows;
    });

    const vezes: VezDaSombra[] = [];
    for (const m of reservadas) {
      const alvo = { brandId: m.brand_id, tenantId: m.tenant_id };
      try {
        if (!(await this.flags.isEnabled('sombra', this.flags.context({ tenantId: m.tenant_id })))) {
          await this.fechar(m.brand_id, 'desligada', null, referencia);
          vezes.push({ ...alvo, status: 'desligada' });
          continue;
        }
        if (await withSystem(db, (tx) => desligadoPelaEmpresa(tx, { tenantId: m.tenant_id, brandId: m.brand_id, agentKey: GESTOR_DE_TRAFEGO }))) {
          await this.fechar(m.brand_id, 'desligada_pela_empresa', null, referencia);
          vezes.push({ ...alvo, status: 'desligada_pela_empresa' });
          continue;
        }
        const r = await this.sombra.rodarMarca({ ...alvo, ultimoDia: m.last_run_on }, agora);
        await this.fechar(m.brand_id, r.status, r.status === 'feito' ? r.dia : null, referencia);
        if (r.status === 'feito' && (r.novas || r.avaliadas || r.observadas || r.descartadas)) {
          this.logger.log(`marca ${m.brand_id}: ${r.novas} nova(s), ${r.observadas} com ação da pessoa, ${r.avaliadas} avaliada(s), ${r.descartadas} descartada(s)`);
        }
        vezes.push({ ...alvo, status: r.status });
      } catch (err) {
        // Falha fora do previsto: a reserva vence e a marca volta para a fila (LIC-001).
        this.logger.error(`marca ${m.brand_id}: ${err instanceof Error ? err.message : String(err)}`);
        vezes.push({ ...alvo, status: 'falhou' });
      }
    }
    return vezes;
  }

  private async fechar(brandId: string, status: keyof typeof VOLTA, dia: string | null, referencia: ReturnType<typeof sql>): Promise<void> {
    await withSystem(this.database!.db, (tx) =>
      tx.execute(sql`
        update liame.shadow_state
           set last_status = ${status}, last_run_on = coalesce(${dia}::date, last_run_on), next_at = ${referencia} + ${VOLTA[status]}::interval, updated_at = now()
         where brand_id = ${brandId}`),
    );
  }
}
