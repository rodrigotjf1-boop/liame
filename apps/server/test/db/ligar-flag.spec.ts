import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { createDatabase, type Database, runMigrations } from '@liame/database';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DATABASE } from '../../src/database/database.module.js';
import { definirFlagDaEmpresa } from '../../src/flags/distribuicao-flags.js';
import { FlagService } from '../../src/flags/flag.service.js';
import { enableMfa, ownerQuery, resetIpRateLimits, signupAndLogin, startApi, type TestApi } from '../helpers/api.js';
import { hasDb, OWNER_URL } from './env.js';

// A distribuição liga e desliga uma função para UMA empresa (ADR-012; `scripts/ligar-flag.ts`): a regra fica
// no escopo da empresa, vale só para ela, e fica na auditoria quem decidiu e por quê. É como a criação de cupom
// no Regem (`regem_write`, que nasce desligada) chega a um cliente.

describe.skipIf(!hasDb)('ligar e desligar uma flag para uma empresa (distribuição)', () => {
  let api: TestApi;
  let database: Database;
  let flags: FlagService;
  const criadas: string[] = [];

  async function empresa(nome: string) {
    const s = await signupAndLogin(api, undefined, nome);
    await enableMfa(api, s.cookie);
    const tenantId = s.me.active_organization_id as string;
    criadas.push(tenantId);
    return { cookie: s.cookie, tenantId, userId: s.me.user.id as string };
  }
  const ligada = async (e: { cookie: string }) => {
    flags.invalidate();
    return (await api.call('GET', '/v1/connections', { cookie: e.cookie })).body.regem_write as boolean;
  };
  const definir = (tenantId: string, ligar: boolean, over: Record<string, string> = {}) =>
    definirFlagDaEmpresa(database.db, { flag: 'regem_write', tenantId, ligada: ligar, por: 'Rodrigo', motivo: 'piloto do cupom de campanha', ...over });
  const regras = (tenantId: string) =>
    ownerQuery<{ value: unknown; created_by: string }>(`select value, created_by from liame.feature_flag_rule where flag_key = 'regem_write' and scope_type = 'tenant' and scope_id = $1`, [tenantId]);
  const trilha = (tenantId: string) =>
    ownerQuery<{ action: string; actor_type: string; actor_label: string; origin: string; reason: string; resource_id: string; before: unknown; after: unknown }>(
      `select action, actor_type, actor_label, origin, reason, resource_id, before, after from liame.audit_event where chain_key = $1 and action like 'flag.%' order by chain_seq`,
      [tenantId],
    );

  beforeAll(async () => {
    await runMigrations({ connectionString: OWNER_URL, dir: resolve(process.cwd(), '../../packages/database/migrations') });
    api = await startApi();
    await resetIpRateLimits();
    // O comando da distribuição roda com o papel dono do banco (o do aplicativo não grava regra de flag).
    database = createDatabase({ connectionString: OWNER_URL, max: 2, applicationName: 'liame-test-ligar-flag' });
    flags = api.app.get(FlagService);
  });
  afterAll(async () => {
    // O banco de testes é compartilhado: nenhuma regra desta spec fica para trás.
    for (const t of criadas) await ownerQuery(`delete from liame.feature_flag_rule where flag_key = 'regem_write' and scope_type = 'tenant' and scope_id = $1`, [t]);
    await database?.close();
    await api?.close();
  });

  it('o papel do aplicativo não grava regra de flag: a barreira do banco continua de pé', async () => {
    const a = await empresa('Lanchonete Flag');
    const doApp = api.app.get<Database>(DATABASE);
    await expect(definirFlagDaEmpresa(doApp.db, { flag: 'regem_write', tenantId: a.tenantId, ligada: true, por: 'Rodrigo', motivo: 'piloto do cupom de campanha' })).rejects.toThrow();
    expect(await regras(a.tenantId)).toEqual([]);
    expect(await trilha(a.tenantId)).toEqual([]);
  });

  it('ligar vale só para a empresa escolhida, fica na auditoria com quem decidiu e o motivo; repetir não muda nada', async () => {
    const a = await empresa('Mister Burgers Flag');
    const b = await empresa('Outra Hamburgueria Flag');
    expect([await ligada(a), await ligada(b)]).toEqual([false, false]);

    expect(await definir(a.tenantId, true)).toEqual({ empresa: 'Mister Burgers Flag', antes: null, padrao: false, valeAgora: true, mudou: true });
    expect([await ligada(a), await ligada(b)]).toEqual([true, false]);
    expect(await regras(a.tenantId)).toEqual([{ value: true, created_by: 'distribuição: Rodrigo' }]);
    expect(await trilha(a.tenantId)).toEqual([
      {
        action: 'flag.ligar',
        actor_type: 'system',
        actor_label: 'Distribuição DMS (Rodrigo)',
        origin: 'console',
        reason: 'piloto do cupom de campanha',
        resource_id: 'regem_write',
        before: { regra_da_empresa: null, padrao: false },
        after: { regra_da_empresa: true, vale_agora: true },
      },
    ]);

    expect(await definir(a.tenantId, true)).toMatchObject({ antes: true, valeAgora: true, mudou: false });
    expect(await regras(a.tenantId)).toHaveLength(1);
    expect(await trilha(a.tenantId)).toHaveLength(1);
    expect(await trilha(b.tenantId)).toEqual([]);
    expect((await api.call('GET', '/v1/audit/verify', { cookie: a.cookie })).body.ok).toBe(true);
  });

  it('desligar apaga a regra (a empresa volta ao padrão da flag) e também fica na auditoria; desligar o que já estava desligado não muda nada', async () => {
    const a = await empresa('Pizzaria Flag');
    await definir(a.tenantId, true);
    expect(await ligada(a)).toBe(true);

    expect(await definir(a.tenantId, false, { por: 'Camila', motivo: 'fim do piloto' })).toEqual({ empresa: 'Pizzaria Flag', antes: true, padrao: false, valeAgora: false, mudou: true });
    expect(await ligada(a)).toBe(false);
    expect(await regras(a.tenantId)).toEqual([]);
    expect((await trilha(a.tenantId)).map((t) => [t.action, t.actor_label, t.reason])).toEqual([
      ['flag.ligar', 'Distribuição DMS (Rodrigo)', 'piloto do cupom de campanha'],
      ['flag.desligar', 'Distribuição DMS (Camila)', 'fim do piloto'],
    ]);

    expect(await definir(a.tenantId, false)).toMatchObject({ antes: null, valeAgora: false, mudou: false });
    expect(await trilha(a.tenantId)).toHaveLength(2);
    expect((await api.call('GET', '/v1/audit/verify', { cookie: a.cookie })).body.ok).toBe(true);
  });

  it('recusas: flag que não existe, empresa que não existe, quem e motivo vazios, empresa suspensa (só para ligar); nenhuma deixa regra', async () => {
    const a = await empresa('Bar Flag');
    await expect(definirFlagDaEmpresa(database.db, { flag: 'nao_existe', tenantId: a.tenantId, ligada: true, por: 'Rodrigo', motivo: 'piloto do cupom' })).rejects.toThrow('a flag "nao_existe" não existe');
    await expect(definir(randomUUID(), true)).rejects.toThrow('empresa não encontrada');
    await expect(definir(a.tenantId, true, { por: ' ' })).rejects.toThrow('diga quem decidiu');
    await expect(definir(a.tenantId, true, { motivo: 'ok' })).rejects.toThrow('diga o motivo');

    await ownerQuery(`update liame.organization set status = 'suspensa' where id = $1`, [a.tenantId]);
    await expect(definir(a.tenantId, true)).rejects.toThrow('a empresa está suspensa');
    expect(await regras(a.tenantId)).toEqual([]);
    expect(await trilha(a.tenantId)).toEqual([]);
    // Desligar continua valendo na empresa suspensa (é o lado seguro).
    await ownerQuery(`insert into liame.feature_flag_rule (id, flag_key, scope_type, scope_id, value, created_by) values (gen_random_uuid(), 'regem_write', 'tenant', $1, 'true'::jsonb, 'testes')`, [a.tenantId]);
    expect(await definir(a.tenantId, false)).toMatchObject({ antes: true, valeAgora: false, mudou: true });
    await ownerQuery(`update liame.organization set status = 'ativa' where id = $1`, [a.tenantId]);
  });
});
