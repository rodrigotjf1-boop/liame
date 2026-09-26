import { type ArgumentsHost, Catch, type ExceptionFilter, Logger } from '@nestjs/common';
import type { HttpAdapterHost } from '@nestjs/core';
import { currentTraceId, reasonOf, toProblem } from './problems.js';

/**
 * Toda resposta de erro sai em RFC 9457 (`application/problem+json`) com `trace_id` (arquitetura §14).
 * 5xx: log com a causa real e a stack (LIC-003). 4xx: log do motivo, em nível informativo.
 */
@Catch()
export class ProblemDetailsFilter implements ExceptionFilter {
  private readonly logger = new Logger('http');

  constructor(private readonly adapterHost: HttpAdapterHost) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const { httpAdapter } = this.adapterHost;
    const ctx = host.switchToHttp();
    const req: unknown = ctx.getRequest();
    const res: unknown = ctx.getResponse();
    const traceId = currentTraceId();
    const method = String(httpAdapter.getRequestMethod(req));
    const path = String(httpAdapter.getRequestUrl(req)).split('?')[0] ?? '/';
    const problem = toProblem(exception, traceId, path);

    if (problem.status >= 500) {
      this.logger.error(
        `${method} ${path} → ${problem.status} [trace ${traceId}]: ${reasonOf(exception)}`,
        exception instanceof Error ? exception.stack : undefined,
      );
    } else {
      this.logger.log(`${method} ${path} → ${problem.status} ${problem.code} [trace ${traceId}]: ${reasonOf(exception)}`);
    }

    httpAdapter.setHeader(res, 'content-type', 'application/problem+json');
    httpAdapter.reply(res, problem, problem.status);
  }
}
