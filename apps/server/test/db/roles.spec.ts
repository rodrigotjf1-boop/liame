import { resolve } from 'node:path';
import { runMigrations } from '@liame/database';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PERMISSIONS } from '../../src/auth/permissions.js';
import { listRoutes } from '../../src/auth/routes.js';
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

// Matriz papel × permissão (ADR-013, ADR-017), escrita à mão de propósito: mudar um papel padrão
// exige mudar a migration E este quadro, com revisão.
const MATRIX: Record<string, string[]> = {
  dono: [...PERMISSIONS],
  administrador: [
    'empresa.ver', 'empresa.editar', 'marcas.ver', 'marcas.gerenciar', 'pessoas.ver', 'pessoas.convidar', 'pessoas.remover',
    'pessoas.alterar_nivel', 'auditoria.ver', 'acoes.aprovar', 'campanhas.ver', 'campanhas.operar', 'relatorios.ver',
    'agentes.gerenciar', 'parada.acionar', 'webhooks.gerenciar', 'politicas.gerenciar',
    'orcamento.gerenciar', 'contas.ver', 'contas.conectar', 'vendas.ver', 'atribuicao.gerenciar', 'links.gerenciar', 'cupons.criar',
  ],
  gestor: [
    'empresa.ver', 'marcas.ver', 'pessoas.ver', 'acoes.aprovar', 'campanhas.ver', 'campanhas.operar', 'relatorios.ver',
    'agentes.gerenciar', 'parada.acionar', 'contas.ver', 'contas.conectar', 'vendas.ver', 'atribuicao.gerenciar', 'links.gerenciar',
    'cupons.criar',
  ],
  aprovador: ['empresa.ver', 'marcas.ver', 'acoes.aprovar', 'campanhas.ver', 'relatorios.ver', 'contas.ver', 'vendas.ver'],
  somente_leitura: ['empresa.ver', 'marcas.ver', 'campanhas.ver', 'relatorios.ver', 'contas.ver', 'vendas.ver'],
  so_relatorios: [],
};
const APPROVERS = new Set(['administrador', 'gestor', 'aprovador']);
const ANY_ID = '0192f1d4-3c1a-7b2e-9a10-5f1e2d3c4b5a';

describe.skipIf(!hasDb)('papéis como dado', () => {
  let api: TestApi;

  async function owner(company = 'Empresa dos Papéis') {
    const s = await signupAndLogin(api, undefined, company);
    await enableMfa(api, s.cookie);
    return { ...s, tenantId: s.me.active_organization_id as string };
  }

  async function member(dono: { cookie: string }, role: string) {
    const email = uniqueEmail(role);
    const body: Record<string, unknown> = { email, role };
    if (APPROVERS.has(role)) body.approve_limit_micros = 1_000_000;
    expect((await api.call('POST', '/v1/invitations', { cookie: dono.cookie, body })).status).toBe(201);
    const s = await api.call('POST', '/v1/invitations/signup', {
      body: { token: tokenFrom(api.mailer, email), name: role, password: PASSWORD, terms_version: TERMOS },
    });
    if (APPROVERS.has(role)) await enableMfa(api, s.cookie!);
    return { email, cookie: s.cookie!, me: s.body };
  }

  beforeAll(async () => {
    await runMigrations({ connectionString: OWNER_URL, dir: resolve(process.cwd(), '../../packages/database/migrations') });
    api = await startApi();
  });
  beforeEach(resetIpRateLimits);
  afterAll(async () => {
    await api?.close();
  });

  it('os conjuntos padrão no banco são exatamente a matriz, e só usam permissões conhecidas', async () => {
    const rows = await ownerQuery<{ role_key: string; permission: string }>(
      `select role_key, permission from liame.role_permission where tenant_id is null order by 1, 2`,
    );
    const fromDb: Record<string, string[]> = Object.fromEntries(Object.keys(MATRIX).map((k) => [k, []]));
    for (const r of rows) fromDb[r.role_key]!.push(r.permission);
    const sorted = (m: Record<string, string[]>) => Object.fromEntries(Object.entries(m).map(([k, v]) => [k, [...v].sort()]));
    expect(sorted(fromDb)).toEqual(sorted(MATRIX));
    const roles = await ownerQuery<{ key: string }>(`select key from liame.role order by key`);
    expect(roles.map((r) => r.key).sort()).toEqual(Object.keys(MATRIX).sort());
  });

  it('cada papel passa ou é barrado em TODA rota com permissão, conforme a matriz', async () => {
    const dono = await owner();
    const sessions: Record<string, string> = { dono: dono.cookie };
    for (const role of Object.keys(MATRIX).filter((r) => r !== 'dono')) sessions[role] = (await member(dono, role)).cookie;

    const routes = listRoutes(api.app).filter((r) => r.access?.kind === 'permissao');
    expect(routes.length).toBeGreaterThan(5);
    const results: string[] = [];
    for (const [role, cookie] of Object.entries(sessions)) {
      // Corpo vazio e id que não existe: quem passa pelo guard recebe 400 ou 404, sem efeito colateral.
      await Promise.all(
        routes.map(async (route) => {
          const needed = route.access!.kind === 'permissao' ? route.access!.permissions : [];
          const allowed = needed.every((p) => MATRIX[role]!.includes(p));
          const path = route.path.replace(/:[a-zA-Z_]+/g, ANY_ID);
          const r = await api.call(route.method, path, { cookie, body: route.method === 'GET' ? undefined : {} });
          const barred = r.status === 403 && r.body?.code === 'sem-permissao';
          if (barred === allowed) results.push(`${role} ${route.method} ${route.path}: ${r.status} ${r.body?.code ?? ''}`);
        }),
      );
    }
    expect(results).toEqual([]);
  }, 90_000);

  it('a empresa com conjunto próprio muda o acesso de um papel sem deploy, só para ela', async () => {
    const a = await owner('Empresa A');
    const b = await owner('Empresa B');
    const leitorA = await member(a, 'somente_leitura');
    const leitorB = await member(b, 'somente_leitura');
    expect(leitorA.me.permissions).toEqual([...MATRIX.somente_leitura!].sort());
    expect((await api.call('GET', '/v1/brands', { cookie: leitorA.cookie })).status).toBe(200);

    // A empresa A tira "marcas.ver" do Somente leitura dela: o conjunto próprio substitui o padrão inteiro.
    await ownerQuery(
      `insert into liame.role_permission (tenant_id, role_key, permission) values ($1, 'somente_leitura', 'empresa.ver')`,
      [a.tenantId],
    );
    const barrado = await api.call('GET', '/v1/brands', { cookie: leitorA.cookie });
    expect(barrado.body.code).toBe('sem-permissao');
    expect((await api.call('GET', '/v1/organization', { cookie: leitorA.cookie })).status).toBe(200);
    expect((await api.call('GET', '/v1/me', { cookie: leitorA.cookie })).body.permissions).toEqual(['empresa.ver']);

    // A empresa B segue no padrão.
    expect((await api.call('GET', '/v1/brands', { cookie: leitorB.cookie })).status).toBe(200);
  });

  it('o banco recusa papel que não existe', async () => {
    const dono = await owner();
    await expect(
      ownerQuery(`update liame.membership set role_key = 'super_admin', billing_access = false where tenant_id = $1`, [dono.tenantId]),
    ).rejects.toMatchObject({ code: '23503', constraint: 'membership_role_fk' });
  });
});
