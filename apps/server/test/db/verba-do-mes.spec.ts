import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { BudgetMonthResponse } from '@liame/contracts';
import { type Database, runMigrations } from '@liame/database';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { BudgetService } from '../../src/actions/budget.service.js';
import { aoCentavo, diasEntre, mesDe } from '../../src/actions/verba-do-mes.js';
import { currentStep, totpCode } from '../../src/auth/totp.js';
import { DATABASE } from '../../src/database/database.module.js';
import { FlagService } from '../../src/flags/flag.service.js';
import { KillSwitchService } from '../../src/kill-switch/kill-switch.service.js';
import { diaNoFuso, menosDias } from '../../src/results/fora-do-normal.js';
import { ActionExecutor } from '../../src/worker/action-executor.js';
import { ownerQuery, resetIpRateLimits, startApi, type TestApi } from '../helpers/api.js';
import { type EmpresaComMeta, empresaComMeta, ligarConectorNaMetaDeMentira, ligarEscritaNaMeta, ligarFlagDaEmpresa, MetaDeMentira, objetoLido } from '../helpers/meta-de-mentira.js';
import { hasDb, OWNER_URL } from './env.js';

// A4 · X4, parte 1 (D-A4-19 e D-A4-22): a verba do mês pela API. O teto do mês conta tudo o que as contas de anúncio
// conectadas gastam (Meta e Google); o pedido que faz o gasto subir só passa se a previsão de fechamento, com o que
// já foi pedido ou feito hoje e com ele, couber no teto. Reduzir e pausar passam sempre. Os dois limites (o teto do mês
// e o teto por campanha) são definidos juntos, pelo Dono ou pelo Administrador. A conta em si (calendário, ritmo,
// arredondamento) é provada em `test/verba-do-mes.spec.ts`; aqui, o que sai do banco e o que o pedido respeita.

const REAL = 1_000_000;
const FUSO = 'America/Sao_Paulo';
/** Os dias com gasto semeado: os 9 antes de hoje (a janela do ritmo são os 7 mais recentes). */
const DIAS_SEMEADOS = 9;

