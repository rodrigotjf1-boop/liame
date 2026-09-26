import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { loadConfig } from '../src/config.js';
import { configureApp } from '../src/setup.js';

describe('borda HTTP: cabeçalhos de segurança e CORS (security-hardening P1)', () => {
  let app: INestApplication;
  let base: string;

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

  it('toda resposta sai com os cabeçalhos de segurança e sem X-Powered-By', async () => {
    for (const path of ['/health', '/v1/me', '/v1/nao-existe']) {
      const res = await fetch(`${base}${path}`);
      expect({ path, h: Object.fromEntries(['x-content-type-options', 'x-frame-options', 'referrer-policy', 'cache-control', 'cross-origin-resource-policy'].map((k) => [k, res.headers.get(k)])) }).toEqual({
        path,
        h: {
          'x-content-type-options': 'nosniff',
          'x-frame-options': 'DENY',
          'referrer-policy': 'no-referrer',
          'cache-control': 'no-store',
          'cross-origin-resource-policy': 'same-site',
        },
      });
      expect(res.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
      expect(res.headers.get('x-powered-by')).toBeNull();
    }
  });

  it('CORS só para a origem do app, com credenciais; origem estranha não recebe permissão', async () => {
    const preflight = (origin: string) =>
      fetch(`${base}/v1/brands`, {
        method: 'OPTIONS',
        headers: { origin, 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type,idempotency-key' },
      });
    const ok = await preflight('http://localhost:3000');
    expect(ok.headers.get('access-control-allow-origin')).toBe('http://localhost:3000');
    expect(ok.headers.get('access-control-allow-credentials')).toBe('true');
    expect(ok.headers.get('access-control-allow-headers')).toContain('idempotency-key');
    const evil = await preflight('https://site-malicioso.example');
    expect(evil.headers.get('access-control-allow-origin')).toBeNull();
  });
});

describe('fail-fast da configuração em produção', () => {
  const prod = {
    NODE_ENV: 'production',
    APP_URL: 'https://app.agencialiame.com',
    MAIL_TRANSPORT: 'ses',
    AUDIT_ANCHOR_SALT: 'um-sal-bem-comprido-de-teste',
    AUDIT_ANCHOR_SIGNING_KEY: 'chave',
    REKOR_URL: 'https://rekor.exemplo.dev',
    TSA_URL: 'https://tsa.exemplo.dev/api/v1/timestamp',
  } as NodeJS.ProcessEnv;

  it('sobe com a configuração completa, cookie seguro por padrão', () => {
    expect(loadConfig(prod)).toMatchObject({ env: 'production', cookieSecure: true, appUrl: 'https://app.agencialiame.com' });
  });

  it('recusa subir sem APP_URL, com origem sem https ou com cookie inseguro', () => {
    const { APP_URL: _omit, ...semAppUrl } = prod;
    expect(() => loadConfig(semAppUrl)).toThrow('defina APP_URL');
    expect(() => loadConfig({ ...prod, APP_URL: 'http://app.agencialiame.com' })).toThrow('só com https');
    expect(() => loadConfig({ ...prod, ALLOWED_ORIGINS: 'http://outro.dev' })).toThrow('só com https');
    expect(() => loadConfig({ ...prod, COOKIE_SECURE: 'false' })).toThrow('só-HTTPS');
    expect(() => loadConfig({ ...prod, MAIL_TRANSPORT: 'memoria' })).toThrow('transporte real');
    expect(() => loadConfig({ ...prod, WEBHOOK_ALLOW_PRIVATE_NETWORK: 'true' })).toThrow('SSRF');
    expect(() => loadConfig({ ...prod, TSA_URL: undefined })).toThrow('âncora');
  });
});
