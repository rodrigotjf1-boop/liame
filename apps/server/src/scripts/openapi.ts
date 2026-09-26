// Gera o contrato OpenAPI 3.1 a partir do código: `pnpm openapi` (na raiz) grava `docs/openapi.json`.
// O CI regera e reprova se o arquivo commitado estiver diferente (contrato desatualizado).
import 'reflect-metadata';
import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module.js';
import { buildOpenApiDocument } from '../openapi.js';
import { configureApp } from '../setup.js';

const out = resolve(process.cwd(), process.argv[2] ?? '../../docs/openapi.json');

// O contrato não depende de banco nem do cofre: sobe sem DATABASE_URL e, se faltar, com uma chave mestra
// descartável (nada é cifrado aqui).
delete process.env.DATABASE_URL;
process.env.LIAME_KEK_LOCAL ??= `1:${randomBytes(32).toString('base64')}`;
const app = await NestFactory.create(AppModule, { logger: ['error'] });
configureApp(app);
await app.init();
const document = buildOpenApiDocument(app);
await app.close();

writeFileSync(out, `${JSON.stringify(document, null, 2)}\n`, 'utf8');
console.log(`openapi: ${Object.keys(document.paths).length} caminhos gravados em ${out}`);
