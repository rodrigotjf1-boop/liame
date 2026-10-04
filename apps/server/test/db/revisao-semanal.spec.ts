import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { WeeklyReviewResponse } from '@liame/contracts';
import { createDatabase, type Database, runMigrations, withTenant } from '@liame/database';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ExplicarService } from '../../src/ai/explicar/explicar.service.js';
import { atribuirPedidos } from '../../src/attribution/motor.js';
import { gravarToques } from '../../src/attribution/toque-store.js';
import { APP_CONFIG, type AppConfig } from '../../src/config.js';
import { FlagService } from '../../src/flags/flag.service.js';
import { type MailMessage, Mailer } from '../../src/mail/mailer.js';
import { MediaService } from '../../src/media/media.service.js';
import { gravarMetricas } from '../../src/media/metric-store.js';
import { centavosParaMicros, gravarPedidos, type PedidoLido } from '../../src/orders/order-store.js';
import { AtencaoCicloService } from '../../src/results/atencao-ciclo.service.js';
import { diaNoFuso } from '../../src/results/fora-do-normal.js';
import { proximaRevisao } from '../../src/results/revisao-semanal.js';
import { ResultsService } from '../../src/results/results.service.js';
import { RevisaoSemanalLoop } from '../../src/worker/revisao-semanal-loop.js';
import { RevisaoSemanalService } from '../../src/worker/revisao-semanal.service.js';
import { enableMfa, ownerQuery, resetIpRateLimits, signupAndLogin, startApi, type TestApi, uniqueEmail } from '../helpers/api.js';
import { APP_URL, hasDb, OWNER_URL } from './env.js';

// A3 · I7: a revisão da semana. Na segunda-feira de manhã, no fuso da loja, o worker fecha a semana que
// acabou no domingo, guarda a revisão como foi gerada e, com o envio ligado, manda por e-mail. Relógio
// injetado; loja em Brasília; a IA fica desligada (a leitura da LIA é provada em `ia-explicar.spec.ts`).

const FUSO = 'America/Sao_Paulo';
/** A semana da revisão e a segunda-feira em que ela sai. */
const SEMANA = { from: '2026-09-21', to: '2026-09-27' };
/** Um instante da segunda-feira, 28/09/2026, na hora de Brasília (UTC−3). */
const segunda = (hora: number, minuto = 0) => new Date(Date.UTC(2026, 8, 28, hora + 3, minuto));
const ID_NA_META = { noite: '2201', combo: '2202' } as const;

/** Um carteiro que falha para um endereço enquanto mandarem falhar. */
class CarteiroDeTeste extends Mailer {
  readonly enviados: MailMessage[] = [];
  falharPara = new Set<string>();
  async send(message: MailMessage): Promise<void> {
    if (this.falharPara.has(message.to)) throw Object.assign(new Error(`recusado: ${message.to}`), { name: 'MessageRejected' });
    this.enviados.push(message);
  }
}

