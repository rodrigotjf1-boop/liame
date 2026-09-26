import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { WorkerModule } from './worker/worker.module.js';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.createApplicationContext(WorkerModule);
  app.enableShutdownHooks();
  Logger.log('worker no ar', 'liame-worker');
}

bootstrap().catch((err: unknown) => {
  console.error('[liame-worker] falha ao subir:', err);
  process.exitCode = 1;
});
