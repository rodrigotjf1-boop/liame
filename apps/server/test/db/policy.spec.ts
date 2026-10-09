import { resolve } from 'node:path';
import { type Database, runMigrations, withContext } from '@liame/database';
import { Controller, HttpCode, Post } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Auditar } from '../../src/audit/auditar.js';
import { Permissao } from '../../src/auth/access.js';
import { DATABASE } from '../../src/database/database.module.js';
import { currentPolicyDecision, Politica } from '../../src/policy/politica.js';
import { enableMfa, ownerQuery, resetIpRateLimits, signupAndLogin, startApi, type TestApi } from '../helpers/api.js';
import { hasDb, OWNER_URL } from './env.js';

/** Rota só dos testes, para provar o @Politica (a rota real de ações chega na E6c). */
@Controller('teste-politica')
class PolicyProbeController {
  @Post()
  @Permissao('campanhas.operar')
  @Auditar('teste.politica')
  @Politica('orcamento.aumentar', (req) => ({ ...(req.body as Record<string, unknown>) }))
  @HttpCode(200)
  probe() {
    return currentPolicyDecision();
  }
}

const base = {
  tool: 'campanha_orcamento_ajustar',
  provider: 'meta',
  account_id: 'act_1',
  risk_level: 'R3',
  budget_impact: 'increase',
  value_micros: 110_000_000,
  current_value_micros: 100_000_000,
};

