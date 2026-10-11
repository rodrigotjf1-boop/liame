import { type Database, withSystem } from '@liame/database';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import {
  DATASET_AVALIACOES,
  DATASET_NUMEROS,
  DATASETS_DO_PERFIL,
  type DatasetDoPerfil,
  INTERVALO_DO_PERFIL_MIN,
  type ResultadoDoPerfil,
  SincronizadorDoPerfil,
} from '../avaliacoes/sincronizador-do-perfil.js';
import { APP_CONFIG, type AppConfig } from '../config.js';
import { PROVEDOR_PERFIL_GOOGLE } from '../connectors/google-business/perfil-google.js';
import { DATABASE } from '../database/database.module.js';
import { FlagService } from '../flags/flag.service.js';
import { VaultService } from '../vault/vault.service.js';
import { type JobScope, tenantFilter } from './outbox-publisher.js';

/** Reserva da leitura: se o worker cair no meio, ela volta para a fila depois disto. */
const RESERVA_MIN = 30;

/**
 * Leitura das lojas do Perfil da Empresa no Google (A6, Z1): as avaliações (a cada hora) e os números do perfil (uma
 * vez por dia), cada conjunto com a fila dele. Reserva as leituras devidas com SKIP LOCKED na MESMA linha que a
 * reserva altera (o `sync_state` do conjunto, ERR-029), a mais atrasada primeiro, de qualquer empresa. Fica no worker
 * porque reserva em escopo de sistema (V53); a leitura em si roda na empresa, e é ela que confere a função
 * `perfil_google`: a loja da empresa com a função desligada sai da fila por um dia (V106).
 */
@Injectable()
export class PerfilLoop {
  private readonly logger = new Logger('perfil-google');

  constructor(
    @Inject(DATABASE) private readonly database: Database | null,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly vault: VaultService,
    private readonly flags: FlagService,
  ) {}

  async executarLote(limite = 3, scope: JobScope = {}, agora: Date = new Date()): Promise<ResultadoDoPerfil[]> {
    if (!this.database) return [];
    const db = this.database.db;
    // O relógio de quem chama vale para a fila inteira: a reserva e o que a leitura grava (V34).
    const referencia = sql`${agora.toISOString()}::timestamptz`;
    const conjuntos = [...DATASETS_DO_PERFIL];
    const elegivel = sql`a.provider = ${PROVEDOR_PERFIL_GOOGLE} and a.disconnected_at is null and a.status in ('ativa', 'erro', 'sem_permissao') and a.credential_secret_id is not null`;
    const reservadas = await withSystem(db, async (tx) => {
      // A loja ligada ganha a linha de cada conjunto, devida desde já.
      await tx.execute(sql`
        insert into liame.sync_state (connected_account_id, dataset, tenant_id, expected_every_minutes, cursor)
        select a.id, d.dataset, a.tenant_id, d.cada, '{}'::jsonb
          from liame.connected_account a
          cross join (values (${DATASET_AVALIACOES}, ${INTERVALO_DO_PERFIL_MIN[DATASET_AVALIACOES]}::integer),
                             (${DATASET_NUMEROS}, ${INTERVALO_DO_PERFIL_MIN[DATASET_NUMEROS]}::integer)) as d (dataset, cada)
         where ${elegivel} ${tenantFilter(scope, sql`a.tenant_id`)}
           and not exists (select 1 from liame.sync_state s where s.connected_account_id = a.id and s.dataset = d.dataset)
        on conflict (connected_account_id, dataset) do nothing`);
      const r = await tx.execute<{ id: string; tenant_id: string; dataset: DatasetDoPerfil }>(sql`
        with devidas as materialized (
          select s.connected_account_id, s.dataset
            from liame.sync_state s
            join liame.connected_account a on a.id = s.connected_account_id
           where s.dataset in ${conjuntos} and ${elegivel}
             and coalesce((s.cursor->>'proxima')::timestamptz, '-infinity'::timestamptz) <= ${referencia}
             ${tenantFilter(scope, sql`a.tenant_id`)}
           order by coalesce((s.cursor->>'proxima')::timestamptz, '-infinity'::timestamptz), s.connected_account_id, s.dataset
           limit ${limite}
           for update of s skip locked
        )
        update liame.sync_state s
           set cursor = s.cursor || jsonb_build_object('proxima', ${referencia} + make_interval(mins => ${RESERVA_MIN})), updated_at = ${referencia}
          from devidas d
         where s.connected_account_id = d.connected_account_id and s.dataset = d.dataset
        returning s.connected_account_id as id, s.tenant_id, s.dataset`);
      return r.rows;
    });
    const sincronizador = new SincronizadorDoPerfil(db, this.vault, this.config, this.flags);
    const resultados: ResultadoDoPerfil[] = [];
    for (const c of reservadas) {
      try {
        resultados.push(await sincronizador.sincronizar(c.id, c.tenant_id, c.dataset, agora));
      } catch (err) {
        // Falha fora do previsto (banco): a reserva vence e a leitura volta para a fila (LIC-001).
        this.logger.error(`conta ${c.id} (${c.dataset}): ${err instanceof Error ? err.message : String(err)}`);
        resultados.push({ dataset: c.dataset, status: 'falhou', erro: 'erro interno' });
      }
    }
    return resultados;
  }
}
