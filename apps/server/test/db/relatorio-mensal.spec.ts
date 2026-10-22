import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { MonthlyReportResponse } from '@liame/contracts';
import { createDatabase, type Database, runMigrations, withTenant } from '@liame/database';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ExplicarService } from '../../src/ai/explicar/explicar.service.js';
import { atribuirPedidos } from '../../src/attribution/motor.js';
import { gravarToques } from '../../src/attribution/toque-store.js';
import { FlagService } from '../../src/flags/flag.service.js';
import { MediaService } from '../../src/media/media.service.js';
import { gravarMetricas } from '../../src/media/metric-store.js';
import { centavosParaMicros, gravarPedidos, type PedidoLido } from '../../src/orders/order-store.js';
import { AtencaoCicloService } from '../../src/results/atencao-ciclo.service.js';
import { diaNoFuso } from '../../src/results/fora-do-normal.js';
import { proximoRelatorio } from '../../src/results/relatorio-mensal.js';
import { ResultsService } from '../../src/results/results.service.js';
import { RelatorioMensalLoop } from '../../src/worker/relatorio-mensal-loop.js';
import { RelatorioMensalService } from '../../src/worker/relatorio-mensal.service.js';
import { enableMfa, ownerQuery, resetIpRateLimits, signupAndLogin, startApi, type TestApi, uniqueEmail } from '../helpers/api.js';
import { APP_URL, hasDb, OWNER_URL } from './env.js';

// A3 · I7, o relatório do mês (P24; D-A3-18 a D-A3-22). No dia 1º de manhã, no fuso da loja, o worker fecha o mês
// que terminou na véspera e guarda o relatório como foi gerado. Relógio injetado; loja em Brasília; a IA fica
// desligada (a leitura da LIA usa a mesma chamada do Explicar, provada em `ia-explicar.spec.ts`). O e-mail do mês é
// outra entrega: aqui, só a situação dele na gravação.

const FUSO = 'America/Sao_Paulo';
const SETEMBRO = { from: '2026-09-01', to: '2026-09-30' };
/** Um instante de 01/10/2026 (quinta-feira), na hora de Brasília (UTC−3). */
const primeiro = (hora: number, minuto = 0) => new Date(Date.UTC(2026, 9, 1, hora + 3, minuto));
/** O dia 1º de novembro às 05:00 em Brasília: a vez seguinte, depois do relatório de setembro. */
const NOVEMBRO_AS_5 = new Date(Date.UTC(2026, 10, 1, 8)).toISOString();
const ID_NA_META = { noite: '3201', combo: '3202' } as const;

