import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { TeamResponse } from '@liame/contracts';
import { createDatabase, type Database, runMigrations, uuidv7, withTenant } from '@liame/database';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { funcionarioAtivo } from '../../src/ai/registro/ativacao.js';
import { FlagService } from '../../src/flags/flag.service.js';
import { diaNoFuso, menosDias } from '../../src/results/fora-do-normal.js';
import { ResultsService } from '../../src/results/results.service.js';
import { SombraLoop } from '../../src/worker/sombra-loop.js';
import { SombraService } from '../../src/worker/sombra.service.js';
import { enableMfa, ownerQuery, PASSWORD, resetIpRateLimits, signupAndLogin, startApi, TERMOS, type TestApi, tokenFrom, uniqueEmail } from '../helpers/api.js';
import { ligarIa } from '../helpers/ia.js';
import { APP_URL, hasDb, OWNER_URL } from './env.js';

// A3 · I13b: Sua equipe. A leitura mostra a situação de cada membro (pelas chaves da empresa, do plano, das flags e da
// parada), o custo de IA e o que fez no mês; a empresa desliga e liga um membro numa marca, e quem está desligado
// não trabalha (a IA, a sombra).

const FUSO = 'America/Sao_Paulo';
const hoje = diaNoFuso(new Date(), FUSO);

