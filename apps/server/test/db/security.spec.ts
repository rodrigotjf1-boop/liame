import { resolve } from 'node:path';
import { runMigrations } from '@liame/database';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { currentStep, totpCode } from '../../src/auth/totp.js';
import { enableMfa, PASSWORD, resetIpRateLimits, signupAndLogin, startApi, type TestApi } from '../helpers/api.js';
import { hasDb, OWNER_URL } from './env.js';

// Segurança da conta: a própria pessoa vê os aparelhos, a atividade e os códigos, e encerra acessos.
const CHROME_WIN = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36';
const SAFARI_IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';

describe.skipIf(!hasDb)('segurança da conta', () => {
  let api: TestApi;

  beforeAll(async () => {
    await runMigrations({ connectionString: OWNER_URL, dir: resolve(process.cwd(), '../../packages/database/migrations') });
    api = await startApi();
  });
  beforeEach(resetIpRateLimits);
  afterAll(async () => {
    await api?.close();
  });

  /** Entra de novo com o app, num "aparelho" (user-agent) dado. */
  async function entrar(email: string, secret: string, ua: string) {
    const login = await api.call('POST', '/v1/auth/login', { body: { email, password: PASSWORD }, headers: { 'user-agent': ua } });
    expect(login.status).toBe(200);
    // Espera o próximo passo do TOTP: o mesmo código não vale duas vezes.
    const passo = currentStep();
    while (currentStep() === passo) await new Promise((r) => setTimeout(r, 250));
    const v = await api.call('POST', '/v1/me/mfa/verify', { cookie: login.cookie, body: { code: totpCode(secret, currentStep()) }, headers: { 'user-agent': ua } });
    expect(v.status).toBe(204);
    return login.cookie!;
  }

  it('aparelhos conectados: lista, encerra um e sai de todos os outros; atividade com aparelho e IP escondido', { timeout: 120_000 }, async () => {
    const dono = await signupAndLogin(api, undefined, 'Cantina Segura');
    const { secret, codes } = await enableMfa(api, dono.cookie);
    const pc = await entrar(dono.email, secret, CHROME_WIN);
    const celular = await entrar(dono.email, secret, SAFARI_IPHONE);

    const lista = await api.call('GET', '/v1/me/sessions', { cookie: pc });
    expect(lista.status).toBe(200);
    const sessoes = lista.body.sessions as { id: string; device: string; ip: string | null; current: boolean }[];
    expect(sessoes[0]).toMatchObject({ device: 'Chrome no Windows', current: true });
    expect(sessoes.map((s) => s.device)).toContain('Safari no iPhone');
    expect(sessoes.every((s) => s.ip === null || /\.x$|::x$/.test(s.ip))).toBe(true);

    // Encerrar o celular: a próxima requisição dele é recusada.
    const cel = sessoes.find((s) => s.device === 'Safari no iPhone')!;
    expect((await api.call('DELETE', `/v1/me/sessions/${cel.id}`, { cookie: pc })).status).toBe(204);
    expect((await api.call('GET', '/v1/me', { cookie: celular })).status).toBe(401);
    expect((await api.call('DELETE', `/v1/me/sessions/${cel.id}`, { cookie: pc })).status).toBe(404);

    // Sair de todos os outros: sobra só este aparelho.
    const outros = await api.call('POST', '/v1/me/sessions/revoke-others', { cookie: pc });
    expect(outros.status).toBe(200);
    expect(outros.body.revoked).toBeGreaterThanOrEqual(1);
    expect((await api.call('GET', '/v1/me', { cookie: dono.cookie })).status).toBe(401);
    expect((await api.call('GET', '/v1/me/sessions', { cookie: pc })).body.sessions).toHaveLength(1);

    // Senha errada fica na atividade, com o aparelho.
    await api.call('POST', '/v1/auth/login', { body: { email: dono.email, password: 'senha errada de teste' }, headers: { 'user-agent': SAFARI_IPHONE } });
    const eventos = (await api.call('GET', '/v1/me/security/events', { cookie: pc })).body.events as { action: string; device: string | null; detail: string | null }[];
    const acoes = eventos.map((e) => e.action);
    expect(acoes).toEqual(expect.arrayContaining(['sessao.falhar', 'sessao.abrir', 'segundo_fator.verificar', 'segundo_fator.ativar', 'sessao.encerrar', 'sessao.encerrar_outras']));
    expect(eventos.find((e) => e.action === 'sessao.falhar')).toMatchObject({ device: 'Safari no iPhone' });
    expect(eventos.find((e) => e.action === 'segundo_fator.verificar')).toMatchObject({ detail: 'totp' });
    expect(JSON.stringify(eventos)).not.toContain(dono.email);

    // Resumo e códigos novos (confirmados só com o código do app).
    const resumo = await api.call('GET', '/v1/me/security', { cookie: pc });
    expect(resumo.body).toMatchObject({ session_mfa_method: 'totp', recovery_codes_left: 10, change_request: null });
    expect(resumo.body.mfa_enabled_since).not.toBeNull();
    expect((await api.call('POST', '/v1/me/mfa/recovery-codes', { cookie: pc, body: { code: codes[0] } })).status).toBe(400);
    const passo = currentStep();
    while (currentStep() === passo) await new Promise((r) => setTimeout(r, 250));
    const novos = await api.call('POST', '/v1/me/mfa/recovery-codes', { cookie: pc, body: { code: totpCode(secret, currentStep()) } });
    expect(novos.status).toBe(200);
    expect(novos.body.recovery_codes).toHaveLength(10);
    expect(api.mailer.lastTo(dono.email)?.subject).toBe('Liame: códigos de recuperação novos');
    // Os antigos deixaram de valer: entrar com um deles é recusado.
    const login = await api.call('POST', '/v1/auth/login', { body: { email: dono.email, password: PASSWORD } });
    expect((await api.call('POST', '/v1/me/mfa/verify', { cookie: login.cookie, body: { code: codes[1] } })).status).toBe(401);
    expect((await api.call('POST', '/v1/me/mfa/verify', { cookie: login.cookie, body: { code: novos.body.recovery_codes[0] } })).status).toBe(204);
    expect((await api.call('GET', '/v1/me/security', { cookie: login.cookie })).body).toMatchObject({ session_mfa_method: 'recuperacao', recovery_codes_left: 9 });
  });

  it('ninguém vê nem encerra a sessão de outra pessoa', { timeout: 60_000 }, async () => {
    const a = await signupAndLogin(api, undefined, 'Empresa A Segura');
    await enableMfa(api, a.cookie);
    const b = await signupAndLogin(api, undefined, 'Empresa B Segura');
    await enableMfa(api, b.cookie);
    const sessaoDeB = (await api.call('GET', '/v1/me/sessions', { cookie: b.cookie })).body.sessions[0].id as string;
    expect((await api.call('GET', '/v1/me/sessions', { cookie: a.cookie })).body.sessions.map((s: { id: string }) => s.id)).not.toContain(sessaoDeB);
    expect((await api.call('DELETE', `/v1/me/sessions/${sessaoDeB}`, { cookie: a.cookie })).status).toBe(404);
    expect((await api.call('GET', '/v1/me', { cookie: b.cookie })).status).toBe(200);
  });
});
