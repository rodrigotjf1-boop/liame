import { resolve } from 'node:path';
import { runMigrations } from '@liame/database';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  enableMfa,
  ownerQuery,
  PASSWORD,
  resetIpRateLimits,
  signupAndLogin,
  startApi,
  type TestApi,
  tokenFrom,
  uniqueEmail,
  TERMOS,
} from '../helpers/api.js';
import { hasDb, OWNER_URL } from './env.js';

// A agência (A7, W6, parte 1; ADR-017; D-A7-45 e D-A7-51): a organização do tipo agência, sem marca e sem assinatura,
// com a dona, o administrador e o membro. Os papéis da agência só valem na agência, e os das empresas só nas empresas.
describe.skipIf(!hasDb)('a agência e o time dela', () => {
  let api: TestApi;

  /** Quem já tem login abre a conta da agência e ativa o app autenticador. */
  async function dona(agencia = 'Agência Fogo') {
    const s = await signupAndLogin(api, undefined, `Empresa de quem abre a ${agencia}`);
    const aberta = await api.call('POST', '/v1/agencies', { cookie: s.cookie, body: { name: agencia, cnpj: '11.222.333/0001-81' } });
    expect(aberta.status).toBe(201);
    await enableMfa(api, s.cookie);
    return { ...s, agencyId: aberta.body.active_organization_id as string, empresaId: s.me.active_organization_id as string };
  }

  /** A dona (ou um administrador) convida; a pessoa cria o login pelo convite e ativa o app. */
  async function doTime(por: { cookie: string }, role: 'agencia_admin' | 'agencia_membro', comApp = true) {
    const email = uniqueEmail(role);
    const inv = await api.call('POST', '/v1/agency/invitations', { cookie: por.cookie, body: { email, role } });
    expect(inv.status).toBe(201);
    const s = await api.call('POST', '/v1/invitations/signup', {
      body: { token: tokenFrom(api.mailer, email), name: `Pessoa ${role}`, password: PASSWORD, terms_version: TERMOS },
    });
    expect(s.status).toBe(200);
    if (comApp) await enableMfa(api, s.cookie!);
    const time = await api.call('GET', '/v1/agency/team', { cookie: por.cookie });
    const membro = time.body.members.find((m: { email: string }) => m.email === email);
    return { email, cookie: s.cookie!, memberId: membro.id as string, me: s.body };
  }

  beforeAll(async () => {
    await runMigrations({ connectionString: OWNER_URL, dir: resolve(process.cwd(), '../../packages/database/migrations') });
    api = await startApi();
  });
  beforeEach(resetIpRateLimits);
  afterAll(async () => {
    await api?.close();
  });

  it('"Sou agência ou consultor" no cadastro cria a agência com a dona, sem marca e sem assinatura', async () => {
    const email = uniqueEmail('dona');
    const cadastro = await api.call('POST', '/v1/auth/signup', {
      body: { name: 'Juliana Prado', email, password: PASSWORD, company: { name: 'Agência Brasa' }, terms_version: TERMOS, kind: 'agencia' },
    });
    expect(cadastro.status).toBe(202);
    expect((await api.call('POST', '/v1/auth/verify-email', { body: { token: tokenFrom(api.mailer, email) } })).status).toBe(200);
    const login = await api.call('POST', '/v1/auth/login', { body: { email, password: PASSWORD } });
    expect(login.status).toBe(200);
    expect(login.body).toMatchObject({
      organizations: [{ name: 'Agência Brasa', role: 'agencia_dona', kind: 'agencia' }],
      permissions: ['agencia.clientes', 'agencia.time', 'agencia.ver'],
      mfa_enrollment_required: true,
    });
    const agencyId = login.body.active_organization_id as string;
    const [org] = await ownerQuery<{ kind: string; marcas: number; assinaturas: number }>(
      `select o.kind, (select count(*)::int from liame.brand b where b.tenant_id = o.id) as marcas,
              (select count(*)::int from liame.subscription s where s.tenant_id = o.id) as assinaturas
         from liame.organization o where o.id = $1`,
      [agencyId],
    );
    expect(org).toEqual({ kind: 'agencia', marcas: 0, assinaturas: 0 });
    const [evento] = await ownerQuery<{ action: string; actor_role: string }>(
      `select action, actor_role from liame.audit_event where tenant_id = $1 order by chain_seq limit 1`,
      [agencyId],
    );
    expect(evento).toEqual({ action: 'agencia.abrir', actor_role: 'agencia_dona' });
    // Sem o app autenticador, a dona ainda não usa a agência (todo o time da agência usa o app).
    const time = await api.call('GET', '/v1/agency/team', { cookie: login.cookie });
    expect(time.body.code).toBe('segundo-fator-nao-configurado');
  });

  it('quem já tem login abre a conta da agência em Sua conta: a agência vira a ativa, a empresa continua, e só uma por pessoa', async () => {
    const s = await signupAndLogin(api, undefined, 'Hamburgueria da Juliana');
    const aberta = await api.call('POST', '/v1/agencies', { cookie: s.cookie, body: { name: 'Agência Fogo' } });
    expect(aberta.status).toBe(201);
    expect(aberta.body.active_organization_id).not.toBe(s.me.active_organization_id);
    expect(
      aberta.body.organizations.map((o: { name: string; role: string; kind: string }) => `${o.name}:${o.role}:${o.kind}`).sort(),
    ).toEqual(['Agência Fogo:agencia_dona:agencia', 'Hamburgueria da Juliana:dono:empresa']);
    const outra = await api.call('POST', '/v1/agencies', { cookie: s.cookie, body: { name: 'Agência Segunda' } });
    expect(outra.status).toBe(409);
    expect(outra.body.code).toBe('ja-tem-agencia');
    // A empresa dela segue igual, com a marca.
    const [empresa] = await ownerQuery<{ kind: string; marcas: number }>(
      `select o.kind, (select count(*)::int from liame.brand b where b.tenant_id = o.id) as marcas from liame.organization o where o.id = $1`,
      [s.me.active_organization_id],
    );
    expect(empresa).toEqual({ kind: 'empresa', marcas: 1 });
  });

  it('a dona convida o time; o convite diz que é da agência, e a pessoa entra só na agência, com o app', async () => {
    const d = await dona();
    const email = uniqueEmail('membro');
    const inv = await api.call('POST', '/v1/agency/invitations', { cookie: d.cookie, body: { email, role: 'agencia_membro' } });
    expect(inv.status).toBe(201);
    expect(inv.body).toMatchObject({ email, role: 'agencia_membro' });
    expect(api.mailer.lastTo(email)?.subject).toBe('Liame: Pessoa de Teste convidou você para o time de Agência Fogo');
    const previa = await api.call('POST', '/v1/invitations/preview', { body: { token: tokenFrom(api.mailer, email) } });
    expect(previa.body).toMatchObject({ organization_name: 'Agência Fogo', organization_kind: 'agencia', role: 'agencia_membro' });

    const s = await api.call('POST', '/v1/invitations/signup', {
      body: { token: tokenFrom(api.mailer, email), name: 'Caio Lima', password: PASSWORD, terms_version: TERMOS },
    });
    expect(s.status).toBe(200);
    expect(s.body).toMatchObject({
      organizations: [{ id: d.agencyId, role: 'agencia_membro', kind: 'agencia' }],
      permissions: ['agencia.ver'],
      mfa_enrollment_required: true,
    });
    // A dona é avisada, com o caminho do time.
    expect(api.mailer.lastTo(d.email)?.text).toContain('/agencia/time');
    expect((await api.call('GET', '/v1/agency/team', { cookie: s.cookie! })).body.code).toBe('segundo-fator-nao-configurado');
    await enableMfa(api, s.cookie!);

    const time = await api.call('GET', '/v1/agency/team', { cookie: s.cookie! });
    expect(time.status).toBe(200);
    expect(time.body.agency).toEqual({ id: d.agencyId, name: 'Agência Fogo', cnpj: '11222333000181' });
    expect(time.body.members.map((m: { name: string; role: string }) => `${m.name}:${m.role}`)).toEqual([
      'Pessoa de Teste:agencia_dona',
      'Caio Lima:agencia_membro',
    ]);
    // O membro só vê: não convida.
    const tenta = await api.call('POST', '/v1/agency/invitations', { cookie: s.cookie!, body: { email: uniqueEmail(), role: 'agencia_membro' } });
    expect(tenta.status).toBe(403);
    expect(tenta.body.code).toBe('sem-permissao');
  });

  it('convidar de novo troca o link; quem já está no time não é convidado; cancelar corta o link', async () => {
    const d = await dona('Agência Convites');
    const email = uniqueEmail('convidado');
    expect((await api.call('POST', '/v1/agency/invitations', { cookie: d.cookie, body: { email, role: 'agencia_membro' } })).status).toBe(201);
    const primeiro = tokenFrom(api.mailer, email);
    const segundo = await api.call('POST', '/v1/agency/invitations', { cookie: d.cookie, body: { email, role: 'agencia_admin' } });
    expect(segundo.status).toBe(201);
    expect((await api.call('POST', '/v1/invitations/preview', { body: { token: primeiro } })).body.code).toBe('link-invalido');
    const time = await api.call('GET', '/v1/agency/team', { cookie: d.cookie });
    expect(time.body.invitations.map((v: { email: string; role: string }) => `${v.email}:${v.role}`)).toEqual([`${email}:agencia_admin`]);

    expect((await api.call('DELETE', `/v1/agency/invitations/${segundo.body.id}`, { cookie: d.cookie })).status).toBe(204);
    expect((await api.call('POST', '/v1/invitations/preview', { body: { token: tokenFrom(api.mailer, email) } })).body.code).toBe('link-invalido');

    const membro = await doTime(d, 'agencia_membro');
    const repetido = await api.call('POST', '/v1/agency/invitations', { cookie: d.cookie, body: { email: membro.email, role: 'agencia_admin' } });
    expect(repetido.status).toBe(409);
    expect(repetido.body.code).toBe('ja-esta-no-time');
  });

  it('mudar o papel e tirar do time: a dona não muda, ninguém mexe no próprio papel, e quem sai perde a agência na hora', async () => {
    const d = await dona('Agência Papéis');
    const admin = await doTime(d, 'agencia_admin');
    const membro = await doTime(d, 'agencia_membro');
    const time = await api.call('GET', '/v1/agency/team', { cookie: d.cookie });
    const daDona = time.body.members.find((m: { role: string }) => m.role === 'agencia_dona').id as string;

    // O administrador sobe o membro para administrador e o desce de novo.
    const sobe = await api.call('PATCH', `/v1/agency/members/${membro.memberId}`, { cookie: admin.cookie, body: { role: 'agencia_admin' } });
    expect(sobe.status).toBe(200);
    expect(sobe.body.role).toBe('agencia_admin');
    expect((await api.call('PATCH', `/v1/agency/members/${membro.memberId}`, { cookie: admin.cookie, body: { role: 'agencia_membro' } })).status).toBe(200);

    const naDona = await api.call('PATCH', `/v1/agency/members/${daDona}`, { cookie: admin.cookie, body: { role: 'agencia_membro' } });
    expect(naDona.body.code).toBe('dona-intocavel');
    expect((await api.call('DELETE', `/v1/agency/members/${daDona}`, { cookie: admin.cookie })).body.code).toBe('dona-intocavel');
    const proprio = await api.call('PATCH', `/v1/agency/members/${admin.memberId}`, { cookie: admin.cookie, body: { role: 'agencia_membro' } });
    expect(proprio.body.code).toBe('proprio-acesso');
    // Ninguém vira dona pelo papel: só administrador ou membro.
    expect((await api.call('PATCH', `/v1/agency/members/${membro.memberId}`, { cookie: d.cookie, body: { role: 'agencia_dona' } })).status).toBe(400);

    expect((await api.call('DELETE', `/v1/agency/members/${membro.memberId}`, { cookie: admin.cookie })).status).toBe(204);
    const depois = await api.call('GET', '/v1/agency/team', { cookie: membro.cookie });
    expect(depois.status).toBe(403);
    expect(depois.body.code).toBe('sem-empresa-ativa');
    const acoes = await ownerQuery<{ action: string }>(
      `select action from liame.audit_event where tenant_id = $1 and action like 'agencia.%' order by chain_seq`,
      [d.agencyId],
    );
    expect(acoes.map((a) => a.action)).toEqual([
      'agencia.abrir',
      'agencia.convidar',
      'agencia.convidar',
      'agencia.mudar_papel',
      'agencia.mudar_papel',
      'agencia.tirar_do_time',
    ]);
  });

  it('os papéis da agência não entram numa empresa, nem os da empresa numa agência, e o tipo não muda', async () => {
    const d = await dona('Agência Fronteira');
    // Na empresa, o convite não aceita papel da agência (o contrato recusa).
    const dono = await signupAndLogin(api, undefined, 'Empresa da Fronteira');
    await enableMfa(api, dono.cookie);
    const errado = await api.call('POST', '/v1/invitations', { cookie: dono.cookie, body: { email: uniqueEmail(), role: 'agencia_membro' } });
    expect(errado.status).toBe(400);
    // Na agência, as rotas da empresa ficam fechadas: a dona não convida pessoas para "a empresa" da agência.
    const pela = await api.call('POST', '/v1/invitations', { cookie: d.cookie, body: { email: uniqueEmail(), role: 'somente_leitura' } });
    expect(pela.status).toBe(403);
    expect(pela.body.code).toBe('sem-permissao');
    // E as da agência ficam fechadas para o dono da empresa.
    expect((await api.call('GET', '/v1/agency/team', { cookie: dono.cookie })).body.code).toBe('sem-permissao');

    // O banco confere, além do serviço.
    const empresaId = dono.me.active_organization_id as string;
    const [alguem] = await ownerQuery<{ id: string }>(`select user_id as id from liame.membership where tenant_id = $1`, [d.agencyId]);
    await expect(
      ownerQuery(`insert into liame.membership (id, tenant_id, user_id, role_key) values (gen_random_uuid(), $1, $2, 'agencia_membro')`, [
        empresaId,
        alguem!.id,
      ]),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      ownerQuery(`update liame.membership set role_key = 'gestor' where tenant_id = $1 and role_key = 'agencia_dona'`, [d.agencyId]),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      ownerQuery(
        `insert into liame.invitation (id, tenant_id, email, role_key, token_hash, expires_at, invited_by)
         values (gen_random_uuid(), $1, 'x@exemplo.com.br', 'agencia_admin', md5(random()::text), now() + interval '1 day', $2)`,
        [empresaId, alguem!.id],
      ),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(ownerQuery(`update liame.organization set kind = 'agencia' where id = $1`, [empresaId])).rejects.toMatchObject({ code: '23514' });
  });
});
