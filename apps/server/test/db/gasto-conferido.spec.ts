import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { BudgetMonthResponse, ClosedLoopAttentionResponse } from '@liame/contracts';
import { type Database, runMigrations } from '@liame/database';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { BudgetService } from '../../src/actions/budget.service.js';
import { currentStep, totpCode } from '../../src/auth/totp.js';
import { DATABASE } from '../../src/database/database.module.js';
import { FlagService } from '../../src/flags/flag.service.js';
import { KillSwitchService } from '../../src/kill-switch/kill-switch.service.js';
import { diaNoFuso, menosDias } from '../../src/results/fora-do-normal.js';
import { ActionExecutor } from '../../src/worker/action-executor.js';
import { ConferenciaDoGasto } from '../../src/worker/conferencia-do-gasto.js';
import { ownerQuery, resetIpRateLimits, startApi, type TestApi } from '../helpers/api.js';
import { type EmpresaComMeta, empresaComMeta, ligarConectorNaMetaDeMentira, ligarEscritaNaMeta, MetaDeMentira } from '../helpers/meta-de-mentira.js';
import { hasDb, OWNER_URL } from './env.js';

// A4 · X4, parte 2 (D-A4-24; critério A4-8): o gasto de cada mudança, conferido todo dia. Pela API e pela rotina do
// worker, contra a Graph API local: o Liame executa a mudança, a leitura do dia "chega" (as linhas que a sincronização
// gravaria) e a rotina grava a conferência: execução → informado → gasto real. A tela Verba do mês recebe a lista do
// que o Liame mudou no mês com a conferência de cada mudança, e a Atenção avisa de quem gastou a mais. A conta pura
// está em `test/conferencia-do-gasto.spec.ts`.

const REAL = 1_000_000;
const FUSO = 'America/Sao_Paulo';
const nbsp = (s: string) => s.replaceAll('R$ ', `R$${String.fromCharCode(160)}`);
const diaMes = (d: string) => `${d.slice(8, 10)}/${d.slice(5, 7)}`;

