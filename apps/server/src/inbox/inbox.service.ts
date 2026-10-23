import { createHash, timingSafeEqual } from 'node:crypto';
import { type Database, uuidv7, withSystem } from '@liame/database';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { APP_CONFIG, type AppConfig } from '../config.js';
import { PROVIDER_ASAAS, situacaoParaGravar } from '../connectors/asaas/api-asaas.js';
import { DATABASE } from '../database/database.module.js';
import { AppProblem } from '../errors/problems.js';
import { verifyWebhook } from '../events/standard-webhooks.js';
import { VaultService } from '../vault/vault.service.js';

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
    private readonly vault: VaultService,
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

  /**
   * O aviso do Asaas (A7, W2a, parte 2; D-A7-28; base §18.5): o token fixo no cabeçalho `asaas-access-token`, conferido em
   * tempo constante (o Asaas não assina o corpo); o evento gravado cru, uma vez só pelo `id` dele (o mesmo nas
   * reentregas). Nada além disso: a resposta sai na hora (o Asaas espera 10 segundos), e o worker relê a cobrança na API.
   * Sem o token configurado, a rota responde como inexistente.
   */
  async receberDoAsaas(rawBody: Buffer | undefined, headers: Record<string, string | string[] | undefined>): Promise<{ duplicate: boolean }> {
    const esperado = this.config.asaas?.webhookToken;
    if (!esperado) throw notFound();
    const recebido = headers['asaas-access-token'];
    if (typeof recebido !== 'string' || !mesmoTexto(recebido, esperado)) {
      // O motivo fica no log; a resposta não ensina a forjar.
      this.logger.warn(`aviso do Asaas recusado: ${typeof recebido === 'string' ? 'token diferente' : 'sem o token'}`);
      throw new AppProblem(401, 'assinatura-invalida', 'Assinatura inválida', 'O token do aviso não confere.');
    }
    if (!rawBody?.length) throw new AppProblem(400, 'corpo-vazio', 'Corpo vazio', 'O webhook chegou sem corpo.');
    const body = rawBody.toString('utf8');
    const evento = eventoDoAsaas(body);
    if (!evento) throw new AppProblem(400, 'aviso-invalido', 'Aviso inválido', 'O aviso chegou sem o id ou o tipo do evento.');
    if (!this.database) throw new AppProblem(503, 'indisponivel', 'Serviço indisponível', 'Tente de novo em instantes.');
    const kept = Object.fromEntries(KEPT_HEADERS.filter((h) => typeof headers[h] === 'string').map((h) => [h, headers[h]]));
    const inserted = await withSystem(this.database.db, (tx) =>
      tx.execute(sql`
        insert into liame.inbox_event (id, provider, external_event_id, type, headers, body)
        values (${uuidv7()}, ${PROVIDER_ASAAS}, ${evento.id}, ${evento.tipo}, ${JSON.stringify(kept)}::jsonb, ${body})
        on conflict (provider, external_event_id) do nothing`),
    );
    return { duplicate: inserted.rowCount === 0 };
  }

  /**
   * Webhook de um produto DMS para uma conexão (A2.5, ADR-019): cada conexão tem o próprio segredo, no
   * cofre. Conexão inexistente, de outro produto, revogada ou sem segredo responde como rota inexistente.
   * O evento é só gatilho de frescor: o conector lê pela rota com cursor em seguida.
   */
  async receiveForConnection(
    provider: string,
    connectionId: string,
    rawBody: Buffer | undefined,
    headers: Record<string, string | string[] | undefined>,
  ): Promise<{ duplicate: boolean }> {
    if (!this.database) throw new AppProblem(503, 'indisponivel', 'Serviço indisponível', 'Tente de novo em instantes.');
    if (!rawBody?.length) throw new AppProblem(400, 'corpo-vazio', 'Corpo vazio', 'O webhook chegou sem corpo.');
    const body = rawBody.toString('utf8');
    return withSystem(this.database.db, async (tx) => {
      const r = await tx.execute<{ tenant_id: string; inbox_secret_id: string | null }>(sql`
        select tenant_id, inbox_secret_id from liame.oauth_connection
         where id = ${connectionId} and provider = ${provider} and status in ('aguardando_escolha', 'ativa')`);
      const conexao = r.rows[0];
      const secret = conexao?.inbox_secret_id ? await this.vault.readSecret(tx, conexao.inbox_secret_id) : null;
      if (!conexao || !secret) throw notFound();
      const check = verifyWebhook(secret, headers, body);
      if (!check.ok) {
        this.logger.warn(`webhook de ${provider} para a conexão ${connectionId} recusado: ${check.reason}`);
        throw new AppProblem(401, 'assinatura-invalida', 'Assinatura inválida', 'A assinatura do webhook não confere.');
      }
      const kept = Object.fromEntries(KEPT_HEADERS.filter((h) => typeof headers[h] === 'string').map((h) => [h, headers[h]]));
      const inserted = await tx.execute(sql`
        insert into liame.inbox_event (id, provider, external_event_id, tenant_id, connection_id, type, headers, body)
        values (${uuidv7()}, ${provider}, ${check.id}, ${conexao.tenant_id}, ${connectionId}, ${typeOf(body)}, ${JSON.stringify(kept)}::jsonb, ${body})
        on conflict (provider, external_event_id) do nothing`);
      return { duplicate: inserted.rowCount === 0 };
    });
  }
}

/** Compara dois textos em tempo constante (pelo hash de cada um, que tem sempre o mesmo tamanho). */
function mesmoTexto(a: string, b: string): boolean {
  return timingSafeEqual(createHash('sha256').update(a, 'utf8').digest(), createHash('sha256').update(b, 'utf8').digest());
}

/**
 * O evento do Asaas (eventos para cobranças, 13/10/2026): o `id` (como `evt_05b7…&368604920`, até 200 letras) e o tipo em
 * `event` (`PAYMENT_RECEIVED`…, nas regras da situação: maiúsculas e sublinhado). Fora disso, não é aviso.
 */
export function eventoDoAsaas(body: string): { id: string; tipo: string } | null {
  let aviso: unknown;
  try {
    aviso = JSON.parse(body);
  } catch {
    return null;
  }
  const { id, event } = (aviso ?? {}) as { id?: unknown; event?: unknown };
  if (typeof id !== 'string' || id.length < 1 || id.length > 200 || typeof event !== 'string') return null;
  const tipo = situacaoParaGravar(event);
  return tipo ? { id, tipo } : null;
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
