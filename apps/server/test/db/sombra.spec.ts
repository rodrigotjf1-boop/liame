import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { createDatabase, type Database, runMigrations, withTenant } from '@liame/database';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ActionService } from '../../src/actions/action.service.js';
import { atribuirPedidos } from '../../src/attribution/motor.js';
import { gravarToques } from '../../src/attribution/toque-store.js';
import { FlagService } from '../../src/flags/flag.service.js';
import { gravarMetricas } from '../../src/media/metric-store.js';
import { centavosParaMicros, gravarPedidos, type PedidoLido } from '../../src/orders/order-store.js';
import { ResultsService } from '../../src/results/results.service.js';
import { PedidosDoGestor } from '../../src/worker/pedidos-do-gestor.js';
import { SombraLoop } from '../../src/worker/sombra-loop.js';
import { SombraService } from '../../src/worker/sombra.service.js';
import { enableMfa, ownerQuery, resetIpRateLimits, signupAndLogin, startApi, type TestApi } from '../helpers/api.js';
import { APP_URL, hasDb, OWNER_URL } from './env.js';

// A3 · I5: a sombra de verdade. A rotina registra o que o Liame recomendaria (com os números da tela
// Resultados), vê o que a pessoa fez na plataforma e, passada a janela, compara o resultado. Relógio
// injetado; loja em Brasília. Nada é executado em plataforma nenhuma.

const FUSO = 'America/Sao_Paulo';
/** 10:00 em Brasília do dia dado. */
const manha = (dia: string) => new Date(`${dia}T13:00:00Z`);
const DIA = '2026-09-15';
const ID_NA_META = { c1: '1201', c2: '1202' } as const;