describe.skipIf(!hasDb)('políticas versionadas e @Politica (A1-11)', () => {
  let api: TestApi;
  let database: Database;

  async function owner(company = 'Empresa das Políticas') {
    const s = await signupAndLogin(api, undefined, company);
    await enableMfa(api, s.cookie);
    const brands = await api.call('GET', '/v1/brands', { cookie: s.cookie });
    return { ...s, tenantId: s.me.active_organization_id as string, userId: s.me.user.id as string, brandId: brands.body.items[0].id as string };
  }

  beforeAll(async () => {
    await runMigrations({ connectionString: OWNER_URL, dir: resolve(process.cwd(), '../../packages/database/migrations') });
    api = await startApi({ controllers: [PolicyProbeController] });
    database = api.app.get(DATABASE);
  });
  beforeEach(resetIpRateLimits);
  afterAll(async () => {
    await api?.close();
  });

  it('publicar cria versões; a anterior do mesmo escopo arquiva; a da marca é separada; versão publicada não muda', async () => {
    const dono = await owner();
    const doc = (max: number) => ({ rules: [{ type: 'max_value', action: 'orcamento.*', max_micros: max }] });
    const v1 = await api.call('POST', '/v1/policies', { cookie: dono.cookie, body: { document: doc(100_000_000) } });
    expect(v1).toMatchObject({ status: 201, body: { version: 1, status: 'ativa', brand_id: null } });
    const v2 = await api.call('POST', '/v1/policies', { cookie: dono.cookie, body: { document: doc(200_000_000) } });
    expect(v2.body.version).toBe(2);
    const marca = await api.call('POST', '/v1/policies', {
      cookie: dono.cookie,
      body: { brand_id: dono.brandId, document: { rules: [{ type: 'autonomy', action: 'orcamento.aumentar', mode: 'APPROVAL' }] } },
    });
    expect(marca.body).toMatchObject({ version: 1, brand_id: dono.brandId });

    const lista = await api.call('GET', '/v1/policies', { cookie: dono.cookie });
    expect(lista.body.platform.version).toBe(4);
    // A política da distribuição vai inteira na resposta: quem vê as regras da empresa vê também as que valem acima delas.
    expect(lista.body.platform.document.rules).toContainEqual({ type: 'autonomy', provider: 'meta_ads', actor: 'human', mode: 'APPROVAL' });
    expect(lista.body.platform.document.rules).toContainEqual({ type: 'rate_limit', action: 'orcamento.*', provider: 'meta_ads', per: 'resource', max: 3, window_minutes: 60 });
    expect(lista.body.items.map((p: { version: number; status: string; brand_id: string | null }) => [p.brand_id === null ? 'empresa' : 'marca', p.version, p.status])).toEqual([
      ['empresa', 2, 'ativa'],
      ['empresa', 1, 'arquivada'],
      ['marca', 1, 'ativa'],
    ]);
    // A aplicação não reescreve o documento de uma versão publicada.
    await expect(
      withContext(database.db, { tenantId: dono.tenantId, userId: dono.userId }, (tx) =>
        tx.execute(sql`update liame.policy set document = '{"rules":[]}' where id = ${v1.body.id}`),
      ),
    ).rejects.toMatchObject({ cause: expect.objectContaining({ code: '42501' }) });
    // Publicar é auditado.
    const [ev] = await ownerQuery<{ after: Record<string, unknown> }>(
      `select after from liame.audit_event where chain_key = $1 and action = 'politica.publicar' order by chain_seq desc limit 1`,
      [dono.tenantId],
    );
    expect(ev?.after).toMatchObject({ brand_id: dono.brandId, version: 1, rules: 1 });
  });

  it('documento inválido é recusado com o campo', async () => {
    const dono = await owner();
    const r = await api.call('POST', '/v1/policies', { cookie: dono.cookie, body: { document: { rules: [{ type: 'teto_magico', max: 1 }] } } });
    expect(r.status).toBe(400);
    expect(r.body.errors[0].path).toMatch(/^document\.rules\.0/);
    const hora = await api.call('POST', '/v1/policies', { cookie: dono.cookie, body: { document: { rules: [{ type: 'allowed_hours', start: '25:00', end: '06:00' }] } } });
    expect(hora.status).toBe(400);
  });

  it('simular: plataforma + empresa + marca, no fuso da empresa; marca de outra empresa não entra', async () => {
    const dono = await owner();
    await api.call('POST', '/v1/policies', {
      cookie: dono.cookie,
      body: {
        document: {
          rules: [
            { type: 'max_value', max_micros: 500_000_000 },
            { type: 'autonomy', action: 'orcamento.aumentar', up_to_percent: 10, mode: 'LIMITED_AUTO' },
          ],
        },
      },
    });
    const sim = (body: Record<string, unknown>) => api.call('POST', '/v1/policies/evaluate', { cookie: dono.cookie, body: { action: 'orcamento.aumentar', ...base, ...body } });
    expect((await sim({})).body).toEqual({ allowed: true, mode: 'LIMITED_AUTO', violations: [], versions: ['plataforma@4', 'empresa@1'] });
    expect((await sim({ value_micros: 600_000_000 })).body).toMatchObject({ allowed: false, violations: [{ source: 'tenant', type: 'max_value' }] });
    expect((await sim({ categories: ['politica'] })).body.violations[0]).toMatchObject({ source: 'platform', type: 'forbidden_categories' });

    await api.call('POST', '/v1/policies', {
      cookie: dono.cookie,
      body: { brand_id: dono.brandId, document: { rules: [{ type: 'autonomy', action: 'orcamento.aumentar', up_to_percent: 10, mode: 'APPROVAL' }] } },
    });
    expect((await sim({ brand_id: dono.brandId })).body).toMatchObject({ mode: 'APPROVAL', versions: ['plataforma@4', 'empresa@1', 'marca@1'] });

    const outra = await owner('Outra empresa');
    expect((await sim({ brand_id: outra.brandId })).status).toBe(404);
  });

  it('@Politica: a rota declarada é barrada com cada regra (422) ou segue com o modo decidido', async () => {
    const dono = await owner();
    await api.call('POST', '/v1/policies', {
      cookie: dono.cookie,
      body: { document: { rules: [{ type: 'max_change_percent', max_percent: 20 }, { type: 'autonomy', action: 'orcamento.*', mode: 'APPROVAL' }] } },
    });
    const ok = await api.call('POST', '/v1/teste-politica', { cookie: dono.cookie, body: base });
    expect(ok).toMatchObject({ status: 200, body: { allowed: true, mode: 'APPROVAL' } });

    const negado = await api.call('POST', '/v1/teste-politica', { cookie: dono.cookie, body: { ...base, value_micros: 200_000_000, categories: ['politica'] } });
    expect(negado.status).toBe(422);
    expect(negado.body.code).toBe('politica-negou');
    expect(negado.body.errors).toEqual([
      { path: 'politica.platform.0', message: 'Categoria proibida: politica.' },
      { path: 'politica.tenant.0', message: 'A variação de 100,0% passa do máximo de 20%.' },
    ]);
    // Negado não executa o handler, então não audita.
    const audit = await ownerQuery(`select 1 from liame.audit_event where chain_key = $1 and action = 'teste.politica'`, [dono.tenantId]);
    expect(audit).toHaveLength(1);

    const semCampos = await api.call('POST', '/v1/teste-politica', { cookie: dono.cookie, body: { tool: 'x' } });
    expect(semCampos.status).toBe(400);
  });
});
