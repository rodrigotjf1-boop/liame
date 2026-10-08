import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { AutonomyItem, AutonomyResponse, ClosedLoopAttentionResponse } from '@liame/contracts';
import { createDatabase, type Database, runMigrations, uuidv7, withSystem, withTenant } from '@liame/database';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ActionService } from '../../src/actions/action.service.js';
import { naTransacaoDaEmpresa } from '../../src/ai/na-empresa.js';
import { FlagService } from '../../src/flags/flag.service.js';
import { AtencaoCicloService } from '../../src/results/atencao-ciclo.service.js';
import { diaNoFuso, menosDias } from '../../src/results/fora-do-normal.js';
import { proporPromocoes } from '../../src/worker/autonomia-propostas.js';
import { PedidosDoGestor } from '../../src/worker/pedidos-do-gestor.js';
import { enableMfa, ownerQuery, PASSWORD, resetIpRateLimits, signupAndLogin, startApi, TERMOS, type TestApi, tokenFrom, uniqueEmail } from '../helpers/api.js';
import { ligarEscritaNaMeta } from '../helpers/meta-de-mentira.js';
import { type PedidoSemeado, semearPedidos } from '../helpers/pedidos-semeados.js';
import { APP_URL, hasDb, OWNER_URL } from './env.js';

// A3 · I13: a promoção de autonomia. O sistema propõe (de Sombra para Sugerir) quando os cinco portões passam; uma
// pessoa aprova, recusa ou volta para Sombra, e cada decisão publica a versão seguinte da política da marca. Em
// Sugerir, a recomendação da sombra aparece na Atenção; nada é executado em plataforma nenhuma.

const FUSO = 'America/Sao_Paulo';
const hoje = diaNoFuso(new Date(), FUSO);

