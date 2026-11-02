import { resolve } from 'node:path';
import { createDatabase, runMigrations, withContext } from '@liame/database';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { currentStep, totpCode } from '../../src/auth/totp.js';
import { FlagService } from '../../src/flags/flag.service.js';
import {
  codigoErrado,
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
import { APP_URL, hasDb, OWNER_URL } from './env.js';

const REAL = 1_000_000; // micros

type Pessoa = { cookie: string; email: string; userId: string; segredo: string };
type Empresa = Pessoa & { tenantId: string };
type Agencia = Pessoa & { agencyId: string };

// O vínculo de parceiro (A7, W6, parte 2; ADR-017; D-A7-46 a D-A7-50 e D-A7-77): o pedido pelo e-mail do Dono, o aceite
// com o código do app, a recusa, mudar o que a agência pode e desfazer pelos dois lados, com a função `parceiros`.
describe.skipIf(!hasDb)('o vínculo de parceiro', () => {
  let api: TestApi;
  let flags: FlagService;

  async function empresa(nome: string): Promise<Empresa> {
    const s = await signupAndLogin(api, undefined, nome);
    const { secret } = await enableMfa(api, s.cookie);
    return { cookie: s.cookie, email: s.email, userId: s.me.user.id, segredo: secret, tenantId: s.me.active_organization_id as string };
  }

  async function agencia(nome: string): Promise<Agencia> {
    const s = await signupAndLogin(api, undefined, `Empresa de quem abre a ${nome}`);
    const aberta = await api.call('POST', '/v1/agencies', { cookie: s.cookie, body: { name: nome, cnpj: '11222333000181' } });
    expect(aberta.status).toBe(201);
    const { secret } = await enableMfa(api, s.cookie);
    return { cookie: s.cookie, email: s.email, userId: s.me.user.id, segredo: secret, agencyId: aberta.body.active_organization_id as string };
  }

  async function ligar(tenantId: string): Promise<void> {
    await ownerQuery(
      `insert into liame.feature_flag_rule (id, flag_key, scope_type, scope_id, value, created_by) values (gen_random_uuid(), 'parceiros', 'tenant', $1, 'true'::jsonb, 'testes')`,
      [tenantId],
    );
    flags.invalidate();
  }

  async function desligar(tenantId: string): Promise<void> {
    await ownerQuery(`delete from liame.feature_flag_rule where flag_key = 'parceiros' and scope_type = 'tenant' and scope_id = $1`, [tenantId]);
    flags.invalidate();
  }

  /** Um código do app que ainda não foi usado (o mesmo passo não vale duas vezes). */
  async function codigo(p: Pessoa): Promise<string> {
    await ownerQuery(`update liame.app_user set totp_last_step = null where id = $1`, [p.userId]);
    await ownerQuery(`delete from liame.rate_limit where key = $1`, [`segundo-fator:${p.userId}`]);
    return totpCode(p.segredo, currentStep());
  }

  async function pedir(a: Agencia, email: string, extra: Record<string, unknown> = {}) {
    const r = await api.call('POST', '/v1/agency/requests', { cookie: a.cookie, body: { owner_email: email, requested_role: 'gestor', ...extra } });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    return r.body as { id: string; status: string };
  }

  async function aceitar(e: Empresa, id: string, extra: Record<string, unknown> = {}) {
    return api.call('POST', `/v1/partners/requests/${id}/accept`, {
      cookie: e.cookie,
      body: { max_role: 'gestor', approve_limit_micros: 50 * REAL, code: await codigo(e), ...extra },
    });
  }

  /** Um vínculo aceito, pronto para mudar e desfazer. */
  async function vinculo(nomeEmpresa: string, nomeAgencia: string) {
    const e = await empresa(nomeEmpresa);
    const a = await agencia(nomeAgencia);
    await ligar(e.tenantId);
    const p = await pedir(a, e.email);
    const aceito = await aceitar(e, p.id);
    expect(aceito.status, JSON.stringify(aceito.body)).toBe(200);
    return { e, a, linkId: p.id };
  }

  const assuntos = (email: string) => api.mailer.sent.filter((m) => m.to === email).map((m) => m.subject);

  beforeAll(async () => {
    await runMigrations({ connectionString: OWNER_URL, dir: resolve(process.cwd(), '../../packages/database/migrations') });
    api = await startApi();
    flags = api.app.get(FlagService);
  });
  beforeEach(resetIpRateLimits);
  afterAll(async () => {
    await api?.close();
  });

  it('o pedido só chega ao Dono com a função ligada; a resposta é a mesma exista ou não a conta, e pedir de novo troca o anterior', async () => {
    const e = await empresa('Mister Burgers do Pedido');
    const a = await agencia('Agência Fogo do Pedido');

    // Desligada: o pedido fica guardado, mas nada chega ao Dono.
    const primeiro = await pedir(a, e.email, { message: 'Rodrigo, como combinamos na reunião.' });
    expect(primeiro.status).toBe('esperando');
    expect(assuntos(e.email).filter((s) => s.includes('pede para cuidar'))).toEqual([]);
    const desligada = await api.call('GET', '/v1/partners', { cookie: e.cookie });
    expect(desligada.body).toEqual({ enabled: false, requests: [], partners: [] });

    // Ligada: o pedido de novo troca o anterior e o e-mail chega, com o caminho de Pessoas e acessos.
    await ligar(e.tenantId);
    const segundo = await pedir(a, e.email, { message: 'Rodrigo, como combinamos na reunião.' });
    const email = api.mailer.lastTo(e.email)!;
    expect(email.subject).toBe('Liame: Agência Fogo do Pedido pede para cuidar da conta da sua empresa');
    expect(email.text).toContain('(CNPJ informado pela agência: 11.222.333/0001-81)');
    expect(email.text).toContain('como Gestor');
    expect(email.text).toContain('Mensagem da agência: "Rodrigo, como combinamos na reunião."');
    expect(email.text).toContain('/pessoas');
    const lista = await api.call('GET', '/v1/partners', { cookie: e.cookie });
    expect(lista.body.enabled).toBe(true);
    expect(lista.body.requests).toEqual([
      expect.objectContaining({
        id: segundo.id,
        agency: { id: a.agencyId, name: 'Agência Fogo do Pedido', cnpj: '11222333000181' },
        requested_by_name: 'Pessoa de Teste',
        requested_role: 'gestor',
        message: 'Rodrigo, como combinamos na reunião.',
      }),
    ]);

    // E-mail sem conta: a mesma resposta, e o pedido fica esperando até vencer.
    const semConta = await pedir(a, uniqueEmail('ninguem'));
    expect(semConta.status).toBe('esperando');
    const daAgencia = await api.call('GET', '/v1/agency/clients', { cookie: a.cookie });
    expect(daAgencia.body.clients).toEqual([]);
    expect(daAgencia.body.requests.map((r: { id: string; status: string }) => `${r.id}:${r.status}`).sort()).toEqual(
      [`${segundo.id}:esperando`, `${semConta.id}:esperando`].sort(),
    );

    // A mensagem não leva link.
    const comLink = await api.call('POST', '/v1/agency/requests', {
      cookie: a.cookie,
      body: { owner_email: e.email, requested_role: 'gestor', message: 'veja https://exemplo.com.br' },
    });
    expect(comLink.status).toBe(400);
    // Cancelar o pedido em aberto.
    expect((await api.call('DELETE', `/v1/agency/requests/${semConta.id}`, { cookie: a.cookie })).status).toBe(204);
    expect((await api.call('DELETE', `/v1/agency/requests/${semConta.id}`, { cookie: a.cookie })).status).toBe(404);
  });

  it('aceitar: só o Dono, com o código do app, para a empresa ativa; a agência é avisada e vê o cliente', async () => {
    const e = await empresa('Mister Burgers do Aceite');
    const a = await agencia('Agência Fogo do Aceite');
    await ligar(e.tenantId);
    const p = await pedir(a, e.email);

    // Quem não é o Dono não aceita, nem vê o pedido.
    const adminEmail = uniqueEmail('admin');
    expect(
      (await api.call('POST', '/v1/invitations', { cookie: e.cookie, body: { email: adminEmail, role: 'administrador', approve_limit_micros: 10 * REAL } })).status,
    ).toBe(201);
    const admin = await api.call('POST', '/v1/invitations/signup', {
      body: { token: tokenFrom(api.mailer, adminEmail), name: 'Ana Admin', password: PASSWORD, terms_version: TERMOS },
    });
    await enableMfa(api, admin.cookie!);
    expect((await api.call('GET', '/v1/partners', { cookie: admin.cookie! })).body.requests).toEqual([]);
    const pelaAdmin = await api.call('POST', `/v1/partners/requests/${p.id}/accept`, {
      cookie: admin.cookie!,
      body: { max_role: 'gestor', approve_limit_micros: 50 * REAL, code: '123456' },
    });
    expect(pelaAdmin.body.code).toBe('so-o-dono');

    // O código errado e o nível que aprova sem limite não passam.
    const errado = await api.call('POST', `/v1/partners/requests/${p.id}/accept`, {
      cookie: e.cookie,
      body: { max_role: 'gestor', approve_limit_micros: 50 * REAL, code: codigoErrado(e.segredo) },
    });
    expect(errado.body.code).toBe('codigo-invalido');
    const semLimite = await api.call('POST', `/v1/partners/requests/${p.id}/accept`, {
      cookie: e.cookie,
      body: { max_role: 'gestor', code: await codigo(e) },
    });
    expect(semLimite.status).toBe(400);
    // Nunca o Dono nem "só relatórios".
    expect((await aceitar(e, p.id, { max_role: 'dono' })).status).toBe(400);

    const aceito = await aceitar(e, p.id);
    expect(aceito.status, JSON.stringify(aceito.body)).toBe(200);
    expect(aceito.body).toMatchObject({ max_role: 'gestor', approve_limit_micros: 50 * REAL, dual_approval: true, ends_at: null, accepted_by_name: 'Pessoa de Teste' });
    // A agência é avisada (a dona), com o caminho de Clientes.
    const aviso = api.mailer.lastTo(a.email)!;
    expect(aviso.subject).toBe('Liame: Mister Burgers do Aceite aceitou o pedido de Agência Fogo do Aceite');
    expect(aviso.text).toContain('Até onde o time pode ir: Gestor.');
    expect(aviso.text).toContain('/agencia/clientes');

    const parceiros = await api.call('GET', '/v1/partners', { cookie: e.cookie });
    expect(parceiros.body.requests).toEqual([]);
    expect(parceiros.body.partners).toEqual([expect.objectContaining({ id: p.id, agency: expect.objectContaining({ name: 'Agência Fogo do Aceite' }), max_role: 'gestor' })]);
    // O administrador da empresa também vê a agência com acesso.
    expect((await api.call('GET', '/v1/partners', { cookie: admin.cookie! })).body.partners).toHaveLength(1);

    const clientes = await api.call('GET', '/v1/agency/clients', { cookie: a.cookie });
    expect(clientes.body.clients).toEqual([
      expect.objectContaining({ id: p.id, organization: { id: e.tenantId, name: 'Mister Burgers do Aceite' }, status: 'ativo', max_role: 'gestor' }),
    ]);
    expect(clientes.body.requests).toEqual([]);

    // O mesmo pedido não vale duas vezes, e a mesma agência não tem dois vínculos com a empresa.
    expect((await aceitar(e, p.id)).status).toBe(404);
    const outro = await pedir(a, e.email);
    const repetido = await aceitar(e, outro.id);
    expect(repetido.body.code).toBe('ja-tem-vinculo');

    const [evento] = await ownerQuery<{ action: string; after: Record<string, unknown> }>(
      `select action, after from liame.audit_event where tenant_id = $1 and action = 'parceiro.aceitar'`,
      [e.tenantId],
    );
    expect(evento!.after).toMatchObject({ agency_id: a.agencyId, max_role: 'gestor', approve_limit_micros: 50 * REAL, dual_approval: true });
  });

  it('recusar: sem o código; a agência sabe que foi recusado, sem o motivo e sem a empresa', async () => {
    const e = await empresa('Mister Burgers da Recusa');
    const a = await agencia('Agência Fogo da Recusa');
    await ligar(e.tenantId);
    const p = await pedir(a, e.email);
    expect((await api.call('POST', `/v1/partners/requests/${p.id}/refuse`, { cookie: e.cookie })).status).toBe(204);
    const aviso = api.mailer.lastTo(a.email)!;
    expect(aviso.subject).toBe('Liame: o pedido de acesso foi recusado');
    expect(aviso.text).not.toContain('Mister Burgers');
    const clientes = await api.call('GET', '/v1/agency/clients', { cookie: a.cookie });
    expect(clientes.body.clients).toEqual([]);
    expect(clientes.body.requests).toEqual([expect.objectContaining({ id: p.id, status: 'recusado', owner_email: e.email })]);
    expect(JSON.stringify(clientes.body)).not.toContain('Mister Burgers');
    // Recusado não se aceita depois.
    expect((await aceitar(e, p.id)).status).toBe(404);
  });

  it('o pedido de uma agência não aparece para outra agência nem para o Dono de outro e-mail', async () => {
    const e = await empresa('Mister Burgers do Isolamento');
    const outraEmpresa = await empresa('Outra Empresa do Isolamento');
    const a = await agencia('Agência Fogo do Isolamento');
    const b = await agencia('Agência Brasa do Isolamento');
    await ligar(e.tenantId);
    await ligar(outraEmpresa.tenantId);
    const p = await pedir(a, e.email);
    expect((await api.call('GET', '/v1/agency/clients', { cookie: b.cookie })).body.requests).toEqual([]);
    expect((await api.call('GET', '/v1/partners', { cookie: outraEmpresa.cookie })).body.requests).toEqual([]);
    expect((await aceitar(outraEmpresa, p.id)).status).toBe(404);
    expect((await api.call('DELETE', `/v1/agency/requests/${p.id}`, { cookie: b.cookie })).status).toBe(404);
  });

  it('a RLS dos dois lados, no banco: cada agência vê só os seus; o Dono, o pedido ao e-mail dele; a recusa não mostra a empresa', async () => {
    const e = await empresa('Mister Burgers da RLS');
    const a = await agencia('Agência Fogo da RLS');
    const b = await agencia('Agência Brasa da RLS');
    await ligar(e.tenantId);
    const recusado = await pedir(a, e.email);
    expect((await api.call('POST', `/v1/partners/requests/${recusado.id}/refuse`, { cookie: e.cookie })).status).toBe(204);
    const pedido = await pedir(a, e.email);

    const database = createDatabase({ connectionString: APP_URL, max: 2, applicationName: 'liame-test' });
    try {
      const ver = (ctx: { tenantId: string; userId: string }, id: string) =>
        withContext(database.db, ctx, async (tx) => (await tx.execute(sql`select id from liame.partner_link where id = ${id}`)).rows.length);
      // A agência que pediu vê; a outra não; a empresa, antes do aceite, só pelo Dono a quem o pedido foi.
      expect(await ver({ tenantId: a.agencyId, userId: a.userId }, pedido.id)).toBe(1);
      expect(await ver({ tenantId: b.agencyId, userId: b.userId }, pedido.id)).toBe(0);
      expect(await ver({ tenantId: e.tenantId, userId: a.userId }, pedido.id)).toBe(0);
      expect(await ver({ tenantId: e.tenantId, userId: e.userId }, pedido.id)).toBe(1);
      // A recusa guarda a empresa, mas a agência não enxerga o nome dela.
      const nomeDaEmpresa = await withContext(database.db, { tenantId: a.agencyId, userId: a.userId }, async (tx) =>
        (await tx.execute(sql`select name from liame.organization where id = ${e.tenantId}`)).rows.length,
      );
      expect(nomeDaEmpresa).toBe(0);
      // Uma agência não grava pedido em nome de outra.
      await expect(
        withContext(database.db, { tenantId: b.agencyId, userId: b.userId }, (tx) =>
          tx.execute(sql`
            insert into liame.partner_link (id, partner_org_id, owner_email, requested_role, request_expires_at, requested_by)
            values (gen_random_uuid(), ${a.agencyId}, 'x@exemplo.com.br', 'gestor', now() + interval '1 day', ${b.userId})`),
        ),
      ).rejects.toMatchObject({ cause: { code: '42501' } });

      // Depois do aceite, a agência enxerga o nome da empresa.
      expect((await aceitar(e, pedido.id)).status).toBe(200);
      const depois = await withContext(database.db, { tenantId: a.agencyId, userId: a.userId }, async (tx) =>
        (await tx.execute<{ name: string }>(sql`select name from liame.organization where id = ${e.tenantId}`)).rows.map((r) => r.name),
      );
      expect(depois).toEqual(['Mister Burgers da RLS']);
    } finally {
      await database.close();
    }
  });

  it('mudar o que a agência pode: baixar vale sem o código; subir pede o código, e a agência é avisada', async () => {
    const { e, a, linkId } = await vinculo('Mister Burgers da Mudança', 'Agência Fogo da Mudança');
    const mudar = (body: Record<string, unknown>) => api.call('PATCH', `/v1/partners/${linkId}`, { cookie: e.cookie, body });

    const baixa = await mudar({ max_role: 'aprovador' });
    expect(baixa.status, JSON.stringify(baixa.body)).toBe(200);
    expect(baixa.body).toMatchObject({ max_role: 'aprovador', approve_limit_micros: 50 * REAL });
    expect(api.mailer.lastTo(a.email)?.subject).toBe('Liame: Mister Burgers da Mudança mudou o que Agência Fogo da Mudança pode');
    expect((await mudar({ approve_limit_micros: 20 * REAL })).status).toBe(200);
    // Pôr uma data de fim é dar menos tempo: sem o código.
    const fim = new Date(Date.now() + 30 * 86_400_000).toISOString();
    expect((await mudar({ ends_at: fim })).status).toBe(200);

    // Subir: o nível, o limite, tirar o "eu também aprovo" e dar mais tempo pedem o código.
    for (const corpo of [{ max_role: 'administrador' }, { approve_limit_micros: 100 * REAL }, { dual_approval: false }, { ends_at: null }]) {
      const sem = await mudar(corpo);
      expect({ corpo, status: sem.status, campo: sem.body.errors?.[0]?.path }).toEqual({ corpo, status: 400, campo: 'code' });
    }
    const sobe = await mudar({ max_role: 'administrador', code: await codigo(e) });
    expect(sobe.status, JSON.stringify(sobe.body)).toBe(200);
    expect(sobe.body.max_role).toBe('administrador');
    // Só o Dono muda.
    const clientes = await api.call('GET', '/v1/agency/clients', { cookie: a.cookie });
    expect(clientes.body.clients[0]).toMatchObject({ max_role: 'administrador', approve_limit_micros: 20 * REAL, ends_at: fim });
  });

  it('desfazer pelos dois lados, na hora e sem o código, mesmo com a função desligada; o outro lado é avisado', async () => {
    // Pela empresa, com a função desligada depois do aceite.
    const um = await vinculo('Mister Burgers do Desfazer', 'Agência Fogo do Desfazer');
    await desligar(um.e.tenantId);
    const lista = await api.call('GET', '/v1/partners', { cookie: um.e.cookie });
    expect(lista.body).toMatchObject({ enabled: false, requests: [] });
    expect(lista.body.partners).toHaveLength(1);
    expect((await api.call('DELETE', `/v1/partners/${um.linkId}`, { cookie: um.e.cookie })).status).toBe(204);
    expect(api.mailer.lastTo(um.a.email)?.subject).toBe('Liame: Mister Burgers do Desfazer desfez o vínculo com Agência Fogo do Desfazer');
    expect((await api.call('GET', '/v1/partners', { cookie: um.e.cookie })).body.partners).toEqual([]);
    const daAgencia = await api.call('GET', '/v1/agency/clients', { cookie: um.a.cookie });
    expect(daAgencia.body.clients).toEqual([expect.objectContaining({ id: um.linkId, status: 'desfeito', ended_side: 'empresa' })]);
    expect((await api.call('DELETE', `/v1/partners/${um.linkId}`, { cookie: um.e.cookie })).status).toBe(404);

    // Pela agência.
    const dois = await vinculo('Mister Burgers do Deixar', 'Agência Fogo do Deixar');
    expect((await api.call('DELETE', `/v1/agency/clients/${dois.linkId}`, { cookie: dois.a.cookie })).status).toBe(204);
    const aviso = api.mailer.lastTo(dois.e.email)!;
    expect(aviso.subject).toBe('Liame: Agência Fogo do Deixar deixou de cuidar da conta de Mister Burgers do Deixar');
    expect(aviso.text).toContain('/pessoas');
    expect((await api.call('GET', '/v1/partners', { cookie: dois.e.cookie })).body.partners).toEqual([]);
    const deixou = await api.call('GET', '/v1/agency/clients', { cookie: dois.a.cookie });
    expect(deixou.body.clients).toEqual([expect.objectContaining({ id: dois.linkId, status: 'desfeito', ended_side: 'agencia' })]);
    // A agência pode pedir de novo.
    const denovo = await pedir(dois.a, dois.e.email);
    expect((await aceitar(dois.e, denovo.id)).status).toBe(200);
  });
});
