import { resolve } from 'node:path';
import { CreatePasskeyResponse, MeResponse, PasskeyCeremony, PasskeysResponse } from '@liame/contracts';
import { runMigrations } from '@liame/database';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { chavePublicaDaDms, gerarChaves } from '../../src/auth/recuperacao/lacre.js';
import { currentStep, totpCode } from '../../src/auth/totp.js';
import { APP_CONFIG, type AppConfig } from '../../src/config.js';
import { AparelhoDeTeste } from '../helpers/aparelho-de-teste.js';
import { enableMfa, ownerQuery, PASSWORD, resetIpRateLimits, signupAndLogin, startApi, type TestApi } from '../helpers/api.js';
import { flagDasChaves } from '../helpers/chaves.js';
import { hasDb, OWNER_URL } from './env.js';

// As chaves de acesso (A7, W9, parte 9a; P28; D-A7-54 a D-A7-58; D-A7-87), pelo caminho inteiro, com um aparelho de teste
// que assina como um de verdade: a primeira chave sem o app (sem confirmar, com os 10 códigos); confirmar com a chave
// para criar outra; o mesmo gerenciador não repete; renomear e tirar (a última não sai sem o app); a chave no lugar do
// código do app na entrada, recusando origem errada e aparelho que não confirma a pessoa; o pedido de recuperação que
// cai; entrar sem senha com a chave (parte 9b); e as restrições do banco.

const GOOGLE = 'ea9b8d66-4d01-1d21-3ce4-b6b48cb575d4';
const WINDOWS = '08987058-cadc-4b81-b6e1-30de50dcbe96';
const CHROME_WINDOWS = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36';

