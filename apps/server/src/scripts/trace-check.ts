// Verificação de observabilidade de ponta a ponta (A1-14, ADR-010): `node dist/scripts/trace-check.js`.
// Liga o OTel com um exportador em memória (passando pela redação de dado pessoal) ANTES de carregar o
// Nest, o http e o pg; só então sobe a API e roda o fluxo de uma ação até o conector.
import { existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { RedactingSpanExporter, startTelemetry } from '@liame/telemetry';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';

const envLocal = resolve(import.meta.dirname, '../../../../.env.local');
if (existsSync(envLocal)) process.loadEnvFile(envLocal);
if (process.env.TEST_DATABASE_URL) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
// É o nome da variável que desliga a checagem de senha vazada (serviço externo), não um segredo.
process.env.BREACHED_PASSWORD_CHECK = 'off'; // nosemgrep: ajinabraham.njsscan.generic.hardcoded_secrets.node_password
process.env.LIAME_KEK_LOCAL ??= `1:${randomBytes(32).toString('base64')}`;
process.env.NODE_ENV ??= 'test';

export const memoryExporter = new InMemorySpanExporter();
startTelemetry({ serviceName: 'liame-verificacao', spanProcessors: [new SimpleSpanProcessor(new RedactingSpanExporter(memoryExporter))] });

const guard = setTimeout(() => {
  console.error('[rastreio] tempo esgotado (90 s)');
  process.exit(2);
}, 90_000);
guard.unref();

if (!process.env.DATABASE_URL) {
  console.log('[rastreio] pulado: sem banco de testes (TEST_DATABASE_URL)');
} else {
  try {
    const { run } = await import('./trace-check-run.js');
    process.exitCode = await run(memoryExporter);
  } catch (err) {
    console.error('[rastreio] falha inesperada:', err);
    process.exitCode = 1;
  }
}
