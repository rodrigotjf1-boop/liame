import { type Database, withContext } from '@liame/database';
import { type CallHandler, type ExecutionContext, Inject, Injectable, Logger, type NestInterceptor } from '@nestjs/common';
import { HTTP_CODE_METADATA } from '@nestjs/common/constants.js';
import { trace } from '@opentelemetry/api';
import { from, lastValueFrom, type Observable } from 'rxjs';
import { writeAudit } from '../audit/audit.js';
import { AUDIT_KEY, type AuditDeclaration } from '../audit/auditar.js';
import type { RequestWithAuth } from '../auth/access.js';
import { ROLE_LABEL } from '../people/grant-rules.js';
import { DATABASE } from '../database/database.module.js';
import {
  claimIdempotencyKey,
  type IdempotentRequest,
  readIdempotencyKey,
  REPLAYED_HEADER,
  requestHash,
  storeIdempotentResponse,
} from './idempotency.js';
import { type AuthContext, requestStore } from './request-context.js';
import { SEM_TRANSACAO_KEY } from './sem-transacao.js';

const MUTATIONS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

interface HttpRequest extends RequestWithAuth {
  method: string;
  url: string;
  originalUrl?: string;
  body?: unknown;
  params?: Record<string, string>;
  headers: Record<string, string | string[] | undefined>;
}
interface HttpResponse {
  setHeader(name: string, value: string): void;
}

/**
 * Unidade de trabalho: toda rota autenticada roda numa transação com o tenant e a pessoa no contexto
 * da RLS (ADR-003). A mutação, a auditoria, o outbox e a resposta idempotente entram juntos ou não entram.
 * A transação é curta: chamada a serviço externo não acontece aqui (vai para a fila). A exceção declarada
 * é a rota `@SemTransacao`, que espera um modelo de IA e abre as próprias transações.
 */
@Injectable()
export class UnitOfWorkInterceptor implements NestInterceptor {
  private readonly logger = new Logger('unidade-de-trabalho');

  constructor(@Inject(DATABASE) private readonly database: Database | null) {}

  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    const auth = ctx.switchToHttp().getRequest<RequestWithAuth>().auth;
    if (!auth || !this.database) return next.handle();
    // A rota que espera um modelo de IA abre as próprias transações curtas (`@SemTransacao`).
    if (Reflect.getMetadata(SEM_TRANSACAO_KEY, ctx.getHandler())) return next.handle();
    return from(this.run(this.database, auth, ctx, next));
  }

  private async run(database: Database, auth: NonNullable<RequestWithAuth['auth']>, ctx: ExecutionContext, next: CallHandler): Promise<unknown> {
    const http = ctx.switchToHttp();
    const req = http.getRequest<HttpRequest>();
    const method = req.method.toUpperCase();
    const key = MUTATIONS.has(method) ? readIdempotencyKey(req.headers) : undefined;
    const path = req.originalUrl ?? req.url;
    const idem: IdempotentRequest | null = key ? { key, method, path, hash: requestHash(method, path, req.body) } : null;
    const status = (Reflect.getMetadata(HTTP_CODE_METADATA, ctx.getHandler()) as number | undefined) ?? (method === 'POST' ? 201 : 200);
    const ids = { tenantId: auth.tenantId, userId: auth.userId };

    const declaration = Reflect.getMetadata(AUDIT_KEY, ctx.getHandler()) as AuditDeclaration | undefined;
    const effects: Array<() => Promise<void>> = [];
    let replayed = false;
    const result = await withContext(database.db, ids, (tx) => {
      const store: Parameters<typeof requestStore.run>[0] = { tx, afterCommit: effects };
      return requestStore.run(store, async () => {
        if (idem) {
          const claim = await claimIdempotencyKey(tx, ids, idem);
          if (claim.replay) {
            replayed = true;
            return claim.body ?? undefined;
          }
        }
        const value: unknown = await lastValueFrom(next.handle(), { defaultValue: undefined });
        // A1-6: a mutação e o evento de auditoria entram na mesma transação.
        if (declaration?.kind === 'auditar' && !declaration.manual) {
          await writeAudit(tx, {
            tenantId: declaration.scope === 'pessoa' ? null : auth.tenantId,
            actorType: 'human',
            actorId: auth.userId,
            actorLabel: actorLabel(auth),
            actorRole: auth.roleKey,
            action: declaration.action,
            resourceType: declaration.resourceType,
            resourceId: store.audit?.resourceId ?? req.params?.id ?? idOf(value),
            before: store.audit?.before ?? null,
            after: store.audit?.after ?? null,
            reason: store.audit?.reason ?? null,
            traceId: trace.getActiveSpan()?.spanContext().traceId ?? null,
            origin: 'api',
          });
        }
        if (idem) await storeIdempotentResponse(tx, ids, idem.key, status, value);
        return value;
      });
    });
    if (replayed) http.getResponse<HttpResponse>().setHeader(REPLAYED_HEADER, 'true');
    for (const effect of effects) {
      try {
        await effect();
      } catch (err) {
        this.logger.error(`efeito depois do commit falhou: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return result;
  }
}

/** Quem era no momento: "Juliana, Administrador" (ADR-017). */
export function actorLabel(auth: Pick<AuthContext, 'name' | 'roleKey'>): string {
  return auth.roleKey ? `${auth.name}, ${ROLE_LABEL[auth.roleKey]}` : auth.name;
}

function idOf(value: unknown): string | null {
  if (value && typeof value === 'object' && typeof (value as { id?: unknown }).id === 'string') return (value as { id: string }).id;
  return null;
}
