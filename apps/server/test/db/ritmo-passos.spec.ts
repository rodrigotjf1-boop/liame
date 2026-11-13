import { randomInt, randomUUID } from 'node:crypto';
import { RegionRhythmResponse, RegionRhythmStopResponse } from '@liame/contracts';
import type { Database } from '@liame/database';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ActionService } from '../../src/actions/action.service.js';
import { BudgetService } from '../../src/actions/budget.service.js';
import { naTransacaoDaEmpresa } from '../../src/ai/na-empresa.js';
import { DATABASE } from '../../src/database/database.module.js';
import { GESTOR_DE_TRAFEGO } from '../../src/equipe/membros.js';
import { FlagService } from '../../src/flags/flag.service.js';
import { KillSwitchService } from '../../src/kill-switch/kill-switch.service.js';
import { RegiaoService } from '../../src/regiao/regiao.service.js';
import { diaDaSemana } from '../../src/regiao/ritmo-da-semana.js';
import { diasDepois } from '../../src/regiao/semana.js';
import { diaNoFuso } from '../../src/results/fora-do-normal.js';
import { ActionExecutor } from '../../src/worker/action-executor.js';
import { RitmoDaSemanaService } from '../../src/worker/ritmo-da-semana.service.js';
import { ownerQuery, resetIpRateLimits, startApi, type TestApi } from '../helpers/api.js';
import { campanhaComRecomendacao, type EmpresaComMeta, empresaComMeta, ligarConectorNaMetaDeMentira, ligarFlagDaEmpresa, MetaDeMentira, objetoLido } from '../helpers/meta-de-mentira.js';
import { hasDb } from './env.js';

// Plano da região, R7, parte 1b-2 (D-RG-62 e D-RG-63), contra Postgres e a Meta de mentira: o passo de cada dia do ritmo
// da semana que uma pessoa aprovou. O executor confere o portão com o relógio de verdade, então os ritmos do teste são
// da semana de HOJE (ou da que acabou), e o dia seguinte só é provado até o pedido. O que se prova:
//   - o passo de hoje: o pedido do Gestor de tráfego nasce aprovado (a pessoa aprovou a semana), sem outro código do app,
//     com a ação própria da política e a reserva de quem aumenta; a verba muda na Meta; uma tentativa por dia;
//   - a pessoa não pede o passo direto, e o portão segura o que sai do aprovado, do dia ou da função;
//   - a campanha mexida por fora (a verba ou a pausa) sai do ritmo e fica como a pessoa deixou;
//   - parar o ritmo: sem o código do app; o passo na fila não sai, e a verba volta à de antes;
//   - o fim da semana: a volta em até 10% por dia, e o ritmo se encerra quando todas voltaram;
//   - a semana que continua de outra: a verba de hoje é a de antes do ritmo, e a segunda parte da verba de domingo;
//   - o que o ritmo NÃO liga: o pedido de verba comum de um funcionário de IA segue como sempre.

const REAL = 1_000_000;
const HOJE = diaNoFuso(new Date(), 'America/Sao_Paulo');
/** A segunda-feira da semana de um dia. */
const segundaDe = (dia: string) => diasDepois(dia, -((diaDaSemana(dia) + 6) % 7));
const meioDiaDe = (dia: string) => new Date(`${dia}T15:00:00Z`);

type Empresa = EmpresaComMeta & { loja: string };
type Passo = { resource_id: string; dia: string; kind: string; status: string; target: string; expected: string; reason: string | null; action_id: string | null };