describe.skipIf(!hasDb)('sombra de verdade: recomenda, observa a pessoa e calcula o arrependimento (A3, I5)', () => {
  let api: TestApi;
  let database: Database;
  let flags: FlagService;
  let sombra: SombraService;
  let loop: SombraLoop;

  type Empresa = { tenantId: string; brandId: string; unitId: string; meta: string; loja: string; noite: string; combo: string };

  /** Empresa com uma conta da Meta (duas campanhas com verba diária de R$ 30) e uma loja do Regem. */
  async function empresa(opcoes: { flag?: boolean } = {}): Promise<Empresa> {
    const s = await signupAndLogin(api, undefined, 'Mister Burgers Sombra');
    await enableMfa(api, s.cookie);
    const tenantId = s.me.active_organization_id as string;
    const brandId = (await ownerQuery<{ id: string }>(`select id from liame.brand where tenant_id = $1 limit 1`, [tenantId]))[0]!.id;
    const [unitId, meta, loja, noite, combo] = [randomUUID(), randomUUID(), randomUUID(), randomUUID(), randomUUID()];
    await ownerQuery(`insert into liame.unit (id, tenant_id, brand_id, name, timezone) values ($1, $2, $3, 'Loja Centro', $4)`, [unitId, tenantId, brandId, FUSO]);
    await ownerQuery(
      `insert into liame.connected_account (id, tenant_id, brand_id, unit_id, provider, external_id, name, currency, timezone)
       values ($1, $2, $3, null, 'meta_ads', $4, 'CA - Mister', 'BRL', $6), ($5, $2, $3, $7, 'regem', $8, 'Loja Centro (Regem)', 'BRL', $6)`,
      [meta, tenantId, brandId, randomUUID(), loja, FUSO, unitId, randomUUID()],
    );
    // O id da campanha na plataforma é numérico: é ele que o clique traz e que liga o pedido à campanha.
    for (const [id, ext, nome] of [[noite, ID_NA_META.c1, 'Delivery noite'], [combo, ID_NA_META.c2, 'Combo sexta']] as const) {
      const [grupo, anuncio] = [randomUUID(), randomUUID()];
      await ownerQuery(
        `insert into liame.campaign (id, tenant_id, connected_account_id, provider, external_id, name, status, daily_budget_micros) values ($1, $2, $3, 'meta_ads', $4, $5, 'ativa', 30000000)`,
        [id, tenantId, meta, ext, nome],
      );
      await ownerQuery(`insert into liame.ad_group (id, tenant_id, connected_account_id, campaign_id, provider, external_id, name, status) values ($1, $2, $3, $4, 'meta_ads', $5, 'Público', 'ativa')`, [grupo, tenantId, meta, id, `g-${ext}`]);
      await ownerQuery(`insert into liame.ad (id, tenant_id, connected_account_id, ad_group_id, provider, external_id, name, status) values ($1, $2, $3, $4, 'meta_ads', $5, 'Vídeo', 'ativa')`, [anuncio, tenantId, meta, grupo, `a-${ext}`]);
    }
    if (opcoes.flag !== false) {
      await ownerQuery(`insert into liame.feature_flag_rule (id, flag_key, scope_type, scope_id, value, created_by) values (gen_random_uuid(), 'sombra', 'tenant', $1, 'true'::jsonb, 'testes')`, [tenantId]);
      flags.invalidate();
    }
    return { tenantId, brandId, unitId, meta, loja, noite, combo };
  }

  /** A leitura da manhã: a Meta lida há duas horas e os pedidos do Regem há cinco minutos (ou como pedir). */
  async function lidas(e: Empresa, agora: Date, opcoes: { metaHa?: number } = {}): Promise<void> {
    const quando = (minutos: number) => new Date(agora.getTime() - minutos * 60_000).toISOString();
    await ownerQuery(
      `insert into liame.sync_state (connected_account_id, dataset, tenant_id, expected_every_minutes, last_success_at)
       values ($1, 'metricas', $3, 1440, $4), ($2, 'pedidos', $3, 15, $5)
       on conflict (connected_account_id, dataset) do update set last_success_at = excluded.last_success_at`,
      [e.meta, e.loja, e.tenantId, quando(opcoes.metaHa ?? 120), quando(5)],
    );
  }

  /** Gasto da campanha num dia (a Meta entrega por anúncio). */
  async function gastar(e: Empresa, campanha: 'c1' | 'c2', dia: string, reais: number): Promise<void> {
    const anuncio = (await ownerQuery<{ id: string }>(`select id from liame.ad where connected_account_id = $1 and external_id = $2`, [e.meta, `a-${ID_NA_META[campanha]}`]))[0]!.id;
    await withTenant(database.db, e.tenantId, (tx) =>
      gravarMetricas(tx, { tenantId: e.tenantId, brandId: e.brandId, syncRunId: null, sourceVersion: null, currency: 'BRL', timezone: FUSO, observedAt: new Date(`${dia}T23:59:00Z`), connectedAccountId: e.meta, provider: 'meta_ads' }, [
        { level: 'ad', externalEntityId: `a-${ID_NA_META[campanha]}`, entityId: anuncio, metricDate: dia, metricName: 'spend', value: reais.toFixed(2) },
      ]),
    );
  }

  /** Pedidos confirmados no caixa às 20:00 do dia, cada um com o clique da campanha uma hora antes. */
  async function vender(e: Empresa, campanha: 'c1' | 'c2', dia: string, quantos: number, receita: number, custo: number | null): Promise<void> {
    const pedidos: PedidoLido[] = Array.from({ length: quantos }, (_, i) => ({
      externalId: `${campanha}-${dia}-${i}`,
      channel: 'cardapio',
      channelGroup: 'cardapio',
      status: 'confirmado',
      currency: 'BRL',
      timezone: FUSO,
      revenueMicros: centavosParaMicros(Math.round(receita * 100)),
      discountMicros: 0n,
      refundedMicros: 0n,
      couponCode: null,
      customer: null,
      isNewCustomer: null,
      placedAt: null,
      confirmedAt: `${dia}T23:00:00Z`,
      cancelledAt: null,
      version: 1n,
      sourceUpdatedAt: `${dia}T23:00:00Z`,
      items: [{ externalId: 'i1', name: 'Combo', quantity: '1', revenueMicros: centavosParaMicros(Math.round(receita * 100)), costMicros: custo === null ? null : centavosParaMicros(Math.round(custo * 100)) }],
    }));
    await withTenant(database.db, e.tenantId, async (tx) => {
      const r = await gravarPedidos(tx, { tenantId: e.tenantId, brandId: e.brandId, unitId: e.unitId, connectedAccountId: e.loja, provider: 'regem' }, pedidos);
      await gravarToques(
        tx,
        { tenantId: e.tenantId, brandId: e.brandId, connectedAccountId: e.loja },
        pedidos.map((p) => ({ externalId: `t-${p.externalId}`, kind: 'clique' as const, occurredAt: `${dia}T22:00:00Z`, orderExternalId: p.externalId, fbclid: `IwAR-${p.externalId}`, campaignExternalId: ID_NA_META[campanha] })),
      );
      await atribuirPedidos(tx, { tenantId: e.tenantId, orderIds: r.alterados.map((a) => a.id), gatilho: 'pedidos' });
    });
  }

  /**
   * A semana até a véspera da decisão: "Delivery noite" gastou R$ 150 e trouxe R$ 40 de margem (prejuízo
   * forte); "Combo sexta" gastou R$ 200, no limite da verba, e trouxe R$ 360 de margem (lucro folgado).
   */
  async function semanaAntes(e: Empresa): Promise<void> {
    await gastar(e, 'c1', '2026-09-10', 75);
    await gastar(e, 'c1', '2026-09-12', 75);
    await vender(e, 'c1', '2026-09-12', 2, 40, 20);
    await gastar(e, 'c2', '2026-09-11', 100);
    await gastar(e, 'c2', '2026-09-13', 100);
    await vender(e, 'c2', '2026-09-13', 4, 120, 30);
  }

  type Decisao = {
    campaign_id: string;
    tool: string;
    rule_key: string;
    params: Record<string, unknown>;
    confidence: string;
    status: string;
    decided_on: string;
    window_from: string;
    window_to: string;
    evaluate_on: string;
    human_action: string | null;
    human_action_on: string | null;
    agreement: string | null;
    regret: string | null;
    regret_label: string | null;
    state_snapshot: Record<string, unknown>;
    outcome: Record<string, unknown> | null;
    discard_reason: string | null;
  };
  const decisoes = (e: Empresa) =>
    ownerQuery<Decisao>(
      `select campaign_id, tool, rule_key, params, confidence::text as confidence, status, decided_on::text as decided_on, window_from::text as window_from,
              window_to::text as window_to, evaluate_on::text as evaluate_on, human_action, human_action_on::text as human_action_on, agreement,
              action_regret_micros::text as regret, regret_label, state_snapshot, outcome, discard_reason
         from liame.shadow_decision where tenant_id = $1 order by decided_on, tool`,
      [e.tenantId],
    );
  const vez = (e: Empresa, agora: Date) => loop.executarLote(10, { tenantIds: [e.tenantId] }, agora);

  beforeAll(async () => {
    await runMigrations({ connectionString: OWNER_URL, dir: resolve(process.cwd(), '../../packages/database/migrations') });
    api = await startApi();
    await resetIpRateLimits();
    database = createDatabase({ connectionString: APP_URL, max: 3, applicationName: 'liame-test' });
    flags = api.app.get(FlagService);
    sombra = new SombraService(database, api.app.get(ResultsService));
    loop = new SombraLoop(database, flags, sombra, new PedidosDoGestor(database, api.app.get(ActionService), flags));
  });
  afterAll(async () => {
    await database?.close();
    await api?.close();
  });

  it('registra o que recomendaria, com a confiança e o retrato do estado; no mesmo dia não repete', async () => {
    const e = await empresa();
    await semanaAntes(e);
    await lidas(e, manha(DIA));

    expect(await vez(e, manha(DIA))).toEqual([{ brandId: e.brandId, tenantId: e.tenantId, status: 'feito' }]);
    const d = await decisoes(e);
    expect(d.map((x) => [x.campaign_id, x.tool, x.rule_key, x.params, x.confidence, x.status])).toEqual([
      [e.noite, 'campanha_pausar', 'prejuizo_forte', {}, '0.925', 'aberta'],
      [e.combo, 'orcamento_aumentar', 'lucro_no_limite', { percent: 10 }, '1.000', 'aberta'],
    ]);
    expect(d[0]).toMatchObject({ decided_on: DIA, window_from: '2026-09-08', window_to: '2026-09-14', evaluate_on: '2026-09-22', human_action: null, regret_label: null });
    // O retrato guarda os mesmos números da tela Resultados e o frescor de cada fonte.
    expect(d[0]!.state_snapshot).toMatchObject({
      campanha: { nome: 'Delivery noite', situacao: 'ativa', verba_diaria_micros: '30000000' },
      janela: { de: '2026-09-08', ate: '2026-09-14', fuso: FUSO },
      plataforma: { spend_micros: '150000000' },
      caixa: { orders: 2, revenue_micros: '80000000', margin_known_micros: '40000000', margin_coverage_pct: '100.0', verdict: 'prejuizo' },
    });
    const fontes = d[0]!.state_snapshot.fontes as Array<{ provider: string; freshness: string }>;
    expect(fontes.map((f) => [f.provider, f.freshness]).sort()).toEqual([['meta_ads', 'fresh'], ['regem', 'fresh']]);

    // A vez da marca só volta depois; e, chamada de novo no mesmo dia, a rotina não repete nem duplica.
    expect(await vez(e, new Date(manha(DIA).getTime() + 600_000))).toEqual([]);
    expect(await sombra.rodarMarca({ tenantId: e.tenantId, brandId: e.brandId, ultimoDia: DIA }, manha(DIA))).toEqual({ status: 'ja_rodou', dia: DIA });
    expect(await sombra.rodarMarca({ tenantId: e.tenantId, brandId: e.brandId }, manha(DIA))).toMatchObject({ status: 'feito', novas: 0 });
    expect(await decisoes(e)).toHaveLength(2);
  });

  it('vê o que a pessoa fez na plataforma e, passada a janela, calcula o arrependimento e a prontidão', async () => {
    const e = await empresa();
    await semanaAntes(e);
    await lidas(e, manha(DIA));
    await vez(e, manha(DIA));

    // Dois dias depois, a pessoa pausou a "Delivery noite" na Meta; a leitura da manhã trouxe a mudança.
    await ownerQuery(`update liame.campaign set status = 'pausada' where id = $1`, [e.noite]);
    await lidas(e, manha('2026-09-17'));
    expect(await vez(e, manha('2026-09-17'))).toEqual([{ brandId: e.brandId, tenantId: e.tenantId, status: 'feito' }]);
    let d = await decisoes(e);
    expect(d[0]).toMatchObject({ tool: 'campanha_pausar', status: 'aberta', human_action: 'pausou', human_action_on: '2026-09-17', agreement: 'igual' });
    expect(d[1]).toMatchObject({ tool: 'orcamento_aumentar', status: 'aberta', human_action: null, agreement: null });

    // A semana seguinte da "Combo sexta", sem ninguém mexer: gastou R$ 210 e trouxe R$ 270 de margem.
    await gastar(e, 'c2', '2026-09-16', 110);
    await gastar(e, 'c2', '2026-09-19', 100);
    await vender(e, 'c2', '2026-09-19', 3, 120, 30);
    await lidas(e, manha('2026-09-22'));
    expect(await vez(e, manha('2026-09-22'))).toEqual([{ brandId: e.brandId, tenantId: e.tenantId, status: 'feito' }]);
    d = await decisoes(e);
    // A pessoa fez o que o Liame recomendaria: sem diferença.
    expect(d[0]).toMatchObject({ status: 'avaliada', human_action: 'pausou', agreement: 'igual', regret: '0', regret_label: 'igual' });
    // Aumentar 10% numa semana que sobrou R$ 60 teria trazido mais R$ 6 (estimativa linear).
    expect(d[1]).toMatchObject({ status: 'avaliada', human_action: 'nenhuma', agreement: 'nenhuma', regret: '-6000000', regret_label: 'teria_melhorado' });
    expect(d[1]!.outcome).toMatchObject({
      janela: { de: '2026-09-15', ate: '2026-09-21' },
      campanha: { situacao: 'ativa', verba_diaria_micros: '30000000' },
      plataforma: { spend_micros: '210000000' },
      caixa: { orders: 3, margin_known_micros: '270000000', verdict: 'lucro' },
    });
    // Na semana nova, a "Combo sexta" deu lucro sem folga e a outra está parada: nenhuma recomendação nova.
    expect(d).toHaveLength(2);

    const prontidao = await ownerQuery<{ tool: string; sample_size: number; agreement_rate: string; worse_rate: string; regret: string; confidence_avg: string; missing: string[]; computed_on: string }>(
      `select tool, sample_size, agreement_rate::text as agreement_rate, worse_rate::text as worse_rate, regret_sum_micros::text as regret, confidence_avg::text as confidence_avg, missing, computed_on::text as computed_on
         from liame.readiness_snapshot where tenant_id = $1 and connected_account_id = $2 order by tool`,
      [e.tenantId, e.meta],
    );
    expect(prontidao).toEqual([
      { tool: 'campanha_pausar', sample_size: 1, agreement_rate: '1.0000', worse_rate: '0.0000', regret: '0', confidence_avg: '0.925', missing: ['amostra'], computed_on: '2026-09-22' },
      { tool: 'orcamento_aumentar', sample_size: 1, agreement_rate: '0.0000', worse_rate: '0.0000', regret: '-6000000', confidence_avg: '1.000', missing: ['amostra', 'concordancia'], computed_on: '2026-09-22' },
    ]);
  });

  it('dado velho não gera recomendação: sem a leitura de hoje da plataforma, a rotina espera', async () => {
    const e = await empresa();
    await semanaAntes(e);
    // A Meta foi lida ontem às 18:00 de Brasília: dentro do prazo, mas sem o dia de ontem inteiro.
    await lidas(e, manha(DIA), { metaHa: 16 * 60 });
    expect(await vez(e, manha(DIA))).toEqual([{ brandId: e.brandId, tenantId: e.tenantId, status: 'dado_velho' }]);
    expect(await decisoes(e)).toEqual([]);
    // Uma hora depois a marca volta para a fila; com a leitura da manhã feita, a recomendação sai.
    const depois = new Date(manha(DIA).getTime() + 61 * 60_000);
    await lidas(e, depois);
    expect(await vez(e, depois)).toEqual([{ brandId: e.brandId, tenantId: e.tenantId, status: 'feito' }]);
    expect(await decisoes(e)).toHaveLength(2);
  });

  it('decisão que não consegue ser comparada dentro do prazo sai da amostra, com o motivo', async () => {
    const e = await empresa();
    await semanaAntes(e);
    await lidas(e, manha(DIA));
    await vez(e, manha(DIA));
    // As fontes pararam: 15 dias depois do primeiro dia de comparação, a decisão é descartada.
    const tarde = manha('2026-10-07');
    expect(await vez(e, tarde)).toEqual([{ brandId: e.brandId, tenantId: e.tenantId, status: 'dado_velho' }]);
    expect((await decisoes(e)).map((x) => [x.status, x.discard_reason])).toEqual([
      ['descartada', 'sem dado em dia para comparar dentro do prazo'],
      ['descartada', 'sem dado em dia para comparar dentro do prazo'],
    ]);
  });

  it('várias réplicas do worker ao mesmo tempo: cada marca tem a vez dela uma vez só (V35)', async () => {
    const empresas = [await empresa(), await empresa(), await empresa()];
    for (const e of empresas) {
      await semanaAntes(e);
      await lidas(e, manha(DIA));
    }
    const escopo = { tenantIds: empresas.map((e) => e.tenantId) };
    const lotes = await Promise.all(Array.from({ length: 4 }, () => loop.executarLote(2, escopo, manha(DIA))));
    const marcas = lotes.flat().map((v) => v.brandId);
    // Nenhuma marca duas vezes na mesma rodada; as que sobraram (lote de 2) saem na rodada seguinte.
    expect(new Set(marcas).size).toBe(marcas.length);
    const resto = await loop.executarLote(10, escopo, manha(DIA));
    expect([...marcas, ...resto.map((v) => v.brandId)].sort()).toEqual(empresas.map((e) => e.brandId).sort());
    for (const e of empresas) expect(await decisoes(e)).toHaveLength(2);
  });

  it('nasce desligada: sem a flag `sombra` da empresa, nada é registrado', async () => {
    const e = await empresa({ flag: false });
    await semanaAntes(e);
    await lidas(e, manha(DIA));
    expect(await vez(e, manha(DIA))).toEqual([{ brandId: e.brandId, tenantId: e.tenantId, status: 'desligada' }]);
    expect(await decisoes(e)).toEqual([]);
  });

  it('A4 · X3 e A4-7: feita a rodada, a recomendação de uma ação em Aprovação vira a tentativa de pedido do Gestor de tráfego (flag `modo_aprovacao`), e a sombra continua medindo', async () => {
    // Mais uma empresa neste arquivo: o limite de cadastros por IP (o desta API de teste) volta a zero antes.
    await resetIpRateLimits();
    const e = await empresa();
    await semanaAntes(e);
    await lidas(e, manha(DIA));
    // A empresa pôs "pausar campanha" em Aprovação para o funcionário nesta conta; "aumentar a verba" segue em Sombra.
    const [dono] = await ownerQuery<{ user_id: string }>(`select user_id from liame.membership where tenant_id = $1 and role_key = 'dono'`, [e.tenantId]);
    await ownerQuery(`insert into liame.policy (id, tenant_id, brand_id, version, status, document, created_by) values (gen_random_uuid(), $1, $2, 1, 'ativa', $3, $4)`, [
      e.tenantId,
      e.brandId,
      JSON.stringify({ rules: [{ type: 'autonomy', action: 'campanha.pausar', actor: 'agent', account: e.meta, mode: 'APPROVAL' }] }),
      dono!.user_id,
    ]);
    await ownerQuery(`insert into liame.feature_flag_rule (id, flag_key, scope_type, scope_id, value, created_by) values (gen_random_uuid(), 'modo_aprovacao', 'tenant', $1, 'true'::jsonb, 'testes')`, [e.tenantId]);
    flags.invalidate();

    expect(await vez(e, manha(DIA))).toEqual([{ brandId: e.brandId, tenantId: e.tenantId, status: 'feito' }]);
    const tentativas = () =>
      ownerQuery<{ tool: string; tentou: boolean; request_error: string | null }>(
        `select tool, request_attempted_at is not null as tentou, request_error from liame.shadow_decision where tenant_id = $1 order by tool`,
        [e.tenantId],
      );
    // A escrita na Meta não está ligada para esta empresa: o pedido não entra, e o motivo fica na recomendação.
    const depoisDaRodada = [
      { tool: 'campanha_pausar', tentou: true, request_error: 'escrita-desligada' },
      { tool: 'orcamento_aumentar', tentou: false, request_error: null },
    ];
    expect(await tentativas()).toEqual(depoisDaRodada);
    expect(await ownerQuery(`select 1 from liame.action_request where tenant_id = $1`, [e.tenantId])).toEqual([]);
    // No mesmo dia a rodada não repete, e a tentativa também não.
    expect(await vez(e, new Date(manha(DIA).getTime() + 4 * 3_600_000))).toEqual([{ brandId: e.brandId, tenantId: e.tenantId, status: 'ja_rodou' }]);
    expect(await tentativas()).toEqual(depoisDaRodada);

    // A4-7: a sombra continua medindo. Passada a janela, a recomendação que virou tentativa de pedido é avaliada como
    // as outras (ninguém pausou a campanha, e ela não gastou na semana seguinte: sem diferença), e a tentativa fica.
    await lidas(e, manha('2026-09-22'));
    expect(await vez(e, manha('2026-09-22'))).toEqual([{ brandId: e.brandId, tenantId: e.tenantId, status: 'feito' }]);
    const d = await decisoes(e);
    expect(d.map((x) => [x.tool, x.status, x.human_action, x.regret_label])).toEqual([
      ['campanha_pausar', 'avaliada', 'nenhuma', 'igual'],
      ['orcamento_aumentar', 'avaliada', 'nenhuma', 'sem_dado'],
    ]);
    expect(await tentativas()).toEqual(depoisDaRodada);
  });

  it('A3-4: a empresa só lê a sombra dela, e ninguém grava fora do escopo de sistema', async () => {
    const [a, b] = [await empresa(), await empresa()];
    await semanaAntes(a);
    await lidas(a, manha(DIA));
    await vez(a, manha(DIA));
    const conta = (tenantId: string) =>
      withTenant(database.db, tenantId, async (tx) => Number((await tx.execute<{ n: string }>(sql`select count(*)::text as n from liame.shadow_decision`)).rows[0]!.n));
    expect(await conta(a.tenantId)).toBe(2);
    expect(await conta(b.tenantId)).toBe(0);
    // Como a empresa (a rota de uma pessoa), não dá para inventar nem alterar uma recomendação.
    await expect(
      withTenant(database.db, a.tenantId, (tx) => tx.execute(sql`update liame.shadow_decision set confidence = 1 where tenant_id = ${a.tenantId} returning id`)),
    ).rejects.toThrow();
  });
});
