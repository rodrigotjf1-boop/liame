import type { INestApplication, LoggerService } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/setup.js';
import { ProbeController } from './helpers/probe.controller.js';

/** Guarda o que a API loga, para conferir que o 5xx deixa a causa (LIC-003). */
class MemoryLogger implements LoggerService {
  readonly lines: string[] = [];
  log(message: unknown): void {
    this.lines.push(`log ${String(message)}`);
  }
  error(message: unknown, stack?: unknown): void {
    this.lines.push(`error ${String(message)} ${String(stack ?? '')}`);
  }
  warn(message: unknown): void {
    this.lines.push(`warn ${String(message)}`);
  }
}

describe('API: validação e política de erros (RFC 9457)', () => {
  let app: INestApplication;
  let base: string;
  const logger = new MemoryLogger();

  const post = (path: string, body: string) =>
    fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body });

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule], controllers: [ProbeController] }).compile();
    app = moduleRef.createNestApplication({ logger });
    configureApp(app);
    await app.listen(0, '127.0.0.1');
    base = (await app.getUrl()).replace('[::1]', '127.0.0.1');
  });

  afterAll(async () => {
    await app?.close();
  });

  it('GET /health responde fora do prefixo /v1, com a versão', async () => {
    const res = await fetch(`${base}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: 'ok', service: 'liame-api', version: expect.any(String) });
  });

  it('aceita corpo válido e entrega o valor transformado pelo schema', async () => {
    const res = await post('/v1/teste/eco', JSON.stringify({ message: '  olá  ' }));
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ message: 'olá', tags: [], length: 3 });
  });

  it('corpo inválido: 400 em problem+json, com os campos e o trace_id', async () => {
    const res = await post('/v1/teste/eco', JSON.stringify({ message: '', tags: ['ok'] }));
    expect(res.status).toBe(400);
    expect(res.headers.get('content-type')).toMatch(/^application\/problem\+json/);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      type: 'https://agencialiame.com/erros/validacao',
      code: 'validacao',
      status: 400,
      instance: '/v1/teste/eco',
      errors: [expect.objectContaining({ path: 'message' })],
    });
    expect(body.trace_id).toMatch(/^[0-9a-f]{32}$/);
  });

  it('campo extra também é validação (strictObject)', async () => {
    const res = await post('/v1/teste/eco', JSON.stringify({ message: 'oi', admin: true }));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe('validacao');
  });

  it('JSON malformado: 400 em problem+json, sem ecoar o corpo', async () => {
    const res = await post('/v1/teste/eco', '{"message": "sem fechar');
    expect(res.status).toBe(400);
    expect(res.headers.get('content-type')).toMatch(/^application\/problem\+json/);
    const texto = await res.text();
    expect(texto).not.toContain('sem fechar');
    expect(JSON.parse(texto)).toMatchObject({ code: 'requisicao-invalida', status: 400 });
  });

  it('rota inexistente: 404 "não encontramos", sem revelar a rota interna', async () => {
    const res = await fetch(`${base}/v1/nao-existe?x=1`);
    expect(res.status).toBe(404);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ code: 'nao-encontrado', title: 'Não encontramos', instance: '/v1/nao-existe' });
    expect(JSON.stringify(body)).not.toMatch(/Cannot GET/);
  });

  it('erro interno: 500 sem o dado interno na resposta, com a causa e a stack no log', async () => {
    const res = await fetch(`${base}/v1/teste/falha`);
    expect(res.status).toBe(500);
    const body = (await res.json()) as { code: string; trace_id: string; detail: string };
    expect(body.code).toBe('interno');
    expect(JSON.stringify(body)).not.toContain('liame.segredo');
    const linha = logger.lines.find((l) => l.startsWith('error') && l.includes(body.trace_id));
    expect(linha).toContain('falha proposital');
    expect(linha).toContain('probe.controller');
  });
});
