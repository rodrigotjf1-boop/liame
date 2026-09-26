import { type Database, withContext } from '@liame/database';
import { type CallHandler, type ExecutionContext, Inject, Injectable, Logger, type NestInterceptor } from '@nestjs/common';
import { HTTP_CODE_METADATA } from '@nestjs/common/constants.js';
import { from, lastValueFrom, type Observable } from 'rxjs';
import type { RequestWithAuth } from '../auth/access.js';
import { DATABASE } from '../database/database.module.js';
import {
  claimIdempotencyKey,
  type IdempotentRequest,
  readIdempotencyKey,
  REPLAYED_HEADER,
  requestHash,
  storeIdempotentResponse,
} from './idempotency.js';
import { requestStore } from './request-context.js';

const MUTATIONS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

interface HttpRequest extends RequestWithAuth {
  method: string;
  url: string;
  originalUrl?: string;
  body?: unknown;
  headers: Record<string, string | string[] | undefined>;
}
interface HttpResponse {
  setHeader(name: string, value: string): void;
}

/**
 * Unidade de trabalho: toda rota autenticada roda numa transação com o tenant e a pessoa no contexto
 * da RLS (ADR-003). A mutação, a auditoria, o outbox e a resposta idempotente entram juntos ou não entram.
 * A transação é curta: chamada a serviço externo não acontece aqui (vai para a fila).
 */
@Injectable()
export class UnitOfWorkInterceptor implements NestInterceptor {
  private readonly logger = new Logger('unidade-de-trabalho');

  constructor(@Inject(DATABASE) private readonly database: Database | null) {}

  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    const auth = ctx.switchToHttp().getRequest<RequestWithAuth>().auth;
    if (!auth || !this.database) return next.handle();
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

    const effects: Array<() => Promise<void>> = [];
    let replayed = false;
    const result = await withContext(database.db, ids, (tx) =>
      requestStore.run({ tx, afterCommit: effects }, async () => {
        if (idem) {
          const claim = await claimIdempotencyKey(tx, ids, idem);
          if (claim.replay) {
            replayed = true;
            return claim.body ?? undefined;
          }
        }
        const value: unknown = await lastValueFrom(next.handle(), { defaultValue: undefined });
        if (idem) await storeIdempotentResponse(tx, ids, idem.key, status, value);
        return value;
      }),
    );
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
