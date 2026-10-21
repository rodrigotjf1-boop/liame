import { type Database, withSystem } from '@liame/database';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { DATABASE } from '../database/database.module.js';
import { chaveDaMiniatura } from '../fotos/conferencia.js';
import { ARMAZEM_DE_IMAGENS, type ArmazemDeImagens } from '../imagens/armazem.js';
import { type JobScope, tenantFilter } from './outbox-publisher.js';

/** O envio que não terminou em 15 minutos é limpo: a linha `enviando` que ficou para trás (a rota caiu no meio). */
export const ENVIO_ABANDONADO_MIN = 15;

function mensagem(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * A limpeza das fotos (A6, Z4; ADR-021, item 6): a foto apagada e o envio que não terminou. O arquivo (a foto e a
 * miniatura) sai do armazenamento primeiro e a linha depois; se o armazenamento falhar, a linha volta para o fim da
 * fila (pela data da última mudança, V106) e é tentada de novo na volta seguinte, sem segurar as outras.
 */
@Injectable()
export class FotosLoop {
  private readonly logger = new Logger('fotos');

  constructor(
    @Inject(DATABASE) private readonly database: Database | null,
    @Inject(ARMAZEM_DE_IMAGENS) private readonly armazem: ArmazemDeImagens,
  ) {}

  /** Um lote; devolve os ids das fotos que saíram de vez. */
  async executarLote(limite = 20, scope: JobScope = {}, agora: Date = new Date()): Promise<string[]> {
    if (!this.database || !this.armazem.disponivel) return [];
    const db = this.database.db;
    const abandonado = new Date(agora.getTime() - ENVIO_ABANDONADO_MIN * 60_000).toISOString();
    const devidas = await withSystem(db, (tx) =>
      tx.execute<{ id: string; object_key: string }>(sql`
        select id, object_key from liame.brand_photo
         where (removed_at is not null or (status = 'enviando' and created_at < ${abandonado})) ${tenantFilter(scope, sql`tenant_id`)}
         order by updated_at, id
         limit ${limite}`),
    );
    const saiu: string[] = [];
    for (const f of devidas.rows) {
      try {
        await this.armazem.apagar([f.object_key, chaveDaMiniatura(f.object_key)]);
      } catch (err) {
        this.logger.warn(`foto ${f.id}: o armazenamento não apagou o arquivo; fica para a volta seguinte (${mensagem(err)})`);
        await withSystem(db, (tx) => tx.execute(sql`update liame.brand_photo set updated_at = ${agora.toISOString()} where id = ${f.id}`));
        continue;
      }
      // A condição de novo: o envio que terminou no meio do caminho não perde a linha.
      await withSystem(db, (tx) => tx.execute(sql`delete from liame.brand_photo where id = ${f.id} and (removed_at is not null or status = 'enviando')`));
      saiu.push(f.id);
    }
    return saiu;
  }
}
