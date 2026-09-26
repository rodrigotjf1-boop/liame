import { type Attributes, context, propagation, SpanStatusCode, trace } from '@opentelemetry/api';

// Spans manuais (ADR-010): workflow, política, ação e connector, com o trace continuando entre a API e o
// worker pelo `traceparent` guardado no banco. Atributos só com ids e códigos, nunca dado pessoal.

const tracer = trace.getTracer('liame');

/** `traceparent` do contexto atual (nulo sem span ativo ou com o OTel desligado). */
export function currentTraceparent(): string | null {
  const carrier: Record<string, string> = {};
  propagation.inject(context.active(), carrier);
  return carrier.traceparent ?? null;
}

/** Roda `fn` num span; com `parent`, continua o trace de quem gravou (ex.: a requisição que pediu a ação). */
export async function inSpan<T>(name: string, attributes: Attributes, fn: () => Promise<T>, parent?: string | null): Promise<T> {
  const ctx = parent ? propagation.extract(context.active(), { traceparent: parent }) : context.active();
  return tracer.startActiveSpan(name, { attributes }, ctx, async (span) => {
    try {
      return await fn();
    } catch (err) {
      span.recordException(err instanceof Error ? err : new Error(String(err)));
      span.setStatus({ code: SpanStatusCode.ERROR, message: err instanceof Error ? err.message : String(err) });
      throw err;
    } finally {
      span.end();
    }
  });
}
