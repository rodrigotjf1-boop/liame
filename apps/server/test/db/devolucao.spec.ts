import { createDatabase, type Database } from '@liame/database';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { currentStep, totpCode } from '../../src/auth/totp.js';
import { RELEITURA_DA_AUTORIZACAO_MS, RELEITURA_DEPOIS_DO_PEDIDO_MS, RELEITURA_DO_ESTORNO_MS } from '../../src/cobranca/cobranca-pix.js';
import { DESCRICAO_DO_ESTORNO } from '../../src/cobranca/devolucao.js';
import { MeioAsaas } from '../../src/cobranca/meio-asaas.js';
import { diaNoFuso } from '../../src/cobranca/vida.js';
import { PROVIDER_ASAAS } from '../../src/connectors/asaas/api-asaas.js';
import { chaveDe } from '../../src/connectors/cota.js';
import { FlagService } from '../../src/flags/flag.service.js';
import { avisoDoAsaas } from '../../src/worker/aviso-do-asaas.js';
import { CobrancasPixLoop } from '../../src/worker/cobrancas-pix-loop.js';
import { CobrancasReleituraLoop } from '../../src/worker/cobrancas-releitura-loop.js';
import { type InboxHandler, InboxProcessor } from '../../src/worker/inbox-processor.js';
import { AsaasDeMentira, type CobrancaNoAsaas, MARCA_DO_AVISO_DE_TESTE } from '../helpers/asaas-de-mentira.js';
import { enableMfa, ownerQuery, PASSWORD, resetIpRateLimits, startApi, TERMOS, type TestApi, tokenFrom, uniqueEmail } from '../helpers/api.js';
import { ligarFlagDaEmpresa } from '../helpers/meta-de-mentira.js';
import { APP_URL, hasDb } from './env.js';

// A7 · W2a, parte 3b: a devolução na desistência em 7 dias (Termos 11.1; D-A7-19, D-A7-29, D-A7-35 a D-A7-37), contra um
// Asaas local. A desistência põe a fatura paga na fila da releitura; a rotina relê a cobrança no Asaas e só pede o estorno
// quando não há estorno feito nem em andamento (a API não tem chave de idempotência e, no PIX, aceita mais de um estorno);
// acompanha até o estorno feito (`DONE`), quando a fatura vira devolvida, com a auditoria. O que falha espera e tenta de
// novo; o que espera alguém fora do Liame (a autorização da ação crítica) e o que só uma pessoa resolve chamam a distribuição.

type Empresa = { cookie: string; tenantId: string; brandId: string; userId: string; segredo: string };

const SP = 'America/Sao_Paulo';
/** O CNPJ de exemplo das documentações (11.222.333/0001-81), nunca o de um cliente. */
const CNPJ_DE_EXEMPLO = '11222333000181';
const MINUTO = 60_000;

