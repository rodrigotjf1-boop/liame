import { type Database, withSystem } from '@liame/database';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { APP_CONFIG, type AppConfig } from '../config.js';
import { DATASET_DOS_COMENTARIOS, FLAG_DOS_COMENTARIOS, INTERVALO_DOS_COMENTARIOS_MIN } from '../comentarios/comentarios.js';
import { FLAG_DOS_PEDIDOS } from '../comentarios/pedidos.js';
import { type ResultadoDosComentarios, SincronizadorDosComentarios } from '../comentarios/sincronizador-dos-comentarios.js';
import { contaConectada } from '../connections/conectada.js';
import { ClienteConector } from '../connectors/cliente-http.js';
import { enderecosDasPlataformas } from '../connectors/enderecos.js';
import { PROVEDOR_INSTAGRAM, PROVEDOR_PAGINA } from '../connectors/meta/publicacao.js';
import { versaoRegistrada } from '../connectors/tipos.js';
import { DATABASE } from '../database/database.module.js';
import { FlagService } from '../flags/flag.service.js';
import { VaultService } from '../vault/vault.service.js';
import { type JobScope, tenantFilter } from './outbox-publisher.js';

/** Reserva da leitura: se o worker cair no meio, ela volta para a fila depois disto. */
const RESERVA_MIN = 30;

/**
 * Comentários (A6, Z11, parte 1; P38, D-A6-85): a leitura dos comentários de cada conta do Instagram e de cada Página
 * ligadas a uma marca, a cada 15 minutos. Reserva as leituras devidas com SKIP LOCKED na MESMA linha que a reserva altera
 * (o `sync_state` do conjunto, ERR-029), a mais atrasada primeiro, de qualquer empresa. Fica no worker porque reserva em
 * escopo de sistema (V53); a leitura em si roda na empresa, e é ela que confere a função `comentarios`: a conta da
 * empresa com a função desligada sai da fila por um dia (V106). A conta desligada leva junto o que foi lido dela.
 */
@Injectable()
export class ComentariosLoop {
  private readonly logger = new Logger('comentarios');
  private sincronizador: SincronizadorDosComentarios | null = null;

  constructor(
    @Inject(DATABASE) private readonly database: Database | null,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly vault: VaultService,
    private readonly flags: FlagService,
  ) {}

  async executarLote(limite = 5, scope: JobScope = {}, agora: Date = new Date()): Promise<ResultadoDosComentarios[]> {
    const database = this.database;
    if (!database) return [];
    const db = database.db;
    // O relógio de quem chama vale para a fila inteira: a reserva e o que a leitura grava (V34).
    const referencia = sql`${agora.toISOString()}::timestamptz`;
    const elegivel = sql`a.provider in (${PROVEDOR_INSTAGRAM}, ${PROVEDOR_PAGINA}) and ${contaConectada('a')} and a.credential_secret_id is not null`;
    const reservadas = await withSystem(db, async (tx) => {
      // A conta desligada leva junto o que foi lido dela (os comentários saem com o post, em cascata).
      await tx.execute(sql`
        delete from liame.social_comment_post p
         using liame.connected_account a
         where a.id = p.connected_account_id and not coalesce(${contaConectada('a')}, false) ${tenantFilter(scope, sql`p.tenant_id`)}`);
      // A conta ligada ganha a linha do conjunto, devida desde já.
      await tx.execute(sql`
        insert into liame.sync_state (connected_account_id, dataset, tenant_id, expected_every_minutes, cursor)
        select a.id, ${DATASET_DOS_COMENTARIOS}, a.tenant_id, ${INTERVALO_DOS_COMENTARIOS_MIN}::integer, '{}'::jsonb
          from liame.connected_account a
         where ${elegivel} ${tenantFilter(scope, sql`a.tenant_id`)}
           and not exists (select 1 from liame.sync_state s where s.connected_account_id = a.id and s.dataset = ${DATASET_DOS_COMENTARIOS})
        on conflict (connected_account_id, dataset) do nothing`);
      const r = await tx.execute<{ id: string; tenant_id: string }>(sql`
        with devidas as materialized (
          select s.connected_account_id
            from liame.sync_state s
            join liame.connected_account a on a.id = s.connected_account_id
           where s.dataset = ${DATASET_DOS_COMENTARIOS} and ${elegivel}
             and coalesce((s.cursor->>'proxima')::timestamptz, '-infinity'::timestamptz) <= ${referencia}
             ${tenantFilter(scope, sql`a.tenant_id`)}
           order by coalesce((s.cursor->>'proxima')::timestamptz, '-infinity'::timestamptz), s.connected_account_id
           limit ${limite}
           for update of s skip locked
        )
        -- A marca 'lendo' diz ao "Ler agora" que a conta está sendo lida; a leitura que termina regrava o cursor sem ela.
        update liame.sync_state s
           set cursor = s.cursor || jsonb_build_object('proxima', ${referencia} + make_interval(mins => ${RESERVA_MIN}), 'lendo', ${referencia}),
               updated_at = ${referencia}
          from devidas d
         where s.connected_account_id = d.connected_account_id and s.dataset = ${DATASET_DOS_COMENTARIOS}
        returning s.connected_account_id as id, s.tenant_id`);
      return r.rows;
    });
    this.sincronizador ??= new SincronizadorDosComentarios(database, {
      lerSegredo: (tx, secretId) => this.vault.readSecret(tx, secretId),
      // Uma tentativa por chamada: a leitura que falha volta para a fila pela espera do tipo da falha.
      cliente: () => new ClienteConector(db, { enderecos: enderecosDasPlataformas(this.config.plataformas), tentativas: 1 }),
      graphUrl: this.config.plataformas.metaGraphUrl,
      appSecret: this.config.plataformas.metaAppSecret,
      versao: (capacidade) => versaoRegistrada(db, 'meta_ads', capacidade),
      ligada: (tenantId, brandId) => this.flags.isEnabled(FLAG_DOS_COMENTARIOS, this.flags.context({ tenantId, brandId })),
      pedidosLigados: (tenantId, brandId) => this.flags.isEnabled(FLAG_DOS_PEDIDOS, this.flags.context({ tenantId, brandId })),
    });
    const resultados: ResultadoDosComentarios[] = [];
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
