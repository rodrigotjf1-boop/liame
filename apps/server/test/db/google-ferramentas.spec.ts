import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import type { Database } from '@liame/database';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ActionExecutor } from '../../src/worker/action-executor.js';
import type { TestApi } from '../helpers/api.js';
import type { CampanhaNoGoogle, EmpresaComGoogle, GoogleDeMentira } from '../helpers/google-de-mentira.js';
import { APP_URL, hasDb, OWNER_URL } from './env.js';

// A5 · Y3: as ferramentas de anúncio numa campanha do Google, do pedido à volta, pela API e contra uma Google Ads API
// local. O conector do Google está no registro de verdade desde a Y3 (09/10/2026), atrás da flag `google_write`, que
// este arquivo liga para a empresa de teste. O app e os ajudantes entram por `import()` dentro do `beforeAll`.

const REAL = 1_000_000;

describe.skipIf(!hasDb)('ferramentas de anúncio no Google: do pedido à volta (A5 · Y3)', () => {
  let api: TestApi;
  let database: Database;
  let executor: ActionExecutor;
  let google: GoogleDeMentira;
  let e: EmpresaComGoogle;
  let ownerQuery: typeof import('../helpers/api.js').ownerQuery;
  let resetIpRateLimits: typeof import('../helpers/api.js').resetIpRateLimits;
  let empresaComGoogle: typeof import('../helpers/google-de-mentira.js').empresaComGoogle;
  let campanhaLida: typeof import('../helpers/google-de-mentira.js').campanhaLida;
  let codigoDoApp: (segredo: string) => string;
  let invalidarFlags: () => void;
  const anterior: Record<string, string | undefined> = {};

  type Resposta = Awaited<ReturnType<TestApi['call']>>;
  const pedir = (emp: EmpresaComGoogle, tool: string, c: { id: string }, params: Record<string, unknown> = {}): Promise<Resposta> =>
    api.call('POST', '/v1/actions', { cookie: emp.cookie, body: { tool, provider: 'google_ads', account_id: emp.conta, resource_id: `campanha:${c.id}`, params } });
  /** Aprova com o código do app de agora (o passo usado e o limite de tentativas são zerados: o teste aprova muito). */
  async function aprovar(emp: EmpresaComGoogle, pedido: { id: string; plan_hash: string }): Promise<Resposta> {
    await ownerQuery(`update liame.app_user set totp_last_step = null where id = $1`, [emp.userId]);
    await ownerQuery(`delete from liame.rate_limit where key = $1`, [`segundo-fator:${emp.userId}`]);
    return api.call('POST', `/v1/actions/${pedido.id}/approve`, { cookie: emp.cookie, body: { plan_hash: pedido.plan_hash, code: codigoDoApp(emp.secret) } });
  }
  const ciclo = (emp: EmpresaComGoogle) => executor.runCycle(20, { tenantIds: [emp.tenantId] });
  const ver = async (emp: EmpresaComGoogle, id: string) => (await api.call('GET', `/v1/actions/${id}`, { cookie: emp.cookie })).body;
  const desfazer = (emp: EmpresaComGoogle, id: string) => api.call('POST', `/v1/actions/${id}/undo`, { cookie: emp.cookie });
  async function ligarEscrita(emp: EmpresaComGoogle, valor: boolean): Promise<void> {
    await ownerQuery(`delete from liame.feature_flag_rule where flag_key = 'google_write' and scope_type = 'tenant' and scope_id = $1`, [emp.tenantId]);
    if (valor) await ownerQuery(`insert into liame.feature_flag_rule (id, flag_key, scope_type, scope_id, value, created_by) values (gen_random_uuid(), 'google_write', 'tenant', $1, 'true'::jsonb, 'testes')`, [emp.tenantId]);
    invalidarFlags();
  }
  /** Uma campanha nova no Google e na lista que o Liame leu da conta. */
  async function campanha(emp: EmpresaComGoogle, extra: Parameters<GoogleDeMentira['novaCampanha']>[1] = {}): Promise<CampanhaNoGoogle> {
    const c = google.novaCampanha(emp.cliente, extra);
    await campanhaLida(emp, c);
    return c;
  }
  /** Pede, aprova com o código do app e executa; devolve a ação como ficou. */
  async function executar(emp: EmpresaComGoogle, tool: string, c: { id: string }, params: Record<string, unknown> = {}) {
    const p = await pedir(emp, tool, c, params);
    expect([p.status, p.body.status], JSON.stringify(p.body)).toEqual([201, 'aguardando_aprovacao']);
    expect((await aprovar(emp, p.body)).body.status).toBe('aprovada');
    await ciclo(emp);
    return ver(emp, p.body.id);
  }

  beforeAll(async () => {
    const { createDatabase, runMigrations } = await import('@liame/database');
    await runMigrations({ connectionString: OWNER_URL, dir: resolve(process.cwd(), '../../packages/database/migrations') });
    const ajudaDoGoogle = await import('../helpers/google-de-mentira.js');
    google = new ajudaDoGoogle.GoogleDeMentira();
    await google.subir();
    const ambiente = google.ambiente();
    for (const k of Object.keys(ambiente)) anterior[k] = process.env[k];
    Object.assign(process.env, ambiente);
    const ajuda = await import('../helpers/api.js');
    ({ ownerQuery, resetIpRateLimits } = ajuda);
    ({ empresaComGoogle, campanhaLida } = ajudaDoGoogle);
    api = await ajuda.startApi();
    database = createDatabase({ connectionString: APP_URL, max: 4, applicationName: 'liame-test' });
    const [{ ActionExecutor: Executor }, { BudgetService }, { KillSwitchService }, { FlagService }, { DATABASE }, totp] = await Promise.all([
      import('../../src/worker/action-executor.js'),
      import('../../src/actions/budget.service.js'),
      import('../../src/kill-switch/kill-switch.service.js'),
      import('../../src/flags/flag.service.js'),
      import('../../src/database/database.module.js'),
      import('../../src/auth/totp.js'),
    ]);
    const flags = api.app.get(FlagService);
    invalidarFlags = () => flags.invalidate();
    codigoDoApp = (segredo) => totp.totpCode(segredo, totp.currentStep());
    executor = new Executor(api.app.get(DATABASE), api.app.get(BudgetService), api.app.get(KillSwitchService), flags);

    e = await empresaComGoogle(api, database, { nome: 'Mister Burgers Ferramentas no Google' });
    await ligarEscrita(e, true);
    // O que a empresa define antes de o Liame aumentar verba: o teto por campanha e o teto do mês, pela rota da tela
    // (a regra dela não tem provedor: vale para a Meta e para o Google).
    const limites = await api.call('PUT', '/v1/budget/limits', { cookie: e.cookie, body: { month_micros: 1_000_000 * REAL, campaign_daily_micros: 150 * REAL } });
    expect(limites.status, JSON.stringify(limites.body)).toBe(200);
  }, 120_000);
  beforeEach(async () => {
    google.chamadas.length = 0;
    google.defeitos.clear();
    await resetIpRateLimits();
  });
  afterAll(async () => {
    await api?.close();
    await database?.close();
    await google?.fechar();
    for (const [k, v] of Object.entries(anterior)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('a pessoa pede reduzir a verba de uma campanha do Google; a política manda esperar a aprovação com o código do app; só então o Liame valida e escreve', async () => {
    const c = await campanha(e, { name: 'Busca hambúrguer perto' });
    const orcamento = google.orcamentos.get(c.orcamento!)!;
    google.chamadas.length = 0;
    const p = await pedir(e, 'orcamento_ajustar', c, { daily_budget_micros: 27 * REAL });
    expect(p.status, JSON.stringify(p.body)).toBe(201);
    expect(p.body).toMatchObject({
      tool: 'orcamento_ajustar',
      action: 'orcamento.reduzir',
      provider: 'google_ads',
      brand_id: e.brandId,
      resource_id: `campanha:${c.id}`,
      budget_impact: 'decrease',
      value_micros: 27 * REAL,
      current_value_micros: 30 * REAL,
      reserved_micros: 0,
      mode: 'APPROVAL',
      status: 'aguardando_aprovacao',
      // A regra é da distribuição (versão 4): no Google, como na Meta, o que uma pessoa pede espera aprovação.
      policy: { allowed: true, mode: 'APPROVAL', violations: [] },
      target: { kind: 'campanha', name: 'Busca hambúrguer perto' },
      from: { status: 'ativo', daily_micros: 30 * REAL },
      to: { status: 'ativo', daily_micros: 27 * REAL },
    });
    expect(p.body.policy.versions[0]).toBe('plataforma@5');
    // O pedido leu a campanha no Google, e mais nada. Sem a aprovação, o executor nem olha para ele.
    expect(google.resumo(e.cliente)).toEqual(['leitura']);
    await ciclo(e);
    expect(google.resumo(e.cliente)).toEqual(['leitura']);
    expect(orcamento.amountMicros).toBe(30 * REAL);

    expect((await aprovar(e, p.body)).body).toMatchObject({ status: 'aprovada' });
    await ciclo(e);
    expect(await ver(e, p.body.id)).toMatchObject({ status: 'executada', status_reason: null, workflow: { status: 'concluido' }, execution: { status: 'executada', no_write: false } });
    // Na execução: lê e valida; lê, escreve e confere (A5-5: nenhuma escrita sem a validação antes).
    expect(google.resumo(e.cliente)).toEqual(['leitura', 'leitura', 'validacao:campaignBudgets', 'leitura', 'escrita:campaignBudgets', 'leitura']);
    expect(orcamento.amountMicros).toBe(27 * REAL);
  });

  it('as mesmas regras da Meta: mais de 10% é negado; aumentar passa pelo teto por campanha; grupo de anúncios e anúncio não têm ferramenta no Google', async () => {
    const c = await campanha(e);
    const acima = await pedir(e, 'orcamento_ajustar', c, { daily_budget_micros: 24 * REAL });
    expect([acima.status, acima.body.code], JSON.stringify(acima.body)).toEqual([422, 'politica-negou']);
    expect(JSON.stringify(acima.body)).toContain('passa do máximo de 10%');

    // Aumentar dentro dos 10%: reserva a diferença de um dia e espera a aprovação.
    const ok = await pedir(e, 'orcamento_ajustar', c, { daily_budget_micros: 33 * REAL });
    expect([ok.status, ok.body.status, ok.body.action, ok.body.reserved_micros], JSON.stringify(ok.body)).toEqual([201, 'aguardando_aprovacao', 'orcamento.aumentar', 3 * REAL]);

    // Acima do teto por campanha que a empresa definiu (R$ 150,00): negado, mesmo dentro dos 10%.
    const cara = await campanha(e, { orcamento: google.novoOrcamento(e.cliente, { amountMicros: 145 * REAL }).id });
    const passaDoTeto = await pedir(e, 'orcamento_ajustar', cara, { daily_budget_micros: 155 * REAL });
    expect([passaDoTeto.status, passaDoTeto.body.code], JSON.stringify(passaDoTeto.body)).toEqual([422, 'politica-negou']);
    expect(JSON.stringify(passaDoTeto.body)).toContain('teto por campanha');

    // No Google o Liame só mexe na campanha.
    for (const ferramenta of ['conjunto_pausar', 'anuncio_pausar', 'conjunto_retomar', 'anuncio_retomar']) {
      const r = await pedir(e, ferramenta, c);
      expect([r.status, r.body.code], ferramenta).toEqual([400, 'provedor-nao-suportado']);
    }
  });

  it('verba dividida entre campanhas: o pedido de verba nem nasce, com o motivo; pausar a campanha passa (A5-6)', async () => {
    const dividido = google.novoOrcamento(e.cliente, { amountMicros: 80 * REAL });
    const a = await campanha(e, { orcamento: dividido.id, name: 'Busca marca' });
    await campanha(e, { orcamento: dividido.id, name: 'Busca concorrente' });
    const antes = Number((await ownerQuery<{ n: string }>(`select count(*)::text as n from liame.action_request where tenant_id = $1`, [e.tenantId]))[0]!.n);
    google.chamadas.length = 0;

    const verba = await pedir(e, 'orcamento_ajustar', a, { daily_budget_micros: 88 * REAL });
    expect([verba.status, verba.body.code, verba.body.detail], JSON.stringify(verba.body)).toEqual([
      422,
      'plano-recusado',
      'A verba desta campanha vem de um orçamento compartilhado com outra campanha no Google: mudar aqui mudaria a verba dela também. O Liame não muda orçamento compartilhado.',
    ]);
    expect(Number((await ownerQuery<{ n: string }>(`select count(*)::text as n from liame.action_request where tenant_id = $1`, [e.tenantId]))[0]!.n)).toBe(antes);
    // Só a leitura chegou ao Google.
    expect(google.resumo(e.cliente)).toEqual(['leitura']);

    const pausada = await executar(e, 'campanha_pausar', a);
    expect(pausada).toMatchObject({ status: 'executada', action: 'campanha.pausar' });
    expect(google.campanhas.get(a.id)!.status).toBe('PAUSED');
    expect(dividido.amountMicros).toBe(80 * REAL);
    expect(google.chamadas.filter((x) => x.recurso === 'campaignBudgets')).toHaveLength(0);
  });

  it('pausar e desfazer pelo mesmo trilho: a volta é um pedido novo, que também espera a aprovação', async () => {
    const c = await campanha(e);
    const pausada = await executar(e, 'campanha_pausar', c);
    expect(pausada).toMatchObject({ status: 'executada' });
    expect(google.campanhas.get(c.id)!.status).toBe('PAUSED');

    const volta = await desfazer(e, pausada.id);
    expect([volta.status, volta.body.tool, volta.body.status, volta.body.undoes], JSON.stringify(volta.body)).toEqual([201, 'campanha_retomar', 'aguardando_aprovacao', pausada.id]);
    expect(google.campanhas.get(c.id)!.status).toBe('PAUSED');
    expect((await aprovar(e, volta.body)).body.status).toBe('aprovada');
    await ciclo(e);
    expect(await ver(e, volta.body.id)).toMatchObject({ status: 'executada' });
    expect(google.campanhas.get(c.id)!.status).toBe('ENABLED');
  });

  it('as opções do pedido numa campanha do Google: sem "conecte de novo" (a autorização do Google já cobre mudar), só a campanha, com a verba e pausar', async () => {
    const c = await campanha(e, { name: 'Busca hambúrguer perto' });
    const [linha] = await ownerQuery<{ id: string }>(`select id from liame.campaign where connected_account_id = $1 and external_id = $2`, [e.conta, c.id]);
    const alvos = await api.call('GET', `/v1/actions/targets?brand_id=${e.brandId}`, { cookie: e.cookie });
    expect(alvos.status, JSON.stringify(alvos.body)).toBe(200);
    // A conta do Google não tem "acesso pedido" (isso é da Meta): com a escrita ligada, já pode.
    expect((alvos.body.campaigns as Array<{ campaign_id: string; write: string }>).find((x) => x.campaign_id === linha!.id)).toMatchObject({ write: 'ligada' });

    const opcoes = await api.call('GET', `/v1/actions/options?campaign_id=${linha!.id}`, { cookie: e.cookie });
    expect(opcoes.status, JSON.stringify(opcoes.body)).toBe(200);
    expect(opcoes.body).toMatchObject({
      campaign: { id: linha!.id, provider: 'google_ads', account_id: e.conta },
      target: { kind: 'campanha', name: 'Busca hambúrguer perto', status: 'ativo', daily_micros: 30 * REAL },
      tools: ['orcamento_ajustar', 'campanha_pausar'],
      ad_sets: [],
      ads: [],
    });

    // A verba é só desta campanha: não há com quem dividir, e o Google só foi perguntado pela campanha.
    expect(opcoes.body.target.shared_budget).toBeNull();
  });

  it('no Google a mudança é na campanha inteira: os grupos de anúncios e os anúncios que o Liame leu não entram nas opções, e pedir neles é recusado', async () => {
    const c = await campanha(e, { name: 'Busca com grupos' });
    const [linha] = await ownerQuery<{ id: string }>(`select id from liame.campaign where connected_account_id = $1 and external_id = $2`, [e.conta, c.id]);
    const grupo = randomUUID();
    await ownerQuery(
      `insert into liame.ad_group (id, tenant_id, connected_account_id, campaign_id, provider, external_id, name, status, daily_budget_micros, last_seen_at)
       values ($1, $2, $3, $4, 'google_ads', '7001', 'Grupo hambúrguer', 'ativa', null, now())`,
      [grupo, e.tenantId, e.conta, linha!.id],
    );
    await ownerQuery(
      `insert into liame.ad (id, tenant_id, connected_account_id, ad_group_id, provider, external_id, name, status, last_seen_at)
       values (gen_random_uuid(), $1, $2, $3, 'google_ads', '9001', 'Anúncio de busca', 'ativa', now())`,
      [e.tenantId, e.conta, grupo],
    );
    const opcoes = await api.call('GET', `/v1/actions/options?campaign_id=${linha!.id}`, { cookie: e.cookie });
    expect(opcoes.status, JSON.stringify(opcoes.body)).toBe(200);
    expect(opcoes.body).toMatchObject({ target: { kind: 'campanha', resource_id: `campanha:${c.id}` }, ad_sets: [], ads: [], listed_at: expect.any(String) });
    google.chamadas.length = 0;
    for (const alvo of ['conjunto:7001', 'anuncio:9001']) {
      const r = await api.call('GET', `/v1/actions/options?campaign_id=${linha!.id}&target=${alvo}`, { cookie: e.cookie });
      expect([r.status, r.body.code], JSON.stringify(r.body)).toEqual([422, 'alvo-nao-e-da-campanha']);
    }
    // A recusa sai antes de falar com o Google.
    expect(google.chamadasDe(e.cliente)).toHaveLength(0);
  });

  it('verba dividida nas opções: só pausar, com o orçamento inteiro, quantas campanhas usam e o nome das outras; sem o Google responder os nomes, o pedido segue', async () => {
    const dividido = google.novoOrcamento(e.cliente, { amountMicros: 120 * REAL, explicitlyShared: true });
    const d = await campanha(e, { orcamento: dividido.id, name: 'Busca hambúrguer perto' });
    await campanha(e, { orcamento: dividido.id, name: 'Busca Mister Burgers' });
    await campanha(e, { orcamento: dividido.id, name: 'Busca combo', status: 'PAUSED', primaryStatus: 'PAUSED' });
    // A removida não usa mais o orçamento; a de outro orçamento e a de outra conta não entram.
    await campanha(e, { orcamento: dividido.id, name: 'Busca antiga', status: 'REMOVED', primaryStatus: 'REMOVED' });
    await campanha(e, { name: 'Busca de outro orçamento' });
    const [linhaD] = await ownerQuery<{ id: string }>(`select id from liame.campaign where connected_account_id = $1 and external_id = $2`, [e.conta, d.id]);
    google.chamadas.length = 0;
    const daDividida = await api.call('GET', `/v1/actions/options?campaign_id=${linhaD!.id}`, { cookie: e.cookie });
    expect(daDividida.status, JSON.stringify(daDividida.body)).toBe(200);
    expect(daDividida.body).toMatchObject({ target: { daily_micros: null, shared_budget: { daily_micros: 120 * REAL, campaigns: 3, shared_with: ['Busca combo', 'Busca Mister Burgers'] } }, tools: ['campanha_pausar'] });
    // Duas leituras: a campanha e, por ser dividida, as outras do orçamento (pelo campo do orçamento, sem as removidas).
    const consultas = google.chamadasDe(e.cliente).map((x) => String(x.corpo.query));
    expect(consultas).toHaveLength(2);
    expect(consultas[1]).toBe(
      `SELECT campaign.id, campaign.name FROM campaign WHERE campaign.campaign_budget = 'customers/${e.cliente}/campaignBudgets/${dividido.id}' AND campaign.status != 'REMOVED' AND campaign.id != ${d.id} ORDER BY campaign.name LIMIT 10`,
    );

    // O Google não respondeu a segunda leitura: as opções saem do mesmo jeito, sem os nomes (a contagem veio com a campanha).
    google.defeitos.set(e.cliente, (x) => (String(x.corpo.query ?? '').includes('campaign.campaign_budget =') ? google.erro(503, 'UNAVAILABLE', 'The service is currently unavailable.') : null));
    try {
      const semNomes = await api.call('GET', `/v1/actions/options?campaign_id=${linhaD!.id}`, { cookie: e.cookie });
      expect(semNomes.status, JSON.stringify(semNomes.body)).toBe(200);
      expect(semNomes.body).toMatchObject({ target: { shared_budget: { daily_micros: 120 * REAL, campaigns: 3, shared_with: [] } }, tools: ['campanha_pausar'] });
    } finally {
      google.defeitos.delete(e.cliente);
    }

    // Criado para ser dividido, mas hoje só uma campanha usa: é dividido do mesmo jeito, e não há outra para citar.
    const deUma = google.novoOrcamento(e.cliente, { amountMicros: 40 * REAL, explicitlyShared: true });
    const u = await campanha(e, { orcamento: deUma.id, name: 'Busca sozinha' });
    const [linhaU] = await ownerQuery<{ id: string }>(`select id from liame.campaign where connected_account_id = $1 and external_id = $2`, [e.conta, u.id]);
    const daSozinha = await api.call('GET', `/v1/actions/options?campaign_id=${linhaU!.id}`, { cookie: e.cookie });
    expect(daSozinha.body).toMatchObject({ target: { daily_micros: null, shared_budget: { daily_micros: 40 * REAL, campaigns: 1, shared_with: [] } }, tools: ['campanha_pausar'] });
  });

  it('o Google recusou na conferência: o pedido guarda o motivo, e a resposta separa o texto do Google do código dele', async () => {
    const c = await campanha(e, { name: 'Busca recusada' });
    google.defeitos.set(e.cliente, (x) =>
      x.tipo === 'validacao' ? google.erro(400, 'INVALID_ARGUMENT', 'Request contains an invalid argument.', { codigo: { campaignBudgetError: 'BUDGET_BELOW_PER_DAY_MINIMUM' }, texto: "Budget amount must be above this campaign's per-day minimum." }) : null,
    );
    try {
      const recusada = await executar(e, 'orcamento_ajustar', c, { daily_budget_micros: 27 * REAL });
      expect(recusada).toMatchObject({
        status: 'falhou',
        attempts: 0,
        status_reason: "O Google recusou a mudança: Budget amount must be above this campaign's per-day minimum (campaignBudgetError.BUDGET_BELOW_PER_DAY_MINIMUM).",
        execution: { status: 'falhou', no_write: false, provider_reply: { text: "Budget amount must be above this campaign's per-day minimum.", code: 'campaignBudgetError.BUDGET_BELOW_PER_DAY_MINIMUM' } },
      });
      expect(google.escritasDe(e.cliente).filter((x) => x.recurso === 'campaignBudgets')).toHaveLength(0);
    } finally {
      google.defeitos.delete(e.cliente);
    }
    // O pedido que foi executado não tem resposta de recusa.
    const feita = await executar(e, 'campanha_pausar', c);
    expect(feita).toMatchObject({ status: 'executada', execution: { status: 'executada', provider_reply: null } });
  });

  it('o Google pediu para esperar: o pedido aprovado fica na fila com a hora da próxima tentativa, e o motivo fala do limite do Google', async () => {
    const c = await campanha(e, { name: 'Busca em espera' });
    google.defeitos.set(e.cliente, (x) =>
      x.tipo === 'leitura' ? null : google.erro(429, 'RESOURCE_EXHAUSTED', 'Resource has been exhausted (e.g. check quota).', { codigo: { quotaError: 'RESOURCE_EXHAUSTED_TEMPORARY' }, texto: 'Too many requests. Retry in 30 seconds.', esperar: '30s' }),
    );
    try {
      const adiada = await executar(e, 'campanha_pausar', c);
      expect(adiada).toMatchObject({ status: 'aprovada', status_reason: 'o Google pediu para esperar (limite de uso do Google)', attempts: 1, next_attempt_at: expect.any(String), execution: { status: 'adiada', provider_reply: null } });
      expect(google.campanhas.get(c.id)!.status).toBe('ENABLED');
    } finally {
      google.defeitos.delete(e.cliente);
    }
  });

  it('sem a escrita no Google ligada para a empresa, o pedido é negado e nada chega ao Google além do que já chegava', async () => {
    const outra = await empresaComGoogle(api, database, { nome: 'Hamburgueria sem escrita no Google' });
    const c = google.novaCampanha(outra.cliente);
    await campanhaLida(outra, c);
    google.chamadas.length = 0;
    const r = await pedir(outra, 'campanha_pausar', c);
    expect([r.status, r.body.code], JSON.stringify(r.body)).toEqual([403, 'escrita-desligada']);
    expect(google.chamadasDe(outra.cliente).filter((x) => x.tipo !== 'leitura')).toHaveLength(0);
    expect(google.campanhas.get(c.id)!.status).toBe('ENABLED');
  });
});
