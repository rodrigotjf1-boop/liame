import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { TeamActivityResponse, TeamShadowResponse } from '@liame/contracts';
import { createDatabase, type Database, runMigrations, uuidv7, withContext } from '@liame/database';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { atividadeDoMembro } from '../../src/equipe/atividade.js';
import { diaNoFuso, menosDias } from '../../src/results/fora-do-normal.js';
import { enableMfa, ownerQuery, PASSWORD, resetIpRateLimits, signupAndLogin, startApi, TERMOS, type TestApi, tokenFrom, uniqueEmail } from '../helpers/api.js';
import { APP_URL, hasDb, OWNER_URL } from './env.js';

// A3 · Sua equipe (protótipo P7): "O que fez" de cada membro e a sombra do Gestor de tráfego, pela API. Tudo é lido do
// que já está guardado; o que é de uma pessoa (a conversa, quem perguntou à IA) só aparece para ela; o nome do plano,
// da demanda e do site lido segue a permissão da tela de origem; outra marca e outra empresa não entram.

const FUSO = 'America/Sao_Paulo';
const hoje = diaNoFuso(new Date(), FUSO);
/** "há N minutos", para o banco: a ordem dos acontecimentos nos testes. */
const ha = (minutos: number) => new Date(Date.now() - minutos * 60_000).toISOString();