describe.skipIf(!hasDb)('as chaves de acesso', () => {
  let api: TestApi;
  let rp: AppConfig['passkeys'];

  const aparelho = (aaguid?: string, sincroniza = true) => new AparelhoDeTeste(rp.rpId, rp.origins[0]!, aaguid, sincroniza);
  const chamar = (metodo: string, caminho: string, cookie: string, body?: unknown) =>
    api.call(metodo, caminho, { cookie, body, headers: { 'user-agent': CHROME_WINDOWS } });
  const cerimonia = async (caminho: string, cookie: string, body: unknown = {}) => {
    const r = await chamar('POST', caminho, cookie, body);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    return PasskeyCeremony.parse(r.body);
  };
  const criar = async (cookie: string, a: AparelhoDeTeste, confirmar: unknown = {}, nome?: string) => {
    const c = await cerimonia('/v1/me/passkeys/registration-options', cookie, confirmar);
    return chamar('POST', '/v1/me/passkeys', cookie, { challenge_id: c.challenge_id, response: a.criar(c.options), ...(nome ? { name: nome } : {}) });
  };
  const confirmarCom = async (cookie: string, a: AparelhoDeTeste) => {
    const c = await cerimonia('/v1/me/passkeys/confirmation-options', cookie);
    return { passkey: { challenge_id: c.challenge_id, response: a.assinar(c.options) } };
  };
  const listar = async (cookie: string) => PasskeysResponse.parse((await chamar('GET', '/v1/me/passkeys', cookie)).body);
  const me = async (cookie: string) => MeResponse.parse((await api.call('GET', '/v1/me', { cookie })).body);
  const soASenha = async (email: string) => (await api.call('POST', '/v1/auth/login', { body: { email, password: PASSWORD } })).cookie!;

  beforeAll(async () => {
    await runMigrations({ connectionString: OWNER_URL, dir: resolve(process.cwd(), '../../packages/database/migrations') });
    api = await startApi();
    rp = api.app.get<AppConfig>(APP_CONFIG).passkeys;
    // As chaves nascem desligadas (9d): ligadas para o ambiente neste arquivo; o caso desligado tem o teste dele.
    await flagDasChaves(api, { tipo: 'environment' }, true);
  });
  afterAll(async () => {
    if (api) await flagDasChaves(api, { tipo: 'environment' }, null);
    await api?.close();
  });
  beforeEach(resetIpRateLimits);

  it('a flag desligada (9d): o cadastro e a entrada sem senha recusam com 409; a lista diz que não dá para criar; a chave que já existe continua valendo', async () => {
    const s = await signupAndLogin(api, undefined, 'Empresa Chaves Desligadas');
    const chave = aparelho(GOOGLE);
    expect((await criar(s.cookie, chave)).status).toBe(201);
    expect((await listar(s.cookie)).can_create).toBe(true);
    // A regra da pessoa vence a do ambiente: para ela, desligada.
    const eu = s.me.user.id;
    await flagDasChaves(api, { tipo: 'user', id: eu }, false);
    try {
      expect((await listar(s.cookie)).can_create).toBe(false);
      const recusado = await chamar('POST', '/v1/me/passkeys/registration-options', s.cookie, await confirmarCom(s.cookie, chave));
      expect([recusado.status, recusado.body.code]).toEqual([409, 'funcao-desligada']);
      // O que já existe continua valendo: confirmar com a chave (gerar códigos novos, aprovar, o segundo fator).
      const codigos = await chamar('POST', '/v1/me/mfa/recovery-codes', s.cookie, await confirmarCom(s.cookie, chave));
      expect(codigos.status, JSON.stringify(codigos.body)).toBe(200);
      // A entrada sem senha segue só a regra do ambiente (ninguém entrou ainda): sem ela, desligada para todos.
      await flagDasChaves(api, { tipo: 'environment' }, null);
      const entrada = await api.call('POST', '/v1/auth/passkey-options', {});
      expect([entrada.status, entrada.body.code]).toEqual([409, 'funcao-desligada']);
    } finally {
      await flagDasChaves(api, { tipo: 'user', id: eu }, null);
      await flagDasChaves(api, { tipo: 'environment' }, true);
    }
  });

  it('a primeira chave sem o app traz os 10 códigos; confirmar com a chave para criar outra; o mesmo gerenciador não repete; renomear e tirar', async () => {
    const s = await signupAndLogin(api, undefined, 'Empresa Só Chaves');
    const primeiro = aparelho();
    const r = await criar(s.cookie, primeiro);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const criada = CreatePasskeyResponse.parse(r.body);
    expect(criada.passkey).toMatchObject({ name: 'Chave sincronizada', synced: true, last_used_at: null });
    expect(criada.recovery_codes).toHaveLength(10);
    // A sessão ficou verificada com a chave, e o /me mostra a forma de segundo fator.
    expect(await me(s.cookie)).toMatchObject({ mfa: 'verified', mfa_methods: ['chave'] });
    expect(api.mailer.sent.filter((m) => m.to === s.email && m.subject === 'Liame: chave de acesso criada')).toHaveLength(1);

    // Para criar outra: confirmar que é ela (sem nada, 400; com código sem ter o app, 400; com a chave, passa).
    expect((await chamar('POST', '/v1/me/passkeys/registration-options', s.cookie, {})).body.code).toBe('confirme-que-e-voce');
    expect((await chamar('POST', '/v1/me/passkeys/registration-options', s.cookie, { code: '123456' })).body.code).toBe('sem-app');
    const google = aparelho(GOOGLE);
    const segunda = await criar(s.cookie, google, await confirmarCom(s.cookie, primeiro));
    expect(segunda.status, JSON.stringify(segunda.body)).toBe(201);
    expect(CreatePasskeyResponse.parse(segunda.body)).toMatchObject({ passkey: { name: 'Senhas do Google' }, recovery_codes: null });
    // O mesmo gerenciador não repete; o desafio não vale duas vezes.
    const repetida = await criar(s.cookie, aparelho(GOOGLE), await confirmarCom(s.cookie, primeiro));
    expect([repetida.status, repetida.body.code]).toEqual([409, 'mesmo-gerenciador']);
    const c = await cerimonia('/v1/me/passkeys/registration-options', s.cookie, await confirmarCom(s.cookie, primeiro));
    const windows = aparelho(WINDOWS, false);
    expect((await chamar('POST', '/v1/me/passkeys', s.cookie, { challenge_id: c.challenge_id, response: windows.criar(c.options) })).status).toBe(201);
    expect((await chamar('POST', '/v1/me/passkeys', s.cookie, { challenge_id: c.challenge_id, response: windows.criar(c.options) })).body.code).toBe('desafio-vencido');

    const lista = await listar(s.cookie);
    expect(lista).toMatchObject({ max: 10, has_totp: false });
    expect(lista.items.map((k) => [k.name, k.synced])).toEqual([
      ['Chave sincronizada', true],
      ['Senhas do Google', true],
      ['Windows Hello', false],
    ]);
    // A chave usada para confirmar ganha o último uso, com o aparelho.
    expect(lista.items[0]).toMatchObject({ last_used_where: 'Chrome no Windows' });

    // Renomear e tirar; a última não sai sem o app.
    const [a, b, w] = lista.items;
    expect((await chamar('PATCH', `/v1/me/passkeys/${a!.id}`, s.cookie, { name: 'Celular da loja' })).body.items[0].name).toBe('Celular da loja');
    expect((await chamar('DELETE', `/v1/me/passkeys/${w!.id}`, s.cookie)).status).toBe(200);
    expect((await chamar('DELETE', `/v1/me/passkeys/${b!.id}`, s.cookie)).status).toBe(200);
    const ultima = await chamar('DELETE', `/v1/me/passkeys/${a!.id}`, s.cookie);
    expect([ultima.status, ultima.body.code]).toEqual([409, 'ultima-chave']);
    expect(api.mailer.sent.filter((m) => m.to === s.email && m.subject === 'Liame: chave de acesso tirada')).toHaveLength(2);
  });

  it('com o app: criar confirma com o código; na entrada, a chave vale pelo código do app; o pedido de recuperação cai', async () => {
    const s = await signupAndLogin(api, undefined, 'Empresa Com App');
    const { secret } = await enableMfa(api, s.cookie);
    await ownerQuery(`update liame.app_user set totp_last_step = null where email = $1`, [s.email]);
    const chave = aparelho(GOOGLE);
    const r = await criar(s.cookie, chave, { code: totpCode(secret, currentStep()) });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(CreatePasskeyResponse.parse(r.body).recovery_codes).toBeNull();

    // A sessão só da senha: o /me pede o segundo fator e mostra as duas formas.
    const cookie = await soASenha(s.email);
    expect(await me(cookie)).toMatchObject({ mfa: 'required', mfa_methods: ['totp', 'chave'] });
    // Um pedido de recuperação em andamento, para ver que cai ao entrar com a chave.
    const config = api.app.get<AppConfig>(APP_CONFIG);
    config.recuperacaoChavePublica = chavePublicaDaDms(gerarChaves(3072).publica);
    const pedido = await api.call('POST', '/v1/me/account-recovery?reason=outro', { cookie, raw: { data: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2]), type: 'image/jpeg' } });
    expect(pedido.status, JSON.stringify(pedido.body)).toBe(201);

    // Origem errada e aparelho que não confirma a pessoa: recusados (e o desafio já foi usado).
    let c = await cerimonia('/v1/me/mfa/passkey-options', cookie);
    expect((await chamar('POST', '/v1/me/mfa/passkey', cookie, { challenge_id: c.challenge_id, response: chave.assinar(c.options, { origem: 'https://outro.exemplo' }) })).body.code).toBe('chave-recusada');
    expect((await chamar('POST', '/v1/me/mfa/passkey', cookie, { challenge_id: c.challenge_id, response: chave.assinar(c.options) })).body.code).toBe('desafio-vencido');
    c = await cerimonia('/v1/me/mfa/passkey-options', cookie);
    expect((await chamar('POST', '/v1/me/mfa/passkey', cookie, { challenge_id: c.challenge_id, response: chave.assinar(c.options, { uv: false }) })).body.code).toBe('chave-recusada');
    // Outra pessoa não usa a chave de quem não é ela.
    const outra = await signupAndLogin(api, undefined, 'Empresa Outra');
    await enableMfa(api, outra.cookie);
    expect((await chamar('POST', '/v1/me/mfa/passkey-options', await soASenha(outra.email))).body.code).toBe('sem-chave');

    c = await cerimonia('/v1/me/mfa/passkey-options', cookie);
    const ok = await chamar('POST', '/v1/me/mfa/passkey', cookie, { challenge_id: c.challenge_id, response: chave.assinar(c.options) });
    expect(ok.status, JSON.stringify(ok.body)).toBe(204);
    expect(await me(cookie)).toMatchObject({ mfa: 'verified' });
    const [sessao] = await ownerQuery<{ mfa_method: string }>(`select mfa_method from liame.session where user_id = (select id from liame.app_user where email = $1) order by created_at desc limit 1`, [s.email]);
    expect(sessao?.mfa_method).toBe('chave');
    expect((await api.call('GET', '/v1/me/account-recovery', { cookie })).body.recovery).toMatchObject({ status: 'cancelado', cancelled_by: 'entrou' });
    // De novo na mesma sessão: já entrou.
    expect((await chamar('POST', '/v1/me/mfa/passkey-options', cookie)).body.code).toBe('ja-entrou');
  });

  it('Segurança da conta (9c1): quem só tem chave não aparece com o app ativo; a atividade mostra criar, renomear, tirar e entrar com a chave, com o nome', async () => {
    const s = await signupAndLogin(api, undefined, 'Empresa Atividade Chaves');
    const primeira = aparelho(GOOGLE);
    expect((await criar(s.cookie, primeira)).status).toBe(201);
    // A primeira chave acende o segundo fator (e os 10 códigos), mas não é o app.
    expect((await chamar('GET', '/v1/me/security', s.cookie)).body).toMatchObject({ mfa_enabled_since: null, recovery_codes_left: 10, session_mfa_method: 'chave' });

    const segunda = aparelho(WINDOWS, false);
    expect((await criar(s.cookie, segunda, await confirmarCom(s.cookie, primeira))).status).toBe(201);
    const windows = (await listar(s.cookie)).items.find((k) => k.name === 'Windows Hello')!;
    expect((await chamar('PATCH', `/v1/me/passkeys/${windows.id}`, s.cookie, { name: 'Notebook' })).status).toBe(200);
    expect((await chamar('DELETE', `/v1/me/passkeys/${windows.id}`, s.cookie)).status).toBe(200);
    const c = PasskeyCeremony.parse((await api.call('POST', '/v1/auth/passkey-options', { headers: { 'user-agent': CHROME_WINDOWS } })).body);
    const entrou = await api.call('POST', '/v1/auth/passkey', { body: { challenge_id: c.challenge_id, response: primeira.assinar(c.options) }, headers: { 'user-agent': CHROME_WINDOWS } });
    expect(entrou.status, JSON.stringify(entrou.body)).toBe(200);

    const eventos = (await chamar('GET', '/v1/me/security/events', entrou.cookie!)).body.events as { action: string; detail: string | null; key_name: string | null }[];
    expect(eventos.slice(0, 6).map((e) => [e.action, e.detail, e.key_name])).toEqual([
      ['sessao.abrir', 'chave', 'Senhas do Google'],
      ['segundo_fator.chave_tirar', null, 'Notebook'],
      ['segundo_fator.chave_renomear', null, 'Notebook'],
      ['segundo_fator.chave_criar', null, 'Windows Hello'],
      ['segundo_fator.chave_criar', null, 'Senhas do Google'],
      ['sessao.abrir', null, null],
    ]);
  });

  it('entrar sem senha com a chave (9b): a sessão nasce verificada; o desafio vale uma vez; a chave de outra pessoa, a que saiu e a pessoa desativada não entram', async () => {
    const s = await signupAndLogin(api, undefined, 'Empresa Entra Com Chave');
    const chave = aparelho(GOOGLE);
    expect((await criar(s.cookie, chave)).status).toBe(201);
    const comoNavegador = { 'user-agent': CHROME_WINDOWS };
    const opcoes = async () => {
      const r = await api.call('POST', '/v1/auth/passkey-options', { headers: comoNavegador });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      return PasskeyCeremony.parse(r.body);
    };
    const entrar = async (a: AparelhoDeTeste, o: Parameters<AparelhoDeTeste['assinar']>[1] = {}) => {
      const c = await opcoes();
      return api.call('POST', '/v1/auth/passkey', { body: { challenge_id: c.challenge_id, response: a.assinar(c.options, o) }, headers: comoNavegador });
    };
    const eventos = async () =>
      ownerQuery<{ action: string; after: Record<string, unknown> | null }>(
        `select e.action, e."after" from liame.audit_event e join liame.app_user u on u.id = e.actor_id
          where u.email = $1 and e.tenant_id is null and e.action in ('sessao.abrir', 'sessao.falhar') order by e.chain_seq`,
        [s.email],
      );

    // As opções não dizem quais chaves existem: a do aparelho diz quem é.
    const c = await opcoes();
    expect((c.options as { allowCredentials?: unknown[] }).allowCredentials ?? []).toEqual([]);
    expect(c.options).toMatchObject({ rpId: rp.rpId, userVerification: 'required' });
    const r = await api.call('POST', '/v1/auth/passkey', { body: { challenge_id: c.challenge_id, response: chave.assinar(c.options) }, headers: comoNavegador });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(MeResponse.parse(r.body)).toMatchObject({ user: { email: s.email }, mfa: 'verified', mfa_methods: ['chave'] });
    expect(await me(r.cookie!)).toMatchObject({ mfa: 'verified' });
    const [sessao] = await ownerQuery<{ mfa_method: string; verificada: boolean }>(
      `select mfa_method, mfa_verified_at is not null as verificada from liame.session
        where user_id = (select id from liame.app_user where email = $1) order by created_at desc limit 1`,
      [s.email],
    );
    expect(sessao).toEqual({ mfa_method: 'chave', verificada: true });
    // Como na entrada com senha: o aviso de acesso novo (outro navegador) e o evento na auditoria da pessoa.
    expect(api.mailer.sent.filter((m) => m.to === s.email && m.subject === 'Liame: novo acesso à sua conta')).toHaveLength(1);
    expect((await eventos()).at(-1)).toEqual({ action: 'sessao.abrir', after: expect.objectContaining({ metodo: 'chave', chave: 'Senhas do Google', aparelho: 'Chrome no Windows' }) });
    expect((await listar(r.cookie!)).items[0]).toMatchObject({ last_used_where: 'Chrome no Windows' });

    // O desafio vale uma vez.
    const repetida = await api.call('POST', '/v1/auth/passkey', { body: { challenge_id: c.challenge_id, response: chave.assinar(c.options) }, headers: comoNavegador });
    expect([repetida.status, repetida.body.code]).toEqual([400, 'desafio-vencido']);
    // Origem errada, aparelho que não confirma a pessoa, sem o identificador ou com o de outra pessoa: recusada, e a falha
    // fica na auditoria da dona da chave.
    for (const o of [{ origem: 'https://outro.exemplo' }, { uv: false }, { usuario: null }, { usuario: 'identificador_de_outra_pessoa' }]) {
      const recusada = await entrar(chave, o);
      expect([recusada.status, recusada.body.code, recusada.cookie ?? null], JSON.stringify(o)).toEqual([401, 'chave-recusada', null]);
    }
    expect((await eventos()).filter((e) => e.action === 'sessao.falhar')).toHaveLength(4);
    expect((await eventos()).at(-1)?.after).toMatchObject({ metodo: 'chave' });
    // A chave que nunca foi cadastrada não diz de quem seria.
    expect((await entrar(aparelho(WINDOWS))).body.code).toBe('chave-desconhecida');
    // A pessoa desativada não entra, nem com a chave certa.
    await ownerQuery(`update liame.app_user set disabled_at = now() where email = $1`, [s.email]);
    expect((await entrar(chave)).body.code).toBe('chave-recusada');
    await ownerQuery(`update liame.app_user set disabled_at = null where email = $1`, [s.email]);
    // A chave tirada da conta não abre mais (ela continua no gerenciador do aparelho).
    const outra = aparelho(WINDOWS);
    expect((await criar(r.cookie!, outra, await confirmarCom(r.cookie!, chave))).status).toBe(201);
    const tirar = (await listar(r.cookie!)).items.find((k) => k.name === 'Senhas do Google')!;
    expect((await chamar('DELETE', `/v1/me/passkeys/${tirar.id}`, r.cookie!)).status).toBe(200);
    expect((await entrar(chave)).body.code).toBe('chave-desconhecida');
    expect((await entrar(outra)).status).toBe(200);
  });

  it('as restrições do banco (V119): cada check recusa o valor errado, pelo nome', async () => {
    const s = await signupAndLogin(api, undefined, 'Empresa Restricoes Chaves');
    const [u] = await ownerQuery<{ id: string }>(`select id from liame.app_user where email = $1`, [s.email]);
    const restricao = async (texto: string, params: unknown[] = []): Promise<string | undefined> => {
      try {
        await ownerQuery(texto, params);
        return undefined;
      } catch (err) {
        const e = err as { constraint?: string; message?: string };
        return e.constraint ?? `sem restrição: ${e.message}`;
      }
    };
    expect(await restricao(`update liame.app_user set webauthn_user_id = 'curto' where id = $1`, [u!.id])).toBe('app_user_webauthn_user_id_check');
    const chave = (o: Record<string, string>) =>
      restricao(
        `insert into liame.passkey (id, user_id, credential_id, public_key, counter, device_type, backed_up, aaguid, name, last_used_where)
         values (gen_random_uuid(), $1, $2, '\\x00', $3, $4, true, $5, $6, $7)`,
        [u!.id, o.credencial ?? `cred_${Date.now()}_abcdefghij`, o.contador ?? '0', o.tipo ?? 'multiDevice', o.aaguid ?? '00000000-0000-0000-0000-000000000000', o.nome ?? 'Chave', o.onde ?? null],
      );
    expect(await chave({})).toBeUndefined();
    expect(await chave({ credencial: 'curta' })).toBe('passkey_credential_id_check');
    expect(await chave({ contador: '-1' })).toBe('passkey_counter_check');
    expect(await chave({ tipo: 'algum' })).toBe('passkey_device_type_check');
    expect(await chave({ aaguid: 'ABC' })).toBe('passkey_aaguid_check');
    expect(await chave({ nome: '' })).toBe('passkey_name_check');
    expect(await chave({ onde: '' })).toBe('passkey_last_used_where_check');
    const desafio = (proposito: string, desafioTexto: string, comPessoa: boolean) =>
      restricao(
        `insert into liame.webauthn_challenge (id, user_id, purpose, challenge, expires_at) values (gen_random_uuid(), $1, $2, $3, now())`,
        [comPessoa ? u!.id : null, proposito, desafioTexto],
      );
    expect(await desafio('cadastrar', 'desafio_bem_comprido_123', true)).toBeUndefined();
    expect(await desafio('entrar', 'desafio_bem_comprido_123', false)).toBeUndefined();
    expect(await desafio('abrir', 'desafio_bem_comprido_123', true)).toBe('webauthn_challenge_purpose_check');
    expect(await desafio('cadastrar', 'curto', true)).toBe('webauthn_challenge_challenge_check');
    expect(await desafio('entrar', 'desafio_bem_comprido_123', true)).toBe('webauthn_challenge_dono');
    expect(await desafio('cadastrar', 'desafio_bem_comprido_123', false)).toBe('webauthn_challenge_dono');
    expect(await restricao(`update liame.session set mfa_method = 'chave' where user_id = $1`, [u!.id])).toBeUndefined();
    expect(await restricao(`update liame.session set mfa_method = 'sms' where user_id = $1`, [u!.id])).toBe('session_mfa_method_check');
    await ownerQuery(`delete from liame.passkey where user_id = $1`, [u!.id]);
    await ownerQuery(`delete from liame.webauthn_challenge where user_id = $1 or (user_id is null and challenge = 'desafio_bem_comprido_123')`, [u!.id]);
  });
});
