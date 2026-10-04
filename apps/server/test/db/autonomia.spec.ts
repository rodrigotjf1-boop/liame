import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { AutonomyItem, AutonomyResponse, ClosedLoopAttentionResponse } from '@liame/contracts';
import { createDatabase, type Database, runMigrations, uuidv7, withSystem, withTenant } from '@liame/database';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { diaNoFuso, menosDias } from '../../src/results/fora-do-normal.js';
import { proporPromocoes } from '../../src/worker/autonomia-propostas.js';
import { enableMfa, ownerQuery, PASSWORD, resetIpRateLimits, signupAndLogin, startApi, TERMOS, type TestApi, tokenFrom, uniqueEmail } from '../helpers/api.js';
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
    expect(v.thresholds).toEqual({ sample_size: 30, agreement_min_pct: 80, worse_max_pct: 10, regret_max_micros: '0', confidence_min_pct: 70, sample_after_rejection: 30 });
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
