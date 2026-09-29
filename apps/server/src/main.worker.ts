import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { APP_VERSION } from './version.js';
import { startWorkerHealth } from './worker/health-server.js';
import { WorkerModule } from './worker/worker.module.js';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.createApplicationContext(WorkerModule);
  app.enableShutdownHooks();
  // Mesma porta que o HEALTHCHECK da imagem consulta (PORT, 3001 na imagem).
  const health = await startWorkerHealth(Number(process.env.PORT ?? 3001), APP_VERSION);
  process.once('SIGTERM', () => health.close());
  Logger.log('worker no ar', 'liame-worker');
}

bootstrap().catch((err: unknown) => {
  console.error('[liame-worker] falha ao subir:', err);
  process.exitCode = 1;
});
