import { resolve } from 'node:path';
import { createDatabase, type Database, runMigrations, withContext } from '@liame/database';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { registrarRecusa, regrasParaGuardar } from '../../src/ai/recusas.js';
import { enableMfa, ownerQuery, resetIpRateLimits, signupAndLogin, startApi, type TestApi } from '../helpers/api.js';
import { APP_URL, hasDb, OWNER_URL } from './env.js';

// A3 · D-A3-15: o que a conferência recusou fica contado SEM o texto (migration 0040). A linha guarda o funcionário, o
// fluxo, o porquê e os nomes das regras; a aplicação só lê e insere; e a falha da contagem nunca derruba quem chamou.

describe('regras que vão para o banco: só nomes, sem repetir', () => {
  it('tira o que não é nome de regra (um trecho do texto nunca entra)', () => {
    expect(regrasParaGuardar(['promessa_de_resultado', 'promessa_de_resultado', 'regra_da_marca'])).toEqual(['promessa_de_resultado', 'regra_da_marca']);
    expect(regrasParaGuardar(['o melhor hambúrguer do Rio', 'Retorno Garantido', 'politico_eleitoral'])).toEqual(['politico_eleitoral']);
    expect(regrasParaGuardar(undefined)).toEqual([]);
    expect(regrasParaGuardar(Array.from({ length: 30 }, (_, i) => `regra_${i}`))).toHaveLength(12);
  });
});

describe.skipIf(!hasDb)('o registro das recusas da conferência (A3, D-A3-15)', () => {
  let api: TestApi;
  let database: Database;

  beforeAll(async () => {
    await runMigrations({ connectionString: OWNER_URL, dir: resolve(process.cwd(), '../../packages/database/migrations') });
    api = await startApi();
    database = createDatabase({ connectionString: APP_URL, max: 2, applicationName: 'liame-test' });
  });

  afterAll(async () => {
    await database?.close();
    await api?.close();
  });

  async function empresa() {
    await resetIpRateLimits();
    const s = await signupAndLogin(api, undefined, 'Hamburgueria das Recusas');
    await enableMfa(api, s.cookie);
    const tenantId = s.me.active_organization_id as string;
    const brandId = (await api.call('GET', '/v1/brands', { cookie: s.cookie })).body.items[0].id as string;
    return { tenantId, userId: s.me.user.id as string, brandId };
  }
  const linhas = (tenantId: string) =>
    ownerQuery<{ member: string; workflow: string; kind: string; rules: string[]; rules_version: number | null; items: number; usage_id: string | null }>(
      `select member, workflow, kind, rules, rules_version, items, usage_id from liame.ai_refusal where tenant_id = $1 order by created_at, id`,
      [tenantId],
    );

  it('grava a recusa da empresa, com os nomes das regras e quantos textos; sem chamada, sem ligação de uso', async () => {
    const e = await empresa();
    await registrarRecusa(database, {
      tenantId: e.tenantId,
      brandId: e.brandId,
      userId: e.userId,
      usageId: null,
      member: 'pesquisador',
      workflow: 'pesquisador.pagina',
      kind: 'compliance',
      rules: ['dado_pessoal', 'dado_pessoal', '(21) 98888-7777'],
      rulesVersion: 2,
      items: 3,
    });
    // Rotina do sistema: sem pessoa no contexto, a recusa grava do mesmo jeito.
    await registrarRecusa(database, { tenantId: e.tenantId, brandId: e.brandId, userId: null, usageId: null, member: 'relatorios', workflow: 'revisao.semanal', kind: 'numero_fora' });
    expect(await linhas(e.tenantId)).toEqual([
      { member: 'pesquisador', workflow: 'pesquisador.pagina', kind: 'compliance', rules: ['dado_pessoal'], rules_version: 2, items: 3, usage_id: null },
      { member: 'relatorios', workflow: 'revisao.semanal', kind: 'numero_fora', rules: [], rules_version: null, items: 1, usage_id: null },
    ]);
  });

  it('a falha da contagem não derruba quem chamou: nome fora do formato ou uso que não existe só ficam no log', async () => {
    const [a, b] = [await empresa(), await empresa()];
    const base = { tenantId: a.tenantId, brandId: a.brandId, userId: a.userId, usageId: null, member: 'lia', workflow: 'conversa.lia', kind: 'compliance' };
    // O porquê é um nome curto; texto livre não entra (e não vira erro para quem chamou).
    await expect(registrarRecusa(database, { ...base, kind: 'Promessa de resultado!' })).resolves.toBeUndefined();
    await expect(registrarRecusa(database, { ...base, member: 'LIA, a assistente' })).resolves.toBeUndefined();
    // A chamada de uso que não existe: o banco recusa a linha, e a função só registra a falha.
    await expect(registrarRecusa(database, { ...base, usageId: '00000000-0000-4000-8000-000000000000' })).resolves.toBeUndefined();
    expect(await linhas(a.tenantId)).toEqual([]);
    // A que serve grava, e só na empresa dela.
    await registrarRecusa(database, base);
    expect((await linhas(a.tenantId)).map((l) => l.kind)).toEqual(['compliance']);
    expect(await linhas(b.tenantId)).toEqual([]);
  });

  it('a aplicação só lê e insere: não altera nem apaga uma recusa', async () => {
    const e = await empresa();
    await registrarRecusa(database, { tenantId: e.tenantId, brandId: e.brandId, userId: e.userId, usageId: null, member: 'lia', workflow: 'conversa.lia', kind: 'formato' });
    const tentar = (comando: ReturnType<typeof sql>) => withContext(database.db, { tenantId: e.tenantId, userId: e.userId }, (tx) => tx.execute(comando));
    await expect(tentar(sql`update liame.ai_refusal set kind = 'ok' where tenant_id = ${e.tenantId}`)).rejects.toThrow();
    await expect(tentar(sql`delete from liame.ai_refusal where tenant_id = ${e.tenantId}`)).rejects.toThrow();
    expect((await linhas(e.tenantId)).map((l) => l.kind)).toEqual(['formato']);
  });
});
