import { randomBytes } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import pg from 'pg';
import { AppModule } from '../../src/app.module.js';
import { Mailer, type MemoryMailer } from '../../src/mail/mailer.js';
import { configureApp } from '../../src/setup.js';

export interface ApiResponse {
  status: number;
  body: any;
  headers: Headers;
  cookie: string | null;
}

/** Sobe a API para teste e devolve um cliente HTTP mínimo que guarda o cookie de sessão. */
export async function startApi() {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app: INestApplication = moduleRef.createNestApplication({ logger: false });
  configureApp(app);
  await app.listen(0, '127.0.0.1');
  const base = (await app.getUrl()).replace('[::1]', '127.0.0.1');
  const mailer = app.get(Mailer) as MemoryMailer;

  async function call(method: string, path: string, opts: { body?: unknown; cookie?: string | null; headers?: Record<string, string> } = {}): Promise<ApiResponse> {
    const headers: Record<string, string> = { ...opts.headers };
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
    body: { name: 'Pessoa de Teste', email, password: PASSWORD, company: { name: company } },
  });
  if (signup.status !== 202) throw new Error(`cadastro: ${signup.status} ${JSON.stringify(signup.body)}`);
  const verify = await api.call('POST', '/v1/auth/verify-email', { body: { token: tokenFrom(api.mailer, email) } });
  if (verify.status !== 200) throw new Error(`confirmação: ${verify.status}`);
  const login = await api.call('POST', '/v1/auth/login', { body: { email, password: PASSWORD } });
  if (login.status !== 200) throw new Error(`login: ${login.status} ${JSON.stringify(login.body)}`);
  return { email, cookie: login.cookie!, me: login.body };
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

/** Zera os contadores por IP (todos os testes saem de 127.0.0.1). */
export async function resetIpRateLimits(): Promise<void> {
  await ownerQuery(`delete from liame.rate_limit where key like '%:ip:%'`);
}