describe.skipIf(!hasDb)('Sua equipe: o que cada um fez e a sombra do Gestor de tráfego (A3, P7)', () => {
  let api: TestApi;
  let database: Database;

  type Empresa = { cookie: string; tenantId: string; userId: string; brandId: string; conta: string; campanha: string };
  type Pessoa = { cookie: string; userId: string };

  async function empresa(): Promise<Empresa> {
    await resetIpRateLimits();
    const s = await signupAndLogin(api, undefined, 'Hamburgueria do Histórico');
    await enableMfa(api, s.cookie);
    const tenantId = s.me.active_organization_id as string;
    const brandId = (await api.call('GET', '/v1/brands', { cookie: s.cookie })).body.items[0].id as string;
    const [conta, campanha] = [randomUUID(), randomUUID()];
    await ownerQuery(
      `insert into liame.connected_account (id, tenant_id, brand_id, provider, external_id, name, currency, timezone) values ($1, $2, $3, 'meta_ads', $4, 'CA - Histórico', 'BRL', $5)`,
      [conta, tenantId, brandId, `act_${randomUUID().slice(0, 8)}`, FUSO],
    );
    await ownerQuery(
      `insert into liame.campaign (id, tenant_id, connected_account_id, provider, external_id, name, status, daily_budget_micros) values ($1, $2, $3, 'meta_ads', 'c1', 'Delivery noite', 'ativa', 30000000)`,
      [campanha, tenantId, conta],
    );
    return { cookie: s.cookie, tenantId, userId: s.me.user.id as string, brandId, conta, campanha };
  }

  async function membro(e: Empresa, role: string): Promise<Pessoa> {
    const email = uniqueEmail(role);
    const body: Record<string, unknown> = { email, role };
    if (['administrador', 'gestor', 'aprovador'].includes(role)) body.approve_limit_micros = 1_000_000;
    expect((await api.call('POST', '/v1/invitations', { cookie: e.cookie, body })).status).toBe(201);
    const s = await api.call('POST', '/v1/invitations/signup', { body: { token: tokenFrom(api.mailer, email), name: `Pessoa ${role}`, password: PASSWORD, terms_version: TERMOS } });
    if (!s.cookie) throw new Error(`convite não aceito: ${s.status} ${JSON.stringify(s.body)}`);
    await enableMfa(api, s.cookie);
    const eu = await api.call('GET', '/v1/me', { cookie: s.cookie });
    return { cookie: s.cookie, userId: eu.body.user.id as string };
  }

  /**
   * Uma chamada ao modelo, como o AI Gateway grava. `respondeu`: a chamada que entregou a resposta do pedido (a
   * atendida, se o teste não disser outra coisa); a rodada em que o modelo só pediu uma leitura não respondeu.
   */
  async function chamada(e: Empresa, o: { fluxo: string; quem: string | null; quando: string; outcome?: string; marca?: string; respondeu?: boolean }): Promise<string> {
    const id = uuidv7();
    const outcome = o.outcome ?? 'ok';
    const respondeu = o.respondeu ?? outcome === 'ok';
    await ownerQuery(
      `insert into liame.ai_usage (id, tenant_id, brand_id, user_id, workflow, task, provider, model, served_by, cost_usd_micros, outcome, occurred_at, tool_calls, answered)
       values ($1, $2, $3, $4, $5, 'teste', 'teste', 'modelo', 'principal', 1000, $6, $7, $8, $9)`,
      [id, e.tenantId, o.marca ?? e.brandId, o.quem, o.fluxo, outcome, o.quando, outcome === 'ok' && !respondeu ? 1 : 0, respondeu],
    );
    return id;
  }

  /** A conversa de uma pessoa com a resposta da LIA ligada à chamada. */
  async function conversa(e: Empresa, quem: string, titulo: string, usageId: string): Promise<void> {
    const id = uuidv7();
    await ownerQuery(`insert into liame.conversation (id, tenant_id, brand_id, user_id, title) values ($1, $2, $3, $4, $5)`, [id, e.tenantId, e.brandId, quem, titulo]);
    await ownerQuery(
      `insert into liame.conversation_message (id, tenant_id, conversation_id, user_id, role, content, usage_id) values ($1, $2, $3, $4, 'lia', '{}'::jsonb, $5)`,
      [uuidv7(), e.tenantId, id, quem, usageId],
    );
  }

  const atividade = async (quem: { cookie: string }, brandId: string, key: string, extra = '') => {
    const r = await api.call('GET', `/v1/team/members/${key}/activity?brand_id=${brandId}${extra}`, { cookie: quem.cookie });
    expect(r.status).toBe(200);
    return TeamActivityResponse.parse(r.body);
  };
  const tipos = (t: TeamActivityResponse) => t.items.map((i) => i.kind);

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

  it('LIA: cada pessoa vê a própria conversa pelo nome; a dos outros aparece sem o assunto e sem quem perguntou', async () => {
    const e = await empresa();
    const gestor = await membro(e, 'gestor');
    const minha = await chamada(e, { fluxo: 'conversa.lia', quem: e.userId, quando: ha(10) });
    await conversa(e, e.userId, 'Como foi a semana?', minha);
    const dele = await chamada(e, { fluxo: 'conversa.lia', quem: gestor.userId, quando: ha(20) });
    await conversa(e, gestor.userId, 'Quanto gastamos no Google?', dele);
    // A tentativa que falhou não é resposta; a de outra marca não entra.
    await chamada(e, { fluxo: 'conversa.lia', quem: e.userId, quando: ha(5), outcome: 'erro' });
    const outraMarca = (await api.call('POST', '/v1/brands', { cookie: e.cookie, body: { name: 'Segunda marca' } })).body.id as string;
    await chamada(e, { fluxo: 'conversa.lia', quem: e.userId, quando: ha(1), marca: outraMarca });
    // A rodada em que a LIA só leu os dados (antes de responder à pergunta do dono) é uma chamada, não uma resposta.
    await chamada(e, { fluxo: 'conversa.lia', quem: e.userId, quando: ha(11), respondeu: false });
    // A resposta que a conferência retirou não chegou à pessoa: aparece só como retirada.
    const barrada = await chamada(e, { fluxo: 'conversa.lia', quem: e.userId, quando: ha(41) });
    await ownerQuery(`insert into liame.ai_feedback (id, tenant_id, usage_id, user_id, verdict) values ($1, $2, $3, $4, 'fez_sentido')`, [uuidv7(), e.tenantId, minha, e.userId]);
    await ownerQuery(
      `insert into liame.demand (id, tenant_id, brand_id, kind, title, detail, assignee_agent, requested_by, opened_by_agent, created_at)
       values ($1, $2, $3, 'promocao', 'Promoção de sexta', 'Quero uma promoção.', 'estrategista', $4, 'lia', $5)`,
      [uuidv7(), e.tenantId, e.brandId, e.userId, ha(30)],
    );
    await ownerQuery(
      `insert into liame.ai_refusal (id, tenant_id, brand_id, usage_id, member, workflow, kind, rules, created_at)
       values ($1, $2, $3, $4, 'lia', 'conversa.lia', 'compliance', '["promessa_de_resultado"]'::jsonb, $5)`,
      [uuidv7(), e.tenantId, e.brandId, barrada, ha(40)],
    );

    const dono = await atividade(e, e.brandId, 'lia');
    expect(dono.member).toBe('lia');
    expect(tipos(dono)).toEqual(['respondeu', 'respondeu', 'abriu_demanda', 'retirada_na_conferencia']);
    expect(dono.items[0]).toMatchObject({ subject: 'Como foi a semana?', by: { id: e.userId }, mine: true, feedback: 'fez_sentido' });
    // A conversa do gestor: o dono sabe que a LIA respondeu, e mais nada.
    expect(dono.items[1]).toMatchObject({ subject: null, by: null, mine: false, feedback: null });
    expect(dono.items[2]).toMatchObject({ subject: 'Promoção de sexta', detail: 'promocao', by: { id: e.userId }, mine: true });
    expect(dono.items[3]).toMatchObject({ detail: 'compliance', rules: ['promessa_de_resultado'], count: 1, by: null });
    expect(JSON.stringify(dono)).not.toContain('Quanto gastamos');

    // O gestor vê o inverso: a conversa dele pelo nome, a do dono sem nada.
    const doGestor = await atividade(gestor, e.brandId, 'lia');
    expect(doGestor.items[0]).toMatchObject({ kind: 'respondeu', subject: null, by: null, mine: false });
    expect(doGestor.items[1]).toMatchObject({ kind: 'respondeu', subject: 'Quanto gastamos no Google?', by: { id: gestor.userId }, mine: true });
    expect(JSON.stringify(doGestor)).not.toContain('Como foi a semana');

    // O limite corta e diz que há mais.
    const curto = await atividade(e, e.brandId, 'lia', '&limit=2');
    expect(curto.items).toHaveLength(2);
    expect(curto.has_more).toBe(true);
    expect(dono.has_more).toBe(false);
  });

  it('Analista, Relatórios e Compliance: explicações com o retorno, a revisão com a semana e os textos barrados com a regra', async () => {
    const e = await empresa();
    const explicacao = await chamada(e, { fluxo: 'resultados.explicar', quem: e.userId, quando: ha(10) });
    await chamada(e, { fluxo: 'atencao.explicar', quem: e.userId, quando: ha(20) });
    await ownerQuery(`insert into liame.ai_feedback (id, tenant_id, usage_id, user_id, verdict, reasons) values ($1, $2, $3, $4, 'discordo', '{motivo}')`, [uuidv7(), e.tenantId, explicacao, e.userId]);
    // A explicação que a conferência retirou (o número fora) não aparece como explicação: só como retirada.
    const retirada = await chamada(e, { fluxo: 'resultados.explicar', quem: e.userId, quando: ha(26) });
    await ownerQuery(
      `insert into liame.ai_refusal (id, tenant_id, brand_id, usage_id, member, workflow, kind, created_at) values ($1, $2, $3, $4, 'analista', 'resultados.explicar', 'numero_fora', $5)`,
      [uuidv7(), e.tenantId, e.brandId, retirada, ha(25)],
    );
    await ownerQuery(
      `insert into liame.ai_refusal (id, tenant_id, brand_id, member, workflow, kind, rules, items, created_at) values ($1, $2, $3, 'pesquisador', 'pesquisador.pagina', 'compliance', '["dado_pessoal"]'::jsonb, 3, $4)`,
      [uuidv7(), e.tenantId, e.brandId, ha(35)],
    );

    const analista = await atividade(e, e.brandId, 'analista');
    expect(tipos(analista)).toEqual(['explicou_resultados', 'explicou_aviso', 'retirada_na_conferencia']);
    expect(analista.items[0]).toMatchObject({ feedback: 'discordo', mine: true });
    expect(analista.items[2]).toMatchObject({ detail: 'numero_fora', rules: [] });

    // A revisão da semana: gerada com a leitura da IA e enviada a três pessoas.
    const segunda = menosDias(hoje, ((new Date(`${hoje}T12:00:00Z`).getUTCDay() + 6) % 7) + 7);
    const leitura = await chamada(e, { fluxo: 'revisao.semanal', quem: null, quando: ha(60) });
    await ownerQuery(
      `insert into liame.weekly_review (id, tenant_id, brand_id, week_from, week_to, timezone, generated_at, reading_source, usage_id, content, content_version, email_status, email_sent_at, email_recipients)
       values ($1, $2, $3, $4::date, $4::date + 6, $5, $6, 'lia', $7, '{}'::jsonb, 1, 'enviado', $8, 3)`,
      [uuidv7(), e.tenantId, e.brandId, segunda, FUSO, ha(60), leitura, ha(50)],
    );
    const relatorios = await atividade(e, e.brandId, 'relatorios');
    expect(tipos(relatorios)).toEqual(['enviou_revisao', 'gerou_revisao']);
    expect(relatorios.items[0]).toMatchObject({ count: 3, period: { from: segunda, to: menosDias(segunda, -6) } });
    expect(relatorios.items[1]).toMatchObject({ detail: 'lia', period: { from: segunda }, by: null });

    // O Compliance mostra o que uma regra de texto barrou, de qualquer funcionário; a recusa pelos números não é dele.
    const compliance = await atividade(e, e.brandId, 'compliance');
    expect(tipos(compliance)).toEqual(['barrou_texto']);
    expect(compliance.items[0]).toMatchObject({ detail: 'pesquisador', rules: ['dado_pessoal'], count: 3 });
  });

  it('Estrategista e Pesquisador: a demanda, o plano e a decisão; a página lida, a recusada e a que falhou', async () => {
    const e = await empresa();
    const demanda = uuidv7();
    await ownerQuery(
      `insert into liame.demand (id, tenant_id, brand_id, kind, title, detail, assignee_agent, requested_by, opened_by_agent, created_at)
       values ($1, $2, $3, 'promocao', 'Promoção de sexta', 'Quero uma promoção.', 'estrategista', $4, 'lia', $5)`,
      [demanda, e.tenantId, e.brandId, e.userId, ha(90)],
    );
    const plano = uuidv7();
    await ownerQuery(
      `insert into liame.plan (id, tenant_id, brand_id, kind, title, status, version, demand_id, requested_by, expires_at, created_at)
       values ($1, $2, $3, 'oferta', 'Smash em dobro na sexta', 'aprovado', 1, $4, $5, now() + interval '7 days', $6)`,
      [plano, e.tenantId, e.brandId, demanda, e.userId, ha(80)],
    );
    await ownerQuery(
      `insert into liame.plan_version (id, tenant_id, plan_id, version, content, risk, content_hash, author, created_at) values ($1, $2, $3, 1, '{}'::jsonb, 'baixo', $4, 'estrategista', $5)`,
      [uuidv7(), e.tenantId, plano, 'a'.repeat(64), ha(80)],
    );
    await ownerQuery(`insert into liame.plan_decision (id, tenant_id, plan_id, version, content_hash, decision, decided_by, created_at) values ($1, $2, $3, 1, $4, 'aprovado', $5, $6)`, [
      uuidv7(),
      e.tenantId,
      plano,
      'a'.repeat(64),
      e.userId,
      ha(70),
    ]);

    const estrategista = await atividade(e, e.brandId, 'estrategista');
    expect(tipos(estrategista)).toEqual(['plano_aprovado', 'montou_plano', 'recebeu_demanda']);
    expect(estrategista.items[0]).toMatchObject({ subject: 'Smash em dobro na sexta', detail: 'oferta', by: { id: e.userId }, mine: true });
    expect(estrategista.items[1]).toMatchObject({ subject: 'Smash em dobro na sexta', count: 1, by: null });
    expect(estrategista.items[2]).toMatchObject({ subject: 'Promoção de sexta', detail: 'promocao' });

    for (const [url, host, status, motivo, secoes, quando] of [
      ['https://exemplo.com.br/cardapio', 'exemplo.com.br', 'concluida', null, '{produtos,ofertas}', ha(40)],
      ['https://concorrente.example/', 'concorrente.example', 'recusada', 'robots', '{}', ha(30)],
      ['https://fora.example/', 'fora.example', 'falhou', 'fora_do_ar', '{}', ha(20)],
      // Na fila: ainda não é acontecimento.
      ['https://fila.example/', 'fila.example', 'pendente', null, '{}', null],
    ] as const) {
      await ownerQuery(
        `insert into liame.research_request (id, tenant_id, brand_id, kind, url, host, status, reason, sections, requested_by, finished_at)
         values ($1, $2, $3, 'concorrente', $4, $5, $6, $7, $8::text[], $9, $10)`,
        [uuidv7(), e.tenantId, e.brandId, url, host, status, motivo, secoes, e.userId, quando],
      );
    }
    const pesquisador = await atividade(e, e.brandId, 'pesquisador');
    expect(tipos(pesquisador)).toEqual(['pagina_falhou', 'pagina_recusada', 'leu_pagina']);
    expect(pesquisador.items[0]).toMatchObject({ subject: 'fora.example', detail: 'fora_do_ar', count: null });
    expect(pesquisador.items[1]).toMatchObject({ subject: 'concorrente.example', detail: 'robots' });
    expect(pesquisador.items[2]).toMatchObject({ subject: 'exemplo.com.br', detail: 'concorrente', count: 2, by: { id: e.userId } });

    // Sem a permissão da tela de origem, o acontecimento aparece sem o nome (aqui, direto na função: os níveis de
    // hoje que veem Sua equipe também veem os planos e o dossiê).
    const olhar = (membroDaEquipe: 'estrategista' | 'pesquisador', quem: string) =>
      withContext(database.db, { tenantId: e.tenantId, userId: quem }, (tx) =>
        atividadeDoMembro(tx, membroDaEquipe, { tenantId: e.tenantId, brandId: e.brandId, userId: quem, desde: ha(60 * 24), podePlanos: false, podeDossie: false }, 20),
      );
    const outraPessoa = await membro(e, 'somente_leitura');
    const semPlanos = await olhar('estrategista', outraPessoa.userId);
    expect(semPlanos.items.map((i) => i.subject)).toEqual([null, null, null]);
    // Quem pediu a demanda vê o título dela mesmo sem ver os planos.
    expect((await olhar('estrategista', e.userId)).items.map((i) => i.subject)).toEqual([null, null, 'Promoção de sexta']);
    expect((await olhar('pesquisador', outraPessoa.userId)).items.map((i) => i.subject)).toEqual([null, null, null]);
  });

  it('Gestor de tráfego: as recomendações, a comparação, a promoção e a volta para sombra; a lista da sombra com a vez da rotina', async () => {
    const e = await empresa();
    const outra = randomUUID();
    await ownerQuery(`insert into liame.campaign (id, tenant_id, connected_account_id, provider, external_id, name, status) values ($1, $2, $3, 'meta_ads', 'c2', 'Smash em dobro', 'ativa')`, [
      outra,
      e.tenantId,
      e.conta,
    ]);
    const antes = menosDias(hoje, 9);
    const [aberta, avaliada] = [uuidv7(), uuidv7()];
    await ownerQuery(
      `insert into liame.shadow_decision (id, tenant_id, brand_id, connected_account_id, campaign_id, provider, source, tool, rule_key, rule_version, params, confidence,
                                          state_snapshot, decided_on, window_from, window_to, evaluate_on, status, created_at)
       values ($1, $2, $3, $4, $5, 'meta_ads', 'regra', 'orcamento_reduzir', 'prejuizo', 1, '{"percent":20}', 0.76, '{}', $6, $7, $8, $9, 'aberta', $10)`,
      [aberta, e.tenantId, e.brandId, e.conta, e.campanha, hoje, menosDias(hoje, 7), menosDias(hoje, 1), menosDias(hoje, -7), ha(30)],
    );
    await ownerQuery(
      `insert into liame.shadow_decision (id, tenant_id, brand_id, connected_account_id, campaign_id, provider, source, tool, rule_key, rule_version, params, confidence,
                                          state_snapshot, decided_on, window_from, window_to, evaluate_on, status, human_action, human_action_on, agreement, regret_label,
                                          action_regret_micros, evaluated_at, created_at)
       values ($1, $2, $3, $4, $5, 'meta_ads', 'regra', 'campanha_pausar', 'sem_pedido', 1, '{}', 0.812, '{}', $6, $7, $8, $9, 'avaliada', 'reduziu_verba', $6, 'mesma_direcao',
               'teria_melhorado', -18400000, $10, $11)`,
      [avaliada, e.tenantId, e.brandId, e.conta, outra, antes, menosDias(antes, 7), menosDias(antes, 1), menosDias(antes, -7), ha(40), ha(60 * 24 * 9)],
    );
    await ownerQuery(`insert into liame.shadow_state (brand_id, tenant_id, last_run_on, last_status, last_attempt_at) values ($1, $2, $3, 'feito', $4)`, [e.brandId, e.tenantId, hoje, ha(30)]);
    const retrato = uuidv7();
    await ownerQuery(
      `insert into liame.readiness_snapshot (id, tenant_id, brand_id, connected_account_id, tool, computed_on, rule_version, sample_size) values ($1, $2, $3, $4, 'orcamento_reduzir', $5, 1, 31)`,
      [retrato, e.tenantId, e.brandId, e.conta, hoje],
    );
    await ownerQuery(
      `insert into liame.autonomy_proposal (id, tenant_id, brand_id, connected_account_id, tool, action, from_mode, to_mode, readiness_snapshot_id, rule_version, sample_size, signals,
                                            status, decided_by, decided_at, policy_version, undone_by, undone_at, undone_policy_version, created_at)
       values ($1, $2, $3, $4, 'orcamento_reduzir', 'orcamento.reduzir', 'SHADOW', 'SUGGEST', $5, 1, 31, '{}'::jsonb, 'desfeita', $6, $7, 2, $6, $8, 3, $9)`,
      [uuidv7(), e.tenantId, e.brandId, e.conta, retrato, e.userId, ha(15), ha(5), ha(20)],
    );

    const trafego = await atividade(e, e.brandId, 'trafego');
    expect(tipos(trafego)).toEqual(['voltou_para_sombra', 'promocao_aprovada', 'promocao_proposta', 'recomendou', 'comparou', 'recomendou']);
    expect(trafego.items[0]).toMatchObject({ subject: 'CA - Histórico', detail: 'orcamento_reduzir', by: { id: e.userId }, mine: true });
    expect(trafego.items[2]).toMatchObject({ count: 31, by: null });
    expect(trafego.items[3]).toMatchObject({ subject: 'Delivery noite', detail: 'orcamento_reduzir', count: 20 });
    expect(trafego.items[4]).toMatchObject({ subject: 'Smash em dobro', detail: 'teria_melhorado' });
    expect(trafego.items[5]).toMatchObject({ subject: 'Smash em dobro', detail: 'campanha_pausar', count: null });

    const r = await api.call('GET', `/v1/team/shadow?brand_id=${e.brandId}`, { cookie: e.cookie });
    expect(r.status).toBe(200);
    const sombra = TeamShadowResponse.parse(r.body);
    expect(sombra).toMatchObject({ rule_version: 1, last_run: { on: hoje, status: 'feito' }, has_more: false });
    expect(sombra.items).toEqual([
      {
        id: aberta,
        decided_on: hoje,
        campaign: { id: e.campanha, name: 'Delivery noite', provider: 'meta_ads' },
        tool: 'orcamento_reduzir',
        percent: 20,
        confidence_pct: '76.0',
        status: 'aberta',
        evaluate_on: menosDias(hoje, -7),
        human_action: null,
        human_action_on: null,
        agreement: null,
        regret_label: null,
        regret_micros: null,
      },
      {
        id: avaliada,
        decided_on: antes,
        campaign: { id: outra, name: 'Smash em dobro', provider: 'meta_ads' },
        tool: 'campanha_pausar',
        percent: null,
        confidence_pct: '81.2',
        status: 'avaliada',
        evaluate_on: menosDias(antes, -7),
        human_action: 'reduziu_verba',
        human_action_on: antes,
        agreement: 'mesma_direcao',
        regret_label: 'teria_melhorado',
        regret_micros: '-18400000',
      },
    ]);
    const curta = TeamShadowResponse.parse((await api.call('GET', `/v1/team/shadow?brand_id=${e.brandId}&limit=1`, { cookie: e.cookie })).body);
    expect(curta.items.map((d) => d.id)).toEqual([aberta]);
    expect(curta.has_more).toBe(true);
  });

  it('desligar e ligar entram no histórico; outra empresa não vê; quem não vê Sua equipe não vê o histórico', async () => {
    const e = await empresa();
    expect((await api.call('POST', '/v1/team/members/pesquisador/pause', { cookie: e.cookie, body: { brand_id: e.brandId, reason: 'Sem leitura por enquanto' } })).status).toBe(200);
    expect((await api.call('POST', '/v1/team/members/pesquisador/resume', { cookie: e.cookie, body: { brand_id: e.brandId } })).status).toBe(200);
    const pesquisador = await atividade(e, e.brandId, 'pesquisador');
    expect(tipos(pesquisador)).toEqual(['ligado', 'desligado']);
    expect(pesquisador.items[1]).toMatchObject({ by: { id: e.userId }, mine: true });
    // Marca sem nada guardado: a lista vem vazia, e a sombra sem a vez da rotina.
    expect((await atividade(e, e.brandId, 'lia')).items).toEqual([]);
    expect(TeamShadowResponse.parse((await api.call('GET', `/v1/team/shadow?brand_id=${e.brandId}`, { cookie: e.cookie })).body)).toMatchObject({ last_run: null, items: [] });

    const outra = await empresa();
    expect((await api.call('GET', `/v1/team/members/pesquisador/activity?brand_id=${e.brandId}`, { cookie: outra.cookie })).status).toBe(404);
    expect((await api.call('GET', `/v1/team/shadow?brand_id=${e.brandId}`, { cookie: outra.cookie })).status).toBe(404);
    // Funcionário que não é da equipe desta fase, e limite fora da faixa.
    expect((await api.call('GET', `/v1/team/members/criativo/activity?brand_id=${e.brandId}`, { cookie: e.cookie })).status).toBe(400);
    expect((await api.call('GET', `/v1/team/members/lia/activity?brand_id=${e.brandId}&limit=500`, { cookie: e.cookie })).status).toBe(400);
    // Só relatórios: não vê campanhas nem vendas.
    const soRelatorios = await membro(e, 'so_relatorios');
    expect((await api.call('GET', `/v1/team/members/lia/activity?brand_id=${e.brandId}`, { cookie: soRelatorios.cookie })).status).toBe(403);
    expect((await api.call('GET', `/v1/team/shadow?brand_id=${e.brandId}`, { cookie: soRelatorios.cookie })).status).toBe(403);
  });
});
