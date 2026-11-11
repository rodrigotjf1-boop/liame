import { type Database, withSystem } from '@liame/database';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { APP_CONFIG, type AppConfig } from '../config.js';
import { contaConectada } from '../connections/conectada.js';
import { ClienteConector } from '../connectors/cliente-http.js';
import { enderecosDasPlataformas } from '../connectors/enderecos.js';
import { PROVEDOR_INSTAGRAM, PROVEDOR_PAGINA } from '../connectors/meta/publicacao.js';
import { versaoRegistrada } from '../connectors/tipos.js';
import { DATABASE } from '../database/database.module.js';
import { DATASET_DO_DIRECT, FLAG_DO_DIRECT, FLAG_DO_MESSENGER, INTERVALO_DO_DIRECT_MIN } from '../direct/direct.js';
import { type ResultadoDoDirect, SincronizadorDoDirect } from '../direct/sincronizador-do-direct.js';
import { FlagService } from '../flags/flag.service.js';
import { VaultService } from '../vault/vault.service.js';
import { type JobScope, tenantFilter } from './outbox-publisher.js';

/** Reserva da leitura: se o worker cair no meio, ela volta para a fila depois disto. */
const RESERVA_MIN = 5;

/**
 * Direct do Instagram (A6, Z12, parte 1; P39, D-A6-108): a leitura das conversas de cada conta do Instagram ligada a uma
 * marca, a cada minuto. Reserva as leituras devidas com SKIP LOCKED na MESMA linha que a reserva altera (o `sync_state`
 * do conjunto, ERR-029), a mais atrasada primeiro, de qualquer empresa. Fica no worker porque reserva em escopo de
 * sistema (V53); a leitura em si roda na empresa, e é ela que confere a função `direct`, o Direct ligado na marca e o
 * Regem (D-A6-107): a conta desligada sai da fila por um dia (V106). A conta desligada leva junto o que foi lido dela.
 */
@Injectable()
export class DirectLoop {
  private readonly logger = new Logger('direct');
  private sincronizador: SincronizadorDoDirect | null = null;

  constructor(
    @Inject(DATABASE) private readonly database: Database | null,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly vault: VaultService,
    private readonly flags: FlagService,
  ) {}

  async executarLote(limite = 10, scope: JobScope = {}, agora: Date = new Date()): Promise<ResultadoDoDirect[]> {
    const database = this.database;
    if (!database) return [];
    const db = database.db;
    // O relógio de quem chama vale para a fila inteira: a reserva e o que a leitura grava (V34).
    const referencia = sql`${agora.toISOString()}::timestamptz`;
    // O Instagram (o Direct) e a Página (o Messenger, A6, Z14): cada conta com a sua linha no conjunto.
    const elegivel = sql`a.provider in (${PROVEDOR_INSTAGRAM}, ${PROVEDOR_PAGINA}) and ${contaConectada('a')} and a.credential_secret_id is not null`;
    const reservadas = await withSystem(db, async (tx) => {
      // A conta desligada leva junto o que foi lido dela (as mensagens saem com a conversa, em cascata).
      await tx.execute(sql`
        delete from liame.direct_conversation c
         using liame.connected_account a
         where a.id = c.connected_account_id and not coalesce(${contaConectada('a')}, false) ${tenantFilter(scope, sql`c.tenant_id`)}`);
      // A conta ligada ganha a linha do conjunto, devida desde já.
      await tx.execute(sql`
        insert into liame.sync_state (connected_account_id, dataset, tenant_id, expected_every_minutes, cursor)
        select a.id, ${DATASET_DO_DIRECT}, a.tenant_id, ${INTERVALO_DO_DIRECT_MIN}::integer, '{}'::jsonb
          from liame.connected_account a
         where ${elegivel} ${tenantFilter(scope, sql`a.tenant_id`)}
           and not exists (select 1 from liame.sync_state s where s.connected_account_id = a.id and s.dataset = ${DATASET_DO_DIRECT})
        on conflict (connected_account_id, dataset) do nothing`);
      const r = await tx.execute<{ id: string; tenant_id: string }>(sql`
        with devidas as materialized (
          select s.connected_account_id
            from liame.sync_state s
            join liame.connected_account a on a.id = s.connected_account_id
           where s.dataset = ${DATASET_DO_DIRECT} and ${elegivel}
             and coalesce((s.cursor->>'proxima')::timestamptz, '-infinity'::timestamptz) <= ${referencia}
             ${tenantFilter(scope, sql`a.tenant_id`)}
           order by coalesce((s.cursor->>'proxima')::timestamptz, '-infinity'::timestamptz), s.connected_account_id
           limit ${limite}
           for update of s skip locked
        )
        update liame.sync_state s
           set cursor = s.cursor || jsonb_build_object('proxima', ${referencia} + make_interval(mins => ${RESERVA_MIN}), 'lendo', ${referencia}),
               updated_at = ${referencia}
          from devidas d
         where s.connected_account_id = d.connected_account_id and s.dataset = ${DATASET_DO_DIRECT}
        returning s.connected_account_id as id, s.tenant_id`);
      return r.rows;
    });
    this.sincronizador ??= new SincronizadorDoDirect(database, {
      lerSegredo: (tx, secretId) => this.vault.readSecret(tx, secretId),
      // Uma tentativa por chamada: a leitura que falha volta para a fila pela espera do tipo da falha.
      cliente: () => new ClienteConector(db, { enderecos: enderecosDasPlataformas(this.config.plataformas, this.config.produtos), tentativas: 1 }),
      graphUrl: this.config.plataformas.metaGraphUrl,
      appSecret: this.config.plataformas.metaAppSecret,
      versao: (capacidade) => versaoRegistrada(db, 'meta_ads', capacidade),
      ligada: (tenantId, brandId, canal) => this.flags.isEnabled(canal === 'messenger' ? FLAG_DO_MESSENGER : FLAG_DO_DIRECT, this.flags.context({ tenantId, brandId })),
      config: this.config,
    });
    const resultados: ResultadoDoDirect[] = [];
    for (const c of reservadas) {
      try {
        resultados.push(await this.sincronizador.sincronizar(c.id, c.tenant_id, agora));
      } catch (err) {
        // Falha fora do previsto (banco): a reserva vence e a leitura volta para a fila (LIC-001).
        this.logger.error(`conta ${c.id}: ${err instanceof Error ? err.message : String(err)}`);
        resultados.push({ conta: c.id, status: 'falhou', erro: 'erro interno' });
      }
    }
    return resultados;
  }
}
