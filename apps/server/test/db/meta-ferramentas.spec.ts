import { resolve } from 'node:path';
import { ActionRecommendation, ClosedLoopAttentionResponse } from '@liame/contracts';
import { type Database, runMigrations, uuidv7 } from '@liame/database';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { BudgetService } from '../../src/actions/budget.service.js';
import { currentStep, totpCode } from '../../src/auth/totp.js';
import { DATABASE } from '../../src/database/database.module.js';
import { FlagService } from '../../src/flags/flag.service.js';
import { KillSwitchService } from '../../src/kill-switch/kill-switch.service.js';
import { diaNoFuso, menosDias } from '../../src/results/fora-do-normal.js';
import { ActionExecutor } from '../../src/worker/action-executor.js';
import { ownerQuery, resetIpRateLimits, startApi, type TestApi } from '../helpers/api.js';
import {
  type AcaoRecomendada,
  campanhaComRecomendacao as comRecomendacao,
  type EmpresaComMeta,
  empresaComMeta,
  type FalhaDaMeta,
  ligarConectorNaMetaDeMentira,
  ligarEscritaNaMeta,
  MetaDeMentira,
  objetoLido,
} from '../helpers/meta-de-mentira.js';
import { hasDb, OWNER_URL } from './env.js';

// A4 · X2: as ferramentas de anúncio na Meta, do pedido à volta, pela API e contra uma Graph API local
// (`helpers/meta-de-mentira.ts`): a pessoa pede (`POST /v1/actions`), a política da distribuição (versão 3) manda
// esperar a aprovação com o código do app, o executor valida e escreve na Meta, e a volta (`POST /v1/actions/{id}/undo`)
// passa pelo mesmo trilho. O conector em si (validação, espera, conferência) é provado em `meta-escrita.spec.ts`.

const REAL = 1_000_000;