describe.skipIf(!hasDb)('Sua equipe: situação, custo, números do mês e desligar (A3, I13b)', () => {
  let api: TestApi;
  let database: Database;
  let flags: FlagService;

  type Empresa = { cookie: string; tenantId: string; userId: string; brandId: string; conta: string; campanha: string };

  async function empresa(): Promise<Empresa> {
    await resetIpRateLimits();
    const s = await signupAndLogin(api, undefined, 'Hamburgueria da Equipe');
    await enableMfa(api, s.cookie);
    const tenantId = s.me.active_organization_id as string;
    const brandId = (await api.call('GET', '/v1/brands', { cookie: s.cookie })).body.items[0].id as string;
    const [conta, campanha] = [randomUUID(), randomUUID()];
    await ownerQuery(
      `insert into liame.connected_account (id, tenant_id, brand_id, provider, external_id, name, currency, timezone) values ($1, $2, $3, 'meta_ads', $4, 'CA - Equipe', 'BRL', $5)`,
      [conta, tenantId, brandId, `act_${randomUUID().slice(0, 8)}`, FUSO],
    );
    await ownerQuery(
      `insert into liame.campaign (id, tenant_id, connected_account_id, provider, external_id, name, status, daily_budget_micros) values ($1, $2, $3, 'meta_ads', 'c1', 'Delivery noite', 'ativa', 30000000)`,
      [campanha, tenantId, conta],
    );
    return { cookie: s.cookie, tenantId, userId: s.me.user.id as string, brandId, conta, campanha };
  }

  async function membro(e: Empresa, role: string): Promise<{ cookie: string }> {
    const email = uniqueEmail(role);
    const body: Record<string, unknown> = { email, role };
    if (['administrador', 'gestor', 'aprovador'].includes(role)) body.approve_limit_micros = 1_000_000;
    expect((await api.call('POST', '/v1/invitations', { cookie: e.cookie, body })).status).toBe(201);
    const s = await api.call('POST', '/v1/invitations/signup', { body: { token: tokenFrom(api.mailer, email), name: `Pessoa ${role}`, password: PASSWORD, terms_version: TERMOS } });
    if (!s.cookie) throw new Error(`convite não aceito: ${s.status} ${JSON.stringify(s.body)}`);
    await enableMfa(api, s.cookie);
    return { cookie: s.cookie };
  }

  async function ligarSombra(tenantId: string): Promise<void> {
    await ownerQuery(`insert into liame.feature_flag_rule (id, flag_key, scope_type, scope_id, value, created_by) values (gen_random_uuid(), 'sombra', 'tenant', $1, 'true'::jsonb, 'testes')`, [tenantId]);
    flags.invalidate();
  }

  /**
   * Uma chamada ao modelo registrada no mês, como o AI Gateway grava. `respondeu`: a chamada que entregou a resposta do
   * pedido (a atendida, se o teste não disser outra coisa); a rodada em que o modelo só pediu uma leitura não respondeu.
   */
  async function chamada(e: Empresa, workflow: string, custo: number, o: { outcome?: string; respondeu?: boolean } = {}): Promise<string> {
    const id = uuidv7();
    const outcome = o.outcome ?? 'ok';
    const respondeu = o.respondeu ?? outcome === 'ok';
    await ownerQuery(
      `insert into liame.ai_usage (id, tenant_id, brand_id, user_id, workflow, task, provider, model, served_by, cost_usd_micros, outcome, tool_calls, answered)
       values ($1, $2, $3, $4, $5, 'teste', 'teste', 'modelo', 'principal', $6, $7, $8, $9)`,
      [id, e.tenantId, e.brandId, e.userId, workflow, custo, outcome, outcome === 'ok' && !respondeu ? 1 : 0, respondeu],
    );
    return id;
  }

  const ver = async (e: { cookie: string }, brandId: string) => {
    const r = await api.call('GET', `/v1/team?brand_id=${brandId}`, { cookie: e.cookie });
    expect(r.status).toBe(200);
    return TeamResponse.parse(r.body);
  };
  const situacoes = (t: TeamResponse) => Object.fromEntries(t.members.map((m) => [m.key, m.status]));
  const doMembro = (t: TeamResponse, key: string) => t.members.find((m) => m.key === key)!;
  const numeros = (t: TeamResponse, key: string) => Object.fromEntries(doMembro(t, key).stats.map((s) => [s.key, s.value]));

  beforeAll(async () => {
    await runMigrations({ connectionString: OWNER_URL, dir: resolve(process.cwd(), '../../packages/database/migrations') });
    api = await startApi();
    await resetIpRateLimits();
    database = createDatabase({ connectionString: APP_URL, max: 3, applicationName: 'liame-test' });
    flags = api.app.get(FlagService);
  });
  afterAll(async () => {
    await database?.close();
    await api?.close();
  });

  it('a situação de cada um segue as flags da distribuição e a parada da empresa', async () => {
    const e = await empresa();
    let t = await ver(e, e.brandId);
    // Nasce tudo desligado pela distribuição (IA e sombra), menos quem trabalha por regra.
    expect(situacoes(t)).toEqual({
      lia: 'desligado_pela_liame',
      analista: 'desligado_pela_liame',
      relatorios: 'ativo',
      compliance: 'ativo',
      estrategista: 'desligado_pela_liame',
      pesquisador: 'desligado_pela_liame',
      trafego: 'desligado_pela_liame',
    });
    expect(t).toMatchObject({ ai: { enabled: false, spent_usd_micros: '0', band: 'livre' }, stop: null, can_manage: true, can_stop: true });
    expect(t.month.from <= hoje && hoje <= t.month.to).toBe(true);
    // O Compliance trabalha por regra e não desliga; os números dele são contagens (D-A3-15), zeradas sem nada no mês.
    expect(doMembro(t, 'compliance')).toMatchObject({ kind: 'regra', can_pause: false });
    expect(numeros(t, 'compliance')).toEqual({ textos_conferidos: '0', textos_barrados: '0' });

    await ligarIa(flags, e.tenantId);
    await ligarSombra(e.tenantId);
    t = await ver(e, e.brandId);
    expect(situacoes(t)).toEqual({ lia: 'ativo', analista: 'ativo', relatorios: 'ativo', compliance: 'ativo', estrategista: 'ativo', pesquisador: 'ativo', trafego: 'sombra' });

    // A parada da empresa (a mesma da A1) trava quem usa IA; quem trabalha por regra segue.
    const parada = await api.call('POST', '/v1/kill-switches', { cookie: e.cookie, body: { level: 'tenant', reason: 'Revisando os textos da semana' } });
    expect(parada.status).toBe(201);
    t = await ver(e, e.brandId);
    expect(t.stop).toMatchObject({ id: parada.body.id, level: 'tenant', by_company: true, reason: 'Revisando os textos da semana', by: { id: e.userId } });
    expect(situacoes(t)).toEqual({ lia: 'parado', analista: 'parado', relatorios: 'ativo', compliance: 'ativo', estrategista: 'parado', pesquisador: 'parado', trafego: 'sombra' });
    expect((await api.call('DELETE', `/v1/kill-switches/${parada.body.id}`, { cookie: e.cookie })).status).toBe(204);
    expect((await ver(e, e.brandId)).stop).toBeNull();
  });

  it('o custo de IA de cada um e o que fez no mês saem do banco, por marca', async () => {
    const e = await empresa();
    await ligarIa(flags, e.tenantId);
    const resposta = await chamada(e, 'conversa.lia', 120_000);
    await chamada(e, 'conversa.lia', 80_000);
    // A rodada em que a LIA só leu os dados custa e é uma chamada, mas a resposta é a chamada seguinte.
    await chamada(e, 'conversa.lia', 40_000, { respondeu: false });
    // A tentativa que falhou também custa, mas não conta como resposta.
    await chamada(e, 'conversa.lia', 10_000, { outcome: 'erro' });
    // As duas respostas que o Compliance barrou chegaram à conferência, não à pessoa.
    const barradas = [await chamada(e, 'conversa.lia', 15_000), await chamada(e, 'conversa.lia', 15_000)];
    const explicacao = await chamada(e, 'resultados.explicar', 50_000);
    await chamada(e, 'atencao.explicar', 30_000);
    // A explicação retirada pelos números, também.
    const retirada = await chamada(e, 'resultados.explicar', 25_000);
    await chamada(e, 'revisao.semanal', 20_000);
    await ownerQuery(`insert into liame.ai_feedback (id, tenant_id, usage_id, user_id, verdict) values ($1, $2, $3, $4, 'fez_sentido'), ($5, $2, $6, $4, 'discordo')`, [
      uuidv7(),
      e.tenantId,
      resposta,
      e.userId,
      uuidv7(),
      explicacao,
    ]);
    await ownerQuery(
      `insert into liame.demand (id, tenant_id, brand_id, kind, title, detail, assignee_agent, requested_by, opened_by_agent) values ($1, $2, $3, 'promocao', 'Promoção de sexta', 'Quero uma promoção.', 'estrategista', $4, 'lia')`,
      [uuidv7(), e.tenantId, e.brandId, e.userId],
    );
    // Duas recomendações da sombra no mês: uma comparável, na mesma direção da pessoa.
    for (const [dia, status, humana, agreement, label, regret] of [
      [hoje, 'aberta', null, null, null, null],
      [hoje, 'avaliada', 'reduziu_verba', 'mesma_direcao', 'teria_melhorado', -18_400_000],
    ] as const) {
      const campanha = randomUUID();
      await ownerQuery(
        `insert into liame.campaign (id, tenant_id, connected_account_id, provider, external_id, name, status) values ($1, $2, $3, 'meta_ads', $4, 'Outra', 'ativa')`,
        [campanha, e.tenantId, e.conta, campanha.slice(0, 8)],
      );
      await ownerQuery(
        `insert into liame.shadow_decision (id, tenant_id, brand_id, connected_account_id, campaign_id, provider, source, tool, rule_key, rule_version, params, confidence,
                                            state_snapshot, decided_on, window_from, window_to, evaluate_on, status, human_action, agreement, regret_label, action_regret_micros, evaluated_at)
         values ($1, $2, $3, $4, $5, 'meta_ads', 'regra', 'orcamento_reduzir', 'prejuizo', 1, '{"percent":20}', 0.8, '{}', $6, $7, $8, $9, $10, $11, $12, $13, $14,
                 case when $10 = 'avaliada' then now() end)`,
        [uuidv7(), e.tenantId, e.brandId, e.conta, campanha, dia, menosDias(dia, 7), menosDias(dia, 1), menosDias(dia, -7), status, humana, agreement, label, regret],
      );
    }

    // O que a conferência recusou no mês (D-A3-15): dois textos da LIA barrados pelo Compliance, uma resposta do Analista
    // retirada pelos números e três rótulos do Pesquisador barrados numa leitura só. De outra marca, nada entra.
    const outraMarca = (await api.call('POST', '/v1/brands', { cookie: e.cookie, body: { name: 'Segunda marca' } })).body.id as string;
    for (const [marca, member, workflow, kind, rules, items, uso] of [
      [e.brandId, 'lia', 'conversa.lia', 'compliance', '["promessa_de_resultado"]', 1, barradas[0]],
      [e.brandId, 'lia', 'conversa.lia', 'compliance', '["regra_da_marca"]', 1, barradas[1]],
      [e.brandId, 'analista', 'resultados.explicar', 'numero_fora', '[]', 1, retirada],
      [e.brandId, 'pesquisador', 'pesquisador.pagina', 'compliance', '["dado_pessoal"]', 3, null],
      [outraMarca, 'lia', 'conversa.lia', 'compliance', '["promessa_de_resultado"]', 5, null],
    ] as const) {
      await ownerQuery(`insert into liame.ai_refusal (id, tenant_id, brand_id, member, workflow, kind, rules, items, usage_id) values ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9)`, [
        uuidv7(),
        e.tenantId,
        marca,
        member,
        workflow,
        kind,
        rules,
        items,
        uso,
      ]);
    }

    const t = await ver(e, e.brandId);
    // O custo e as chamadas contam tudo o que foi ao modelo (6 da LIA: duas respostas, a rodada de leitura, a que falhou
    // e as duas barradas); as respostas são só as que chegaram à pessoa.
    expect(doMembro(t, 'lia').cost).toEqual({ usd_micros: '280000', calls: 6 });
    expect(numeros(t, 'lia')).toEqual({ respostas: '2', fez_sentido: '1', discordo: '0', demandas: '1', retiradas_na_conferencia: '2' });
    expect(doMembro(t, 'analista').cost).toEqual({ usd_micros: '105000', calls: 3 });
    expect(numeros(t, 'analista')).toEqual({ explicacoes: '2', fez_sentido: '0', discordo: '1', retiradas_na_conferencia: '1' });
    // O Compliance: conferidos = as respostas que chegaram à conferência (8: quatro da LIA, três do Analista e a da
    // revisão; a rodada de leitura e a tentativa que falhou não são texto para conferir); barrados = só o que uma regra
    // de texto barrou (2 + 3), e a recusa pelos números não entra aqui.
    expect(numeros(t, 'compliance')).toEqual({ textos_conferidos: '8', textos_barrados: '5' });
    expect(numeros(t, 'pesquisador')).toMatchObject({ retiradas_na_conferencia: '3' });
    expect(doMembro(t, 'relatorios').cost).toEqual({ usd_micros: '20000', calls: 1 });
    expect(numeros(t, 'estrategista')).toMatchObject({ em_preparo: '1' });
    expect(numeros(t, 'trafego')).toEqual({ recomendacoes: '2', comparaveis: '1', mesma_direcao: '1', arrependimento: '-18400000' });
    // O gasto da empresa no mês soma todas as chamadas; o teto vem da configuração.
    expect(t.ai.spent_usd_micros).toBe('405000');

    // Outra empresa não vê esta marca, e a marca dela não mostra o custo desta.
    const outra = await empresa();
    expect((await api.call('GET', `/v1/team?brand_id=${e.brandId}`, { cookie: outra.cookie })).status).toBe(404);
    expect(doMembro(await ver(outra, outra.brandId), 'lia').cost).toEqual({ usd_micros: '0', calls: 0 });
  });

  it('desligar e ligar um funcionário: ele deixa de trabalhar na marca; o Compliance não desliga; o histórico fica', async () => {
    const e = await empresa();
    await ligarIa(flags, e.tenantId);
    const ativo = () => withTenant(database.db, e.tenantId, (tx) => funcionarioAtivo(tx, { tenantId: e.tenantId, brandId: e.brandId, agentKey: 'lia', ativoPorPadrao: true }));
    expect(await ativo()).toBe(true);

    const r = await api.call('POST', '/v1/team/members/lia/pause', { cookie: e.cookie, body: { brand_id: e.brandId, reason: 'Vamos testar sem ela; dúvidas com fulano@exemplo.com' } });
    expect(r.status).toBe(200);
    const lia = doMembro(TeamResponse.parse(r.body), 'lia');
    expect(lia).toMatchObject({ status: 'desligado', paused: { by: { id: e.userId } } });
    expect(lia.paused!.reason).toContain('Vamos testar sem ela');
    expect(lia.paused!.reason).not.toContain('fulano@exemplo.com');
    expect(await ativo()).toBe(false);
    expect((await api.call('POST', '/v1/team/members/lia/pause', { cookie: e.cookie, body: { brand_id: e.brandId } })).body.code).toBe('ja-desligado');
    expect((await api.call('POST', '/v1/team/members/compliance/pause', { cookie: e.cookie, body: { brand_id: e.brandId } })).body.code).toBe('nao-desliga');
    expect((await api.call('POST', '/v1/team/members/criativo/pause', { cookie: e.cookie, body: { brand_id: e.brandId } })).status).toBe(400);

    const volta = await api.call('POST', '/v1/team/members/lia/resume', { cookie: e.cookie, body: { brand_id: e.brandId } });
    expect(volta.status).toBe(200);
    expect(doMembro(TeamResponse.parse(volta.body), 'lia')).toMatchObject({ status: 'ativo', paused: null });
    expect(await ativo()).toBe(true);
    expect((await api.call('POST', '/v1/team/members/lia/resume', { cookie: e.cookie, body: { brand_id: e.brandId } })).body.code).toBe('ja-ligado');
    const historico = await ownerQuery<{ agent_key: string; resumed_at: string | null; reason: string | null }>(`select agent_key, resumed_at, reason from liame.agent_pause where brand_id = $1`, [e.brandId]);
    expect(historico).toHaveLength(1);
    expect(historico[0]!.resumed_at).not.toBeNull();
    const audit = await ownerQuery<{ action: string }>(`select action from liame.audit_event where tenant_id = $1 and action like 'equipe.%' order by occurred_at`, [e.tenantId]);
    expect(audit.map((a) => a.action)).toEqual(['equipe.desligar_funcionario', 'equipe.ligar_funcionario']);
  });

  it('o Gestor de tráfego desligado na marca não roda a sombra; ligado de novo, volta', async () => {
    const e = await empresa();
    await ligarSombra(e.tenantId);
    const loop = new SombraLoop(database, flags, new SombraService(database, api.app.get(ResultsService)));
    expect((await api.call('POST', '/v1/team/members/trafego/pause', { cookie: e.cookie, body: { brand_id: e.brandId } })).status).toBe(200);
    expect(await loop.executarLote(10, { tenantIds: [e.tenantId] })).toEqual([{ brandId: e.brandId, tenantId: e.tenantId, status: 'desligada_pela_empresa' }]);
    expect((await api.call('POST', '/v1/team/members/trafego/resume', { cookie: e.cookie, body: { brand_id: e.brandId } })).status).toBe(200);
    // A vez da marca volta em até uma hora.
    await ownerQuery(`update liame.shadow_state set next_at = now() where brand_id = $1`, [e.brandId]);
    const depois = await loop.executarLote(10, { tenantIds: [e.tenantId] });
    expect(depois.map((v) => v.status)).not.toContain('desligada_pela_empresa');
  });

  it('quem vê e quem desliga: o gestor vê e desliga; o aprovador não desliga', async () => {
    const e = await empresa();
    const gestor = await membro(e, 'gestor');
    expect((await ver(gestor, e.brandId)).can_manage).toBe(true);
    expect((await api.call('POST', '/v1/team/members/pesquisador/pause', { cookie: gestor.cookie, body: { brand_id: e.brandId } })).status).toBe(200);
    const aprovador = await membro(e, 'aprovador');
    expect((await api.call('POST', '/v1/team/members/pesquisador/resume', { cookie: aprovador.cookie, body: { brand_id: e.brandId } })).status).toBe(403);
    expect(doMembro(await ver(e, e.brandId), 'pesquisador').status).toBe('desligado');
  });
});
