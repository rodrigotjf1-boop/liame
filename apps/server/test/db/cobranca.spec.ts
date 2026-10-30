import { randomBytes, randomUUID } from 'node:crypto';
import { BillingPlansResponse, BillingResponse } from '@liame/contracts';
import { createDatabase, type Database, withSystem } from '@liame/database';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { usoDeIaDaEmpresa } from '../../src/ai/uso.js';
import { pessoaPode } from '../../src/auth/pessoa-pode.js';
import { currentStep, totpCode } from '../../src/auth/totp.js';
import { criarAssinatura, encerrar, type Forma, pagarFatura } from '../../src/cobranca/assinatura.js';
import { diaNoFuso, diasEntre, diferencaDoPlano, proximoVencimento, somarDias } from '../../src/cobranca/vida.js';
import { FlagService } from '../../src/flags/flag.service.js';
import { KillSwitchService } from '../../src/kill-switch/kill-switch.service.js';
import { AssinaturasLoop } from '../../src/worker/assinaturas-loop.js';
import {
  codigoErrado,
  enableMfa,
  ownerQuery,
  PASSWORD,
  resetIpRateLimits,
  signupAndLogin,
  startApi,
  TERMOS,
  type TestApi,
  tokenFrom,
  uniqueEmail,
} from '../helpers/api.js';
import { ligarFlagDaEmpresa } from '../helpers/meta-de-mentira.js';
import { APP_URL, hasDb } from './env.js';

// A7 · W1: os planos e a assinatura (Termos 10.4 e 11.1; `plano-a7.md` D-A7-13 a D-A7-26; P26), pelo caminho inteiro:
// a função desligada; os planos; assinar (o pedido repetido, a troca antes do primeiro pagamento, a marca que já
// assina); o primeiro pagamento, que começa o período; a rotina com o relógio (A7-3): a fatura 5 dias antes, o 1º, o 10º
// e o 30º dia, o pagamento que volta tudo na hora, o pedido sem pagamento em 7 dias; cancelar no fim do período pago,
// manter, cancelar em atraso; desistir em 7 dias (e fora do prazo, e na segunda contratação); subir e descer de plano;
// quem vê e quem muda (o Administrador com a cobrança liberada vê e não muda); o código do app; a outra empresa; a
// função desligada depois de assinar; e as restrições das tabelas (V119).

type Empresa = { cookie: string; tenantId: string; brandId: string; userId: string; segredo: string };

const SP = 'America/Sao_Paulo';
const ESSENCIAL = '24900';
const COMPLETO = '44900';
const REAL = 1_000_000;

