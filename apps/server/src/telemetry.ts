// Pré-carregado com `node --require ./dist/telemetry.js`: liga o OTel antes do Nest, do http e do pg.
import { basename } from 'node:path';
import { startTelemetry } from '@liame/telemetry';

const entry = basename(process.argv[1] ?? '');
startTelemetry({
  serviceName: process.env.OTEL_SERVICE_NAME ?? (entry.startsWith('main.worker') ? 'liame-worker' : 'liame-api'),
});