describe.skipIf(!hasDb)('A devolução na desistência em 7 dias, pelo Asaas (A7 · W2a, parte 3b)', () => {
  let asaas: AsaasDeMentira;
  let api: TestApi;
  let database: Database;
  let rotina: CobrancasPixLoop;
  let releitura: CobrancasReleituraLoop;
  let processador: InboxProcessor;

  beforeAll(async () => {
    // O Asaas sobe antes da API: a configuração lê o endereço, a chave e o token do aviso dele do ambiente.
    asaas = new AsaasDeMentira();
    await asaas.subir();
    api = await startApi();
    await resetIpRateLimits();
    database = createDatabase({ connectionString: APP_URL, max: 4, applicationName: 'liame-test' });
    rotina = new CobrancasPixLoop(database, api.app.get(MeioAsaas), api.app.get(FlagService));
    releitura = new CobrancasReleituraLoop(database, api.app.get(MeioAsaas), api.app.get(FlagService));
    processador = new InboxProcessor(database, new Map<string, InboxHandler>([['asaas', avisoDoAsaas]]));
  }, 120_000);
  beforeEach(async () => {
    await resetIpRateLimits();
    // As falhas de propósito de um caso não abrem o disjuntor nem gastam a cota dos seguintes.
    const chave = chaveDe(PROVIDER_ASAAS, 'liame');
    await ownerQuery(`delete from liame.circuit_state where circuit_key = $1`, [chave]);
    await ownerQuery(`delete from liame.quota_bucket where bucket_key = $1`, [chave]);
    asaas.criar = 'ok';
    asaas.ler = 'ok';
    asaas.estornar = 'ok';
    asaas.situacaoDoEstorno = 'PENDING';
    asaas.caiDepoisDeEstornar = false;
  });
  afterAll(async () => {
    await api?.close();
    await database?.close();
    await asaas?.fechar();
  });

  /** A empresa nasce pelo cadastro, com o CNPJ, o app autenticador (o segredo fica para o código) e a função ligada. */
  async function empresa(nome: string): Promise<Empresa> {
    const email = uniqueEmail('dono');
    const cadastro = await api.call('POST', '/v1/auth/signup', {
      body: { name: 'Pessoa de Teste', email, password: PASSWORD, company: { name: nome, cnpj: CNPJ_DE_EXEMPLO }, terms_version: TERMOS },
    });
    expect(cadastro.status, JSON.stringify(cadastro.body)).toBe(202);
    expect((await api.call('POST', '/v1/auth/verify-email', { body: { token: tokenFrom(api.mailer, email) } })).status).toBe(200);
    const login = await api.call('POST', '/v1/auth/login', { body: { email, password: PASSWORD } });
    expect(login.status).toBe(200);
    const cookie = login.cookie!;
    const { secret } = await enableMfa(api, cookie);
    const tenantId = login.body.active_organization_id as string;
    const marcas = await api.call('GET', '/v1/brands', { cookie });
    const [u] = await ownerQuery<{ id: string }>(`select id from liame.app_user where email = $1`, [email]);
    await ownerQuery(`update liame.organization set timezone = $2 where id = $1`, [tenantId, SP]);
    await ligarFlagDaEmpresa(api, 'cobranca', tenantId, true);
    return { cookie, tenantId, brandId: marcas.body.items[0].id as string, userId: u!.id, segredo: secret };
  }

  /** O código do app de agora (o passo usado e o limite de tentativas são zerados). */
  async function codigo(e: Empresa): Promise<string> {
    await ownerQuery(`update liame.app_user set totp_last_step = null where id = $1`, [e.userId]);
    await ownerQuery(`delete from liame.rate_limit where key = $1`, [`segundo-fator:${e.userId}`]);
    return totpCode(e.segredo, currentStep());
  }

  const daReleitura = (e: Empresa, agora = new Date()) => releitura.executarLote(10, { tenantIds: [e.tenantId] }, agora);
  const estornos = () => asaas.vistos.filter((v) => v.metodo === 'POST' && /^\/payments\/[a-z0-9_]+\/refund$/.test(v.caminho));
  const estornosDa = (c: CobrancaNoAsaas) => estornos().filter((v) => v.caminho === `/payments/${c.id}/refund`);

  const fatura = async (id: string) =>
    (
      await ownerQuery<{
        status: string;
        refund_requested_at: Date | null;
        refunded_at: Date | null;
        provider_status: string | null;
        charge_attempts: number;
        charge_error: string | null;
        charge_next_at: Date | null;
        charge_locked_until: Date | null;
      }>(
        `select status, refund_requested_at, refunded_at, provider_status, charge_attempts, charge_error, charge_next_at, charge_locked_until
           from liame.billing_invoice where id = $1`,
        [id],
      )
    )[0]!;

  /** O aviso pela porta HTTP, como o Asaas manda, e o worker que o processa (só o deste teste, pelo id: V10). */
  async function avisarEProcessar(c: CobrancaNoAsaas, evento: string): Promise<void> {
    const corpo = asaas.aviso(c, evento);
    const r = await api.call('POST', '/v1/billing/asaas/webhook', {
      raw: { data: Buffer.from(corpo, 'utf8'), type: 'application/json' },
      headers: { 'asaas-access-token': MARCA_DO_AVISO_DE_TESTE },
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const [ev] = await ownerQuery<{ id: string }>(`select id from liame.inbox_event where provider = 'asaas' and external_event_id = $1`, [JSON.parse(corpo).id as string]);
    await processador.processBatch(50, { ids: [ev!.id] });
  }

  /**
   * A empresa que assinou no PIX, pagou a primeira mensalidade no Asaas (relida e paga) e desistiu com o código do app: a
   * fatura paga fica com a devolução pedida e entra na fila na hora.
   */
  async function desistiu(nome: string): Promise<{ e: Empresa; faturaId: string; c: CobrancaNoAsaas }> {
    const e = await empresa(nome);
    const assinou = await api.call('POST', '/v1/billing/subscription', { cookie: e.cookie, body: { brand_id: e.brandId, plan: 'essencial', method: 'pix' } });
    expect(assinou.status, JSON.stringify(assinou.body)).toBe(200);
    const [f] = await ownerQuery<{ id: string }>(`select id from liame.billing_invoice where brand_id = $1 and status = 'aberta'`, [e.brandId]);
    const faturaId = f!.id;
    expect((await rotina.executarLote(10, { tenantIds: [e.tenantId] }))[0]!.resultado).toBe('pronta');
    const [c] = asaas.cobrancasDa(faturaId);
    asaas.pagar(c!.id, diaNoFuso(new Date(), SP));
    await avisarEProcessar(c!, 'PAYMENT_RECEIVED');
    expect(await daReleitura(e)).toEqual([{ fatura: faturaId, tenantId: e.tenantId, resultado: 'paga' }]);
    const d = await api.call('POST', '/v1/billing/subscription/withdraw', { cookie: e.cookie, body: { brand_id: e.brandId, code: await codigo(e) } });
    expect(d.status, JSON.stringify(d.body)).toBe(200);
    const depois = await fatura(faturaId);
    expect(depois).toMatchObject({ status: 'paga', charge_error: null });
    expect(depois.refund_requested_at).not.toBeNull();
    expect(depois.charge_next_at!.getTime()).toBeLessThanOrEqual(Date.now() + 1000);
    return { e, faturaId, c: c! };
  }

  it('a desistência põe a devolução na fila: o estorno integral é pedido uma vez, espera, e o estorno feito torna a fatura devolvida, com a auditoria', async () => {
    const { e, faturaId, c } = await desistiu('Casa Brasa Devolve');
    const agora = new Date();
    expect(await daReleitura(e, agora)).toEqual([{ fatura: faturaId, tenantId: e.tenantId, resultado: 'pedida' }]);
    // Integral: sem o valor, com o texto da desistência.
    expect(estornosDa(c).map((v) => v.corpo)).toEqual([{ description: DESCRICAO_DO_ESTORNO }]);
    let f = await fatura(faturaId);
    expect(f).toMatchObject({ status: 'paga', provider_status: 'REFUND_REQUESTED', charge_error: null, charge_attempts: 0, charge_locked_until: null });
    expect(f.charge_next_at!.getTime()).toBe(agora.getTime() + RELEITURA_DEPOIS_DO_PEDIDO_MS);

    // Antes da hora, nada; depois, relê e espera o estorno em andamento, sem pedir de novo.
    expect(await daReleitura(e, agora)).toEqual([]);
    const depois = new Date(agora.getTime() + RELEITURA_DEPOIS_DO_PEDIDO_MS + 1000);
    expect(await daReleitura(e, depois)).toEqual([{ fatura: faturaId, tenantId: e.tenantId, resultado: 'esperando' }]);
    expect(estornosDa(c)).toHaveLength(1);
    expect((await fatura(faturaId)).charge_next_at!.getTime()).toBe(depois.getTime() + RELEITURA_DO_ESTORNO_MS);

    // O Asaas faz o estorno e avisa: a fatura vira devolvida.
    asaas.concluirEstorno(c.id);
    await avisarEProcessar(c, 'PAYMENT_REFUNDED');
    expect(await daReleitura(e)).toEqual([{ fatura: faturaId, tenantId: e.tenantId, resultado: 'devolvida' }]);
    f = await fatura(faturaId);
    expect(f).toMatchObject({ status: 'devolvida', provider_status: 'REFUNDED', charge_next_at: null, charge_error: null, charge_locked_until: null });
    expect(f.refunded_at).not.toBeNull();
    const auditoria = await ownerQuery<{ before: Record<string, unknown>; after: Record<string, unknown> }>(
      `select before, after from liame.audit_event where tenant_id = $1 and action = 'cobranca.devolucao'`,
      [e.tenantId],
    );
    expect(auditoria).toHaveLength(1);
    expect(auditoria[0]!.after).toMatchObject({ fatura: faturaId, devolvido_cents: 24_900, status: 'devolvida' });
    // A tela lê a fatura devolvida.
    const tela = await api.call('GET', `/v1/billing?brand_id=${e.brandId}`, { cookie: e.cookie });
    expect(tela.body.invoices.find((x: { id: string }) => x.id === faturaId)?.status).toBe('devolvida');
    expect(estornosDa(c)).toHaveLength(1);

    // O aviso atrasado do estorno só encerra a fila: nenhum alarme, nenhum estorno novo.
    await avisarEProcessar(c, 'PAYMENT_REFUNDED');
    expect(await daReleitura(e)).toEqual([{ fatura: faturaId, tenantId: e.tenantId, resultado: 'encerrada' }]);
    expect(await fatura(faturaId)).toMatchObject({ status: 'devolvida', charge_error: null, charge_next_at: null });
    expect(estornosDa(c)).toHaveLength(1);
  }, 120_000);

  it('a resposta do estorno se perde (o Asaas estornou e a conexão caiu): a vez grava a falha, e a seguinte acha o estorno em andamento e NÃO pede de novo', async () => {
    const { e, faturaId, c } = await desistiu('Casa Brasa Caiu');
    asaas.caiDepoisDeEstornar = true;
    const agora = new Date();
    const r = await daReleitura(e, agora);
    expect(r).toEqual([{ fatura: faturaId, tenantId: e.tenantId, resultado: 'falhou' }]);
    expect(await fatura(faturaId)).toMatchObject({ status: 'paga', charge_error: 'meio_fora_do_ar', charge_attempts: 1, charge_locked_until: null });
    asaas.caiDepoisDeEstornar = false;
    expect(await daReleitura(e, new Date(agora.getTime() + MINUTO + 1000))).toEqual([{ fatura: faturaId, tenantId: e.tenantId, resultado: 'esperando' }]);
    // Um pedido só, e um estorno só no Asaas.
    expect(estornosDa(c)).toHaveLength(1);
    expect(asaas.cobrancas.find((x) => x.id === c.id)!.refunds).toHaveLength(1);
    expect(await fatura(faturaId)).toMatchObject({ charge_error: null, charge_attempts: 0, provider_status: 'REFUND_REQUESTED' });
  }, 120_000);

  it('o estorno feito na hora (PIX): a fatura sai devolvida na mesma vez', async () => {
    const { e, faturaId, c } = await desistiu('Casa Brasa Na Hora');
    asaas.situacaoDoEstorno = 'DONE';
    expect(await daReleitura(e)).toEqual([{ fatura: faturaId, tenantId: e.tenantId, resultado: 'devolvida' }]);
    expect(await fatura(faturaId)).toMatchObject({ status: 'devolvida', provider_status: 'REFUNDED', charge_next_at: null });
    expect(estornosDa(c)).toHaveLength(1);
  }, 120_000);

  it('sem saldo na conta (o PIX logo depois do recebimento): a vez espera e tenta de novo; com o saldo, o estorno sai', async () => {
    const { e, faturaId, c } = await desistiu('Casa Brasa Sem Saldo');
    asaas.estornar = 'sem-saldo';
    const agora = new Date();
    expect(await daReleitura(e, agora)).toEqual([{ fatura: faturaId, tenantId: e.tenantId, resultado: 'falhou' }]);
    const f = await fatura(faturaId);
    expect(f).toMatchObject({ status: 'paga', charge_error: 'recusada_pelo_meio', charge_attempts: 1 });
    expect(f.charge_next_at!.getTime()).toBe(agora.getTime() + MINUTO);
    asaas.estornar = 'ok';
    expect(await daReleitura(e, new Date(agora.getTime() + MINUTO + 1000))).toEqual([{ fatura: faturaId, tenantId: e.tenantId, resultado: 'pedida' }]);
    // O pedido recusado não deixou estorno: o segundo é o único que existe.
    expect(asaas.cobrancas.find((x) => x.id === c.id)!.refunds).toHaveLength(1);
  }, 120_000);

  it('o estorno que espera a autorização de uma ação crítica no Asaas: a releitura passa a ser diária, e o estorno não é pedido de novo', async () => {
    const { e, faturaId, c } = await desistiu('Casa Brasa Autoriza');
    asaas.situacaoDoEstorno = 'AWAITING_CRITICAL_ACTION_AUTHORIZATION';
    const agora = new Date();
    // Já no pedido a rotina sabe que ele espera a autorização: a próxima leitura fica para o dia seguinte.
    expect(await daReleitura(e, agora)).toEqual([{ fatura: faturaId, tenantId: e.tenantId, resultado: 'pedida' }]);
    expect((await fatura(faturaId)).charge_next_at!.getTime()).toBe(agora.getTime() + RELEITURA_DA_AUTORIZACAO_MS);
    expect(await daReleitura(e, new Date(agora.getTime() + RELEITURA_DEPOIS_DO_PEDIDO_MS + 1000))).toEqual([]);
    const depois = new Date(agora.getTime() + RELEITURA_DA_AUTORIZACAO_MS + 1000);
    expect(await daReleitura(e, depois)).toEqual([{ fatura: faturaId, tenantId: e.tenantId, resultado: 'esperando' }]);
    expect((await fatura(faturaId)).charge_next_at!.getTime()).toBe(depois.getTime() + RELEITURA_DA_AUTORIZACAO_MS);
    expect(estornosDa(c)).toHaveLength(1);
    // Autorizado no painel do Asaas, o estorno anda e fica feito.
    asaas.concluirEstorno(c.id);
    expect(await daReleitura(e, new Date(depois.getTime() + RELEITURA_DA_AUTORIZACAO_MS + 1000))).toEqual([{ fatura: faturaId, tenantId: e.tenantId, resultado: 'devolvida' }]);
  }, 120_000);

  it('a cobrança em disputa, a removida e a de estorno cancelado: param com o porquê em código, sem pedir estorno', async () => {
    const disputa = await desistiu('Casa Brasa Disputa');
    asaas.cobrancas.find((x) => x.id === disputa.c.id)!.status = 'CHARGEBACK_REQUESTED';
    expect(await daReleitura(disputa.e)).toEqual([{ fatura: disputa.faturaId, tenantId: disputa.e.tenantId, resultado: 'parada' }]);
    expect(await fatura(disputa.faturaId)).toMatchObject({ status: 'paga', charge_error: 'devolucao_em_disputa', charge_next_at: null, charge_locked_until: null });
    expect(estornosDa(disputa.c)).toHaveLength(0);

    const removida = await desistiu('Casa Brasa Sumiu');
    asaas.removerNoPainel(removida.c.id);
    expect(await daReleitura(removida.e)).toEqual([{ fatura: removida.faturaId, tenantId: removida.e.tenantId, resultado: 'parada' }]);
    expect(await fatura(removida.faturaId)).toMatchObject({ status: 'paga', charge_error: 'devolucao_sem_cobranca', charge_next_at: null });
    expect(estornosDa(removida.c)).toHaveLength(0);

    const cancelado = await desistiu('Casa Brasa Cancelou');
    asaas.situacaoDoEstorno = 'CANCELLED';
    expect(await daReleitura(cancelado.e)).toEqual([{ fatura: cancelado.faturaId, tenantId: cancelado.e.tenantId, resultado: 'parada' }]);
    expect(await fatura(cancelado.faturaId)).toMatchObject({ status: 'paga', charge_error: 'devolucao_cancelada', charge_next_at: null });
    // Um pedido só: o cancelado não é pedido de novo.
    expect(estornosDa(cancelado.c)).toHaveLength(1);
  }, 180_000);

  it('a função desligada depois de desistir: a devolução espera 1 hora sem chamar o Asaas', async () => {
    const { e, faturaId, c } = await desistiu('Casa Brasa Desligou');
    await ligarFlagDaEmpresa(api, 'cobranca', e.tenantId, false);
    const agora = new Date();
    expect(await daReleitura(e, agora)).toEqual([{ fatura: faturaId, tenantId: e.tenantId, resultado: 'desligada' }]);
    expect(estornosDa(c)).toHaveLength(0);
    expect((await fatura(faturaId)).charge_next_at!.getTime()).toBe(agora.getTime() + 3_600_000);
  }, 120_000);
});