describe.skipIf(!hasDb)('revisão da semana: gerada na segunda-feira, guardada como saiu e enviada por e-mail (A3, I7)', () => {
  let api: TestApi;
  let database: Database;
  let flags: FlagService;
  let carteiro: CarteiroDeTeste;
  let revisao: RevisaoSemanalService;
  let loop: RevisaoSemanalLoop;

  type Empresa = { cookie: string; tenantId: string; brandId: string; unitId: string; meta: string; loja: string; noite: string; combo: string; dono: string };

  /** Empresa com uma conta da Meta (duas campanhas) e, salvo pedido em contrário, uma loja do Regem. */
  async function empresa(opcoes: { regem?: boolean } = {}): Promise<Empresa> {
    // Cada teste cadastra mais de uma empresa do mesmo endereço: o limite de cadastros por IP não é o assunto aqui.
    await resetIpRateLimits();
    const email = uniqueEmail('dono-revisao');
    const s = await signupAndLogin(api, email, 'Mister Burgers Revisão');
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
   * Duas semanas de movimento. Anterior (14 a 20/09): "Delivery noite" gastou R$ 140 e trouxe 3 pedidos de
   * R$ 50 (margem R$ 30: prejuízo); "Combo sexta" gastou R$ 200 e trouxe 8 de R$ 100 (margem R$ 480: lucro).
   * A da revisão (21 a 27/09): "Delivery noite" gastou R$ 150 e trouxe 2 de R$ 60 (prejuízo de novo);
   * "Combo sexta" gastou R$ 200 e trouxe 10 de R$ 100.
   */
  async function duasSemanas(e: Empresa): Promise<void> {
    await gastar(e, 'noite', '2026-09-15', 70);
    await gastar(e, 'noite', '2026-09-17', 70);
    await vender(e, 'noite', '2026-09-17', 3, 50, 40);
    await gastar(e, 'combo', '2026-09-16', 100);
    await gastar(e, 'combo', '2026-09-18', 100);
    await vender(e, 'combo', '2026-09-18', 8, 100, 40);
    await gastar(e, 'noite', '2026-09-22', 75);
    await gastar(e, 'noite', '2026-09-24', 75);
    await vender(e, 'noite', '2026-09-24', 2, 60, 45);
    await gastar(e, 'combo', '2026-09-23', 100);
    await gastar(e, 'combo', '2026-09-25', 100);
    await vender(e, 'combo', '2026-09-25', 10, 100, 40);
  }

  /** Mais uma pessoa na empresa, com o nível dado. */
  async function pessoa(e: Empresa, nivel: string, opcoes: { verificado?: boolean } = {}): Promise<string> {
    const [id, email] = [randomUUID(), uniqueEmail(nivel.replaceAll('_', '-'))];
    await ownerQuery(`insert into liame.app_user (id, email, name, password_hash, email_verified_at) values ($1, $2, 'Pessoa', 'x', $3)`, [id, email, opcoes.verificado === false ? null : new Date().toISOString()]);
    await ownerQuery(`insert into liame.membership (id, tenant_id, user_id, role_key) values ($1, $2, $3, $4)`, [randomUUID(), e.tenantId, id, nivel]);
    return email;
  }
  async function ligarEmail(e: Empresa, ligado = true): Promise<void> {
    await ownerQuery(
      `insert into liame.feature_flag_rule (id, flag_key, scope_type, scope_id, value, created_by) values (gen_random_uuid(), 'revisao_email', 'tenant', $1, $2::jsonb, 'testes')
       on conflict (flag_key, scope_type, scope_id) do update set value = excluded.value`,
      [e.tenantId, String(ligado)],
    );
    flags.invalidate();
  }

  type Linha = {
    id: string;
    week_from: string;
    week_to: string;
    timezone: string;
    generated_at: string;
    reading_source: string;
    reading_reason: string | null;
    usage_id: string | null;
    content_version: number;
    email_status: string;
    email_next_at: string | null;
    email_sent_at: string | null;
    email_recipients: number;
    content: Record<string, any>;
  };
  const revisoes = (e: Empresa) =>
    ownerQuery<Linha>(
      `select id, week_from::text as week_from, week_to::text as week_to, timezone, generated_at, reading_source, reading_reason, usage_id, content_version,
              email_status, email_next_at, email_sent_at, email_recipients, content
         from liame.weekly_review where tenant_id = $1 order by week_from`,
      [e.tenantId],
    ).then((linhas) => linhas.map((l) => ({ ...l, generated_at: new Date(l.generated_at).toISOString(), email_next_at: l.email_next_at ? new Date(l.email_next_at).toISOString() : null, email_sent_at: l.email_sent_at ? new Date(l.email_sent_at).toISOString() : null })));
  const estado = async (e: Empresa) => {
    const r = (await ownerQuery<{ last_status: string | null; last_week_from: string | null; next_at: string }>(`select last_status, last_week_from::text as last_week_from, next_at from liame.weekly_review_state where brand_id = $1`, [e.brandId]))[0];
    return r ? { ...r, next_at: new Date(r.next_at).toISOString() } : null;
  };
  const entregas = (e: Empresa) =>
    ownerQuery<{ email: string; role_key: string; status: string; attempts: number; error: string | null }>(
      `select u.email, d.role_key, d.status, d.attempts, d.error from liame.weekly_review_delivery d join liame.app_user u on u.id = d.user_id where d.tenant_id = $1 order by d.role_key, u.email`,
      [e.tenantId],
    );
  const vez = (e: Empresa, agora: Date) => loop.executarLote(10, { tenantIds: [e.tenantId] }, agora);
  const envio = (e: Empresa, agora: Date) => loop.enviarLote(10, { tenantIds: [e.tenantId] }, agora);
  const naTela = (e: Empresa, extra = '') => api.call('GET', `/v1/results/weekly-review?brand_id=${e.brandId}${extra}`, { cookie: e.cookie });

  beforeAll(async () => {
    await runMigrations({ connectionString: OWNER_URL, dir: resolve(process.cwd(), '../../packages/database/migrations') });
    api = await startApi();
    await resetIpRateLimits();
    database = createDatabase({ connectionString: APP_URL, max: 3, applicationName: 'liame-test' });
    flags = api.app.get(FlagService);
    carteiro = new CarteiroDeTeste();
    const config = api.app.get<AppConfig>(APP_CONFIG);
    revisao = new RevisaoSemanalService(database, config, api.app.get(ResultsService), api.app.get(MediaService), api.app.get(AtencaoCicloService), api.app.get(ExplicarService), flags, carteiro);
    loop = new RevisaoSemanalLoop(database, revisao);
  });
  beforeEach(() => {
    carteiro.enviados.length = 0;
    carteiro.falharPara.clear();
  });
  afterAll(async () => {
    await database?.close();
    await api?.close();
  });

  it('na segunda-feira, antes das 5h a marca espera; depois, a revisão da semana que fechou no domingo sai e fica guardada', async () => {
    const e = await empresa();
    await duasSemanas(e);

    // 03:00 em Brasília: ainda não é hora. A marca volta às 05:00.
    await lidas(e, segunda(3));
    expect(await vez(e, segunda(3))).toEqual([{ brandId: e.brandId, tenantId: e.tenantId, status: 'cedo' }]);
    expect(await revisoes(e)).toEqual([]);
    expect(await estado(e)).toEqual({ last_status: 'cedo', last_week_from: null, next_at: segunda(5).toISOString() });
    expect(await vez(e, segunda(4, 30))).toEqual([]);

    // 05:10: as duas fontes lidas hoje. A revisão sai.
    const agora = segunda(5, 10);
    await lidas(e, agora);
    expect(await vez(e, agora)).toEqual([{ brandId: e.brandId, tenantId: e.tenantId, status: 'gerada' }]);
    const [r, ...outras] = await revisoes(e);
    expect(outras).toEqual([]);
    expect(r).toMatchObject({
      week_from: SEMANA.from,
      week_to: SEMANA.to,
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
    expect(c).toMatchObject({ brand_id: e.brandId, week: SEMANA, previous_week: { from: '2026-09-14', to: '2026-09-20' }, timezone: FUSO, currency: 'BRL', verdict: 'lucro' });
    // Os quatro números do topo: 350 investidos (eram 340), 12 pedidos (eram 11), R$ 1.120 (eram R$ 950) e ROAS 3,20 (era 2,79).
    expect(c.totals).toEqual([
      { kind: 'investimento', campaign: null, unit: 'dinheiro', before: '340000000', now: '350000000', change_pct: '+2.9' },
      { kind: 'pedidos_de_anuncios', campaign: null, unit: 'contagem', before: '11', now: '12', change_pct: '+9.1' },
      { kind: 'receita_confirmada', campaign: null, unit: 'dinheiro', before: '950000000', now: '1120000000', change_pct: '+17.9' },
      { kind: 'roas_confirmado', campaign: null, unit: 'razao', before: '2.79', now: '3.20', change_pct: '+14.7' },
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
    // A campanha em prejuízo nas duas semanas é a primeira decisão; o resto são os avisos ativos na geração.
    expect(c.decisions[0]).toMatchObject({ kind: 'prejuizo_seguido', campaign_id: e.noite, title: 'Delivery noite deu prejuízo nas duas últimas semanas', detail: 'Faltaram R$ 120,00 para a margem dos pedidos pagar o anúncio: R$ 120,00 de receita para R$ 150,00 investidos na semana.' });
    expect(c.decisions.every((d: any) => ['critica', 'atencao'].includes(d.severity))).toBe(true);
    // A leitura da semana, pelo sistema: os mesmos números, com a fonte de cada um.
    expect(c.reading).toMatchObject({ source: 'sistema', reason: 'desligada', usage_id: null, period: { from: '21/09/2026', to: '27/09/2026' }, compared_to: { from: '14/09/2026', to: '20/09/2026' }, stale_sources: [] });
    const frase = (trechos: Array<{ text: string }>) => trechos.map((t) => t.text).join('');
    expect(frase(c.reading.explanation.what_happened)).toBe(
      'De 21/09/2026 a 27/09/2026 o investimento em anúncios foi de R$ 350,00 e o caixa confirmou 12 pedido(s) com origem provada em campanha, com receita de R$ 1.120,00. O ROAS confirmado no caixa foi 3,20 (quanto voltou em vendas para cada real investido). Em relação à semana anterior, o investimento subiu 2,9% e a receita com origem provada subiu 17,9%.',
    );
    expect(frase(c.reading.explanation.risk_reason)).toBe('pela regra do sistema, a semana deu lucro depois de pagar os anúncios.');
    expect(c.reading.numbers.length).toBeGreaterThan(5);

    // A marca só volta na segunda-feira seguinte, às 05:00; chamar de novo não gera outra.
    expect(await estado(e)).toEqual({ last_status: 'gerada', last_week_from: SEMANA.from, next_at: new Date(Date.UTC(2026, 9, 5, 8)).toISOString() });
    expect(await vez(e, segunda(6))).toEqual([]);
    expect(await revisao.gerar({ tenantId: e.tenantId, brandId: e.brandId }, segunda(6))).toEqual({ status: 'ja_tem', fuso: FUSO, semana: SEMANA.from });
    expect(await revisoes(e)).toHaveLength(1);
  });

  it('a tela lê a revisão guardada pelo contrato; outra semana, outra empresa e quem não vê as vendas não a recebem', async () => {
    const e = await empresa();
    await duasSemanas(e);
    // Antes de existir: a tela sabe quando sai a primeira.
    const hoje = diaNoFuso(new Date(), FUSO);
    const vazia = await naTela(e);
    expect(vazia.status).toBe(200);
    expect(vazia.body).toEqual({ review: null, next_review_on: proximaRevisao(hoje, null), timezone: FUSO });

    await lidas(e, segunda(5, 10));
    await vez(e, segunda(5, 10));
    const [guardada] = await revisoes(e);
    const r = await naTela(e);
    expect(r.status).toBe(200);
    // O conteúdo guardado passa pelo contrato inteiro (objetos estritos): nada a mais, nada faltando.
    const lida = WeeklyReviewResponse.parse(r.body);
    expect(lida.review).toMatchObject({ id: guardada!.id, brand_id: e.brandId, week: SEMANA, generated_at: segunda(5, 10).toISOString(), email: { status: 'desligado', sent_at: null, recipients: 0 } });
    expect(lida.review!.totals.map((m) => m.kind)).toEqual(['investimento', 'pedidos_de_anuncios', 'receita_confirmada', 'roas_confirmado']);
    expect(lida.next_review_on).toBe(proximaRevisao(hoje, SEMANA.from));
    // Pedida pela segunda-feira dela; semana sem revisão vem vazia; dia que não é segunda é recusado.
    expect((await naTela(e, `&week=${SEMANA.from}`)).body.review.id).toBe(guardada!.id);
    expect((await naTela(e, '&week=2026-09-14')).body.review).toBeNull();
    expect(await naTela(e, '&week=2026-09-22')).toMatchObject({ status: 422, body: { code: 'semana-invalida' } });

    // Outra empresa não acha a marca (a RLS corta); sem `vendas.ver`, 403.
    const outra = await empresa();
    expect((await api.call('GET', `/v1/results/weekly-review?brand_id=${e.brandId}`, { cookie: outra.cookie })).status).toBe(404);
    await ownerQuery(`insert into liame.role_permission (tenant_id, role_key, permission) select $1, 'dono', p from unnest(array['empresa.ver', 'marcas.ver']) as p`, [e.tenantId]);
    expect((await naTela(e)).status).toBe(403);
  });

  it('sem a leitura de hoje da conta de anúncio, a revisão espera até as 9h; depois sai com o que há, e diz qual fonte estava atrasada', async () => {
    const e = await empresa();
    await duasSemanas(e);
    // A Meta foi lida no domingo às 05:10 (há 24 horas): pelo prazo ainda está "em dia", mas o domingo dela não chegou inteiro.
    await lidas(e, segunda(5, 10), 24 * 60);
    expect(await vez(e, segunda(5, 10))).toEqual([{ brandId: e.brandId, tenantId: e.tenantId, status: 'aguardando_leitura' }]);
    expect(await revisoes(e)).toEqual([]);
    expect(await estado(e)).toMatchObject({ last_status: 'aguardando_leitura', next_at: segunda(5, 30).toISOString() });

    // 09:10 e nada de leitura nova: a revisão sai, com a leitura do sistema e o motivo.
    await lidas(e, segunda(9, 10), 28 * 60);
    expect(await vez(e, segunda(9, 10))).toEqual([{ brandId: e.brandId, tenantId: e.tenantId, status: 'gerada' }]);
    const [r] = await revisoes(e);
    expect(r).toMatchObject({ reading_source: 'sistema', reading_reason: 'dado_velho', week_from: SEMANA.from });
    expect(r!.content.reading.stale_sources).toEqual([{ platform: 'Meta', name: 'CA - Mister', freshness: 'atrasado', last_read: '27/09/2026 05:10' }]);
  });

  it('se a segunda-feira passou sem o worker, a revisão sai na primeira vez depois; sem vendas conectadas ou sem movimento, não há revisão', async () => {
    const e = await empresa();
    await duasSemanas(e);
    // Quarta-feira, 30/09, 10:00 em Brasília.
    const quarta = new Date(Date.UTC(2026, 8, 30, 13));
    await lidas(e, quarta);
    expect(await vez(e, quarta)).toEqual([{ brandId: e.brandId, tenantId: e.tenantId, status: 'gerada' }]);
    expect((await revisoes(e)).map((r) => [r.week_from, r.generated_at])).toEqual([[SEMANA.from, quarta.toISOString()]]);
    expect(await estado(e)).toMatchObject({ last_status: 'gerada', next_at: new Date(Date.UTC(2026, 9, 5, 8)).toISOString() });

    // Marca sem o Regem não entra na fila; com o Regem e sem nenhum movimento nas duas semanas, não há o que revisar.
    const semRegem = await empresa({ regem: false });
    expect(await vez(semRegem, segunda(5, 10))).toEqual([]);
    expect(await estado(semRegem)).toBeNull();
    const parada = await empresa();
    await lidas(parada, segunda(5, 10));
    expect(await vez(parada, segunda(5, 10))).toEqual([{ brandId: parada.brandId, tenantId: parada.tenantId, status: 'sem_movimento' }]);
    expect(await revisoes(parada)).toEqual([]);
    expect(await estado(parada)).toMatchObject({ last_status: 'sem_movimento', next_at: segunda(11, 10).toISOString() });
  });

  it('com o envio ligado, o e-mail sai a partir das 7h para o dono, os administradores e quem só recebe relatórios, uma vez só para cada pessoa', async () => {
    const e = await empresa();
    await duasSemanas(e);
    await ligarEmail(e);
    const admin = await pessoa(e, 'administrador');
    const relatorios = await pessoa(e, 'so_relatorios');
    // Não recebem: o gestor (nível que não é de relatório) e quem não confirmou o e-mail.
    await pessoa(e, 'gestor');
    await pessoa(e, 'so_relatorios', { verificado: false });

    await lidas(e, segunda(5, 10));
    await vez(e, segunda(5, 10));
    expect((await revisoes(e))[0]).toMatchObject({ email_status: 'pendente', email_next_at: segunda(7).toISOString(), email_recipients: 0 });
    // Antes das 7h, nada sai.
    expect(await envio(e, segunda(6, 30))).toEqual([]);
    expect(carteiro.enviados).toEqual([]);

    const [vezDoEnvio] = await envio(e, segunda(7, 5));
    expect(vezDoEnvio).toMatchObject({ status: 'enviado', enviados: 3 });
    expect(carteiro.enviados.map((m) => m.to).sort()).toEqual([admin, e.dono, relatorios].sort());
    const doRelatorio = carteiro.enviados.find((m) => m.to === relatorios)!;
    expect(doRelatorio.subject).toBe('Liame: revisão da semana da Mister Burgers Revisão (21/09 a 27/09)');
    const linhas = doRelatorio.text.split('\n');
    for (const linha of [
      'Pedidos de anúncios: 12 (+9,1%; eram 11)',
      'Receita confirmada no caixa: R$ 1.120,00 (+17,9%; era R$ 950,00)',
      'LEITURA DA SEMANA, PELO SISTEMA (SEM IA)',
      '- Combo sexta (Meta): R$ 200,00 investidos, 10 pedido(s), R$ 1.000,00 de receita, ROAS 5,00 · dá lucro',
      '- Delivery noite: ROAS no caixa de 1,07 para 0,80',
      '- Delivery noite deu prejuízo nas duas últimas semanas. Faltaram R$ 120,00 para a margem dos pedidos pagar o anúncio: R$ 120,00 de receita para R$ 150,00 investidos na semana.',
      `Ver a revisão completa: ${api.app.get<AppConfig>(APP_CONFIG).appUrl}/resultados/revisao?marca=${e.brandId}&semana=${SEMANA.from}`,
      'Você recebe este e-mail porque tem acesso à Mister Burgers Revisão no Liame como Só relatórios por e-mail. Para deixar de receber, escreva para suporte@agencialiame.com.',
    ]) {
      expect(linhas, linha).toContain(linha);
    }
    expect(carteiro.enviados.find((m) => m.to === e.dono)!.text).toContain('no Liame como Dono.');
    // A versão em HTML vai junto: os mesmos números, a marca servida pelo webapp, o botão para a revisão e o porquê de cada pessoa.
    const appUrl = api.app.get<AppConfig>(APP_CONFIG).appUrl;
    expect(doRelatorio.html).toContain(`<img src="${appUrl}/email/liame-logo.png"`);
    expect(doRelatorio.html).toContain('R$ 1.120,00');
    expect(doRelatorio.html).toContain('Pelo sistema · sem IA');
    expect(doRelatorio.html).toContain(`<a href="${appUrl}/resultados/revisao?marca=${e.brandId}&amp;semana=${SEMANA.from}"`);
    expect(doRelatorio.html).toContain('no Liame como Só relatórios por e-mail.');
    expect(carteiro.enviados.find((m) => m.to === e.dono)!.html).toContain('no Liame como Dono.');
    expect((await entregas(e)).map((d) => [d.role_key, d.status, d.attempts, d.error])).toEqual([
      ['administrador', 'enviado', 1, null],
      ['dono', 'enviado', 1, null],
      ['so_relatorios', 'enviado', 1, null],
    ]);
    expect((await revisoes(e))[0]).toMatchObject({ email_status: 'enviado', email_next_at: null, email_sent_at: segunda(7, 5).toISOString(), email_recipients: 3 });
    // A tela mostra para quantas pessoas foi.
    expect((await naTela(e)).body.review.email).toEqual({ status: 'enviado', sent_at: segunda(7, 5).toISOString(), recipients: 3 });
    // Depois de enviado, nada volta para a fila.
    expect(await envio(e, segunda(8))).toEqual([]);
    expect(carteiro.enviados).toHaveLength(3);
  });

  it('entrega que falha é tentada de novo, só para quem faltou; depois de três tentativas, desiste dessa pessoa', async () => {
    const e = await empresa();
    await duasSemanas(e);
    await ligarEmail(e);
    const admin = await pessoa(e, 'administrador');
    await lidas(e, segunda(5, 10));
    await vez(e, segunda(5, 10));

    carteiro.falharPara.add(admin);
    expect((await envio(e, segunda(7, 5)))[0]).toMatchObject({ status: 'pendente', enviados: 1 });
    expect((await entregas(e)).map((d) => [d.role_key, d.status, d.attempts, d.error])).toEqual([
      // Na entrega fica só o tipo do erro, nunca o endereço.
      ['administrador', 'falhou', 1, 'MessageRejected'],
      ['dono', 'enviado', 1, null],
    ]);
    expect((await revisoes(e))[0]).toMatchObject({ email_status: 'pendente', email_next_at: segunda(7, 35).toISOString(), email_recipients: 1 });
    // Antes da hora da nova tentativa nada acontece; na hora, só quem faltou recebe.
    expect(await envio(e, segunda(7, 20))).toEqual([]);
    expect((await envio(e, segunda(7, 40)))[0]).toMatchObject({ status: 'pendente', enviados: 1 });
    carteiro.falharPara.clear();
    expect((await envio(e, segunda(8, 15)))[0]).toMatchObject({ status: 'enviado', enviados: 2 });
    expect(carteiro.enviados.map((m) => m.to)).toEqual([e.dono, admin]);
    expect((await entregas(e)).map((d) => [d.role_key, d.status, d.attempts])).toEqual([['administrador', 'enviado', 3], ['dono', 'enviado', 1]]);

    // Outra empresa: o único destinatário falha três vezes. O envio fecha como falhou, sem tentar para sempre.
    const f = await empresa();
    await duasSemanas(f);
    await ligarEmail(f);
    await lidas(f, segunda(5, 10));
    await vez(f, segunda(5, 10));
    carteiro.falharPara.add(f.dono);
    expect((await envio(f, segunda(7, 5)))[0]).toMatchObject({ status: 'pendente', enviados: 0 });
    expect((await envio(f, segunda(7, 40)))[0]).toMatchObject({ status: 'pendente', enviados: 0 });
    expect((await envio(f, segunda(8, 15)))[0]).toMatchObject({ status: 'falhou', enviados: 0 });
    expect((await revisoes(f))[0]).toMatchObject({ email_status: 'falhou', email_next_at: null, email_sent_at: null, email_recipients: 0 });
    expect(await envio(f, segunda(9))).toEqual([]);
  });

  it('o envio para quando a empresa desliga, quando a semana seguinte acaba e quando não há para quem enviar', async () => {
    // Desligado entre a geração e a hora do envio.
    const e = await empresa();
    await duasSemanas(e);
    await ligarEmail(e);
    await lidas(e, segunda(5, 10));
    await vez(e, segunda(5, 10));
    await ligarEmail(e, false);
    expect((await envio(e, segunda(7, 5)))[0]).toMatchObject({ status: 'desligado', enviados: 0 });
    expect((await revisoes(e))[0]).toMatchObject({ email_status: 'desligado', email_next_at: null, email_recipients: 0 });
    expect(carteiro.enviados).toEqual([]);

    // A semana seguinte acabou (segunda-feira, 05/10) sem dar para enviar: a revisão já não é notícia.
    const v = await empresa();
    await duasSemanas(v);
    await ligarEmail(v);
    await lidas(v, segunda(5, 10));
    await vez(v, segunda(5, 10));
    expect((await envio(v, new Date(Date.UTC(2026, 9, 5, 12))))[0]).toMatchObject({ status: 'expirado', enviados: 0 });
    expect(carteiro.enviados).toEqual([]);

    // Ninguém com nível para receber e e-mail confirmado.
    const s = await empresa();
    await duasSemanas(s);
    await ligarEmail(s);
    await ownerQuery(`update liame.app_user set email_verified_at = null where email = $1`, [s.dono]);
    await lidas(s, segunda(5, 10));
    await vez(s, segunda(5, 10));
    expect((await envio(s, segunda(7, 5)))[0]).toMatchObject({ status: 'sem_destinatario', enviados: 0 });
    expect((await revisoes(s))[0]).toMatchObject({ email_status: 'sem_destinatario', email_next_at: null });
  });
});
