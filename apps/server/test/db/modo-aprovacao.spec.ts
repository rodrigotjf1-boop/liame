import { resolve } from 'node:path';
import { ClosedLoopAttentionResponse } from '@liame/contracts';
import { type Database, runMigrations, withTenant } from '@liame/database';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ActionService } from '../../src/actions/action.service.js';
import { BudgetService } from '../../src/actions/budget.service.js';
import { naTransacaoDaEmpresa } from '../../src/ai/na-empresa.js';
import { pessoaPode } from '../../src/auth/pessoa-pode.js';
import { currentStep, totpCode } from '../../src/auth/totp.js';
import { DATABASE } from '../../src/database/database.module.js';
import { FlagService } from '../../src/flags/flag.service.js';
import { KillSwitchService } from '../../src/kill-switch/kill-switch.service.js';
import { diaNoFuso, menosDias } from '../../src/results/fora-do-normal.js';
import { ActionExecutor } from '../../src/worker/action-executor.js';
import { PedidosDoGestor } from '../../src/worker/pedidos-do-gestor.js';
import { ownerQuery, resetIpRateLimits, signupAndLogin, startApi, type TestApi } from '../helpers/api.js';
import {
  type AcaoRecomendada,
  campanhaComRecomendacao,
  type EmpresaComMeta,
  empresaComMeta,
  ligarConectorNaMetaDeMentira,
  ligarEscritaNaMeta,
  MetaDeMentira,
} from '../helpers/meta-de-mentira.js';
import { hasDb, OWNER_URL } from './env.js';

// A4 · X3 (parte 2): o modo Aprovação do Gestor de tráfego, contra a Graph API local. Na rodada da manhã, a recomendação
// nova de uma ação que está em Aprovação naquela conta vira um pedido feito por ele, pelo mesmo trilho do pedido de uma
// pessoa; o pedido espera a aprovação de alguém com o código do app. O que não deu para pedir fica na recomendação, com
// o motivo, e ele não tenta de novo sozinho. Tudo atrás da flag `modo_aprovacao`, que nasce desligada.

const REAL = 1_000_000;
const hoje = diaNoFuso(new Date(), 'America/Sao_Paulo');

