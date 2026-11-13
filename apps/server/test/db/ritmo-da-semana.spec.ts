import { randomInt, randomUUID } from 'node:crypto';
import type { Database } from '@liame/database';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ActionService } from '../../src/actions/action.service.js';
import { BudgetService } from '../../src/actions/budget.service.js';
import { currentStep, totpCode } from '../../src/auth/totp.js';
import { DATABASE } from '../../src/database/database.module.js';
import { FlagService } from '../../src/flags/flag.service.js';
import { KillSwitchService } from '../../src/kill-switch/kill-switch.service.js';
import { RegiaoService } from '../../src/regiao/regiao.service.js';
import { problemasDaVerba } from '../../src/regiao/ritmo-da-semana.js';
import { ActionExecutor } from '../../src/worker/action-executor.js';
import { RitmoDaSemanaService } from '../../src/worker/ritmo-da-semana.service.js';
import { ownerQuery, resetIpRateLimits, startApi, type TestApi } from '../helpers/api.js';
import { type EmpresaComMeta, empresaComMeta, ligarFlagDaEmpresa, MetaDeMentira } from '../helpers/meta-de-mentira.js';
import { hasDb } from './env.js';

// Plano da região, R7, parte 1b (migration 0156; D-RG-58 e D-RG-62), contra Postgres: a rotina do Gestor de tráfego
// monta o ritmo da semana que vem no domingo, a partir das 16h na loja, e pede em Aprovações. O que se prova:
//   - fora da hora (dia de semana, domingo cedo) e com a função desligada, nada é pedido;
//   - na hora: o ritmo guardado (a semana de segunda a domingo, as campanhas com verba diária e a verba de cada dia
//     dentro dos limites) e o pedido `ritmo_da_semana`, em nome do dono, esperando a aprovação com o código do app;
//   - uma proposta por marca e semana: a volta seguinte não pede de novo;
//   - aprovar marca o ritmo como aprovado, sem chamar a Meta; recusar deixa o ritmo cancelado na volta seguinte;
//   - a marca que não pode ter ritmo (a função desligada) não segura as que vêm depois dela, e com o lote de pedidos
//     cheio a volta seguinte continua de onde a anterior parou.

// 15/11/2026 é domingo; em São Paulo (UTC−3), 19:30Z são 16:30.
const DOMINGO_NA_HORA = new Date('2026-11-15T19:30:00Z');
const DOMINGO_CEDO = new Date('2026-11-15T18:59:00Z');
const QUARTA = new Date('2026-11-11T19:30:00Z');
const SEMANA = { de: '2026-11-16', ate: '2026-11-22' };

