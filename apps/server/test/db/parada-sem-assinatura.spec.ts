import { createDatabase, type Database, withSystem } from '@liame/database';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { criarAssinatura, encerrar, pagarFatura } from '../../src/cobranca/assinatura.js';
import { MOTIVO_DA_PARADA_SEM_ASSINATURA } from '../../src/cobranca/parada-sem-assinatura.js';
import { FlagService } from '../../src/flags/flag.service.js';
import { KillSwitchService } from '../../src/kill-switch/kill-switch.service.js';
import { ParadasSemAssinaturaService } from '../../src/worker/paradas-sem-assinatura.service.js';
import { enableMfa, ownerQuery, resetIpRateLimits, signupAndLogin, startApi, type TestApi } from '../helpers/api.js';
import { ligarFlagDaEmpresa } from '../helpers/meta-de-mentira.js';
import { APP_URL, hasDb } from './env.js';

// A7 · W3, parte 4c (migration 0162; D-A7-4, D-A7-6 e D-A7-108): a equipe parada sem assinatura paga. Com a cobrança
// ligada, a marca que nunca assinou (e a que espera o primeiro pagamento: sem período grátis) para pela rotina, sem pessoa;
// o primeiro pagamento a tira na hora; o fim da assinatura a põe na hora; uma pessoa não a desliga; a cobrança desligada e
// a marca arquivada a tiram; a empresa sem a cobrança nunca para; e as regras da tabela.

const SP = 'America/Sao_Paulo';
const meioDia = (dia: string) => new Date(`${dia}T15:00:00Z`);

type Empresa = { cookie: string; tenantId: string; brandId: string; userId: string };