describe.skipIf(!hasDb)('a verba do mês: o teto conta o gasto inteiro (A4 · X4)', () => {
  let api: TestApi;
  let database: Database;
  let executor: ActionExecutor;
  const meta = new MetaDeMentira();
  let e: EmpresaComMeta;
  /** A conta do Google Ads da mesma marca (só leitura). */
  let google: string;

  const hoje = diaNoFuso(new Date(), FUSO);
  const mes = mesDe(hoje);
  const dias = mes.diasQueFaltam;
  /** Dos dias semeados, quantos caem neste mês quando a conta foi lida até `ate` dias atrás (1 = ontem). */
  const diasNoMes = (ate = 1) => Math.max(0, Math.min(DIAS_SEMEADOS - (ate - 1), diasEntre(mes.inicio, hoje) - (ate - 1)));
  /** R$ 70,00 por dia na Meta (em dois anúncios) e R$ 20,555555 por dia no Google (fração de centavo, como ele manda). */
  const META_POR_DIA = 70 * REAL;
  const GOOGLE_POR_DIA = 20_555_555;
  const GOOGLE_RITMO = 20_560_000;
  const googleNoMes = (n: number) => Number(aoCentavo(BigInt(GOOGLE_POR_DIA) * BigInt(n)));
  /** A previsão das duas plataformas, com as contas lidas hoje. */
  const previstoNormal = () => META_POR_DIA * diasNoMes() + META_POR_DIA * dias + googleNoMes(diasNoMes()) + GOOGLE_RITMO * dias;

  type Resposta = Awaited<ReturnType<TestApi['call']>>;

  const verba = async (emp: EmpresaComMeta = e) => {
    const r = await api.call('GET', '/v1/budget/month', { cookie: emp.cookie });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    return BudgetMonthResponse.parse(r.body);
  };
  const limites = (month_micros: number, campaign_daily_micros: number, emp: EmpresaComMeta = e): Promise<Resposta> =>
    api.call('PUT', '/v1/budget/limits', { cookie: emp.cookie, body: { month_micros, campaign_daily_micros } });
  const pedir = (tool: string, recurso: string, params: Record<string, unknown> = {}, conta: string = e.conta): Promise<Resposta> =>
    api.call('POST', '/v1/actions', { cookie: e.cookie, body: { tool, provider: 'meta_ads', account_id: conta, resource_id: recurso, params } });
  const verbaDe = (recurso: string, reais: number, conta?: string) => pedir('orcamento_ajustar', recurso, { daily_budget_micros: reais * REAL }, conta);
  async function aprovar(pedido: { id: string; plan_hash: string }): Promise<Resposta> {
    await ownerQuery(`update liame.app_user set totp_last_step = null where id = $1`, [e.userId]);
    await ownerQuery(`delete from liame.rate_limit where key = $1`, [`segundo-fator:${e.userId}`]);
    return api.call('POST', `/v1/actions/${pedido.id}/approve`, { cookie: e.cookie, body: { plan_hash: pedido.plan_hash, code: totpCode(e.secret, currentStep()) } });
  }
  const ciclo = () => executor.runCycle(20, { tenantIds: [e.tenantId] });
  /** Pede, aprova com o código do app e executa; devolve a ação como ficou. */
  async function executar(p: Resposta) {
    expect([p.status, p.body.status], JSON.stringify(p.body)).toEqual([201, 'aguardando_aprovacao']);
    expect((await aprovar(p.body)).body.status).toBe('aprovada');
    await ciclo();
    const feita = (await api.call('GET', `/v1/actions/${p.body.id}`, { cookie: e.cookie })).body;
    expect(feita.status, JSON.stringify(feita)).toBe('executada');
    return feita;
  }
  /** Cada teste parte do zero: nada esperando, e o que foi executado fica com data de anteontem (não pesa hoje). */
  async function zerarPedidos(): Promise<void> {
    await ownerQuery(`update liame.action_request set status = 'cancelada', status_reason = 'limpeza do teste' where tenant_id = $1 and status in ('aguardando_aprovacao', 'aprovada', 'executando')`, [e.tenantId]);
    await ownerQuery(`update liame.action_request set updated_at = now() - interval '2 days' where tenant_id = $1 and status = 'executada'`, [e.tenantId]);
  }

  /** A última leitura boa das métricas da conta: agora, ou ao meio-dia de `diasAtras` dias atrás (no fuso da conta). */
  const lida = (conta: string, diasAtras = 0) =>
    ownerQuery(
      `insert into liame.sync_state (connected_account_id, dataset, tenant_id, expected_every_minutes, last_success_at)
       values ($1, 'metricas', $2, 1440, case when $3::int = 0 then now() else (($4::date - $3::int)::timestamp + interval '12 hours') at time zone $5 end)
       on conflict (connected_account_id, dataset) do update set last_success_at = excluded.last_success_at`,
      [conta, e.tenantId, diasAtras, hoje, FUSO],
    );
  const metrica = (conta: string, provider: string, level: string, entidade: string, dia: string, valor: number, nome = 'spend', janela = '', brandId = e.brandId) =>
    ownerQuery(
      `insert into liame.metric_latest (connected_account_id, level, external_entity_id, metric_date, metric_name, attribution_window, tenant_id, brand_id, provider, metric_value, currency, timezone, observed_at, changed_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'BRL', $11, now(), now())
       on conflict (connected_account_id, level, external_entity_id, metric_date, metric_name, attribution_window) do update set metric_value = excluded.metric_value`,
      [conta, level, entidade, dia, nome, janela, e.tenantId, brandId, provider, valor, FUSO],
    );

  beforeAll(async () => {
    await runMigrations({ connectionString: OWNER_URL, dir: resolve(process.cwd(), '../../packages/database/migrations') });
    await meta.ligar();
    api = await startApi();
    await resetIpRateLimits();
    database = api.app.get(DATABASE);
    executor = new ActionExecutor(database, api.app.get(BudgetService), api.app.get(KillSwitchService), api.app.get(FlagService));
    ligarConectorNaMetaDeMentira(api, meta);

    e = await empresaComMeta(api, meta, 'Mister Burgers Verba do Mês');
    await ligarEscritaNaMeta(api, e.tenantId, true);
    // A conta sem autorização do cadastro de teste sai: desconectada, não entra na conta do mês.
    await ownerQuery(`update liame.connected_account set disconnected_at = now(), status = 'desconectada' where id = $1`, [e.contaSemToken]);
    google = randomUUID();
    await ownerQuery(
      `insert into liame.connected_account (id, tenant_id, brand_id, provider, external_id, name, currency, timezone) values ($1, $2, $3, 'google_ads', $4, 'Mister Burgers Google', 'BRL', $5)`,
      [google, e.tenantId, e.brandId, String(Date.now()).slice(-10), FUSO],
    );
    // O gasto dos 9 dias antes de hoje: a Meta por anúncio (R$ 40,00 + R$ 30,00) e o Google por campanha.
    for (let n = 1; n <= DIAS_SEMEADOS; n++) {
      const dia = menosDias(hoje, n);
      await metrica(e.conta, 'meta_ads', 'ad', '9001', dia, 40);
      await metrica(e.conta, 'meta_ads', 'ad', '9002', dia, 30);
      await metrica(google, 'google_ads', 'campaign', '7001', dia, GOOGLE_POR_DIA / REAL);
    }
    // O que NÃO é gasto do mês: hoje (só tem dado amanhã), a Meta por campanha (somaria duas vezes), outra métrica, o
    // gasto com janela de atribuição e o Google por anúncio.
    await metrica(e.conta, 'meta_ads', 'ad', '9001', hoje, 999);
    await metrica(e.conta, 'meta_ads', 'campaign', '8001', menosDias(hoje, 1), 70);
    await metrica(e.conta, 'meta_ads', 'ad', '9001', menosDias(hoje, 1), 5000, 'impressions');
    await metrica(e.conta, 'meta_ads', 'ad', '9001', menosDias(hoje, 1), 300, 'spend', '7d_click');
    await metrica(google, 'google_ads', 'ad', '7101', menosDias(hoje, 1), 20);
    await lida(e.conta);
    await lida(google);
    // Cadastro, app autenticador, cofre e semente: com a suíte inteira rodando junto, passa do prazo padrão dos ganchos.
  }, 120_000);
  beforeEach(async () => {
    meta.normalizar();
    await resetIpRateLimits();
    await zerarPedidos();
    await lida(e.conta);
    await lida(google);
  });
  afterAll(async () => {
    if (e) await ligarEscritaNaMeta(api, e.tenantId, false);
    await api?.close();
    await meta.desligar();
  });

  it('D-A4-19: a conta do mês soma o gasto lido da Meta e do Google, o ritmo dos 7 dias e a previsão; sem limites, não há o que sobrar', async () => {
    const v = await verba();
    expect(v).toMatchObject({
      period: mes.periodo,
      timezone: FUSO,
      today: hoje,
      month_start: mes.inicio,
      month_end: mes.fim,
      through: mes.ontem,
      days_left: dias,
      currency: 'BRL',
      forecast_days: dias,
      pending_daily_micros: 0,
      pending_micros: 0,
      limits: { month_micros: null, campaign_daily_micros: null, set_by: null, set_at: null },
      remaining_micros: null,
      // As regras da distribuição que a tela cita: 10% por pedido e 3 mudanças de verba por hora no mesmo objeto.
      rules: { change_percent_max: 10, rate_limit: { max: 3, window_minutes: 60 } },
    });
    const metaNoMes = META_POR_DIA * diasNoMes();
    expect(v.platforms).toEqual([
      // `writes`: a escrita na Meta está ligada para esta empresa; a do Google, não (o Liame só lê o Google nela).
      { provider: 'meta_ads', accounts: 1, spend_micros: metaNoMes, daily_micros: META_POR_DIA, forecast_micros: metaNoMes + META_POR_DIA * dias, read_through: mes.ontem, forecast_days: dias, stale: false, last_success_at: expect.any(String), writes: true },
      {
        provider: 'google_ads',
        accounts: 1,
        // A fração de centavo do Google vai ao centavo: as parcelas fecham o total que a tela mostra.
        spend_micros: googleNoMes(diasNoMes()),
        daily_micros: GOOGLE_RITMO,
        forecast_micros: googleNoMes(diasNoMes()) + GOOGLE_RITMO * dias,
        read_through: mes.ontem,
        forecast_days: dias,
        stale: false,
        last_success_at: expect.any(String),
        writes: false,
      },
    ]);
    expect([v.spend_micros, v.daily_micros, v.forecast_micros]).toEqual([metaNoMes + googleNoMes(diasNoMes()), META_POR_DIA + GOOGLE_RITMO, previstoNormal()]);
    expect(v.forecast_micros).toBe(v.spend_micros + v.daily_micros * dias);
    for (const micros of [v.spend_micros, v.daily_micros, v.forecast_micros]) expect(micros % 10_000).toBe(0);
    // O gasto de cada dia (o desenho "o mês, dia a dia"): do primeiro dia do mês até ontem, sem plataforma faltando; a
    // soma é o gasto do mês, ao centavo. No dia 1 ainda não há dia inteiro para mostrar.
    const lidos = v.days ?? [];
    expect(lidos.map((d) => d.day)).toEqual(Array.from({ length: diasEntre(mes.inicio, hoje) }, (_, i) => menosDias(mes.inicio, -i)));
    expect(lidos.reduce((s, d) => s + d.spend_micros, 0)).toBe(v.spend_micros);
    expect(lidos.every((d) => d.spend_micros % 10_000 === 0 && d.missing.length === 0)).toBe(true);
    // Ontem: os R$ 70,00 da Meta e os R$ 20,55 ou R$ 20,56 do Google, conforme o centavo que o acumulado ganhou.
    const ontem = lidos.at(-1);
    if (ontem) expect([META_POR_DIA + 20_550_000, META_POR_DIA + 20_560_000]).toContain(ontem.spend_micros);
  });

  it('em quais plataformas o Liame muda campanhas: segue a flag de escrita de cada uma, conta a conta', async () => {
    const escreve = async () => Object.fromEntries((await verba()).platforms.map((p) => [p.provider, p.writes]));
    expect(await escreve()).toEqual({ meta_ads: true, google_ads: false });
    try {
      // O Google ligado para a empresa: as duas plataformas passam a ter pedido.
      await ligarFlagDaEmpresa(api, 'google_write', e.tenantId, true);
      expect(await escreve()).toEqual({ meta_ads: true, google_ads: true });
      // A Meta desligada: o Liame só lê a Meta, e a tela não pode prometer pedido nela.
      await ligarEscritaNaMeta(api, e.tenantId, false);
      expect(await escreve()).toEqual({ meta_ads: false, google_ads: true });
    } finally {
      await ligarFlagDaEmpresa(api, 'google_write', e.tenantId, false);
      await ligarEscritaNaMeta(api, e.tenantId, true);
    }
    expect(await escreve()).toEqual({ meta_ads: true, google_ads: false });
  });

  it('D-A4-22: os dois limites juntos, só por quem gerencia o orçamento; o teto por campanha vira regra da política da empresa', async () => {
    // Uma regra que a empresa já tinha na política: tem de sobreviver à troca do teto.
    const outra = { type: 'autonomy', action: 'cupom.criar', mode: 'ESCALATE' };
    expect((await api.call('POST', '/v1/policies', { cookie: e.cookie, body: { brand_id: null, document: { rules: [outra] } } })).status).toBe(201);
    const politicaAtiva = async () => {
      const r = await api.call('GET', '/v1/policies', { cookie: e.cookie });
      return (r.body.items as Array<{ brand_id: string | null; version: number; status: string; document: { rules: unknown[] } }>).find((p) => p.brand_id === null && p.status === 'ativa')!;
    };
    const antes = (await politicaAtiva()).version;

    // O que não entra: o teto por campanha (por dia) acima do teto do mês, valor abaixo de R$ 1,00 e um dos dois faltando.
    const maior = await limites(100 * REAL, 101 * REAL);
    expect([maior.status, maior.body.errors]).toEqual([400, [{ path: 'campaign_daily_micros', message: 'O teto por campanha é por dia e não pode passar do teto do mês.' }]]);
    expect((await limites(999_999, 999_999)).status).toBe(400);
    expect((await api.call('PUT', '/v1/budget/limits', { cookie: e.cookie, body: { month_micros: 5_500 * REAL } })).status).toBe(400);
    expect((await politicaAtiva()).version).toBe(antes);

    // Quem acompanha as campanhas vê a verba do mês, mas não muda os limites (o Gestor, o Aprovador e quem só lê).
    await ownerQuery(`insert into liame.role_permission (tenant_id, role_key, permission) select $1, 'dono', p from unnest(array['empresa.ver', 'marcas.ver', 'campanhas.ver', 'campanhas.operar']) as p`, [e.tenantId]);
    try {
      const negado = await limites(5_500 * REAL, 80 * REAL);
      expect([negado.status, negado.body.code]).toEqual([403, 'sem-permissao']);
      expect((await verba()).limits.month_micros).toBeNull();
    } finally {
      await ownerQuery(`delete from liame.role_permission where tenant_id = $1`, [e.tenantId]);
    }

    // O Dono define: valem na hora, com quem definiu e quando; o que sobra é o teto menos a previsão.
    const feito = await limites(5_500 * REAL, 80 * REAL);
    expect(feito.status, JSON.stringify(feito.body)).toBe(200);
    const v = BudgetMonthResponse.parse(feito.body);
    expect(v.limits).toEqual({ month_micros: 5_500 * REAL, campaign_daily_micros: 80 * REAL, set_by: { id: e.userId, name: 'Pessoa de Teste' }, set_at: expect.any(String) });
    expect(v.remaining_micros).toBe(5_500 * REAL - previstoNormal());
    // O teto por campanha é uma versão nova da política da empresa: a regra do teto no fim, a outra regra como estava.
    const depois = await politicaAtiva();
    expect([depois.version, depois.document.rules]).toEqual([antes + 1, [outra, { type: 'max_value', action: 'orcamento.*', max_micros: 80 * REAL }]]);

    // Salvar os mesmos valores, ou mudar só o teto do mês, não publica outra versão; mudar o teto por campanha, sim.
    expect((await limites(5_500 * REAL, 80 * REAL)).status).toBe(200);
    expect((await limites(6_000 * REAL, 80 * REAL)).body.limits.month_micros).toBe(6_000 * REAL);
    expect((await politicaAtiva()).version).toBe(antes + 1);
    expect((await limites(6_000 * REAL, 90 * REAL)).body.limits.campaign_daily_micros).toBe(90 * REAL);
    const trocada = await politicaAtiva();
    expect([trocada.version, trocada.document.rules]).toEqual([antes + 2, [outra, { type: 'max_value', action: 'orcamento.*', max_micros: 90 * REAL }]]);

    // A mudança fica na auditoria, com o antes e o depois; o livro de reservas mostra o mesmo teto do mês.
    const trilha = await ownerQuery<{ before: Record<string, unknown>; after: Record<string, unknown> }>(
      `select "before", "after" from liame.audit_event where chain_key = $1 and action = 'orcamento.limites' order by chain_seq`,
      [e.tenantId],
    );
    expect(trilha.map((t) => [t.before, t.after])).toEqual([
      [{ month_micros: null, campaign_daily_micros: null }, { month_micros: 5_500 * REAL, campaign_daily_micros: 80 * REAL, policy_version: antes + 1 }],
      [{ month_micros: 5_500 * REAL, campaign_daily_micros: 80 * REAL }, { month_micros: 5_500 * REAL, campaign_daily_micros: 80 * REAL, policy_version: antes + 1 }],
      [{ month_micros: 5_500 * REAL, campaign_daily_micros: 80 * REAL }, { month_micros: 6_000 * REAL, campaign_daily_micros: 80 * REAL, policy_version: antes + 1 }],
      [{ month_micros: 6_000 * REAL, campaign_daily_micros: 80 * REAL }, { month_micros: 6_000 * REAL, campaign_daily_micros: 90 * REAL, policy_version: antes + 2 }],
    ]);
    const livro = await api.call('GET', '/v1/budget', { cookie: e.cookie });
    expect(livro.body.envelopes).toMatchObject([{ brand_id: null, limit_micros: 6_000 * REAL }]);
  });

  it('D-A4-19: o aumento só passa se couber no que sobra do mês, contando o que já foi pedido hoje; reduzir e pausar passam sempre', async () => {
    // Sobram R$ 5,00 por dia até o fim do mês.
    const previsto = previstoNormal();
    expect((await limites(previsto + 5 * dias * REAL, 150 * REAL)).status).toBe(200);
    const [c1, c2, c3] = [await objetoLido(meta, e, 'campanha'), await objetoLido(meta, e, 'campanha'), await objetoLido(meta, e, 'campanha')];

    // De R$ 30,00 para R$ 33,00: R$ 3,00 por dia. Cabe, e passa a pesar no mês antes mesmo de ser aprovado.
    const primeiro = await verbaDe(c1.recurso, 33);
    expect([primeiro.status, primeiro.body.status, primeiro.body.reserved_micros], JSON.stringify(primeiro.body)).toEqual([201, 'aguardando_aprovacao', 3 * REAL]);
    expect(await verba()).toMatchObject({ pending_daily_micros: 3 * REAL, pending_micros: 3 * dias * REAL, remaining_micros: 2 * dias * REAL, forecast_micros: previsto });

    // Outro aumento de R$ 3,00 por dia não cabe mais (sobram R$ 2,00 por dia): a recusa diz os números que decidem.
    const naoCabe = await verbaDe(c2.recurso, 33);
    expect([naoCabe.status, naoCabe.body.code, naoCabe.body.title]).toEqual([422, 'orcamento-insuficiente', 'Não cabe na verba do mês']);
    expect(naoCabe.body.detail).toMatch(
      /^Não cabe na verba de [a-zç]+: o pedido acrescenta R\$\s[\d.]+,00 até o fim do mês, e sobram R\$\s[\d.]+,00\. No ritmo atual, [a-zç]+ fecha em R\$\s[\d.]+,\d\d, mais R\$\s[\d.]+,00 de aumentos pedidos ou feitos hoje, e o teto da empresa é de R\$\s[\d.]+,\d\d\.$/,
    );
    // O que cabe até o último centavo, passa: R$ 2,00 por dia. Depois dele não sobra nada.
    const justo = await verbaDe(c2.recurso, 32);
    expect([justo.status, justo.body.reserved_micros], JSON.stringify(justo.body)).toEqual([201, 2 * REAL]);
    expect((await verba()).remaining_micros).toBe(0);
    // Cancelado, o pedido deixa de pesar.
    expect((await api.call('POST', `/v1/actions/${justo.body.id}/cancel`, { cookie: e.cookie })).status).toBe(200);
    expect(await verba()).toMatchObject({ pending_daily_micros: 3 * REAL, remaining_micros: 2 * dias * REAL });

    // Com o teto abaixo da previsão, o mês passa do teto: aumentar e retomar ficam negados, até o que não acrescenta nada.
    expect((await limites(previsto - 100 * REAL, 150 * REAL)).status).toBe(200);
    expect((await verba()).remaining_micros).toBe(-(100 + 3 * dias) * REAL);
    const acima = await verbaDe(c2.recurso, 31);
    expect([acima.status, acima.body.code]).toEqual([422, 'orcamento-insuficiente']);
    expect(acima.body.detail).toMatch(/^Não cabe na verba de [a-zç]+: o mês já passa do teto em R\$\s[\d.]+,00\. No ritmo atual, /);
    const pausada = await objetoLido(meta, e, 'campanha', { status: 'PAUSED', effective_status: 'PAUSED' });
    const anuncioPausado = await objetoLido(meta, e, 'anuncio', { status: 'PAUSED', effective_status: 'PAUSED' });
    expect((await pedir('campanha_retomar', pausada.recurso)).body.code).toBe('orcamento-insuficiente');
    expect((await pedir('anuncio_retomar', anuncioPausado.recurso)).body.code).toBe('orcamento-insuficiente');
    // Reduzir e pausar são a direção segura: passam com o mês acima do teto (e o Liame não pausa nada sozinho).
    const reduz = await verbaDe(c2.recurso, 27);
    expect([reduz.status, reduz.body.action, reduz.body.reserved_micros]).toEqual([201, 'orcamento.reduzir', 0]);
    expect((await pedir('campanha_pausar', c3.recurso)).status).toBe(201);
    // A volta de uma redução faz o gasto subir: fica fora do teto por campanha, mas não do teto do mês (D-A4-14).
    const reduzida = await executar(reduz);
    const volta = await api.call('POST', `/v1/actions/${reduzida.id}/undo`, { cookie: e.cookie });
    expect([volta.status, volta.body.code]).toEqual([422, 'orcamento-insuficiente']);
    // Nada disso escreveu na Meta, fora a redução aprovada.
    expect(meta.escritasDe(c1.id)).toEqual([]);
    expect(meta.objetos.get(c2.id)!.daily_budget).toBe('2700');
  });

  it('o que foi executado hoje pesa até o fim do mês; desfeito, ou executado antes de hoje, não pesa mais', async () => {
    expect((await limites(previstoNormal() + 1_000 * REAL, 150 * REAL)).status).toBe(200);
    const c = await objetoLido(meta, e, 'campanha');
    const feita = await executar(await verbaDe(c.recurso, 33));
    expect(meta.objetos.get(c.id)!.daily_budget).toBe('3300');
    expect(await verba()).toMatchObject({ pending_daily_micros: 3 * REAL, pending_micros: 3 * dias * REAL });

    // A volta é uma redução: enquanto espera, o aumento de hoje continua pesando; executada, ele sai da conta.
    const volta = await api.call('POST', `/v1/actions/${feita.id}/undo`, { cookie: e.cookie });
    expect([volta.status, volta.body.action]).toEqual([201, 'orcamento.reduzir']);
    expect((await verba()).pending_daily_micros).toBe(3 * REAL);
    await executar(volta);
    expect(meta.objetos.get(c.id)!.daily_budget).toBe('3000');
    expect((await verba()).pending_daily_micros).toBe(0);

    // Retomar pesa a verba inteira do que volta a rodar; executado ontem, já está no ritmo (em parte) e sai da conta de hoje.
    const pausada = await objetoLido(meta, e, 'campanha', { status: 'PAUSED', effective_status: 'PAUSED' });
    const retomada = await executar(await pedir('campanha_retomar', pausada.recurso));
    expect((await verba()).pending_daily_micros).toBe(30 * REAL);
    await ownerQuery(`update liame.action_request set updated_at = now() - interval '1 day' where id = $1`, [retomada.id]);
    expect((await verba()).pending_daily_micros).toBe(0);
  });

  it('conta com a leitura atrasada: o gasto vale até onde foi lida e o resto entra pelo ritmo; nunca lida, entra zerada e avisada', async () => {
    // A Meta lida ontem ao meio-dia: a leitura cobre até anteontem.
    await lida(e.conta, 1);
    const anteontem = menosDias(hoje, 2);
    const previstos = diasEntre([anteontem, menosDias(mes.inicio, 1)].sort()[1]!, mes.fim);
    const metaNoMes = META_POR_DIA * diasNoMes(2);
    const v = await verba();
    expect(v.platforms[0]).toMatchObject({ provider: 'meta_ads', spend_micros: metaNoMes, daily_micros: META_POR_DIA, forecast_micros: metaNoMes + META_POR_DIA * previstos, read_through: anteontem, forecast_days: previstos, stale: true });
    // O Google foi lido hoje: os dias previstos deixam de ser um número só.
    expect([v.platforms[1]!.stale, v.platforms[1]!.forecast_days, v.forecast_days]).toEqual([false, dias, previstos === dias ? dias : null]);
    expect(v.forecast_micros).toBe(v.platforms[0]!.forecast_micros + v.platforms[1]!.forecast_micros);
    // No desenho do mês, o dia que a Meta não cobre entra só com o Google e diz o que falta; a soma segue o gasto lido.
    const ultimoDia = v.days?.at(-1);
    if (hoje > mes.inicio) expect([ultimoDia?.day, ultimoDia?.missing]).toEqual([mes.ontem, ['meta_ads']]);
    expect((v.days ?? []).reduce((s, d) => s + d.spend_micros, 0)).toBe(v.spend_micros);

    // Nunca lida: sem gasto e sem ritmo; a tela mostra que falta a leitura.
    await ownerQuery(`delete from liame.sync_state where connected_account_id = $1 and dataset = 'metricas'`, [e.conta]);
    const semLeitura = (await verba()).platforms[0]!;
    expect(semLeitura).toMatchObject({ provider: 'meta_ads', spend_micros: 0, daily_micros: 0, forecast_micros: 0, read_through: null, stale: true, last_success_at: null });
  });

  it('dois aumentos ao mesmo tempo não passam juntos do teto do mês', async () => {
    // Sobram R$ 4,00 por dia: cada aumento de R$ 3,00 por dia cabe sozinho, e os dois juntos não.
    expect((await limites(previstoNormal() + 4 * dias * REAL, 150 * REAL)).status).toBe(200);
    const [a, b] = [await objetoLido(meta, e, 'campanha'), await objetoLido(meta, e, 'campanha')];
    const [ra, rb] = await Promise.all([verbaDe(a.recurso, 33), verbaDe(b.recurso, 33)]);
    expect([ra.status, rb.status].sort()).toEqual([201, 422]);
    expect([ra, rb].find((r) => r.status === 422)!.body.code).toBe('orcamento-insuficiente');
    expect(await verba()).toMatchObject({ pending_daily_micros: 3 * REAL, remaining_micros: 1 * dias * REAL });
  });

  it('o teto de uma marca conta só as contas e os pedidos dela', async () => {
    // Outra marca da empresa, com a conta de anúncios dela (a mesma autorização) e R$ 10,00 por dia de gasto.
    const marca = (await api.call('POST', '/v1/brands', { cookie: e.cookie, body: { name: 'Mister Pizzas' } })).body.id as string;
    const contaDaMarca = randomUUID();
    await ownerQuery(
      `insert into liame.connected_account (id, tenant_id, brand_id, provider, external_id, name, currency, timezone, credential_secret_id)
       select $1, tenant_id, $2, 'meta_ads', $3, 'CA - Mister Pizzas', 'BRL', timezone, credential_secret_id from liame.connected_account where id = $4`,
      [contaDaMarca, marca, `act_${meta.outraConta}`, e.conta],
    );
    for (let n = 1; n <= DIAS_SEMEADOS; n++) await metrica(contaDaMarca, 'meta_ads', 'ad', '9101', menosDias(hoje, n), 10, 'spend', '', marca);
    await lida(contaDaMarca);
    try {
      // A empresa com folga; a marca com R$ 2,00 por dia de sobra sobre a previsão dela.
      const previstoDaMarca = 10 * REAL * (diasNoMes() + dias);
      expect((await limites(previstoNormal() + previstoDaMarca + 1_000 * REAL, 150 * REAL)).status).toBe(200);
      expect((await api.call('PUT', '/v1/budget/policies', { cookie: e.cookie, body: { brand_id: marca, limit_micros: previstoDaMarca + 2 * dias * REAL } })).status).toBe(204);
      const daMarca = await objetoLido(meta, { tenantId: e.tenantId, conta: contaDaMarca }, 'campanha', { account_id: meta.outraConta });
      const daOutra = await objetoLido(meta, e, 'campanha');

      const naoCabe = await verbaDe(daMarca.recurso, 33, contaDaMarca);
      expect([naoCabe.status, naoCabe.body.code], JSON.stringify(naoCabe.body)).toEqual([422, 'orcamento-insuficiente']);
      expect(naoCabe.body.detail).toMatch(/e sobram R\$\s[\d.]+,00\. No ritmo atual, [a-zç]+ fecha em R\$\s[\d.]+,00, e o teto da marca é de R\$\s[\d.]+,00\.$/);
      // O pedido na conta da outra marca não entra no teto desta, nem é barrado por ele.
      expect((await verbaDe(daOutra.recurso, 33)).status).toBe(201);
      const cabe = await verbaDe(daMarca.recurso, 32, contaDaMarca);
      expect([cabe.status, cabe.body.brand_id, cabe.body.reserved_micros], JSON.stringify(cabe.body)).toEqual([201, marca, 2 * REAL]);
      // A verba do mês da empresa soma as duas marcas: as duas contas da Meta e os dois pedidos.
      const v = await verba();
      expect(v.platforms[0]).toMatchObject({ provider: 'meta_ads', accounts: 2, daily_micros: META_POR_DIA + 10 * REAL });
      expect(v.pending_daily_micros).toBe(5 * REAL);
    } finally {
      await ownerQuery(`update liame.connected_account set disconnected_at = now(), status = 'desconectada' where id = $1`, [contaDaMarca]);
      await ownerQuery(`delete from liame.budget_policy where tenant_id = $1 and brand_id = $2`, [e.tenantId, marca]);
    }
  });
});
