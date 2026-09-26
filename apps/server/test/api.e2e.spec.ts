import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/setup.js';

describe('API: validação por Standard Schema (Zod)', () => {
  let app: INestApplication;
  let base: string;

  const post = (path: string, body: unknown) =>
    fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    configureApp(app);
    await app.listen(0, '127.0.0.1');
    base = (await app.getUrl()).replace('[::1]', '127.0.0.1');
  });

  afterAll(async () => {
    await app?.close();
  });

  it('GET /health responde fora do prefixo /v1', async () => {
    const res = await fetch(`${base}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: 'ok', service: 'liame-api' });
  });

  it('aceita corpo válido e entrega o valor transformado pelo schema', async () => {
    const res = await post('/v1/spike/echo', { message: '  olá  ' });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ message: 'olá', tags: [], length: 3 });
  });

  it('recusa corpo inválido com 400 e aponta o campo', async () => {
    const res = await post('/v1/spike/echo', { message: '', tags: ['ok'] });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { message: string[] };
    expect(body.message.join(' ')).toMatch(/message/);
  });

  it('recusa campo extra (strictObject)', async () => {
    const res = await post('/v1/spike/echo', { message: 'oi', admin: true });
    expect(res.status).toBe(400);
  });
});