describe.skipIf(!hasDb)('o ritmo da semana: os passos do dia (R7, parte 1b-2)', () => {
  let api: TestApi;
  let database: Database;
  let executor: ActionExecutor;
  let novaRotina: () => RitmoDaSemanaService;
  const meta = new MetaDeMentira();
  const lojas: string[] = [];

  beforeAll(async () => {
    api = await startApi();
    await resetIpRateLimits();
    await meta.ligar();
    database = api.app.get(DATABASE);
    executor = new ActionExecutor(database, api.app.get(BudgetService), api.app.get(KillSwitchService), api.app.get(FlagService));
    ligarConectorNaMetaDeMentira(api, meta);
    novaRotina = () => new RitmoDaSemanaService(database, api.app.get(ActionService), api.app.get(FlagService), api.app.get(RegiaoService));
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

  /** Liga ou desliga uma função para a empresa (o ajudante comum tem a lista fechada das outras). */
  async function ligar(chave: string, tenantId: string, valor: boolean): Promise<void> {
    await ownerQuery(`delete from liame.feature_flag_rule where flag_key = $1 and scope_type = 'tenant' and scope_id = $2`, [chave, tenantId]);
    if (valor) {
      await ownerQuery(
        `insert into liame.feature_flag_rule (id, flag_key, scope_type, scope_id, value, rollout_percent, created_by)
         values (gen_random_uuid(), $1, 'tenant', $2, 'true'::jsonb, null, 'testes')`,
        [chave, tenantId],
      );
    }
    api.app.get(FlagService).invalidate();
  }

  /** A empresa com uma conta de anúncios, uma loja no mapa, as funções ligadas e os limites definidos (o teto por campanha e o do mês). */
  async function cenario(nome: string): Promise<Empresa> {
    const e = await empresaComMeta(api, meta, nome);
    await ownerQuery(`update liame.connected_account set disconnected_at = now() where id = $1`, [e.contaSemToken]);
    const loja = randomUUID();
    lojas.push(loja);
    await ownerQuery(
      `insert into liame.unit (id, tenant_id, brand_id, name, address_postal_code, address_district, address_city, address_state, ibge_city_code, location_source, delivery_radius_km)
       values ($1, $2, $3, 'Loja do Ritmo', '20520054', 'Centro', 'Cidade do Ritmo', 'RJ', $4, 'cep', 3)`,
      [loja, e.tenantId, e.brandId, String(randomInt(9_100_000, 9_999_999))],
    );
    await ligarFlagDaEmpresa(api, 'meta_write', e.tenantId, true);
    await ligarFlagDaEmpresa(api, 'regiao', e.tenantId, true);
    await ligar('ritmo_da_semana', e.tenantId, true);
    const teto = await api.call('POST', '/v1/policies', { cookie: e.cookie, body: { brand_id: null, document: { rules: [{ type: 'max_value', action: 'orcamento.*', max_micros: 150 * REAL }] } } });
    expect(teto.status, JSON.stringify(teto.body)).toBe(201);
    expect((await api.call('PUT', '/v1/budget/policies', { cookie: e.cookie, body: { limit_micros: 1_000_000 * REAL } })).status).toBe(204);
    return { ...e, loja };
  }

  /** Um ritmo guardado como a rotina de domingo o guarda, já na situação pedida (o padrão: aprovado, na semana de hoje). */
  async function ritmo(
    e: Empresa,
    campanhas: Array<{ recurso: string; nome: string; base: number; dias: number[] }>,
    o: { inicio?: string; status?: 'pedido' | 'aprovado' | 'parado'; pesoDeDomingo?: number } = {},
  ): Promise<string> {
    const id = randomUUID();
    const status = o.status ?? 'aprovado';
    const dias = Array.from({ length: 7 }, (_, i) => diasDepois(o.inicio ?? segundaDe(HOJE), i));
    const plano = {
      ritmo: id,
      marca: e.brandId,
      loja: { id: e.loja, nome: 'Loja do Ritmo' },
      semana: { de: dias[0], ate: dias[6] },
      fonte: 'loja',
      dias: dias.map((dia, i) => ({ dia, dia_da_semana: diaDaSemana(dia), peso: i === 6 ? (o.pesoDeDomingo ?? 1) : 1, porques: [] })),
      campanhas: campanhas.map((c) => ({ recurso: c.recurso, nome: c.nome, base_micros: c.base * REAL, dias_micros: c.dias.map((v) => Math.round(v * REAL)) })),
      fora: [],
      teto_micros: null,
      moeda: 'BRL',
    };
    await ownerQuery(
      `insert into liame.budget_rhythm (id, tenant_id, brand_id, unit_id, ad_account_id, week_start, week_end, status, source, plan, approved_at, stopped_at, stopped_by)
       values ($1, $2, $3, $4, $5, $6::date, $7::date, $8, 'loja', $9::jsonb,
               case when $8 <> 'pedido' then now() end, case when $8 = 'parado' then now() end, case when $8 = 'parado' then $10::uuid end)`,
      [id, e.tenantId, e.brandId, e.loja, e.conta, dias[0], dias[6], status, JSON.stringify(plano), e.userId],
    );
    return id;
  }
  const todosOsDias = (reais: number) => Array<number>(7).fill(reais);

  const passos = (ritmoId: string) =>
    ownerQuery<Passo>(
      `select resource_id, day::text as dia, kind, status, target_micros::text as target, expected_micros::text as expected, reason, action_id
         from liame.budget_rhythm_step where rhythm_id = $1 order by day, created_at, id`,
      [ritmoId],
    );
  const pedidosDe = (e: Empresa) =>
    ownerQuery<{ id: string; tool: string; action: string; status: string; status_reason: string | null; mode: string; actor_type: string; agent_key: string | null; requested_by: string; resource_id: string; value: string; atual: string; reservado: string }>(
      `select id, tool, action, status, status_reason, mode, actor_type, agent_key, requested_by, resource_id, value_micros::text as value, current_value_micros::text as atual, reserved_micros::text as reservado
         from liame.action_request where tenant_id = $1 order by created_at, id`,
      [e.tenantId],
    );
  /** As verbas que a Meta recebeu de verdade para o objeto (em centavos), na ordem. */
  const verbasNaMeta = (id: string) =>
    meta
      .escritasDe(id)
      .filter((c) => !c.validar)
      .map((c) => c.params.daily_budget);
  const executar = (e: Empresa) => executor.runCycle(20, { tenantIds: [e.tenantId] });
  const resumo = (r: Array<{ recurso: string | null; situacao: string }>) => r.map((x) => [x.recurso, x.situacao]);

  it('o passo de hoje: o pedido nasce aprovado pelo ritmo, com a ação própria e a reserva de quem aumenta; a verba muda na Meta; uma tentativa por dia', async () => {
    const e = await cenario('Brasa Passo De Hoje');
    const a = await objetoLido(meta, e, 'campanha', { name: 'Combo sexta', daily_budget: '6000' });
    const b = await objetoLido(meta, e, 'campanha', { name: 'Smash em dobro', daily_budget: '4000' });
    const id = await ritmo(e, [
      { recurso: a.recurso, nome: 'Combo sexta', base: 60, dias: todosOsDias(66) },
      { recurso: b.recurso, nome: 'Smash em dobro', base: 40, dias: todosOsDias(36) },
    ]);
    const rotina = novaRotina();
    const volta = (agora = new Date()) => rotina.executarPassos(20, { tenantIds: [e.tenantId] }, agora);

    expect(resumo(await volta())).toEqual([
      [a.recurso, 'pedido'],
      [b.recurso, 'pedido'],
    ]);
    const pedidos = await pedidosDe(e);
    const comum = { tool: 'orcamento_do_ritmo', status: 'aprovada', mode: 'AUTO', actor_type: 'agent', agent_key: GESTOR_DE_TRAFEGO, requested_by: e.userId };
    expect(pedidos.find((p) => p.resource_id === a.recurso)).toMatchObject({ ...comum, action: 'orcamento.ritmo_aumentar', value: String(66 * REAL), atual: String(60 * REAL), reservado: String(6 * REAL) });
    expect(pedidos.find((p) => p.resource_id === b.recurso)).toMatchObject({ ...comum, action: 'orcamento.ritmo_reduzir', value: String(36 * REAL), atual: String(40 * REAL), reservado: '0' });
    // Nenhuma aprovação nova: a pessoa aprovou a semana, e o passo sai pelo ritmo.
    expect((await ownerQuery<{ n: string }>(`select count(*)::text as n from liame.approval where tenant_id = $1`, [e.tenantId]))[0]!.n).toBe('0');
    expect([verbasNaMeta(a.id), verbasNaMeta(b.id)]).toEqual([[], []]);

    await executar(e);
    expect([verbasNaMeta(a.id), verbasNaMeta(b.id)]).toEqual([['6600'], ['3600']]);
    // A volta seguinte fecha os passos e não pede de novo hoje.
    expect(await volta()).toEqual([]);
    expect(await passos(id)).toMatchObject([
      { resource_id: a.recurso, dia: HOJE, kind: 'ritmo', status: 'feito', target: String(66 * REAL), expected: String(60 * REAL), reason: null },
      { resource_id: b.recurso, dia: HOJE, kind: 'ritmo', status: 'feito', target: String(36 * REAL), expected: String(40 * REAL), reason: null },
    ]);
    expect(await pedidosDe(e)).toHaveLength(2);

    // Uma pessoa não pede o passo direto: ele só sai pelo ritmo aprovado.
    const direto = await api.call('POST', '/v1/actions', {
      cookie: e.cookie,
      body: { tool: 'orcamento_do_ritmo', provider: 'meta_ads', account_id: e.conta, resource_id: a.recurso, params: { daily_budget_micros: 70 * REAL, expected_micros: 66 * REAL } },
    });
    expect([direto.status, direto.body.code], JSON.stringify(direto.body)).toEqual([422, 'acao-so-pelo-automatico']);
  }, 120_000);

  it('o portão: fora do aprovado, do dia ou da função, o passo não é pedido; o que o ritmo não liga segue como sempre', async () => {
    const e = await cenario('Brasa Portão Do Ritmo');
    const a = await objetoLido(meta, e, 'campanha', { name: 'Combo sexta', daily_budget: '6000' });
    const id = await ritmo(e, [{ recurso: a.recurso, nome: 'Combo sexta', base: 60, dias: todosOsDias(63) }]);
    const actions = api.app.get(ActionService);
    const passo = async (dia: string, valor: number) => {
      await ownerQuery(`delete from liame.budget_rhythm_step where rhythm_id = $1`, [id]);
      await ownerQuery(
        `insert into liame.budget_rhythm_step (id, tenant_id, rhythm_id, day, resource_id, kind, target_micros, expected_micros, status) values (gen_random_uuid(), $1, $2, $3::date, $4, 'ritmo', $5, $6, 'pedido')`,
        [e.tenantId, id, dia, a.recurso, valor * REAL, 60 * REAL],
      );
      return naTransacaoDaEmpresa(database, { tenantId: e.tenantId, userId: null }, () =>
        actions.ajustarPeloRitmo(
          { tenantId: e.tenantId, agentKey: GESTOR_DE_TRAFEGO, agentLabel: 'Gestor de tráfego', emNomeDe: e.userId },
          { tool: 'orcamento_do_ritmo', brand_id: e.brandId, provider: 'meta_ads', account_id: e.conta, resource_id: a.recurso, params: { daily_budget_micros: valor * REAL, expected_micros: 60 * REAL } },
          { ritmo: id, dia, tipo: 'ritmo' },
        ),
      );
    };
    // Acima do que a pessoa aprovou para o dia (R$ 63,00).
    await expect(passo(HOJE, 66)).rejects.toMatchObject({ code: 'ritmo-segurado', detail: expect.stringContaining('acima_do_aprovado') });
    // O passo de ontem não sai hoje.
    await expect(passo(diasDepois(HOJE, -1), 63)).rejects.toMatchObject({ code: 'ritmo-segurado', detail: expect.stringContaining('fora_do_dia') });
    // A função desligada, e o ritmo parado.
    await ligar('ritmo_da_semana', e.tenantId, false);
    await expect(passo(HOJE, 63)).rejects.toMatchObject({ code: 'ritmo-segurado', detail: expect.stringContaining('funcao_desligada') });
    await ligar('ritmo_da_semana', e.tenantId, true);
    await ownerQuery(`update liame.budget_rhythm set status = 'parado', stopped_at = now() where id = $1`, [id]);
    await expect(passo(HOJE, 63)).rejects.toMatchObject({ code: 'ritmo-segurado', detail: expect.stringContaining('ritmo_parado') });
    await ownerQuery(`update liame.budget_rhythm set status = 'aprovado', stopped_at = null where id = $1`, [id]);
    // Dentro do aprovado, entra (e a política da empresa que pede aprovação para a verba do funcionário segura o passo).
    expect(await passo(HOJE, 63)).toMatch(/^[0-9a-f-]{36}$/);
    expect(await pedidosDe(e)).toMatchObject([{ tool: 'orcamento_do_ritmo', status: 'aprovada', action: 'orcamento.ritmo_aumentar' }]);
    expect(verbasNaMeta(a.id)).toEqual([]);

    // O que o ritmo NÃO liga (D-A7-11): com a função do ritmo ligada, o pedido de verba comum do funcionário de IA segue
    // como sempre. Sem o modo Aprovação definido para ele, o Action Service recusa.
    await ligar('modo_aprovacao', e.tenantId, true);
    const r = await campanhaComRecomendacao(meta, e, 'orcamento_aumentar', { dia: HOJE, nome: 'Verba comum' });
    const comum = () =>
      naTransacaoDaEmpresa(database, { tenantId: e.tenantId, userId: null }, () =>
        actions.pedirPeloFuncionario(
          { tenantId: e.tenantId, agentKey: GESTOR_DE_TRAFEGO, agentLabel: 'Gestor de tráfego', emNomeDe: e.userId },
          { tool: 'orcamento_ajustar', provider: 'meta_ads', account_id: e.conta, resource_id: r.recurso, params: { daily_budget_micros: 33 * REAL }, recommendation_id: r.recomendacao },
        ),
      );
    await expect(comum()).rejects.toMatchObject({ code: 'modo-nao-e-aprovacao' });
    expect((await pedidosDe(e)).filter((p) => p.tool === 'orcamento_ajustar')).toEqual([]);
  }, 120_000);

  it('a campanha mexida por fora (a verba ou a pausa) sai do ritmo e fica como a pessoa deixou', async () => {
    const e = await cenario('Brasa Mexida Por Fora');
    // Na Meta, alguém pôs R$ 70,00 onde o Liame esperava R$ 60,00; e pausou a outra.
    const mudada = await objetoLido(meta, e, 'campanha', { name: 'Verba mudada', daily_budget: '7000' });
    const pausada = await objetoLido(meta, e, 'campanha', { name: 'Pausada', daily_budget: '4000', status: 'PAUSED', effective_status: 'PAUSED' });
    const id = await ritmo(e, [
      { recurso: mudada.recurso, nome: 'Verba mudada', base: 60, dias: todosOsDias(66) },
      { recurso: pausada.recurso, nome: 'Pausada', base: 40, dias: todosOsDias(44) },
    ]);
    const rotina = novaRotina();
    const volta = () => rotina.executarPassos(20, { tenantIds: [e.tenantId] }, new Date());
    expect(resumo(await volta())).toEqual([
      [mudada.recurso, 'fora'],
      [pausada.recurso, 'fora'],
    ]);
    expect(await passos(id)).toMatchObject([
      { resource_id: mudada.recurso, status: 'fora', reason: 'a campanha não está como o Liame deixou', action_id: null },
      { resource_id: pausada.recurso, status: 'fora', reason: 'a campanha não está como o Liame deixou', action_id: null },
    ]);
    // Nenhum pedido, nenhuma escrita, e a volta seguinte não mexe mais nelas.
    expect(await pedidosDe(e)).toEqual([]);
    expect(await volta()).toEqual([]);
    expect([verbasNaMeta(mudada.id), verbasNaMeta(pausada.id)]).toEqual([[], []]);
  }, 120_000);

  it('parar o ritmo: sem o código do app; o passo na fila não sai, e a verba que já subiu volta à de antes', async () => {
    // (1) Parado com o passo ainda na fila: a Meta não é tocada.
    const e = await cenario('Brasa Ritmo Parado Na Fila');
    const a = await objetoLido(meta, e, 'campanha', { name: 'Combo sexta', daily_budget: '6000' });
    const id = await ritmo(e, [{ recurso: a.recurso, nome: 'Combo sexta', base: 60, dias: todosOsDias(66) }]);
    const rotina = novaRotina();
    const volta = (agora = new Date()) => rotina.executarPassos(20, { tenantIds: [e.tenantId] }, agora);
    expect(resumo(await volta())).toEqual([[a.recurso, 'pedido']]);
    const parar = await api.call('POST', `/v1/region/rhythm/${id}/stop`, { cookie: e.cookie });
    expect(parar.status, JSON.stringify(parar.body)).toBe(200);
    expect(RegionRhythmStopResponse.parse(parar.body)).toMatchObject({ id, status: 'parado', week: { from: segundaDe(HOJE) } });
    expect(await ownerQuery(`select status, stopped_by from liame.budget_rhythm where id = $1`, [id])).toEqual([{ status: 'parado', stopped_by: e.userId }]);
    const [auditoria] = await ownerQuery<{ action: string; after: unknown }>(`select action, "after" from liame.audit_event where resource_id = $1 order by chain_seq desc limit 1`, [id]);
    expect(auditoria).toMatchObject({ action: 'ritmo.parar', after: { status: 'parado' } });
    await executar(e);
    expect(verbasNaMeta(a.id)).toEqual([]);
    expect(await pedidosDe(e)).toMatchObject([{ status: 'falhou', status_reason: 'ritmo da semana: ritmo_parado' }]);
    // A volta seguinte fecha o passo como bloqueado; a verba nunca saiu da de antes, então não há o que devolver.
    expect(resumo(await volta())).toEqual([[a.recurso, 'igual']]);
    expect(await passos(id)).toMatchObject([
      { kind: 'ritmo', status: 'bloqueado', reason: 'ritmo da semana: ritmo_parado' },
      { kind: 'volta', status: 'igual', target: String(60 * REAL) },
    ]);
    expect(await volta()).toEqual([]);
    // Parar de novo, o ritmo que ainda espera a aprovação e o de outra empresa.
    expect([(await api.call('POST', `/v1/region/rhythm/${id}/stop`, { cookie: e.cookie })).body.code]).toEqual(['ritmo-nao-esta-rodando']);
    const pedido = await ritmo(e, [{ recurso: a.recurso, nome: 'Combo sexta', base: 60, dias: todosOsDias(66) }], { status: 'pedido', inicio: diasDepois(segundaDe(HOJE), 7) });
    const aindaPedido = await api.call('POST', `/v1/region/rhythm/${pedido}/stop`, { cookie: e.cookie });
    expect([aindaPedido.status, aindaPedido.body.code]).toEqual([409, 'ritmo-nao-esta-rodando']);

    // (2) Parado depois de a verba subir: o passo de volta devolve a de antes (R$ 44,00 → R$ 40,00 cabe nos 10%).
    const o = await cenario('Brasa Ritmo Parado Depois');
    const b = await objetoLido(meta, o, 'campanha', { name: 'Smash em dobro', daily_budget: '4000' });
    const doOutro = await ritmo(o, [{ recurso: b.recurso, nome: 'Smash em dobro', base: 40, dias: todosOsDias(44) }]);
    const outra = novaRotina();
    const voltaDoOutro = (agora = new Date()) => outra.executarPassos(20, { tenantIds: [o.tenantId] }, agora);
    // O ritmo de outra empresa não se para daqui.
    expect((await api.call('POST', `/v1/region/rhythm/${doOutro}/stop`, { cookie: e.cookie })).status).toBe(404);
    expect(resumo(await voltaDoOutro())).toEqual([[b.recurso, 'pedido']]);
    await executar(o);
    expect(await voltaDoOutro()).toEqual([]);
    expect((await api.call('POST', `/v1/region/rhythm/${doOutro}/stop`, { cookie: o.cookie })).status).toBe(200);
    expect(resumo(await voltaDoOutro())).toEqual([[b.recurso, 'pedido']]);
    expect((await pedidosDe(o)).at(-1)).toMatchObject({ tool: 'orcamento_do_ritmo', action: 'orcamento.ritmo_reduzir', status: 'aprovada', value: String(40 * REAL), atual: String(44 * REAL) });
    await executar(o);
    expect(verbasNaMeta(b.id)).toEqual(['4400', '4000']);
    expect(await voltaDoOutro()).toEqual([]);
    expect(await passos(doOutro)).toMatchObject([
      { kind: 'ritmo', status: 'feito', target: String(44 * REAL), expected: String(40 * REAL) },
      { kind: 'volta', status: 'feito', target: String(40 * REAL), expected: String(44 * REAL) },
    ]);
    // No dia seguinte a verba já é a de antes: a rotina só registra, e depois não olha mais o ritmo.
    const amanha = meioDiaDe(diasDepois(HOJE, 1));
    expect(resumo(await voltaDoOutro(amanha))).toEqual([[b.recurso, 'igual']]);
    expect(await voltaDoOutro(meioDiaDe(diasDepois(HOJE, 2)))).toEqual([]);
  }, 180_000);

  it('o fim da semana: a verba volta à de antes em até 10% por dia, e o ritmo se encerra quando todas voltaram', async () => {
    const e = await cenario('Brasa Fim Da Semana');
    // A semana passada: o domingo terminou em R$ 72,00 numa (a de antes era R$ 60,00) e na de antes na outra.
    const a = await objetoLido(meta, e, 'campanha', { name: 'Combo sexta', daily_budget: '7200' });
    const b = await objetoLido(meta, e, 'campanha', { name: 'Smash em dobro', daily_budget: '4000' });
    const passada = diasDepois(segundaDe(HOJE), -7);
    const id = await ritmo(
      e,
      [
        { recurso: a.recurso, nome: 'Combo sexta', base: 60, dias: todosOsDias(72) },
        { recurso: b.recurso, nome: 'Smash em dobro', base: 40, dias: todosOsDias(40) },
      ],
      { inicio: passada },
    );
    await ownerQuery(
      `insert into liame.budget_rhythm_step (id, tenant_id, rhythm_id, day, resource_id, kind, target_micros, expected_micros, status) values (gen_random_uuid(), $1, $2, $3::date, $4, 'ritmo', $5, $6, 'feito')`,
      [e.tenantId, id, diasDepois(passada, 6), a.recurso, 72 * REAL, 66 * REAL],
    );
    const rotina = novaRotina();
    const volta = (agora = new Date()) => rotina.executarPassos(20, { tenantIds: [e.tenantId] }, agora);

    // Hoje: R$ 72,00 → R$ 64,80 (10% por mudança); a outra já está na de antes.
    expect(resumo(await volta())).toEqual([
      [a.recurso, 'pedido'],
      [b.recurso, 'igual'],
    ]);
    expect((await pedidosDe(e)).at(-1)).toMatchObject({ action: 'orcamento.ritmo_reduzir', value: String(64.8 * REAL), atual: String(72 * REAL), status: 'aprovada' });
    await executar(e);
    expect(verbasNaMeta(a.id)).toEqual(['6480']);
    expect((await ownerQuery(`select status from liame.budget_rhythm where id = $1`, [id]))[0]).toEqual({ status: 'aprovado' });

    // Amanhã: R$ 64,80 → R$ 60,00 (cabe nos 10%). O executor confere o dia com o relógio de verdade, então aqui o passo
    // só é provado até o pedido; o teste o dá por feito.
    const amanha = meioDiaDe(diasDepois(HOJE, 1));
    expect(resumo(await volta(amanha))).toEqual([[a.recurso, 'pedido']]);
    const deAmanha = (await passos(id)).at(-1)!;
    expect(deAmanha).toMatchObject({ dia: diasDepois(HOJE, 1), kind: 'volta', status: 'pedido', target: String(60 * REAL), expected: String(64.8 * REAL) });
    await ownerQuery(`update liame.budget_rhythm_step set status = 'feito' where rhythm_id = $1 and day = $2::date`, [id, diasDepois(HOJE, 1)]);

    // Depois de amanhã: todas voltaram, e o ritmo se encerra.
    const depois = meioDiaDe(diasDepois(HOJE, 2));
    expect(resumo(await volta(depois))).toEqual([
      [a.recurso, 'igual'],
      [null, 'encerrado'],
    ]);
    expect((await ownerQuery(`select status, version from liame.budget_rhythm where id = $1`, [id]))[0]).toEqual({ status: 'encerrado', version: 2 });
    expect(await volta(depois)).toEqual([]);
  }, 120_000);

  it('a semana que continua de outra: a verba de hoje é a de antes do ritmo, e a segunda parte da verba de domingo', async () => {
    const e = await cenario('Brasa Semana Que Continua');
    const a = await objetoLido(meta, e, 'campanha', { name: 'Combo sexta', daily_budget: '7200' });
    // A leitura da conta já guardou a verba que o ritmo deixou (R$ 72,00), e não a de antes (R$ 60,00).
    await ownerQuery(`update liame.campaign set daily_budget_micros = $3 where tenant_id = $1 and external_id = $2`, [e.tenantId, a.id, 72 * REAL]);
    const id = await ritmo(e, [{ recurso: a.recurso, nome: 'Combo sexta', base: 60, dias: todosOsDias(72) }], { pesoDeDomingo: 1.2 });
    await ownerQuery(
      `insert into liame.budget_rhythm_step (id, tenant_id, rhythm_id, day, resource_id, kind, target_micros, expected_micros, status) values (gen_random_uuid(), $1, $2, $3::date, $4, 'ritmo', $5, $6, 'feito')`,
      [e.tenantId, id, HOJE, a.recurso, 72 * REAL, 66 * REAL],
    );
    const r = await api.call('GET', `/v1/region/rhythm?brand_id=${e.brandId}&unit_id=${e.loja}`, { cookie: e.cookie });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const previa = RegionRhythmResponse.parse(r.body);
    expect(previa.status).toBe('pronto');
    expect(previa.week?.from).toBe(diasDepois(segundaDe(HOJE), 7));
    const [campanha] = previa.campaigns;
    // A verba de hoje é a de antes do ritmo; a semana não gasta mais do que 7 dias dela.
    expect(campanha!.base_micros).toBe(60 * REAL);
    expect(campanha!.week_micros).toBeLessThanOrEqual(7 * 60 * REAL);
    // A segunda parte dos R$ 72,00 de domingo: no máximo 10% abaixo (R$ 64,80), e o peso dela não desce além do passo.
    expect(campanha!.days_micros[0]).toBeGreaterThanOrEqual(64.8 * REAL);
    expect(campanha!.days_micros[0]).toBeLessThanOrEqual(72 * REAL);
    expect(previa.days[0]!.weight).toBeGreaterThanOrEqual(1.086);
    // Sem o ritmo em curso (parado e já de volta), a verba de hoje volta a ser a que a conta mostra.
    await ownerQuery(`update liame.budget_rhythm set status = 'encerrado' where id = $1`, [id]);
    const semRitmo = RegionRhythmResponse.parse((await api.call('GET', `/v1/region/rhythm?brand_id=${e.brandId}&unit_id=${e.loja}`, { cookie: e.cookie })).body);
    expect(semRitmo.campaigns[0]!.base_micros).toBe(72 * REAL);
  }, 120_000);
});
