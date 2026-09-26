import { type Database, withContext } from '@liame/database';
import { type CallHandler, type ExecutionContext, Inject, Injectable, Logger, type NestInterceptor } from '@nestjs/common';
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
  private readonly logger = new Logger('unidade-de-trabalho');

  constructor(@Inject(DATABASE) private readonly database: Database | null) {}

  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    const auth = ctx.switchToHttp().getRequest<RequestWithAuth>().auth;
    if (!auth || !this.database) return next.handle();
    return from(this.run(this.database, auth, next));
  }

  private async run(database: Database, auth: NonNullable<RequestWithAuth['auth']>, next: CallHandler): Promise<unknown> {
    const effects: Array<() => Promise<void>> = [];
    const result = await withContext(database.db, { tenantId: auth.tenantId, userId: auth.userId }, (tx) =>
      requestStore.run({ tx, afterCommit: effects }, () => lastValueFrom(next.handle(), { defaultValue: undefined })),
    );
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
