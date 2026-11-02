import { resolve } from 'node:path';
import { CreatePasskeyResponse, PasskeyCeremony, RecoveryCodesResponse } from '@liame/contracts';
import { runMigrations } from '@liame/database';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { currentStep, totpCode } from '../../src/auth/totp.js';
import { APP_CONFIG, type AppConfig } from '../../src/config.js';
import { AparelhoDeTeste } from '../helpers/aparelho-de-teste.js';
import { enableMfa, ownerQuery, resetIpRateLimits, signupAndLogin, startApi, type TestApi } from '../helpers/api.js';
import { flagDasChaves } from '../helpers/chaves.js';
import { hasDb, OWNER_URL } from './env.js';

// A chave de acesso no lugar do código do app onde ele é pedido (A7, W9, parte 9b2; D-A7-56), pelo `ConfirmacaoService`:
// aprovar um pedido (os posts aprovam pelo mesmo caminho), gerar códigos novos (quem só tem chave não tinha como), o
// pedido sem prova (400), a chave de outra pessoa, a origem errada e o desafio de uso único; com o app, o código segue
// valendo. As outras rotas (contrato, plano, agência, propriedade, encerrar a conta) chamam o mesmo serviço.

const REAL = 1_000_000;
const CHROME_WINDOWS = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36';

