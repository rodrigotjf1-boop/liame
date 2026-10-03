import { randomBytes, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { PlanListResponse, PlanResponse } from '@liame/contracts';
import { type Database, runMigrations, uuidv7 } from '@liame/database';
import { MockLanguageModelV4 } from 'ai/test';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mesesDoPlano } from '../../src/ai/estrategista/contexto.js';
import { TAREFA_ESTRATEGISTA } from '../../src/ai/estrategista/prompt.js';
import { AiGateway } from '../../src/ai/gateway.js';
import { ModelosIa } from '../../src/ai/modelos.js';
import { FerramentasDeLeitura } from '../../src/ai/registro/leituras.js';
import { currentStep, totpCode } from '../../src/auth/totp.js';
import { APP_CONFIG, type AppConfig } from '../../src/config.js';
import { DATABASE } from '../../src/database/database.module.js';
import { FlagService } from '../../src/flags/flag.service.js';
import { diaNoFuso, menosDias } from '../../src/results/fora-do-normal.js';
import { ResultsService } from '../../src/results/results.service.js';
import { EstrategistaLoop, TENTATIVAS } from '../../src/worker/estrategista-loop.js';
import { EstrategistaService } from '../../src/worker/estrategista.service.js';
import { enableMfa, ownerQuery, PASSWORD, resetIpRateLimits, signupAndLogin, startApi, TERMOS, type TestApi, tokenFrom, uniqueEmail } from '../helpers/api.js';
import { ligarIa, ModelosDeTeste, rotaCompartilhada, uso } from '../helpers/ia.js';
import { hasDb, OWNER_URL } from './env.js';

// Planos do Estrategista (A3, I11): a demanda que a LIA registrou vira plano pela fila do worker, com o modelo simulado;
// o plano só vai para Aprovações depois da conferência; a pessoa aprova com o código do app, edita (versão nova que
// derruba a aprovação), recusa ou pede nova análise; nada é executado; o plano é da empresa e tem prazo.

const FUSO = 'America/Sao_Paulo';