describe.skipIf(!hasDb)('a equipe parada sem assinatura paga (A7 · W3, parte 4c)', () => {
  let api: TestApi;
  let database: Database;
  let rotina: ParadasSemAssinaturaService;

  beforeAll(async () => {
    api = await startApi();
    await resetIpRateLimits();
    database = createDatabase({ connectionString: APP_URL, max: 4, applicationName: 'liame-test' });
    rotina = new ParadasSemAssinaturaService(database, api.app.get(FlagService));
  }, 120_000);
  beforeEach(resetIpRateLimits);
  afterAll(async () => {
    await api?.close();
    await database?.close();
  });

  async function empresa(nome: string, { ligada = true } = {}): Promise<Empresa> {
    const s = await signupAndLogin(api, undefined, nome);
    await enableMfa(api, s.cookie);
    const tenantId = s.me.active_organization_id as string;
    const brandId = (await api.call('GET', '/v1/brands', { cookie: s.cookie })).body.items[0].id as string;
    const [u] = await ownerQuery<{ id: string }>(`select id from liame.app_user where email = $1`, [s.email]);
    await ownerQuery(`update liame.organization set timezone = $2 where id = $1`, [tenantId, SP]);
    if (ligada) await ligarFlagDaEmpresa(api, 'cobranca', tenantId, true);
    return { cookie: s.cookie, tenantId, brandId, userId: u!.id };
  }
  const rodar = (e: Empresa, dia = '2026-11-20') => rotina.executarLote(200, { tenantIds: [e.tenantId] }, meioDia(dia));
  const paradas = (e: Empresa) =>
    ownerQuery<{ id: string; level: string; brand_id: string; activated_by: string | null; deactivated: boolean; reason: string; subscription_id: string | null }>(
      `select id, level, brand_id, activated_by, deactivated_at is not null as deactivated, reason, subscription_id
         from liame.kill_switch where tenant_id = $1 and no_paid_subscription order by activated_at`,
      [e.tenantId],
    );
  const vivas = async (e: Empresa) => (await paradas(e)).filter((p) => !p.deactivated);
  const trava = (e: Empresa) => withSystem(database.db, (tx) => api.app.get(KillSwitchService).check(tx, { tenantId: e.tenantId, provider: 'ai', brandId: e.brandId }));
  async function assinar(e: Empresa, dia: string): Promise<string> {
    const [plano] = await ownerQuery<{ id: string }>(`select id from liame.billing_plan where key = 'essencial' and offered`);
    return withSystem(database.db, (tx) => criarAssinatura(tx, { tenantId: e.tenantId, brandId: e.brandId, planoId: plano!.id, forma: 'pix', quem: e.userId, agora: meioDia(dia) }));
  }
  async function pagarAPrimeira(id: string, dia: string) {
    const [f] = await ownerQuery<{ id: string }>(`select id from liame.billing_invoice where subscription_id = $1 and status = 'aberta'`, [id]);
    return withSystem(database.db, (tx) => pagarFatura(tx, { faturaId: f!.id, pagoEm: meioDia(dia), forma: 'pix', agora: meioDia(dia) }));
  }

  it('sem assinatura, a rotina para a equipe (sem pessoa); uma pessoa não desliga; esperando o pagamento segue parada; pagou, volta na hora', async () => {
    const e = await empresa('Casa Brasa Sem Assinatura');
    expect(await rodar(e)).toEqual([{ tenantId: e.tenantId, brandId: e.brandId, resultado: 'parou' }]);
    const [p] = await vivas(e);
    expect(p).toMatchObject({ level: 'brand', brand_id: e.brandId, activated_by: null, reason: MOTIVO_DA_PARADA_SEM_ASSINATURA, subscription_id: null });
    expect(await trava(e)).toMatchObject({ id: p!.id, level: 'brand' });
    // A rotina de novo: nada (uma viva por marca).
    expect(await rodar(e)).toEqual([]);
    expect(await vivas(e)).toHaveLength(1);

    // A empresa vê que é da cobrança, na lista e em Sua equipe; uma pessoa não a desliga.
    const lista = await api.call('GET', '/v1/kill-switches', { cookie: e.cookie });
    expect(lista.body.items.filter((i: { brand_id: string | null }) => i.brand_id === e.brandId)).toEqual([expect.objectContaining({ id: p!.id, by_billing: true })]);
    const equipe = await api.call('GET', `/v1/team?brand_id=${e.brandId}`, { cookie: e.cookie });
    expect(equipe.body.stop).toMatchObject({ id: p!.id, by_billing: true, by: null });
    const desligar = await api.call('DELETE', `/v1/kill-switches/${p!.id}`, { cookie: e.cookie });
    expect({ status: desligar.status, code: desligar.body.code }).toEqual({ status: 409, code: 'parada-da-cobranca' });
    expect(desligar.body.detail).toContain('não tem assinatura paga');

    // Assinou e espera o primeiro pagamento: segue parada (sem período grátis).
    const id = await assinar(e, '2026-11-21');
    expect(await rodar(e, '2026-11-21')).toEqual([]);
    expect(await vivas(e)).toHaveLength(1);
    // Pagou a primeira: volta na hora, sem esperar a rotina, com a auditoria.
    expect(await pagarAPrimeira(id, '2026-11-22')).toMatchObject({ situacao: 'paga', status: 'ativa' });
    expect(await vivas(e)).toEqual([]);
    expect(await trava(e)).toBeNull();
    expect(await rodar(e, '2026-11-22')).toEqual([]);
    const eventos = await ownerQuery<{ action: string; after: Record<string, unknown> }>(
      `select action, after from liame.audit_event where tenant_id = $1 and action in ('cobranca.parar_acoes', 'cobranca.voltar_acoes') order by chain_seq`,
      [e.tenantId],
    );
    expect(eventos.map((x) => [x.action, x.after.motivo])).toEqual([
      ['cobranca.parar_acoes', 'sem_assinatura_paga'],
      ['cobranca.voltar_acoes', 'sem_assinatura_paga'],
    ]);

    // A assinatura termina: a equipe para na hora (sem esperar a rotina).
    await withSystem(database.db, (tx) => encerrar(tx, id, 'cancelada', meioDia('2026-12-22')));
    expect(await vivas(e)).toHaveLength(1);
    expect(await trava(e)).not.toBeNull();
  });

  it('a cobrança desligada e a marca arquivada tiram a parada; a empresa sem a cobrança nunca para', async () => {
    const e = await empresa('Casa Brasa Desligou');
    await rodar(e);
    expect(await vivas(e)).toHaveLength(1);
    await ligarFlagDaEmpresa(api, 'cobranca', e.tenantId, false);
    expect(await rodar(e)).toEqual([{ tenantId: e.tenantId, brandId: e.brandId, resultado: 'voltou' }]);
    expect(await vivas(e)).toEqual([]);

    const arquivada = await empresa('Casa Brasa Arquivada');
    await rodar(arquivada);
    expect(await vivas(arquivada)).toHaveLength(1);
    await ownerQuery(`update liame.brand set archived_at = now() where id = $1`, [arquivada.brandId]);
    expect(await rodar(arquivada)).toEqual([{ tenantId: arquivada.tenantId, brandId: arquivada.brandId, resultado: 'voltou' }]);

    const semCobranca = await empresa('Casa Brasa Sem Cobranca', { ligada: false });
    expect(await rodar(semCobranca)).toEqual([]);
    expect(await paradas(semCobranca)).toEqual([]);
  });

  it('a tabela: a parada sem assinatura é da marca, da rotina e não da cobrança do atraso; uma viva por marca', async () => {
    const e = await empresa('Casa Brasa Regras', { ligada: false });
    const inserir = (nivel: string, por: string | null) =>
      ownerQuery(
        `insert into liame.kill_switch (id, level, tenant_id, brand_id, reason, activated_by, no_paid_subscription) values (gen_random_uuid(), $1, $2, $3, 'teste', $4, true)`,
        [nivel, e.tenantId, nivel === 'brand' ? e.brandId : null, por],
      );
    await expect(inserir('tenant', null)).rejects.toMatchObject({ code: '23514', constraint: 'kill_switch_sem_assinatura' });
    await expect(inserir('brand', e.userId)).rejects.toMatchObject({ code: '23514', constraint: 'kill_switch_sem_assinatura' });
    await inserir('brand', null);
    await expect(inserir('brand', null)).rejects.toMatchObject({ code: '23505', constraint: 'uq_kill_switch_sem_assinatura' });
  });
});
