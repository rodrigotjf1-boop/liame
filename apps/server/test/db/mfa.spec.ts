import { resolve } from 'node:path';
import { runMigrations } from '@liame/database';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { currentStep, totpCode } from '../../src/auth/totp.js';
import { codigoErrado, ownerQuery, PASSWORD, resetIpRateLimits, signupAndLogin, startApi, type TestApi, tokenFrom } from '../helpers/api.js';
import { hasDb, OWNER_URL } from './env.js';

// ADR-013: segundo fator por app autenticador, obrigatório para Dono, Administrador, Gestor e Aprovador.
describe.skipIf(!hasDb)('segundo fator (app autenticador)', () => {
  let api: TestApi;

  const code = (secret: string, delta = 0) => totpCode(secret, currentStep() + delta);

  async function enable(cookie: string) {
    const setup = await api.call('POST', '/v1/me/mfa/totp/setup', { cookie });
    expect(setup.status).toBe(200);
    const confirm = await api.call('POST', '/v1/me/mfa/totp/confirm', { cookie, body: { code: code(setup.body.secret) } });
    expect(confirm.status).toBe(200);
    return { secret: setup.body.secret as string, codes: confirm.body.recovery_codes as string[] };
  }

  async function login(email: string) {
    const r = await api.call('POST', '/v1/auth/login', { body: { email, password: PASSWORD } });
    expect(r.status).toBe(200);
    return { cookie: r.cookie!, me: r.body };
  }

  beforeAll(async () => {
    await runMigrations({ connectionString: OWNER_URL, dir: resolve(process.cwd(), '../../packages/database/migrations') });
    api = await startApi();
  });
  beforeEach(resetIpRateLimits);
  afterAll(async () => {
    await api?.close();
  });

  it('dono sem app: /me pede a configuração e as rotas de permissão ficam bloqueadas', async () => {
    const { cookie, me } = await signupAndLogin(api);
    expect(me).toMatchObject({ mfa: 'not_configured', mfa_enrollment_required: true });
    const r = await api.call('GET', '/v1/brands', { cookie });
    expect(r.status).toBe(403);
    expect(r.body.code).toBe('segundo-fator-nao-configurado');
  });

  it('configura com QR, confirma com o código e libera o acesso', async () => {
    const { cookie } = await signupAndLogin(api, undefined, 'Pizzaria Segura');
    const setup = await api.call('POST', '/v1/me/mfa/totp/setup', { cookie });
    expect(setup.body.otpauth_uri).toMatch(/^otpauth:\/\/totp\/Liame%3A/);

    const errado = await api.call('POST', '/v1/me/mfa/totp/confirm', { cookie, body: { code: codigoErrado(setup.body.secret) } });
    expect(errado.status).toBe(401);

    const ok = await api.call('POST', '/v1/me/mfa/totp/confirm', { cookie, body: { code: code(setup.body.secret) } });
    expect(ok.status).toBe(200);
    expect(ok.body.recovery_codes).toHaveLength(10);

    const me = await api.call('GET', '/v1/me', { cookie });
    expect(me.body).toMatchObject({ mfa: 'verified', mfa_enrollment_required: false });
    const marcas = await api.call('GET', '/v1/brands', { cookie });
    expect(marcas.status).toBe(200);
    expect(marcas.body.items).toEqual([expect.objectContaining({ name: 'Pizzaria Segura' })]);
  });

  it('pedidos de QR e confirmações ao mesmo tempo não quebram (ERR-031): vale o último QR, confirma uma vez', async () => {
    const { cookie, me } = await signupAndLogin(api);
    // O modo estrito do React roda o efeito duas vezes: pedidos de QR chegam juntos.
    const pedidos = await Promise.all(Array.from({ length: 4 }, () => api.call('POST', '/v1/me/mfa/totp/setup', { cookie })));
    expect(pedidos.map((p) => p.status)).toEqual([200, 200, 200, 200]);
    const [pendentes] = await ownerQuery<{ n: string }>(
      `select count(*) as n from liame.secret where owner_user_id = $1 and purpose = 'totp_pendente' and revoked_at is null`,
      [me.user.id],
    );
    expect(Number(pendentes!.n)).toBe(1);
    // Só o QR de quem chegou por último vale; confirmações repetidas desse QR: uma entra, a outra não quebra.
    let valendo: string | null = null;
    for (const p of pedidos) {
      const [linha] = await ownerQuery<{ ok: boolean }>(
        `select exists (select 1 from liame.secret where owner_user_id = $1 and purpose = 'totp_pendente' and revoked_at is null) as ok`,
        [me.user.id],
      );
      if (!linha!.ok) break;
      const tentativa = await api.call('POST', '/v1/me/mfa/totp/confirm', { cookie, body: { code: code(p.body.secret) } });
      if (tentativa.status === 200) {
        valendo = p.body.secret as string;
        break;
      }
      expect(tentativa.status).toBe(401);
    }
    expect(valendo).not.toBeNull();
  });

  it('confirmações iguais ao mesmo tempo: uma ativa, a outra recusa sem erro 500 (ERR-031)', async () => {
    const { cookie } = await signupAndLogin(api);
    const setup = await api.call('POST', '/v1/me/mfa/totp/setup', { cookie });
    const corpo = { code: code(setup.body.secret) };
    const r = await Promise.all([1, 2, 3].map(() => api.call('POST', '/v1/me/mfa/totp/confirm', { cookie, body: corpo })));
    const status = r.map((x) => x.status).sort();
    expect(status.filter((s) => s === 200)).toHaveLength(1);
    expect(status.every((s) => s < 500)).toBe(true);
  });

  it('login novo: só /me e verificar antes do código; o mesmo código não vale duas vezes', async () => {
    const { email, cookie } = await signupAndLogin(api);
    const { secret } = await enable(cookie);

    const s = await login(email);
    expect(s.me.mfa).toBe('required');
    expect((await api.call('GET', '/v1/brands', { cookie: s.cookie })).body.code).toBe('segundo-fator-necessario');
    expect((await api.call('GET', '/v1/me', { cookie: s.cookie })).status).toBe(200);

    // O código do passo usado na confirmação já foi gasto; o do passo seguinte vale uma vez.
    const proximo = code(secret, 1);
    expect((await api.call('POST', '/v1/me/mfa/verify', { cookie: s.cookie, body: { code: proximo } })).status).toBe(204);
    expect((await api.call('GET', '/v1/brands', { cookie: s.cookie })).status).toBe(200);

    const outra = await login(email);
    const repetido = await api.call('POST', '/v1/me/mfa/verify', { cookie: outra.cookie, body: { code: proximo } });
    expect(repetido.status).toBe(401);
    expect(repetido.body.code).toBe('codigo-invalido');
  });

  it('código de recuperação entra uma vez só e avisa por e-mail', async () => {
    const { email, cookie } = await signupAndLogin(api);
    const { codes } = await enable(cookie);

    const a = await login(email);
    expect((await api.call('POST', '/v1/me/mfa/verify', { cookie: a.cookie, body: { code: codes[0]!.toLowerCase() } })).status).toBe(204);
    expect(api.mailer.lastTo(email)?.subject).toMatch(/código de recuperação usado/);

    const b = await login(email);
    expect((await api.call('POST', '/v1/me/mfa/verify', { cookie: b.cookie, body: { code: codes[0]! } })).status).toBe(401);
  });

  it('aparelho perdido: com código de recuperação, a troca só vale depois de 24 horas', async () => {
    const { email, cookie } = await signupAndLogin(api);
    const { secret: antigo, codes } = await enable(cookie);

    const s = await login(email);
    await api.call('POST', '/v1/me/mfa/verify', { cookie: s.cookie, body: { code: codes[1]! } });
    const direto = await api.call('POST', '/v1/me/mfa/totp/setup', { cookie: s.cookie });
    expect(direto.status).toBe(403);
    expect(direto.body.code).toBe('troca-do-segundo-fator-bloqueada');

    expect((await api.call('POST', '/v1/me/mfa/change-request', { cookie: s.cookie })).status).toBe(202);
    expect(api.mailer.lastTo(email)?.subject).toMatch(/pedido de troca/);
    expect((await api.call('POST', '/v1/me/mfa/totp/setup', { cookie: s.cookie })).status).toBe(403);

    // Simula as 24 horas passadas.
    await ownerQuery(
      `update liame.user_token set usable_after = now() - interval '1 second'
        where purpose = 'trocar_segundo_fator' and user_id = (select id from liame.app_user where email = $1)`,
      [email],
    );
    const setup = await api.call('POST', '/v1/me/mfa/totp/setup', { cookie: s.cookie });
    expect(setup.status).toBe(200);
    expect((await api.call('POST', '/v1/me/mfa/totp/confirm', { cookie: s.cookie, body: { code: code(setup.body.secret) } })).status).toBe(200);

    const depois = await login(email);
    const comAntigo = await api.call('POST', '/v1/me/mfa/verify', { cookie: depois.cookie, body: { code: code(antigo, 1) } });
    expect(comAntigo.status).toBe(401);
  });

  it('com o app em mãos não há pedido de espera; trocar a senha cancela o pedido pendente', async () => {
    const { email, cookie } = await signupAndLogin(api);
    const { codes } = await enable(cookie);
    const semEspera = await api.call('POST', '/v1/me/mfa/change-request', { cookie });
    expect(semEspera.status).toBe(400);
    expect(semEspera.body.code).toBe('troca-sem-espera');

    const s = await login(email);
    await api.call('POST', '/v1/me/mfa/verify', { cookie: s.cookie, body: { code: codes[2]! } });
    expect((await api.call('POST', '/v1/me/mfa/change-request', { cookie: s.cookie })).status).toBe(202);

    await api.call('POST', '/v1/auth/password/forgot', { body: { email } });
    const nova = 'outra frase comprida e nova';
    expect((await api.call('POST', '/v1/auth/password/reset', { body: { token: tokenFrom(api.mailer, email), password: nova } })).status).toBe(200);
    const pendentes = await ownerQuery(
      `select 1 from liame.user_token t join liame.app_user u on u.id = t.user_id
        where u.email = $1 and t.purpose = 'trocar_segundo_fator' and t.used_at is null`,
      [email],
    );
    expect(pendentes).toHaveLength(0);
  });

  it('somente leitura entra sem app, vê as marcas e não cria', async () => {
    const dono = await signupAndLogin(api, undefined, 'Empresa do Dono');
    const leitor = await signupAndLogin(api, undefined, 'Empresa do Leitor');
    const [u] = await ownerQuery<{ id: string }>(`select id from liame.app_user where email = $1`, [leitor.email]);
    await ownerQuery(
      `insert into liame.membership (id, tenant_id, user_id, role_key) values (gen_random_uuid(), $1, $2, 'somente_leitura')`,
      [dono.me.active_organization_id, u!.id],
    );
    await api.call('PUT', '/v1/me/active-organization', { cookie: leitor.cookie, body: { organization_id: dono.me.active_organization_id } });

    expect((await api.call('GET', '/v1/brands', { cookie: leitor.cookie })).status).toBe(200);
    const criar = await api.call('POST', '/v1/brands', { cookie: leitor.cookie, body: { name: 'Marca intrusa' } });
    expect(criar.status).toBe(403);
    expect(criar.body.code).toBe('sem-permissao');
  });
});
