// Gera o contrato OpenAPI 3.1 a partir do código: `pnpm openapi` (na raiz) grava `docs/openapi.json`.
// O CI regera e reprova se o arquivo commitado estiver diferente (contrato desatualizado).
import 'reflect-metadata';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module.js';
import { buildOpenApiDocument } from '../openapi.js';
import { configureApp } from '../setup.js';

const out = resolve(process.cwd(), process.argv[2] ?? '../../docs/openapi.json');

// O contrato não depende de banco: sobe sem DATABASE_URL.
delete process.env.DATABASE_URL;
const app = await NestFactory.create(AppModule, { logger: ['error'] });
configureApp(app);
await app.init();
const document = buildOpenApiDocument(app);
await app.close();

writeFileSync(out, `${JSON.stringify(document, null, 2)}\n`, 'utf8');
console.log(`openapi: ${Object.keys(document.paths).length} caminhos gravados em ${out}`);
