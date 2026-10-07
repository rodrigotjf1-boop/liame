import { TERMS_VERSION_DEV } from '../../src/config.js';
import { randomBytes } from 'node:crypto';
import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import pg from 'pg';
import { AppModule } from '../../src/app.module.js';
import { currentStep, totpCode } from '../../src/auth/totp.js';
import { Mailer, type MemoryMailer } from '../../src/mail/mailer.js';
import { configureApp } from '../../src/setup.js';

export interface ApiResponse {
  status: number;
  body: any;
  headers: Headers;
  cookie: string | null;
}

/** IPs de origem das APIs subidas neste arquivo de teste (cada arquivo roda no próprio processo). */
const ipsDoArquivo = new Set<string>();

/** Sobe a API para teste e devolve um cliente HTTP mínimo que guarda o cookie de sessão. */
export async function startApi(options: { controllers?: Array<new (...args: never[]) => unknown> } = {}) {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule], controllers: options.controllers ?? [] }).compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>({ logger: false, rawBody: true });
  // Cada API de teste tem o próprio IP de origem, como atrás do proxy em produção (TRUST_PROXY_HOPS): os
  // arquivos rodam em paralelo contra o mesmo banco, e o limite por IP (cadastro 10/h) somava entre eles.
  app.set('trust proxy', 1);
  const ip = `10.${[...randomBytes(3)].join('.')}`;
  ipsDoArquivo.add(ip);
  configureApp(app);
  await app.listen(0, '127.0.0.1');
  const base = (await app.getUrl()).replace('[::1]', '127.0.0.1');
  const mailer = app.get(Mailer) as MemoryMailer;

  async function call(method: string, path: string, opts: { body?: unknown; cookie?: string | null; headers?: Record<string, string> } = {}): Promise<ApiResponse> {
    const headers: Record<string, string> = { 'x-forwarded-for': ip, ...opts.headers };
    if (opts.body !== undefined) headers['content-type'] = 'application/json';
    if (opts.cookie) headers.cookie = opts.cookie;
    const res = await fetch(`${base}${path}`, {
      method,
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    });
    const text = await res.text();
    const setCookie = res.headers.get('set-cookie');
    return {
      status: res.status,
      body: text ? JSON.parse(text) : null,
      headers: res.headers,
      cookie: setCookie ? (setCookie.split(';')[0] ?? null) : null,
    };
  }

  return { app, base, mailer, call, close: () => app.close() };
}

export type TestApi = Awaited<ReturnType<typeof startApi>>;

/** E-mail único por execução (o banco de testes não é zerado entre execuções). */
export function uniqueEmail(prefix = 'pessoa'): string {
  return `${prefix}.${randomBytes(5).toString('hex')}@teste.liame.dev`;
}

/** Versão dos termos fora de produção: o cadastro precisa mandar a vigente. */
export const TERMOS = TERMS_VERSION_DEV;

export const PASSWORD = 'uma frase longa de teste';

/** Token do último link enviado para o e-mail. */
export function tokenFrom(mailer: MemoryMailer, email: string): string {
  const text = mailer.lastTo(email)?.text ?? '';
  const match = /token=([A-Za-z0-9_-]+)/.exec(text);
  if (!match?.[1]) throw new Error(`nenhum link com token enviado para ${email}`);
  return match[1];
}

/** Cadastra, confirma e entra. Devolve o cookie da sessão e o `me`. */
export async function signupAndLogin(api: TestApi, email = uniqueEmail(), company = 'Restaurante de Teste') {
  const signup = await api.call('POST', '/v1/auth/signup', {
    body: { name: 'Pessoa de Teste', email, password: PASSWORD, company: { name: company }, terms_version: TERMOS },
  });
  if (signup.status !== 202) throw new Error(`cadastro: ${signup.status} ${JSON.stringify(signup.body)}`);
  const verify = await api.call('POST', '/v1/auth/verify-email', { body: { token: tokenFrom(api.mailer, email) } });
  if (verify.status !== 200) throw new Error(`confirmação: ${verify.status}`);
  const login = await api.call('POST', '/v1/auth/login', { body: { email, password: PASSWORD } });
  if (login.status !== 200) throw new Error(`login: ${login.status} ${JSON.stringify(login.body)}`);
  return { email, cookie: login.cookie!, me: login.body };
}

/** Ativa o app autenticador na sessão (níveis que o exigem só usam rotas de permissão depois disso). */
export async function enableMfa(api: TestApi, cookie: string): Promise<{ secret: string; codes: string[] }> {
  const setup = await api.call('POST', '/v1/me/mfa/totp/setup', { cookie });
  if (setup.status !== 200) throw new Error(`segundo fator: ${setup.status} ${JSON.stringify(setup.body)}`);
  const confirm = await api.call('POST', '/v1/me/mfa/totp/confirm', {
    cookie,
    body: { code: totpCode(setup.body.secret, currentStep()) },
  });
  if (confirm.status !== 200) throw new Error(`segundo fator: ${confirm.status} ${JSON.stringify(confirm.body)}`);
  return { secret: setup.body.secret, codes: confirm.body.recovery_codes };
}

/**
 * Um código de seis dígitos que o app autenticador não mostraria agora: diferente dos códigos dos passos vizinhos.
 * Um código fixo ("000000") coincide com o de verdade uma vez em algumas centenas de milhares de execuções, e o
 * teste que esperava a recusa falha sem motivo aparente (ERR-114).
 */
export function codigoErrado(secret: string): string {
  const validos = new Set([-2, -1, 0, 1, 2].map((d) => totpCode(secret, currentStep() + d)));
  for (let n = 0; ; n += 1) {
    const c = String(n).padStart(6, '0');
    if (!validos.has(c)) return c;
  }
}

/** Consulta como dono do banco, em escopo de sistema (a RLS é forçada até para o dono). */
export async function ownerQuery<T extends pg.QueryResultRow>(sqlText: string, params: unknown[] = []): Promise<T[]> {
  const client = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL_OWNER });
  await client.connect();
  try {
    await client.query('begin');
    await client.query(`select set_config('app.scope', 'sistema', true)`);
    const r = await client.query<T>(sqlText, params);
    await client.query('commit');
    return r.rows;
  } finally {
    await client.end();
  }
}

/** Zera os contadores por IP deste arquivo (os outros arquivos, rodando em paralelo, têm os próprios IPs). */
export async function resetIpRateLimits(): Promise<void> {
  if (!ipsDoArquivo.size) return;
  await ownerQuery(`delete from liame.rate_limit where split_part(key, ':ip:', 2) = any($1::text[])`, [[...ipsDoArquivo]]);
}
