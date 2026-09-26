import { diag, DiagConsoleLogger, DiagLogLevel } from '@opentelemetry/api';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { PgInstrumentation } from '@opentelemetry/instrumentation-pg';
import { UndiciInstrumentation } from '@opentelemetry/instrumentation-undici';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto';
import { BatchSpanProcessor, NoopSpanProcessor, type SpanProcessor } from '@opentelemetry/sdk-trace-base';
import { RedactingSpanExporter } from './redact.js';

export { maskIp, RedactingSpanExporter, redactAttributes, redactSpan, redactString } from './redact.js';

export interface TelemetryOptions {
  /** `liame-api`, `liame-worker` ou `liame-web` (ADR-010). */
  serviceName: string;
  /** Processadores de span explícitos. Os testes passam um exportador em memória. */
  spanProcessors?: SpanProcessor[];
  /** Caminhos de entrada sem span (sondas). Padrão: `/health`. */
  ignoreIncomingPaths?: string[];
}

let sdk: NodeSDK | undefined;

/**
 * Liga o OpenTelemetry com http, undici e pg (ADR-010). Precisa rodar **antes** de carregar
 * `pg` e o servidor HTTP: na API e no worker entra por `--require`; no Next, pelo `instrumentation.ts`.
 *
 * Sem exportador configurado (`OTEL_EXPORTER_OTLP_ENDPOINT` ou `OTEL_TRACES_EXPORTER`), os spans
 * existem (o `trace_id` chega aos logs) mas não saem do processo, e métricas e logs ficam
 * desligados: nada tenta falar com um coletor que não existe.
 */
export function startTelemetry(options: TelemetryOptions): NodeSDK {
  if (sdk) return sdk;
  diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.WARN);

  const ignored = new Set(options.ignoreIncomingPaths ?? ['/health']);
  const exportConfigured = Boolean(
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT ||
      process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT ||
      process.env.OTEL_TRACES_EXPORTER,
  );

  const quiet = !exportConfigured && !options.spanProcessors;
  // Exportando, o OTLP passa antes pela redação de dado pessoal (ADR-010, LGPD).
  const exporting = exportConfigured && process.env.OTEL_TRACES_EXPORTER !== 'none' && !options.spanProcessors;
  sdk = new NodeSDK({
    serviceName: options.serviceName,
    ...(options.spanProcessors
      ? { spanProcessors: options.spanProcessors }
      : quiet
        ? { spanProcessors: [new NoopSpanProcessor()] }
        : exporting
          ? { spanProcessors: [new BatchSpanProcessor(new RedactingSpanExporter(new OTLPTraceExporter()))] }
          : {}),
    ...(quiet || options.spanProcessors ? { metricReaders: [], logRecordProcessors: [] } : {}),
    instrumentations: [
      new HttpInstrumentation({
        ignoreIncomingRequestHook: (req) => ignored.has((req.url ?? '').split('?')[0] ?? ''),
      }),
      new UndiciInstrumentation(),
      // Sem texto de query com valores nem parâmetros no span (LGPD, base §15).
      new PgInstrumentation({ enhancedDatabaseReporting: false }),
    ],
  });
  sdk.start();
  return sdk;
}

/** Envia o que falta e desliga. Chamar no desligamento do processo. */
export async function shutdownTelemetry(): Promise<void> {
  const current = sdk;
  sdk = undefined;
  if (!current) return;
  try {
    await current.shutdown();
  } catch (err) {
    console.error('[telemetry] falha ao desligar:', err instanceof Error ? err.message : err);
  }
}