describe.skipIf(!hasDb)('o gasto conferido: cada mudança do Liame, todo dia, contra a plataforma (A4 · X4)', () => {
  let api: TestApi;
  let database: Database;
  let executor: ActionExecutor;
  let conferencia: ConferenciaDoGasto;
  const meta = new MetaDeMentira();
  let e: EmpresaComMeta;

  const hoje = diaNoFuso(new Date(), FUSO);
  const ha = (n: number) => menosDias(hoje, n);

  type Resposta = Awaited<ReturnType<TestApi['call']>>;
  /** Uma campanha com um conjunto e um anúncio, na Meta e nas tabelas que a leitura diária grava. */
  type Arvore = { campanha: { id: string; recurso: string; linha: string }; conjunto: { id: string; recurso: string; linha: string }; anuncio: { id: string; recurso: string; linha: string } };

  async function arvore(nome: string, opcoes: { verbaNoConjunto?: boolean } = {}): Promise<Arvore> {
    // A verba mora na campanha (orçamento de campanha) ou no conjunto, nunca nos dois.
    const naCampanha = !opcoes.verbaNoConjunto;
    const c = meta.novo('campanha', { name: nome, ...(naCampanha ? {} : { daily_budget: '0' }) });
    const s = meta.novo('conjunto', { name: `${nome} · conjunto`, ...(naCampanha ? { daily_budget: '0' } : {}) });
    const a = meta.novo('anuncio', { name: `${nome} · anúncio` });
    const [lc, ls, la] = [randomUUID(), randomUUID(), randomUUID()];
    await ownerQuery(`insert into liame.campaign (id, tenant_id, connected_account_id, provider, external_id, name, status, daily_budget_micros) values ($1, $2, $3, 'meta_ads', $4, $5, 'ativa', $6)`, [
      lc,
      e.tenantId,
      e.conta,
      c.id,
      c.name,
      naCampanha ? 30 * REAL : 0,
    ]);
    await ownerQuery(
      `insert into liame.ad_group (id, tenant_id, connected_account_id, campaign_id, provider, external_id, name, status, daily_budget_micros) values ($1, $2, $3, $4, 'meta_ads', $5, $6, 'ativa', $7)`,
      [ls, e.tenantId, e.conta, lc, s.id, s.name, naCampanha ? 0 : 30 * REAL],
    );
    await ownerQuery(`insert into liame.ad (id, tenant_id, connected_account_id, ad_group_id, provider, external_id, name, status) values ($1, $2, $3, $4, 'meta_ads', $5, $6, 'ativa')`, [la, e.tenantId, e.conta, ls, a.id, a.name]);
    return {
      campanha: { id: c.id, recurso: `campanha:${c.id}`, linha: lc },
      conjunto: { id: s.id, recurso: `conjunto:${s.id}`, linha: ls },
      anuncio: { id: a.id, recurso: `anuncio:${a.id}`, linha: la },
    };
  }
  /** O gasto do anúncio da árvore em cada um dos `n` dias antes de hoje (reais por dia), com exceções por dia. */
  async function gasto(t: Arvore, n: number, porDia: number, outros: Record<string, number> = {}): Promise<void> {
    const dias = new Map<string, number>();
    for (let d = 1; d <= n; d++) dias.set(ha(d), porDia);
    for (const [dia, v] of Object.entries(outros)) dias.set(dia, v);
    for (const [dia, valor] of dias) {
      await ownerQuery(
        `insert into liame.metric_latest (connected_account_id, level, external_entity_id, metric_date, metric_name, attribution_window, tenant_id, brand_id, provider, entity_id, metric_value, currency, timezone, observed_at, changed_at)
         values ($1, 'ad', $2, $3, 'spend', '', $4, $5, 'meta_ads', $6, $7, 'BRL', $8, now(), now())
         on conflict (connected_account_id, level, external_entity_id, metric_date, metric_name, attribution_window) do update set metric_value = excluded.metric_value`,
        [e.conta, t.anuncio.id, dia, e.tenantId, e.brandId, t.anuncio.linha, valor, FUSO],
      );
    }
  }
  /** A leitura do dia "chega": a conta lida ao meio-dia de `dia` e todos os objetos vistos nessa leitura. */
  async function leituraChegou(dia: string = hoje): Promise<void> {
    const quando = `(($1::date)::timestamp + interval '12 hours') at time zone '${FUSO}'`;
    await ownerQuery(
      `insert into liame.sync_state (connected_account_id, dataset, tenant_id, expected_every_minutes, last_success_at) values ($2, 'metricas', $3, 1440, ${quando})
       on conflict (connected_account_id, dataset) do update set last_success_at = excluded.last_success_at`,
      [dia, e.conta, e.tenantId],
    );
    for (const tabela of ['campaign', 'ad_group', 'ad']) await ownerQuery(`update liame.${tabela} set last_seen_at = ${quando} where connected_account_id = $2`, [dia, e.conta]);
  }
  /** Como a leitura do dia mostra um objeto (o que a sincronização gravaria depois de uma mudança na Meta). */
  const leituraMostra = (tabela: 'campaign' | 'ad_group' | 'ad', linha: string, campos: { status?: string; verba?: number | null }) =>
    ownerQuery(
      `update liame.${tabela} set status = coalesce($2, status)${tabela === 'ad' ? '' : ', daily_budget_micros = case when $3::boolean then $4::bigint else daily_budget_micros end'} where id = $1`,
      tabela === 'ad' ? [linha, campos.status ?? null] : [linha, campos.status ?? null, campos.verba !== undefined, campos.verba ?? null],
    );

  const pedir = (tool: string, recurso: string, params: Record<string, unknown> = {}): Promise<Resposta> =>
    api.call('POST', '/v1/actions', { cookie: e.cookie, body: { tool, provider: 'meta_ads', account_id: e.conta, resource_id: recurso, params } });
  const verbaDe = (recurso: string, reais: number) => pedir('orcamento_ajustar', recurso, { daily_budget_micros: reais * REAL });
  async function aprovar(pedido: { id: string; plan_hash: string }): Promise<Resposta> {
    await ownerQuery(`update liame.app_user set totp_last_step = null where id = $1`, [e.userId]);
    await ownerQuery(`delete from liame.rate_limit where key = $1`, [`segundo-fator:${e.userId}`]);
    return api.call('POST', `/v1/actions/${pedido.id}/approve`, { cookie: e.cookie, body: { plan_hash: pedido.plan_hash, code: totpCode(e.secret, currentStep()) } });
  }
  /** Pede, aprova e executa; depois leva a execução para `dias` dias atrás (0 = hoje). Devolve o id da ação. */
  async function executadaHa(dias: number, p: Resposta): Promise<string> {
    expect([p.status, p.body.status], JSON.stringify(p.body)).toEqual([201, 'aguardando_aprovacao']);
    expect((await aprovar(p.body)).body.status).toBe('aprovada');
    await executor.runCycle(20, { tenantIds: [e.tenantId] });
    const feita = (await api.call('GET', `/v1/actions/${p.body.id}`, { cookie: e.cookie })).body;
    expect(feita.status, JSON.stringify(feita)).toBe('executada');
    if (dias > 0) await ownerQuery(`update liame.action_request set updated_at = now() - make_interval(days => $2::int) where id = $1`, [p.body.id, dias]);
    return p.body.id as string;
  }
  const conferir = (agora?: Date) => conferencia.executarLote(100, { tenantIds: [e.tenantId] }, agora);
  const linhasDe = (acao: string) =>
    ownerQuery<{
      checked_on: string;
      expected_status: string;
      expected_daily_micros: string | null;
      informed_status: string | null;
      informed_daily_micros: string | null;
      window_from: string;
      window_to: string;
      spend_micros: string;
      allowed_micros: string | null;
      days_after: number;
      spend_after_micros: string;
      status: string;
    }>(
      `select checked_on::text, expected_status, expected_daily_micros::text, informed_status, informed_daily_micros::text, window_from::text, window_to::text,
              spend_micros::text, allowed_micros::text, days_after, spend_after_micros::text, status
         from liame.action_spend_check where action_request_id = $1 order by checked_on`,
      [acao],
    );
  const verbaDoMes = async () => {
    const r = await api.call('GET', '/v1/budget/month', { cookie: e.cookie });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    return BudgetMonthResponse.parse(r.body);
  };
  const mudancas = async () => (await verbaDoMes()).changes;
  const avisos = async () => {
    const r = await api.call('GET', `/v1/results/attention?brand_id=${e.brandId}`, { cookie: e.cookie });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    return ClosedLoopAttentionResponse.parse(r.body).items.filter((i) => i.kind === 'gasto_acima_da_verba');
  };
  /**
   * Cada teste parte do zero: nenhuma mudança executada antes dele continua "valendo" (vão para fora do prazo de
   * conferência), e as conferências já gravadas saem (no produto elas só crescem; aqui a limpeza é do teste).
   */
  async function zerar(): Promise<void> {
    await ownerQuery(`delete from liame.action_spend_check where tenant_id = $1`, [e.tenantId]);
    await ownerQuery(`update liame.action_request set status = 'cancelada', status_reason = 'limpeza do teste' where tenant_id = $1 and status in ('aguardando_aprovacao', 'aprovada', 'executando')`, [e.tenantId]);
    await ownerQuery(`update liame.action_request set updated_at = now() - interval '90 days' where tenant_id = $1 and status = 'executada'`, [e.tenantId]);
  }

  beforeAll(async () => {
    await runMigrations({ connectionString: OWNER_URL, dir: resolve(process.cwd(), '../../packages/database/migrations') });
    await meta.ligar();
    api = await startApi();
    await resetIpRateLimits();
    database = api.app.get(DATABASE);
    executor = new ActionExecutor(database, api.app.get(BudgetService), api.app.get(KillSwitchService), api.app.get(FlagService));
    conferencia = new ConferenciaDoGasto(database);
    ligarConectorNaMetaDeMentira(api, meta);

    e = await empresaComMeta(api, meta, 'Mister Burgers Gasto Conferido');
    await ligarEscritaNaMeta(api, e.tenantId, true);
    await ownerQuery(`update liame.connected_account set disconnected_at = now(), status = 'desconectada' where id = $1`, [e.contaSemToken]);
    // Limites folgados: aqui o assunto é a conferência depois da execução, não a conta do mês.
    expect((await api.call('PUT', '/v1/budget/limits', { cookie: e.cookie, body: { month_micros: 1_000_000 * REAL, campaign_daily_micros: 500 * REAL } })).status).toBe(200);
  }, 120_000);
  beforeEach(async () => {
    meta.normalizar();
    await resetIpRateLimits();
    await zerar();
    await leituraChegou();
  });
  afterAll(async () => {
    if (e) await ligarEscritaNaMeta(api, e.tenantId, false);
    await api?.close();
    await meta.desligar();
  });

  it('A4-8: a mudança é conferida depois da leitura do dia: o que o Liame deixou, o que a Meta informa e o que ela gastou na semana', async () => {
    const t = await arvore('Smash em dobro');
    // Há 5 dias o Liame reduziu a verba de R$ 30,00 para R$ 27,00; a leitura de hoje mostra R$ 27,00.
    const acao = await executadaHa(5, await verbaDe(t.campanha.recurso, 27));
    await leituraMostra('campaign', t.campanha.linha, { verba: 27 * REAL });
    // R$ 29,00 por dia até a véspera da mudança e R$ 26,50 por dia do dia da mudança em diante.
    await gasto(t, 10, 26.5, { [ha(6)]: 29, [ha(7)]: 29, [ha(8)]: 29, [ha(9)]: 29, [ha(10)]: 29 });

    expect(await conferir()).toEqual([{ tenantId: e.tenantId, contaId: e.conta, dia: hoje, conferidas: 1, mudou: 0, acima: 0 }]);
    // Os 7 dias até ontem: dois com a verba de antes (R$ 30,00), o dia da mudança com a maior das duas e quatro com R$ 27,00.
    expect(await linhasDe(acao)).toEqual([
      {
        checked_on: hoje,
        expected_status: 'ativo',
        expected_daily_micros: String(27 * REAL),
        informed_status: 'ativo',
        informed_daily_micros: String(27 * REAL),
        window_from: ha(7),
        window_to: ha(1),
        spend_micros: String((2 * 29 + 5 * 26.5) * REAL),
        allowed_micros: String((3 * 30 + 4 * 27) * REAL),
        days_after: 4,
        spend_after_micros: String(4 * 26.5 * REAL),
        status: 'confere',
      },
    ]);
    // Conferir de novo no mesmo dia não duplica.
    expect(await conferir()).toEqual([]);
    expect(await linhasDe(acao)).toHaveLength(1);

    // A tela recebe a mudança com a conferência: o que mudou, quem pediu e o resultado de hoje.
    const [m] = await mudancas();
    expect(m).toMatchObject({
      action_id: acao,
      executed_on: ha(5),
      tool: 'orcamento_ajustar',
      action: 'orcamento.reduzir',
      provider: 'meta_ads',
      account_id: e.conta,
      target: { kind: 'campanha', name: 'Smash em dobro', campaign_name: null },
      from: { status: 'ativo', daily_micros: 30 * REAL },
      to: { status: 'ativo', daily_micros: 27 * REAL },
      requested_by: { id: e.userId, name: 'Pessoa de Teste' },
      agent_key: null,
      undoes: null,
      superseded_by: null,
      check: {
        checked_on: hoje,
        status: 'confere',
        since: hoje,
        informed_status: 'ativo',
        informed_daily_micros: 27 * REAL,
        window: { from: ha(7), to: ha(1) },
        window_spend_micros: (2 * 29 + 5 * 26.5) * REAL,
        window_allowed_micros: (3 * 30 + 4 * 27) * REAL,
        days_after: 4,
        spend_after_micros: 4 * 26.5 * REAL,
      },
    });
    expect(await avisos()).toEqual([]);
  });

  it('D-A4-24: a semana acima de 7 vezes a verba vira aviso na Atenção; o pausado que gastou depois da pausa, também', async () => {
    // (1) Há 12 dias o Liame aumentou a verba de R$ 30,00 para R$ 33,00, e a campanha vem gastando R$ 35,00 por dia.
    const t = await arvore('Combo sexta');
    const aumento = await executadaHa(12, await verbaDe(t.campanha.recurso, 33));
    await leituraMostra('campaign', t.campanha.linha, { verba: 33 * REAL });
    await gasto(t, 13, 35);
    // (2) Há 4 dias o Liame pausou um anúncio de outra campanha, e ele seguiu gastando R$ 9,00 por dia.
    const outra = await arvore('Delivery noite', { verbaNoConjunto: true });
    const pausa = await executadaHa(4, await pedir('anuncio_pausar', outra.anuncio.recurso));
    await leituraMostra('ad', outra.anuncio.linha, { status: 'pausada' });
    await gasto(outra, 8, 9);

    expect(await conferir()).toEqual([{ tenantId: e.tenantId, contaId: e.conta, dia: hoje, conferidas: 2, mudou: 0, acima: 2 }]);
    expect((await linhasDe(aumento))[0]).toMatchObject({ status: 'acima', window_from: ha(7), window_to: ha(1), spend_micros: String(245 * REAL), allowed_micros: String(231 * REAL), days_after: 11 });
    // O anúncio não tem verba própria: comparam-se só os dias inteiros depois da pausa, que valem zero.
    expect((await linhasDe(pausa))[0]).toMatchObject({ status: 'acima', expected_status: 'pausado', expected_daily_micros: null, informed_status: 'pausado', window_from: ha(3), window_to: ha(1), spend_micros: String(27 * REAL), allowed_micros: '0', days_after: 3 });

    // A Atenção avisa das duas, com os números que decidem; o aviso leva à campanha.
    const itens = await avisos();
    expect(itens.map((i) => [i.title, i.detail, i.action, i.severity, i.campaign_id, i.connected_account_id, i.provider])).toEqual(
      expect.arrayContaining([
        [
          'A campanha "Combo sexta" gastou mais do que a verba permite',
          nbsp(`Na semana de ${diaMes(ha(7))} a ${diaMes(ha(1))}, ela gastou R$ 245,00. Com a verba de R$ 33,00 por dia que o Liame deixou, a semana iria até R$ 231,00.`),
          'Veja na Meta se a verba foi mudada por lá ou se há um conjunto com verba própria.',
          'atencao',
          t.campanha.linha,
          e.conta,
          'meta_ads',
        ],
        [
          'O anúncio "Delivery noite · anúncio" gastou depois de pausado pelo Liame',
          nbsp(`De ${diaMes(ha(3))} a ${diaMes(ha(1))}, depois da pausa de ${diaMes(ha(4))}, ele gastou R$ 27,00.`),
          'Veja na Meta se ele voltou a rodar nesses dias.',
          'atencao',
          outra.campanha.linha,
          e.conta,
          'meta_ads',
        ],
      ]),
    );
    expect(itens).toHaveLength(2);
    // A tela Verba do mês recebe os mesmos avisos, já em palavras, e a maior verba diária de hoje (a de R$ 33,00).
    const v = await verbaDoMes();
    expect(v.overspend.map((o) => [o.action_id, o.title, o.detail, o.action]).sort()).toEqual(
      [
        [aumento, ...itens.filter((i) => i.campaign_id === t.campanha.linha).flatMap((i) => [i.title, i.detail, i.action])],
        [pausa, ...itens.filter((i) => i.campaign_id === outra.campanha.linha).flatMap((i) => [i.title, i.detail, i.action])],
      ].sort(),
    );
    expect(v.largest_daily_micros).toBe(33 * REAL);
    // Na tela, as duas mudanças vêm com a situação "acima"; o anúncio diz de que campanha é.
    const lista = v.changes;
    expect(lista.find((m) => m.action_id === aumento)!.check).toMatchObject({ status: 'acima', window_spend_micros: 245 * REAL, window_allowed_micros: 231 * REAL });
    expect(lista.find((m) => m.action_id === pausa)).toMatchObject({ target: { kind: 'anuncio', name: 'Delivery noite · anúncio', campaign_name: 'Delivery noite' }, to: { status: 'pausado', daily_micros: null }, check: { status: 'acima' } });

    // Outro pedido do Liame no mesmo objeto (aqui, a volta do aumento) tira o aviso: aquela mudança deixou de valer.
    const volta = await api.call('POST', `/v1/actions/${aumento}/undo`, { cookie: e.cookie });
    expect(volta.status, JSON.stringify(volta.body)).toBe(201);
    const desfeita = await executadaHa(0, volta);
    expect((await avisos()).map((i) => i.title)).toEqual(['O anúncio "Delivery noite · anúncio" gastou depois de pausado pelo Liame']);
    expect((await verbaDoMes()).overspend.map((o) => o.action_id)).toEqual([pausa]);
    // A volta é de hoje: ainda não tem conferência (o gasto de hoje só é lido amanhã).
    expect((await mudancas()).find((m) => m.action_id === desfeita)).toMatchObject({ undoes: aumento, check: null, superseded_by: null, from: { daily_micros: 33 * REAL }, to: { daily_micros: 30 * REAL } });
  });

  it('alguém mudou na Meta depois: a conferência diz "mudou", sem aviso de gasto; o objeto que saiu da lista, também', async () => {
    // (1) O conjunto pausado pelo Liame há 3 dias foi retomado por alguém na Meta, e gasta bem.
    const t = await arvore('Almoço executivo', { verbaNoConjunto: true });
    const pausa = await executadaHa(3, await pedir('conjunto_pausar', t.conjunto.recurso));
    await leituraMostra('ad_group', t.conjunto.linha, { status: 'ativa' });
    await gasto(t, 8, 40);
    // (2) A verba que o Liame deixou em R$ 27,00 aparece em R$ 45,00 na leitura de hoje.
    const u = await arvore('Happy hour');
    const reducao = await executadaHa(6, await verbaDe(u.campanha.recurso, 27));
    await leituraMostra('campaign', u.campanha.linha, { verba: 45 * REAL });
    await gasto(u, 8, 44);
    // (3) A campanha pausada pelo Liame não veio na leitura de hoje (foi arquivada ou apagada na Meta).
    const v = await arvore('Campanha de inverno');
    const sumiu = await executadaHa(2, await pedir('campanha_pausar', v.campanha.recurso));
    await leituraMostra('campaign', v.campanha.linha, { status: 'pausada' });
    await ownerQuery(`update liame.campaign set last_seen_at = now() - interval '2 days' where id = $1`, [v.campanha.linha]);

    expect(await conferir()).toEqual([{ tenantId: e.tenantId, contaId: e.conta, dia: hoje, conferidas: 3, mudou: 3, acima: 0 }]);
    expect((await linhasDe(pausa))[0]).toMatchObject({ status: 'mudou', expected_status: 'pausado', informed_status: 'ativo' });
    expect((await linhasDe(reducao))[0]).toMatchObject({ status: 'mudou', expected_daily_micros: String(27 * REAL), informed_status: 'ativo', informed_daily_micros: String(45 * REAL) });
    expect((await linhasDe(sumiu))[0]).toMatchObject({ status: 'mudou', expected_status: 'pausado', informed_status: null, informed_daily_micros: null });
    // Quem mexe na Meta manda: não é erro, e não vira aviso de gasto (mesmo gastando acima do que o Liame tinha deixado).
    expect(await avisos()).toEqual([]);
    const lista = await mudancas();
    expect(lista.find((m) => m.action_id === pausa)).toMatchObject({ target: { kind: 'conjunto', campaign_name: 'Almoço executivo' }, check: { status: 'mudou', informed_status: 'ativo' } });
    expect(lista.find((m) => m.action_id === sumiu)!.check).toMatchObject({ status: 'mudou', informed_status: null });
  });

  it('o que não é conferido: a mudança de hoje, a que outro pedido já trocou, a que não escreveu nada e a conta sem a leitura de hoje', async () => {
    // (1) Executada hoje: o gasto de hoje só é lido amanhã.
    const hojeMesmo = await arvore('Executada hoje');
    const deHoje = await executadaHa(0, await verbaDe(hojeMesmo.campanha.recurso, 27));
    // (2) Dois pedidos no mesmo objeto: só o mais recente continua valendo.
    const duas = await arvore('Duas mudanças');
    const primeira = await executadaHa(6, await verbaDe(duas.campanha.recurso, 27));
    const segunda = await executadaHa(2, await verbaDe(duas.campanha.recurso, 25));
    await leituraMostra('campaign', duas.campanha.linha, { verba: 25 * REAL });
    // (3) O Liame foi pausar e o anúncio já estava pausado: não escreveu nada, então não há mudança dele para conferir.
    const jaEstava = await arvore('Já estava pausado');
    const p = await pedir('anuncio_pausar', jaEstava.anuncio.recurso);
    expect((await aprovar(p.body)).body.status).toBe('aprovada');
    meta.objetos.get(jaEstava.anuncio.id)!.status = 'PAUSED';
    await executor.runCycle(20, { tenantIds: [e.tenantId] });
    await ownerQuery(`update liame.action_request set updated_at = now() - interval '3 days' where id = $1`, [p.body.id]);

    // Sem a leitura de hoje (a última foi ontem), nada é conferido: ela é que traz a véspera inteira.
    await leituraChegou(ha(1));
    expect(await conferir()).toEqual([]);
    await leituraChegou();
    expect(await conferir()).toEqual([{ tenantId: e.tenantId, contaId: e.conta, dia: hoje, conferidas: 1, mudou: 0, acima: 0 }]);
    expect([(await linhasDe(deHoje)).length, (await linhasDe(primeira)).length, (await linhasDe(segunda)).length, (await linhasDe(p.body.id)).length]).toEqual([0, 0, 1, 0]);

    // Na tela: a de hoje sem conferência e a que continua valendo, conferida; a que não escreveu nada não aparece. A que
    // outro pedido trocou só aparece se for deste mês (de antes dele, a lista traz só o que continua valendo).
    const lista = await mudancas();
    const primeiraNoMes = ha(6) >= `${hoje.slice(0, 7)}-01`;
    expect(lista.map((m) => m.action_id)).toEqual([deHoje, segunda, ...(primeiraNoMes ? [primeira] : [])]);
    expect(lista[0]).toMatchObject({ check: null, superseded_by: null });
    expect(lista[1]).toMatchObject({ check: { status: 'confere' }, superseded_by: null, from: { daily_micros: 27 * REAL }, to: { daily_micros: 25 * REAL } });

    // Dois pedidos de hoje no mesmo objeto: os dois na lista, e o primeiro diz qual veio depois.
    const hojeDuas = await arvore('Duas de hoje');
    const antes = await executadaHa(0, await verbaDe(hojeDuas.campanha.recurso, 28));
    const depois = await executadaHa(0, await verbaDe(hojeDuas.campanha.recurso, 26));
    const deHojeNaLista = (await mudancas()).filter((m) => m.target.name === 'Duas de hoje');
    expect(deHojeNaLista.map((m) => [m.action_id, m.superseded_by?.action_id ?? null, m.to.daily_micros])).toEqual([
      [depois, null, 26 * REAL],
      [antes, depois, 28 * REAL],
    ]);
  });

  it('a conferência é de todo dia: no dia seguinte entra outra linha, e a tela diz desde quando o resultado é o de agora', async () => {
    const t = await arvore('Petiscos');
    const acao = await executadaHa(9, await verbaDe(t.campanha.recurso, 33));
    await leituraMostra('campaign', t.campanha.linha, { verba: 33 * REAL });
    // Dentro da verba até ontem.
    await gasto(t, 10, 32);
    expect((await conferir())[0]).toMatchObject({ conferidas: 1, acima: 0 });

    // Amanhã, a leitura chega de novo, com o dia de hoje muito acima: a semana passa de 7 vezes a verba.
    const amanha = new Date(Date.now() + 86_400_000);
    const diaDeAmanha = diaNoFuso(amanha, FUSO);
    await gasto(t, 0, 0, { [hoje]: 60 });
    await leituraChegou(diaDeAmanha);
    expect(await conferir(amanha)).toEqual([{ tenantId: e.tenantId, contaId: e.conta, dia: diaDeAmanha, conferidas: 1, mudou: 0, acima: 1 }]);
    expect((await linhasDe(acao)).map((l) => [l.checked_on, l.status, l.window_from, l.window_to, l.spend_micros, l.days_after])).toEqual([
      [hoje, 'confere', ha(7), ha(1), String(7 * 32 * REAL), 8],
      [diaDeAmanha, 'acima', ha(6), hoje, String((6 * 32 + 60) * REAL), 9],
    ]);
    // A tela mostra a conferência mais recente, e desde quando ela diz "acima".
    expect((await mudancas()).find((m) => m.action_id === acao)!.check).toMatchObject({ checked_on: diaDeAmanha, status: 'acima', since: diaDeAmanha, days_after: 9, spend_after_micros: (8 * 32 + 60) * REAL });
    // No terceiro dia, com mais um dia acima e o mesmo resultado, "desde" continua sendo o primeiro dia seguido.
    const depois = new Date(Date.now() + 2 * 86_400_000);
    await gasto(t, 0, 0, { [diaDeAmanha]: 60 });
    await leituraChegou(diaNoFuso(depois, FUSO));
    expect((await conferir(depois))[0]).toMatchObject({ dia: diaNoFuso(depois, FUSO), acima: 1 });
    expect((await mudancas()).find((m) => m.action_id === acao)!.check).toMatchObject({ checked_on: diaNoFuso(depois, FUSO), status: 'acima', since: diaDeAmanha });
  });

  it('isolamento: a conferência de uma empresa não aparece para outra, e a rotina com escopo só mexe na empresa pedida', async () => {
    const t = await arvore('Só desta empresa');
    const acao = await executadaHa(3, await verbaDe(t.campanha.recurso, 27));
    await leituraMostra('campaign', t.campanha.linha, { verba: 27 * REAL });
    const outra = await empresaComMeta(api, meta, 'Outra Empresa Gasto Conferido', { conta: '5550001111', outra: '5550002222' });
    // A rotina pedida só para a outra empresa não confere nada desta.
    expect(await conferencia.executarLote(100, { tenantIds: [outra.tenantId] })).toEqual([]);
    expect(await linhasDe(acao)).toHaveLength(0);
    expect((await conferir())[0]).toMatchObject({ tenantId: e.tenantId, conferidas: 1 });
    // A outra empresa não vê as mudanças nem as conferências desta.
    const dela = await api.call('GET', '/v1/budget/month', { cookie: outra.cookie });
    expect([dela.status, dela.body.changes]).toEqual([200, []]);
  });
});