describe.skipIf(!hasDb)('promoção de autonomia: proposta, decisão, política e Atenção (A3, I13)', () => {
  let api: TestApi;
  let database: Database;

  type Empresa = { cookie: string; tenantId: string; brandId: string; conta: string; campanha: string };

  /** Empresa com uma conta da Meta e a campanha "Delivery noite" (verba diária de R$ 30). */
  async function empresa(): Promise<Empresa> {
    await resetIpRateLimits();
    const s = await signupAndLogin(api, undefined, 'Hamburgueria da Autonomia');
    await enableMfa(api, s.cookie);
    const tenantId = s.me.active_organization_id as string;
    const brandId = (await api.call('GET', '/v1/brands', { cookie: s.cookie })).body.items[0].id as string;
    const [conta, campanha] = [randomUUID(), randomUUID()];
    await ownerQuery(
      `insert into liame.connected_account (id, tenant_id, brand_id, provider, external_id, name, currency, timezone) values ($1, $2, $3, 'meta_ads', $4, 'CA - Hamburgueria', 'BRL', $5)`,
      [conta, tenantId, brandId, `act_${randomUUID().slice(0, 8)}`, FUSO],
    );
    await ownerQuery(
      `insert into liame.campaign (id, tenant_id, connected_account_id, provider, external_id, name, status, daily_budget_micros) values ($1, $2, $3, 'meta_ads', 'c1', 'Delivery noite', 'ativa', 30000000)`,
      [campanha, tenantId, conta],
    );
    return { cookie: s.cookie, tenantId, brandId, conta, campanha };
  }

  /** Outra pessoa na mesma empresa, com o nível dado. */
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

  /** O retrato da prontidão do dia, como a sombra grava (em escopo de sistema). */
  async function retrato(e: Empresa, dia: string, sinais: { tool?: string; amostra: number; falta?: string[] }): Promise<void> {
    await ownerQuery(
      `insert into liame.readiness_snapshot (id, tenant_id, brand_id, connected_account_id, tool, computed_on, rule_version, sample_size,
                                             agreement_rate, worse_rate, regret_sum_micros, confidence_avg, missing)
       values ($1, $2, $3, $4, $5, $6, 1, $7, 0.86, 0.05, -41200000, 0.760, $8)`,
      [uuidv7(), e.tenantId, e.brandId, e.conta, sinais.tool ?? 'orcamento_reduzir', dia, sinais.amostra, sinais.falta ?? []],
    );
  }

  /** Uma recomendação em aberto da sombra, de hoje, com os números do retrato. */
  async function recomendacao(e: Empresa): Promise<void> {
    const retratoDoEstado = {
      campanha: { nome: 'Delivery noite', situacao: 'ativa', verba_diaria_micros: '30000000' },
      janela: { de: menosDias(hoje, 7), ate: menosDias(hoje, 1), fuso: FUSO },
      plataforma: { spend_micros: '150000000' },
      caixa: { orders: 2, revenue_micros: '120000000', margin_known_micros: '90000000', margin_coverage_pct: '100.0', verdict: 'prejuizo' },
    };
    await ownerQuery(
      `insert into liame.shadow_decision (id, tenant_id, brand_id, connected_account_id, campaign_id, provider, source, tool, rule_key, rule_version, params,
                                          confidence, state_snapshot, decided_on, window_from, window_to, evaluate_on, status)
       values ($1, $2, $3, $4, $5, 'meta_ads', 'regra', 'orcamento_reduzir', 'prejuizo', 1, '{"percent":20}', 0.9, $6, $7, $8, $9, $10, 'aberta')`,
      [uuidv7(), e.tenantId, e.brandId, e.conta, e.campanha, JSON.stringify(retratoDoEstado), hoje, menosDias(hoje, 7), menosDias(hoje, 1), menosDias(hoje, -7)],
    );
  }

  const propor = (e: Empresa, dia: string) => withSystem(database.db, (tx) => proporPromocoes(tx, { tenantId: e.tenantId, brandId: e.brandId, hoje: dia }));
  const ver = async (e: { cookie: string }, brandId: string) => {
    const r = await api.call('GET', `/v1/autonomy?brand_id=${brandId}`, { cookie: e.cookie });
    expect(r.status).toBe(200);
    return AutonomyResponse.parse(r.body);
  };
  const reduzir = async (e: Empresa) => (await ver(e, e.brandId)).items.find((i) => i.tool === 'orcamento_reduzir')!;
  const sugestoes = async (e: Empresa) => {
    const r = await api.call('GET', `/v1/results/attention?brand_id=${e.brandId}`, { cookie: e.cookie });
    expect(r.status).toBe(200);
    return ClosedLoopAttentionResponse.parse(r.body).items.filter((i) => i.kind.startsWith('sugestao_'));
  };
  const politicas = (e: Empresa) =>
    ownerQuery<{ version: number; status: string; document: { rules: Array<Record<string, unknown>> } }>(
      `select version, status, document from liame.policy where tenant_id = $1 and brand_id = $2 order by version`,
      [e.tenantId, e.brandId],
    );
  const auditoria = (e: Empresa, acao: string) =>
    ownerQuery<{ actor_type: string; after: Record<string, unknown> | null }>(`select actor_type, after from liame.audit_event where tenant_id = $1 and action = $2 order by occurred_at`, [e.tenantId, acao]);

  beforeAll(async () => {
    await runMigrations({ connectionString: OWNER_URL, dir: resolve(process.cwd(), '../../packages/database/migrations') });
    api = await startApi();
    await resetIpRateLimits();
    database = createDatabase({ connectionString: APP_URL, max: 3, applicationName: 'liame-test' });
  });
  afterAll(async () => {
    await database?.close();
    await api?.close();
  });

  it('o sistema propõe quando os cinco portões passam, uma vez só; a empresa só lê (A3-11)', async () => {
    const e = await empresa();
    await recomendacao(e);
    await retrato(e, '2026-09-22', { amostra: 31 });
    await retrato(e, '2026-09-22', { tool: 'campanha_pausar', amostra: 9, falta: ['amostra', 'concordancia'] });
    expect(await propor(e, '2026-09-22')).toEqual({ propostas: 1, retiradas: 0, encerradas: 0 });
    expect(await propor(e, '2026-09-22')).toEqual({ propostas: 0, retiradas: 0, encerradas: 0 });

    const v = await ver(e, e.brandId);
    expect(v.thresholds).toEqual({
      sample_size: 30,
      agreement_min_pct: 80,
      worse_max_pct: 10,
      regret_max_micros: '0',
      confidence_min_pct: 70,
      sample_after_rejection: 30,
      approval_requests: 10,
      approval_min_approved: 8,
      requests_after_rejection: 10,
    });
    expect(v.can_decide).toBe(true);
    // A pendente primeiro; a outra ação, com sombra registrada, depois.
    expect(v.items.map((i) => [i.tool, i.mode, i.proposal?.status ?? null])).toEqual([
      ['orcamento_reduzir', 'SHADOW', 'pendente'],
      ['campanha_pausar', 'SHADOW', null],
    ]);
    expect(v.items[0]).toMatchObject({
      account_name: 'CA - Hamburgueria',
      action: 'orcamento.reduzir',
      mode_source: { policy: 'padrao', version: null },
      readiness: { computed_on: '2026-09-22', sample_size: 31, agreement_pct: '86.0', worse_pct: '5.0', regret_sum_micros: '-41200000', confidence_avg_pct: '76.0', missing: [] },
      proposal: { from_mode: 'SHADOW', to_mode: 'SUGGEST', sample_size: 31, decided_by: null, policy_version: null },
    });
    expect(v.items[1]!.readiness?.missing).toEqual(['amostra', 'concordancia']);
    expect((await auditoria(e, 'autonomia.propor')).map((a) => [a.actor_type, a.after?.tool])).toEqual([['system', 'orcamento_reduzir']]);

    // A empresa não inventa proposta, e outra empresa não vê esta marca.
    await expect(
      withTenant(database.db, e.tenantId, (tx) =>
        tx.execute(sql`insert into liame.autonomy_proposal (id, tenant_id, brand_id, connected_account_id, tool, action, from_mode, to_mode, readiness_snapshot_id, rule_version, sample_size, signals, status)
                       select ${uuidv7()}, tenant_id, brand_id, connected_account_id, tool, action, from_mode, to_mode, readiness_snapshot_id, rule_version, sample_size, signals, 'pendente'
                         from liame.autonomy_proposal limit 1`),
      ),
    ).rejects.toThrow();
    const outra = await empresa();
    expect((await api.call('GET', `/v1/autonomy?brand_id=${e.brandId}`, { cookie: outra.cookie })).status).toBe(404);
  });

  it('aprovar publica a política da marca com Sugerir e a recomendação aparece na Atenção; voltar para Sombra desfaz', async () => {
    const e = await empresa();
    await recomendacao(e);
    await retrato(e, '2026-09-22', { amostra: 31 });
    await propor(e, '2026-09-22');
    expect(await sugestoes(e)).toEqual([]);
    const proposta = (await reduzir(e)).proposal!;

    const ok = await api.call('POST', `/v1/autonomy/proposals/${proposta.id}/approve`, { cookie: e.cookie });
    expect(ok.status).toBe(200);
    const item = AutonomyItem.parse(ok.body);
    expect(item).toMatchObject({ mode: 'SUGGEST', mode_source: { policy: 'marca', version: 1 }, proposal: { status: 'aprovada', policy_version: 1, decided_by: { name: expect.any(String) } } });
    expect(await politicas(e)).toEqual([
      // A regra é do funcionário de IA (`actor: 'agent'`): não muda o que uma pessoa pede pelo Liame (A4, X2).
      { version: 1, status: 'ativa', document: { rules: [{ type: 'autonomy', action: 'orcamento.reduzir', actor: 'agent', account: e.conta, mode: 'SUGGEST' }] } },
    ]);
    expect((await auditoria(e, 'autonomia.promover')).map((a) => a.after)).toEqual([
      { mode: 'SUGGEST', connected_account_id: e.conta, tool: 'orcamento_reduzir', action: 'orcamento.reduzir', policy_version: 1, sample_size: 31 },
    ]);
    // Em Sugerir, a recomendação aparece na Atenção, com os números do retrato; nada foi executado.
    const [aviso] = await sugestoes(e);
    expect(aviso).toMatchObject({
      kind: 'sugestao_reduzir_verba',
      severity: 'atencao',
      title: 'Sugestão do Gestor de tráfego: reduzir a verba da campanha "Delivery noite" em 20%',
      action: 'Se concordar, reduza a verba na Meta. Nada muda sem você.',
      campaign_id: e.campanha,
      brand_id: e.brandId,
    });
    // A sugestão leva a recomendação por trás dela (A4, X3). Sem a escrita na Meta ligada para a empresa, não há pedido
    // a fazer pelo Liame: quem muda é a pessoa, na plataforma.
    expect(aviso!.recommendation).toEqual({ id: expect.any(String), campaign_name: 'Delivery noite', request: null, action: null });
    expect((await ownerQuery<{ daily_budget_micros: string }>(`select daily_budget_micros::text from liame.campaign where id = $1`, [e.campanha]))[0]!.daily_budget_micros).toBe('30000000');
    expect((await api.call('POST', `/v1/autonomy/proposals/${proposta.id}/approve`, { cookie: e.cookie })).body.code).toBe('proposta-decidida');

    const volta = await api.call('POST', '/v1/autonomy/undo', { cookie: e.cookie, body: { connected_account_id: e.conta, tool: 'orcamento_reduzir' } });
    expect(volta.status).toBe(200);
    expect(AutonomyItem.parse(volta.body)).toMatchObject({ mode: 'SHADOW', mode_source: { policy: 'marca', version: 2 }, proposal: { status: 'desfeita', policy_version: 1, next_sample_size: 61 } });
    expect((await politicas(e)).map((p) => [p.version, p.status, p.document.rules])).toEqual([
      [1, 'arquivada', [{ type: 'autonomy', action: 'orcamento.reduzir', actor: 'agent', account: e.conta, mode: 'SUGGEST' }]],
      [2, 'ativa', [{ type: 'autonomy', action: 'orcamento.reduzir', actor: 'agent', account: e.conta, mode: 'SHADOW' }]],
    ]);
    expect(await sugestoes(e)).toEqual([]);
    expect((await api.call('POST', '/v1/autonomy/undo', { cookie: e.cookie, body: { connected_account_id: e.conta, tool: 'orcamento_reduzir' } })).body.code).toBe('ja-em-sombra');
    expect((await auditoria(e, 'autonomia.voltar_sombra')).map((a) => a.after)).toEqual([
      { mode: 'SHADOW', connected_account_id: e.conta, tool: 'orcamento_reduzir', action: 'orcamento.reduzir', policy_version: 2 },
    ]);
    // Depois de desfeita, o sistema só propõe de novo com 61 decisões comparáveis.
    await retrato(e, '2026-09-29', { amostra: 45 });
    expect(await propor(e, '2026-09-29')).toMatchObject({ propostas: 0 });
    await retrato(e, '2026-10-06', { amostra: 61 });
    expect(await propor(e, '2026-10-06')).toMatchObject({ propostas: 1 });
  });

  it('recusar: segue em Sombra, o motivo perde o dado pessoal e a próxima proposta espera mais 30 decisões; a que deixa de valer sai', async () => {
    const e = await empresa();
    await recomendacao(e);
    await retrato(e, '2026-09-22', { amostra: 31 });
    await propor(e, '2026-09-22');
    const proposta = (await reduzir(e)).proposal!;
    const r = await api.call('POST', `/v1/autonomy/proposals/${proposta.id}/reject`, { cookie: e.cookie, body: { reason: 'Prefiro esperar o fim do mês; falar com fulano@exemplo.com' } });
    expect(r.status).toBe(200);
    const item = AutonomyItem.parse(r.body);
    expect(item).toMatchObject({ mode: 'SHADOW', proposal: { status: 'recusada', next_sample_size: 61, decided_by: { name: expect.any(String) } } });
    expect(item.proposal!.reason).toContain('Prefiro esperar o fim do mês');
    expect(item.proposal!.reason).not.toContain('fulano@exemplo.com');
    expect(await politicas(e)).toEqual([]);
    expect(await sugestoes(e)).toEqual([]);

    await retrato(e, '2026-09-29', { amostra: 40 });
    expect(await propor(e, '2026-09-29')).toMatchObject({ propostas: 0 });
    await retrato(e, '2026-10-06', { amostra: 61 });
    expect(await propor(e, '2026-10-06')).toMatchObject({ propostas: 1 });
    // No retrato seguinte a concordância caiu: a pendente sai, com o motivo.
    await retrato(e, '2026-10-13', { amostra: 64, falta: ['concordancia'] });
    expect(await propor(e, '2026-10-13')).toEqual({ propostas: 0, retiradas: 1, encerradas: 0 });
    expect((await reduzir(e)).proposal).toMatchObject({ status: 'retirada', reason: 'Os portões da prontidão deixaram de passar.' });
    expect(await auditoria(e, 'autonomia.retirar')).toHaveLength(1);
  });

  it('o modo que muda por outro caminho: a pendente aparece retirada na hora, e a aprovada se encerra na rotina', async () => {
    const e = await empresa();
    await recomendacao(e);
    await retrato(e, '2026-09-22', { amostra: 31 });
    await propor(e, '2026-09-22');
    const proposta = (await reduzir(e)).proposal!;
    // Uma regra larga da empresa põe todas as ações de verba em Sugerir.
    expect((await api.call('POST', '/v1/policies', { cookie: e.cookie, body: { brand_id: null, document: { rules: [{ type: 'autonomy', action: 'orcamento.*', mode: 'SUGGEST' }] } } })).status).toBe(201);
    expect(await reduzir(e)).toMatchObject({ mode: 'SUGGEST', mode_source: { policy: 'empresa', version: 1 }, proposal: { status: 'retirada', reason: 'O modo da ação mudou por outro caminho.' } });
    expect((await api.call('POST', `/v1/autonomy/proposals/${proposta.id}/approve`, { cookie: e.cookie })).body.code).toBe('modo-mudou');
    // Com o modo acima de Sombra, a recomendação aparece na Atenção mesmo sem promoção.
    expect((await sugestoes(e)).map((s) => s.kind)).toEqual(['sugestao_reduzir_verba']);

    // Outra marca do zero: aprovada, e depois a política da marca é publicada sem a regra (pela tela de políticas).
    const f = await empresa();
    await retrato(f, '2026-09-22', { amostra: 31 });
    await propor(f, '2026-09-22');
    const p2 = (await reduzir(f)).proposal!;
    expect((await api.call('POST', `/v1/autonomy/proposals/${p2.id}/approve`, { cookie: f.cookie })).status).toBe(200);
    expect((await api.call('POST', '/v1/policies', { cookie: f.cookie, body: { brand_id: f.brandId, document: { rules: [] } } })).status).toBe(201);
    await retrato(f, '2026-09-29', { amostra: 35 });
    expect(await propor(f, '2026-09-29')).toEqual({ propostas: 0, retiradas: 0, encerradas: 1 });
    expect((await reduzir(f)).proposal).toMatchObject({ status: 'desfeita', reason: 'A política da marca voltou a ação para Sombra por outro caminho.', next_sample_size: 65, undone_by: null });
  });

  it('uma regra mais específica da política mantém o modo: a aprovação não vale e nada muda', async () => {
    const e = await empresa();
    await retrato(e, '2026-09-22', { amostra: 31 });
    // A marca já tem uma regra para a ação na conta com mais um seletor (o risco), em Sombra.
    expect(
      (
        await api.call('POST', '/v1/policies', {
          cookie: e.cookie,
          body: { brand_id: e.brandId, document: { rules: [{ type: 'autonomy', action: 'orcamento.reduzir', account: e.conta, risk: 'R3', mode: 'SHADOW' }] } },
        })
      ).status,
    ).toBe(201);
    await propor(e, '2026-09-22');
    const proposta = (await reduzir(e)).proposal!;
    expect(proposta.status).toBe('pendente');
    const r = await api.call('POST', `/v1/autonomy/proposals/${proposta.id}/approve`, { cookie: e.cookie });
    expect([r.status, r.body.code]).toEqual([409, 'politica-mais-especifica']);
    // A transação inteira volta: a política segue na versão 1 e a proposta, pendente.
    expect((await politicas(e)).map((p) => [p.version, p.status])).toEqual([[1, 'ativa']]);
    expect((await reduzir(e)).proposal?.status).toBe('pendente');
  });

  it('A4 · X3: em Sugerir, a Atenção diz como pedir a mudança a quem opera campanhas, com a escrita ligada; quem só lê vê a sugestão sem o pedido', async () => {
    const e = await empresa();
    // A campanha como a leitura da Meta a guarda: com o id dela na plataforma (é ele que vira o recurso do pedido).
    const naMeta = `12021${String(Date.now()).slice(-10)}`;
    await ownerQuery(`update liame.campaign set external_id = $2 where id = $1`, [e.campanha, naMeta]);
    await recomendacao(e);
    expect((await api.call('POST', '/v1/policies', { cookie: e.cookie, body: { brand_id: null, document: { rules: [{ type: 'autonomy', action: 'orcamento.*', actor: 'agent', mode: 'SUGGEST' }] } } })).status).toBe(201);
    const leitor = await membro(e, 'somente_leitura');
    const recomendacaoDe = async (quem: { cookie: string }) => {
      const r = await api.call('GET', `/v1/results/attention?brand_id=${e.brandId}`, { cookie: quem.cookie });
      expect(r.status).toBe(200);
      return ClosedLoopAttentionResponse.parse(r.body).items.find((i) => i.kind === 'sugestao_reduzir_verba')!.recommendation;
    };
    const [decisao] = await ownerQuery<{ id: string }>(`select id from liame.shadow_decision where tenant_id = $1`, [e.tenantId]);

    // A escrita na Meta nasce desligada: a sugestão vem com a recomendação, sem o pedido.
    expect(await recomendacaoDe(e)).toEqual({ id: decisao!.id, campaign_name: 'Delivery noite', request: null, action: null });
    await ligarEscritaNaMeta(api, e.tenantId, true);
    try {
      // Ligada para a empresa: o corpo do pedido, com a verba de agora menos os 20% desta recomendação.
      expect(await recomendacaoDe(e)).toEqual({
        id: decisao!.id,
        campaign_name: 'Delivery noite',
        request: { tool: 'orcamento_ajustar', provider: 'meta_ads', account_id: e.conta, resource_id: `campanha:${naMeta}`, params: { daily_budget_micros: 24_000_000 } },
        action: null,
      });
      // Quem só lê não pede ação: recebe a recomendação, e mais nada.
      expect(await recomendacaoDe(leitor)).toEqual({ id: decisao!.id, campaign_name: 'Delivery noite', request: null, action: null });
    } finally {
      await ligarEscritaNaMeta(api, e.tenantId, false);
    }
    // A leitura que não é a da tela (a revisão da semana, a IA) não leva a recomendação: só o texto do aviso.
    const semLeitor = await naTransacaoDaEmpresa(database, { tenantId: e.tenantId, userId: null }, () => api.app.get(AtencaoCicloService).atencao(e.brandId));
    const doGestor = semLeitor.items.filter((i) => i.kind === 'sugestao_reduzir_verba');
    expect(doGestor.map((i) => [i.campaign_id, 'recommendation' in i])).toEqual([[e.campanha, false]]);
  });

  // ------------------------------------------------------------ de Sugerir para Aprovação (A4, X3)

  const dez = (situacao: PedidoSemeado): PedidoSemeado[] => Array.from({ length: 10 }, () => situacao);
  const vezDaAprovacao = (e: Empresa) => new PedidosDoGestor(database, api.app.get(ActionService), api.app.get(FlagService)).proporAprovacao({ tenantId: e.tenantId, brandId: e.brandId });
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
  /** A empresa com a ação "reduzir a verba" já em Sugerir (a promoção do primeiro passo aprovada), e para quem semear pedidos. */
  async function emSugerir(): Promise<{ e: Empresa; alvo: Parameters<typeof semearPedidos>[0] }> {
    const e = await empresa();
    await recomendacao(e);
    await retrato(e, '2026-09-22', { amostra: 31 });
    await propor(e, '2026-09-22');
    expect((await api.call('POST', `/v1/autonomy/proposals/${(await reduzir(e)).proposal!.id}/approve`, { cookie: e.cookie })).status).toBe(200);
    const [dono] = await ownerQuery<{ user_id: string }>(`select user_id from liame.membership where tenant_id = $1 and role_key = 'dono'`, [e.tenantId]);
    const [decisao] = await ownerQuery<{ id: string }>(`select id from liame.shadow_decision where tenant_id = $1`, [e.tenantId]);
    return { e, alvo: { tenantId: e.tenantId, brandId: e.brandId, conta: e.conta, userId: dono!.user_id, recomendacao: decisao!.id } };
  }
  const naTabela = (e: Empresa) => ownerQuery<{ to_mode: string; status: string }>(`select to_mode, status from liame.autonomy_proposal where tenant_id = $1 order by created_at, id`, [e.tenantId]);
  const aprovarProposta = async (e: Empresa) => api.call('POST', `/v1/autonomy/proposals/${(await reduzir(e)).proposal!.id}/approve`, { cookie: e.cookie });
  const voltar = (e: Empresa, reason?: string) => api.call('POST', '/v1/autonomy/undo', { cookie: e.cookie, body: { connected_account_id: e.conta, tool: 'orcamento_reduzir', ...(reason ? { reason } : {}) } });
  const NADA = { propostas: 0, retiradas: 0, encerradas: 0 };

  it('A4 · X3 (A4-6): de Sugerir para Aprovação só com os portões dos pedidos e uma pessoa aprovando; voltar é um passo por vez', async () => {
    const { e, alvo } = await emSugerir();
    try {
      // Dez pedidos aprovados e executados, nascidos de recomendações dele. Com a flag do modo desligada (como nasce),
      // a tela não fala em Aprovação e o sistema não propõe.
      await semearPedidos(alvo, dez('executada'), 100);
      expect('approval' in (await reduzir(e))).toBe(false);
      expect(await vezDaAprovacao(e)).toEqual(NADA);

      // Modo ligado para a empresa, mas a escrita na Meta não: o modo não existe nesta conta.
      await ligarModoAprovacao(e.tenantId, true);
      expect((await reduzir(e)).approval).toEqual({ sample_size: 10, approved: 10, failed: 0, missing: [], blocked_by: 'escrita_desligada' });
      expect(await vezDaAprovacao(e)).toEqual(NADA);
      await ligarEscritaNaMeta(api, e.tenantId, true);

      // Um aprovado mais recente terminou em erro: barra, mesmo com todos aprovados.
      await semearPedidos(alvo, ['falhou'], 50);
      expect((await reduzir(e)).approval).toEqual({ sample_size: 10, approved: 10, failed: 1, missing: ['erro'], blocked_by: null });
      expect(await vezDaAprovacao(e)).toEqual(NADA);
      // Mais dez pedidos decididos depois (oito aprovados, um recusado, um que ninguém decidiu): o erro sai dos dez mais
      // recentes, e oito em dez passa. O que ainda espera e o que foi retirado por quem pediu não entram na conta.
      await semearPedidos(alvo, [...dez('executada').slice(0, 8), 'recusada', 'expirada'], 20);
      await semearPedidos(alvo, ['aguardando', 'retirada'], 5);
      expect((await reduzir(e)).approval).toEqual({ sample_size: 10, approved: 8, failed: 0, missing: [], blocked_by: null });
      expect(await vezDaAprovacao(e)).toEqual({ propostas: 1, retiradas: 0, encerradas: 0 });
      expect(await vezDaAprovacao(e)).toEqual(NADA);

      const v = await ver(e, e.brandId);
      expect(v.thresholds).toMatchObject({ approval_requests: 10, approval_min_approved: 8, requests_after_rejection: 10 });
      expect(v.items[0]).toMatchObject({ tool: 'orcamento_reduzir', mode: 'SUGGEST', proposal: { status: 'pendente', from_mode: 'SUGGEST', to_mode: 'APPROVAL', sample_size: 31, next_request_count: null } });
      // A rotina do primeiro passo não mexe na proposta do segundo.
      expect(await propor(e, '2026-09-22')).toEqual(NADA);
      expect((await reduzir(e)).proposal?.status).toBe('pendente');
      expect((await auditoria(e, 'autonomia.propor')).map((a) => [a.actor_type, a.after?.to_mode ?? 'SUGGEST'])).toEqual([
        ['system', 'SUGGEST'],
        ['system', 'APPROVAL'],
      ]);

      // Uma pessoa aprova: a política da marca passa a dizer Aprovação para o funcionário, nesta conta e ação.
      const ok = await aprovarProposta(e);
      expect(ok.status, JSON.stringify(ok.body)).toBe(200);
      expect(AutonomyItem.parse(ok.body)).toMatchObject({
        mode: 'APPROVAL',
        mode_source: { policy: 'marca', version: 2 },
        proposal: { status: 'aprovada', from_mode: 'SUGGEST', to_mode: 'APPROVAL', policy_version: 2, decided_by: { name: expect.any(String) } },
      });
      expect((await politicas(e)).map((p) => [p.version, p.status, p.document.rules])).toEqual([
        [1, 'arquivada', [{ type: 'autonomy', action: 'orcamento.reduzir', actor: 'agent', account: e.conta, mode: 'SUGGEST' }]],
        [2, 'ativa', [{ type: 'autonomy', action: 'orcamento.reduzir', actor: 'agent', account: e.conta, mode: 'APPROVAL' }]],
      ]);
      expect((await auditoria(e, 'autonomia.promover')).map((a) => a.after)).toEqual([
        { mode: 'SUGGEST', connected_account_id: e.conta, tool: 'orcamento_reduzir', action: 'orcamento.reduzir', policy_version: 1, sample_size: 31 },
        { mode: 'APPROVAL', connected_account_id: e.conta, tool: 'orcamento_reduzir', action: 'orcamento.reduzir', policy_version: 2, sample_size: 31, requests: { sample_size: 10, approved: 8, failed: 0 } },
      ]);
      // A recomendação segue na Atenção (o pedido dele é outro passo, na rodada da manhã).
      expect((await sugestoes(e)).map((s) => s.kind)).toEqual(['sugestao_reduzir_verba']);

      // Voltar um passo: de Aprovação para Sugerir. A promoção para Sugerir segue aprovada, e a próxima proposta de
      // Aprovação pede mais dez pedidos decididos (são 21 até aqui).
      const volta = await voltar(e, 'Quero olhar cada pedido antes');
      expect(volta.status, JSON.stringify(volta.body)).toBe(200);
      expect(AutonomyItem.parse(volta.body)).toMatchObject({
        mode: 'SUGGEST',
        mode_source: { policy: 'marca', version: 3 },
        proposal: { status: 'desfeita', to_mode: 'APPROVAL', policy_version: 2, next_request_count: 31, reason: 'Quero olhar cada pedido antes', undone_by: { name: expect.any(String) } },
      });
      expect(await naTabela(e)).toEqual([
        { to_mode: 'SUGGEST', status: 'aprovada' },
        { to_mode: 'APPROVAL', status: 'desfeita' },
      ]);
      expect((await auditoria(e, 'autonomia.voltar_sombra')).map((a) => a.after)).toEqual([
        { mode: 'SUGGEST', connected_account_id: e.conta, tool: 'orcamento_reduzir', action: 'orcamento.reduzir', policy_version: 3 },
      ]);
      expect(await vezDaAprovacao(e)).toEqual(NADA);
      await semearPedidos(alvo, dez('executada'), 1);
      expect(await vezDaAprovacao(e)).toEqual({ propostas: 1, retiradas: 0, encerradas: 0 });

      // Recusar: segue em Sugerir, e a próxima proposta espera mais dez pedidos decididos (31 + 10).
      const nao = await api.call('POST', `/v1/autonomy/proposals/${(await reduzir(e)).proposal!.id}/reject`, { cookie: e.cookie, body: { reason: 'Ainda não' } });
      expect(AutonomyItem.parse(nao.body)).toMatchObject({ mode: 'SUGGEST', proposal: { status: 'recusada', to_mode: 'APPROVAL', next_request_count: 41, next_sample_size: null, reason: 'Ainda não' } });
      expect(await vezDaAprovacao(e)).toEqual(NADA);
      await semearPedidos(alvo, dez('executada'), 0);
      expect(await vezDaAprovacao(e)).toEqual({ propostas: 1, retiradas: 0, encerradas: 0 });

      // Voltar de Sugerir para Sombra com uma proposta de Aprovação esperando: ela sai na hora, e a tela volta a mostrar
      // a história do primeiro passo.
      const fim = await voltar(e);
      expect(AutonomyItem.parse(fim.body)).toMatchObject({ mode: 'SHADOW', mode_source: { policy: 'marca', version: 4 }, proposal: { status: 'desfeita', to_mode: 'SUGGEST', next_sample_size: 61 } });
      expect(await naTabela(e)).toEqual([
        { to_mode: 'SUGGEST', status: 'desfeita' },
        { to_mode: 'APPROVAL', status: 'desfeita' },
        { to_mode: 'APPROVAL', status: 'recusada' },
        { to_mode: 'APPROVAL', status: 'retirada' },
      ]);
      expect(await vezDaAprovacao(e)).toEqual(NADA);
      expect(await sugestoes(e)).toEqual([]);

      // Em "O que ele fez", cada passo sai com o tipo dele.
      const atividade = await api.call('GET', `/v1/team/members/trafego/activity?brand_id=${e.brandId}&limit=50`, { cookie: e.cookie });
      expect(atividade.status).toBe(200);
      expect([...new Set((atividade.body.items as Array<{ kind: string }>).map((i) => i.kind))].sort()).toEqual([
        'aprovacao_aprovada',
        'aprovacao_proposta',
        'aprovacao_recusada',
        'aprovacao_retirada',
        'promocao_aprovada',
        'promocao_proposta',
        'recomendou',
        'saiu_da_aprovacao',
        'voltou_para_sombra',
      ]);
    } finally {
      await ligarModoAprovacao(e.tenantId, false);
      await ligarEscritaNaMeta(api, e.tenantId, false);
    }
  });

  it('A4 · X3: a proposta de Aprovação que deixa de valer sai; a aprovada sem efeito se encerra; no Google o modo não existe', async () => {
    const { e, alvo } = await emSugerir();
    try {
      await ligarModoAprovacao(e.tenantId, true);
      await ligarEscritaNaMeta(api, e.tenantId, true);
      await semearPedidos(alvo, dez('executada'), 100);
      expect(await vezDaAprovacao(e)).toEqual({ propostas: 1, retiradas: 0, encerradas: 0 });

      // (1) A escrita na Meta foi desligada depois da proposta: ela aparece retirada na hora, não dá para aprovar, e a rotina grava.
      await ligarEscritaNaMeta(api, e.tenantId, false);
      expect(await reduzir(e)).toMatchObject({ proposal: { status: 'retirada', reason: 'O modo Aprovação deixou de estar disponível nesta conta.' }, approval: { blocked_by: 'escrita_desligada' } });
      const semEscrita = await aprovarProposta(e);
      expect([semEscrita.status, semEscrita.body.code]).toEqual([409, 'aprovacao-indisponivel']);
      expect(await vezDaAprovacao(e)).toEqual({ propostas: 0, retiradas: 1, encerradas: 0 });
      expect((await auditoria(e, 'autonomia.retirar')).map((a) => a.after?.reason)).toEqual(['O modo Aprovação deixou de estar disponível nesta conta.']);
      // Ligada de novo, o sistema propõe de novo (retirada não pede pedidos a mais).
      await ligarEscritaNaMeta(api, e.tenantId, true);
      expect(await vezDaAprovacao(e)).toEqual({ propostas: 1, retiradas: 0, encerradas: 0 });

      // (2) O modo Aprovação foi desligado para a empresa: a pendente aparece retirada, e aprovar é recusado.
      await ligarModoAprovacao(e.tenantId, false);
      const semModo = await reduzir(e);
      expect(['approval' in semModo, semModo.proposal?.status, semModo.proposal?.reason]).toEqual([false, 'retirada', 'O modo Aprovação deixou de estar disponível nesta conta.']);
      const desligado = await aprovarProposta(e);
      expect([desligado.status, desligado.body.code]).toEqual([409, 'modo-aprovacao-desligado']);
      expect(await vezDaAprovacao(e)).toEqual(NADA);
      await ligarModoAprovacao(e.tenantId, true);
      expect((await reduzir(e)).proposal?.status).toBe('pendente');

      // (3) Um pedido aprovado mais recente terminou em erro: os portões da Aprovação deixam de passar.
      const [comErro] = await semearPedidos(alvo, ['falhou'], 30);
      expect((await reduzir(e)).proposal).toMatchObject({ status: 'retirada', reason: 'Os portões da Aprovação deixaram de passar.' });
      const semPortoes = await aprovarProposta(e);
      expect([semPortoes.status, semPortoes.body.code]).toEqual([409, 'prontidao-mudou']);
      expect(await vezDaAprovacao(e)).toEqual({ propostas: 0, retiradas: 1, encerradas: 0 });
      // O erro era de uma falha passageira e o pedido acabou executado: os portões voltam a passar.
      await ownerQuery(`update liame.action_request set status = 'executada', status_reason = null where id = $1`, [comErro]);
      expect(await vezDaAprovacao(e)).toEqual({ propostas: 1, retiradas: 0, encerradas: 0 });

      // (4) Aprovada, e depois a política da marca é publicada sem a regra (pela tela de políticas): a ação volta para
      // Sombra por outro caminho, e as duas promoções se encerram, cada uma na rotina dela.
      expect((await aprovarProposta(e)).status).toBe(200);
      expect((await reduzir(e)).mode).toBe('APPROVAL');
      expect((await api.call('POST', '/v1/policies', { cookie: e.cookie, body: { brand_id: e.brandId, document: { rules: [] } } })).status).toBe(201);
      expect(await vezDaAprovacao(e)).toEqual({ propostas: 0, retiradas: 0, encerradas: 1 });
      await retrato(e, '2026-09-29', { amostra: 35 });
      expect(await propor(e, '2026-09-29')).toEqual({ propostas: 0, retiradas: 0, encerradas: 1 });
      const linhas = await ownerQuery<{ to_mode: string; status: string; reason: string | null; next_request_count: number | null }>(
        `select to_mode, status, reason, next_request_count from liame.autonomy_proposal where tenant_id = $1 and status = 'desfeita' order by to_mode`,
        [e.tenantId],
      );
      expect(linhas).toEqual([
        { to_mode: 'APPROVAL', status: 'desfeita', reason: 'A política da marca tirou a ação de Aprovação por outro caminho.', next_request_count: 21 },
        { to_mode: 'SUGGEST', status: 'desfeita', reason: 'A política da marca voltou a ação para Sombra por outro caminho.', next_request_count: null },
      ]);

      // (5) No Google, o Liame não muda anúncios: o modo vai até Sugerir.
      const google = randomUUID();
      await ownerQuery(
        `insert into liame.connected_account (id, tenant_id, brand_id, provider, external_id, name, currency, timezone) values ($1, $2, $3, 'google_ads', $4, 'Google Ads - Hamburgueria', 'BRL', $5)`,
        [google, e.tenantId, e.brandId, randomUUID().slice(0, 10), FUSO],
      );
      await ownerQuery(
        `insert into liame.readiness_snapshot (id, tenant_id, brand_id, connected_account_id, tool, computed_on, rule_version, sample_size,
                                               agreement_rate, worse_rate, regret_sum_micros, confidence_avg, missing)
         values ($1, $2, $3, $4, 'campanha_pausar', '2026-09-29', 2, 40, 0.90, 0.05, -1000000, 0.800, '{}')`,
        [uuidv7(), e.tenantId, e.brandId, google],
      );
      const doGoogle = (await ver(e, e.brandId)).items.find((i) => i.provider === 'google_ads')!;
      expect(doGoogle.approval).toEqual({ sample_size: 0, approved: 0, failed: 0, missing: ['pedidos', 'aprovacao'], blocked_by: 'plataforma_sem_escrita' });
    } finally {
      await ligarModoAprovacao(e.tenantId, false);
      await ligarEscritaNaMeta(api, e.tenantId, false);
    }
  });

  it('quem vê e quem decide: o gestor vê; só quem gerencia políticas aprova, recusa ou volta para Sombra', async () => {
    const e = await empresa();
    await retrato(e, '2026-09-22', { amostra: 31 });
    await propor(e, '2026-09-22');
    const proposta = (await reduzir(e)).proposal!;
    const gestor = await membro(e, 'gestor');
    const v = await ver(gestor, e.brandId);
    expect([v.can_decide, v.items.length]).toEqual([false, 1]);
    expect((await api.call('POST', `/v1/autonomy/proposals/${proposta.id}/approve`, { cookie: gestor.cookie })).status).toBe(403);
    expect((await api.call('POST', `/v1/autonomy/proposals/${proposta.id}/reject`, { cookie: gestor.cookie, body: {} })).status).toBe(403);
    expect((await api.call('POST', '/v1/autonomy/undo', { cookie: gestor.cookie, body: { connected_account_id: e.conta, tool: 'orcamento_reduzir' } })).status).toBe(403);
    expect((await reduzir(e)).proposal?.status).toBe('pendente');
  });
});
