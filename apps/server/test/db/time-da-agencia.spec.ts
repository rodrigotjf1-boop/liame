import { resolve } from 'node:path';
import { createDatabase, runMigrations, type Tx, withContext, withSystem } from '@liame/database';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { pessoaPode } from '../../src/auth/pessoa-pode.js';
import { currentStep, totpCode } from '../../src/auth/totp.js';
import { FlagService } from '../../src/flags/flag.service.js';
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
import { APP_URL, hasDb, OWNER_URL } from './env.js';

const REAL = 1_000_000; // micros

type Pessoa = { cookie: string; email: string; userId: string; segredo: string };

// O time da agência dentro de cada cliente (A7, W6, parte 3; ADR-017; D-A7-47 a D-A7-50): a agência coloca pessoas do
// time numa empresa que aceitou o vínculo, até o máximo do Dono e só com o app; quem vem da agência nunca convida, remove
// nem vê a cobrança; a auditoria a registra como `partner`; e o acesso some com o vínculo, com a pessoa ou com o Dono.
describe.skipIf(!hasDb)('o time da agência no cliente', () => {
  let api: TestApi;
  let flags: FlagService;

  async function codigo(p: Pessoa): Promise<string> {
    await ownerQuery(`update liame.app_user set totp_last_step = null where id = $1`, [p.userId]);
    await ownerQuery(`delete from liame.rate_limit where key = $1`, [`segundo-fator:${p.userId}`]);
    return totpCode(p.segredo, currentStep());
  }

  /** A empresa, a agência com o time (dona, administrador, membro com o app e membro sem o app) e o vínculo aceito. */
  async function cenario(nome: string, termos: Record<string, unknown> = { max_role: 'gestor', approve_limit_micros: 50 * REAL }) {
    const s = await signupAndLogin(api, undefined, `Empresa ${nome}`);
    const e = { cookie: s.cookie, email: s.email, userId: s.me.user.id, segredo: (await enableMfa(api, s.cookie)).secret, tenantId: s.me.active_organization_id as string };
    const d = await signupAndLogin(api, undefined, `Empresa da dona ${nome}`);
    const aberta = await api.call('POST', '/v1/agencies', { cookie: d.cookie, body: { name: `Agência ${nome}` } });
    const dona = { cookie: d.cookie, email: d.email, userId: d.me.user.id, segredo: (await enableMfa(api, d.cookie)).secret, agencyId: aberta.body.active_organization_id as string };
    const time: Record<string, Pessoa> = {};
    for (const [chave, role, comApp] of [['admin', 'agencia_admin', true], ['membro', 'agencia_membro', true], ['semApp', 'agencia_membro', false]] as const) {
      const email = uniqueEmail(chave.toLowerCase());
      expect((await api.call('POST', '/v1/agency/invitations', { cookie: dona.cookie, body: { email, role } })).status).toBe(201);
      const r = await api.call('POST', '/v1/invitations/signup', {
        body: { token: tokenFrom(api.mailer, email), name: `Pessoa ${chave}`, password: PASSWORD, terms_version: TERMOS },
      });
      const userId = r.body.user.id as string;
      time[chave] = { cookie: r.cookie!, email, userId, segredo: comApp ? (await enableMfa(api, r.cookie!)).secret : '' };
    }
    await ownerQuery(
      `insert into liame.feature_flag_rule (id, flag_key, scope_type, scope_id, value, created_by) values (gen_random_uuid(), 'parceiros', 'tenant', $1, 'true'::jsonb, 'testes')`,
      [e.tenantId],
    );
    flags.invalidate();
    const pedido = await api.call('POST', '/v1/agency/requests', { cookie: dona.cookie, body: { owner_email: e.email, requested_role: 'gestor' } });
    const aceito = await api.call('POST', `/v1/partners/requests/${pedido.body.id}/accept`, { cookie: e.cookie, body: { ...termos, code: await codigo(e) } });
    expect(aceito.status, JSON.stringify(aceito.body)).toBe(200);
    return { e, dona, time: time as Record<'admin' | 'membro' | 'semApp', Pessoa>, linkId: pedido.body.id as string };
  }

  const salvar = (por: { cookie: string }, linkId: string, members: unknown[]) =>
    api.call('PUT', `/v1/agency/clients/${linkId}/team`, { cookie: por.cookie, body: { members } });

  /** A pessoa troca para a empresa (a sessão dela passa a ser na empresa). */
  const entrar = (p: Pessoa, tenantId: string) => api.call('PUT', '/v1/me/active-organization', { cookie: p.cookie, body: { organization_id: tenantId } });

  beforeAll(async () => {
    await runMigrations({ connectionString: OWNER_URL, dir: resolve(process.cwd(), '../../packages/database/migrations') });
    api = await startApi();
    flags = api.app.get(FlagService);
  });
  beforeEach(resetIpRateLimits);
  afterAll(async () => {
    await api?.close();
  });

  it('a agência coloca o time no cliente até o máximo do Dono e só com o app; o Dono é avisado e vê cada pessoa com o nome da agência', async () => {
    const { e, dona, time, linkId } = await cenario('Fogo do Time');
    const antes = await api.call('GET', `/v1/agency/clients/${linkId}/team`, { cookie: dona.cookie });
    expect(antes.status).toBe(200);
    expect(antes.body.client).toMatchObject({ id: linkId, max_role: 'gestor', approve_limit_micros: 50 * REAL });
    expect(antes.body.team).toHaveLength(4);
    expect(antes.body.team.every((t: { in_client: unknown }) => t.in_client === null)).toBe(true);

    expect((await salvar(dona, linkId, [{ user_id: time.semApp.userId, role: 'gestor' }])).body.code).toBe('sem-app-autenticador');
    expect((await salvar(dona, linkId, [{ user_id: time.membro.userId, role: 'administrador' }])).body.code).toBe('acima-do-maximo');
    expect((await salvar(dona, linkId, [{ user_id: time.membro.userId, role: 'gestor', approve_limit_micros: 100 * REAL }])).body.code).toBe('limite-acima-do-maximo');
    expect((await salvar(dona, linkId, [{ user_id: time.membro.userId, role: 'gestor', approve_limit_micros: null }])).body.code).toBe('limite-acima-do-maximo');
    expect((await salvar(dona, linkId, [{ user_id: time.membro.userId, role: 'gestor', dual_approval: false }])).body.code).toBe('aprovacao-dupla-do-dono');
    // O membro da agência não escolhe o time.
    expect((await salvar(time.membro, linkId, [])).body.code).toBe('sem-permissao');

    const salvo = await salvar(time.admin, linkId, [
      { user_id: time.membro.userId, role: 'gestor' },
      { user_id: time.admin.userId, role: 'aprovador', approve_limit_micros: 20 * REAL },
    ]);
    expect(salvo.status, JSON.stringify(salvo.body)).toBe(200);
    const noCliente = Object.fromEntries(
      salvo.body.team.filter((t: { in_client: unknown }) => t.in_client).map((t: { user_id: string; in_client: unknown }) => [t.user_id, t.in_client]),
    );
    expect(noCliente[time.membro.userId]).toMatchObject({ role: 'gestor', approve_limit_micros: 50 * REAL, dual_approval: true });
    expect(noCliente[time.admin.userId]).toMatchObject({ role: 'aprovador', approve_limit_micros: 20 * REAL, dual_approval: true });
    const aviso = api.mailer.lastTo(e.email)!;
    expect(aviso.subject).toBe('Liame: Agência Fogo do Time colocou 2 pessoas na conta de Empresa Fogo do Time');
    expect(aviso.text).toContain('- Pessoa membro, como Gestor');
    expect(aviso.text).toContain('/pessoas');

    const pessoas = await api.call('GET', '/v1/people', { cookie: e.cookie });
    const doMembro = pessoas.body.members.find((m: { email: string }) => m.email === time.membro.email);
    expect(doMembro).toMatchObject({ role: 'gestor', approve_limit_micros: 50 * REAL, partner: { link_id: linkId, agency_name: 'Agência Fogo do Time' } });
    // Salvar de novo sem o administrador tira o acesso dele a este cliente.
    expect((await salvar(dona, linkId, [{ user_id: time.membro.userId, role: 'gestor' }])).status).toBe(200);
    const depois = await api.call('GET', '/v1/people', { cookie: e.cookie });
    expect(depois.body.members.some((m: { email: string }) => m.email === time.admin.email)).toBe(false);
  });

  it('quem vem da agência nunca convida, remove nem vê a cobrança, nem como Administrador; entra só com o app; e age como partner', async () => {
    const { e, dona, time, linkId } = await cenario('Fogo das Permissões', { max_role: 'administrador', approve_limit_micros: 50 * REAL });
    expect((await salvar(dona, linkId, [{ user_id: time.membro.userId, role: 'administrador' }])).status).toBe(200);
    const na = await entrar(time.membro, e.tenantId);
    expect(na.status).toBe(200);
    expect(na.body.organizations.find((o: { id: string }) => o.id === e.tenantId)).toMatchObject({
      role: 'administrador',
      via_agency: { name: 'Agência Fogo das Permissões' },
    });
    const permissoes: string[] = na.body.permissions;
    expect(permissoes).toContain('campanhas.operar');
    for (const p of ['pessoas.convidar', 'pessoas.remover', 'pessoas.alterar_nivel', 'cobranca.ver', 'cobranca.gerenciar', 'cobranca.pagar']) {
      expect(permissoes).not.toContain(p);
    }
    const convite = await api.call('POST', '/v1/invitations', { cookie: time.membro.cookie, body: { email: uniqueEmail(), role: 'somente_leitura' } });
    expect(convite.body.code).toBe('sem-permissao');
    expect((await api.call('GET', '/v1/billing/plans', { cookie: time.membro.cookie })).body.code).toBe('sem-permissao');

    // A ação na empresa fica na auditoria como `partner`, com o nome da agência.
    const marca = await api.call('POST', '/v1/brands', { cookie: time.membro.cookie, body: { name: 'Marca criada pela agência' } });
    expect(marca.status).toBe(201);
    const [evento] = await ownerQuery<{ actor_type: string; actor_label: string }>(
      `select actor_type, actor_label from liame.audit_event where tenant_id = $1 and action = 'marca.criar' order by chain_seq desc limit 1`,
      [e.tenantId],
    );
    expect(evento).toEqual({ actor_type: 'partner', actor_label: 'Pessoa membro, Administrador · Agência Fogo das Permissões' });

    // As rotinas que agem sem a sessão seguem a mesma regra.
    const database = createDatabase({ connectionString: APP_URL, max: 2, applicationName: 'liame-test' });
    try {
      const pode = (permissao: string) => withSystem(database.db, (tx) => pessoaPode(tx, { tenantId: e.tenantId, userId: time.membro.userId, permissao }));
      expect(await pode('campanhas.operar')).toBe(true);
      expect(await pode('pessoas.convidar')).toBe(false);
      expect(await pode('cobranca.ver')).toBe(false);
    } finally {
      await database.close();
    }
  });

  it('quem vem da agência e ainda não tem o app não usa a empresa, em nenhum nível', async () => {
    const { e, dona, time, linkId } = await cenario('Fogo do App', { max_role: 'somente_leitura' });
    expect((await salvar(dona, linkId, [{ user_id: time.membro.userId, role: 'somente_leitura' }])).status).toBe(200);
    // O app desligado depois de entrar: o acesso à empresa para até ele voltar.
    await ownerQuery(`update liame.secret set revoked_at = now() where owner_user_id = $1 and purpose = 'totp' and revoked_at is null`, [time.membro.userId]);
    await entrar(time.membro, e.tenantId);
    const r = await api.call('GET', '/v1/brands', { cookie: time.membro.cookie });
    expect(r.body.code).toBe('segundo-fator-nao-configurado');
  });

  it('o Dono tira uma pessoa só (o nível dela não muda por Pessoas), e quem já tem acesso direto não entra pela agência', async () => {
    const { e, dona, time, linkId } = await cenario('Fogo do Dono');
    expect((await salvar(dona, linkId, [{ user_id: time.membro.userId, role: 'gestor' }])).status).toBe(200);
    const pessoas = await api.call('GET', '/v1/people', { cookie: e.cookie });
    const membro = pessoas.body.members.find((m: { email: string }) => m.email === time.membro.email);
    const muda = await api.call('PATCH', `/v1/members/${membro.id}`, { cookie: e.cookie, body: { role: 'aprovador' } });
    expect(muda.body.code).toBe('acesso-da-agencia');
    expect((await entrar(time.membro, e.tenantId)).status).toBe(200);
    expect((await api.call('DELETE', `/v1/members/${membro.id}`, { cookie: e.cookie })).status).toBe(204);
    expect((await api.call('GET', '/v1/brands', { cookie: time.membro.cookie })).body.code).toBe('sem-empresa-ativa');
    expect((await entrar(time.membro, e.tenantId)).status).toBe(404);

    // O administrador da agência com convite direto do Dono não entra de novo pela agência; nada do pedido fica gravado.
    expect((await api.call('POST', '/v1/invitations', { cookie: e.cookie, body: { email: time.admin.email, role: 'somente_leitura' } })).status).toBe(201);
    const token = tokenFrom(api.mailer, time.admin.email);
    expect((await api.call('POST', '/v1/invitations/accept', { cookie: time.admin.cookie, body: { token } })).status).toBe(200);
    const dupla = await salvar(dona, linkId, [
      { user_id: time.membro.userId, role: 'gestor' },
      { user_id: time.admin.userId, role: 'gestor' },
    ]);
    expect(dupla.body.code).toBe('ja-tem-acesso');
    const [vivos] = await ownerQuery<{ n: number }>(`select count(*)::int as n from liame.membership where partner_link_id = $1 and revoked_at is null`, [linkId]);
    expect(vivos!.n).toBe(0);
  });

  it('baixar o máximo desce quem estava acima, e a data de fim vale para todos; desfazer corta o time inteiro na hora', async () => {
    const { e, dona, time, linkId } = await cenario('Fogo do Máximo', { max_role: 'administrador', approve_limit_micros: 50 * REAL });
    expect(
      (
        await salvar(dona, linkId, [
          { user_id: time.membro.userId, role: 'administrador' },
          { user_id: time.admin.userId, role: 'gestor', approve_limit_micros: 20 * REAL },
        ])
      ).status,
    ).toBe(200);
    const fim = new Date(Date.now() + 20 * 86_400_000).toISOString();
    const baixa = await api.call('PATCH', `/v1/partners/${linkId}`, { cookie: e.cookie, body: { max_role: 'aprovador', approve_limit_micros: 10 * REAL, ends_at: fim } });
    expect(baixa.status, JSON.stringify(baixa.body)).toBe(200);
    expect(api.mailer.lastTo(dona.email)?.text).toContain('2 pessoas do time estavam acima e desceram para o novo máximo.');
    const linhas = await ownerQuery<{ user_id: string; role_key: string; approve_limit_micros: string; expires_at: Date }>(
      `select user_id, role_key, approve_limit_micros, expires_at from liame.membership where partner_link_id = $1 and revoked_at is null order by user_id`,
      [linkId],
    );
    expect(linhas.map((l) => ({ role: l.role_key, limite: Number(l.approve_limit_micros), fim: new Date(l.expires_at).toISOString() }))).toEqual([
      { role: 'aprovador', limite: 10 * REAL, fim },
      { role: 'aprovador', limite: 10 * REAL, fim },
    ]);

    await entrar(time.membro, e.tenantId);
    expect((await api.call('GET', '/v1/brands', { cookie: time.membro.cookie })).status).toBe(200);
    expect((await api.call('DELETE', `/v1/partners/${linkId}`, { cookie: e.cookie })).status).toBe(204);
    expect((await api.call('GET', '/v1/brands', { cookie: time.membro.cookie })).body.code).toBe('sem-empresa-ativa');
    const [vivos] = await ownerQuery<{ n: number }>(`select count(*)::int as n from liame.membership where partner_link_id = $1 and revoked_at is null`, [linkId]);
    expect(vivos!.n).toBe(0);
  });

  it('quem sai do time sai de todos os clientes, e a agência que deixa o cliente leva o time junto', async () => {
    const { e, dona, time, linkId } = await cenario('Fogo da Saída');
    expect(
      (
        await salvar(dona, linkId, [
          { user_id: time.membro.userId, role: 'gestor' },
          { user_id: time.admin.userId, role: 'gestor' },
        ])
      ).status,
    ).toBe(200);
    const equipe = await api.call('GET', '/v1/agency/team', { cookie: dona.cookie });
    const doMembro = equipe.body.members.find((m: { email: string }) => m.email === time.membro.email).id as string;
    expect((await entrar(time.membro, e.tenantId)).status).toBe(200);
    expect((await entrar(time.admin, e.tenantId)).status).toBe(200);
    expect((await api.call('DELETE', `/v1/agency/members/${doMembro}`, { cookie: dona.cookie })).status).toBe(204);
    expect((await api.call('GET', '/v1/brands', { cookie: time.membro.cookie })).body.code).toBe('sem-empresa-ativa');
    expect((await api.call('GET', '/v1/brands', { cookie: time.admin.cookie })).status).toBe(200);

    expect((await api.call('DELETE', `/v1/agency/clients/${linkId}`, { cookie: dona.cookie })).status).toBe(204);
    expect((await api.call('GET', '/v1/brands', { cookie: time.admin.cookie })).body.code).toBe('sem-empresa-ativa');
  });

  it('a RLS: a agência só grava o vínculo do time dela, no cliente dela, e não lê os vínculos diretos do cliente', async () => {
    const um = await cenario('Fogo da RLS');
    const outro = await cenario('Brasa da RLS');
    const database = createDatabase({ connectionString: APP_URL, max: 2, applicationName: 'liame-test' });
    try {
      const comoAgencia = <T>(agencyId: string, userId: string, fn: (tx: Tx) => Promise<T>) =>
        withContext(database.db, { tenantId: agencyId, userId }, fn);
      const inserir = (agencyId: string, userId: string, tenantId: string, linkId: string | null) =>
        comoAgencia(agencyId, userId, (tx) =>
          tx.execute(sql`
            insert into liame.membership (id, tenant_id, user_id, role_key, partner_link_id)
            values (gen_random_uuid(), ${tenantId}, ${um.time.membro.userId}, 'somente_leitura', ${linkId})`),
        );
      // A outra agência não usa o vínculo desta; esta não grava no cliente sem o vínculo, nem com o vínculo noutro cliente.
      await expect(inserir(outro.dona.agencyId, outro.dona.userId, um.e.tenantId, um.linkId)).rejects.toMatchObject({ cause: { code: '42501' } });
      await expect(inserir(um.dona.agencyId, um.dona.userId, um.e.tenantId, null)).rejects.toMatchObject({ cause: { code: '42501' } });
      await expect(inserir(um.dona.agencyId, um.dona.userId, outro.e.tenantId, um.linkId)).rejects.toMatchObject({ cause: { code: '42501' } });
      // O vínculo do Dono com a empresa não aparece para a agência.
      const doDono = await comoAgencia(um.dona.agencyId, um.dona.userId, async (tx) =>
        (await tx.execute(sql`select id from liame.membership where tenant_id = ${um.e.tenantId} and user_id = ${um.e.userId}`)).rows.length,
      );
      expect(doDono).toBe(0);
    } finally {
      await database.close();
    }
  });
});