describe.skipIf(!hasDb)('relatório do mês: gerado no dia 1º, guardado como saiu e lido pela tela (A3, I7; P24)', () => {
  let api: TestApi;
  let database: Database;
  let flags: FlagService;
  let relatorio: RelatorioMensalService;
  let loop: RelatorioMensalLoop;

  type Empresa = { cookie: string; tenantId: string; brandId: string; unitId: string; meta: string; loja: string; noite: string; combo: string; dono: string };

  /** Empresa com uma conta da Meta (duas campanhas) e, salvo pedido em contrário, uma loja do Regem. */
  async function empresa(opcoes: { regem?: boolean } = {}): Promise<Empresa> {
    // Cada teste cadastra mais de uma empresa do mesmo endereço: o limite de cadastros por IP não é o assunto aqui.
    await resetIpRateLimits();
    const email = uniqueEmail('dono-relatorio');
    const s = await signupAndLogin(api, email, 'Mister Burgers Mês');
    await enableMfa(api, s.cookie);
    const tenantId = s.me.active_organization_id as string;
    const brandId = (await ownerQuery<{ id: string }>(`select id from liame.brand where tenant_id = $1 limit 1`, [tenantId]))[0]!.id;
    const [unitId, meta, loja, noite, combo] = [randomUUID(), randomUUID(), randomUUID(), randomUUID(), randomUUID()];
    await ownerQuery(`insert into liame.unit (id, tenant_id, brand_id, name, timezone) values ($1, $2, $3, 'Loja Centro', $4)`, [unitId, tenantId, brandId, FUSO]);
    await ownerQuery(`insert into liame.connected_account (id, tenant_id, brand_id, provider, external_id, name, currency, timezone) values ($1, $2, $3, 'meta_ads', $4, 'CA - Mister', 'BRL', $5)`, [meta, tenantId, brandId, randomUUID(), FUSO]);
    if (opcoes.regem !== false) {
      await ownerQuery(
        `insert into liame.connected_account (id, tenant_id, brand_id, unit_id, provider, external_id, name, currency, timezone) values ($1, $2, $3, $4, 'regem', $5, 'Loja Centro (Regem)', 'BRL', $6)`,
        [loja, tenantId, brandId, unitId, randomUUID(), FUSO],
      );
    }
    // O id da campanha na plataforma é numérico: é ele que o clique traz e que liga o pedido à campanha (ERR-056).
    for (const [id, ext, nome] of [[noite, ID_NA_META.noite, 'Delivery noite'], [combo, ID_NA_META.combo, 'Combo sexta']] as const) {
      const [grupo, anuncio] = [randomUUID(), randomUUID()];
      await ownerQuery(`insert into liame.campaign (id, tenant_id, connected_account_id, provider, external_id, name, status) values ($1, $2, $3, 'meta_ads', $4, $5, 'ativa')`, [id, tenantId, meta, ext, nome]);
      await ownerQuery(`insert into liame.ad_group (id, tenant_id, connected_account_id, campaign_id, provider, external_id, name, status) values ($1, $2, $3, $4, 'meta_ads', $5, 'Público', 'ativa')`, [grupo, tenantId, meta, id, `g-${ext}`]);
      await ownerQuery(`insert into liame.ad (id, tenant_id, connected_account_id, ad_group_id, provider, external_id, name, status) values ($1, $2, $3, $4, 'meta_ads', $5, 'Vídeo', 'ativa')`, [anuncio, tenantId, meta, grupo, `a-${ext}`]);
    }
    return { cookie: s.cookie, tenantId, brandId, unitId, meta, loja, noite, combo, dono: email };
  }

  /** A leitura das fontes: a Meta lida há `metaHa` minutos e os pedidos do Regem há cinco. */
  async function lidas(e: Empresa, agora: Date, metaHa = 120): Promise<void> {
    const quando = (minutos: number) => new Date(agora.getTime() - minutos * 60_000).toISOString();
    await ownerQuery(
      `insert into liame.sync_state (connected_account_id, dataset, tenant_id, expected_every_minutes, last_success_at)
       values ($1, 'metricas', $3, 1440, $4), ($2, 'pedidos', $3, 15, $5)
       on conflict (connected_account_id, dataset) do update set last_success_at = excluded.last_success_at`,
      [e.meta, e.loja, e.tenantId, quando(metaHa), quando(5)],
    );
  }

  /** Gasto da campanha num dia (a Meta entrega por anúncio). */
  async function gastar(e: Empresa, campanha: keyof typeof ID_NA_META, dia: string, reais: number): Promise<void> {
    const anuncio = (await ownerQuery<{ id: string }>(`select id from liame.ad where connected_account_id = $1 and external_id = $2`, [e.meta, `a-${ID_NA_META[campanha]}`]))[0]!.id;
    await withTenant(database.db, e.tenantId, (tx) =>
      gravarMetricas(tx, { tenantId: e.tenantId, brandId: e.brandId, syncRunId: null, sourceVersion: null, currency: 'BRL', timezone: FUSO, observedAt: new Date(`${dia}T23:59:00Z`), connectedAccountId: e.meta, provider: 'meta_ads' }, [
        { level: 'ad', externalEntityId: `a-${ID_NA_META[campanha]}`, entityId: anuncio, metricDate: dia, metricName: 'spend', value: reais.toFixed(2) },
      ]),
    );
  }

  /** Pedidos confirmados no caixa às 20:00 do dia, cada um com o clique da campanha uma hora antes. */
  async function vender(e: Empresa, campanha: keyof typeof ID_NA_META, dia: string, quantos: number, receita: number, custo: number): Promise<void> {
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
      items: [{ externalId: 'i1', name: 'Combo', quantity: '1', revenueMicros: centavosParaMicros(Math.round(receita * 100)), costMicros: centavosParaMicros(Math.round(custo * 100)) }],
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
   * Dois meses de movimento, com os totais da revisão da semana (`revisao-semanal.spec.ts`), para a conta ser a mesma.
   * Agosto: "Delivery noite" gastou R$ 140 e trouxe 3 pedidos de R$ 50 (margem R$ 30: prejuízo); "Combo sexta" gastou
   * R$ 200 e trouxe 8 de R$ 100. Setembro, semana a semana: de 01 a 06/09, R$ 175 e 4 pedidos de R$ 100; de 07 a 13/09,
   * R$ 100 e 6 pedidos de R$ 100; de 14 a 20/09, nada; de 21 a 27/09, R$ 75 e 2 pedidos de R$ 60 ("Delivery noite", em
   * prejuízo de novo); de 28 a 30/09, nada.
   */
  async function doisMeses(e: Empresa): Promise<void> {
    await gastar(e, 'noite', '2026-08-11', 70);
    await gastar(e, 'noite', '2026-08-13', 70);
    await vender(e, 'noite', '2026-08-13', 3, 50, 40);
    await gastar(e, 'combo', '2026-08-12', 100);
    await gastar(e, 'combo', '2026-08-14', 100);
    await vender(e, 'combo', '2026-08-14', 8, 100, 40);
    await gastar(e, 'noite', '2026-09-02', 75);
    await gastar(e, 'combo', '2026-09-03', 100);
    await vender(e, 'combo', '2026-09-03', 4, 100, 40);
    await gastar(e, 'combo', '2026-09-08', 100);
    await vender(e, 'combo', '2026-09-08', 6, 100, 40);
    await gastar(e, 'noite', '2026-09-22', 75);
    await vender(e, 'noite', '2026-09-24', 2, 60, 45);
  }

  /** A revisão da semana de 07 a 13/09 já existe: a semana dela, no relatório, leva à revisão. */
  async function revisaoDaSemana(e: Empresa, segunda: string): Promise<void> {
    await ownerQuery(
      `insert into liame.weekly_review (id, tenant_id, brand_id, week_from, week_to, timezone, generated_at, reading_source, reading_reason, content, content_version, email_status)
       values ($1, $2, $3, $4::date, $4::date + 6, $5, now(), 'sistema', 'desligada', '{}'::jsonb, 1, 'desligado')`,
      [randomUUID(), e.tenantId, e.brandId, segunda, FUSO],
    );
  }

  async function ligarEmail(e: Empresa, ligado = true): Promise<void> {
    await ownerQuery(
      `insert into liame.feature_flag_rule (id, flag_key, scope_type, scope_id, value, created_by) values (gen_random_uuid(), 'relatorio_email', 'tenant', $1, $2::jsonb, 'testes')
       on conflict (flag_key, scope_type, scope_id) do update set value = excluded.value`,
      [e.tenantId, String(ligado)],
    );
    flags.invalidate();
  }

  type Linha = {
    id: string;
    month_from: string;
    month_to: string;
    timezone: string;
    generated_at: string;
    reading_source: string;
    reading_reason: string | null;
    usage_id: string | null;
    content_version: number;
    email_status: string;
    email_next_at: string | null;
    email_recipients: number;
    content: Record<string, any>;
  };
  const relatorios = (e: Empresa) =>
    ownerQuery<Linha>(
      `select id, month_from::text as month_from, month_to::text as month_to, timezone, generated_at, reading_source, reading_reason, usage_id, content_version,
              email_status, email_next_at, email_recipients, content
         from liame.monthly_report where tenant_id = $1 order by month_from`,
      [e.tenantId],
    ).then((linhas) => linhas.map((l) => ({ ...l, generated_at: new Date(l.generated_at).toISOString(), email_next_at: l.email_next_at ? new Date(l.email_next_at).toISOString() : null })));
  const estado = async (e: Empresa) => {
    const r = (await ownerQuery<{ last_status: string | null; last_month_from: string | null; next_at: string }>(`select last_status, last_month_from::text as last_month_from, next_at from liame.monthly_report_state where brand_id = $1`, [e.brandId]))[0];
    return r ? { ...r, next_at: new Date(r.next_at).toISOString() } : null;
  };
  const vez = (e: Empresa, agora: Date) => loop.executarLote(10, { tenantIds: [e.tenantId] }, agora);
  const naTela = (e: Empresa, extra = '') => api.call('GET', `/v1/results/monthly-report?brand_id=${e.brandId}${extra}`, { cookie: e.cookie });

  beforeAll(async () => {
    await runMigrations({ connectionString: OWNER_URL, dir: resolve(process.cwd(), '../../packages/database/migrations') });
    api = await startApi();
    await resetIpRateLimits();
    database = createDatabase({ connectionString: APP_URL, max: 3, applicationName: 'liame-test' });
    flags = api.app.get(FlagService);
    relatorio = new RelatorioMensalService(database, api.app.get(ResultsService), api.app.get(MediaService), api.app.get(AtencaoCicloService), api.app.get(ExplicarService), flags);
    loop = new RelatorioMensalLoop(database, relatorio);
  }, 120_000);
  afterAll(async () => {
    await database?.close();
    await api?.close();
  });

  it('no dia 1º, antes das 5h a marca espera; depois, o relatório do mês que fechou na véspera sai e fica guardado', async () => {
    const e = await empresa();
    await doisMeses(e);
    await revisaoDaSemana(e, '2026-09-07');

    // 03:00 em Brasília: ainda não é hora. A marca volta às 05:00.
    await lidas(e, primeiro(3));
    expect(await vez(e, primeiro(3))).toEqual([{ brandId: e.brandId, tenantId: e.tenantId, status: 'cedo' }]);
    expect(await relatorios(e)).toEqual([]);
    expect(await estado(e)).toEqual({ last_status: 'cedo', last_month_from: null, next_at: primeiro(5).toISOString() });
    expect(await vez(e, primeiro(4, 30))).toEqual([]);

    // 05:10: as duas fontes lidas depois do fim do mês. O relatório sai.
    const agora = primeiro(5, 10);
    await lidas(e, agora);
    expect(await vez(e, agora)).toEqual([{ brandId: e.brandId, tenantId: e.tenantId, status: 'gerado' }]);
    const [r, ...outros] = await relatorios(e);
    expect(outros).toEqual([]);
    expect(r).toMatchObject({
      month_from: SETEMBRO.from,
      month_to: SETEMBRO.to,
      timezone: FUSO,
      generated_at: agora.toISOString(),
      // A IA está desligada para a empresa: a leitura é a do sistema, com o motivo.
      reading_source: 'sistema',
      reading_reason: 'desligada',
      usage_id: null,
      content_version: 1,
      // O envio por e-mail não está ligado.
      email_status: 'desligado',
      email_next_at: null,
      email_recipients: 0,
    });
    const c = r!.content;
    expect(c).toMatchObject({ brand_id: e.brandId, month: SETEMBRO, previous_month: { from: '2026-08-01', to: '2026-08-31' }, timezone: FUSO, currency: 'BRL', verdict: 'lucro' });
    // Os quatro números do topo: 350 investidos (eram 340), 12 pedidos (eram 11), R$ 1.120 (eram R$ 950) e ROAS 3,20 (era 2,79).
    expect(c.totals).toEqual([
      { kind: 'investimento', campaign: null, unit: 'dinheiro', before: '340000000', now: '350000000', change_pct: '+2.9' },
      { kind: 'pedidos_de_anuncios', campaign: null, unit: 'contagem', before: '11', now: '12', change_pct: '+9.1' },
      { kind: 'receita_confirmada', campaign: null, unit: 'dinheiro', before: '950000000', now: '1120000000', change_pct: '+17.9' },
      { kind: 'roas_confirmado', campaign: null, unit: 'razao', before: '2.79', now: '3.20', change_pct: '+14.7' },
    ]);
    // Semana a semana, cortadas no mês; a de 07 a 13/09 tem revisão.
    expect(c.weeks.map((w: any) => [w.from, w.to, w.days, w.week.from, w.week.to, w.has_review, w.spend_micros, w.orders, w.revenue_micros])).toEqual([
      ['2026-09-01', '2026-09-06', 6, '2026-08-31', '2026-09-06', false, '175000000', 4, '400000000'],
      ['2026-09-07', '2026-09-13', 7, '2026-09-07', '2026-09-13', true, '100000000', 6, '600000000'],
      ['2026-09-14', '2026-09-20', 7, '2026-09-14', '2026-09-20', false, '0', 0, '0'],
      ['2026-09-21', '2026-09-27', 7, '2026-09-21', '2026-09-27', false, '75000000', 2, '120000000'],
      ['2026-09-28', '2026-09-30', 3, '2026-09-28', '2026-10-04', false, '0', 0, '0'],
    ]);
    expect(c.campaigns.map((x: any) => [x.name, x.provider, x.spend_micros, x.orders, x.revenue_micros, x.roas, x.verdict])).toEqual([
      ['Combo sexta', 'meta_ads', '200000000', 10, '1000000000', '5.00', 'lucro'],
      ['Delivery noite', 'meta_ads', '150000000', 2, '120000000', '0.80', 'prejuizo'],
    ]);
    expect(c.platform_only).toEqual([]);
    expect(c.improved.map((m: any) => [m.kind, m.campaign?.name ?? null, m.before, m.now])).toEqual([
      ['pedidos_de_anuncios', null, '11', '12'],
      ['receita_confirmada', null, '950000000', '1120000000'],
      ['roas_da_campanha', 'Combo sexta', '4.00', '5.00'],
    ]);
    expect(c.worsened.map((m: any) => [m.kind, m.campaign?.name ?? null, m.before, m.now])).toEqual([['roas_da_campanha', 'Delivery noite', '1.07', '0.80']]);
    // Para o mês que vem: a campanha que deu prejuízo no mês, com quanto faltou; o resto são os avisos ativos na geração.
    expect(c.decisions[0]).toMatchObject({
      kind: 'prejuizo_no_mes',
      campaign_id: e.noite,
      title: 'Delivery noite deu prejuízo em setembro',
      detail: 'Faltaram R$ 120,00 para a margem dos pedidos pagar o anúncio: R$ 120,00 de receita para R$ 150,00 investidos no mês.',
    });
    expect(c.decisions.every((d: any) => ['critica', 'atencao'].includes(d.severity))).toBe(true);
    // A leitura do mês, pelo sistema: os mesmos números, com a fonte de cada um, e o mês anterior pelo nome.
    expect(c.reading).toMatchObject({ source: 'sistema', reason: 'desligada', usage_id: null, period: { from: '01/09/2026', to: '30/09/2026' }, compared_to: { from: '01/08/2026', to: '31/08/2026' }, stale_sources: [] });
    const frase = (trechos: Array<{ text: string }>) => trechos.map((t) => t.text).join('');
    expect(frase(c.reading.explanation.what_happened)).toBe(
      'De 01/09/2026 a 30/09/2026 o investimento em anúncios foi de R$ 350,00 e o caixa confirmou 12 pedido(s) com origem provada em campanha, com receita de R$ 1.120,00. O ROAS confirmado no caixa foi 3,20 (quanto voltou em vendas para cada real investido). Em relação a agosto, o investimento subiu 2,9% e a receita com origem provada subiu 17,9%.',
    );
    expect(frase(c.reading.explanation.risk_reason)).toBe('pela regra do sistema, o mês deu lucro depois de pagar os anúncios.');

    // A marca só volta no dia 1º de novembro, às 05:00; chamar de novo não gera outro.
    expect(await estado(e)).toEqual({ last_status: 'gerado', last_month_from: SETEMBRO.from, next_at: NOVEMBRO_AS_5 });
    expect(await vez(e, primeiro(6))).toEqual([]);
    expect(await relatorio.gerar({ tenantId: e.tenantId, brandId: e.brandId }, primeiro(6))).toEqual({ status: 'ja_tem', fuso: FUSO, mes: SETEMBRO.from });
    expect(await relatorios(e)).toHaveLength(1);
  });

  it('a tela lê o relatório guardado pelo contrato; outro mês, outra empresa e quem não vê as vendas não o recebem', async () => {
    const e = await empresa();
    await doisMeses(e);
    // Antes de existir: a tela sabe quando sai o primeiro.
    const hoje = diaNoFuso(new Date(), FUSO);
    const vazia = await naTela(e);
    expect(vazia.status).toBe(200);
    expect(vazia.body).toEqual({ report: null, next_report_on: proximoRelatorio(hoje, null), timezone: FUSO });

    await lidas(e, primeiro(5, 10));
    await vez(e, primeiro(5, 10));
    const [guardado] = await relatorios(e);
    const r = await naTela(e);
    expect(r.status).toBe(200);
    // O conteúdo guardado passa pelo contrato inteiro (objetos estritos): nada a mais, nada faltando.
    const lido = MonthlyReportResponse.parse(r.body);
    expect(lido.report).toMatchObject({ id: guardado!.id, brand_id: e.brandId, month: SETEMBRO, generated_at: primeiro(5, 10).toISOString(), email: { status: 'desligado', sent_at: null, recipients: 0 } });
    expect(lido.report!.totals.map((m) => m.kind)).toEqual(['investimento', 'pedidos_de_anuncios', 'receita_confirmada', 'roas_confirmado']);
    expect(lido.report!.weeks).toHaveLength(5);
    expect(lido.next_report_on).toBe(proximoRelatorio(hoje, SETEMBRO.from));
    // Pedido pelo mês; mês sem relatório vem vazio; mês fora do formato é recusado.
    expect((await naTela(e, '&month=2026-09')).body.report.id).toBe(guardado!.id);
    expect((await naTela(e, '&month=2026-08')).body.report).toBeNull();
    expect((await naTela(e, '&month=2026-13')).status).toBe(400);
    expect((await naTela(e, '&month=2026-9')).status).toBe(400);

    // Outra empresa não acha a marca (a RLS corta); sem `vendas.ver`, 403.
    const outra = await empresa();
    expect((await api.call('GET', `/v1/results/monthly-report?brand_id=${e.brandId}`, { cookie: outra.cookie })).status).toBe(404);
    await ownerQuery(`insert into liame.role_permission (tenant_id, role_key, permission) select $1, 'dono', p from unnest(array['empresa.ver', 'marcas.ver']) as p`, [e.tenantId]);
    expect((await naTela(e)).status).toBe(403);
  });

  it('sem a leitura da conta de anúncio depois do fim do mês, o relatório espera até as 9h; depois sai com o que há, e diz qual fonte estava atrasada', async () => {
    const e = await empresa();
    await doisMeses(e);
    // A Meta foi lida em 30/09 às 21:10: pelo prazo ainda está "em dia", mas o último dia do mês não chegou inteiro.
    await lidas(e, primeiro(5, 10), 8 * 60);
    expect(await vez(e, primeiro(5, 10))).toEqual([{ brandId: e.brandId, tenantId: e.tenantId, status: 'aguardando_leitura' }]);
    expect(await relatorios(e)).toEqual([]);
    expect(await estado(e)).toMatchObject({ last_status: 'aguardando_leitura', next_at: primeiro(5, 30).toISOString() });

    // 09:10 e nada de leitura nova: o relatório sai, com a leitura do sistema e o motivo.
    await lidas(e, primeiro(9, 10), 12 * 60);
    expect(await vez(e, primeiro(9, 10))).toEqual([{ brandId: e.brandId, tenantId: e.tenantId, status: 'gerado' }]);
    const [r] = await relatorios(e);
    expect(r).toMatchObject({ reading_source: 'sistema', reading_reason: 'dado_velho', month_from: SETEMBRO.from });
    expect(r!.content.reading.stale_sources).toEqual([{ platform: 'Meta', name: 'CA - Mister', freshness: 'atrasado', last_read: '30/09/2026 21:10' }]);
  });

  it('se o dia 1º passou sem o worker, o relatório sai até o dia 7; no dia 8, o mês que passou fica sem relatório; sem vendas conectadas ou sem movimento, não há relatório', async () => {
    // Sábado, 03/10, 10:00 em Brasília: ainda no prazo.
    const e = await empresa();
    await doisMeses(e);
    const sabado = new Date(Date.UTC(2026, 9, 3, 13));
    await lidas(e, sabado);
    expect(await vez(e, sabado)).toEqual([{ brandId: e.brandId, tenantId: e.tenantId, status: 'gerado' }]);
    expect((await relatorios(e)).map((r) => [r.month_from, r.generated_at])).toEqual([[SETEMBRO.from, sabado.toISOString()]]);
    expect(await estado(e)).toMatchObject({ last_status: 'gerado', next_at: NOVEMBRO_AS_5 });

    // Quinta, 08/10: passou do dia 7. Nada é gerado, e a vez vai para o dia 1º de novembro.
    const tarde = await empresa();
    await doisMeses(tarde);
    const dia8 = new Date(Date.UTC(2026, 9, 8, 13));
    await lidas(tarde, dia8);
    expect(await vez(tarde, dia8)).toEqual([{ brandId: tarde.brandId, tenantId: tarde.tenantId, status: 'fora_do_prazo' }]);
    expect(await relatorios(tarde)).toEqual([]);
    expect(await estado(tarde)).toEqual({ last_status: 'fora_do_prazo', last_month_from: null, next_at: NOVEMBRO_AS_5 });

    // Marca sem o Regem não entra na fila; com o Regem e sem nenhum movimento nos dois meses, não há o que relatar.
    const semRegem = await empresa({ regem: false });
    expect(await vez(semRegem, primeiro(5, 10))).toEqual([]);
    expect(await estado(semRegem)).toBeNull();
    const parada = await empresa();
    await lidas(parada, primeiro(5, 10));
    expect(await vez(parada, primeiro(5, 10))).toEqual([{ brandId: parada.brandId, tenantId: parada.tenantId, status: 'sem_movimento' }]);
    expect(await relatorios(parada)).toEqual([]);
    expect(await estado(parada)).toMatchObject({ last_status: 'sem_movimento', next_at: primeiro(11, 10).toISOString() });
  });

  it('com o envio do mês ligado (`relatorio_email`), o relatório nasce esperando o e-mail das 7h; dois workers ao mesmo tempo gravam um relatório só', async () => {
    const e = await empresa();
    await doisMeses(e);
    await ligarEmail(e);
    await lidas(e, primeiro(5, 10));
    // Duas voltas ao mesmo tempo: a reserva (SKIP LOCKED) dá a marca a uma só.
    const voltas = await Promise.all([vez(e, primeiro(5, 10)), vez(e, primeiro(5, 10)), vez(e, primeiro(5, 10))]);
    expect(voltas.flat().map((v) => v.status)).toEqual(['gerado']);
    expect(await relatorios(e)).toHaveLength(1);
    expect((await relatorios(e))[0]).toMatchObject({ email_status: 'pendente', email_next_at: primeiro(7).toISOString(), email_recipients: 0 });
    expect((await naTela(e)).body.report.email).toEqual({ status: 'pendente', sent_at: null, recipients: 0 });
  });

  it('as restrições das tabelas novas (V119): o que passa e o que não passa, pelo nome da restrição', async () => {
    const e = await empresa();
    const inserir = (over: Record<string, string | null> = {}) =>
      ownerQuery(
        `insert into liame.monthly_report (id, tenant_id, brand_id, month_from, month_to, timezone, generated_at, reading_source, reading_reason, content, content_version, email_status, email_next_at, email_sent_at)
         values (gen_random_uuid(), $1, $2, $3::date, $4::date, $5, now(), $6, $7, '{}'::jsonb, 1, $8, $9::timestamptz, $10::timestamptz)`,
        [e.tenantId, e.brandId, over.from ?? '2026-08-01', over.to ?? '2026-08-31', FUSO, over.source ?? 'sistema', 'reason' in over ? over.reason : 'desligada', over.email ?? 'desligado', over.next ?? null, over.sent ?? null],
      ).then(
        () => null,
        (err: { constraint?: string }) => err.constraint ?? 'outro erro',
      );
    expect(await inserir()).toBeNull();
    // O mês começa no dia 1º e acaba no último dia dele (fevereiro de ano bissexto, no 29).
    expect(await inserir({ from: '2026-07-02', to: '2026-08-01' })).toBe('monthly_report_mes');
    expect(await inserir({ from: '2026-07-01', to: '2026-07-30' })).toBe('monthly_report_mes');
    expect(await inserir({ from: '2028-02-01', to: '2028-02-29' })).toBeNull();
    expect(await inserir({ from: '2027-02-01', to: '2027-02-29' })).toBe('outro erro');
    // A leitura do sistema tem o motivo; a da LIA, não.
    expect(await inserir({ from: '2026-06-01', to: '2026-06-30', reason: null })).toBe('monthly_report_leitura');
    expect(await inserir({ from: '2026-06-01', to: '2026-06-30', source: 'lia' })).toBe('monthly_report_leitura');
    // Esperando o envio, tem a hora; enviado, tem quando.
    expect(await inserir({ from: '2026-06-01', to: '2026-06-30', email: 'pendente' })).toBe('monthly_report_envio');
    expect(await inserir({ from: '2026-06-01', to: '2026-06-30', email: 'enviado' })).toBe('monthly_report_enviado');
    // Um por marca e mês.
    expect(await inserir()).toBe('monthly_report_um_por_mes');

    const id = (await ownerQuery<{ id: string }>(`select id from liame.monthly_report where brand_id = $1 and month_from = '2026-08-01'`, [e.brandId]))[0]!.id;
    const dono = (await ownerQuery<{ id: string }>(`select id from liame.app_user where email = $1`, [e.dono]))[0]!.id;
    const entregar = (status: string, enviadoEm: string | null) =>
      ownerQuery(`insert into liame.monthly_report_delivery (id, tenant_id, report_id, user_id, role_key, status, sent_at) values (gen_random_uuid(), $1, $2, $3, 'dono', $4, $5::timestamptz)`, [
        e.tenantId,
        id,
        dono,
        status,
        enviadoEm,
      ]).then(
        () => null,
        (err: { constraint?: string }) => err.constraint ?? 'outro erro',
      );
    expect(await entregar('enviado', null)).toBe('monthly_report_delivery_enviado');
    expect(await entregar('enviado', new Date().toISOString())).toBeNull();
    expect(await entregar('falhou', null)).toBe('monthly_report_delivery_uma_por_pessoa');
  });
});
