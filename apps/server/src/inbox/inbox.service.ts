import { type Database, uuidv7, withSystem } from '@liame/database';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { APP_CONFIG, type AppConfig } from '../config.js';
import { DATABASE } from '../database/database.module.js';
import { AppProblem } from '../errors/problems.js';
import { verifyWebhook } from '../events/standard-webhooks.js';

/** Cabeçalhos guardados junto com o corpo (nada de cookie, autorização ou assinatura). */
const KEPT_HEADERS = ['content-type', 'user-agent', 'webhook-id', 'webhook-timestamp'];
const notFound = () => new AppProblem(404, 'nao-encontrado', 'Não encontramos', 'O recurso pedido não existe.');

/**
 * Inbox (ADR-004): receber → verificar assinatura → persistir cru → deduplicar → ACK. Nada além de
 * gravar acontece aqui (LIC-009); o processamento é do worker. Chega antes de saber a empresa, por isso
 * grava no escopo de sistema.
 */
@Injectable()
export class InboxService {
  private readonly logger = new Logger('inbox');

  constructor(
    @Inject(DATABASE) private readonly database: Database | null,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async receive(provider: string, rawBody: Buffer | undefined, headers: Record<string, string | string[] | undefined>): Promise<{ duplicate: boolean }> {
    const secret = this.config.inboxSecrets.get(provider);
    // Provedor desconhecido responde como rota inexistente (não revela quais provedores existem).
    if (!secret) throw notFound();
    if (!rawBody?.length) throw new AppProblem(400, 'corpo-vazio', 'Corpo vazio', 'O webhook chegou sem corpo.');
    const body = rawBody.toString('utf8');
    const check = verifyWebhook(secret, headers, body);
    if (!check.ok) {
      // O motivo fica no log; a resposta não ensina a forjar (regra de log de erros esperados).
      this.logger.warn(`webhook de ${provider} recusado: ${check.reason}`);
      throw new AppProblem(401, 'assinatura-invalida', 'Assinatura inválida', 'A assinatura do webhook não confere.');
    }
    const kept = Object.fromEntries(KEPT_HEADERS.filter((h) => typeof headers[h] === 'string').map((h) => [h, headers[h]]));
    const type = typeOf(body);
    if (!this.database) throw new AppProblem(503, 'indisponivel', 'Serviço indisponível', 'Tente de novo em instantes.');
    const inserted = await withSystem(this.database.db, (tx) =>
      tx.execute(sql`
        insert into liame.inbox_event (id, provider, external_event_id, type, headers, body)
        values (${uuidv7()}, ${provider}, ${check.id}, ${type}, ${JSON.stringify(kept)}::jsonb, ${body})
        on conflict (provider, external_event_id) do nothing`),
    );
    return { duplicate: inserted.rowCount === 0 };
  }
}

/** O tipo, quando o corpo é JSON com `type` (CloudEvents e afins); o resto fica para o processador. */
function typeOf(body: string): string | null {
  try {
    const parsed = JSON.parse(body) as { type?: unknown };
    return typeof parsed.type === 'string' ? parsed.type.slice(0, 200) : null;
  } catch {
    return null;
  }
}