describe.skipIf(!hasDb)('confirmar com a chave de acesso no lugar do código do app', () => {
  let api: TestApi;
  let rp: AppConfig['passkeys'];

  const chamar = (metodo: string, caminho: string, cookie: string, body?: unknown) =>
    api.call(metodo, caminho, { cookie, body, headers: { 'user-agent': CHROME_WINDOWS } });
  /**
   * A primeira chave de quem ainda não tem segundo fator (sem confirmar; a sessão fica verificada). A flag das chaves
   * (9d) liga pela empresa da conta.
   */
  const primeiraChave = async (quem: { cookie: string; me: { active_organization_id: string | null } }): Promise<AparelhoDeTeste> => {
    await flagDasChaves(api, { tipo: 'tenant', id: quem.me.active_organization_id! }, true);
    const cookie = quem.cookie;
    const aparelho = new AparelhoDeTeste(rp.rpId, rp.origins[0]!);
    const r = await chamar('POST', '/v1/me/passkeys/registration-options', cookie, {});
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const c = PasskeyCeremony.parse(r.body);
    const criada = await chamar('POST', '/v1/me/passkeys', cookie, { challenge_id: c.challenge_id, response: aparelho.criar(c.options) });
    expect(criada.status, JSON.stringify(criada.body)).toBe(201);
    expect(CreatePasskeyResponse.parse(criada.body).recovery_codes).toHaveLength(10);
    return aparelho;
  };
  /** O desafio de confirmação da pessoa do cookie, assinado pelo aparelho dado. */
  const comChave = async (cookie: string, aparelho: AparelhoDeTeste, o: Parameters<AparelhoDeTeste['assinar']>[1] = {}) => {
    const r = await chamar('POST', '/v1/me/passkeys/confirmation-options', cookie);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const c = PasskeyCeremony.parse(r.body);
    return { challenge_id: c.challenge_id, response: aparelho.assinar(c.options, o) };
  };

  beforeAll(async () => {
    await runMigrations({ connectionString: OWNER_URL, dir: resolve(process.cwd(), '../../packages/database/migrations') });
    api = await startApi();
    rp = api.app.get<AppConfig>(APP_CONFIG).passkeys;
  });
  afterAll(async () => {
    await api?.close();
  });
  beforeEach(resetIpRateLimits);

  it('quem só tem chave aprova um pedido com ela; sem prova, 400; o código do app não serve a quem não tem o app; o desafio vale uma vez', async () => {
    const s = await signupAndLogin(api, undefined, 'Empresa Aprova Com Chave');
    const chave = await primeiraChave(s);
    const recurso = await chamar('PUT', '/v1/sandbox/resources', s.cookie, {
      account_id: 'act_1',
      resource_id: 'camp_1',
      state: { name: 'Campanha camp_1', status: 'ativa', daily_budget_micros: 100 * REAL },
    });
    expect(recurso.status, JSON.stringify(recurso.body)).toBe(200);
    expect((await chamar('POST', '/v1/policies', s.cookie, { document: { rules: [{ type: 'autonomy', mode: 'APPROVAL' }] } })).status).toBe(201);
    const pedido = await chamar('POST', '/v1/actions', s.cookie, {
      tool: 'orcamento_ajustar',
      provider: 'sandbox',
      account_id: 'act_1',
      resource_id: 'camp_1',
      params: { daily_budget_micros: 120 * REAL },
    });
    expect(pedido.status, JSON.stringify(pedido.body)).toBe(201);
    const aprovar = (prova: Record<string, unknown>) => chamar('POST', `/v1/actions/${pedido.body.id}/approve`, s.cookie, { plan_hash: pedido.body.plan_hash, ...prova });

    const semProva = await aprovar({});
    expect([semProva.status, semProva.body.code]).toEqual([400, 'confirme-que-e-voce']);
    expect((await aprovar({ code: '123456' })).body.code).toBe('segundo-fator-nao-configurado');
    // A origem errada é recusada, e o desafio fica gasto mesmo assim.
    const errada = await comChave(s.cookie, chave, { origem: 'https://outro.exemplo' });
    const recusada = await aprovar({ passkey: errada });
    expect([recusada.status, recusada.body.code]).toEqual([400, 'chave-recusada']);
    expect((await aprovar({ passkey: errada })).body.code).toBe('desafio-vencido');

    const ok = await aprovar({ passkey: await comChave(s.cookie, chave) });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body).toMatchObject({ status: 'aprovada', approvals: [{ approver_role: 'dono', sufficient: true, current_plan: true }] });
    // O uso fica na chave, com o aparelho de quem aprovou.
    expect((await chamar('GET', '/v1/me/passkeys', s.cookie)).body.items[0]).toMatchObject({ last_used_where: 'Chrome no Windows' });
  });

  it('gerar códigos novos com a chave (quem só tem chave não tinha como); a chave de outra pessoa não serve; com o app, o código segue valendo', async () => {
    const s = await signupAndLogin(api, undefined, 'Empresa Codigos Com Chave');
    const chave = await primeiraChave(s);
    const novos = await chamar('POST', '/v1/me/mfa/recovery-codes', s.cookie, { passkey: await comChave(s.cookie, chave) });
    expect(novos.status, JSON.stringify(novos.body)).toBe(200);
    expect(RecoveryCodesResponse.parse(novos.body).recovery_codes).toHaveLength(10);
    expect(api.mailer.sent.filter((m) => m.to === s.email && m.subject === 'Liame: códigos de recuperação novos')).toHaveLength(1);
    const [valendo] = await ownerQuery<{ n: string }>(
      `select count(*) as n from liame.recovery_code where user_id = (select id from liame.app_user where email = $1) and used_at is null`,
      [s.email],
    );
    expect(valendo?.n).toBe('10');

    const semProva = await chamar('POST', '/v1/me/mfa/recovery-codes', s.cookie, {});
    expect([semProva.status, semProva.body.code]).toEqual([400, 'confirme-que-e-voce']);
    // As opções são as desta pessoa, mas quem assina é o aparelho de outra: a chave não é dela.
    const outra = await signupAndLogin(api, undefined, 'Empresa Outra Chave');
    const chaveDaOutra = await primeiraChave(outra);
    const deOutra = await chamar('POST', '/v1/me/mfa/recovery-codes', s.cookie, { passkey: await comChave(s.cookie, chaveDaOutra) });
    expect([deOutra.status, deOutra.body.code]).toEqual([400, 'chave-recusada']);

    const t = await signupAndLogin(api, undefined, 'Empresa Com App Codigos');
    const { secret } = await enableMfa(api, t.cookie);
    await ownerQuery(`update liame.app_user set totp_last_step = null where email = $1`, [t.email]);
    const comApp = await chamar('POST', '/v1/me/mfa/recovery-codes', t.cookie, { code: totpCode(secret, currentStep()) });
    expect(comApp.status, JSON.stringify(comApp.body)).toBe(200);
  });
});
