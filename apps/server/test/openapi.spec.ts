import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { buildOpenApiDocument } from '../src/openapi.js';
import { configureApp } from '../src/setup.js';

type Schema = { $ref?: string; type?: string; properties?: Record<string, Schema>; required?: string[] };

describe('OpenAPI 3.1 gerado dos schemas Zod', () => {
  let app: INestApplication;
  let doc: ReturnType<typeof buildOpenApiDocument>;

  const resolve = (s: Schema | undefined): Schema | undefined =>
    s?.$ref ? (doc.components?.schemas?.[s.$ref.split('/').pop() ?? ''] as Schema) : s;

  beforeAll(async () => {
    app = await NestFactory.create(AppModule, { logger: false });
    configureApp(app);
    await app.init();
    doc = buildOpenApiDocument(app);
  });

  afterAll(async () => {
    await app?.close();
  });

  it('declara a versão 3.1.0', () => {
    expect(doc.openapi).toBe('3.1.0');
  });

  it('usa o prefixo /v1 e deixa /health de fora', () => {
    expect(Object.keys(doc.paths)).toEqual(expect.arrayContaining(['/health', '/v1/spike/echo']));
  });

  it('reflete o corpo da rota a partir do Zod', () => {
    const body = doc.paths['/v1/spike/echo']?.post?.requestBody;
    const schema = resolve(body && 'content' in body ? (body.content['application/json']?.schema as Schema) : undefined);
    expect(schema?.properties?.message?.type).toBe('string');
    expect(schema?.required).toContain('message');
  });

  it('reflete a resposta a partir do Zod', () => {
    const created = doc.paths['/v1/spike/echo']?.post?.responses?.['201'];
    const schema = resolve(created && 'content' in created ? (created.content?.['application/json']?.schema as Schema) : undefined);
    expect(Object.keys(schema?.properties ?? {})).toEqual(expect.arrayContaining(['message', 'tags', 'length']));
  });
});
