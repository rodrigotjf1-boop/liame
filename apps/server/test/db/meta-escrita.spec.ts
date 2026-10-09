import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { type Database, runMigrations, withTenant } from '@liame/database';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { BudgetService } from '../../src/actions/budget.service.js';
import type { ReadResult } from '../../src/actions/connectors.js';
import { type EstadoDoObjeto, USO_PARA_ESPERAR_PCT } from '../../src/actions/meta-anuncios.js';
import { canonicalJson, sha256 } from '../../src/audit/audit.js';
import { DATABASE } from '../../src/database/database.module.js';
import { FlagService } from '../../src/flags/flag.service.js';
import { KillSwitchService } from '../../src/kill-switch/kill-switch.service.js';
import { ActionExecutor, MAX_ADIAMENTOS } from '../../src/worker/action-executor.js';
import { ownerQuery, resetIpRateLimits, signupAndLogin, startApi, type TestApi } from '../helpers/api.js';
import {
  type EmpresaComMeta,
  empresaComMeta,
  lerNaMetaDeMentira,
  ligarConectorNaMetaDeMentira,
  ligarEscritaNaMeta,
  MetaDeMentira,
  type ObjetoNaMeta,
  objetoLido,
  SEGREDO_DO_APP_DA_META,
  type TipoDeObjeto,
  TOKEN_DA_META,
} from '../helpers/meta-de-mentira.js';
import { hasDb, OWNER_URL } from './env.js';

// A4 · X1: o conector de escrita da Meta contra uma Graph API local (`helpers/meta-de-mentira.ts`), que segue a
// referência conferida em 04/10/2026 (`POST /{id}` com `status` e `daily_budget` na menor unidade da moeda;
// `execution_options=["validate_only"]` não muda nada; resposta `{"success": true}`; erros com `code`, `error_subcode`
// e `error_user_msg`; cabeçalho de uso). Aqui o pedido aprovado entra direto no banco, e o caminho provado é o do
// executor (flag, aprovação, validação, escrita, conferência e espera). O caminho pela API (pedido, política,
// aprovação com o código do app e a volta) é o de `meta-ferramentas.spec.ts` (X2).

const REAL = 1_000_000;

type Acao = { status: string; status_reason: string | null; attempts: number; next_attempt_at: string | null; execution?: { status: string; provider_reply?: { text: string; code: string | null } | null } | null; workflow: { status: string; steps: { name: string; status: string; attempts: number }[] } };

