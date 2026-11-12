import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { RenderModule } from './render/render.module.js';
import { APP_VERSION } from './version.js';
import { startWorkerHealth } from './worker/health-server.js';

// O serviço de montagem do vídeo (`liame-render`, A6 · Z15 parte 2b; D-A6-139): a terceira entrada do mesmo código,
// ao lado da API e do worker, com a imagem própria (`apps/server/Dockerfile.render`: o Chrome Headless Shell do Remotion
// e o modelo empacotado).
async function bootstrap(): Promise<void> {
  const app = await NestFactory.createApplicationContext(RenderModule);
  app.enableShutdownHooks();
  // Mesma porta que o HEALTHCHECK da imagem consulta (PORT, 3001 na imagem).
  const health = await startWorkerHealth(Number(process.env.PORT ?? 3001), APP_VERSION, '127.0.0.1', 'liame-render');
  process.once('SIGTERM', () => health.close());
  Logger.log('serviço de montagem no ar', 'liame-render');
}

bootstrap().catch((err: unknown) => {
  console.error('[liame-render] falha ao subir:', err);
  process.exitCode = 1;
});
