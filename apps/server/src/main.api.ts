import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module.js';
import { configureApp } from './setup.js';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  // Atrás da Cloudflare e do proxy do EasyPanel: quantos saltos confiar para achar o IP real (security-model §8).
  app.set('trust proxy', Number(process.env.TRUST_PROXY_HOPS ?? 0));
  configureApp(app);
  app.enableShutdownHooks();
  const port = Number(process.env.PORT ?? 3001);
  await app.listen(port);
  Logger.log(`API no ar na porta ${port}`, 'liame-api');
}

bootstrap().catch((err: unknown) => {
  console.error('[liame-api] falha ao subir:', err);
  process.exitCode = 1;
});
