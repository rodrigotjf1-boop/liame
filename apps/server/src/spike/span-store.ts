// Primeiro módulo carregado pela verificação: guarda os avisos do Node e liga o OTel com um
// exportador em memória ANTES de qualquer import do Nest, do http ou do pg.
import { startTelemetry } from '@liame/telemetry';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';

export const warnings: string[] = [];
process.on('warning', (w) => warnings.push(`${w.name}: ${w.message}`));

export const memoryExporter = new InMemorySpanExporter();
startTelemetry({ serviceName: 'liame-spike', spanProcessors: [new SimpleSpanProcessor(memoryExporter)] });
