import { type Database, withSystem } from '@liame/database';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { APP_CONFIG, type AppConfig } from '../config.js';
import { contaConectada } from '../connections/conectada.js';
import { ClienteConector } from '../connectors/cliente-http.js';
import { enderecosDasPlataformas } from '../connectors/enderecos.js';
import { PROVEDOR_INSTAGRAM } from '../connectors/meta/publicacao.js';
import { versaoRegistrada } from '../connectors/tipos.js';
import { DATABASE } from '../database/database.module.js';
import { FlagService } from '../flags/flag.service.js';
import { DATASET_DO_INSTAGRAM, INTERVALO_DO_INSTAGRAM_MIN } from '../fotos/do-seu-instagram.js';
import { FLAG_FOTOS, FLAG_VIDEOS } from '../fotos/fotos.service.js';
import { type ResultadoDoInstagram, SincronizadorDoInstagram } from '../fotos/sincronizador-do-instagram.js';
import { VaultService } from '../vault/vault.service.js';
import { type JobScope, tenantFilter } from './outbox-publisher.js';

/** Reserva da leitura: se o worker cair no meio, ela volta para a fila depois disto. */
const RESERVA_MIN = 30;

/**
 * "Do seu Instagram" (A6, Z10, parte 5; D-A6-71 e D-A6-83): a leitura das publicações de cada conta do Instagram
 * ligada a uma marca, uma vez por dia. Reserva as leituras devidas com SKIP LOCKED na MESMA linha que a reserva altera
 * (o `sync_state` do conjunto, ERR-029), a mais atrasada primeiro, de qualquer empresa. Fica no worker porque reserva
 * em escopo de sistema (V53); a leitura em si roda na empresa, e é ela que confere as funções `fotos` e `videos`: a
 * conta da empresa com uma delas desligada sai da fila por um dia (V106).
 */
@Injectable()
export class DoSeuInstagramLoop {
  private readonly logger = new Logger('do-seu-instagram');
  private sincronizador: SincronizadorDoInstagram | null = null;

  constructor(
    @Inject(DATABASE) private readonly database: Database | null,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly vault: VaultService,
    private readonly flags: FlagService,
  ) {}

  async executarLote(limite = 3, scope: JobScope = {}, agora: Date = new Date()): Promise<ResultadoDoInstagram[]> {
    const database = this.database;
    if (!database) return [];
    const db = database.db;
    // O relógio de quem chama vale para a fila inteira: a reserva e o que a leitura grava (V34).
    const referencia = sql`${agora.toISOString()}::timestamptz`;
    const elegivel = sql`a.provider = ${PROVEDOR_INSTAGRAM} and ${contaConectada('a')} and a.credential_secret_id is not null`;
    const reservadas = await withSystem(db, async (tx) => {
      // A conta desligada leva junto o que foi lido dela: a guarda é "com a conta conectada" (`data-classes.ts`).
      await tx.execute(sql`
        delete from liame.instagram_media m
         using liame.connected_account a
         where a.id = m.connected_account_id and not coalesce(${contaConectada('a')}, false) ${tenantFilter(scope, sql`m.tenant_id`)}`);
      // A conta ligada ganha a linha do conjunto, devida desde já.
      await tx.execute(sql`
        insert into liame.sync_state (connected_account_id, dataset, tenant_id, expected_every_minutes, cursor)
        select a.id, ${DATASET_DO_INSTAGRAM}, a.tenant_id, ${INTERVALO_DO_INSTAGRAM_MIN}::integer, '{}'::jsonb
          from liame.connected_account a
         where ${elegivel} ${tenantFilter(scope, sql`a.tenant_id`)}
           and not exists (select 1 from liame.sync_state s where s.connected_account_id = a.id and s.dataset = ${DATASET_DO_INSTAGRAM})
        on conflict (connected_account_id, dataset) do nothing`);
      const r = await tx.execute<{ id: string; tenant_id: string }>(sql`
        with devidas as materialized (
          select s.connected_account_id
            from liame.sync_state s
            join liame.connected_account a on a.id = s.connected_account_id
           where s.dataset = ${DATASET_DO_INSTAGRAM} and ${elegivel}
             and coalesce((s.cursor->>'proxima')::timestamptz, '-infinity'::timestamptz) <= ${referencia}
             ${tenantFilter(scope, sql`a.tenant_id`)}
           order by coalesce((s.cursor->>'proxima')::timestamptz, '-infinity'::timestamptz), s.connected_account_id
           limit ${limite}
           for update of s skip locked
        )
        update liame.sync_state s
           set cursor = s.cursor || jsonb_build_object('proxima', ${referencia} + make_interval(mins => ${RESERVA_MIN})), updated_at = ${referencia}
          from devidas d
         where s.connected_account_id = d.connected_account_id and s.dataset = ${DATASET_DO_INSTAGRAM}
        returning s.connected_account_id as id, s.tenant_id`);
      return r.rows;
    });
    this.sincronizador ??= new SincronizadorDoInstagram(database, {
      lerSegredo: (tx, secretId) => this.vault.readSecret(tx, secretId),
      // Uma tentativa por chamada: a leitura que falha volta para a fila pela espera do tipo da falha.
      cliente: () => new ClienteConector(db, { enderecos: enderecosDasPlataformas(this.config.plataformas), tentativas: 1 }),
      graphUrl: this.config.plataformas.metaGraphUrl,
      appSecret: this.config.plataformas.metaAppSecret,
      versao: (capacidade) => versaoRegistrada(db, 'meta_ads', capacidade),
      ligadas: async (tenantId, brandId) => {
        const contexto = this.flags.context({ tenantId, brandId });
        return (await this.flags.isEnabled(FLAG_FOTOS, contexto)) && (await this.flags.isEnabled(FLAG_VIDEOS, contexto));
      },
    });
    const resultados: ResultadoDoInstagram[] = [];
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