describe.skipIf(!hasDb)('escrita na Meta: conector e execução (A4 · X1)', () => {
  let api: TestApi;
  let database: Database;
  let executor: ActionExecutor;
  let budget: BudgetService;
  let e: EmpresaComMeta;

  // ---- a Meta de mentira (uma conta de anúncios por execução do arquivo)
  const meta = new MetaDeMentira();
  const { objetos, chamadas, defeitos } = meta;
  const CONTA = meta.conta;
  const OUTRA_CONTA = meta.outraConta;
  const erro = (code: number, message: string, extra: Record<string, unknown> = {}) => meta.erro(code, message, extra);
  const chamadasDe = (id: string) => meta.chamadasDe(id);
  const escritasDe = (id: string) => meta.escritasDe(id);
  const resumo = (id: string) => meta.resumo(id);

  // ---- o Liame do teste
  /** Um objeto novo na Meta e na lista que o Liame leu da conta. */
  const objeto = (tipo: TipoDeObjeto, extra: Partial<ObjetoNaMeta> = {}, opcoes: { conta?: string; semLinha?: boolean } = {}) => objetoLido(meta, e, tipo, extra, opcoes);
  const ler = (recurso: string, conta = e.conta, tenantId = e.tenantId) => lerNaMetaDeMentira(api, tenantId, conta, recurso);

  /** O pedido aprovado, como o Action Service o grava: o estado lido na Meta, a versão dele e o estado desejado. */
  async function pedidoAprovado(
    recurso: string,
    mudar: Partial<EstadoDoObjeto>,
    opcoes: { reserva?: number; ferramenta?: string; acao?: string; conta?: string; aprovacao?: 'nenhuma' | 'de_outro_plano' } = {},
  ): Promise<{ id: string; antes: ReadResult }> {
    const antes = await ler(recurso, opcoes.conta ?? e.conta);
    if (!antes) throw new Error(`recurso ${recurso} não lido`);
    const desejado = { ...antes.state, ...mudar };
    const id = randomUUID();
    const hash = sha256(canonicalJson({ id, desejado, versao: antes.version }));
    await ownerQuery(
      `insert into liame.action_request (id, tenant_id, brand_id, tool, action, provider, account_id, resource_id, params, risk_level, budget_impact, reserved_micros,
                                         before_state, before_version, desired_state, plan_hash, action_fingerprint, mode, policy_decision, status, requested_by, expires_at)
       values ($1, $2, $3, $4, $5, 'meta_ads', $6, $7, '{}'::jsonb, 'R3', 'none', $8, $9::jsonb, $10, $11::jsonb, $12, $13, 'APPROVAL',
               '{"allowed": true, "mode": "APPROVAL", "violations": [], "versions": ["plataforma@2"]}'::jsonb, 'aprovada', $14, now() + interval '3 days')`,
      [
        id,
        e.tenantId,
        e.brandId,
        opcoes.ferramenta ?? 'orcamento_ajustar',
        opcoes.acao ?? 'orcamento.reduzir',
        opcoes.conta ?? e.conta,
        recurso,
        opcoes.reserva ?? 0,
        JSON.stringify(antes.state),
        antes.version,
        JSON.stringify(desejado),
        hash,
        sha256(`${id}:${recurso}`),
        e.userId,
      ],
    );
    if (opcoes.aprovacao !== 'nenhuma') {
      await ownerQuery(
        `insert into liame.approval (id, tenant_id, action_request_id, plan_hash, approved_by, approver_role, approver_limit_micros, sufficient, method)
         values (gen_random_uuid(), $1, $2, $3, $4, 'dono', null, true, 'totp')`,
        [e.tenantId, id, opcoes.aprovacao === 'de_outro_plano' ? sha256(`${hash}:antes`) : hash, e.userId],
      );
    }
    if (opcoes.reserva) await withTenant(database.db, e.tenantId, (tx) => budget.reserve(tx, { tenantId: e.tenantId, brandId: e.brandId, actionId: id, amountMicros: opcoes.reserva! }));
    return { id, antes };
  }

  const ciclo = () => executor.runCycle(20, { tenantIds: [e.tenantId] });
  const acao = async (id: string) => (await api.call('GET', `/v1/actions/${id}`, { cookie: e.cookie })).body as Acao;
  const execucoes = (id: string) =>
    ownerQuery<{ status: string; error: string | null; result_state: (EstadoDoObjeto & { conferido?: boolean; sem_escrita?: boolean }) | null; observed_state: EstadoDoObjeto | null }>(
      `select status, error, result_state, observed_state from liame.action_execution where action_request_id = $1 order by finished_at, id`,
      [id],
    );
  const naHora = (id: string) => ownerQuery(`update liame.action_request set next_attempt_at = now() where id = $1`, [id]);
  const esperaEmMinutos = async (id: string) =>
    (await ownerQuery<{ m: number }>(`select round(extract(epoch from (next_attempt_at - now())) / 60)::int as m from liame.action_request where id = $1`, [id]))[0]!.m;
  const livroDe = async (id: string) =>
    (await ownerQuery<{ kind: string; amount_micros: string }>(`select kind, amount_micros::text from liame.budget_ledger_entry where action_request_id = $1 order by created_at, id`, [id])).map((l) => [l.kind, Number(l.amount_micros)]);

  const ligarFlag = (valor: boolean) => ligarEscritaNaMeta(api, e.tenantId, valor);

  beforeAll(async () => {
    await runMigrations({ connectionString: OWNER_URL, dir: resolve(process.cwd(), '../../packages/database/migrations') });
    await meta.ligar();
    api = await startApi();
    await resetIpRateLimits();
    database = api.app.get(DATABASE);
    budget = api.app.get(BudgetService);
    executor = new ActionExecutor(database, budget, api.app.get(KillSwitchService), api.app.get(FlagService));
    ligarConectorNaMetaDeMentira(api, meta);
    e = await empresaComMeta(api, meta, 'Mister Burgers Escrita na Meta');
    await ligarFlag(true);
    // Cadastro, app autenticador e cofre: com a suíte inteira rodando junto, pode passar do prazo padrão dos ganchos.
  }, 120_000);
  beforeEach(() => {
    meta.normalizar();
  });
  afterAll(async () => {
    if (e) await ligarFlag(false);
    await api?.close();
    await meta.desligar();
  });

  it('o estado é lido na Meta, com a versão tirada dele; o que não é da conta, não é da empresa ou sumiu não existe', async () => {
    const c = await objeto('campanha', { name: 'Delivery noite' });
    const lido = await ler(c.recurso);
    expect(lido!.state).toEqual({ tipo: 'campanha', id: c.id, nome: 'Delivery noite', status: 'ativo', status_efetivo: 'ACTIVE', daily_budget_micros: 30 * REAL, lifetime_budget_micros: null, moeda: 'BRL' });
    // A versão é a mesma enquanto a situação e a verba forem as mesmas, e muda com elas.
    expect((await ler(c.recurso))!.version).toBe(lido!.version);
    objetos.get(c.id)!.daily_budget = '2500';
    expect((await ler(c.recurso))!.version).not.toBe(lido!.version);
    // O anúncio não tem verba; a verba "0" (a que mora em outro nível) é "não tem".
    const a = await objeto('anuncio', { status: 'PAUSED', effective_status: 'CAMPAIGN_PAUSED' });
    expect((await ler(a.recurso))!.state).toMatchObject({ tipo: 'anuncio', status: 'pausado', status_efetivo: 'CAMPAIGN_PAUSED', daily_budget_micros: null });
    const semVerba = await objeto('conjunto', { daily_budget: '0', lifetime_budget: '90000' });
    expect((await ler(semVerba.recurso))!.state).toMatchObject({ daily_budget_micros: null, lifetime_budget_micros: 900 * REAL });

    // O que não existe para esta empresa: recurso torto, objeto que o Liame não leu desta conta, objeto de outra conta
    // na Meta, objeto apagado lá, conta de outra empresa.
    expect(await ler('cupom:SEXTA15')).toBeNull();
    expect(await ler(`conjunto:${c.id}`)).toBeNull();
    const naoLido = await objeto('campanha', {}, { semLinha: true });
    expect(await ler(naoLido.recurso)).toBeNull();
    const deOutraConta = await objeto('campanha', { account_id: OUTRA_CONTA });
    expect(await ler(deOutraConta.recurso)).toBeNull();
    const apagado = await objeto('campanha');
    objetos.delete(apagado.id);
    expect(await ler(apagado.recurso)).toBeNull();
    const outra = await signupAndLogin(api, undefined, 'Outra Empresa Escrita na Meta');
    expect(await ler(c.recurso, e.conta, outra.me.active_organization_id as string)).toBeNull();

    // O token foi no cabeçalho, com a prova do segredo do app, em toda chamada.
    expect(defeitos).toEqual([]);
    expect(chamadas.every((x) => x.metodo === 'GET')).toBe(true);
  });

  it('A4-1: valida na Meta antes, escreve depois e confere; a verba vai em centavos', async () => {
    const c = await objeto('campanha', { name: 'Delivery noite' });
    const { id } = await pedidoAprovado(c.recurso, { daily_budget_micros: 24 * REAL });
    chamadas.length = 0;
    await ciclo();

    expect(resumo(c.id)).toEqual(['ler', 'validar', 'ler', 'escrever', 'ler']);
    const [validou, escreveu] = escritasDe(c.id);
    expect(validou!.params).toEqual({ daily_budget: '2400', execution_options: '["validate_only"]' });
    expect(escreveu!.params).toEqual({ daily_budget: '2400' });
    expect(objetos.get(c.id)!.daily_budget).toBe('2400');

    expect(await acao(id)).toMatchObject({ status: 'executada', status_reason: null, attempts: 0, next_attempt_at: null, workflow: { status: 'concluido' } });
    const [exec] = await execucoes(id);
    expect(exec).toMatchObject({ status: 'executada', error: null, result_state: { tipo: 'campanha', status: 'ativo', daily_budget_micros: 24 * REAL, conferido: true } });
    const [auditoria] = await ownerQuery<{ action: string; actor_type: string; origin: string }>(`select action, actor_type, origin from liame.audit_event where resource_id = $1 order by chain_seq desc limit 1`, [id]);
    expect(auditoria).toEqual({ action: 'acao.executar', actor_type: 'system', origin: 'worker' });
    expect(defeitos).toEqual([]);
  });

  it('A4-1: a validação da Meta recusou: nada é escrito, o motivo é o que a Meta escreveu, e não se tenta de novo', async () => {
    const c = await objeto('campanha');
    const { id } = await pedidoAprovado(c.recurso, { daily_budget_micros: 5 * REAL });
    chamadas.length = 0;
    await ciclo();
    expect(resumo(c.id)).toEqual(['ler', 'validar']);
    expect(objetos.get(c.id)!.daily_budget).toBe('3000');
    expect(await acao(id)).toMatchObject({ status: 'falhou', status_reason: 'A Meta recusou a mudança: O orçamento diário precisa ser de pelo menos R$ 6,00.', attempts: 0, next_attempt_at: null });
    // A resposta do pedido separa o que a Meta escreveu do que o Liame diz em volta (a tela põe entre aspas só o dela).
    expect((await acao(id)).execution).toMatchObject({ status: 'falhou', provider_reply: { text: 'O orçamento diário precisa ser de pelo menos R$ 6,00.', code: null } });
    expect((await execucoes(id)).map((x) => x.status)).toEqual(['falhou']);
    await ciclo();
    expect(resumo(c.id)).toEqual(['ler', 'validar']);
  });

  it('A4-2: sem a aprovação de uma pessoa para o plano atual, nada é lido nem escrito na Meta', async () => {
    const [c1, c2] = [await objeto('campanha'), await objeto('campanha')];
    // Marcada como aprovada sem aprovação nenhuma, e com a aprovação de um plano que já mudou.
    const semAprovacao = await pedidoAprovado(c1.recurso, { daily_budget_micros: 24 * REAL }, { aprovacao: 'nenhuma' });
    const planoMudou = await pedidoAprovado(c2.recurso, { daily_budget_micros: 24 * REAL }, { aprovacao: 'de_outro_plano' });
    chamadas.length = 0;
    await ciclo();
    for (const [p, o] of [
      [semAprovacao, c1],
      [planoMudou, c2],
    ] as const) {
      expect(await acao(p.id)).toMatchObject({ status: 'falhou', status_reason: 'sem aprovação válida para o plano atual' });
      expect(chamadasDe(o.id)).toEqual([]);
      expect(objetos.get(o.id)!.daily_budget).toBe('3000');
      expect((await execucoes(p.id)).map((x) => x.status)).toEqual(['bloqueada']);
    }
  });

  it('pausar e retomar: campanha, conjunto e anúncio mudam só a situação', async () => {
    const [c, s, a] = [await objeto('campanha'), await objeto('conjunto'), await objeto('anuncio')];
    for (const o of [c, s, a]) await pedidoAprovado(o.recurso, { status: 'pausado' }, { ferramenta: 'anuncio_pausar', acao: 'anuncio.pausar' });
    chamadas.length = 0;
    await ciclo();
    for (const o of [c, s, a]) {
      expect(escritasDe(o.id).map((x) => x.params)).toEqual([{ status: 'PAUSED', execution_options: '["validate_only"]' }, { status: 'PAUSED' }]);
      expect(objetos.get(o.id)!.status).toBe('PAUSED');
    }
    // Retomar: o que estava pausado volta a ativo, pela mesma validação.
    const { id } = await pedidoAprovado(a.recurso, { status: 'ativo' }, { ferramenta: 'anuncio_pausar', acao: 'anuncio.pausar' });
    await ciclo();
    expect(objetos.get(a.id)!.status).toBe('ACTIVE');
    expect((await execucoes(id))[0]!.result_state).toMatchObject({ status: 'ativo', conferido: true });
  });

  it('A4-4: alguém mudou o objeto na Meta depois do pedido: nada é sobrescrito', async () => {
    const c = await objeto('campanha');
    const { id } = await pedidoAprovado(c.recurso, { daily_budget_micros: 24 * REAL });
    // Entre a aprovação e a execução, uma pessoa subiu a verba na Meta.
    objetos.get(c.id)!.daily_budget = '4500';
    chamadas.length = 0;
    await ciclo();
    expect(resumo(c.id)).toEqual(['ler']);
    expect(objetos.get(c.id)!.daily_budget).toBe('4500');
    expect(await acao(id)).toMatchObject({ status: 'falhou', status_reason: 'o recurso mudou desde o pedido; nada foi sobrescrito' });
    expect(await execucoes(id)).toMatchObject([{ status: 'estado_mudou', observed_state: { daily_budget_micros: 45 * REAL } }]);

    // Pausado por alguém: a mudança de verba também não entra.
    const outro = await objeto('conjunto');
    const p = await pedidoAprovado(outro.recurso, { daily_budget_micros: 20 * REAL });
    objetos.get(outro.id)!.status = 'PAUSED';
    await ciclo();
    expect(escritasDe(outro.id)).toEqual([]);
    expect((await acao(p.id)).status).toBe('falhou');
  });

  it('o que o Liame não muda é recusado sem chamar a escrita: verba de outro nível, objeto arquivado, fração de centavo', async () => {
    const semVerba = await objeto('conjunto', { daily_budget: '0' });
    const arquivado = await objeto('campanha');
    const fracao = await objeto('campanha');
    const p1 = await pedidoAprovado(semVerba.recurso, { daily_budget_micros: 20 * REAL });
    const p2 = await pedidoAprovado(arquivado.recurso, { status: 'pausado' });
    // Arquivado na Meta depois do pedido, por outra pessoa: o estado mudou, e a mudança humana vence.
    objetos.get(arquivado.id)!.status = 'ARCHIVED';
    const p3 = await pedidoAprovado(fracao.recurso, { daily_budget_micros: 24_995_000 });
    await ciclo();
    expect((await acao(p1.id)).status_reason).toBe('Este objeto não tem verba diária: a verba fica em outro nível, ou é de período.');
    expect((await acao(p2.id)).status_reason).toBe('o recurso mudou desde o pedido; nada foi sobrescrito');
    expect((await acao(p3.id)).status_reason).toBe('A verba diária precisa ser um valor positivo, sem fração de centavo.');
    for (const o of [semVerba, arquivado, fracao]) expect(escritasDe(o.id)).toEqual([]);
  });

  it('a Meta recusa de vez: sem permissão de gerenciar anúncios, autorização vencida e objeto apagado', async () => {
    const c = await objeto('campanha');
    const semPermissao = await pedidoAprovado(c.recurso, { daily_budget_micros: 24 * REAL });
    meta.falhasDaEscrita = [{ status: 400, corpo: erro(200, '(#200) Requires ads_management permission to manage the object') }];
    await ciclo();
    const a1 = await acao(semPermissao.id);
    expect(a1.status).toBe('falhou');
    expect(a1.status_reason).toContain('não tem permissão para gerenciar os anúncios desta conta');
    expect(resumo(c.id).filter((x) => x === 'escrever')).toEqual([]);

    // Conta sem a autorização guardada (revogada): recusa com o que fazer, sem chamar a Meta.
    const semToken = await objeto('campanha', { account_id: OUTRA_CONTA }, { conta: e.contaSemToken });
    const id = randomUUID();
    const estado: EstadoDoObjeto = { tipo: 'campanha', id: semToken.id, nome: 'x', status: 'ativo', status_efetivo: 'ACTIVE', daily_budget_micros: 30 * REAL, lifetime_budget_micros: null, moeda: 'BRL' };
    await ownerQuery(
      `insert into liame.action_request (id, tenant_id, brand_id, tool, action, provider, account_id, resource_id, params, risk_level, budget_impact, reserved_micros,
                                         before_state, before_version, desired_state, plan_hash, action_fingerprint, mode, policy_decision, status, requested_by, expires_at)
       values ($1, $2, $3, 'orcamento_ajustar', 'orcamento.reduzir', 'meta_ads', $4, $5, '{}'::jsonb, 'R3', 'none', 0, $6::jsonb, 1, $7::jsonb, $8, $9, 'APPROVAL',
               '{"allowed": true, "mode": "APPROVAL", "violations": [], "versions": ["plataforma@2"]}'::jsonb, 'aprovada', $10, now() + interval '3 days')`,
      [id, e.tenantId, e.brandId, e.contaSemToken, semToken.recurso, JSON.stringify(estado), JSON.stringify({ ...estado, daily_budget_micros: 24 * REAL }), sha256(id), sha256(`${id}:f`), e.userId],
    );
    await ownerQuery(`insert into liame.approval (id, tenant_id, action_request_id, plan_hash, approved_by, approver_role, sufficient, method) values (gen_random_uuid(), $1, $2, $3, $4, 'dono', true, 'totp')`, [e.tenantId, id, sha256(id), e.userId]);
    chamadas.length = 0;
    await ciclo();
    expect((await acao(id)).status_reason).toBe('A Meta recusou o acesso desta conta (a autorização foi revogada ou venceu). Conecte a Meta de novo em Contas conectadas.');
    expect(chamadasDe(semToken.id)).toEqual([]);

    // A leitura antes de mudar deu um erro definitivo que não é "o objeto não existe": o motivo aparece, e nada é escrito.
    const campo = await objeto('campanha');
    const pc = await pedidoAprovado(campo.recurso, { daily_budget_micros: 24 * REAL });
    meta.falhasDaLeitura = [{ status: 400, corpo: erro(100, '(#100) Tried accessing nonexisting field (account_id) on node type (Campaign)') }];
    await ciclo();
    expect((await acao(pc.id)).status_reason).toBe('A Meta não deixou ler o objeto antes de mudar: (#100) Tried accessing nonexisting field (account_id) on node type (Campaign). Nada foi mudado.');
    expect(escritasDe(campo.id)).toEqual([]);

    // Apagado na Meta entre o pedido e a execução.
    const apagado = await objeto('anuncio');
    const p = await pedidoAprovado(apagado.recurso, { status: 'pausado' });
    objetos.delete(apagado.id);
    await ciclo();
    expect((await acao(p.id)).status_reason).toBe('A Meta não tem mais este objeto nesta conta (foi apagado, ou a conta foi desconectada). Nada foi mudado.');
  });

  it('A4-3: a Meta manda esperar: a ação é adiada pelo tempo pedido, não é tentada antes da hora e executa depois', async () => {
    const c = await objeto('campanha');
    const { id } = await pedidoAprovado(c.recurso, { daily_budget_micros: 33 * REAL }, { reserva: 3 * REAL, acao: 'orcamento.aumentar' });
    // "User request limit reached", com o tempo para voltar a ter acesso no cabeçalho de uso (12 minutos).
    meta.falhasDaEscrita = [
      {
        status: 400,
        corpo: erro(17, 'User request limit reached', { error_subcode: 2446079 }),
        cabecalhos: { 'x-business-use-case-usage': JSON.stringify({ [CONTA]: [{ type: 'ads_management', call_count: 100, total_cputime: 30, total_time: 30, estimated_time_to_regain_access: 12 }] }) },
      },
    ];
    chamadas.length = 0;
    await ciclo();
    expect(resumo(c.id)).toEqual(['ler', 'validar']);
    const adiada = await acao(id);
    expect(adiada).toMatchObject({ status: 'aprovada', status_reason: 'a Meta pediu para esperar (limite de uso da conta)', attempts: 1, workflow: { status: 'em_andamento' } });
    expect(adiada.next_attempt_at).not.toBeNull();
    expect(await esperaEmMinutos(id)).toBe(12);
    expect(adiada.workflow.steps.find((s) => s.name === 'execucao')).toMatchObject({ status: 'aguardando' });
    expect((await execucoes(id)).map((x) => [x.status, x.error])).toEqual([['adiada', 'a Meta pediu para esperar (limite de uso da conta)']]);
    // A reserva do envelope continua: a ação segue aprovada.
    expect(await livroDe(id)).toEqual([['reserva', 3 * REAL]]);
    const [auditoria] = await ownerQuery<{ action: string }>(`select action from liame.audit_event where resource_id = $1 order by chain_seq desc limit 1`, [id]);
    expect(auditoria!.action).toBe('acao.adiar');

    // Antes da hora, o executor nem olha para ela: nenhuma chamada sai.
    await ciclo();
    await ciclo();
    expect(resumo(c.id)).toEqual(['ler', 'validar']);

    await naHora(id);
    await ciclo();
    expect(await acao(id)).toMatchObject({ status: 'executada', status_reason: null, attempts: 1, next_attempt_at: null });
    expect(objetos.get(c.id)!.daily_budget).toBe('3300');
    expect((await execucoes(id)).map((x) => x.status)).toEqual(['adiada', 'executada']);
    expect(await livroDe(id)).toEqual([
      ['reserva', 3 * REAL],
      ['execucao', 3 * REAL],
    ]);
  });

  it('A4-3: a quinta mudança de verba na hora espera uma hora; o uso alto da conta adia antes de escrever', async () => {
    const s = await objeto('conjunto');
    const { id } = await pedidoAprovado(s.recurso, { daily_budget_micros: 27 * REAL });
    // A validação passa; a escrita bate no limite de 4 mudanças de verba por hora do conjunto.
    meta.falhasDaEscrita = [{ status: 200, corpo: { success: true } }, { status: 400, corpo: erro(613, 'You can only change your ad set budget 4 times per hour', { error_subcode: 1487632 }) }];
    await ciclo();
    expect(await acao(id)).toMatchObject({ status: 'aprovada', attempts: 1 });
    expect(await esperaEmMinutos(id)).toBe(60);
    expect(objetos.get(s.id)!.daily_budget).toBe('3000');

    // Uso da conta no limite, visto na leitura: a escrita nem é tentada.
    const c = await objeto('campanha');
    const p = await pedidoAprovado(c.recurso, { status: 'pausado' });
    meta.uso = JSON.stringify({ [CONTA]: [{ type: 'ads_management', call_count: USO_PARA_ESPERAR_PCT + 2, total_cputime: 10, total_time: 10, estimated_time_to_regain_access: 0 }] });
    chamadas.length = 0;
    await ciclo();
    expect(resumo(c.id)).toEqual(['ler']);
    expect(await acao(p.id)).toMatchObject({ status: 'aprovada', status_reason: 'a Meta pediu para esperar (limite de uso da conta)', attempts: 1 });
    expect(await esperaEmMinutos(p.id)).toBe(5);
    // Com o uso de volta ao normal, executa.
    meta.uso = null;
    await naHora(p.id);
    await ciclo();
    expect((await acao(p.id)).status).toBe('executada');
    expect(objetos.get(c.id)!.status).toBe('PAUSED');
  });

  it('a Meta aceitou, mas a resposta se perdeu: a ação é adiada e, na volta, vê que já está feito, sem escrever de novo', async () => {
    const c = await objeto('campanha');
    const { id } = await pedidoAprovado(c.recurso, { daily_budget_micros: 24 * REAL });
    meta.falhasDaEscrita = [{ status: 200, corpo: { success: true } }, { status: 500, corpo: erro(2, 'Service temporarily unavailable'), aplicaAntes: true }];
    chamadas.length = 0;
    await ciclo();
    expect(objetos.get(c.id)!.daily_budget).toBe('2400');
    expect(await acao(id)).toMatchObject({ status: 'aprovada', status_reason: 'a Meta não respondeu', attempts: 1 });
    expect(await esperaEmMinutos(id)).toBe(1);

    await naHora(id);
    await ciclo();
    // Uma escrita só (a que se perdeu): na volta, a leitura mostra o objeto como o pedido queria.
    expect(resumo(c.id)).toEqual(['ler', 'validar', 'ler', 'escrever', 'ler', 'ler']);
    expect(await acao(id)).toMatchObject({ status: 'executada', status_reason: null });
    expect((await execucoes(id)).at(-1)).toMatchObject({ status: 'executada', result_state: { daily_budget_micros: 24 * REAL, conferido: true, sem_escrita: true } });
  });

  it('a Meta aceitou, mas a leitura depois não mostra a mudança: executada, com "não conferido" no resultado', async () => {
    const c = await objeto('campanha');
    const { id } = await pedidoAprovado(c.recurso, { daily_budget_micros: 24 * REAL });
    // A validação passa e a escrita "dá certo" sem mudar nada (leitura atrasada do lado da Meta).
    meta.falhasDaEscrita = [{ status: 200, corpo: { success: true } }, { status: 200, corpo: { success: true } }];
    chamadas.length = 0;
    await ciclo();
    expect(resumo(c.id)).toEqual(['ler', 'validar', 'ler', 'escrever', 'ler', 'ler']);
    expect((await acao(id)).status).toBe('executada');
    expect((await execucoes(id))[0]).toMatchObject({ status: 'executada', result_state: { daily_budget_micros: 30 * REAL, conferido: false } });

    // Resposta sem o `success`: não é dada como feita.
    const outro = await objeto('campanha');
    const p = await pedidoAprovado(outro.recurso, { daily_budget_micros: 24 * REAL });
    meta.falhasDaEscrita = [{ status: 200, corpo: { success: true } }, { status: 200, corpo: {} }];
    await ciclo();
    expect(await acao(p.id)).toMatchObject({ status: 'falhou', status_reason: 'A Meta não confirmou a mudança. Nada foi dado como feito: confira o objeto na Meta.' });
  });

  it(`depois de ${MAX_ADIAMENTOS} esperas, a ação se encerra e a reserva volta ao envelope`, async () => {
    const c = await objeto('campanha');
    const { id } = await pedidoAprovado(c.recurso, { daily_budget_micros: 36 * REAL }, { reserva: 6 * REAL, acao: 'orcamento.aumentar' });
    const esperas: number[] = [];
    for (let tentativa = 1; tentativa <= MAX_ADIAMENTOS; tentativa++) {
      meta.falhasDaEscrita = [{ status: 400, corpo: erro(80004, 'There have been too many calls to this ad-account') }];
      await naHora(id);
      await ciclo();
      const a = await acao(id);
      if (a.status === 'aprovada') esperas.push(await esperaEmMinutos(id));
      expect(a.attempts).toBe(tentativa < MAX_ADIAMENTOS ? tentativa : MAX_ADIAMENTOS - 1);
    }
    // 1 minuto, dobrando a cada espera.
    expect(esperas).toEqual([1, 2, 4, 8, 16]);
    const fim = await acao(id);
    expect(fim.status).toBe('falhou');
    expect(fim.status_reason).toBe(
      `a Meta pediu para esperar (limite de uso da conta); depois de ${MAX_ADIAMENTOS} tentativas, a ação foi encerrada. Confira o objeto na plataforma e peça de novo, se ainda fizer sentido.`,
    );
    expect(fim.next_attempt_at).toBeNull();
    expect(objetos.get(c.id)!.daily_budget).toBe('3000');
    expect((await execucoes(id)).map((x) => x.status)).toEqual([...Array.from({ length: MAX_ADIAMENTOS - 1 }, () => 'adiada'), 'falhou']);
    expect(await livroDe(id)).toEqual([
      ['reserva', 6 * REAL],
      ['liberacao', 6 * REAL],
    ]);
  });

  it('com a flag `meta_write` desligada, nada é lido nem escrito na Meta', async () => {
    const c = await objeto('campanha');
    const { id } = await pedidoAprovado(c.recurso, { daily_budget_micros: 24 * REAL });
    await ligarFlag(false);
    chamadas.length = 0;
    try {
      await ciclo();
      expect(chamadasDe(c.id)).toEqual([]);
      expect(await acao(id)).toMatchObject({ status: 'falhou', status_reason: 'escrita em meta_ads desligada' });
    } finally {
      await ligarFlag(true);
    }
  });

  it('o token da empresa não aparece no pedido, na execução nem na auditoria', async () => {
    const linhas = await ownerQuery<{ texto: string }>(
      `select coalesce(r.status_reason, '') || coalesce(r.before_state::text, '') || coalesce(r.desired_state::text, '') || coalesce(x.result_state::text, '') || coalesce(x.error, '') as texto
         from liame.action_request r left join liame.action_execution x on x.action_request_id = r.id where r.tenant_id = $1`,
      [e.tenantId],
    );
    const auditoria = await ownerQuery<{ texto: string }>(`select coalesce("before"::text, '') || coalesce("after"::text, '') as texto from liame.audit_event where tenant_id = $1`, [e.tenantId]);
    expect(linhas.length).toBeGreaterThan(10);
    for (const l of [...linhas, ...auditoria]) expect(l.texto.includes(TOKEN_DA_META) || l.texto.includes(SEGREDO_DO_APP_DA_META)).toBe(false);
    expect(defeitos).toEqual([]);
  });
});
