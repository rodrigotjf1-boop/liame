import { type Database, withContext } from '@liame/database';
import { type CallHandler, type ExecutionContext, Inject, Injectable, type NestInterceptor } from '@nestjs/common';
import { from, lastValueFrom, type Observable } from 'rxjs';
import type { RequestWithAuth } from '../auth/access.js';
import { DATABASE } from '../database/database.module.js';
import { requestStore } from './request-context.js';

/**
 * Unidade de trabalho: toda rota autenticada roda numa transação com o tenant e a pessoa no contexto
 * da RLS (ADR-003). A mutação, a auditoria e o outbox entram juntos ou não entram.
 * A transação é curta: chamada a serviço externo não acontece aqui (vai para a fila).
 */
@Injectable()
export class UnitOfWorkInterceptor implements NestInterceptor {
  constructor(@Inject(DATABASE) private readonly database: Database | null) {}

  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    const auth = ctx.switchToHttp().getRequest<RequestWithAuth>().auth;
    if (!auth || !this.database) return next.handle();
    return from(
      withContext(this.database.db, { tenantId: auth.tenantId, userId: auth.userId }, (tx) =>
        requestStore.run({ tx }, () => lastValueFrom(next.handle(), { defaultValue: undefined })),
      ),
    );
  }
}