describe.skipIf(!hasDb)('o ritmo da semana: o pedido do Gestor de tráfego (R7, parte 1b)', () => {
  let api: TestApi;
  let executor: ActionExecutor;
  let rotina: RitmoDaSemanaService;
  let novaRotina: () => RitmoDaSemanaService;
  const meta = new MetaDeMentira();
  const lojas: string[] = [];

  beforeAll(async () => {
    api = await startApi();
    await resetIpRateLimits();
    await meta.ligar();
    const database: Database = api.app.get(DATABASE);
    executor = new ActionExecutor(database, api.app.get(BudgetService), api.app.get(KillSwitchService), api.app.get(FlagService));
    novaRotina = () => new RitmoDaSemanaService(database, api.app.get(ActionService), api.app.get(FlagService), api.app.get(RegiaoService));
    rotina = novaRotina();
  }, 120_000);
  beforeEach(async () => {
    await resetIpRateLimits();
    meta.normalizar();
  });
  afterAll(async () => {
    // As lojas com município de mentira saem (ERR-232): a rotina das fontes da região lê todo município com loja.
    for (const loja of lojas) await ownerQuery(`delete from liame.unit where id = $1`, [loja]);
    await meta.desligar();
    await api?.close();
  });

  /** A empresa com UMA conta de anúncios da Meta, UMA loja no mapa e três campanhas (duas cabem no ritmo, uma é pequena). */
  async function cenario(nome: string): Promise<EmpresaComMeta & { loja: string }> {
    const e = await empresaComMeta(api, meta, nome);
    await ownerQuery(`update liame.connected_account set disconnected_at = now() where id = $1`, [e.contaSemToken]);
    const loja = randomUUID();
    lojas.push(loja);
    await ownerQuery(
      `insert into liame.unit (id, tenant_id, brand_id, name, address_postal_code, address_district, address_city, address_state, ibge_city_code, location_source, delivery_radius_km)
       values ($1, $2, $3, 'Loja do Ritmo', '20520054', 'Centro', 'Cidade do Ritmo', 'RJ', $4, 'cep', 3)`,
      [loja, e.tenantId, e.brandId, String(randomInt(9_100_000, 9_999_999))],
    );
    await ownerQuery(
      `insert into liame.campaign (id, tenant_id, connected_account_id, provider, external_id, name, status, daily_budget_micros) values
         (gen_random_uuid(), $1, $2, 'meta_ads', $3, 'Combo sexta', 'ativa', 60000000), (gen_random_uuid(), $1, $2, 'meta_ads', $4, 'Smash em dobro', 'ativa', 40000000),
         (gen_random_uuid(), $1, $2, 'meta_ads', $5, 'Campanha pequena', 'ativa', 8000000)`,
      [e.tenantId, e.conta, `1202${randomInt(1e9, 9e9)}`, `1203${randomInt(1e9, 9e9)}`, `1204${randomInt(1e9, 9e9)}`],
    );
    await ligarFlagDaEmpresa(api, 'meta_write', e.tenantId, true);
    await ligarFlagDaEmpresa(api, 'regiao', e.tenantId, true);
    return { ...e, loja };
  }
  /** Liga ou desliga a função `ritmo_da_semana` para a empresa (o ajudante comum tem a lista fechada das outras). */
  async function ligarRitmo(tenantId: string, valor: boolean): Promise<void> {
    await ownerQuery(`delete from liame.feature_flag_rule where flag_key = 'ritmo_da_semana' and scope_type = 'tenant' and scope_id = $1`, [tenantId]);
    if (valor) {
      await ownerQuery(
        `insert into liame.feature_flag_rule (id, flag_key, scope_type, scope_id, value, rollout_percent, created_by)
         values (gen_random_uuid(), 'ritmo_da_semana', 'tenant', $1, 'true'::jsonb, null, 'testes')`,
        [tenantId],
      );
    }
    api.app.get(FlagService).invalidate();
  }
  const voltar = (e: EmpresaComMeta, agora: Date) => rotina.executarLote(5, { tenantIds: [e.tenantId] }, agora);
  const ritmos = (e: EmpresaComMeta) =>
    ownerQuery<{ id: string; status: string; source: string; week_start: string; week_end: string; plan: Record<string, unknown>; action_id: string | null; version: number; approved_at: string | null }>(
      `select id, status, source, week_start::text, week_end::text, plan, action_id, version, approved_at from liame.budget_rhythm where tenant_id = $1 order by created_at`,
      [e.tenantId],
    );
  const pedidoDe = async (id: string) =>
    (await ownerQuery<{ status: string; tool: string; action: string; plan_hash: string; actor_type: string; requested_by: string; mode: string; reserved_micros: string; before_state: Record<string, unknown> }>(
      `select status, tool, action, plan_hash, actor_type, requested_by, mode, reserved_micros::text, before_state from liame.action_request where id = $1`,
      [id],
    ))[0]!;

  it('fora da hora e com a função desligada, nada é pedido; na hora, o ritmo é guardado e pedido em nome do dono; uma proposta por semana', async () => {
    const e = await cenario('Brasa Ritmo da Semana');
    // A função do ritmo desligada: nem na hora.
    expect(await voltar(e, DOMINGO_NA_HORA)).toEqual([{ tenantId: e.tenantId, brandId: e.brandId, situacao: 'sem_ritmo', motivo: 'funcao_desligada' }]);
    await ligarRitmo(e.tenantId, true);
    // Fora da hora: dia de semana, e domingo antes das 16h na loja.
    expect(await voltar(e, QUARTA)).toEqual([]);
    expect(await voltar(e, DOMINGO_CEDO)).toEqual([]);
    expect(await ritmos(e)).toHaveLength(0);

    // Na hora: o ritmo da semana que vem, pedido em Aprovações.
    expect(await voltar(e, DOMINGO_NA_HORA)).toEqual([{ tenantId: e.tenantId, brandId: e.brandId, situacao: 'pedido', motivo: null }]);
    const [r] = await ritmos(e);
    expect(r).toMatchObject({ status: 'pedido', source: 'setor', week_start: SEMANA.de, week_end: SEMANA.ate, version: 1, approved_at: null });
    type Plano = { semana: unknown; loja: { nome: string }; dias: unknown[]; campanhas: Array<{ recurso: string; nome: string; base_micros: number; dias_micros: number[] }>; fora: unknown[]; situacao?: string };
    const plano = r!.plan as unknown as Plano;
    expect(plano).toMatchObject({ semana: SEMANA, loja: { nome: 'Loja do Ritmo' }, fora: [{ nome: 'Campanha pequena', motivo: 'verba_pequena' }] });
    expect(plano.situacao).toBeUndefined();
    expect(plano.dias).toHaveLength(7);
    expect(plano.campanhas.map((c) => [c.nome, c.base_micros])).toEqual([
      ['Combo sexta', 60_000_000],
      ['Smash em dobro', 40_000_000],
    ]);
    for (const c of plano.campanhas) {
      expect(c.recurso).toMatch(/^campanha:\d+$/);
      expect(problemasDaVerba(c.base_micros, c.dias_micros, null)).toEqual([]);
    }
    const pedido = await pedidoDe(r!.action_id!);
    expect(pedido).toMatchObject({ status: 'aguardando_aprovacao', tool: 'ritmo_da_semana', action: 'ritmo.aprovar', actor_type: 'agent', requested_by: e.userId, mode: 'APPROVAL', reserved_micros: '0' });
    expect(pedido.before_state).toMatchObject({ ritmo: r!.id, situacao: 'pedido', semana: SEMANA });
    // O pedido aparece para quem aprova, como qualquer outro.
    const visto = await api.call('GET', `/v1/actions/${r!.action_id}`, { cookie: e.cookie });
    expect(visto.status, JSON.stringify(visto.body)).toBe(200);
    expect(visto.body).toMatchObject({ tool: 'ritmo_da_semana', status: 'aguardando_aprovacao' });

    // Uma pessoa não pede o ritmo direto: quem monta e pede é a rotina; a pessoa aprova ou recusa.
    const direto = await api.call('POST', '/v1/actions', { cookie: e.cookie, body: { tool: 'ritmo_da_semana', brand_id: e.brandId, provider: 'meta_ads', account_id: e.conta, resource_id: `ritmo:${r!.id}`, params: {} } });
    expect(direto.status, JSON.stringify(direto.body)).toBe(422);
    expect(direto.body.code).toBe('acao-so-pelo-funcionario');

    // Uma proposta por marca e semana: a volta seguinte não pede de novo.
    expect(await voltar(e, new Date(DOMINGO_NA_HORA.getTime() + 15 * 60_000))).toEqual([]);
    expect(await ritmos(e)).toHaveLength(1);
  }, 120_000);

  it('aprovar com o código do app marca o ritmo como aprovado, sem mudar nada na Meta; recusar deixa o ritmo cancelado', async () => {
    const e = await cenario('Brasa Ritmo Aprovado');
    await ligarRitmo(e.tenantId, true);
    await voltar(e, DOMINGO_NA_HORA);
    const [r] = await ritmos(e);
    const antes = await pedidoDe(r!.action_id!);
    await ownerQuery(`update liame.app_user set totp_last_step = null where id = $1`, [e.userId]);
    await ownerQuery(`delete from liame.rate_limit where key = $1`, [`segundo-fator:${e.userId}`]);
    const escritasAntes = meta.criados.length;
    const aprovado = await api.call('POST', `/v1/actions/${r!.action_id}/approve`, { cookie: e.cookie, body: { plan_hash: antes.plan_hash, code: totpCode(e.secret, currentStep()) } });
    expect(aprovado.status, JSON.stringify(aprovado.body)).toBe(200);
    await executor.executeBatch(20, { tenantIds: [e.tenantId] });
    expect((await pedidoDe(r!.action_id!)).status).toBe('executada');
    const [depois] = await ritmos(e);
    expect(depois).toMatchObject({ status: 'aprovado', version: 2 });
    expect(depois!.approved_at).not.toBeNull();
    expect(meta.criados.length).toBe(escritasAntes);

    // Outra empresa recusa o dela: na volta seguinte, o ritmo fica cancelado (e não há outro para a mesma semana).
    const o = await cenario('Brasa Ritmo Recusado');
    await ligarRitmo(o.tenantId, true);
    await voltar(o, DOMINGO_NA_HORA);
    const [ro] = await ritmos(o);
    const recusa = await api.call('POST', `/v1/actions/${ro!.action_id}/reject`, { cookie: o.cookie, body: { plan_hash: (await pedidoDe(ro!.action_id!)).plan_hash, reason: 'Nesta semana não' } });
    expect(recusa.status, JSON.stringify(recusa.body)).toBe(200);
    expect(await voltar(o, new Date(DOMINGO_NA_HORA.getTime() + 15 * 60_000))).toEqual([]);
    expect(await ritmos(o)).toMatchObject([{ status: 'cancelado', version: 2 }]);
  }, 120_000);

  it('a marca que não pode ter ritmo não segura as outras; com o lote cheio, a volta seguinte continua de onde parou', async () => {
    const tres = [await cenario('Brasa Ritmo Fila Um'), await cenario('Brasa Ritmo Fila Dois'), await cenario('Brasa Ritmo Fila Três')];
    // A rotina percorre as marcas pela chave: a primeira da lista fica com a função desligada.
    tres.sort((x, y) => (x.brandId < y.brandId ? -1 : 1));
    const [a, b, c] = [tres[0]!, tres[1]!, tres[2]!];
    await ligarRitmo(b.tenantId, true);
    await ligarRitmo(c.tenantId, true);
    const fila = novaRotina();
    const volta = async () => (await fila.executarLote(1, { tenantIds: [a.tenantId, b.tenantId, c.tenantId] }, DOMINGO_NA_HORA)).map((r) => [r.brandId, r.situacao]);
    // O lote é de 1 pedido: a volta passa pela marca que não pode e pede o da segunda.
    expect(await volta()).toEqual([
      [a.brandId, 'sem_ritmo'],
      [b.brandId, 'pedido'],
    ]);
    // A volta seguinte continua depois da segunda, sem olhar de novo a primeira: a terceira.
    expect(await volta()).toEqual([[c.brandId, 'pedido']]);
    // Depois da terceira não há mais ninguém: a lista recomeça do início na volta seguinte, e só resta a que não pode.
    expect(await volta()).toEqual([]);
    expect(await volta()).toEqual([[a.brandId, 'sem_ritmo']]);
    expect(await ritmos(a)).toHaveLength(0);
    expect(await ritmos(b)).toMatchObject([{ status: 'pedido' }]);
    expect(await ritmos(c)).toMatchObject([{ status: 'pedido' }]);
  }, 120_000);
});