describe.skipIf(!hasDb)('modo Aprovação: o pedido feito pelo Gestor de tráfego (A4 · X3)', () => {
  let api: TestApi;
  let database: Database;
  let executor: ActionExecutor;
  let pedidos: PedidosDoGestor;
  let actions: ActionService;
  const meta = new MetaDeMentira();
  /** A empresa do piloto: escrita na Meta ligada, teto por ação de R$ 150,00 e envelope do mês de R$ 500,00. */
  let e: EmpresaComMeta;

  type Resposta = Awaited<ReturnType<TestApi['call']>>;
  const politica = (emp: EmpresaComMeta, rules: unknown[], brandId: string | null = null) => api.call('POST', '/v1/policies', { cookie: emp.cookie, body: { brand_id: brandId, document: { rules } } });
  /** O modo do Gestor de tráfego nesta conta, por ação: a regra que a promoção publica na política da marca. */
  const modos = async (emp: EmpresaComMeta, cada: Partial<Record<'orcamento.reduzir' | 'orcamento.aumentar' | 'campanha.pausar', string>>): Promise<void> => {
    const rules = Object.entries(cada).map(([action, mode]) => ({ type: 'autonomy', action, actor: 'agent', account: emp.conta, mode }));
    expect((await politica(emp, rules, emp.brandId)).status).toBe(201);
  };
  async function ligarModoAprovacao(tenantId: string, valor: boolean): Promise<void> {
    await ownerQuery(`delete from liame.feature_flag_rule where flag_key = 'modo_aprovacao' and scope_type = 'tenant' and scope_id = $1`, [tenantId]);
    if (valor) {
      await ownerQuery(
        `insert into liame.feature_flag_rule (id, flag_key, scope_type, scope_id, value, rollout_percent, created_by)
         values (gen_random_uuid(), 'modo_aprovacao', 'tenant', $1, 'true'::jsonb, null, 'testes')`,
        [tenantId],
      );
    }
    api.app.get(FlagService).invalidate();
  }
  const campanha = (tool: AcaoRecomendada, opcoes: { nome?: string; dia?: string } = {}) => campanhaComRecomendacao(meta, e, tool, { dia: opcoes.dia ?? hoje, ...(opcoes.nome ? { nome: opcoes.nome } : {}) });
  const rodada = (emp: EmpresaComMeta = e) => pedidos.pedirAsDeHoje({ tenantId: emp.tenantId, brandId: emp.brandId, hoje });
  const tentativa = async (recomendacao: string) =>
    (
      await ownerQuery<{ tentou: boolean; request_error: string | null; request_error_detail: string | null }>(
        `select request_attempted_at is not null as tentou, request_error, request_error_detail from liame.shadow_decision where id = $1`,
        [recomendacao],
      )
    )[0]!;
  const pedidosDa = (recomendacao: string) =>
    ownerQuery<{ id: string; status: string; mode: string; actor_type: string; agent_key: string | null; requested_by: string; plan_hash: string }>(
      `select id, status, mode, actor_type, agent_key, requested_by, plan_hash from liame.action_request where shadow_decision_id = $1 order by created_at, id`,
      [recomendacao],
    );
  const ver = async (id: string) => (await api.call('GET', `/v1/actions/${id}`, { cookie: e.cookie })).body;
  const ciclo = () => executor.runCycle(20, { tenantIds: [e.tenantId] });
  async function aprovar(pedido: { id: string; plan_hash: string }): Promise<Resposta> {
    await ownerQuery(`update liame.app_user set totp_last_step = null where id = $1`, [e.userId]);
    await ownerQuery(`delete from liame.rate_limit where key = $1`, [`segundo-fator:${e.userId}`]);
    return api.call('POST', `/v1/actions/${pedido.id}/approve`, { cookie: e.cookie, body: { plan_hash: pedido.plan_hash, code: totpCode(e.secret, currentStep()) } });
  }
  /** A recomendação desta campanha como a Atenção a entrega a quem está na tela. */
  const naAtencao = async (campanhaId: string) => {
    const r = await api.call('GET', `/v1/results/attention?brand_id=${e.brandId}`, { cookie: e.cookie });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    return ClosedLoopAttentionResponse.parse(r.body).items.find((i) => i.kind.startsWith('sugestao_') && i.campaign_id === campanhaId)?.recommendation;
  };
  const trilha = async (pedido: string) =>
    (
      await ownerQuery<{ action: string; actor_type: string; actor_label: string | null; origin: string }>(
        `select action, actor_type, actor_label, origin from liame.audit_event where chain_key = $1 and resource_id = $2 order by chain_seq`,
        [e.tenantId, pedido],
      )
    ).map((t) => [t.action, t.actor_type, t.actor_label, t.origin]);
  const TODAS_EM_APROVACAO = { 'orcamento.reduzir': 'APPROVAL', 'orcamento.aumentar': 'APPROVAL', 'campanha.pausar': 'APPROVAL' } as const;

  beforeAll(async () => {
    await runMigrations({ connectionString: OWNER_URL, dir: resolve(process.cwd(), '../../packages/database/migrations') });
    await meta.ligar();
    api = await startApi();
    await resetIpRateLimits();
    database = api.app.get(DATABASE);
    actions = api.app.get(ActionService);
    executor = new ActionExecutor(database, api.app.get(BudgetService), api.app.get(KillSwitchService), api.app.get(FlagService));
    pedidos = new PedidosDoGestor(database, actions, api.app.get(FlagService));
    ligarConectorNaMetaDeMentira(api, meta);

    e = await empresaComMeta(api, meta, 'Mister Burgers Modo Aprovação');
    await ligarEscritaNaMeta(api, e.tenantId, true);
    expect((await politica(e, [{ type: 'max_value', action: 'orcamento.*', provider: 'meta_ads', max_micros: 150 * REAL }])).status).toBe(201);
    expect((await api.call('PUT', '/v1/budget/policies', { cookie: e.cookie, body: { limit_micros: 500 * REAL } })).status).toBe(204);
    // Cadastro, app autenticador, cofre e política: com a suíte inteira rodando junto, passa do prazo padrão dos ganchos.
  }, 120_000);
  beforeEach(async () => {
    meta.normalizar();
    await resetIpRateLimits();
  });
  afterAll(async () => {
    if (e) {
      await ligarModoAprovacao(e.tenantId, false);
      await ligarEscritaNaMeta(api, e.tenantId, false);
    }
    await api?.close();
    await meta.desligar();
  });

  it('com a flag desligada ou a ação em Sugerir, ele não pede; em Aprovação, a recomendação de hoje vira um pedido dele, que espera uma pessoa', async () => {
    const r = await campanha('orcamento_reduzir');
    const semTentativa = { tentou: false, request_error: null, request_error_detail: null };

    // A regra de Aprovação existe, mas a flag `modo_aprovacao` está desligada (como nasce): nada acontece.
    await modos(e, { 'orcamento.reduzir': 'APPROVAL' });
    expect(await rodada()).toEqual({ pedidos: 0, semPedido: 0 });
    expect(await tentativa(r.recomendacao)).toEqual(semTentativa);
    // Flag ligada e a ação em Sugerir: quem pede é a pessoa. Ele não pede, e não gasta a tentativa.
    await ligarModoAprovacao(e.tenantId, true);
    await modos(e, { 'orcamento.reduzir': 'SUGGEST' });
    expect(await rodada()).toEqual({ pedidos: 0, semPedido: 0 });
    expect([await tentativa(r.recomendacao), await pedidosDa(r.recomendacao)]).toEqual([semTentativa, []]);

    // Em Aprovação: o pedido nasce pelo trilho de sempre, lido na Meta, e fica esperando.
    await modos(e, { 'orcamento.reduzir': 'APPROVAL' });
    meta.chamadas.length = 0;
    expect(await rodada()).toEqual({ pedidos: 1, semPedido: 0 });
    const [p] = await pedidosDa(r.recomendacao);
    // Quem pediu foi o funcionário; quem responde por ele é a pessoa que publicou a regra do modo.
    expect(p).toMatchObject({ status: 'aguardando_aprovacao', mode: 'APPROVAL', actor_type: 'agent', agent_key: 'trafego', requested_by: e.userId });
    expect(await tentativa(r.recomendacao)).toEqual({ tentou: true, request_error: null, request_error_detail: null });
    expect(meta.resumo(r.id)).toEqual(['ler']);
    expect(await ver(p!.id)).toMatchObject({
      tool: 'orcamento_ajustar',
      action: 'orcamento.reduzir',
      resource_id: r.recurso,
      value_micros: 27 * REAL,
      current_value_micros: 30 * REAL,
      reserved_micros: 0,
      mode: 'APPROVAL',
      status: 'aguardando_aprovacao',
      agent_key: 'trafego',
      requested_by: { id: e.userId },
      recommendation: { id: r.recomendacao, tool: 'orcamento_reduzir', percent: 10 },
      policy: { allowed: true, mode: 'APPROVAL', violations: [] },
    });
    expect(await trilha(p!.id)).toEqual([['acao.pedir', 'agent', 'Gestor de tráfego', 'worker']]);
    // O pedido de uma pessoa segue sem funcionário.
    const dela = await api.call('POST', '/v1/actions', { cookie: e.cookie, body: { tool: 'campanha_pausar', provider: 'meta_ads', account_id: e.conta, resource_id: r.recurso, params: {} } });
    expect([dela.status, dela.body.agent_key]).toEqual([201, null]);
    await api.call('POST', `/v1/actions/${dela.body.id}/cancel`, { cookie: e.cookie });

    // Uma tentativa por recomendação: a rodada seguinte não pede de novo.
    expect(await rodada()).toEqual({ pedidos: 0, semPedido: 0 });
    expect(await pedidosDa(r.recomendacao)).toHaveLength(1);
    // Na Atenção, a sugestão mostra o pedido que ele fez (e nenhum motivo de não ter pedido).
    expect(await naAtencao(r.campanha)).toMatchObject({ id: r.recomendacao, action: { id: p!.id, status: 'aguardando_aprovacao' } });
    expect('not_requested' in (await naAtencao(r.campanha))!).toBe(false);

    // Sem a aprovação de uma pessoa, nada muda na Meta. Com ela (e o código do app), o Liame valida, escreve e confere.
    await ciclo();
    expect(meta.escritasDe(r.id)).toEqual([]);
    expect((await aprovar(p!)).body).toMatchObject({ status: 'aprovada', approvals: [{ approver_role: 'dono', sufficient: true }] });
    await ciclo();
    expect(await ver(p!.id)).toMatchObject({ status: 'executada', agent_key: 'trafego' });
    expect(meta.objetos.get(r.id)!.daily_budget).toBe('2700');
    expect(await trilha(p!.id)).toEqual([
      ['acao.pedir', 'agent', 'Gestor de tráfego', 'worker'],
      ['acao.aprovar', 'human', expect.any(String), 'api'],
      ['acao.executar', 'system', 'Liame (execução)', 'worker'],
    ]);
  });

  it('o que não deu para pedir fica na recomendação, com o motivo, e ele não tenta de novo sozinho', async () => {
    await ligarModoAprovacao(e.tenantId, true);
    await modos(e, TODAS_EM_APROVACAO);
    /** Uma rodada em que nenhum pedido entra; devolve o que ficou na recomendação. */
    const semPedido = async (recomendacao: string) => {
      expect(await rodada()).toEqual({ pedidos: 0, semPedido: 1 });
      expect(await pedidosDa(recomendacao)).toEqual([]);
      const t = await tentativa(recomendacao);
      expect(t.tentou).toBe(true);
      return [t.request_error, t.request_error_detail];
    };

    // (1) A Meta não respondeu: fica o motivo. Na rodada seguinte ele não lê a Meta de novo.
    const fora = await campanha('orcamento_reduzir', { nome: 'Almoço executivo' });
    meta.falhasDaLeitura = [{ status: 500, corpo: meta.erro(2, 'Service temporarily unavailable') }];
    meta.chamadas.length = 0;
    const indisponivel = 'A Meta não respondeu agora, ou pediu para esperar. Nada foi pedido: tente de novo em alguns minutos.';
    expect(await semPedido(fora.recomendacao)).toEqual(['plataforma-indisponivel', indisponivel]);
    expect(await rodada()).toEqual({ pedidos: 0, semPedido: 0 });
    expect(meta.resumo(fora.id)).toEqual(['ler']);
    // A Atenção mostra o motivo, e a pessoa ainda pode pedir por ali (o corpo do pedido segue na sugestão).
    const aviso = await naAtencao(fora.campanha);
    expect(aviso).toMatchObject({ id: fora.recomendacao, action: null, request: { tool: 'orcamento_ajustar', resource_id: fora.recurso }, not_requested: { code: 'plataforma-indisponivel', detail: indisponivel } });
    expect(Number.isNaN(Date.parse(aviso!.not_requested!.at))).toBe(false);

    // (2) Já existe um pedido igual, feito por uma pessoa.
    const igual = await campanha('campanha_pausar', { nome: 'Madrugada' });
    const dela = await api.call('POST', '/v1/actions', { cookie: e.cookie, body: { tool: 'campanha_pausar', provider: 'meta_ads', account_id: e.conta, resource_id: igual.recurso, params: {} } });
    expect(dela.status).toBe(201);
    expect(await semPedido(igual.recomendacao)).toEqual(['acao-duplicada', 'Já há um pedido ativo desta ferramenta para este recurso. Aprove, altere ou cancele o que existe.']);
    await api.call('POST', `/v1/actions/${dela.body.id}/cancel`, { cookie: e.cookie });

    // (3) O limite da empresa: aumentar 10% de uma verba de R$ 200,00 passa do teto de R$ 150,00 por ação. O motivo leva a regra.
    const teto = await campanha('orcamento_aumentar', { nome: 'Combo família' });
    await ownerQuery(`update liame.campaign set daily_budget_micros = 200000000 where id = $1`, [teto.campanha]);
    meta.objetos.get(teto.id)!.daily_budget = '20000';
    const [codigo, motivo] = await semPedido(teto.recomendacao);
    expect(codigo).toBe('politica-negou');
    expect(motivo).toMatch(/^Esta ação fere uma regra da política da empresa ou da plataforma\. O valor R\$\s220,00 passa do teto de R\$\s150,00 por ação\.$/);

    // (4) A equipe está parada (a trava da empresa): nada é lido na Meta.
    const parada = await campanha('orcamento_reduzir', { nome: 'Jantar de sexta' });
    const trava = await api.call('POST', '/v1/kill-switches', { cookie: e.cookie, body: { level: 'tenant', reason: 'pausa de segurança' } });
    expect(trava.status).toBe(201);
    try {
      expect(await semPedido(parada.recomendacao)).toEqual(['parada-acionada', 'Há uma trava ativa (nível tenant): pausa de segurança']);
    } finally {
      await api.call('DELETE', `/v1/kill-switches/${trava.body.id}`, { cookie: e.cookie });
    }
    expect(meta.chamadasDe(parada.id)).toEqual([]);

    // (5) A escrita na Meta foi desligada para a empresa.
    const desligada = await campanha('orcamento_reduzir', { nome: 'Happy hour' });
    await ligarEscritaNaMeta(api, e.tenantId, false);
    try {
      expect((await semPedido(desligada.recomendacao))[0]).toBe('escrita-desligada');
    } finally {
      await ligarEscritaNaMeta(api, e.tenantId, true);
    }

    // (6) A campanha não tem verba diária própria (a verba fica no conjunto): não há o que pedir por aqui.
    const semVerba = await campanha('orcamento_reduzir', { nome: 'Sobremesas' });
    await ownerQuery(`update liame.campaign set daily_budget_micros = null where id = $1`, [semVerba.campanha]);
    expect((await semPedido(semVerba.recomendacao))[0]).toBe('sem-pedido-possivel');
    expect(meta.chamadasDe(semVerba.id)).toEqual([]);

    // (7) Quem liberou o modo não está mais na empresa (ou não pode mais pedir ações): o funcionário não pede em nome de ninguém.
    const orfa = await campanha('orcamento_reduzir', { nome: 'Domingo' });
    const deFora = await signupAndLogin(api, undefined, 'Empresa Vizinha');
    await ownerQuery(`update liame.policy set created_by = $2 where tenant_id = $1 and brand_id = $3 and status = 'ativa'`, [e.tenantId, deFora.me.user.id, e.brandId]);
    try {
      const [semDono, porque] = await semPedido(orfa.recomendacao);
      expect([semDono, porque]).toEqual([
        'sem-responsavel',
        'Quem liberou o modo Aprovação não está mais na empresa, ou não pode mais pedir ações. Alguém com permissão precisa liberar o modo de novo.',
      ]);
    } finally {
      await ownerQuery(`update liame.policy set created_by = $2 where tenant_id = $1 and brand_id = $3 and status = 'ativa'`, [e.tenantId, e.userId, e.brandId]);
    }
    expect(meta.chamadasDe(orfa.id)).toEqual([]);
    // Em nenhum dos casos a Meta recebeu escrita.
    for (const c of [fora, igual, teto, parada, desligada, semVerba, orfa]) expect(meta.escritasDe(c.id)).toEqual([]);
  });

  it('ele só pede a recomendação de hoje, em aberto, sem ação da pessoa e sem pedido; e o Action Service confere o modo de novo', async () => {
    await ligarModoAprovacao(e.tenantId, true);
    await modos(e, TODAS_EM_APROVACAO);

    // De ontem (os números já têm um dia), com a ação da pessoa já vista, ou com um pedido que uma pessoa já fez: não pede.
    const deOntem = await campanha('orcamento_reduzir', { nome: 'Ontem', dia: menosDias(hoje, 1) });
    const jaMexeu = await campanha('orcamento_reduzir', { nome: 'Já mexeu' });
    await ownerQuery(`update liame.shadow_decision set human_action = 'reduziu_verba', human_action_on = $2, agreement = 'igual' where id = $1`, [jaMexeu.recomendacao, hoje]);
    const jaPedida = await campanha('campanha_pausar', { nome: 'Já pedida' });
    const dela = await api.call('POST', '/v1/actions', {
      cookie: e.cookie,
      body: { tool: 'campanha_pausar', provider: 'meta_ads', account_id: e.conta, resource_id: jaPedida.recurso, params: {}, recommendation_id: jaPedida.recomendacao },
    });
    expect(dela.status, JSON.stringify(dela.body)).toBe(201);
    expect(await rodada()).toEqual({ pedidos: 0, semPedido: 0 });
    for (const c of [deOntem, jaMexeu, jaPedida]) expect((await tentativa(c.recomendacao)).tentou).toBe(false);
    expect((await pedidosDa(jaPedida.recomendacao)).map((p) => [p.actor_type, p.agent_key])).toEqual([['human', null]]);
    await api.call('POST', `/v1/actions/${dela.body.id}/cancel`, { cookie: e.cookie });

    // Chamado direto com a ação em Sugerir (ou em Sombra), o Action Service recusa: a regra não depende de quem chama.
    const r = await campanha('orcamento_aumentar', { nome: 'Direto' });
    const direto = () =>
      naTransacaoDaEmpresa(database, { tenantId: e.tenantId, userId: null }, () =>
        actions.pedirPeloFuncionario(
          { tenantId: e.tenantId, agentKey: 'trafego', agentLabel: 'Gestor de tráfego', emNomeDe: e.userId },
          { tool: 'orcamento_ajustar', provider: 'meta_ads', account_id: e.conta, resource_id: r.recurso, params: { daily_budget_micros: 33 * REAL }, recommendation_id: r.recomendacao },
        ),
      );
    await modos(e, { 'orcamento.aumentar': 'SUGGEST' });
    await expect(direto()).rejects.toMatchObject({ code: 'modo-nao-e-aprovacao' });
    await modos(e, {});
    await expect(direto()).rejects.toMatchObject({ code: 'modo-nao-e-aprovacao' });
    expect(await pedidosDa(r.recomendacao)).toEqual([]);
    // Em Aprovação, o mesmo pedido entra, com a reserva de quem aumenta a verba (um dia da diferença).
    await modos(e, { 'orcamento.aumentar': 'APPROVAL' });
    const id = await direto();
    expect(await ver(id)).toMatchObject({ action: 'orcamento.aumentar', status: 'aguardando_aprovacao', reserved_micros: 3 * REAL, agent_key: 'trafego' });
    await api.call('POST', `/v1/actions/${id}/cancel`, { cookie: e.cookie });
    // E a flag do modo também é conferida ali: desligada para a empresa, o funcionário não pede, nem em Aprovação.
    await ligarModoAprovacao(e.tenantId, false);
    await expect(direto()).rejects.toMatchObject({ code: 'modo-aprovacao-desligado' });
    expect(await pedidosDa(r.recomendacao)).toHaveLength(1);
  });

  it('em nome de quem: a pessoa precisa estar na empresa, com o vínculo ativo e podendo pedir ações', async () => {
    const pode = (userId: string, permissao = 'campanhas.operar') => withTenant(database.db, e.tenantId, (tx) => pessoaPode(tx, { tenantId: e.tenantId, userId, permissao }));
    expect(await pode(e.userId)).toBe(true);
    expect(await pode(e.userId, 'permissao.que.nao.existe')).toBe(false);
    // Quem é de outra empresa não pode nesta.
    const deFora = await signupAndLogin(api, undefined, 'Outra Empresa Qualquer');
    expect(await pode(deFora.me.user.id as string)).toBe(false);
    // A empresa tirou "operar campanhas" do papel: o conjunto próprio substitui o padrão inteiro.
    await ownerQuery(`insert into liame.role_permission (tenant_id, role_key, permission) select $1, 'dono', p from unnest(array['empresa.ver', 'marcas.ver', 'campanhas.ver']) as p`, [e.tenantId]);
    try {
      expect(await pode(e.userId)).toBe(false);
      expect(await pode(e.userId, 'campanhas.ver')).toBe(true);
    } finally {
      await ownerQuery(`delete from liame.role_permission where tenant_id = $1`, [e.tenantId]);
    }
    // Vínculo revogado ou conta desativada: não pode.
    await ownerQuery(`update liame.membership set revoked_at = now() where tenant_id = $1 and user_id = $2`, [e.tenantId, e.userId]);
    try {
      expect(await pode(e.userId)).toBe(false);
    } finally {
      await ownerQuery(`update liame.membership set revoked_at = null where tenant_id = $1 and user_id = $2`, [e.tenantId, e.userId]);
    }
    await ownerQuery(`update liame.app_user set disabled_at = now() where id = $1`, [e.userId]);
    try {
      expect(await pode(e.userId)).toBe(false);
    } finally {
      await ownerQuery(`update liame.app_user set disabled_at = null where id = $1`, [e.userId]);
    }
    expect(await pode(e.userId)).toBe(true);
  });
});
