import { resolve } from 'node:path';
import { runMigrations } from '@liame/database';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  ownerQuery,
  PASSWORD,
  resetIpRateLimits,
  signupAndLogin,
  startApi,
  type TestApi,
  tokenFrom,
  uniqueEmail,
} from '../helpers/api.js';
import { hasDb, OWNER_URL } from './env.js';

describe.skipIf(!hasDb)('identidade: cadastro, e-mail, sessão, senha e empresa ativa', () => {
  let api: TestApi;

  beforeAll(async () => {
    await runMigrations({ connectionString: OWNER_URL, dir: resolve(process.cwd(), '../../packages/database/migrations') });
    api = await startApi();
  });
  beforeEach(resetIpRateLimits);
  afterAll(async () => {
    await api?.close();
  });

  it('cadastro → confirmação → login → /me com a empresa e o nível de dono', async () => {
    const email = uniqueEmail();
    const signup = await api.call('POST', '/v1/auth/signup', {
      body: { name: 'Ana Dona', email, password: PASSWORD, company: { name: 'Cantina da Ana', cnpj: '12.345.678/0001-90' } },
    });
    expect(signup.status).toBe(202);

    const antes = await api.call('POST', '/v1/auth/login', { body: { email, password: PASSWORD } });
    expect(antes.status).toBe(403);
    expect(antes.body.code).toBe('email-nao-confirmado');

    expect((await api.call('POST', '/v1/auth/verify-email', { body: { token: tokenFrom(api.mailer, email) } })).status).toBe(200);

    const login = await api.call('POST', '/v1/auth/login', { body: { email, password: PASSWORD } });
    expect(login.status).toBe(200);
    const setCookie = login.headers.get('set-cookie') ?? '';
    expect(setCookie).toMatch(/^liame_sessao=/);
    expect(setCookie).toMatch(/HttpOnly/);
    expect(setCookie).toMatch(/SameSite=Lax/);

    const me = await api.call('GET', '/v1/me', { cookie: login.cookie });
    expect(me.status).toBe(200);
    expect(me.body).toMatchObject({
      user: { name: 'Ana Dona', email },
      organizations: [{ name: 'Cantina da Ana', role: 'dono' }],
      mfa: 'not_configured',
    });
    expect(me.body.active_organization_id).toBe(me.body.organizations[0].id);

    const [org] = await ownerQuery<{ cnpj: string }>(`select cnpj from liame.organization where id = $1`, [me.body.active_organization_id]);
    expect(org?.cnpj).toBe('12345678000190');
  });

  it('cadastro com e-mail já usado responde igual e não duplica a conta', async () => {
    const { email } = await signupAndLogin(api);
    const again = await api.call('POST', '/v1/auth/signup', {
      body: { name: 'Outra', email, password: PASSWORD, company: { name: 'Outra empresa' } },
    });
    expect(again.status).toBe(202);
    expect(api.mailer.lastTo(email)?.subject).toMatch(/já tem conta/);
    const rows = await ownerQuery<{ n: string }>(`select count(*)::text as n from liame.app_user where email = $1`, [email]);
    expect(rows[0]?.n).toBe('1');
  });

  it('senha errada e e-mail inexistente dão a mesma resposta', async () => {
    const { email } = await signupAndLogin(api);
    const errada = await api.call('POST', '/v1/auth/login', { body: { email, password: 'outra frase qualquer longa' } });
    const inexistente = await api.call('POST', '/v1/auth/login', { body: { email: uniqueEmail('ninguem'), password: PASSWORD } });
    expect(errada.status).toBe(401);
    expect(inexistente.status).toBe(401);
    expect(errada.body.code).toBe('credenciais-invalidas');
    expect(inexistente.body.code).toBe('credenciais-invalidas');
    expect(errada.body.detail).toBe(inexistente.body.detail);
  });

  it('muitas tentativas no mesmo e-mail: 429 com Retry-After', async () => {
    const { email } = await signupAndLogin(api);
    let last = 0;
    let retryAfter: string | null = null;
    for (let i = 0; i < 12; i++) {
      const r = await api.call('POST', '/v1/auth/login', { body: { email, password: 'frase errada de novo aqui' } });
      last = r.status;
      retryAfter = r.headers.get('retry-after');
    }
    expect(last).toBe(429);
    expect(Number(retryAfter)).toBeGreaterThan(0);
  });

  it('senha curta é recusada com o campo indicado', async () => {
    const r = await api.call('POST', '/v1/auth/signup', {
      body: { name: 'X', email: uniqueEmail(), password: 'curta', company: { name: 'Y' } },
    });
    expect(r.status).toBe(400);
    expect(r.body.errors).toEqual([expect.objectContaining({ path: 'password' })]);
  });

  it('sair encerra a sessão', async () => {
    const { cookie } = await signupAndLogin(api);
    expect((await api.call('POST', '/v1/auth/logout', { cookie })).status).toBe(204);
    expect((await api.call('GET', '/v1/me', { cookie })).status).toBe(401);
  });

  it('link de confirmação é de uso único', async () => {
    const email = uniqueEmail();
    await api.call('POST', '/v1/auth/signup', { body: { name: 'Bia', email, password: PASSWORD, company: { name: 'Bia Lanches' } } });
    const token = tokenFrom(api.mailer, email);
    expect((await api.call('POST', '/v1/auth/verify-email', { body: { token } })).status).toBe(200);
    const again = await api.call('POST', '/v1/auth/verify-email', { body: { token } });
    expect(again.status).toBe(400);
    expect(again.body.code).toBe('link-invalido');
  });

  it('senha nova encerra as sessões antigas e só a nova vale', async () => {
    const { email, cookie } = await signupAndLogin(api);
    expect((await api.call('POST', '/v1/auth/password/forgot', { body: { email } })).status).toBe(202);
    const nova = 'outra frase comprida e nova';
    const reset = await api.call('POST', '/v1/auth/password/reset', { body: { token: tokenFrom(api.mailer, email), password: nova } });
    expect(reset.status).toBe(200);
    expect((await api.call('GET', '/v1/me', { cookie })).status).toBe(401);
    expect((await api.call('POST', '/v1/auth/login', { body: { email, password: PASSWORD } })).status).toBe(401);
    expect((await api.call('POST', '/v1/auth/login', { body: { email, password: nova } })).status).toBe(200);
  });

  it('esqueci a senha com e-mail inexistente responde igual', async () => {
    const r = await api.call('POST', '/v1/auth/password/forgot', { body: { email: uniqueEmail('ninguem') } });
    expect(r.status).toBe(202);
  });

  it('troca de empresa só para empresa com vínculo; a de outra pessoa não aparece', async () => {
    const a = await signupAndLogin(api, uniqueEmail('a'), 'Empresa A');
    const b = await signupAndLogin(api, uniqueEmail('b'), 'Empresa B');
    const orgA = a.me.active_organization_id as string;
    const orgB = b.me.active_organization_id as string;

    // Sem vínculo com B: a empresa B não aparece e não pode ser ativada (404, nunca "é de outra empresa").
    const meA = await api.call('GET', '/v1/me', { cookie: a.cookie });
    expect(meA.body.organizations.map((o: { id: string }) => o.id)).toEqual([orgA]);
    const semVinculo = await api.call('PUT', '/v1/me/active-organization', { cookie: a.cookie, body: { organization_id: orgB } });
    expect(semVinculo.status).toBe(404);

    // Com vínculo (convite aceito, simulado), a pessoa A troca para B.
    const [userA] = await ownerQuery<{ id: string }>(`select id from liame.app_user where email = $1`, [a.email]);
    await ownerQuery(
      `insert into liame.membership (id, tenant_id, user_id, role_key) values (gen_random_uuid(), $1, $2, 'somente_leitura')`,
      [orgB, userA!.id],
    );
    const troca = await api.call('PUT', '/v1/me/active-organization', { cookie: a.cookie, body: { organization_id: orgB } });
    expect(troca.status).toBe(200);
    expect(troca.body.active_organization_id).toBe(orgB);
    expect(troca.body.organizations.map((o: { role: string }) => o.role).sort()).toEqual(['dono', 'somente_leitura']);
  });

  it('mutação vinda de outra origem é recusada (além do SameSite)', async () => {
    const r = await api.call('POST', '/v1/auth/login', {
      body: { email: uniqueEmail(), password: PASSWORD },
      headers: { origin: 'https://golpe.exemplo.com' },
    });
    expect(r.status).toBe(403);
    expect(r.body.code).toBe('origem-nao-permitida');
  });
});
