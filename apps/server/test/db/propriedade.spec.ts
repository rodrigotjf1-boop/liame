import { resolve } from 'node:path';
import { OwnershipResponse } from '@liame/contracts';
import { createDatabase, type Database, runMigrations, withContext } from '@liame/database';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { currentStep, totpCode } from '../../src/auth/totp.js';
import { enableMfa, ownerQuery, PASSWORD, resetIpRateLimits, signupAndLogin, startApi, type TestApi, TERMOS, tokenFrom, uniqueEmail } from '../helpers/api.js';
import { APP_URL, hasDb, OWNER_URL } from './env.js';

// A transferência da propriedade da conta (A7, W8, parte 2; ADR-017; P34; D-A7-59 a D-A7-61), pelo caminho inteiro: só o
// Dono pede, com o código do app, para um Administrador com o app; o pedido aparece só para os dois; quem recebe aceita
// com o código dela e os Termos de agora; na troca, o Dono antigo fica como Administrador sem a cobrança, ou sai; quem
// acabou de receber espera 7 dias para transferir de novo; cancelar, recusar e vencer não mudam nada; a RLS separa as
// empresas.

const REAL = 1_000_000;
type Pessoa = { cookie: string; email: string; userId: string; segredo: string };

describe.skipIf(!hasDb)('a transferência da propriedade da conta', () => {
  let api: TestApi;
  let database: Database;

  async function codigo(p: { userId: string; segredo: string }): Promise<string> {
    await ownerQuery(`update liame.app_user set totp_last_step = null where id = $1`, [p.userId]);
    await ownerQuery(`delete from liame.rate_limit where key = $1`, [`segundo-fator:${p.userId}`]);
    return totpCode(p.segredo, currentStep());
  }

  async function convidar(cookie: string, role: string, nome: string, comApp = true): Promise<Pessoa> {
    const email = uniqueEmail(role);
    const inv = await api.call('POST', '/v1/invitations', { cookie, body: { email, role, ...(role === 'administrador' || role === 'gestor' ? { approve_limit_micros: 100 * REAL } : {}) } });
    expect(inv.status, JSON.stringify(inv.body)).toBe(201);
    const r = await api.call('POST', '/v1/invitations/signup', { body: { token: tokenFrom(api.mailer, email), name: nome, password: PASSWORD, terms_version: TERMOS } });
    return { cookie: r.cookie!, email, userId: r.body.user.id as string, segredo: comApp ? (await enableMfa(api, r.cookie!)).secret : '' };
  }

  async function empresa(nome: string) {
    const s = await signupAndLogin(api, undefined, `Empresa ${nome}`);
    const dono = { cookie: s.cookie, email: s.email, userId: s.me.user.id as string, segredo: (await enableMfa(api, s.cookie)).secret };
    const tenantId = s.me.active_organization_id as string;
    const admin = await convidar(dono.cookie, 'administrador', 'Ana Lima');
    const semApp = await convidar(dono.cookie, 'administrador', 'Bia Sem App', false);
    const gestor = await convidar(dono.cookie, 'gestor', 'Caio Gestor');
    return { dono, admin, semApp, gestor, tenantId, nome: `Empresa ${nome}` };
  }

  const ler = (p: { cookie: string }) => api.call('GET', '/v1/ownership', { cookie: p.cookie });
  const pedir = async (dono: Pessoa, para: string, fica = true) =>
    api.call('POST', '/v1/ownership/transfers', { cookie: dono.cookie, body: { to_user_id: para, old_owner_stays: fica, code: await codigo(dono) } });
  const aceitar = async (p: Pessoa, id: string, termos = TERMOS) =>
    api.call('POST', `/v1/ownership/transfers/${id}/accept`, { cookie: p.cookie, body: { code: await codigo(p), terms_version: termos } });
  const papel = async (tenantId: string, userId: string) =>
    (await ownerQuery<{ role_key: string; revoked: boolean; billing_access: boolean }>(
      `select role_key, revoked_at is not null as revoked, billing_access from liame.membership where tenant_id = $1 and user_id = $2`,
      [tenantId, userId],
    ))[0];

  beforeAll(async () => {
    await runMigrations({ connectionString: OWNER_URL, dir: resolve(process.cwd(), '../../packages/database/migrations') });
    api = await startApi();
    database = createDatabase({ connectionString: APP_URL, max: 4, applicationName: 'liame-test' });
  }, 120_000);
  beforeEach(resetIpRateLimits);
  afterAll(async () => {
    await api?.close();
    await database?.close();
  });

  it('só o Dono pede, para um Administrador com o app; o pedido aparece só para o Dono e para quem recebe', async () => {
    const c = await empresa('Brasa do Pedido');
    const inicio = OwnershipResponse.parse((await ler(c.dono)).body);
    expect(inicio.owner.user_id).toBe(c.dono.userId);
    expect(inicio.candidates).toEqual([{ user_id: c.admin.userId, name: 'Ana Lima', email: c.admin.email }]);
    expect(inicio).toMatchObject({ pending: null, addressed_to_me: false, can_transfer_from: null });

    expect((await api.call('POST', '/v1/ownership/transfers', { cookie: c.gestor.cookie, body: { to_user_id: c.admin.userId, old_owner_stays: true, code: await codigo(c.gestor) } })).body.code).toBe('so-o-dono');
    expect((await pedir(c.dono, c.semApp.userId)).body.code).toBe('nao-pode-receber');
    expect((await pedir(c.dono, c.gestor.userId)).body.code).toBe('nao-pode-receber');
    expect((await api.call('POST', '/v1/ownership/transfers', { cookie: c.dono.cookie, body: { to_user_id: c.admin.userId, old_owner_stays: true, code: '12' } })).status).toBe(400);

    const pedido = await pedir(c.dono, c.admin.userId);
    expect(pedido.status, JSON.stringify(pedido.body)).toBe(201);
    expect(pedido.body.pending).toMatchObject({ to: { user_id: c.admin.userId }, old_owner_stays: true, status: 'pedido' });
    expect(api.mailer.lastTo(c.admin.email)!.subject).toContain(`quer passar para você a propriedade da ${c.nome}`);
    expect(api.mailer.lastTo(c.dono.email)!.subject).toBe(`Liame: o pedido de transferência da ${c.nome} foi enviado`);
    expect((await pedir(c.dono, c.admin.userId)).body.code).toBe('pedido-em-aberto');

    const daAna = OwnershipResponse.parse((await ler(c.admin)).body);
    expect(daAna).toMatchObject({ addressed_to_me: true, candidates: [], pending: { id: pedido.body.pending.id } });
    expect((await ler(c.gestor)).body).toMatchObject({ pending: null, addressed_to_me: false, candidates: [] });
    // Nada mudou ainda.
    expect(await papel(c.tenantId, c.dono.userId)).toMatchObject({ role_key: 'dono', revoked: false });
  });

  it('aceitar: com os Termos de agora e o código; o Dono antigo fica como Administrador, sem a cobrança; 7 dias para transferir de novo', async () => {
    const c = await empresa('Brasa do Aceite');
    const id = (await pedir(c.dono, c.admin.userId)).body.pending.id as string;
    expect((await aceitar(c.gestor, id)).status).toBe(404);
    expect((await aceitar(c.admin, id, 'termos-antigos')).body.code).toBe('termos-desatualizados');
    const aceito = await aceitar(c.admin, id);
    expect(aceito.status, JSON.stringify(aceito.body)).toBe(200);
    expect(aceito.body.owner.user_id).toBe(c.admin.userId);
    expect(await papel(c.tenantId, c.admin.userId)).toMatchObject({ role_key: 'dono', revoked: false });
    expect(await papel(c.tenantId, c.dono.userId)).toEqual({ role_key: 'administrador', revoked: false, billing_access: false });
    expect(api.mailer.lastTo(c.admin.email)!.subject).toBe(`Liame: agora a ${c.nome} é sua`);
    expect(api.mailer.lastTo(c.dono.email)!.text).toContain('Você continua como Administrador, sem a cobrança.');

    // A dona nova vê a cobrança; o Dono antigo, não.
    const daAna = await api.call('GET', '/v1/me', { cookie: c.admin.cookie });
    expect(daAna.body.permissions).toContain('cobranca.ver');
    const doAntigo = await api.call('GET', '/v1/me', { cookie: c.dono.cookie });
    expect(doAntigo.body.permissions).not.toContain('cobranca.ver');
    expect((await pedir(c.dono, c.admin.userId)).body.code).toBe('so-o-dono');

    // Quem acabou de receber espera 7 dias para transferir de novo.
    const agora = OwnershipResponse.parse((await ler(c.admin)).body);
    expect(agora.can_transfer_from).not.toBeNull();
    expect(new Date(agora.can_transfer_from!).getTime() - Date.now()).toBeGreaterThan(6.9 * 86_400_000);
    expect((await pedir(c.admin, c.dono.userId)).body.code).toBe('propriedade-recente');
    await ownerQuery(`update liame.ownership_transfer set decided_at = now() - interval '8 days' where id = $1`, [id]);
    expect((await pedir(c.admin, c.dono.userId)).status).toBe(201);

    const acoes = (await ownerQuery<{ action: string }>(`select action from liame.audit_event where tenant_id = $1 and action like 'pessoas.propriedade%' order by chain_seq`, [c.tenantId])).map((a) => a.action);
    expect(acoes).toEqual(['pessoas.propriedade_pedir', 'pessoas.propriedade_aceitar', 'pessoas.propriedade_pedir']);
  });

  it('cancelar, recusar e vencer não mudam nada; quem escolheu sair perde o acesso no aceite; a RLS separa as empresas', async () => {
    const c = await empresa('Brasa Que Sai');
    let id = (await pedir(c.dono, c.admin.userId, false)).body.pending.id as string;
    expect((await api.call('DELETE', `/v1/ownership/transfers/${id}`, { cookie: c.admin.cookie })).body.code).toBe('so-o-dono');
    expect((await api.call('DELETE', `/v1/ownership/transfers/${id}`, { cookie: c.dono.cookie })).status).toBe(204);
    expect(api.mailer.lastTo(c.admin.email)!.subject).toBe(`Liame: o pedido de transferência da ${c.nome} foi cancelado`);

    id = (await pedir(c.dono, c.admin.userId, false)).body.pending.id as string;
    expect((await api.call('POST', `/v1/ownership/transfers/${id}/decline`, { cookie: c.admin.cookie })).status).toBe(204);
    expect(api.mailer.lastTo(c.dono.email)!.subject).toBe(`Liame: Ana Lima recusou a propriedade da ${c.nome}`);

    id = (await pedir(c.dono, c.admin.userId, false)).body.pending.id as string;
    await ownerQuery(`update liame.ownership_transfer set expires_at = now() - interval '1 second', created_at = now() - interval '8 days' where id = $1`, [id]);
    expect((await aceitar(c.admin, id)).status).toBe(404);
    expect((await ler(c.dono)).body.pending).toBeNull();
    expect(await ownerQuery(`select status from liame.ownership_transfer where id = $1`, [id])).toEqual([{ status: 'vencido' }]);
    expect(await papel(c.tenantId, c.dono.userId)).toMatchObject({ role_key: 'dono', revoked: false });

    // Quem escolheu sair perde o acesso quando a dona nova aceita.
    id = (await pedir(c.dono, c.admin.userId, false)).body.pending.id as string;
    expect((await aceitar(c.admin, id)).status).toBe(200);
    expect(await papel(c.tenantId, c.dono.userId)).toEqual({ role_key: 'administrador', revoked: true, billing_access: false });
    expect(api.mailer.lastTo(c.dono.email)!.text).toContain('O seu acesso à conta acabou.');

    // No banco, com o papel da aplicação, outra empresa não vê os pedidos desta.
    const outra = await empresa('Brasa Vizinha');
    const daOutra = await withContext(database.db, { tenantId: outra.tenantId, userId: outra.dono.userId }, async (tx) =>
      (await tx.execute(sql`select id from liame.ownership_transfer where tenant_id = ${c.tenantId}`)).rows,
    );
    expect(daOutra).toEqual([]);
    // Um pedido em aberto por empresa, também no banco.
    const segundo = await ownerQuery(
      `insert into liame.ownership_transfer (id, tenant_id, from_user_id, to_user_id, old_owner_stays, expires_at)
       values (gen_random_uuid(), $1, $2, $3, true, now() + interval '7 days'), (gen_random_uuid(), $1, $2, $3, true, now() + interval '7 days')`,
      [outra.tenantId, outra.dono.userId, outra.admin.userId],
    ).then(
      () => null,
      (err: { constraint?: string }) => err.constraint ?? 'outro erro',
    );
    expect(segundo).toBe('uq_ownership_transfer_pedido');
  });
});
