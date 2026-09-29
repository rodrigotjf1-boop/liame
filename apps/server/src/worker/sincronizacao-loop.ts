import { type Database, withSystem } from '@liame/database';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { APP_CONFIG, type AppConfig } from '../config.js';
import { DATABASE } from '../database/database.module.js';
import { INTERVALO_MIN, type ResultadoSincronizacao, Sincronizador } from '../media/sincronizador.js';
import { VaultService } from '../vault/vault.service.js';
import { type JobScope, tenantFilter } from './outbox-publisher.js';

/** Quanto a reserva de uma conta vale: se o worker cair no meio, outra execução pega depois disto. */
const RESERVA = '2 hours';

/**
 * Laço da sincronização (A2, G7): reserva as contas devidas (a próxima execução já passou) com SKIP
 * LOCKED, uma conta por vez por worker, e sincroniza. Várias instâncias do worker dividem a fila sem
 * pegar a mesma conta; a mais atrasada vai primeiro, de qualquer empresa (ninguém fura a fila).
 */
@Injectable()
export class SincronizacaoLoop {
  private readonly logger = new Logger('sincronizacao');

  constructor(
    @Inject(DATABASE) private readonly database: Database | null,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly vault: VaultService,
  ) {}

  async executarLote(limite = 3, scope: JobScope = {}, agora?: Date): Promise<ResultadoSincronizacao[]> {
    if (!this.database) return [];
    const db = this.database.db;
    // Relógio da reserva: o do banco, ou o informado (testes e reprocessamento) — o mesmo do sincronizador.
    const referencia = agora ? sql`${agora.toISOString()}::timestamptz` : sql`now()`;
    // Só as plataformas de anúncio: as lojas do Regem e as contas do RegemCast têm a leitura de vendas (A2.5).
    const elegivel = sql`a.disconnected_at is null and a.status in ('ativa', 'erro', 'sem_permissao') and a.credential_secret_id is not null
                         and a.provider in ('meta_ads', 'google_ads', 'ga4')`;
    const reservadas = await withSystem(db, async (tx) => {
      // Conta nova ganha a linha de estado (devida desde sempre) antes da reserva.
      await tx.execute(sql`
        insert into liame.sync_state (connected_account_id, dataset, tenant_id, expected_every_minutes, cursor)
        select a.id, 'metricas', a.tenant_id, ${INTERVALO_MIN}, '{}'::jsonb
          from liame.connected_account a
         where ${elegivel} ${tenantFilter(scope, sql`a.tenant_id`)}
           and not exists (select 1 from liame.sync_state s where s.connected_account_id = a.id and s.dataset = 'metricas')
        on conflict (connected_account_id, dataset) do nothing`);
      // A trava é na MESMA linha que a reserva muda (sync_state): quem chegar depois, com a foto antiga,
      // tem a condição reconferida na versão nova e não pega a conta de novo (ERR-029). CTE materializada
      // para o LIMIT valer uma vez só (LIC-069).
      const r = await tx.execute<{ id: string; tenant_id: string }>(sql`
        with devidas as materialized (
          select s.connected_account_id
            from liame.sync_state s
            join liame.connected_account a on a.id = s.connected_account_id
           where s.dataset = 'metricas' and ${elegivel}
             and coalesce((s.cursor->>'proxima')::timestamptz, '-infinity'::timestamptz) <= ${referencia}
             ${tenantFilter(scope, sql`a.tenant_id`)}
           order by coalesce((s.cursor->>'proxima')::timestamptz, '-infinity'::timestamptz)
           limit ${limite}
           for update of s skip locked
        )
        update liame.sync_state s
           set last_attempt_at = now(), cursor = s.cursor || jsonb_build_object('proxima', ${referencia} + ${RESERVA}::interval), updated_at = now()
          from devidas d
         where s.connected_account_id = d.connected_account_id and s.dataset = 'metricas'
        returning s.connected_account_id as id, s.tenant_id`);
      return r.rows;
    });
    const sincronizador = new Sincronizador(db, this.vault, this.config);
    const resultados: ResultadoSincronizacao[] = [];
    for (const c of reservadas) {
      try {
        resultados.push(await sincronizador.sincronizar(c.id, c.tenant_id, agora));
      } catch (err) {
        // Falha fora do previsto (banco): a reserva vence e a conta volta para a fila (LIC-001).
        this.logger.error(`conta ${c.id}: ${err instanceof Error ? err.message : String(err)}`);
        resultados.push({ status: 'falhou', erro: 'erro interno' });
      }
    }
    return resultados;
  }
}