describe.skipIf(!hasDb)('ferramentas de anúncio na Meta: do pedido à volta (A4 · X2)', () => {
  let api: TestApi;
  let database: Database;
  let executor: ActionExecutor;
  const meta = new MetaDeMentira();
  /** A empresa do piloto: com o teto por campanha e o teto do mês definidos. */
  let e: EmpresaComMeta;
  /** Uma empresa que ainda não definiu limite nenhum: nasce no primeiro teste que precisa dela (a preparação fica leve). */
  let semLimites: EmpresaComMeta | null = null;
  async function empresaSemLimites(): Promise<EmpresaComMeta> {
    if (!semLimites) {
      semLimites = await empresaComMeta(api, meta, 'Empresa Sem Limites Definidos');
      await ligarEscritaNaMeta(api, semLimites.tenantId, true);
    }
    return semLimites;
  }

  type Resposta = Awaited<ReturnType<TestApi['call']>>;

  const pedir = (emp: EmpresaComMeta, tool: string, recurso: string, params: Record<string, unknown> = {}, extra: Record<string, unknown> = {}): Promise<Resposta> =>
    api.call('POST', '/v1/actions', { cookie: emp.cookie, body: { tool, provider: 'meta_ads', account_id: emp.conta, resource_id: recurso, params, ...extra } });

  /** Aprova com o código do app de agora (o passo usado e o limite de tentativas são zerados: o teste aprova muito). */
  async function aprovar(emp: EmpresaComMeta, pedido: { id: string; plan_hash: string }): Promise<Resposta> {
    await ownerQuery(`update liame.app_user set totp_last_step = null where id = $1`, [emp.userId]);
    await ownerQuery(`delete from liame.rate_limit where key = $1`, [`segundo-fator:${emp.userId}`]);
    return api.call('POST', `/v1/actions/${pedido.id}/approve`, { cookie: emp.cookie, body: { plan_hash: pedido.plan_hash, code: totpCode(emp.secret, currentStep()) } });
  }

  const ciclo = (emp: EmpresaComMeta) => executor.runCycle(20, { tenantIds: [emp.tenantId] });
  const ver = async (emp: EmpresaComMeta, id: string) => (await api.call('GET', `/v1/actions/${id}`, { cookie: emp.cookie })).body;
  const cancelar = (emp: EmpresaComMeta, id: string) => api.call('POST', `/v1/actions/${id}/cancel`, { cookie: emp.cookie });
  const desfazer = (emp: EmpresaComMeta, id: string) => api.call('POST', `/v1/actions/${id}/undo`, { cookie: emp.cookie });
  const politica = (emp: EmpresaComMeta, rules: unknown[], brandId: string | null = null) => api.call('POST', '/v1/policies', { cookie: emp.cookie, body: { brand_id: brandId, document: { rules } } });
  const envelope = (emp: EmpresaComMeta, reais: number) => api.call('PUT', '/v1/budget/policies', { cookie: emp.cookie, body: { limit_micros: reais * REAL } });
  const pedidosDe = async (emp: EmpresaComMeta) => Number((await ownerQuery<{ n: string }>(`select count(*)::text as n from liame.action_request where tenant_id = $1`, [emp.tenantId]))[0]!.n);
  const livroDe = async (id: string) =>
    (await ownerQuery<{ kind: string; amount_micros: string }>(`select kind, amount_micros::text from liame.budget_ledger_entry where action_request_id = $1 order by created_at, id`, [id])).map((l) => [l.kind, Number(l.amount_micros)]);

  const hoje = diaNoFuso(new Date(), 'America/Sao_Paulo');
  /** Uma campanha lida da conta e a recomendação em aberto do Gestor de tráfego para ela, de hoje. */
  const campanhaComRecomendacao = (emp: EmpresaComMeta, tool: AcaoRecomendada, nome = 'Delivery noite') => comRecomendacao(meta, emp, tool, { dia: hoje, nome });
  const ligacaoDe = async (pedido: string) =>
    (await ownerQuery<{ shadow_decision_id: string | null }>(`select shadow_decision_id from liame.action_request where id = $1`, [pedido]))[0]!.shadow_decision_id;
  /** As sugestões do Gestor de tráfego na Atenção, pelo contrato inteiro (objetos estritos). */
  const sugestoes = async (emp: EmpresaComMeta) => {
    const r = await api.call('GET', `/v1/results/attention?brand_id=${emp.brandId}`, { cookie: emp.cookie });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    return ClosedLoopAttentionResponse.parse(r.body).items.filter((i) => i.kind.startsWith('sugestao_'));
  };

  /** Pede, aprova com o código do app e executa; devolve a ação como ficou. */
  async function executar(emp: EmpresaComMeta, tool: string, recurso: string, params: Record<string, unknown> = {}) {
    const p = await pedir(emp, tool, recurso, params);
    expect([p.status, p.body.status], JSON.stringify(p.body)).toEqual([201, 'aguardando_aprovacao']);
    expect((await aprovar(emp, p.body)).body.status).toBe('aprovada');
    await ciclo(emp);
    return ver(emp, p.body.id);
  }

  beforeAll(async () => {
    await runMigrations({ connectionString: OWNER_URL, dir: resolve(process.cwd(), '../../packages/database/migrations') });
    await meta.ligar();
    api = await startApi();
    await resetIpRateLimits();
    database = api.app.get(DATABASE);
    executor = new ActionExecutor(database, api.app.get(BudgetService), api.app.get(KillSwitchService), api.app.get(FlagService));
    ligarConectorNaMetaDeMentira(api, meta);

    e = await empresaComMeta(api, meta, 'Mister Burgers Ferramentas de Anúncio');
    await ligarEscritaNaMeta(api, e.tenantId, true);
    // O que a empresa define antes de o Liame aumentar verba: o teto por campanha e o teto do mês. O teto do mês conta
    // tudo o que as contas gastam e o que os pedidos de hoje acrescentam até o fim do mês (X4, D-A4-19): aqui ele é
    // folgado, porque o arquivo inteiro pede e executa aumentos e retomadas no mesmo dia. A conta do mês em si é
    // provada em `verba-do-mes.spec.ts`.
    expect((await politica(e, [{ type: 'max_value', action: 'orcamento.*', provider: 'meta_ads', max_micros: 150 * REAL }])).status).toBe(201);
    expect((await envelope(e, 1_000_000)).status).toBe(204);
    // Cadastro, app autenticador, cofre e política: com a suíte inteira rodando junto, passa do prazo padrão dos ganchos.
  }, 120_000);
  beforeEach(async () => {
    meta.normalizar();
    await resetIpRateLimits();
  });
  afterAll(async () => {
    for (const emp of [e, semLimites]) if (emp) await ligarEscritaNaMeta(api, emp.tenantId, false);
    await api?.close();
    await meta.desligar();
  });

  it('A4-2: a pessoa pede, a política manda esperar a aprovação com o código do app, e só então o Liame valida e escreve na Meta', async () => {
    const c = await objetoLido(meta, e, 'campanha', { name: 'Delivery noite' });
    meta.chamadas.length = 0;
    const p = await pedir(e, 'orcamento_ajustar', c.recurso, { daily_budget_micros: 27 * REAL });
    expect(p.status).toBe(201);
    expect(p.body).toMatchObject({
      tool: 'orcamento_ajustar',
      action: 'orcamento.reduzir',
      provider: 'meta_ads',
      // O pedido não disse a marca: vale a da conta conectada.
      brand_id: e.brandId,
      resource_id: c.recurso,
      risk_level: 'R3',
      budget_impact: 'decrease',
      value_micros: 27 * REAL,
      current_value_micros: 30 * REAL,
      reserved_micros: 0,
      mode: 'APPROVAL',
      status: 'aguardando_aprovacao',
      status_reason: null,
      // A regra é da distribuição (versão 3): na Meta, o que uma pessoa pede espera aprovação.
      policy: { allowed: true, mode: 'APPROVAL', violations: [], versions: ['plataforma@3', 'empresa@1'] },
      undoes: null,
      undone_by: null,
    });
    // O pedido leu o estado na Meta, e mais nada. Sem a aprovação, o executor nem olha para ele.
    expect(meta.resumo(c.id)).toEqual(['ler']);
    await ciclo(e);
    expect(meta.resumo(c.id)).toEqual(['ler']);
    expect(meta.objetos.get(c.id)!.daily_budget).toBe('3000');

    expect((await aprovar(e, p.body)).body).toMatchObject({ status: 'aprovada', approvals: [{ approver_role: 'dono', sufficient: true, current_plan: true }] });
    await ciclo(e);
    expect(await ver(e, p.body.id)).toMatchObject({ status: 'executada', status_reason: null, workflow: { status: 'concluido' } });
    // Na execução: lê e valida; lê, escreve e confere.
    expect(meta.resumo(c.id)).toEqual(['ler', 'ler', 'validar', 'ler', 'escrever', 'ler']);
    expect(meta.escritasDe(c.id).map((x) => x.params)).toEqual([{ daily_budget: '2700', execution_options: '["validate_only"]' }, { daily_budget: '2700' }]);
    expect(meta.objetos.get(c.id)!.daily_budget).toBe('2700');

    const trilha = await ownerQuery<{ action: string; actor_type: string; origin: string }>(
      `select action, actor_type, origin from liame.audit_event where chain_key = $1 and resource_id = $2 order by chain_seq`,
      [e.tenantId, p.body.id],
    );
    expect(trilha.map((t) => [t.action, t.actor_type, t.origin])).toEqual([
      ['acao.pedir', 'human', 'api'],
      ['acao.aprovar', 'human', 'api'],
      ['acao.executar', 'system', 'worker'],
    ]);
    expect(meta.defeitos).toEqual([]);
  });

  it('pausar e retomar pelo Liame: cada ferramenta no seu tipo de objeto; retomar reserva um dia da verba que volta a rodar', async () => {
    const c = await objetoLido(meta, e, 'campanha');
    // Ferramenta de anúncio numa campanha: engano de quem pede, recusado com o motivo, sem criar pedido.
    const engano = await pedir(e, 'anuncio_pausar', c.recurso);
    expect([engano.status, engano.body.code, engano.body.detail]).toEqual([422, 'plano-recusado', 'Esta ferramenta é para anúncio; o pedido aponta para campanha.']);

    const pausada = await executar(e, 'campanha_pausar', c.recurso);
    expect(pausada).toMatchObject({ status: 'executada', action: 'campanha.pausar', risk_level: 'R1', budget_impact: 'decrease', reserved_micros: 0 });
    expect(meta.objetos.get(c.id)!.status).toBe('PAUSED');
    expect((await pedir(e, 'campanha_pausar', c.recurso)).body.detail).toBe('A campanha já está em pausa.');

    const p = await pedir(e, 'campanha_retomar', c.recurso);
    expect(p.body).toMatchObject({
      action: 'campanha.retomar',
      risk_level: 'R2',
      budget_impact: 'new_spend',
      value_micros: 30 * REAL,
      current_value_micros: null,
      reserved_micros: 30 * REAL,
      mode: 'APPROVAL',
      status: 'aguardando_aprovacao',
    });
    await aprovar(e, p.body);
    await ciclo(e);
    expect((await ver(e, p.body.id)).status).toBe('executada');
    expect(meta.objetos.get(c.id)!.status).toBe('ACTIVE');
    expect(meta.escritasDe(c.id).map((x) => x.params)).toEqual([
      { status: 'PAUSED', execution_options: '["validate_only"]' },
      { status: 'PAUSED' },
      { status: 'ACTIVE', execution_options: '["validate_only"]' },
      { status: 'ACTIVE' },
    ]);
    expect(await livroDe(p.body.id)).toEqual([
      ['reserva', 30 * REAL],
      ['execucao', 30 * REAL],
    ]);
    expect((await pedir(e, 'campanha_retomar', c.recurso)).body.detail).toBe('Só dá para retomar o que está em pausa, e a campanha está ativa.');

    // Conjunto e anúncio, pelas ferramentas deles.
    const [s, a] = [await objetoLido(meta, e, 'conjunto'), await objetoLido(meta, e, 'anuncio')];
    expect((await executar(e, 'conjunto_pausar', s.recurso)).status).toBe('executada');
    expect((await executar(e, 'anuncio_pausar', a.recurso)).status).toBe('executada');
    expect([meta.objetos.get(s.id)!.status, meta.objetos.get(a.id)!.status]).toEqual(['PAUSED', 'PAUSED']);
    // O anúncio não tem verba própria: retomar não reserva nada, mas espera a aprovação como os outros.
    expect((await pedir(e, 'anuncio_retomar', a.recurso)).body).toMatchObject({ budget_impact: 'new_spend', reserved_micros: 0, status: 'aguardando_aprovacao' });
  });

  it('D-A4-6: aumentar verba e voltar a gastar só com o teto por campanha e o teto do mês que a empresa define; cada pedido mexe no máximo 10%', async () => {
    const sem = await empresaSemLimites();
    const c = await objetoLido(meta, sem, 'campanha');
    const pausada = await objetoLido(meta, sem, 'campanha', { status: 'PAUSED', effective_status: 'PAUSED' });
    const verba = (reais: number) => pedir(sem, 'orcamento_ajustar', c.recurso, { daily_budget_micros: reais * REAL });
    const antes = await pedidosDe(sem);

    // Reduzir e pausar diminuem o gasto: não dependem dos limites da empresa.
    const reduz = await verba(27);
    expect([reduz.status, reduz.body.status, reduz.body.policy.versions]).toEqual([201, 'aguardando_aprovacao', ['plataforma@3']]);
    await cancelar(sem, reduz.body.id);

    // Aumentar: falta o teto por campanha. O teto de outro provedor não serve.
    const osDois = 'Para aumentar a verba, a empresa precisa definir antes o teto do mês e o teto por campanha. Reduzir e pausar não dependem deles. Quem define é o Dono ou o Administrador, em Verba do mês.';
    const semTeto = await verba(33);
    expect([semTeto.status, semTeto.body.code, semTeto.body.title]).toEqual([422, 'teto-nao-definido', 'Falta o teto por campanha']);
    expect(semTeto.body.detail).toBe(osDois);
    expect((await politica(sem, [{ type: 'max_value', action: 'orcamento.*', provider: 'google_ads', max_micros: 500 * REAL }])).status).toBe(201);
    expect((await verba(33)).body.code).toBe('teto-nao-definido');

    // Com o teto por campanha, falta o teto do mês: nem aumentar, nem retomar.
    expect((await politica(sem, [{ type: 'max_value', action: 'orcamento.*', max_micros: 32 * REAL }])).status).toBe(201);
    const semEnvelope = await verba(32);
    expect([semEnvelope.status, semEnvelope.body.code, semEnvelope.body.title, semEnvelope.body.detail]).toEqual([422, 'envelope-nao-definido', 'Falta o teto do mês', osDois]);
    const semRetomar = await pedir(sem, 'campanha_retomar', pausada.recurso);
    expect([semRetomar.body.code, semRetomar.body.detail]).toEqual([
      'envelope-nao-definido',
      'Para retomar, a empresa precisa definir antes o teto do mês. Reduzir e pausar não dependem dele. Quem define é o Dono ou o Administrador, em Verba do mês.',
    ]);
    expect(await pedidosDe(sem)).toBe(antes + 1);
    expect((await envelope(sem, 100)).status).toBe(204);

    // Dentro do teto e dos 10%: passa, reservando a diferença de um dia.
    const ok = await verba(32);
    expect(ok.body).toMatchObject({ action: 'orcamento.aumentar', status: 'aguardando_aprovacao', reserved_micros: 2 * REAL, policy: { versions: ['plataforma@3', 'empresa@2'] } });
    await cancelar(sem, ok.body.id);
    // 10% cravados, mas acima do teto da empresa.
    const acima = await verba(33);
    expect([acima.status, acima.body.code]).toEqual([422, 'politica-negou']);
    expect(acima.body.errors).toEqual([{ path: 'politica.tenant.0', message: expect.stringMatching(/^A verba de R\$\s33,00 por dia passa do teto por campanha, que é de R\$\s32,00 por dia\.$/) }]);
    // Mais de 10% de uma vez, para baixo (o teto não entra na redução) e para cima (aqui, com o teto também).
    const menos = await verba(26);
    expect(menos.body.errors).toEqual([{ path: 'politica.platform.2', message: 'A variação de 13,33% passa do máximo de 10%.' }]);
    expect((await verba(34)).body.errors.map((x: { path: string }) => x.path)).toEqual(['politica.platform.2', 'politica.tenant.0']);
    // Os 20% que o plano permitia até 04/10/2026 também não passam mais.
    expect((await verba(24)).body.errors.map((x: { path: string }) => x.path)).toEqual(['politica.platform.2']);

    // Teto do mês menor do que o aumento acrescenta até o fim do mês (R$ 2,00 por dia, em qualquer dia do mês): negado.
    await envelope(sem, 1);
    const semSaldo = await verba(32);
    expect([semSaldo.status, semSaldo.body.code, semSaldo.body.title]).toEqual([422, 'orcamento-insuficiente', 'Não cabe na verba do mês']);
    expect(semSaldo.body.detail).toMatch(/^Não cabe na verba de [a-zç]+: o pedido acrescenta R\$\s\d+,00 até o fim do mês, e sobram R\$\s1,00\. No ritmo atual, [a-zç]+ fecha em R\$\s0,00, e o teto da empresa é de R\$\s1,00\.$/);
    // Nada disso chamou a escrita da Meta.
    expect(meta.escritasDe(c.id)).toEqual([]);
  });

  it('o teto da empresa não barra a redução: baixar uma verba que já está acima do teto é a direção segura', async () => {
    // Alguém definiu R$ 200,00 por dia na Meta; o teto por campanha da empresa é R$ 150,00.
    const c = await objetoLido(meta, e, 'campanha', { daily_budget: '20000' });
    const p = await pedir(e, 'orcamento_ajustar', c.recurso, { daily_budget_micros: 180 * REAL });
    expect([p.status, p.body.action, p.body.status]).toEqual([201, 'orcamento.reduzir', 'aguardando_aprovacao']);
    await cancelar(e, p.body.id);
    // Aumentar acima do teto, não.
    const sobe = await pedir(e, 'orcamento_ajustar', c.recurso, { daily_budget_micros: 210 * REAL });
    expect(sobe.body.errors.map((x: { path: string }) => x.path)).toEqual(['politica.tenant.0']);
  });

  it('no máximo 3 mudanças de verba por hora no mesmo objeto (a Meta aceita 4); outro objeto da conta segue livre', async () => {
    const [a, b] = [await objetoLido(meta, e, 'conjunto'), await objetoLido(meta, e, 'conjunto')];
    for (const verba of [27, 25, 23]) expect((await executar(e, 'orcamento_ajustar', a.recurso, { daily_budget_micros: verba * REAL })).status).toBe('executada');
    expect(meta.objetos.get(a.id)!.daily_budget).toBe('2300');

    const quarta = await pedir(e, 'orcamento_ajustar', a.recurso, { daily_budget_micros: 21 * REAL });
    expect([quarta.status, quarta.body.code]).toEqual([422, 'politica-negou']);
    expect(quarta.body.errors).toEqual([{ path: 'politica.platform.1', message: 'Limite de 3 execuções a cada 60 min atingido neste objeto.' }]);
    // Aumentar conta na mesma regra (`orcamento.*`); pausar o mesmo conjunto não é mudança de verba.
    expect((await pedir(e, 'orcamento_ajustar', a.recurso, { daily_budget_micros: 25 * REAL })).body.errors.map((x: { path: string }) => x.path)).toEqual(['politica.platform.1']);
    expect((await pedir(e, 'conjunto_pausar', a.recurso)).status).toBe(201);
    // Outro conjunto da mesma conta não entra na conta deste.
    expect((await pedir(e, 'orcamento_ajustar', b.recurso, { daily_budget_micros: 27 * REAL })).status).toBe(201);
    // Passada a hora, o objeto volta a aceitar.
    await ownerQuery(`update liame.action_request set updated_at = now() - interval '61 minutes' where tenant_id = $1 and resource_id = $2 and status = 'executada'`, [e.tenantId, a.recurso]);
    expect((await pedir(e, 'orcamento_ajustar', a.recurso, { daily_budget_micros: 21 * REAL })).status).toBe(201);
  });

  it('A4-5: a volta devolve a verba de antes pelo mesmo trilho; fica fora do teto e dos 10%, e não se pede duas vezes', async () => {
    // R$ 200,00 por dia (acima do teto de R$ 150,00 da empresa: alguém definiu na Meta). O Liame reduz 10%.
    const c = await objetoLido(meta, e, 'campanha', { daily_budget: '20000' });
    const feita = await executar(e, 'orcamento_ajustar', c.recurso, { daily_budget_micros: 180 * REAL });
    expect(feita.status).toBe('executada');
    expect(meta.objetos.get(c.id)!.daily_budget).toBe('18000');

    const volta = await desfazer(e, feita.id);
    expect(volta.status).toBe(201);
    // De R$ 180,00 para R$ 200,00 são 11,1%, e acima do teto: a volta devolve o que já estava lá, então passa.
    expect(volta.body).toMatchObject({
      tool: 'orcamento_ajustar',
      action: 'orcamento.aumentar',
      resource_id: c.recurso,
      params: { daily_budget_micros: 200 * REAL },
      value_micros: 200 * REAL,
      current_value_micros: 180 * REAL,
      reserved_micros: 20 * REAL,
      mode: 'APPROVAL',
      status: 'aguardando_aprovacao',
      undoes: feita.id,
      undone_by: null,
      policy: { allowed: true, violations: [] },
    });
    expect((await ver(e, feita.id)).undone_by).toEqual({ id: volta.body.id, status: 'aguardando_aprovacao' });
    // Uma volta por vez, e a volta não muda de valor.
    const outra = await desfazer(e, feita.id);
    expect([outra.status, outra.body.code]).toEqual([409, 'volta-ja-pedida']);
    const alterar = await api.call('PATCH', `/v1/actions/${volta.body.id}`, { cookie: e.cookie, body: { params: { daily_budget_micros: 190 * REAL } } });
    expect([alterar.status, alterar.body.code]).toEqual([409, 'acao-nao-altera']);

    // Sem a aprovação, nada muda na Meta; com ela, a verba volta.
    await ciclo(e);
    expect(meta.objetos.get(c.id)!.daily_budget).toBe('18000');
    expect((await aprovar(e, volta.body)).body.status).toBe('aprovada');
    await ciclo(e);
    expect((await ver(e, volta.body.id)).status).toBe('executada');
    expect(meta.objetos.get(c.id)!.daily_budget).toBe('20000');
    expect((await ver(e, feita.id)).undone_by).toEqual({ id: volta.body.id, status: 'executada' });
    expect((await desfazer(e, feita.id)).body.code).toBe('volta-ja-pedida');

    // A auditoria liga a volta à ação; e a lista mostra as duas pontas.
    const [aud] = await ownerQuery<{ action: string; after: { volta_de?: string } }>(
      `select action, "after" from liame.audit_event where chain_key = $1 and resource_id = $2 order by chain_seq limit 1`,
      [e.tenantId, volta.body.id],
    );
    expect([aud!.action, aud!.after.volta_de]).toEqual(['acao.desfazer', feita.id]);
    const lista = (await api.call('GET', '/v1/actions', { cookie: e.cookie })).body.items as Array<{ id: string; undoes: string | null; undone_by: { id: string } | null }>;
    expect(lista.find((x) => x.id === feita.id)!.undone_by!.id).toBe(volta.body.id);
    expect(lista.find((x) => x.id === volta.body.id)!.undoes).toBe(feita.id);
  });

  it('A4-5: a volta de pausar é retomar, com a reserva de quem volta a gastar; a de retomar é pausar', async () => {
    const s = await objetoLido(meta, e, 'conjunto');
    const pausado = await executar(e, 'conjunto_pausar', s.recurso);
    const volta = await desfazer(e, pausado.id);
    expect(volta.body).toMatchObject({
      tool: 'conjunto_retomar',
      action: 'conjunto.retomar',
      risk_level: 'R2',
      budget_impact: 'new_spend',
      reserved_micros: 30 * REAL,
      undoes: pausado.id,
      status: 'aguardando_aprovacao',
    });
    await aprovar(e, volta.body);
    await ciclo(e);
    expect(meta.objetos.get(s.id)!.status).toBe('ACTIVE');

    // E a volta da volta pausa de novo.
    const refazer = await desfazer(e, volta.body.id);
    expect(refazer.body).toMatchObject({ tool: 'conjunto_pausar', undoes: volta.body.id, reserved_micros: 0, status: 'aguardando_aprovacao' });
    await aprovar(e, refazer.body);
    await ciclo(e);
    expect(meta.objetos.get(s.id)!.status).toBe('PAUSED');
    expect((await ver(e, volta.body.id)).undone_by).toEqual({ id: refazer.body.id, status: 'executada' });
  });

  it('A4-4: a volta não sobrescreve o que alguém mudou depois, e o Liame não desfaz o que não fez', async () => {
    // (1) Pausado pelo Liame; depois alguém mexeu na verba pela Meta: a volta é recusada na hora do pedido.
    const s = await objetoLido(meta, e, 'conjunto');
    const pausado = await executar(e, 'conjunto_pausar', s.recurso);
    meta.objetos.get(s.id)!.daily_budget = '4500';
    const antes = await pedidosDe(e);
    const r1 = await desfazer(e, pausado.id);
    expect([r1.status, r1.body.code]).toEqual([409, 'estado-mudou']);
    expect(await pedidosDe(e)).toBe(antes);
    expect(meta.objetos.get(s.id)!.status).toBe('PAUSED');

    // (2) A volta foi pedida e aprovada com tudo como a ação deixou; antes de executar, alguém mudou a verba na Meta.
    const c = await objetoLido(meta, e, 'campanha');
    const reduzida = await executar(e, 'orcamento_ajustar', c.recurso, { daily_budget_micros: 27 * REAL });
    const volta = await desfazer(e, reduzida.id);
    expect(volta.status).toBe(201);
    await aprovar(e, volta.body);
    meta.objetos.get(c.id)!.daily_budget = '2600';
    meta.chamadas.length = 0;
    await ciclo(e);
    expect(meta.escritasDe(c.id)).toEqual([]);
    expect(meta.objetos.get(c.id)!.daily_budget).toBe('2600');
    expect(await ver(e, volta.body.id)).toMatchObject({ status: 'falhou', status_reason: 'o recurso mudou desde o pedido; nada foi sobrescrito' });
    // A reserva da volta voltou ao envelope, a ação original mostra a volta que falhou, e pedir de novo não adianta.
    expect(await livroDe(volta.body.id)).toEqual([
      ['reserva', 3 * REAL],
      ['liberacao', 3 * REAL],
    ]);
    expect((await ver(e, reduzida.id)).undone_by).toEqual({ id: volta.body.id, status: 'falhou' });
    expect((await desfazer(e, reduzida.id)).body.code).toBe('estado-mudou');

    // (3) O Liame foi pausar e o anúncio já estava pausado por alguém: executada sem escrever, e sem volta pelo Liame.
    const a = await objetoLido(meta, e, 'anuncio');
    const p = await pedir(e, 'anuncio_pausar', a.recurso);
    await aprovar(e, p.body);
    meta.objetos.get(a.id)!.status = 'PAUSED';
    await ciclo(e);
    expect((await ver(e, p.body.id)).status).toBe('executada');
    expect(meta.escritasDe(a.id)).toEqual([]);
    const r3 = await desfazer(e, p.body.id);
    expect([r3.status, r3.body.code]).toEqual([409, 'acao-sem-volta']);
    expect(r3.body.detail).toBe('O objeto já estava assim quando o Liame foi executar: o Liame não mudou nada, então não há o que desfazer por aqui.');
    expect(meta.objetos.get(a.id)!.status).toBe('PAUSED');

    // (4) Só se desfaz o que foi executado; a ação de outra empresa não existe.
    const pendente = await pedir(e, 'campanha_pausar', c.recurso);
    expect([(await desfazer(e, pendente.body.id)).status, (await desfazer(e, pendente.body.id)).body.code]).toEqual([409, 'acao-nao-desfaz']);
    expect((await desfazer(await empresaSemLimites(), pausado.id)).status).toBe(404);
  });

  it('a Meta aceitou sem a leitura confirmar: a volta confere pelo estado que a ação pediu, não pela leitura atrasada', async () => {
    const c = await objetoLido(meta, e, 'campanha');
    const p = await pedir(e, 'orcamento_ajustar', c.recurso, { daily_budget_micros: 27 * REAL });
    await aprovar(e, p.body);
    // A validação passa e a escrita "dá certo", mas a leitura logo depois ainda mostra a verba de antes.
    meta.falhasDaEscrita = [
      { status: 200, corpo: { success: true } },
      { status: 200, corpo: { success: true } },
    ];
    await ciclo(e);
    expect((await ver(e, p.body.id)).status).toBe('executada');
    // Enquanto a Meta não mostra a mudança, a volta não tem sobre o que agir.
    expect((await desfazer(e, p.body.id)).body.code).toBe('estado-mudou');
    // Quando a mudança aparece, o objeto está como a ação pediu: a volta vale.
    meta.objetos.get(c.id)!.daily_budget = '2700';
    const volta = await desfazer(e, p.body.id);
    expect([volta.status, volta.body.params]).toEqual([201, { daily_budget_micros: 30 * REAL }]);
  });

  it('a leitura na Meta falha na hora do pedido: a pessoa recebe o motivo e nenhum pedido é criado', async () => {
    const c = await objetoLido(meta, e, 'campanha');
    const antes = await pedidosDe(e);
    const tentar = async (falha: FalhaDaMeta) => {
      meta.falhasDaLeitura = [falha];
      const r = await pedir(e, 'campanha_pausar', c.recurso);
      return [r.status, r.body.code, r.body.detail];
    };
    const indisponivel = 'A Meta não respondeu agora, ou pediu para esperar. Nada foi pedido: tente de novo em alguns minutos.';
    expect(await tentar({ status: 500, corpo: meta.erro(2, 'Service temporarily unavailable') })).toEqual([502, 'plataforma-indisponivel', indisponivel]);
    expect(await tentar({ status: 400, corpo: meta.erro(17, 'User request limit reached', { error_subcode: 2446079 }) })).toEqual([502, 'plataforma-indisponivel', indisponivel]);
    expect(await tentar({ status: 400, corpo: meta.erro(190, 'Error validating access token: Session has expired') })).toEqual([
      409,
      'conta-desconectada',
      'A Meta recusou o acesso desta conta (a autorização foi revogada ou venceu). Conecte de novo em Contas conectadas.',
    ]);
    expect((await tentar({ status: 400, corpo: meta.erro(200, '(#200) Requires ads_read permission') })).slice(0, 2)).toEqual([409, 'sem-permissao-na-plataforma']);
    expect(await tentar({ status: 400, corpo: meta.erro(100, '(#100) Tried accessing nonexisting field (account_id) on node type (Campaign)') })).toEqual([
      422,
      'plataforma-recusou',
      'A Meta não deixou ler o objeto: (#100) Tried accessing nonexisting field (account_id) on node type (Campaign)',
    ]);

    // Conta sem a autorização guardada; objeto que o Liame não leu desta conta; recurso que não é de anúncio.
    const semToken = await objetoLido(meta, e, 'campanha', { account_id: meta.outraConta }, { conta: e.contaSemToken });
    const r1 = await api.call('POST', '/v1/actions', { cookie: e.cookie, body: { tool: 'campanha_pausar', provider: 'meta_ads', account_id: e.contaSemToken, resource_id: semToken.recurso, params: {} } });
    expect([r1.status, r1.body.code]).toEqual([409, 'conta-desconectada']);
    const naoLido = await objetoLido(meta, e, 'campanha', {}, { semLinha: true });
    expect([(await pedir(e, 'campanha_pausar', naoLido.recurso)).status, (await pedir(e, 'campanha_pausar', 'cupom:SEXTA15')).body.code]).toEqual([404, 'recurso-nao-encontrado']);
    expect(await pedidosDe(e)).toBe(antes);

    // Com a Meta de volta, o mesmo pedido entra.
    expect((await pedir(e, 'campanha_pausar', c.recurso)).status).toBe(201);
    expect(meta.escritasDe(c.id)).toEqual([]);
  });

  it('a Meta demora mais do que a pessoa pode esperar: o pedido devolve "tente de novo" em vez de ficar preso; o executor espera o tempo dele', async () => {
    const c = await objetoLido(meta, e, 'campanha');
    const antes = await pedidosDe(e);
    // A leitura da hora do pedido espera pouco (10 s em produção; 250 ms aqui), e a Meta só responderia em 20 s.
    ligarConectorNaMetaDeMentira(api, meta, { tempoDaLeituraDoPedidoMs: 250 });
    try {
      meta.atrasoDaProximaRespostaMs = 20_000;
      const inicio = Date.now();
      const r = await pedir(e, 'campanha_pausar', c.recurso);
      expect([r.status, r.body.code]).toEqual([502, 'plataforma-indisponivel']);
      // Folga larga (a máquina pode estar carregada): o que importa é não ter esperado a resposta da Meta.
      expect(Date.now() - inicio).toBeLessThan(10_000);
      expect(await pedidosDe(e)).toBe(antes);

      // Na execução não há ninguém esperando: a mesma demora não derruba a ação aprovada.
      const p = await pedir(e, 'campanha_pausar', c.recurso);
      expect(p.status).toBe(201);
      await aprovar(e, p.body);
      meta.atrasoDaProximaRespostaMs = 600;
      await ciclo(e);
      expect((await ver(e, p.body.id)).status).toBe('executada');
      expect(meta.objetos.get(c.id)!.status).toBe('PAUSED');
    } finally {
      ligarConectorNaMetaDeMentira(api, meta);
    }
  });

  it('com a flag `meta_write` desligada ou com a trava da empresa, o pedido é recusado antes de qualquer leitura na Meta', async () => {
    const c = await objetoLido(meta, e, 'campanha');
    const feita = await executar(e, 'campanha_pausar', c.recurso);
    meta.chamadas.length = 0;
    await ligarEscritaNaMeta(api, e.tenantId, false);
    try {
      const r = await pedir(e, 'campanha_retomar', c.recurso);
      expect([r.status, r.body.code]).toEqual([403, 'escrita-desligada']);
      // A volta passa pelo mesmo trilho: com a escrita desligada, também não entra.
      expect((await desfazer(e, feita.id)).body.code).toBe('escrita-desligada');
    } finally {
      await ligarEscritaNaMeta(api, e.tenantId, true);
    }
    const trava = await api.call('POST', '/v1/kill-switches', { cookie: e.cookie, body: { level: 'tenant', reason: 'pausa de segurança' } });
    try {
      expect((await pedir(e, 'campanha_retomar', c.recurso)).status).toBe(423);
      expect((await desfazer(e, feita.id)).status).toBe(423);
    } finally {
      await api.call('DELETE', `/v1/kill-switches/${trava.body.id}`, { cookie: e.cookie });
    }
    expect(meta.chamadasDe(c.id)).toEqual([]);
  });

  it('A4-2: o modo do funcionário de IA na conta não muda o pedido da pessoa; modo automático sem o autopilot espera aprovação', async () => {
    const c = await objetoLido(meta, e, 'campanha');
    const daMarca = (rules: unknown[]) => politica(e, rules, e.brandId);
    try {
      // O Gestor de tráfego em Sombra para pausar e em Sugerir para reduzir, nesta conta (as regras da promoção).
      expect(
        (
          await daMarca([
            { type: 'autonomy', action: 'campanha.pausar', actor: 'agent', account: e.conta, mode: 'SHADOW' },
            { type: 'autonomy', action: 'orcamento.reduzir', actor: 'agent', account: e.conta, mode: 'SUGGEST' },
          ])
        ).status,
      ).toBe(201);
      const p = await pedir(e, 'campanha_pausar', c.recurso, {}, { brand_id: e.brandId });
      expect(p.body).toMatchObject({ mode: 'APPROVAL', status: 'aguardando_aprovacao', policy: { versions: ['plataforma@3', 'empresa@1', 'marca@1'] } });
      await cancelar(e, p.body.id);

      // A empresa escreve AUTO para o pedido de uma pessoa: sem o autopilot (que nasce desligado), espera aprovação.
      await daMarca([{ type: 'autonomy', action: 'campanha.pausar', actor: 'human', account: e.conta, mode: 'AUTO' }]);
      const auto = await pedir(e, 'campanha_pausar', c.recurso, {}, { brand_id: e.brandId });
      expect(auto.body).toMatchObject({ mode: 'APPROVAL', status: 'aguardando_aprovacao', status_reason: 'autonomia AUTO pedida, mas o autopilot está desligado' });
      await ciclo(e);
      expect(meta.escritasDe(c.id)).toEqual([]);
      expect(meta.objetos.get(c.id)!.status).toBe('ACTIVE');
    } finally {
      await daMarca([]);
    }
  });

  it('a marca do pedido é a da conta conectada: não dá para escolher outra, nem nenhuma, e fugir da política da marca', async () => {
    const c = await objetoLido(meta, e, 'campanha');
    const outraMarca = await api.call('POST', '/v1/brands', { cookie: e.cookie, body: { name: 'Outra marca da empresa' } });
    expect(outraMarca.status).toBe(201);
    const errada = await pedir(e, 'campanha_pausar', c.recurso, {}, { brand_id: outraMarca.body.id });
    expect([errada.status, errada.body.code]).toEqual([422, 'marca-nao-confere']);
    try {
      // A marca da conta manda pausar campanha só com o dono; o pedido sem marca segue essa regra.
      expect((await politica(e, [{ type: 'autonomy', action: 'campanha.pausar', actor: 'human', mode: 'ESCALATE' }], e.brandId)).status).toBe(201);
      const p = await pedir(e, 'campanha_pausar', c.recurso);
      expect(p.body).toMatchObject({ brand_id: e.brandId, mode: 'ESCALATE', status: 'aguardando_aprovacao', status_reason: 'precisa do dono' });
      expect(p.body.policy.versions[2]).toMatch(/^marca@\d+$/);
      await cancelar(e, p.body.id);
      // A trava da marca também pega o pedido que não disse a marca.
      const trava = await api.call('POST', '/v1/kill-switches', { cookie: e.cookie, body: { level: 'brand', brand_id: e.brandId, reason: 'marca em revisão' } });
      expect(trava.status).toBe(201);
      try {
        expect((await pedir(e, 'campanha_pausar', c.recurso)).status).toBe(423);
      } finally {
        await api.call('DELETE', `/v1/kill-switches/${trava.body.id}`, { cookie: e.cookie });
      }
    } finally {
      await politica(e, [], e.brandId);
    }
    expect(meta.escritasDe(c.id)).toEqual([]);
  });

  it('A4 · X3: o pedido que nasce de uma recomendação fica ligado a ela e mostra o porquê; o que não confere com ela não entra', async () => {
    const r = await campanhaComRecomendacao(e, 'orcamento_reduzir');
    const outra = await campanhaComRecomendacao(e, 'orcamento_reduzir', 'Almoço executivo');
    const antes = await pedidosDe(e);
    const comEla = (recurso: string, tool: string, params: Record<string, unknown>, recomendacao: string = r.recomendacao) => pedir(e, tool, recurso, params, { recommendation_id: recomendacao });

    // De outra campanha: recusado antes de gastar a leitura na Meta.
    meta.chamadas.length = 0;
    const trocado = await comEla(outra.recurso, 'orcamento_ajustar', { daily_budget_micros: 27 * REAL });
    expect([trocado.status, trocado.body.code, trocado.body.detail]).toEqual([422, 'recomendacao-nao-confere', 'O pedido não é da campanha desta recomendação.']);
    expect(meta.chamadas).toEqual([]);
    // Na direção contrária: a Meta é lida, o plano é de aumentar, e o pedido não entra (nem chega a pedir os limites).
    const contrario = await comEla(r.recurso, 'orcamento_ajustar', { daily_budget_micros: 33 * REAL });
    expect([contrario.status, contrario.body.code, contrario.body.detail]).toEqual([
      422,
      'recomendacao-nao-confere',
      'A recomendação é de reduzir a verba, e este pedido faz outra coisa. Peça sem ligar à recomendação.',
    ]);
    expect(meta.resumo(r.id)).toEqual(['ler']);
    // Pausar a campanha também não é o que ela recomenda.
    expect((await comEla(r.recurso, 'campanha_pausar', {})).body.code).toBe('recomendacao-nao-confere');
    // A recomendação de outra empresa não existe (a RLS corta); a que não existe, também não; e o id tem de ser um id.
    const sem = await empresaSemLimites();
    const dela = await objetoLido(meta, sem, 'campanha');
    const alheia = await pedir(sem, 'orcamento_ajustar', dela.recurso, { daily_budget_micros: 27 * REAL }, { recommendation_id: r.recomendacao });
    expect([alheia.status, alheia.body.code, alheia.body.detail]).toEqual([404, 'nao-encontrado', 'Recomendação não encontrada nesta empresa.']);
    expect((await comEla(r.recurso, 'orcamento_ajustar', { daily_budget_micros: 27 * REAL }, uuidv7())).status).toBe(404);
    expect((await comEla(r.recurso, 'orcamento_ajustar', { daily_budget_micros: 27 * REAL }, 'a-recomendacao-de-hoje')).status).toBe(400);
    expect(await pedidosDe(e)).toBe(antes);

    // Confere: mesma conta, mesma campanha, mesma direção. O pedido segue o trilho de sempre e guarda de onde veio.
    const p = await comEla(r.recurso, 'orcamento_ajustar', { daily_budget_micros: 27 * REAL });
    expect(p.status, JSON.stringify(p.body)).toBe(201);
    expect(p.body).toMatchObject({ action: 'orcamento.reduzir', mode: 'APPROVAL', status: 'aguardando_aprovacao', reserved_micros: 0, requested_by: { id: e.userId } });
    const porque = {
      id: r.recomendacao,
      tool: 'orcamento_reduzir',
      rule: 'prejuizo',
      rule_version: 2,
      confidence_pct: '90.0',
      percent: 10,
      decided_on: hoje,
      window: { from: menosDias(hoje, 7), to: menosDias(hoje, 1) },
      daily_budget_micros: '30000000',
      spend_micros: '150000000',
      orders: 2,
      revenue_micros: '120000000',
      margin_known_micros: '90000000',
      margin_coverage_pct: '100.0',
    };
    expect(ActionRecommendation.parse(p.body.recommendation)).toEqual(porque);
    expect(await ligacaoDe(p.body.id)).toBe(r.recomendacao);
    const [aud] = await ownerQuery<{ action: string; after: { recommendation_id?: string } }>(
      `select action, "after" from liame.audit_event where chain_key = $1 and resource_id = $2 order by chain_seq limit 1`,
      [e.tenantId, p.body.id],
    );
    expect([aud!.action, aud!.after.recommendation_id]).toEqual(['acao.pedir', r.recomendacao]);
    // Na lista de Aprovações, o pedido da recomendação traz o porquê; o pedido comum, nada.
    const comum = await pedir(e, 'orcamento_ajustar', outra.recurso, { daily_budget_micros: 27 * REAL });
    expect([comum.status, comum.body.recommendation, await ligacaoDe(comum.body.id)]).toEqual([201, null, null]);
    const lista = (await api.call('GET', '/v1/actions?status=aguardando_aprovacao', { cookie: e.cookie })).body.items as Array<{ id: string; recommendation: { id: string } | null }>;
    expect(lista.find((x) => x.id === p.body.id)!.recommendation).toEqual(porque);
    expect(lista.find((x) => x.id === comum.body.id)!.recommendation).toBeNull();
    await cancelar(e, comum.body.id);

    // Quem não vê as vendas recebe a recomendação sem os números do caixa (pedidos, receita, margem): o gasto é da mídia.
    await ownerQuery(`insert into liame.role_permission (tenant_id, role_key, permission) select $1, 'dono', p from unnest(array['empresa.ver', 'marcas.ver', 'campanhas.ver']) as p`, [e.tenantId]);
    try {
      expect((await ver(e, p.body.id)).recommendation).toEqual({ ...porque, orders: null, revenue_micros: null, margin_known_micros: null, margin_coverage_pct: null });
    } finally {
      await ownerQuery(`delete from liame.role_permission where tenant_id = $1`, [e.tenantId]);
    }

    // A pessoa ajusta o valor e segue na direção da recomendação: a ligação fica. Muda de direção: a ligação sai.
    const alterar = (params: Record<string, unknown>) => api.call('PATCH', `/v1/actions/${p.body.id}`, { cookie: e.cookie, body: { params } });
    const menos = await alterar({ daily_budget_micros: 28 * REAL });
    expect([menos.status, menos.body.action, menos.body.recommendation?.id]).toEqual([200, 'orcamento.reduzir', r.recomendacao]);
    const mais = await alterar({ daily_budget_micros: 31 * REAL });
    expect([mais.status, mais.body.action, mais.body.recommendation, await ligacaoDe(p.body.id)]).toEqual([200, 'orcamento.aumentar', null, null]);
    const [mudanca] = await ownerQuery<{ after: { recommendation_unlinked?: string } }>(
      `select "after" from liame.audit_event where chain_key = $1 and resource_id = $2 and action = 'acao.alterar' order by chain_seq desc limit 1`,
      [e.tenantId, p.body.id],
    );
    expect(mudanca!.after.recommendation_unlinked).toBe(r.recomendacao);
    // E voltar para a redução não religa: a ligação nasce com o pedido.
    expect((await alterar({ daily_budget_micros: 27 * REAL })).body.recommendation).toBeNull();
    await cancelar(e, p.body.id);

    // A recomendação que se encerrou (avaliada ou descartada pela rotina) não recebe mais pedido.
    await ownerQuery(`update liame.shadow_decision set status = 'descartada', discard_reason = 'conta de anúncio desconectada' where id = $1`, [r.recomendacao]);
    const tarde = await comEla(r.recurso, 'orcamento_ajustar', { daily_budget_micros: 27 * REAL });
    expect([tarde.status, tarde.body.code]).toEqual([409, 'recomendacao-encerrada']);
    expect(tarde.body.detail).toBe('Esta recomendação já foi avaliada ou saiu da lista. Se a mudança ainda fizer sentido, peça sem ela.');
    expect(meta.escritasDe(r.id)).toEqual([]);
  });

  it('A4 · X3: a Atenção diz como pedir a mudança de cada sugestão e mostra o pedido que já nasceu dela; executado, a ligação fica', async () => {
    const r = await campanhaComRecomendacao(e, 'orcamento_reduzir', 'Jantar de sexta');
    const pausar = await campanhaComRecomendacao(e, 'campanha_pausar', 'Madrugada');
    const daMarca = (rules: unknown[]) => politica(e, rules, e.brandId);
    const desta = async (campanha: string) => (await sugestoes(e)).find((s) => s.campaign_id === campanha);
    try {
      // Em Sombra, a recomendação não aparece na Atenção: não há o que pedir.
      expect(await desta(r.campanha)).toBeUndefined();
      // O Gestor de tráfego em Sugerir, nesta conta, para reduzir verba e para pausar campanha (as regras da promoção).
      expect(
        (
          await daMarca([
            { type: 'autonomy', action: 'orcamento.reduzir', actor: 'agent', account: e.conta, mode: 'SUGGEST' },
            { type: 'autonomy', action: 'campanha.pausar', actor: 'agent', account: e.conta, mode: 'SUGGEST' },
          ])
        ).status,
      ).toBe(201);

      // A sugestão leva a recomendação e o corpo do pedido: a ferramenta, a campanha na Meta e a verba recomendada.
      const aviso = await desta(r.campanha);
      expect(aviso).toMatchObject({ kind: 'sugestao_reduzir_verba', title: 'Sugestão do Gestor de tráfego: reduzir a verba da campanha "Jantar de sexta" em 10%' });
      expect(aviso!.recommendation).toEqual({
        id: r.recomendacao,
        request: { tool: 'orcamento_ajustar', provider: 'meta_ads', account_id: e.conta, resource_id: r.recurso, params: { daily_budget_micros: 27 * REAL } },
        action: null,
      });
      expect((await desta(pausar.campanha))!.recommendation).toEqual({
        id: pausar.recomendacao,
        request: { tool: 'campanha_pausar', provider: 'meta_ads', account_id: e.conta, resource_id: pausar.recurso, params: {} },
        action: null,
      });

      // Com a escrita na Meta desligada para a empresa, a sugestão segue lá, sem o pedido: quem muda é a pessoa, na Meta.
      await ligarEscritaNaMeta(api, e.tenantId, false);
      try {
        expect((await desta(r.campanha))!.recommendation).toEqual({ id: r.recomendacao, request: null, action: null });
      } finally {
        await ligarEscritaNaMeta(api, e.tenantId, true);
      }
      // A campanha sem verba diária própria (a verba foi para o conjunto) não tem verba para pedir; pausar, tem.
      await ownerQuery(`update liame.campaign set daily_budget_micros = null where id = any($1::uuid[])`, [[r.campanha, pausar.campanha]]);
      expect([(await desta(r.campanha))!.recommendation!.request, (await desta(pausar.campanha))!.recommendation!.request?.tool]).toEqual([null, 'campanha_pausar']);
      await ownerQuery(`update liame.campaign set daily_budget_micros = 30000000 where id = $1`, [r.campanha]);

      // A tela pede com o que a Atenção deu, mais o id da recomendação: o pedido entra e aparece na sugestão.
      const { id, request } = (await desta(r.campanha))!.recommendation!;
      const p = await api.call('POST', '/v1/actions', { cookie: e.cookie, body: { ...request, recommendation_id: id } });
      expect(p.status, JSON.stringify(p.body)).toBe(201);
      expect(p.body).toMatchObject({ tool: 'orcamento_ajustar', action: 'orcamento.reduzir', value_micros: 27 * REAL, current_value_micros: 30 * REAL, status: 'aguardando_aprovacao', recommendation: { id: r.recomendacao } });
      expect((await desta(r.campanha))!.recommendation!.action).toEqual({ id: p.body.id, status: 'aguardando_aprovacao' });

      // Quem vê as vendas, mas não opera campanhas nem vê os pedidos, recebe só a recomendação.
      await ownerQuery(`insert into liame.role_permission (tenant_id, role_key, permission) select $1, 'dono', p from unnest(array['empresa.ver', 'marcas.ver', 'vendas.ver']) as p`, [e.tenantId]);
      try {
        expect((await desta(r.campanha))!.recommendation).toEqual({ id: r.recomendacao, request: null, action: null });
      } finally {
        await ownerQuery(`delete from liame.role_permission where tenant_id = $1`, [e.tenantId]);
      }

      // Aprovado com o código do app e executado: a verba muda na Meta e o pedido segue ligado à recomendação.
      expect((await aprovar(e, p.body)).body.status).toBe('aprovada');
      await ciclo(e);
      expect(await ver(e, p.body.id)).toMatchObject({ status: 'executada', recommendation: { id: r.recomendacao, tool: 'orcamento_reduzir' } });
      expect(meta.objetos.get(r.id)!.daily_budget).toBe('2700');
      expect((await desta(r.campanha))!.recommendation!.action).toEqual({ id: p.body.id, status: 'executada' });

      // A recomendação apagada (a campanha saiu da conta) não leva o pedido junto: ele fica, sem a ligação.
      await ownerQuery(`delete from liame.shadow_decision where id = $1`, [r.recomendacao]);
      expect([(await ver(e, p.body.id)).status, (await ver(e, p.body.id)).recommendation, await ligacaoDe(p.body.id)]).toEqual(['executada', null, null]);
    } finally {
      await daMarca([]);
    }
  });

  it('o token da empresa não aparece no pedido, na resposta nem na auditoria', async () => {
    const empresas = [e.tenantId, ...(semLimites ? [semLimites.tenantId] : [])];
    const linhas = await ownerQuery<{ texto: string }>(
      `select coalesce(r.status_reason, '') || coalesce(r.before_state::text, '') || coalesce(r.desired_state::text, '') || coalesce(r.policy_decision::text, '') as texto
         from liame.action_request r where r.tenant_id = any($1::uuid[])`,
      [empresas],
    );
    const auditoria = await ownerQuery<{ texto: string }>(`select coalesce("before"::text, '') || coalesce("after"::text, '') as texto from liame.audit_event where tenant_id = any($1::uuid[])`, [empresas]);
    expect(linhas.length).toBeGreaterThan(10);
    for (const l of [...linhas, ...auditoria]) expect(l.texto.includes('token-de-sistema')).toBe(false);
    expect(meta.defeitos).toEqual([]);
  });
});
