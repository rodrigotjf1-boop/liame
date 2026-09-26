import { resolve } from 'node:path';
import { runMigrations } from '@liame/database';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import pg from 'pg';
import { PgBoss } from 'pg-boss';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../../src/app.module.js';
import { configureApp } from '../../src/setup.js';
import { APP_URL, OWNER_URL, hasDb } from './env.js';

// LIC-008: o health de prontidão toca o banco e a fila e diz a versão e a última migration.
describe.skipIf(!hasDb)('GET /health/ready', () => {
  const schema = 'pgboss_ready_test';
  let app: INestApplication;
  let base: string;
  let boss: PgBoss | undefined;

  beforeAll(async () => {
    process.env.PGBOSS_SCHEMA = schema;
    await runMigrations({ connectionString: OWNER_URL, dir: resolve(process.cwd(), '../../packages/database/migrations') });
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    configureApp(app);
    await app.listen(0, '127.0.0.1');
    base = (await app.getUrl()).replace('[::1]', '127.0.0.1');
  });

  afterAll(async () => {
    await app?.close();
    await boss?.stop({ graceful: false });
    const owner = new pg.Client({ connectionString: OWNER_URL });
    await owner.connect();
    try {
      await owner.query(`drop schema if exists ${schema} cascade`);
    } finally {
      await owner.end();
    }
  });

  it('sem a fila instalada: 503, banco ok e a última migration aplicada', async () => {
    const res = await fetch(`${base}/health/ready`);
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({
      status: 'indisponivel',
      migration: '0001_base.sql',
      checks: { database: { status: 'ok' }, queue: { status: 'falhou' } },
    });
  });

  it('com a fila instalada pelo pg-boss: 200 e tudo ok', async () => {
    boss = new PgBoss({ connectionString: OWNER_URL, schema, application_name: 'liame-test-ready' });
    boss.on('error', (err: Error) => console.error('[pg-boss]', err.message));
    await boss.start();
    const res = await fetch(`${base}/health/ready`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      status: 'ok',
      service: 'liame-api',
      checks: { database: { status: 'ok' }, queue: { status: 'ok' } },
    });
  });

  it('a API usa o papel da aplicação, não o dono', () => {
    expect(new URL(APP_URL).username).toBe('liame_app');
  });
});

describe('GET /health/ready sem banco configurado', () => {
  it('responde 503 com o banco em falha (não derruba nem trava)', async () => {
    const saved = process.env.DATABASE_URL;
    delete process.env.DATABASE_URL;
    try {
      const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
      const app = moduleRef.createNestApplication({ logger: false });
      configureApp(app);
      await app.listen(0, '127.0.0.1');
      try {
        const res = await fetch(`${(await app.getUrl()).replace('[::1]', '127.0.0.1')}/health/ready`);
        expect(res.status).toBe(503);
        expect(await res.json()).toMatchObject({ status: 'indisponivel', checks: { database: { status: 'falhou' } } });
      } finally {
        await app.close();
      }
    } finally {
      if (saved) process.env.DATABASE_URL = saved;
    }
  });
});
