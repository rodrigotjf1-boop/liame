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
} from '../helpers/api.js';
import { hasDb, OWNER_URL } from './env.js';

const REAL = 1_000_000; // micros

// ADR-017: o dono convida por e-mail quem administra por ele; ninguém dá mais poder do que tem.
describe.skipIf(!hasDb)('pessoas e convites', () => {
  let api: TestApi;

  /** Dono com o app autenticador ativo, pronto para usar as rotas de permissão. */
  async function owner(company = 'Empresa do Dono') {
    const s = await signupAndLogin(api, undefined, company);
    await enableMfa(api, s.cookie);
    return { ...s, tenantId: s.me.active_organization_id as string };
  }

  /** Convida, cria o login pelo convite e (para quem exige) ativa o app. */
  async function invited(by: { cookie: string }, role: string, extra: Record<string, unknown> = {}) {
    const email = uniqueEmail(role);
    const inv = await api.call('POST', '/v1/invitations', { cookie: by.cookie, body: { email, role, ...extra } });
    expect(inv.status).toBe(201);
    const s = await api.call('POST', '/v1/invitations/signup', {
      body: { token: tokenFrom(api.mailer, email), name: `Pessoa ${role}`, password: PASSWORD },
    });
    expect(s.status).toBe(200);
    if (role !== 'somente_leitura' && role !== 'so_relatorios') await enableMfa(api, s.cookie!);
    const people = await api.call('GET', '/v1/people', { cookie: by.cookie });
    const member = people.body.members.find((m: { email: string }) => m.email === email);
    return { email, cookie: s.cookie!, memberId: member.id as string, me: s.body };
  }

  beforeAll(async () => {
    await runMigrations({ connectionString: OWNER_URL, dir: resolve(process.cwd(), '../../packages/database/migrations') });
    api = await startApi();
  });
  beforeEach(resetIpRateLimits);
  afterAll(async () => {
    await api?.close();
  });

  it('dono convida; a pessoa cria o login pelo link, entra na empresa e o dono é avisado', async () => {
    const dono = await owner('Pizzaria Convite');
    const email = uniqueEmail('admin');
    const inv = await api.call('POST', '/v1/invitations', {
      cookie: dono.cookie,
      body: { email: email.toUpperCase(), role: 'administrador', approve_limit_micros: 100 * REAL, billing_access: true },
    });
    expect(inv.status).toBe(201);
    expect(inv.body).toMatchObject({ email, role: 'administrador', approve_limit_micros: 100 * REAL, dual_approval: true, billing_access: true });
    expect(new Date(inv.body.expires_at).getTime() - Date.now()).toBeGreaterThan(6.9 * 86400_000);

    const mail = api.mailer.lastTo(email)!;
    expect(mail.subject).toMatch(/convidou você para Pizzaria Convite/);
    expect(mail.text).toMatch(/Administrador/);
    const token = tokenFrom(api.mailer, email);

    const lista = await api.call('GET', '/v1/people', { cookie: dono.cookie });
    expect(lista.body.invitations).toEqual([expect.objectContaining({ email, invited_by_name: 'Pessoa de Teste' })]);
    expect(lista.body.members).toEqual([expect.objectContaining({ email: dono.email, role: 'dono' })]);

    const preview = await api.call('POST', '/v1/invitations/preview', { body: { token } });
    expect(preview.body).toEqual({
      organization_name: 'Pizzaria Convite',
      role: 'administrador',
      email,
      invited_by_name: 'Pessoa de Teste',
      account_exists: false,
    });

    const s = await api.call('POST', '/v1/invitations/signup', { body: { token, name: 'Juliana', password: PASSWORD } });
    expect(s.status).toBe(200);
    expect(s.cookie).toMatch(/^liame_sessao=/);
    expect(s.body).toMatchObject({
      active_organization_id: dono.tenantId,
      organizations: [{ id: dono.tenantId, role: 'administrador' }],
      mfa_enrollment_required: true,
    });
    expect(api.mailer.lastTo(dono.email)?.subject).toBe('Liame: Juliana aceitou o convite');

    // Administrador só usa a conta com o app autenticador ativo (ADR-013).
    expect((await api.call('GET', '/v1/people', { cookie: s.cookie })).body.code).toBe('segundo-fator-nao-configurado');
    await enableMfa(api, s.cookie!);
    const depois = await api.call('GET', '/v1/people', { cookie: s.cookie });
    expect(depois.status).toBe(200);
    expect(depois.body.invitations).toEqual([]);
    expect(depois.body.members.map((m: { role: string }) => m.role)).toEqual(['dono', 'administrador']);

    // Link de uso único.
    expect((await api.call('POST', '/v1/invitations/signup', { body: { token, name: 'De novo', password: PASSWORD } })).status).toBe(400);
  });

  it('o link só vale para o e-mail convidado, vence e deixa de valer quando é cancelado ou substituído', async () => {
    const dono = await owner();
    const email = uniqueEmail('vendedor');
    await api.call('POST', '/v1/invitations', { cookie: dono.cookie, body: { email, role: 'somente_leitura' } });
    const primeiro = tokenFrom(api.mailer, email);

    // Outra pessoa logada não aceita o convite de outro e-mail.
    const outra = await signupAndLogin(api);
    const recusa = await api.call('POST', '/v1/invitations/accept', { cookie: outra.cookie, body: { token: primeiro } });
    expect(recusa.status).toBe(403);
    expect(recusa.body.code).toBe('convite-de-outro-email');

    // Convidar de novo substitui: o link antigo morre.
    const again = await api.call('POST', '/v1/invitations', { cookie: dono.cookie, body: { email, role: 'somente_leitura' } });
    const segundo = tokenFrom(api.mailer, email);
    expect((await api.call('POST', '/v1/invitations/preview', { body: { token: primeiro } })).body.code).toBe('link-invalido');
    expect((await api.call('POST', '/v1/invitations/preview', { body: { token: segundo } })).status).toBe(200);

    // Vencido.
    await ownerQuery(`update liame.invitation set expires_at = now() - interval '1 second' where id = $1`, [again.body.id]);
    expect((await api.call('POST', '/v1/invitations/preview', { body: { token: segundo } })).status).toBe(400);

    // Cancelado.
    const terceiro = await api.call('POST', '/v1/invitations', { cookie: dono.cookie, body: { email, role: 'somente_leitura' } });
    const token = tokenFrom(api.mailer, email);
    expect((await api.call('DELETE', `/v1/invitations/${terceiro.body.id}`, { cookie: dono.cookie })).status).toBe(204);
    expect((await api.call('POST', '/v1/invitations/preview', { body: { token } })).status).toBe(400);
    expect((await api.call('DELETE', `/v1/invitations/${terceiro.body.id}`, { cookie: dono.cookie })).status).toBe(404);
  });

  it('a lista mostra o app autenticador e o último acesso nesta empresa, nunca a atividade em outra', async () => {
    const dono = await owner('Cantina Acesso');
    const outra = await signupAndLogin(api, undefined, 'Padaria Outra');
    await api.call('POST', '/v1/invitations', { cookie: dono.cookie, body: { email: outra.email, role: 'somente_leitura' } });
    const aceite = await api.call('POST', '/v1/invitations/accept', { cookie: outra.cookie, body: { token: tokenFrom(api.mailer, outra.email) } });
    expect(aceite.status).toBe(200);

    const pessoa = async () =>
      (await api.call('GET', '/v1/people', { cookie: dono.cookie })).body.members.find((m: { email: string }) => m.email === outra.email);
    const donoNaLista = (await api.call('GET', '/v1/people', { cookie: dono.cookie })).body.members[0];
    expect(donoNaLista).toMatchObject({ role: 'dono', mfa_enabled: true });
    expect(donoNaLista.last_seen_at).not.toBeNull();
    // Aceitou, mas ainda não usou a conta nesta empresa; e não tem o app autenticador.
    expect(await pessoa()).toMatchObject({ mfa_enabled: false, last_seen_at: null });

    expect((await api.call('GET', '/v1/me', { cookie: outra.cookie })).status).toBe(200);
    const visto = (await pessoa()).last_seen_at;
    expect(Date.now() - Date.parse(visto)).toBeLessThan(60_000);
    await enableMfa(api, outra.cookie);
    expect((await pessoa()).mfa_enabled).toBe(true);

    // Depois de trocar para a própria empresa, usá-la não mexe no último acesso desta.
    const troca = await api.call('PUT', '/v1/me/active-organization', {
      cookie: outra.cookie,
      body: { organization_id: outra.me.active_organization_id },
    });
    expect(troca.status).toBe(200);
    await ownerQuery(`update liame.membership set last_seen_at = now() - interval '2 hours' where tenant_id = $1 and user_id = $2`, [
      dono.tenantId,
      outra.me.user.id,
    ]);
    const antes = (await pessoa()).last_seen_at;
    expect((await api.call('GET', '/v1/brands', { cookie: outra.cookie })).status).toBe(200);
    expect((await pessoa()).last_seen_at).toBe(antes);
  });

  it('quem já tem conta aceita logado e passa a ter as duas empresas', async () => {
    const dono = await owner('Hamburgueria A');
    const outra = await signupAndLogin(api, undefined, 'Doceria B');
    await api.call('POST', '/v1/invitations', {
      cookie: dono.cookie,
      body: { email: outra.email, role: 'gestor', approve_limit_micros: 50 * REAL },
    });
    const token = tokenFrom(api.mailer, outra.email);
    expect((await api.call('POST', '/v1/invitations/preview', { body: { token } })).body.account_exists).toBe(true);
    const criar = await api.call('POST', '/v1/invitations/signup', { body: { token, name: 'X', password: PASSWORD } });
    expect(criar.body.code).toBe('conta-existente');

    const aceite = await api.call('POST', '/v1/invitations/accept', { cookie: outra.cookie, body: { token } });
    expect(aceite.status).toBe(200);
    expect(aceite.body.active_organization_id).toBe(dono.tenantId);
    expect(aceite.body.organizations.map((o: { name: string; role: string }) => `${o.name}:${o.role}`)).toEqual([
      'Doceria B:dono',
      'Hamburgueria A:gestor',
    ]);
    const repetido = await api.call('POST', '/v1/invitations', { cookie: dono.cookie, body: { email: outra.email, role: 'gestor', approve_limit_micros: 1 } });
    expect(repetido.status).toBe(409);
    expect(repetido.body.code).toBe('ja-tem-acesso');
  });

  it('ninguém dá mais poder do que tem', async () => {
    const dono = await owner();
    const admin = await invited(dono, 'administrador', { approve_limit_micros: 100 * REAL });
    const convite = (body: Record<string, unknown>) =>
      api.call('POST', '/v1/invitations', { cookie: admin.cookie, body: { email: uniqueEmail('x'), ...body } });

    expect((await convite({ role: 'gestor', approve_limit_micros: 200 * REAL })).body.code).toBe('limite-acima-do-seu');
    expect((await convite({ role: 'gestor', approve_limit_micros: null })).body.code).toBe('limite-acima-do-seu');
    expect((await convite({ role: 'gestor' })).status).toBe(400);
    expect((await convite({ role: 'administrador', approve_limit_micros: 10 * REAL, billing_access: true })).body.code).toBe('cobranca-so-o-dono');
    expect((await convite({ role: 'gestor', approve_limit_micros: 10 * REAL, dual_approval: false })).body.code).toBe('aprovacao-dupla-so-o-dono');
    expect((await convite({ role: 'dono' })).status).toBe(400);
    expect((await convite({ role: 'gestor', approve_limit_micros: 10 * REAL, billing_access: true })).status).toBe(400);

    const ok = await convite({ role: 'gestor', approve_limit_micros: 100 * REAL });
    expect(ok.status).toBe(201);
    // Convite feito por quem não é o dono: o dono é avisado na hora.
    expect(api.mailer.lastTo(dono.email)?.subject).toBe('Liame: Pessoa administrador convidou uma pessoa');
    expect(api.mailer.lastTo(dono.email)?.text).toMatch(/R\$\s?100,00; acima disso, o dono também aprova/);

    // Gestor não convida.
    const gestor = await invited(dono, 'gestor', { approve_limit_micros: 10 * REAL });
    const semPermissao = await api.call('POST', '/v1/invitations', {
      cookie: gestor.cookie,
      body: { email: uniqueEmail('y'), role: 'somente_leitura' },
    });
    expect(semPermissao.body.code).toBe('sem-permissao');
  });

  it('mudar e remover: o dono é intocável, ninguém mexe no próprio acesso, e a remoção vale na hora', async () => {
    const dono = await owner();
    const admin = await invited(dono, 'administrador', { approve_limit_micros: 100 * REAL });
    const leitor = await invited(dono, 'somente_leitura');
    const lista = await api.call('GET', '/v1/people', { cookie: dono.cookie });
    const donoId = lista.body.members.find((m: { role: string }) => m.role === 'dono').id;

    const patch = (cookie: string, id: string, body: Record<string, unknown>) => api.call('PATCH', `/v1/members/${id}`, { cookie, body });
    expect((await patch(admin.cookie, donoId, { role: 'gestor' })).body.code).toBe('dono-intocavel');
    expect((await api.call('DELETE', `/v1/members/${donoId}`, { cookie: admin.cookie })).body.code).toBe('dono-intocavel');
    expect((await patch(admin.cookie, admin.memberId, { approve_limit_micros: 999 * REAL })).body.code).toBe('proprio-acesso');

    // Quem passa a aprovar precisa de limite, e o limite não passa o de quem concede.
    expect((await patch(admin.cookie, leitor.memberId, { role: 'gestor' })).status).toBe(400);
    expect((await patch(admin.cookie, leitor.memberId, { role: 'gestor', approve_limit_micros: 101 * REAL })).body.code).toBe('limite-acima-do-seu');
    const promovido = await patch(admin.cookie, leitor.memberId, { role: 'gestor', approve_limit_micros: 80 * REAL });
    expect(promovido.status).toBe(200);
    expect(promovido.body).toMatchObject({ role: 'gestor', approve_limit_micros: 80 * REAL, dual_approval: true });
    expect(api.mailer.lastTo(dono.email)?.subject).toMatch(/mudou o acesso de Pessoa somente_leitura/);

    // O dono pode tudo: sem limite e sem aprovação dupla.
    const livre = await patch(dono.cookie, admin.memberId, { approve_limit_micros: null, dual_approval: false });
    expect(livre.body).toMatchObject({ approve_limit_micros: null, dual_approval: false });
    // Campo que o dono concedeu continua valendo quando o administrador mexe em outro campo.
    expect((await patch(dono.cookie, leitor.memberId, { dual_approval: false })).status).toBe(200);
    expect((await patch(admin.cookie, leitor.memberId, { approve_limit_micros: 5 * REAL })).body.dual_approval).toBe(false);

    // Remoção na hora: a próxima chamada da pessoa já não enxerga a empresa.
    expect((await api.call('GET', '/v1/brands', { cookie: admin.cookie })).status).toBe(200);
    expect((await api.call('DELETE', `/v1/members/${admin.memberId}`, { cookie: dono.cookie })).status).toBe(204);
    expect((await api.call('GET', '/v1/brands', { cookie: admin.cookie })).body.code).toBe('sem-empresa-ativa');
    expect((await api.call('GET', '/v1/me', { cookie: admin.cookie })).body.organizations).toEqual([]);
  });

  it('acesso com data de fim deixa de valer sozinho', async () => {
    const dono = await owner();
    const leitor = await invited(dono, 'somente_leitura');
    expect((await api.call('GET', '/v1/brands', { cookie: leitor.cookie })).status).toBe(200);
    await ownerQuery(`update liame.membership set expires_at = now() - interval '1 second' where id = $1`, [leitor.memberId]);
    expect((await api.call('GET', '/v1/brands', { cookie: leitor.cookie })).body.code).toBe('sem-empresa-ativa');
  });

  it('A1-3 pela API: uma empresa não vê nem mexe em pessoas e convites de outra', async () => {
    const a = await owner('Empresa A');
    const b = await owner('Empresa B');
    const leitorA = await invited(a, 'somente_leitura');
    const conviteA = await api.call('POST', '/v1/invitations', { cookie: a.cookie, body: { email: uniqueEmail('a'), role: 'somente_leitura' } });

    const pessoasB = await api.call('GET', '/v1/people', { cookie: b.cookie });
    expect(pessoasB.body.members.map((m: { email: string }) => m.email)).toEqual([b.email]);
    expect(pessoasB.body.invitations).toEqual([]);

    for (const [method, path, body] of [
      ['PATCH', `/v1/members/${leitorA.memberId}`, { role: 'gestor', approve_limit_micros: 1 }],
      ['DELETE', `/v1/members/${leitorA.memberId}`, undefined],
      ['DELETE', `/v1/invitations/${conviteA.body.id}`, undefined],
    ] as const) {
      const r = await api.call(method, path, { cookie: b.cookie, body });
      expect({ rota: `${method} ${path}`, status: r.status }).toEqual({ rota: `${method} ${path}`, status: 404 });
    }
    // Nada mudou em A.
    const pessoasA = await api.call('GET', '/v1/people', { cookie: a.cookie });
    expect(pessoasA.body.members.find((m: { id: string }) => m.id === leitorA.memberId)?.role).toBe('somente_leitura');
    expect(pessoasA.body.invitations).toHaveLength(1);
  });
});