describe.skipIf(!hasDb)('Planos do Estrategista: fila, conferência, decisão, versões, prazo e isolamento (A3, I11)', () => {
  let api: TestApi;
  let database: Database;
  let config: AppConfig;
  let flags: FlagService;
  let modelos: ModelosDeTeste;
  let alvo: { provider: string; model: string };
  let loop: EstrategistaLoop;

  // Datas relativas ao dia em que o teste roda: a verba de hoje lê os 7 dias completos até ontem.
  const hoje = diaNoFuso(new Date(), FUSO);
  const semana = { from: menosDias(hoje, 7), to: menosDias(hoje, 1) };
  const amanha = menosDias(hoje, -1);
  const br = (d: string) => `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)}`;

  const responder = (mock: MockLanguageModelV4) => {
    modelos.porChave.set(`${alvo.provider}/${alvo.model}`, mock);
    return mock;
  };
  const rodada = (content: Array<{ type: 'text'; text: string } | { type: 'tool-call'; toolCallId: string; toolName: string; input: string }>) => ({
    content,
    finishReason: { unified: content.some((c) => c.type === 'tool-call') ? ('tool-calls' as const) : ('stop' as const), raw: undefined },
    usage: uso(1000, 500),
    warnings: [],
  });
  const pede = (toolName: string, input: unknown) => rodada([{ type: 'tool-call', toolCallId: `chamada-${randomBytes(3).toString('hex')}`, toolName, input: JSON.stringify(input) }]);
  const responde = (plano: Record<string, unknown>) => rodada([{ type: 'text', text: JSON.stringify(plano) }]);
  const roteiro = (...passos: Array<ReturnType<typeof rodada>>) => new MockLanguageModelV4({ doGenerate: passos });
  const enviado = (mock: MockLanguageModelV4, n: number) => JSON.stringify(mock.doGenerateCalls[n]!.prompt);

  const oferta = (extra: Record<string, unknown> = {}) => ({
    resumo: `Combo sexta em destaque em ${br(amanha)}, das 18:00 às 23:00.`,
    porques: [`A Combo sexta investiu R$ 200,00 de ${br(semana.from)} a ${br(semana.to)}.`],
    risco: 'baixo',
    risco_motivo: 'não pede verba nova nem cupom novo.',
    fazer: ['Na Meta, troque o texto do anúncio da Combo sexta pelo do plano.'],
    depois: 'A revisão de segunda mostra o que a oferta trouxe no caixa.',
    oferta: 'Combo sexta em destaque',
    dia: amanha,
    inicio: '18:00',
    fim: '23:00',
    onde: 'No anúncio da Combo sexta, no cardápio e no balcão.',
    texto_do_anuncio: 'Sexta é dia de combo: smash, batata e refri.',
    cupom: null,
    como_medir: 'Pedidos pelo link da campanha, confirmados no caixa.',
    ...extra,
  });

  type Dono = { cookie: string; tenantId: string; userId: string; brandId: string; secret: string; campanha: string };

  /** Empresa com a conta da Meta lida há pouco, a campanha "Combo sexta" e R$ 200,00 de gasto anteontem; IA ligada. */
  async function dono(opcoes: { ia?: boolean; campanha?: string } = {}): Promise<Dono> {
    await resetIpRateLimits();
    const s = await signupAndLogin(api, undefined, 'Hamburgueria dos Planos');
    const { secret } = await enableMfa(api, s.cookie);
    const tenantId = s.me.active_organization_id as string;
    const brandId = (await api.call('GET', '/v1/brands', { cookie: s.cookie })).body.items[0].id as string;
    const [conta, campanha, grupo, anuncio] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
    await ownerQuery(
      `insert into liame.connected_account (id, tenant_id, brand_id, provider, external_id, name, currency, timezone) values ($1, $2, $3, 'meta_ads', 'act_' || $4, 'Conta da Hamburgueria', 'BRL', $5)`,
      [conta, tenantId, brandId, Math.floor(Math.random() * 1e9).toString(), FUSO],
    );
    await ownerQuery(`insert into liame.sync_state (connected_account_id, dataset, tenant_id, expected_every_minutes, last_success_at) values ($1, 'metricas', $2, 1440, now() - interval '1 hour')`, [conta, tenantId]);
    await ownerQuery(`insert into liame.campaign (id, tenant_id, connected_account_id, provider, external_id, name, status) values ($1, $2, $3, 'meta_ads', 'c1', $4, 'ativa')`, [
      campanha,
      tenantId,
      conta,
      opcoes.campanha ?? 'Combo sexta',
    ]);
    await ownerQuery(`insert into liame.ad_group (id, tenant_id, connected_account_id, campaign_id, provider, external_id, name, status) values ($1, $2, $3, $4, 'meta_ads', 'g1', 'Bairros', 'ativa')`, [grupo, tenantId, conta, campanha]);
    await ownerQuery(`insert into liame.ad (id, tenant_id, connected_account_id, ad_group_id, provider, external_id, name, status) values ($1, $2, $3, $4, 'meta_ads', 'a1', 'Combo', 'ativa')`, [anuncio, tenantId, conta, grupo]);
    await ownerQuery(
      `insert into liame.metric_latest (connected_account_id, level, external_entity_id, metric_date, metric_name, attribution_window, tenant_id, brand_id, provider, entity_id, metric_value, currency, observed_at, changed_at)
       values ($1, 'ad', 'a1', $5, 'spend', '', $2, $3, 'meta_ads', $4, 200, 'BRL', now(), now())`,
      [conta, tenantId, brandId, anuncio, menosDias(hoje, 2)],
    );
    if (opcoes.ia !== false) await ligarIa(flags, tenantId);
    return { cookie: s.cookie, tenantId, userId: s.me.user.id as string, brandId, secret, campanha };
  }

  /** Outra pessoa na mesma empresa, com o nível dado. */
  async function membro(d: Dono, role: string): Promise<{ cookie: string }> {
    const email = uniqueEmail(role);
    const body: Record<string, unknown> = { email, role };
    if (['administrador', 'gestor', 'aprovador'].includes(role)) body.approve_limit_micros = 1_000_000;
    expect((await api.call('POST', '/v1/invitations', { cookie: d.cookie, body })).status).toBe(201);
    const s = await api.call('POST', '/v1/invitations/signup', { body: { token: tokenFrom(api.mailer, email), name: `Pessoa ${role}`, password: PASSWORD, terms_version: TERMOS } });
    if (!s.cookie) throw new Error(`convite não aceito: ${s.status} ${JSON.stringify(s.body)}`);
    await enableMfa(api, s.cookie);
    return { cookie: s.cookie };
  }

  /** A demanda como a LIA registra (I10): para o Estrategista, em nome do dono. */
  async function demanda(d: Dono, kind: 'promocao' | 'plano' | 'pauta', title = 'Promoção de sexta'): Promise<string> {
    const id = uuidv7();
    await ownerQuery(
      `insert into liame.demand (id, tenant_id, brand_id, kind, title, detail, assignee_agent, requested_by, opened_by_agent)
       values ($1, $2, $3, $4, $5, 'Quero uma promoção de combo para sexta à noite.', 'estrategista', $6, 'lia')`,
      [id, d.tenantId, d.brandId, kind, title, d.userId],
    );
    return id;
  }

  const rodarFila = (d: Dono) => loop.executarLote(10, { tenantIds: [d.tenantId] });
  const ver = async (d: { cookie: string }, id: string) => {
    const r = await api.call('GET', `/v1/plans/${id}`, { cookie: d.cookie });
    expect(r.status).toBe(200);
    return PlanResponse.parse(r.body);
  };
  /** Código do app para aprovar: o mesmo passo não vale duas vezes, então "o relógio anda" entre aprovações. */
  const codigo = async (d: Dono) => {
    await ownerQuery(`update liame.app_user set totp_last_step = null where id = $1`, [d.userId]);
    return totpCode(d.secret, currentStep());
  };
  const demandaNoBanco = async (id: string) =>
    (await ownerQuery<{ status: string; attempts: number; last_error: string | null; espera_min: number | null }>(
      `select status, attempts, last_error, round(extract(epoch from (next_attempt_at - now())) / 60)::int as espera_min from liame.demand where id = $1`,
      [id],
    ))[0]!;
  const usos = (tenantId: string) =>
    ownerQuery<{ workflow: string; user_id: string | null; prompt_version: string }>(`select workflow, user_id, prompt_version from liame.ai_usage where tenant_id = $1 and task = $2 order by occurred_at, id`, [
      tenantId,
      TAREFA_ESTRATEGISTA,
    ]);

  /** Uma oferta proposta pela fila, pronta para a decisão. */
  async function ofertaProposta(d: Dono, extra: Record<string, unknown> = {}): Promise<PlanResponse> {
    const id = await demanda(d, 'promocao');
    responder(roteiro(pede('resultados_ciclo_fechado', { brand_id: d.brandId, ...semana }), responde(oferta(extra))));
    const vezes = await rodarFila(d);
    expect(vezes).toEqual([{ tipo: 'demanda', id, tenantId: d.tenantId, status: 'proposto' }]);
    const lista = PlanListResponse.parse((await api.call('GET', `/v1/plans?brand_id=${d.brandId}`, { cookie: d.cookie })).body);
    return ver(d, lista.items.find((p) => p.demand_id === id)!.id);
  }

  beforeAll(async () => {
    await runMigrations({ connectionString: OWNER_URL, dir: resolve(process.cwd(), '../../packages/database/migrations') });
    api = await startApi();
    database = api.app.get(DATABASE);
    config = api.app.get(APP_CONFIG);
    flags = api.app.get(FlagService);
    modelos = new ModelosDeTeste(config);
    api.app.get(ModelosIa).modelo = (provider, model) => modelos.modelo(provider, model);
    // A fila do worker com o gateway e as leituras da aplicação (os mesmos serviços das rotas).
    const servico = new EstrategistaService(database, api.app.get(AiGateway), api.app.get(FerramentasDeLeitura), api.app.get(ResultsService));
    loop = new EstrategistaLoop(database, flags, servico);
    // A tarefa do Estrategista também é usada por `planos-agenda.spec.ts`, que roda em outro processo: a rota é a
    // compartilhada (ninguém apaga a do outro), e o modelo simulado é o deste arquivo.
    alvo = await rotaCompartilhada(modelos, TAREFA_ESTRATEGISTA, roteiro(responde(oferta())));
  });
  beforeEach(resetIpRateLimits);
  afterAll(async () => {
    await api?.close();
  });

  it('A3-10: a demanda de promoção vira oferta em Aprovações, com a fonte de cada número e a auditoria do agente', async () => {
    const d = await dono();
    const id = await demanda(d, 'promocao');
    const mock = responder(roteiro(pede('resultados_ciclo_fechado', { brand_id: d.brandId, ...semana }), responde(oferta())));
    expect(await rodarFila(d)).toEqual([{ tipo: 'demanda', id, tenantId: d.tenantId, status: 'proposto' }]);

    // O Estrategista recebeu o tipo, o calendário, a verba de hoje e o pedido; e as leituras da rotina.
    const instrucoes = enviado(mock, 0);
    expect(instrucoes).toContain('Tipo de plano pedido: a oferta (uma promoção).');
    expect(instrucoes).toContain('Verba de anúncios hoje, por mês');
    expect(instrucoes).toContain('Meta R$ 860,00; Google R$ 0,00');
    expect(instrucoes).toContain('Quero uma promoção de combo para sexta à noite.');
    expect((mock.doGenerateCalls[0]!.tools ?? []).map((t) => t.name).sort()).toEqual(
      ['atencao_avisos', 'cupons_campanha', 'fontes_frescor', 'links_rastreio', 'midia_entrega', 'resultados_ciclo_fechado'].sort(),
    );

    expect((await demandaNoBanco(id)).status).toBe('entregue');
    const lista = PlanListResponse.parse((await api.call('GET', `/v1/plans?brand_id=${d.brandId}&status=pendente`, { cookie: d.cookie })).body);
    expect(lista.items).toHaveLength(1);
    const resumo = lista.items[0]!;
    expect(resumo).toMatchObject({ kind: 'oferta', title: 'Promoção de sexta', status: 'pendente', version: 1, risk: 'baixo', money_micros: null, demand_id: id });
    expect(resumo.requested_by).toEqual({ id: d.userId, name: expect.any(String) });
    // A oferta expira na hora em que começa (amanhã, 18:00, no fuso da loja), e nunca depois de três dias.
    const expira = new Date(resumo.expires_at).getTime();
    expect(expira).toBeLessThanOrEqual(Date.now() + 72 * 3_600_000);
    expect(expira).toBe(new Date((await ownerQuery<{ t: Date }>(`select ($1::date + time '18:00') at time zone $2 as t`, [amanha, FUSO]))[0]!.t).getTime());

    const p = await ver(d, resumo.id);
    expect(p.content).toMatchObject({ kind: 'oferta', offer: 'Combo sexta em destaque', day: amanha, starts_at: '18:00', coupon_code: null });
    expect(p).toMatchObject({ author: 'estrategista', edited_by: null, reanalysis: null, decisions: [], can_decide: true });
    const fonte = (valor: string) => p.numbers.find((n) => n.value === valor)?.sources ?? [];
    expect(fonte('R$ 200,00')[0]).toMatch(/^Resultados de /);
    expect(fonte(br(amanha))).toEqual(['Proposta do Estrategista nesta versão do plano']);
    // A hora solta fica como texto (não ganha marcação), mas passou pela conferência como os outros números.
    expect(fonte('18:00')).toEqual([]);
    expect(p.marked.map((m) => m.path)).toEqual(['summary', 'reasons.0']);

    // Custo de quem pediu; o agente na auditoria.
    expect(await usos(d.tenantId)).toEqual([
      { workflow: 'estrategista.plano', user_id: d.userId, prompt_version: 'estrategista.plano@1' },
      { workflow: 'estrategista.plano', user_id: d.userId, prompt_version: 'estrategista.plano@1' },
    ]);
    const auditoria = await ownerQuery<{ actor_type: string; actor_label: string; agent: string; origin: string; after: Record<string, unknown> }>(
      `select actor_type, actor_label, agent, origin, after from liame.audit_event where tenant_id = $1 and action = 'plano.propor' and resource_id = $2`,
      [d.tenantId, resumo.id],
    );
    expect(auditoria).toEqual([
      {
        actor_type: 'agent',
        actor_label: 'Estrategista',
        agent: 'estrategista',
        origin: 'worker',
        after: { kind: 'oferta', version: 1, content_hash: resumo.content_hash, risk: 'baixo', money_micros: null, demand_id: id, nova_analise: false },
      },
    ]);
  });

  it('aprovar pede o código do app e o hash da versão vista; nada é executado, e a segunda aprovação é 409', async () => {
    const d = await dono();
    const p = await ofertaProposta(d);
    const aprovar = async (hash: string, code: string) => api.call('POST', `/v1/plans/${p.plan.id}/approve`, { cookie: d.cookie, body: { plan_hash: hash, code } });
    expect((await aprovar('0'.repeat(64), await codigo(d))).body.code).toBe('plano-mudou');
    expect((await aprovar(p.plan.content_hash, '000000')).status).toBe(401);
    const ok = await aprovar(p.plan.content_hash, await codigo(d));
    expect(ok.status).toBe(200);
    const aprovado = PlanResponse.parse(ok.body);
    expect(aprovado.plan.status).toBe('aprovado');
    expect(aprovado.can_decide).toBe(false);
    expect(aprovado.decisions).toEqual([{ version: 1, decision: 'aprovado', reasons: [], comment: null, decided_by: { id: d.userId, name: expect.any(String) }, created_at: expect.any(String) }]);
    expect((await aprovar(p.plan.content_hash, await codigo(d))).body.code).toBe('plano-nao-aguarda');
    const eventos = await ownerQuery<{ action: string }>(`select action from liame.audit_event where tenant_id = $1 and resource_id = $2 order by occurred_at`, [d.tenantId, p.plan.id]);
    expect(eventos.map((e) => e.action)).toEqual(['plano.propor', 'plano.aprovar']);
    // Nenhuma ação foi pedida a plataforma nenhuma.
    expect(await ownerQuery(`select 1 from liame.action_request where tenant_id = $1`, [d.tenantId])).toHaveLength(0);
  });

  it('editar cria a versão da pessoa, derruba a aprovação antiga e passa pelo Compliance e pela marca', async () => {
    const d = await dono();
    const p = await ofertaProposta(d);
    expect((await api.call('POST', `/v1/plans/${p.plan.id}/approve`, { cookie: d.cookie, body: { plan_hash: p.plan.content_hash, code: await codigo(d) } })).status).toBe(200);
    const editar = (content: Record<string, unknown>, base = 1) => api.call('PUT', `/v1/plans/${p.plan.id}`, { cookie: d.cookie, body: { base_version: base, content } });

    const nova: Record<string, unknown> = { ...p.content, reasons: ['A Combo sexta investiu R$ 200,00 e trouxe 99 pedidos.'], where: 'No balcão. Dúvidas: dono@hamburgueria.com.br' };
    const r = await editar(nova);
    expect(r.status).toBe(200);
    const v2 = PlanResponse.parse(r.body);
    expect(v2.plan).toMatchObject({ version: 2, status: 'pendente' });
    expect(v2).toMatchObject({ author: 'pessoa', edited_by: { id: d.userId }, can_decide: true });
    // O dado pessoal saiu antes de gravar; o número que ela escreveu é dela; o que já estava leva a fonte de antes.
    expect(v2.content.kind === 'oferta' && v2.content.where).not.toContain('@');
    const fonte = (valor: string) => v2.numbers.find((n) => n.value === valor)?.sources ?? [];
    expect(fonte('99')).toEqual(['Escrito por quem editou esta versão do plano']);
    expect(fonte('R$ 200,00')).toEqual(p.numbers.find((n) => n.value === 'R$ 200,00')!.sources);

    // A aprovação era da versão 1: o hash antigo não aprova mais, e a edição a partir da versão velha também não entra.
    expect((await api.call('POST', `/v1/plans/${p.plan.id}/approve`, { cookie: d.cookie, body: { plan_hash: p.plan.content_hash, code: await codigo(d) } })).body.code).toBe('plano-mudou');
    expect((await editar(nova, 1)).body.code).toBe('plano-mudou');
    const promessa = await editar({ ...(v2.content as Record<string, unknown>), ad_text: 'Combo com resultado garantido.' }, 2);
    expect(promessa.status).toBe(422);
    expect(promessa.body).toMatchObject({ code: 'texto-recusado' });
    expect(promessa.body.detail).toContain('promessa de resultado (regra da Liame)');
    expect((await editar({ kind: 'pauta', summary: 'x', reasons: ['x'], risk: 'baixo', risk_reason: 'x', to_do: [], after: 'x', days: [{ day: amanha, item: 'x' }] }, 2)).body.code).toBe('tipo-do-plano');
    expect((await editar(v2.content as Record<string, unknown>, 2)).body.code).toBe('plano-sem-mudanca');
    const eventos = await ownerQuery<{ action: string; before: Record<string, unknown> | null; after: Record<string, unknown> }>(
      `select action, before, after from liame.audit_event where tenant_id = $1 and resource_id = $2 and action = 'plano.editar'`,
      [d.tenantId, p.plan.id],
    );
    expect(eventos).toEqual([{ action: 'plano.editar', before: { version: 1, status: 'aprovado', content_hash: p.plan.content_hash }, after: { version: 2, status: 'pendente', content_hash: v2.plan.content_hash } }]);
  });

  it('pedir nova análise: o Estrategista refaz com a versão anterior e o pedido, e manda a versão seguinte; recusar guarda o motivo', async () => {
    const d = await dono();
    const p = await ofertaProposta(d);
    const pedido = await api.call('POST', `/v1/plans/${p.plan.id}/reanalyze`, {
      cookie: d.cookie,
      body: { plan_hash: p.plan.content_hash, request: 'Quero sem refrigerante. Me liga no (21) 99876-5432.' },
    });
    expect(pedido.status).toBe(200);
    const esperando = PlanResponse.parse(pedido.body);
    expect(esperando.plan.status).toBe('nova_analise');
    expect(esperando.decisions[0]).toMatchObject({ decision: 'nova_analise', version: 1 });
    expect(esperando.decisions[0]!.comment).not.toMatch(/9876/);

    const mock = responder(roteiro(responde(oferta({ oferta: 'Combo sexta sem refrigerante', resumo: `Combo sexta sem refrigerante em ${br(amanha)}, das 18:00 às 23:00.` }))));
    expect(await rodarFila(d)).toEqual([{ tipo: 'nova_analise', id: p.plan.id, tenantId: d.tenantId, status: 'proposto' }]);
    expect(enviado(mock, 0)).toContain('Versão anterior deste plano (versão 1)');
    expect(enviado(mock, 0)).toContain('Quero sem refrigerante.');
    const v2 = await ver(d, p.plan.id);
    expect(v2.plan).toMatchObject({ version: 2, status: 'pendente' });
    expect(v2).toMatchObject({ author: 'estrategista', can_decide: true });
    expect(v2.reanalysis).toContain('Quero sem refrigerante.');
    expect(v2.content).toMatchObject({ offer: 'Combo sexta sem refrigerante' });

    const recusa = await api.call('POST', `/v1/plans/${p.plan.id}/reject`, {
      cookie: d.cookie,
      body: { plan_hash: v2.plan.content_hash, reasons: ['oferta_nao_serve', 'oferta_nao_serve'], comment: 'Combo sem bebida não vende aqui.' },
    });
    expect(recusa.status).toBe(200);
    const recusado = PlanResponse.parse(recusa.body);
    expect(recusado.plan.status).toBe('recusado');
    expect(recusado.decisions.at(-1)).toMatchObject({ version: 2, decision: 'recusado', reasons: ['oferta_nao_serve'], comment: 'Combo sem bebida não vende aqui.' });
    expect((await api.call('POST', `/v1/plans/${p.plan.id}/reanalyze`, { cookie: d.cookie, body: { plan_hash: v2.plan.content_hash, request: 'De novo.' } })).body.code).toBe('plano-nao-aguarda');
  });

  it('o plano de 90 dias traz a verba de hoje calculada pelo sistema e só datas da tabela do Liame', async () => {
    const d = await dono();
    const id = await demanda(d, 'plano', 'Plano para os próximos meses');
    const data = (await ownerQuery<{ day: string; name: string }>(`select day::text as day, name from liame.commercial_date where day between $1::date and $1::date + 92 order by day, name limit 1`, [hoje]))[0];
    const datas = data ? [{ dia: data.day, nome: data.name, o_que_fazer: 'Um combo para dividir.' }] : [];
    const plano = {
      resumo: 'Em três meses: provar de onde vêm os pedidos e fazer sobrar mais do marketing.',
      porques: [`A Combo sexta investiu R$ 200,00 de ${br(semana.from)} a ${br(semana.to)}.`],
      risco: 'medio',
      risco_motivo: 'pede verba nova na Meta.',
      fazer: ['Na Meta, deixe a verba do mês em R$ 1.000,00.'],
      depois: 'A pauta de cada semana sai deste plano.',
      objetivos: [{ objetivo: 'Provar a origem dos pedidos', como_saber: 'Os pedidos sem origem caindo na revisão de cada segunda.' }],
      // Os nomes que o contexto dá (o mês de hoje e os dois seguintes).
      meses: mesesDoPlano(hoje).map((m, i) => ({ mes: m.nome, plano: ['Rastreio nos anúncios.', 'Um combo novo para testar.', 'Os horários avisados antes.'][i]! })),
      verba_proposta: { meta: 1000, google: 0 },
      datas,
    };
    responder(roteiro(pede('resultados_ciclo_fechado', { brand_id: d.brandId, ...semana }), responde(plano)));
    expect(await rodarFila(d)).toEqual([{ tipo: 'demanda', id, tenantId: d.tenantId, status: 'proposto' }]);
    const lista = PlanListResponse.parse((await api.call('GET', `/v1/plans?brand_id=${d.brandId}`, { cookie: d.cookie })).body);
    const p = await ver(d, lista.items[0]!.id);
    expect(p.plan).toMatchObject({ kind: 'noventa_dias', risk: 'medio', money_micros: '140000000' });
    expect(p.content.kind === 'noventa_dias' && p.content.budget).toEqual({ today: { meta: 860, google: 0 }, proposal: { meta: 1000, google: 0 } });
    const hojeMeta = p.marked.find((m) => m.path === 'budget.today.meta')!;
    expect(p.numbers[hojeMeta.text[0]!.number!]!.sources[0]).toContain(`Meta Ads · gasto de ${br(semana.from)} a ${br(semana.to)} levado para 30 dias`);

    // Data que não está na tabela não passa: a demanda volta para a fila, e nenhum plano novo aparece.
    const outra = await demanda(d, 'plano', 'Outro plano');
    responder(roteiro(responde({ ...plano, datas: [{ dia: amanha, nome: 'Dia do Hambúrguer', o_que_fazer: 'Combo.' }] })));
    expect(await rodarFila(d)).toEqual([{ tipo: 'demanda', id: outra, tenantId: d.tenantId, status: 'recusado', motivo: 'data_fora_do_calendario' }]);
  });

  it('a pauta da semana pode começar hoje e espera a decisão até o fim do último dia dela', async () => {
    const d = await dono();
    const id = await demanda(d, 'pauta', 'Pauta da semana');
    const pautaHoje = {
      resumo: 'O que fazer hoje e amanhã.',
      porques: [`A Combo sexta investiu R$ 200,00 de ${br(semana.from)} a ${br(semana.to)}.`],
      risco: 'baixo',
      risco_motivo: 'nenhuma verba nova.',
      fazer: [],
      depois: 'A revisão de segunda mostra o que foi feito.',
      dias: [
        { dia: hoje, item: 'Pôr o rastreio nos anúncios.' },
        { dia: amanha, item: 'Nada novo.' },
      ],
    };
    responder(roteiro(pede('resultados_ciclo_fechado', { brand_id: d.brandId, ...semana }), responde(pautaHoje)));
    expect(await rodarFila(d)).toEqual([{ tipo: 'demanda', id, tenantId: d.tenantId, status: 'proposto' }]);
    const plano = PlanListResponse.parse((await api.call('GET', `/v1/plans?brand_id=${d.brandId}`, { cookie: d.cookie })).body).items[0]!;
    expect(plano).toMatchObject({ kind: 'pauta', status: 'pendente', title: 'Pauta da semana' });
    // O fim de amanhã, no fuso da loja, vem antes dos três dias: é ele que vale.
    const fimDoUltimoDia = (await ownerQuery<{ t: Date }>(`select ($1::date + 1)::timestamp at time zone $2 as t`, [amanha, FUSO]))[0]!.t;
    expect(new Date(plano.expires_at).getTime()).toBe(new Date(fimDoUltimoDia).getTime());
  });

  it('o que não passa na conferência não vira plano: a demanda volta com espera crescente e, na quinta falha, sai da fila', async () => {
    const d = await dono();
    const id = await demanda(d, 'promocao');
    responder(roteiro(pede('resultados_ciclo_fechado', { brand_id: d.brandId, ...semana }), responde(oferta({ porques: ['A Combo sexta trouxe 11 pedidos.'] }))));
    expect(await rodarFila(d)).toEqual([{ tipo: 'demanda', id, tenantId: d.tenantId, status: 'recusado', motivo: 'numero_fora' }]);
    // D-A3-15: o plano que a conferência recusou fica contado para Sua equipe, sem o texto.
    expect(
      await ownerQuery<{ member: string; workflow: string; kind: string; rules: string[]; items: number }>(
      `select member, workflow, kind, rules, items from liame.ai_refusal where tenant_id = $1 order by kind`,
      [d.tenantId],
    ),
    ).toEqual([{ member: 'estrategista', workflow: 'estrategista.plano', kind: 'numero_fora', rules: [], items: 1 }]);
    const depois = await demandaNoBanco(id);
    expect(depois).toMatchObject({ status: 'aberta', attempts: 1, last_error: 'numero_fora' });
    expect(depois.espera_min).toBeGreaterThanOrEqual(14);
    expect(depois.espera_min).toBeLessThanOrEqual(15);
    expect(await ownerQuery(`select 1 from liame.plan where demand_id = $1`, [id])).toHaveLength(0);
    // Ainda não é a vez dela.
    expect(await rodarFila(d)).toEqual([]);

    // Na última tentativa que falha, o Estrategista desiste: a demanda fica aberta para a pessoa ver e cancelar.
    await ownerQuery(`update liame.demand set attempts = $2, next_attempt_at = null where id = $1`, [id, TENTATIVAS - 1]);
    responder(roteiro(responde(oferta({ cupom: 'NAOEXISTE' }))));
    expect(await rodarFila(d)).toEqual([{ tipo: 'demanda', id, tenantId: d.tenantId, status: 'recusado', motivo: 'cupom_desconhecido' }]);
    expect(await demandaNoBanco(id)).toMatchObject({ status: 'aberta', attempts: TENTATIVAS, last_error: 'cupom_desconhecido' });
    await ownerQuery(`update liame.demand set next_attempt_at = null where id = $1`, [id]);
    expect(await rodarFila(d)).toEqual([]);
    expect((await api.call('POST', `/v1/demands/${id}/cancel`, { cookie: d.cookie })).status).toBe(200);
  });

  it('A3-6: sem a IA ligada, com o Estrategista desligado ou com campanha de nome político, o modelo não é chamado', async () => {
    const semIa = await dono({ ia: false });
    const id = await demanda(semIa, 'promocao');
    expect(await rodarFila(semIa)).toEqual([{ tipo: 'demanda', id, tenantId: semIa.tenantId, status: 'sem_ia', motivo: 'ia_desligada' }]);
    const volta = await demandaNoBanco(id);
    expect(volta).toMatchObject({ status: 'aberta', attempts: 0, last_error: 'ia_desligada' });
    expect(volta.espera_min).toBeGreaterThanOrEqual(59);
    expect(await usos(semIa.tenantId)).toEqual([]);

    const desligado = await dono();
    await ownerQuery(`insert into liame.agent_activation (id, tenant_id, agent_key, enabled, set_by) values (gen_random_uuid(), $1, 'estrategista', false, 'teste')`, [desligado.tenantId]);
    const outra = await demanda(desligado, 'promocao');
    expect(await rodarFila(desligado)).toEqual([{ tipo: 'demanda', id: outra, tenantId: desligado.tenantId, status: 'sem_ia', motivo: 'funcionario_desligado' }]);
    expect(await usos(desligado.tenantId)).toEqual([]);

    const politico = await dono({ campanha: 'Vote em Fulano para prefeito' });
    const terceira = await demanda(politico, 'promocao');
    expect(await rodarFila(politico)).toEqual([{ tipo: 'demanda', id: terceira, tenantId: politico.tenantId, status: 'recusado', motivo: 'conteudo_politico' }]);
    expect(await usos(politico.tenantId)).toEqual([]);
  });

  it('A3-4: o plano é da empresa; quem só lê vê e não decide; o prazo vencido não aceita decisão, só nova análise', async () => {
    const d = await dono();
    const p = await ofertaProposta(d);
    const outra = await dono();
    expect((await api.call('GET', `/v1/plans/${p.plan.id}`, { cookie: outra.cookie })).status).toBe(404);
    expect((await api.call('GET', `/v1/plans?brand_id=${d.brandId}`, { cookie: outra.cookie })).status).toBe(404);
    expect((await api.call('POST', `/v1/plans/${p.plan.id}/reject`, { cookie: outra.cookie, body: { plan_hash: p.plan.content_hash, reasons: ['nao_concordo'] } })).status).toBe(404);

    const leitor = await membro(d, 'somente_leitura');
    expect((await ver(leitor, p.plan.id)).can_decide).toBe(false);
    expect((await api.call('POST', `/v1/plans/${p.plan.id}/reject`, { cookie: leitor.cookie, body: { plan_hash: p.plan.content_hash, reasons: ['nao_concordo'] } })).status).toBe(403);

    await ownerQuery(`update liame.plan set expires_at = now() - interval '1 minute' where id = $1`, [p.plan.id]);
    const expirado = await ver(d, p.plan.id);
    expect(expirado.plan.status).toBe('expirado');
    expect(expirado.can_decide).toBe(false);
    const soExpirados = PlanListResponse.parse((await api.call('GET', `/v1/plans?brand_id=${d.brandId}&status=expirado`, { cookie: d.cookie })).body);
    expect(soExpirados.items.map((x) => x.id)).toEqual([p.plan.id]);
    expect((await api.call('POST', `/v1/plans/${p.plan.id}/approve`, { cookie: d.cookie, body: { plan_hash: p.plan.content_hash, code: await codigo(d) } })).body.code).toBe('plano-expirado');
    expect((await api.call('POST', `/v1/plans/${p.plan.id}/reject`, { cookie: d.cookie, body: { plan_hash: p.plan.content_hash, reasons: ['nao_e_o_momento'] } })).body.code).toBe('plano-expirado');
    const nova = await api.call('POST', `/v1/plans/${p.plan.id}/reanalyze`, { cookie: d.cookie, body: { plan_hash: p.plan.content_hash, request: 'Monte de novo para a próxima sexta.' } });
    expect(nova.status).toBe(200);
    expect(PlanResponse.parse(nova.body).plan.status).toBe('nova_analise');
  });
});
