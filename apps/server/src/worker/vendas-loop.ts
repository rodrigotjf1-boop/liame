import { type Database, type Tx, withSystem } from '@liame/database';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { APP_CONFIG, type AppConfig } from '../config.js';
import { DATABASE } from '../database/database.module.js';
import { apagarClientesDaOrigem } from '../orders/order-store.js';
import { type ApagarAnonimizados, INTERVALO_VENDAS_MIN, type ResultadoVendas, SincronizadorVendas } from '../orders/sincronizador-vendas.js';
import { VaultService } from '../vault/vault.service.js';
import type { InboxRow } from './inbox-processor.js';
import { type JobScope, tenantFilter } from './outbox-publisher.js';

/** Reserva da loja: se o worker cair no meio, ela volta para a fila depois disto. */
const RESERVA = '30 minutes';

/**
 * Leitura das vendas das lojas do Regem (A2.5, F4). Reserva as lojas devidas com SKIP LOCKED na MESMA
 * linha que a reserva altera (sync_state de `pedidos`, ERR-029), a mais atrasada primeiro, de qualquer
 * empresa; uma leitura por loja por vez.
 */
@Injectable()
export class VendasLoop {
  private readonly logger = new Logger('vendas');

  constructor(
    @Inject(DATABASE) private readonly database: Database | null,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly vault: VaultService,
  ) {}

  async executarLote(limite = 3, scope: JobScope = {}, agora?: Date): Promise<ResultadoVendas[]> {
    if (!this.database) return [];
    const db = this.database.db;
    const referencia = agora ? sql`${agora.toISOString()}::timestamptz` : sql`now()`;
    const elegivel = sql`a.provider = 'regem' and a.disconnected_at is null and a.status in ('ativa', 'erro') and a.credential_secret_id is not null`;
    const reservadas = await withSystem(db, async (tx) => {
      await tx.execute(sql`
        insert into liame.sync_state (connected_account_id, dataset, tenant_id, expected_every_minutes, cursor)
        select a.id, 'pedidos', a.tenant_id, ${INTERVALO_VENDAS_MIN}, '{}'::jsonb
          from liame.connected_account a
         where ${elegivel} ${tenantFilter(scope, sql`a.tenant_id`)}
           and not exists (select 1 from liame.sync_state s where s.connected_account_id = a.id and s.dataset = 'pedidos')
        on conflict (connected_account_id, dataset) do nothing`);
      const r = await tx.execute<{ id: string; tenant_id: string }>(sql`
        with devidas as materialized (
          select s.connected_account_id
            from liame.sync_state s
            join liame.connected_account a on a.id = s.connected_account_id
           where s.dataset = 'pedidos' and ${elegivel}
             and coalesce((s.cursor->>'proxima')::timestamptz, '-infinity'::timestamptz) <= ${referencia}
             ${tenantFilter(scope, sql`a.tenant_id`)}
           order by coalesce((s.cursor->>'proxima')::timestamptz, '-infinity'::timestamptz)
           limit ${limite}
           for update of s skip locked
        )
        update liame.sync_state s
           set last_attempt_at = now(), cursor = s.cursor || jsonb_build_object('proxima', ${referencia} + ${RESERVA}::interval), updated_at = now()
          from devidas d
         where s.connected_account_id = d.connected_account_id and s.dataset = 'pedidos'
        returning s.connected_account_id as id, s.tenant_id`);
      return r.rows;
    });
    const sincronizador = new SincronizadorVendas(db, this.vault, this.config, apagarAnonimizadosNoSistema(db));
    const resultados: ResultadoVendas[] = [];
    for (const c of reservadas) {
      try {
        resultados.push(await sincronizador.sincronizar(c.id, c.tenant_id, agora));
      } catch (err) {
        // Falha fora do previsto (banco): a reserva vence e a loja volta para a fila (LIC-001).
        this.logger.error(`loja ${c.id}: ${err instanceof Error ? err.message : String(err)}`);
        resultados.push({ status: 'falhou', erro: 'erro interno' });
      }
    }
    return resultados;
  }
}

/**
 * Cliente anonimizado na origem: apaga o cliente pseudonimizado no escopo de sistema, com a empresa e a
 * conta explícitas em cada instrução (o escopo de sistema enxerga além da empresa).
 */
export function apagarAnonimizadosNoSistema(db: Database['db']): ApagarAnonimizados {
  return (alvo) => withSystem(db, (tx) => apagarClientesDaOrigem(tx, alvo));
}

/**
 * Evento do Regem (webhook por conexão): só gatilho de frescor. As lojas da conexão ficam devidas agora
 * e a próxima volta do laço lê pelo cursor (ADR-019 item 5).
 */
export async function eventoDoRegem(tx: Tx, evento: InboxRow): Promise<void> {
  if (!evento.connection_id) return;
  await tx.execute(sql`
    update liame.sync_state s
       set cursor = s.cursor || jsonb_build_object('proxima', now()), updated_at = now()
      from liame.connected_account a
     where a.connection_id = ${evento.connection_id} and a.provider = 'regem' and a.disconnected_at is null
       and s.connected_account_id = a.id and s.dataset = 'pedidos'
       and coalesce((s.cursor->>'proxima')::timestamptz, '-infinity'::timestamptz) > now()`);
}