describe.skipIf(!hasDb)('Plano e cobrança: os planos, a assinatura e a vida dela (A7 · W1)', () => {
  let api: TestApi;
  let database: Database;
  let rotina: AssinaturasLoop;

  beforeAll(async () => {
    api = await startApi();
    await resetIpRateLimits();
    database = createDatabase({ connectionString: APP_URL, max: 4, applicationName: 'liame-test' });
    rotina = new AssinaturasLoop(database, api.app.get(FlagService));
  }, 120_000);
  beforeEach(resetIpRateLimits);
  afterAll(async () => {
    await api?.close();
    await database?.close();
  });

  async function empresa(nome: string, { ligada = true } = {}): Promise<Empresa> {
    const s = await signupAndLogin(api, undefined, nome);
    const { secret } = await enableMfa(api, s.cookie);
    const tenantId = s.me.active_organization_id as string;
    const marcas = await api.call('GET', '/v1/brands', { cookie: s.cookie });
    const brandId = marcas.body.items[0].id as string;
    const [u] = await ownerQuery<{ id: string }>(`select id from liame.app_user where email = $1`, [s.email]);
    await ownerQuery(`update liame.organization set timezone = $2 where id = $1`, [tenantId, SP]);
    if (ligada) await ligarFlagDaEmpresa(api, 'cobranca', tenantId, true);
    return { cookie: s.cookie, tenantId, brandId, userId: u!.id, segredo: secret };
  }

  /** O código do app de agora (o passo usado e o limite de tentativas são zerados: o teste confirma mais de uma vez). */
  async function codigo(e: { userId: string; segredo: string }): Promise<string> {
    await ownerQuery(`update liame.app_user set totp_last_step = null where id = $1`, [e.userId]);
    await ownerQuery(`delete from liame.rate_limit where key = $1`, [`segundo-fator:${e.userId}`]);
    return totpCode(e.segredo, currentStep());
  }

  async function estado(e: Empresa, cookie = e.cookie): Promise<BillingResponse> {
    const r = await api.call('GET', `/v1/billing?brand_id=${e.brandId}`, { cookie });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    return BillingResponse.parse(r.body);
  }

  function assinar(e: Empresa, plano = 'essencial', forma = 'pix', brandId = e.brandId) {
    return api.call('POST', '/v1/billing/subscription', { cookie: e.cookie, body: { brand_id: brandId, plan: plano, method: forma } });
  }

  const comCodigo = async (e: Empresa, caminho: string, extra: Record<string, unknown> = {}) =>
    api.call('POST', `/v1/billing/subscription/${caminho}`, { cookie: e.cookie, body: { brand_id: e.brandId, code: await codigo(e), ...extra } });

  /** A fatura em aberto mais antiga da marca. */
  async function emAberto(e: Empresa, tipo = 'mensalidade'): Promise<{ id: string; due_date: string; amount_cents: string; period_start: string | null }> {
    const [f] = await ownerQuery<{ id: string; due_date: string; amount_cents: string; period_start: string | null }>(
      `select id, due_date::text, amount_cents::text, period_start::text from liame.billing_invoice
        where brand_id = $1 and status = 'aberta' and kind = $2 order by due_date, created_at limit 1`,
      [e.brandId, tipo],
    );
    if (!f) throw new Error('nenhuma fatura em aberto');
    return f;
  }

  function pagar(faturaId: string, pagoEm: Date, forma: Forma = 'pix', agora = pagoEm) {
    return withSystem(database.db, (tx) => pagarFatura(tx, { faturaId, pagoEm, forma, agora }));
  }

  /** A rotina, só nas assinaturas desta empresa, com o relógio do teste; a assinatura entra na vez antes (o dia chegou). */
  async function rotinaEm(e: Empresa, agora: Date) {
    await ownerQuery(`update liame.subscription set next_check_at = $2 where tenant_id = $1 and status <> 'encerrada'`, [e.tenantId, agora.toISOString()]);
    return rotina.executarLote(20, { tenantIds: [e.tenantId] }, agora);
  }

  type Assinatura = {
    id: string;
    status: string;
    plan_key: string;
    next_plan_key: string | null;
    period_start: string | null;
    period_end: string | null;
    anchor_day: number | null;
    withdraw_until: string | null;
    cancel_at_period_end: boolean;
    end_reason: string | null;
  };
  async function assinatura(e: Empresa): Promise<Assinatura> {
    const [s] = await ownerQuery<Assinatura>(
      `select s.id, s.status, p.key as plan_key, n.key as next_plan_key, s.period_start::text, s.period_end::text, s.anchor_day,
              s.withdraw_until::text, s.cancel_at_period_end, s.end_reason
         from liame.subscription s join liame.billing_plan p on p.id = s.plan_id left join liame.billing_plan n on n.id = s.next_plan_id
        where s.brand_id = $1 order by (s.status <> 'encerrada') desc, s.created_at desc limit 1`,
      [e.brandId],
    );
    return s!;
  }

  const faturas = (e: Empresa) =>
    ownerQuery<{ kind: string; status: string; due_date: string; period_start: string | null; amount_cents: string; refund_requested_at: string | null }>(
      `select kind, status, due_date::text, period_start::text, amount_cents::text, refund_requested_at::text from liame.billing_invoice
        where brand_id = $1 order by due_date, created_at`,
      [e.brandId],
    );

  /** Meio-dia em São Paulo num dia do calendário (15h em Greenwich). */
  const meioDia = (dia: string) => new Date(`${dia}T15:00:00Z`);
  const hojeEmSP = () => diaNoFuso(new Date(), SP);

  it('desligada: os planos e a cobrança vêm vazios, e assinar é recusado (409) sem gravar nada', async () => {
    const e = await empresa('Casa Brasa Sem Cobrança', { ligada: false });
    const p = await api.call('GET', '/v1/billing/plans', { cookie: e.cookie });
    expect(p.status).toBe(200);
    expect(BillingPlansResponse.parse(p.body)).toEqual({ enabled: false, items: [] });
    expect(await estado(e)).toMatchObject({ enabled: false, can_manage: true, subscription: null, invoices: [] });
    const r = await assinar(e);
    expect(r.status, JSON.stringify(r.body)).toBe(409);
    expect(r.body.code).toBe('funcao-desligada');
    expect(await ownerQuery(`select 1 from liame.subscription where tenant_id = $1`, [e.tenantId])).toHaveLength(0);
  }, 60_000);

  it('os planos: o Essencial (R$ 249) e o Completo (R$ 449), com os funcionários do P26, na ordem da tela', async () => {
    const e = await empresa('Casa Brasa Planos');
    const r = await api.call('GET', '/v1/billing/plans', { cookie: e.cookie });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const planos = BillingPlansResponse.parse(r.body);
    expect(planos.enabled).toBe(true);
    expect(planos.items.map((p) => [p.key, p.version, p.price_cents])).toEqual([
      ['essencial', 1, ESSENCIAL],
      ['completo', 1, COMPLETO],
    ]);
    expect(planos.items[0]!.agents).toEqual(['lia', 'trafego', 'analista', 'relatorios', 'compliance']);
    expect(planos.items[1]!.agents).toEqual(['lia', 'trafego', 'analista', 'relatorios', 'compliance', 'estrategista', 'pesquisador', 'criativo', 'social', 'crm']);
  }, 60_000);

  it('assinar: espera o primeiro pagamento, com a mensalidade vencendo hoje; o pedido repetido não contrata duas vezes; outro plano antes do pagamento substitui; com a assinatura paga, 409', async () => {
    const e = await empresa('Casa Brasa Assina');
    const r = await assinar(e, 'essencial', 'pix');
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const b = BillingResponse.parse(r.body);
    const hoje = hojeEmSP();
    expect(b.today).toBe(hoje);
    expect(b.subscription).toMatchObject({ status: 'aguardando_pagamento', method: 'pix', period_start: null, first_payment_until: somarDias(hoje, 6), overdue: null });
    expect(b.subscription!.plan.key).toBe('essencial');
    expect(b.invoices).toEqual([expect.objectContaining({ kind: 'mensalidade', status: 'aberta', due_date: hoje, amount_cents: ESSENCIAL, period_start: null })]);
    const [ev] = await ownerQuery<{ after: Record<string, unknown> }>(`select after from liame.audit_event where tenant_id = $1 and action = 'cobranca.assinar'`, [e.tenantId]);
    expect(ev!.after).toMatchObject({ brand_id: e.brandId, plano: 'essencial', versao: 1, forma: 'pix', valor_cents: 24_900 });

    // O mesmo pedido de novo: nada novo.
    expect((await assinar(e, 'essencial', 'pix')).status).toBe(200);
    expect(await ownerQuery(`select 1 from liame.subscription where brand_id = $1`, [e.brandId])).toHaveLength(1);

    // Outro plano antes do primeiro pagamento: o pedido anterior termina como substituído, e a fatura dele não é cobrada.
    expect((await assinar(e, 'completo', 'cartao')).status).toBe(200);
    const todas = await ownerQuery<{ status: string; end_reason: string | null }>(`select status, end_reason from liame.subscription where brand_id = $1 order by created_at`, [e.brandId]);
    expect(todas).toEqual([
      { status: 'encerrada', end_reason: 'substituida' },
      { status: 'aguardando_pagamento', end_reason: null },
    ]);
    expect((await faturas(e)).map((f) => [f.status, f.amount_cents])).toEqual([
      ['cancelada', ESSENCIAL],
      ['aberta', COMPLETO],
    ]);

    // Paga, a marca já assina: 409.
    await pagar((await emAberto(e)).id, new Date(), 'cartao');
    const deNovo = await assinar(e, 'essencial', 'pix');
    expect(deNovo.status).toBe(409);
    expect(deNovo.body.code).toBe('assinatura-existe');

    // Plano fora dos oferecidos: 400.
    const outra = await empresa('Casa Brasa Plano Inventado');
    expect((await assinar(outra, 'premium', 'pix')).status).toBe(400);
  }, 90_000);

  it('a rotina com o relógio (A7-3): o primeiro pagamento começa o período; a fatura nasce 5 dias antes; 1º, 10º e 30º dia; pagar volta tudo na hora', async () => {
    const e = await empresa('Casa Brasa Relógio');
    // Assinada em 21/10/2026 (pela mesma função da rota, com o relógio do teste) e paga em 22/10, ao meio-dia em São
    // Paulo: o período vai de 22/10 a 22/11, e o vencimento fica no dia 22.
    const [plano] = await ownerQuery<{ id: string }>(`select id from liame.billing_plan where key = 'essencial' and offered`);
    await withSystem(database.db, (tx) => criarAssinatura(tx, { tenantId: e.tenantId, brandId: e.brandId, planoId: plano!.id, forma: 'pix', quem: e.userId, agora: meioDia('2026-10-21') }));
    const primeira = await emAberto(e);
    expect(await pagar(primeira.id, meioDia('2026-10-22'))).toMatchObject({ situacao: 'paga', status: 'ativa' });
    expect(await assinatura(e)).toMatchObject({ status: 'ativa', anchor_day: 22, period_start: '2026-10-22', period_end: '2026-11-22', withdraw_until: '2026-10-29' });
    // Pagar de novo não muda nada.
    expect(await pagar(primeira.id, meioDia('2026-10-22'))).toEqual({ situacao: 'ja_paga' });

    // 16/11: ainda não é a vez da próxima fatura (faltam 6 dias).
    expect((await rotinaEm(e, meioDia('2026-11-16')))[0]!.resultado).toBe('conferida');
    expect(await faturas(e)).toHaveLength(1);
    // 17/11: 5 dias antes do vencimento, nasce a fatura de 22/11 a 22/12; a rotina de novo no mesmo dia não cobra em dobro.
    await rotinaEm(e, meioDia('2026-11-17'));
    await rotinaEm(e, meioDia('2026-11-17'));
    expect((await faturas(e)).map((f) => [f.status, f.due_date, f.period_start])).toEqual([
      ['paga', '2026-10-21', '2026-10-22'],
      ['aberta', '2026-11-22', '2026-11-22'],
    ]);

    // No vencimento, em dia; no 1º dia depois, em atraso; no 9º, ainda; no 10º, as ações param; no 30º, suspensa.
    const dias = [
      ['2026-11-22', 'ativa'],
      ['2026-11-23', 'em_atraso'],
      ['2026-12-01', 'em_atraso'],
      ['2026-12-02', 'acoes_paradas'],
      ['2026-12-21', 'acoes_paradas'],
      ['2026-12-22', 'suspensa'],
    ] as const;
    for (const [dia, status] of dias) {
      await rotinaEm(e, meioDia(dia));
      expect((await assinatura(e)).status, dia).toBe(status);
    }
    const eventos = await ownerQuery<{ before: { status: string }; after: { status: string } }>(
      `select before, after from liame.audit_event where tenant_id = $1 and action = 'cobranca.situacao' order by chain_seq`,
      [e.tenantId],
    );
    expect(eventos.map((x) => `${x.before.status}→${x.after.status}`)).toEqual(['ativa→em_atraso', 'em_atraso→acoes_paradas', 'acoes_paradas→suspensa']);
    // Em 22/12 o período também virou (22/12 a 22/01), com a fatura dele já nascida em 17/12.
    expect(await assinatura(e)).toMatchObject({ period_start: '2026-12-22', period_end: '2027-01-22' });
    expect((await faturas(e)).map((f) => f.due_date)).toEqual(['2026-10-21', '2026-11-22', '2026-12-22']);

    // Pagou a de novembro em 23/12: a mais antiga em aberto passa a ser a de dezembro (1º dia), e a situação volta na hora.
    const novembro = await emAberto(e);
    expect(novembro.due_date).toBe('2026-11-22');
    expect(await pagar(novembro.id, meioDia('2026-12-23'))).toMatchObject({ situacao: 'paga', status: 'em_atraso' });
    expect(await pagar((await emAberto(e)).id, meioDia('2026-12-23'))).toMatchObject({ situacao: 'paga', status: 'ativa' });
    expect((await estado(e)).subscription!.status).toBe('ativa');
  }, 90_000);

  it('a parada da cobrança (A7 · W3, parte 1; D-A7-6, D-A7-38): no 10º dia as ações da marca param, uma pessoa não a desliga, e pagar a tira na hora', async () => {
    const e = await empresa('Casa Brasa Parada');
    const [plano] = await ownerQuery<{ id: string }>(`select id from liame.billing_plan where key = 'essencial' and offered`);
    await withSystem(database.db, (tx) => criarAssinatura(tx, { tenantId: e.tenantId, brandId: e.brandId, planoId: plano!.id, forma: 'pix', quem: e.userId, agora: meioDia('2026-10-21') }));
    await pagar((await emAberto(e)).id, meioDia('2026-10-22'));
    const s = await assinatura(e);
    const paradas = () =>
      ownerQuery<{ id: string; level: string; brand_id: string; activated_by: string | null; deactivated_at: string | null; subscription_id: string | null }>(
        `select id, level, brand_id, activated_by, deactivated_at::text, subscription_id from liame.kill_switch where tenant_id = $1 order by activated_at`,
        [e.tenantId],
      );
    const trava = (brandId = e.brandId) => withSystem(database.db, (tx) => api.app.get(KillSwitchService).check(tx, { tenantId: e.tenantId, provider: 'ai', brandId }));

    // Do 1º ao 9º dia de atraso, a marca segue trabalhando.
    await rotinaEm(e, meioDia('2026-11-17'));
    await rotinaEm(e, meioDia('2026-12-01'));
    expect((await assinatura(e)).status).toBe('em_atraso');
    expect(await paradas()).toEqual([]);
    // No 10º dia, a parada da marca: pela rotina (sem pessoa), ligada à assinatura; a IA e as ações da marca param.
    await rotinaEm(e, meioDia('2026-12-02'));
    const [p] = await paradas();
    expect(p).toMatchObject({ level: 'brand', brand_id: e.brandId, activated_by: null, deactivated_at: null, subscription_id: s.id });
    expect(await trava()).toMatchObject({ id: p!.id, level: 'brand' });
    // Outra marca da empresa não para (a parada é a da marca da assinatura).
    expect(await trava(randomUUID())).toBeNull();
    // A rotina de novo no mesmo dia, e no 30º (suspensa), não abre outra parada.
    await rotinaEm(e, meioDia('2026-12-02'));
    await rotinaEm(e, meioDia('2026-12-22'));
    expect((await assinatura(e)).status).toBe('suspensa');
    expect((await paradas()).filter((x) => x.deactivated_at === null)).toHaveLength(1);

    // A empresa vê que a parada é da cobrança, na lista e em Sua equipe; uma pessoa não a desliga.
    const lista = await api.call('GET', '/v1/kill-switches', { cookie: e.cookie });
    expect(lista.status).toBe(200);
    // (A lista traz também as paradas da distribuição, que outros testes criam no mesmo banco: só a desta empresa importa.)
    expect(lista.body.items.filter((i: { brand_id: string | null }) => i.brand_id === e.brandId)).toEqual([expect.objectContaining({ id: p!.id, level: 'brand', by_billing: true })]);
    const equipe = await api.call('GET', `/v1/team?brand_id=${e.brandId}`, { cookie: e.cookie });
    expect(equipe.body.stop).toMatchObject({ id: p!.id, by_billing: true, by: null });
    const desligar = await api.call('DELETE', `/v1/kill-switches/${p!.id}`, { cookie: e.cookie });
    expect(desligar.status).toBe(409);
    expect(desligar.body.code).toBe('parada-da-cobranca');
    expect((await paradas())[0]!.deactivated_at).toBeNull();
    // A parada que a pessoa aciona segue com o "retomar" dela, e não é da cobrança.
    const minha = await api.call('POST', '/v1/kill-switches', { cookie: e.cookie, body: { level: 'tenant', reason: 'Parando para revisar' } });
    expect(minha.status).toBe(201);
    expect(minha.body.by_billing).toBe(false);
    expect((await api.call('DELETE', `/v1/kill-switches/${minha.body.id}`, { cookie: e.cookie })).status).toBe(204);

    // Pagou a mais antiga (novembro): a de dezembro ainda deixa em atraso (1º dia), e as ações voltam na hora.
    expect(await pagar((await emAberto(e)).id, meioDia('2026-12-23'))).toMatchObject({ situacao: 'paga', status: 'em_atraso' });
    expect((await paradas()).find((x) => x.id === p!.id)!.deactivated_at).not.toBeNull();
    expect(await trava()).toBeNull();
    const eventos = await ownerQuery<{ action: string; after: Record<string, unknown> }>(
      `select action, after from liame.audit_event where tenant_id = $1 and action in ('cobranca.parar_acoes', 'cobranca.voltar_acoes') order by chain_seq`,
      [e.tenantId],
    );
    expect(eventos.map((x) => [x.action, x.after.status])).toEqual([
      ['cobranca.parar_acoes', 'acoes_paradas'],
      ['cobranca.voltar_acoes', 'em_atraso'],
    ]);

    // De novo no 10º dia da de dezembro, e a assinatura termina (cancelada com atraso, D-A7-25; pelo relógio do teste,
    // porque a rota usa o de agora): a parada sai junto.
    await rotinaEm(e, meioDia('2027-01-01'));
    expect((await paradas()).filter((x) => x.deactivated_at === null)).toHaveLength(1);
    await withSystem(database.db, (tx) => encerrar(tx, s.id, 'cancelada', meioDia('2027-01-02')));
    expect(await assinatura(e)).toMatchObject({ status: 'encerrada' });
    expect((await paradas()).filter((x) => x.deactivated_at === null)).toEqual([]);

    // V119: a parada da cobrança é da marca e da rotina; uma viva por assinatura.
    const inserir = (nivel: string, por: string | null) =>
      ownerQuery(
        `insert into liame.kill_switch (id, level, tenant_id, brand_id, reason, activated_by, subscription_id) values (gen_random_uuid(), $1, $2, $3, 'teste', $4, $5)`,
        [nivel, e.tenantId, nivel === 'brand' ? e.brandId : null, por, s.id],
      );
    await expect(inserir('tenant', null)).rejects.toMatchObject({ code: '23514', constraint: 'kill_switch_da_cobranca' });
    await expect(inserir('brand', e.userId)).rejects.toMatchObject({ code: '23514', constraint: 'kill_switch_da_cobranca' });
    await inserir('brand', null);
    await expect(inserir('brand', null)).rejects.toMatchObject({ code: '23505', constraint: 'uq_kill_switch_cobranca' });
  }, 120_000);

  it('o pedido sem o primeiro pagamento termina sozinho no 7º dia, e a fatura não é cobrada', async () => {
    const e = await empresa('Casa Brasa Sem Pagar');
    expect((await assinar(e)).status).toBe(200);
    const hoje = hojeEmSP();
    expect((await rotinaEm(e, meioDia(somarDias(hoje, 6))))[0]!.resultado).toBe('esperando_o_primeiro_pagamento');
    expect((await rotinaEm(e, meioDia(somarDias(hoje, 7))))[0]!.resultado).toBe('nao_paga');
    expect(await assinatura(e)).toMatchObject({ status: 'encerrada', end_reason: 'nao_paga' });
    expect((await faturas(e)).map((f) => f.status)).toEqual(['cancelada']);
    // A fatura cancelada não é paga depois.
    const [f] = await ownerQuery<{ id: string }>(`select id from liame.billing_invoice where brand_id = $1`, [e.brandId]);
    expect(await pagar(f!.id, new Date())).toEqual({ situacao: 'cancelada' });
  }, 60_000);

  it('cancelar vale no fim do período pago: a fatura seguinte não é cobrada; manter desfaz; no fim do período, termina', async () => {
    const e = await empresa('Casa Brasa Cancela');
    expect((await assinar(e)).status).toBe(200);
    await pagar((await emAberto(e)).id, new Date());
    const s0 = await assinatura(e);
    // A fatura do período seguinte já nasceu (5 dias antes).
    await rotinaEm(e, meioDia(somarDias(s0.period_end!, -5)));
    expect(await faturas(e)).toHaveLength(2);

    const c = await comCodigo(e, 'cancel');
    expect(c.status, JSON.stringify(c.body)).toBe(200);
    expect(BillingResponse.parse(c.body).subscription).toMatchObject({ status: 'ativa', cancel_at_period_end: true });
    expect((await faturas(e)).map((f) => f.status)).toEqual(['paga', 'cancelada']);

    // Manter: a fatura do período seguinte nasce de novo na próxima vez da rotina.
    const m = await api.call('POST', '/v1/billing/subscription/keep', { cookie: e.cookie, body: { brand_id: e.brandId } });
    expect(m.status, JSON.stringify(m.body)).toBe(200);
    expect(BillingResponse.parse(m.body).subscription!.cancel_at_period_end).toBe(false);
    await rotinaEm(e, meioDia(somarDias(s0.period_end!, -4)));
    expect((await faturas(e)).map((f) => f.status)).toEqual(['paga', 'cancelada', 'aberta']);

    // Cancela de novo, e o período acaba: termina, sem cobrar o seguinte.
    expect((await comCodigo(e, 'cancel')).status).toBe(200);
    expect((await rotinaEm(e, meioDia(s0.period_end!)))[0]!.resultado).toBe('cancelada');
    expect(await assinatura(e)).toMatchObject({ status: 'encerrada', end_reason: 'cancelada' });
    expect((await faturas(e)).filter((f) => f.status === 'aberta')).toHaveLength(0);
    const eventos = await ownerQuery<{ action: string }>(`select action from liame.audit_event where tenant_id = $1 and action like 'cobranca.%' order by chain_seq`, [e.tenantId]);
    expect(eventos.map((x) => x.action)).toEqual(['cobranca.assinar', 'cobranca.pagamento', 'cobranca.cancelar', 'cobranca.manter', 'cobranca.cancelar', 'cobranca.encerrar']);
  }, 90_000);

  it('cancelar com a mensalidade em atraso termina agora, e o que está em aberto não é cobrado (D-A7-25)', async () => {
    const e = await empresa('Casa Brasa Cancela Em Atraso');
    expect((await assinar(e)).status).toBe(200);
    // Pago há 35 dias: o período seguinte começou há alguns dias, com a fatura nascida a tempo e em aberto.
    await pagar((await emAberto(e)).id, meioDia(somarDias(hojeEmSP(), -35)));
    const s0 = await assinatura(e);
    await rotinaEm(e, meioDia(somarDias(s0.period_end!, -5)));
    await rotinaEm(e, new Date());
    expect((await assinatura(e)).status).toBe('em_atraso');
    const c = await comCodigo(e, 'cancel');
    expect(c.status, JSON.stringify(c.body)).toBe(200);
    expect(await assinatura(e)).toMatchObject({ status: 'encerrada', end_reason: 'cancelada' });
    // A paga (a primeira) e a do período em atraso, cancelada; a ordem por vencimento depende do dia do teste.
    expect((await faturas(e)).map((f) => f.status).sort()).toEqual(['cancelada', 'paga']);
  }, 60_000);

  it('desistir em 7 dias: termina agora, e o pago fica com a devolução pedida; fora do prazo, 409; na segunda contratação da empresa, não há desistência', async () => {
    const e = await empresa('Casa Brasa Desiste');
    expect((await assinar(e)).status).toBe(200);
    await pagar((await emAberto(e)).id, new Date());
    expect((await estado(e)).subscription!.withdraw_until).toBe(somarDias(hojeEmSP(), 7));
    const d = await comCodigo(e, 'withdraw');
    expect(d.status, JSON.stringify(d.body)).toBe(200);
    expect(await assinatura(e)).toMatchObject({ status: 'encerrada', end_reason: 'desistencia' });
    const [f] = await faturas(e);
    expect(f).toMatchObject({ status: 'paga', amount_cents: ESSENCIAL });
    expect(f!.refund_requested_at).not.toBeNull();
    // Paga aqui sem a cobrança no Asaas (o teste paga direto): a devolução não entra na fila, e o porquê fica para a
    // distribuição devolver à mão (W2a, parte 3b; com a cobrança no Asaas, a fila está em `devolucao.spec.ts`).
    const [fila] = await ownerQuery<{ charge_error: string | null; charge_next_at: Date | null }>(
      `select charge_error, charge_next_at from liame.billing_invoice where brand_id = $1 and status = 'paga'`,
      [e.brandId],
    );
    expect(fila).toEqual({ charge_error: 'devolucao_sem_cobranca', charge_next_at: null });
    const [ev] = await ownerQuery<{ after: Record<string, unknown> }>(`select after from liame.audit_event where tenant_id = $1 and action = 'cobranca.desistir'`, [e.tenantId]);
    expect(ev!.after).toMatchObject({ devolve_cents: 24_900 });

    // A mesma empresa assina de novo: não é mais a primeira contratação, e a desistência não vale.
    expect((await assinar(e)).status).toBe(200);
    await pagar((await emAberto(e)).id, new Date());
    expect((await assinatura(e)).withdraw_until).toBeNull();
    const segunda = await comCodigo(e, 'withdraw');
    expect(segunda.status).toBe(409);
    expect(segunda.body.code).toBe('fora-do-prazo-de-desistencia');

    // Primeira contratação paga há 8 dias: o prazo acabou, e a assinatura segue.
    const outra = await empresa('Casa Brasa Desiste Tarde');
    expect((await assinar(outra)).status).toBe(200);
    await pagar((await emAberto(outra)).id, meioDia(somarDias(hojeEmSP(), -8)));
    const tarde = await comCodigo(outra, 'withdraw');
    expect(tarde.status).toBe(409);
    expect(tarde.body.code).toBe('fora-do-prazo-de-desistencia');
    expect((await assinatura(outra)).status).not.toBe('encerrada');
  }, 90_000);

  it('subir de plano: a diferença dos dias que faltam vence hoje, e o plano muda quando ela é paga; descer vale no período seguinte; escolher o plano em vigor desfaz', async () => {
    const e = await empresa('Casa Brasa Troca');
    expect((await assinar(e)).status).toBe(200);
    // Pago há 10 dias: faltam uns 20 dias do período.
    const hoje = hojeEmSP();
    await pagar((await emAberto(e)).id, meioDia(somarDias(hoje, -10)));
    const s0 = await assinatura(e);

    const subir = await comCodigo(e, 'plan', { plan: 'completo' });
    expect(subir.status, JSON.stringify(subir.body)).toBe(200);
    const esperado = diferencaDoPlano(24_900, 44_900, diasEntre(hoje, s0.period_end!), diasEntre(s0.period_start!, s0.period_end!));
    expect(esperado).toBeGreaterThan(0);
    const diferenca = await emAberto(e, 'diferenca');
    expect(diferenca).toMatchObject({ due_date: hoje, amount_cents: String(esperado), period_start: hoje });
    // Ainda no Essencial: o plano muda com a diferença paga.
    expect((await assinatura(e)).plan_key).toBe('essencial');
    await pagar(diferenca.id, new Date());
    expect((await assinatura(e)).plan_key).toBe('completo');

    // Descer: vale no período seguinte.
    const descer = await comCodigo(e, 'plan', { plan: 'essencial' });
    expect(descer.status, JSON.stringify(descer.body)).toBe(200);
    expect(BillingResponse.parse(descer.body).subscription).toMatchObject({ plan: expect.objectContaining({ key: 'completo' }), next_plan: expect.objectContaining({ key: 'essencial' }) });
    // Escolher de novo o Completo desfaz a descida.
    expect((await comCodigo(e, 'plan', { plan: 'completo' })).status).toBe(200);
    expect((await assinatura(e)).next_plan_key).toBeNull();
    // Descer de novo, e o período acaba: a mensalidade nova é a do Essencial, e o plano muda.
    expect((await comCodigo(e, 'plan', { plan: 'essencial' })).status).toBe(200);
    await rotinaEm(e, meioDia(s0.period_end!));
    expect(await assinatura(e)).toMatchObject({ plan_key: 'essencial', next_plan_key: null, period_start: s0.period_end, period_end: proximoVencimento(s0.period_end!, s0.anchor_day!) });
    expect(await emAberto(e)).toMatchObject({ due_date: s0.period_end, amount_cents: ESSENCIAL });

    // Sem código, 400; com o código errado, 401, sem mexer em nada.
    expect((await api.call('POST', '/v1/billing/subscription/plan', { cookie: e.cookie, body: { brand_id: e.brandId, plan: 'completo' } })).status).toBe(400);
    await ownerQuery(`delete from liame.rate_limit where key = $1`, [`segundo-fator:${e.userId}`]);
    const errado = await api.call('POST', '/v1/billing/subscription/plan', { cookie: e.cookie, body: { brand_id: e.brandId, plan: 'completo', code: codigoErrado(e.segredo) } });
    expect(errado.status).toBe(401);
    expect(errado.body.code).toBe('codigo-invalido');
    expect(await ownerQuery(`select 1 from liame.billing_invoice where brand_id = $1 and kind = 'diferenca' and status = 'aberta'`, [e.brandId])).toHaveLength(0);
  }, 120_000);

  it('quem vê e quem muda: o Administrador com a cobrança liberada vê e não muda; sem ela, nem vê; o Gestor não vê; a marca de outra empresa, 404', async () => {
    const e = await empresa('Casa Brasa Pessoas');
    expect((await assinar(e)).status).toBe(200);
    async function convidado(papel: string, extra: Record<string, unknown> = {}) {
      const email = uniqueEmail(papel);
      const inv = await api.call('POST', '/v1/invitations', { cookie: e.cookie, body: { email, role: papel, approve_limit_micros: 100 * REAL, ...extra } });
      expect(inv.status, JSON.stringify(inv.body)).toBe(201);
      const s = await api.call('POST', '/v1/invitations/signup', { body: { token: tokenFrom(api.mailer, email), name: `Pessoa ${papel}`, password: PASSWORD, terms_version: TERMOS } });
      expect(s.status).toBe(200);
      await enableMfa(api, s.cookie!);
      return { cookie: s.cookie!, userId: s.body.user.id as string };
    }
    const adm = await convidado('administrador', { billing_access: true });
    const admSem = await convidado('administrador');
    const gestor = await convidado('gestor');

    const visto = await estado(e, adm.cookie);
    // Desde a W2a, quem tem a cobrança liberada também paga (D-A7-13).
    expect(visto).toMatchObject({ enabled: true, can_manage: false, can_pay: true });
    expect(await estado(e)).toMatchObject({ can_manage: true, can_pay: true });
    expect(visto.subscription!.status).toBe('aguardando_pagamento');
    expect((await api.call('GET', '/v1/billing/plans', { cookie: adm.cookie })).status).toBe(200);
    expect((await api.call('POST', '/v1/billing/subscription', { cookie: adm.cookie, body: { brand_id: e.brandId, plan: 'completo', method: 'pix' } })).status).toBe(403);
    expect((await api.call('POST', '/v1/billing/subscription/keep', { cookie: adm.cookie, body: { brand_id: e.brandId } })).status).toBe(403);
    for (const p of [admSem, gestor]) {
      expect((await api.call('GET', `/v1/billing?brand_id=${e.brandId}`, { cookie: p.cookie })).status).toBe(403);
    }
    // O mesmo critério fora da sessão (as rotinas que avisam quem paga).
    const pode = (userId: string, permissao = 'cobranca.ver') => withSystem(database.db, (tx) => pessoaPode(tx, { tenantId: e.tenantId, userId, permissao }));
    expect([await pode(adm.userId), await pode(admSem.userId), await pode(gestor.userId), await pode(e.userId)]).toEqual([true, false, false, true]);
    expect(await pode(adm.userId, 'cobranca.gerenciar')).toBe(false);
    expect([await pode(adm.userId, 'cobranca.pagar'), await pode(admSem.userId, 'cobranca.pagar'), await pode(gestor.userId, 'cobranca.pagar'), await pode(e.userId, 'cobranca.pagar')]).toEqual([
      true,
      false,
      false,
      true,
    ]);

    // A marca de outra empresa não aparece (a RLS esconde: 404).
    const outra = await empresa('Casa Brasa Vizinha');
    expect((await api.call('GET', `/v1/billing?brand_id=${e.brandId}`, { cookie: outra.cookie })).status).toBe(404);
    expect((await api.call('POST', '/v1/billing/subscription', { cookie: outra.cookie, body: { brand_id: e.brandId, plan: 'essencial', method: 'pix' } })).status).toBe(404);
  }, 120_000);

  it('a função desligada depois de assinar: a rotina não mexe na assinatura e olha de novo em uma hora', async () => {
    const e = await empresa('Casa Brasa Desliga');
    expect((await assinar(e)).status).toBe(200);
    await pagar((await emAberto(e)).id, new Date());
    await ligarFlagDaEmpresa(api, 'cobranca', e.tenantId, false);
    const s0 = await assinatura(e);
    const agora = meioDia(somarDias(s0.period_end!, 15));
    expect((await rotinaEm(e, agora))[0]!.resultado).toBe('desligada');
    expect(await assinatura(e)).toMatchObject({ status: 'ativa', period_start: s0.period_start });
    const [vez] = await ownerQuery<{ next_check_at: Date }>(`select next_check_at from liame.subscription where id = $1`, [s0.id]);
    expect(vez!.next_check_at.getTime() - agora.getTime()).toBe(3_600_000);
  }, 60_000);

  it('a franquia de IA do plano vira o teto da empresa (D-A7-26): a soma das marcas com assinatura paga e viva; o teto da distribuição vence; sem franquia, o padrão', async () => {
    const e = await empresa('Casa Brasa Franquia');
    const padrao = { dailyLimitUsdMicros: 2_000_000, monthlyLimitUsdMicros: 20_000_000 };
    const teto = async () => {
      const u = await withSystem(database.db, (tx) => usoDeIaDaEmpresa(tx, e.tenantId, padrao, new Date()));
      return [String(u.tetoDia), String(u.tetoMes)];
    };
    // Sem assinatura: o padrão.
    expect(await teto()).toEqual(['2000000', '20000000']);
    // Paga no Essencial, que nasce sem franquia (D-A7-5): o padrão, como antes.
    expect((await assinar(e)).status).toBe(200);
    await pagar((await emAberto(e)).id, new Date());
    expect(await teto()).toEqual(['2000000', '20000000']);

    // Uma versão de plano com franquia (é a distribuição que publica a versão; a assinatura vai para ela aqui, à mão).
    const sufixo = Array.from(randomBytes(8), (b) => String.fromCharCode(97 + (b % 26))).join('');
    const [plano] = await ownerQuery<{ id: string }>(
      `insert into liame.billing_plan (id, key, version, name, price_cents, agents, ai_daily_usd_micros, ai_monthly_usd_micros, offered)
       values (gen_random_uuid(), $1, 1, 'Teste da franquia', 24900, array['lia'], 5000000, 50000000, false) returning id`,
      [`franquia_${sufixo}`],
    );
    await ownerQuery(`update liame.subscription set plan_id = $2 where brand_id = $1 and status <> 'encerrada'`, [e.brandId, plano!.id]);
    expect(await teto()).toEqual(['5000000', '50000000']);
    // Sua equipe mostra o mesmo teto do mês.
    const equipe = await api.call('GET', `/v1/team?brand_id=${e.brandId}`, { cookie: e.cookie });
    expect(equipe.status, JSON.stringify(equipe.body)).toBe(200);
    expect(equipe.body.ai.ceiling_usd_micros).toBe('50000000');

    // Uma segunda marca, paga no mesmo plano: as franquias somam.
    const nova = await api.call('POST', '/v1/brands', { cookie: e.cookie, body: { name: 'Casa Brasa Filial' } });
    expect(nova.status, JSON.stringify(nova.body)).toBe(201);
    const filial = { ...e, brandId: nova.body.id as string };
    expect((await assinar(e, 'essencial', 'pix', filial.brandId)).status).toBe(200);
    await pagar((await emAberto(filial)).id, new Date());
    await ownerQuery(`update liame.subscription set plan_id = $2 where brand_id = $1 and status <> 'encerrada'`, [filial.brandId, plano!.id]);
    expect(await teto()).toEqual(['10000000', '100000000']);

    // O teto que a distribuição define para a empresa vence a franquia, como hoje.
    await ownerQuery(
      `insert into liame.ai_budget (tenant_id, daily_usd_micros, monthly_usd_micros, set_by, reason) values ($1, 1000000, 10000000, 'testes', 'teto da distribuição')
       on conflict (tenant_id) do update set daily_usd_micros = excluded.daily_usd_micros, monthly_usd_micros = excluded.monthly_usd_micros`,
      [e.tenantId],
    );
    expect(await teto()).toEqual(['1000000', '10000000']);
    await ownerQuery(`delete from liame.ai_budget where tenant_id = $1`, [e.tenantId]);

    // A assinatura que termina (a desistência da primeira marca) deixa de contar; a da filial segue.
    expect((await comCodigo(e, 'withdraw')).status).toBe(200);
    expect(await teto()).toEqual(['5000000', '50000000']);
  }, 120_000);

  it('as restrições das tabelas (V119): situação, forma, ativa sem pagamento, franquia pela metade, duas assinaturas vivas, a fatura paga sem a hora e duas mensalidades do mesmo período', async () => {
    const e = await empresa('Casa Brasa Restrições');
    expect((await assinar(e)).status).toBe(200);
    const [s] = await ownerQuery<{ id: string; plan_id: string }>(`select id, plan_id from liame.subscription where brand_id = $1`, [e.brandId]);
    const erro = async (sqlText: string, params: unknown[]) => {
      try {
        await ownerQuery(sqlText, params);
        return null;
      } catch (err) {
        return (err as { constraint?: string }).constraint ?? (err as { code?: string }).code ?? 'erro';
      }
    };
    expect(await erro(`update liame.subscription set status = 'pausada' where id = $1`, [s!.id])).toBe('subscription_status_check');
    expect(await erro(`update liame.subscription set method = 'boleto' where id = $1`, [s!.id])).toBe('subscription_method_check');
    // Ativa sem o primeiro pagamento: não.
    expect(await erro(`update liame.subscription set status = 'ativa' where id = $1`, [s!.id])).toBe('subscription_espera');
    expect(
      await erro(
        `insert into liame.billing_plan (id, key, version, name, price_cents, agents, ai_daily_usd_micros, offered) values (gen_random_uuid(), 'teste_meio', 1, 'Teste', 100, array['lia'], 1000, false)`,
        [],
      ),
    ).toBe('billing_plan_franquia');
    expect(
      await erro(
        `insert into liame.billing_plan (id, key, version, name, price_cents, agents, ai_daily_usd_micros, ai_monthly_usd_micros, offered) values (gen_random_uuid(), 'teste_inteira', 1, 'Teste', 100, array['lia'], 1000, 30000, false)`,
        [],
      ),
    ).toBeNull();
    await ownerQuery(`delete from liame.billing_plan where key = 'teste_inteira'`);
    expect(await erro(`insert into liame.subscription (id, tenant_id, brand_id, plan_id, method) values (gen_random_uuid(), $1, $2, $3, 'pix')`, [e.tenantId, e.brandId, s!.plan_id])).toBe('uq_subscription_viva');

    // Paga: a fatura volta a aberta com a hora do pagamento? Não.
    const f = await emAberto(e);
    await pagar(f.id, new Date());
    expect(await erro(`update liame.billing_invoice set status = 'aberta' where id = $1`, [f.id])).toBe('billing_invoice_paga');
    // Uma segunda mensalidade do mesmo período não entra; a cancelada não conta.
    const [p] = await ownerQuery<{ period_start: string; period_end: string }>(`select period_start::text, period_end::text from liame.billing_invoice where id = $1`, [f.id]);
    const outra = `insert into liame.billing_invoice (id, tenant_id, brand_id, subscription_id, kind, plan_id, period_start, period_end, due_date, amount_cents, status, canceled_at)
                   values (gen_random_uuid(), $1, $2, $3, 'mensalidade', $4, $5, $6, $5, 24900, $7, $8)`;
    expect(await erro(outra, [e.tenantId, e.brandId, s!.id, s!.plan_id, p!.period_start, p!.period_end, 'aberta', null])).toBe('uq_billing_invoice_periodo');
    expect(await erro(outra, [e.tenantId, e.brandId, s!.id, s!.plan_id, p!.period_start, p!.period_end, 'cancelada', new Date().toISOString()])).toBeNull();
  }, 60_000);
});
