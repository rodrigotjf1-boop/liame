import { randomBytes } from 'node:crypto';
import { BillingPixResponse } from '@liame/contracts';
import { createDatabase, type Database, withSystem } from '@liame/database';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { assinaturaVivaTravada, pagarFatura, trocarPlano, vezDaAssinatura } from '../../src/cobranca/assinatura.js';
import { MeioAsaas } from '../../src/cobranca/meio-asaas.js';
import { diaNoFuso, somarDias } from '../../src/cobranca/vida.js';
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

// A7 · W2a, parte 1: o PIX pelo Asaas (D-A7-30 a D-A7-32; `base-conhecimento.md` §18.5), contra um Asaas local. A
// fatura em aberto de uma assinatura no PIX ganha a cobrança dela no Asaas, pela rotina do worker ou na hora em que a
// pessoa pede o QR Code, pelo mesmo caminho: o cliente da empresa uma vez só (sem as notificações do Asaas), a cobrança
// com o id da fatura, procurada antes de criar (a API não tem chave de idempotência), e a trava da vez para nunca criar
// duas. As falhas gravam o porquê em código e a próxima vez; e só paga quem tem `cobranca.pagar`.

type Empresa = { cookie: string; tenantId: string; brandId: string; userId: string };

const SP = 'America/Sao_Paulo';
/** O CNPJ de exemplo das documentações (11.222.333/0001-81), nunca o de um cliente. */
const CNPJ_DE_EXEMPLO = '11222333000181';

describe.skipIf(!hasDb)('O PIX pelo Asaas: a cobrança de cada fatura e o QR Code (A7 · W2a)', () => {
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
    asaas.qrCode = 'ok';
    asaas.caiDepoisDeCriar = false;
    asaas.segurarCriacao = null;
    asaas.enderecoDaFatura = (id) => `https://sandbox.asaas.com/i/${id}`;
    asaas.situacaoNova = 'PENDING';
    asaas.ler = 'ok';
    asaas.segurarLeitura = null;
  });
  afterAll(async () => {
    await api?.close();
    await database?.close();
    await asaas?.fechar();
  });

  /** A empresa nasce pelo cadastro, com o CNPJ (ou sem ele), o app autenticador e a função ligada. */
  async function empresa(nome: string, { cnpj = CNPJ_DE_EXEMPLO as string | null, ligada = true } = {}): Promise<Empresa> {
    const email = uniqueEmail('dono');
    const cadastro = await api.call('POST', '/v1/auth/signup', {
      body: { name: 'Pessoa de Teste', email, password: PASSWORD, company: { name: nome, ...(cnpj ? { cnpj } : {}) }, terms_version: TERMOS },
    });
    expect(cadastro.status, JSON.stringify(cadastro.body)).toBe(202);
    expect((await api.call('POST', '/v1/auth/verify-email', { body: { token: tokenFrom(api.mailer, email) } })).status).toBe(200);
    const login = await api.call('POST', '/v1/auth/login', { body: { email, password: PASSWORD } });
    expect(login.status).toBe(200);
    const cookie = login.cookie!;
    await enableMfa(api, cookie);
    const tenantId = login.body.active_organization_id as string;
    const marcas = await api.call('GET', '/v1/brands', { cookie });
    const [u] = await ownerQuery<{ id: string }>(`select id from liame.app_user where email = $1`, [email]);
    await ownerQuery(`update liame.organization set timezone = $2 where id = $1`, [tenantId, SP]);
    if (ligada) await ligarFlagDaEmpresa(api, 'cobranca', tenantId, true);
    return { cookie, tenantId, brandId: marcas.body.items[0].id as string, userId: u!.id };
  }

  async function assinar(e: Empresa, forma = 'pix'): Promise<string> {
    const r = await api.call('POST', '/v1/billing/subscription', { cookie: e.cookie, body: { brand_id: e.brandId, plan: 'essencial', method: forma } });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const [f] = await ownerQuery<{ id: string }>(`select id from liame.billing_invoice where brand_id = $1 and status = 'aberta'`, [e.brandId]);
    return f!.id;
  }

  const fatura = async (id: string) =>
    (
      await ownerQuery<{
        provider: string | null;
        external_id: string | null;
        provider_url: string | null;
        provider_status: string | null;
        charge_attempts: number;
        charge_error: string | null;
        charge_next_at: Date | null;
        charge_locked_until: Date | null;
      }>(
        `select provider, external_id, provider_url, provider_status, charge_attempts, charge_error, charge_next_at, charge_locked_until
           from liame.billing_invoice where id = $1`,
        [id],
      )
    )[0]!;

  const pix = (e: Empresa, faturaId: string, cookie = e.cookie) => api.call('GET', `/v1/billing/invoices/${faturaId}/pix`, { cookie });
  const daRotina = (e: Empresa, agora = new Date()) => rotina.executarLote(10, { tenantIds: [e.tenantId] }, agora);
  const daReleitura = (e: Empresa, agora = new Date()) => releitura.executarLote(10, { tenantIds: [e.tenantId] }, agora);
  const pedidos = (metodo: string, caminho: string) => asaas.vistos.filter((v) => v.metodo === metodo && v.caminho === caminho);

  /** O aviso pela porta HTTP, como o Asaas manda: o corpo cru e o token no cabeçalho (nulo: sem o cabeçalho). */
  const avisar = (corpo: string, marca: string | null = MARCA_DO_AVISO_DE_TESTE) =>
    api.call('POST', '/v1/billing/asaas/webhook', { raw: { data: Buffer.from(corpo, 'utf8'), type: 'application/json' }, headers: marca ? { 'asaas-access-token': marca } : {} });

  /** O worker processa o aviso gravado (só o deste teste, pelo id: V10). */
  async function processarAviso(corpo: string): Promise<void> {
    const [ev] = await ownerQuery<{ id: string }>(`select id from liame.inbox_event where provider = 'asaas' and external_event_id = $1`, [JSON.parse(corpo).id as string]);
    expect(ev, 'o aviso não foi gravado').toBeDefined();
    await processador.processBatch(50, { ids: [ev!.id] });
  }

  /** A empresa com a primeira mensalidade e a cobrança dela no Asaas, criada pela rotina. */
  async function comCobranca(nome: string): Promise<{ e: Empresa; faturaId: string; c: CobrancaNoAsaas }> {
    const e = await empresa(nome);
    const faturaId = await assinar(e);
    expect((await daRotina(e))[0]!.resultado).toBe('pronta');
    const [c] = asaas.cobrancasDa(faturaId);
    return { e, faturaId, c: c! };
  }

  const linha = async (id: string) =>
    (
      await ownerQuery<{ status: string; paid_at: Date | null; paid_method: string | null; period_start: string | null; amount_cents: string }>(
        `select status, paid_at, paid_method, period_start::text as period_start, amount_cents::text as amount_cents from liame.billing_invoice where id = $1`,
        [id],
      )
    )[0]!;
  const umDiaDepois = () => new Date(Date.now() + 25 * 3_600_000);
  const meioDia = (dia: string) => new Date(`${dia}T12:00:00-03:00`);

  it('a rotina cria a cobrança PIX da primeira mensalidade: o cliente da empresa sem as notificações do Asaas e a cobrança com o id da fatura; de novo, nada novo', async () => {
    const e = await empresa('Casa Brasa PIX');
    const faturaId = await assinar(e);
    const clientesAntes = asaas.clientes.length;
    const vezes = await daRotina(e);
    expect(vezes).toEqual([{ fatura: faturaId, tenantId: e.tenantId, resultado: 'pronta' }]);

    const clientes = asaas.clientes.slice(clientesAntes);
    expect(clientes).toEqual([expect.objectContaining({ name: 'Casa Brasa PIX', cpfCnpj: CNPJ_DE_EXEMPLO, externalReference: e.tenantId, notificationDisabled: true })]);
    const [c] = asaas.cobrancasDa(faturaId);
    const hoje = diaNoFuso(new Date(), SP);
    expect(c).toMatchObject({ customer: clientes[0]!.id, billingType: 'PIX', value: 249, dueDate: hoje, description: 'Liame · plano Essencial · primeira mensalidade' });
    // Toda chamada leva o User-Agent do Liame (obrigatório para conta nova, base §18.5).
    expect(asaas.vistos.every((v) => v.userAgent === 'Liame (agencialiame.com)')).toBe(true);

    expect(await fatura(faturaId)).toMatchObject({ provider: 'asaas', external_id: c!.id, provider_url: c!.invoiceUrl, provider_status: 'PENDING', charge_error: null, charge_locked_until: null });
    expect(await ownerQuery(`select external_id from liame.billing_customer where tenant_id = $1`, [e.tenantId])).toEqual([{ external_id: clientes[0]!.id }]);

    // A rotina de novo: a fatura já tem a cobrança e nem entra na fila.
    const criacoes = pedidos('POST', '/payments').length;
    expect(await daRotina(e)).toEqual([]);
    expect(pedidos('POST', '/payments')).toHaveLength(criacoes);
  }, 60_000);

  it('o QR Code pela rota: cria a cobrança na hora, e pedir de novo devolve a mesma; o Administrador com a cobrança liberada paga, o Gestor não', async () => {
    const e = await empresa('Casa Brasa QR');
    const faturaId = await assinar(e);
    const r = await pix(e, faturaId);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const corpo = BillingPixResponse.parse(r.body);
    const [c] = asaas.cobrancasDa(faturaId);
    expect(corpo).toMatchObject({ invoice_id: faturaId, amount_cents: '24900', due_date: diaNoFuso(new Date(), SP), invoice_url: c!.invoiceUrl, expires_at: '2027-10-23 23:59:59' });
    expect(corpo.qr_code_png_base64.length).toBeGreaterThan(10);
    expect(corpo.copy_paste).toContain(c!.id);
    expect((await pix(e, faturaId)).status).toBe(200);
    expect(asaas.cobrancasDa(faturaId)).toHaveLength(1);

    async function convidado(papel: string, extra: Record<string, unknown> = {}) {
      const email = uniqueEmail(papel);
      const inv = await api.call('POST', '/v1/invitations', { cookie: e.cookie, body: { email, role: papel, approve_limit_micros: 100_000_000, ...extra } });
      expect(inv.status, JSON.stringify(inv.body)).toBe(201);
      const s = await api.call('POST', '/v1/invitations/signup', { body: { token: tokenFrom(api.mailer, email), name: `Pessoa ${papel}`, password: PASSWORD, terms_version: TERMOS } });
      expect(s.status).toBe(200);
      await enableMfa(api, s.cookie!);
      return s.cookie!;
    }
    const adm = await convidado('administrador', { billing_access: true });
    const gestor = await convidado('gestor');
    expect((await pix(e, faturaId, adm)).status).toBe(200);
    expect((await pix(e, faturaId, gestor)).status).toBe(403);
    // A tela sabe quem paga.
    expect((await api.call('GET', `/v1/billing?brand_id=${e.brandId}`, { cookie: adm })).body).toMatchObject({ can_manage: false, can_pay: true });
  }, 90_000);

  it('o Asaas cria e cai antes de responder: a vez grava a falha e a próxima vez; a seguinte acha a cobrança pelo id da fatura e não cria outra', async () => {
    const e = await empresa('Casa Brasa Queda');
    const faturaId = await assinar(e);
    asaas.caiDepoisDeCriar = true;
    const agora = new Date();
    expect((await daRotina(e, agora))[0]!.resultado).toBe('falhou');
    expect(asaas.cobrancasDa(faturaId)).toHaveLength(1);
    const depois = await fatura(faturaId);
    expect(depois).toMatchObject({ external_id: null, charge_attempts: 1, charge_error: 'meio_fora_do_ar', charge_locked_until: null });
    expect(depois.charge_next_at!.getTime() - agora.getTime()).toBe(60_000);
    // Antes da próxima vez, nada; na próxima vez, a cobrança que ficou lá é a da fatura.
    asaas.caiDepoisDeCriar = false;
    expect(await daRotina(e, new Date(agora.getTime() + 30_000))).toEqual([]);
    expect((await daRotina(e, new Date(agora.getTime() + 61_000)))[0]!.resultado).toBe('pronta');
    expect(asaas.cobrancasDa(faturaId)).toHaveLength(1);
    expect(await fatura(faturaId)).toMatchObject({ external_id: asaas.cobrancasDa(faturaId)[0]!.id, charge_error: null });
  }, 60_000);

  it('o Asaas devolve o endereço sem https e a situação fora do formato: a cobrança fica registrada, sem o endereço e com a situação desconhecida, e a fatura sai da fila (V43)', async () => {
    const e = await empresa('Casa Brasa Formato');
    const faturaId = await assinar(e);
    asaas.enderecoDaFatura = (id) => `http://sandbox.asaas.com/i/${id}`;
    asaas.situacaoNova = 'pending';
    expect((await daRotina(e))[0]!.resultado).toBe('pronta');
    const [c] = asaas.cobrancasDa(faturaId);
    expect(await fatura(faturaId)).toMatchObject({ external_id: c!.id, provider_url: null, provider_status: null, charge_error: null, charge_locked_until: null });
    expect(await daRotina(e)).toEqual([]);
    expect(asaas.cobrancasDa(faturaId)).toHaveLength(1);
  }, 60_000);

  it('o Asaas pede pausa (429): a fatura espera o que ele pediu; recusa a chave (401): o porquê é `chave_recusada`, e a rota responde 503', async () => {
    const e = await empresa('Casa Brasa Pausa');
    const faturaId = await assinar(e);
    asaas.criar = 'sem-cota';
    const agora = new Date();
    expect((await daRotina(e, agora))[0]!.resultado).toBe('falhou');
    const pausa = await fatura(faturaId);
    expect(pausa).toMatchObject({ charge_error: 'limite_do_meio', charge_attempts: 1 });
    // O `RateLimit-Reset` de 120 segundos vence a espera de 1 minuto da primeira vez.
    expect(pausa.charge_next_at!.getTime() - agora.getTime()).toBe(120_000);

    asaas.criar = 'chave-recusada';
    const r = await pix(e, faturaId);
    expect(r.status).toBe(503);
    expect(r.body.code).toBe('pagamento-indisponivel');
    expect(await fatura(faturaId)).toMatchObject({ charge_error: 'chave_recusada', charge_attempts: 2 });
    expect(asaas.cobrancasDa(faturaId)).toHaveLength(0);
  }, 60_000);

  it('sem o CNPJ da empresa: a rota responde 409 `cnpj-necessario` e a rotina espera 2 horas, sem chamar o Asaas', async () => {
    const e = await empresa('Casa Brasa Sem CNPJ', { cnpj: null });
    const faturaId = await assinar(e);
    const chamadas = asaas.vistos.length;
    const r = await pix(e, faturaId);
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('cnpj-necessario');
    const agora = new Date();
    await ownerQuery(`update liame.billing_invoice set charge_next_at = null where id = $1`, [faturaId]);
    expect((await daRotina(e, agora))[0]!.resultado).toBe('sem_cnpj');
    const f = await fatura(faturaId);
    expect(f.charge_error).toBe('sem_cnpj');
    expect(f.charge_next_at!.getTime() - agora.getTime()).toBe(2 * 3_600_000);
    expect(asaas.vistos.length).toBe(chamadas);
  }, 60_000);

  it('a função desligada depois de assinar: a rotina espera 1 hora sem chamar o Asaas, e a rota responde 409 `funcao-desligada`', async () => {
    const e = await empresa('Casa Brasa Desligada');
    const faturaId = await assinar(e);
    await ligarFlagDaEmpresa(api, 'cobranca', e.tenantId, false);
    const chamadas = asaas.vistos.length;
    const agora = new Date();
    expect((await daRotina(e, agora))[0]!.resultado).toBe('desligada');
    expect((await fatura(faturaId)).charge_next_at!.getTime() - agora.getTime()).toBe(3_600_000);
    const r = await pix(e, faturaId);
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('funcao-desligada');
    expect(asaas.vistos.length).toBe(chamadas);
  }, 60_000);

  it('a rotina e a pessoa ao mesmo tempo: enquanto um cria, o outro ouve `cobranca-em-criacao`; no fim, uma cobrança só', async () => {
    const e = await empresa('Casa Brasa Ao Mesmo Tempo');
    const faturaId = await assinar(e);
    let soltar!: () => void;
    asaas.segurarCriacao = new Promise<void>((ok) => {
      soltar = ok;
    });
    const criacoes = pedidos('POST', '/payments').length;
    const vez = daRotina(e);
    for (let i = 0; i < 100 && pedidos('POST', '/payments').length === criacoes; i++) await new Promise((ok) => setTimeout(ok, 50));
    const r = await pix(e, faturaId);
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('cobranca-em-criacao');
    expect(r.headers.get('retry-after')).toBe('5');
    soltar();
    await vez;
    expect(asaas.cobrancasDa(faturaId)).toHaveLength(1);
    expect((await pix(e, faturaId)).status).toBe(200);
    expect(asaas.cobrancasDa(faturaId)).toHaveLength(1);
  }, 60_000);

  it('a fatura de outra empresa não aparece (404); a fatura paga (409 `fatura-nao-esta-em-aberto`); a da assinatura no cartão (409 `fatura-nao-e-pix`)', async () => {
    const e = await empresa('Casa Brasa Fatura');
    const faturaId = await assinar(e);
    const vizinha = await empresa('Casa Brasa Vizinha');
    const r = await pix(vizinha, faturaId);
    expect(r.status).toBe(404);
    expect(r.body.code).toBe('fatura-nao-encontrada');
    await withSystem(database.db, (tx) => pagarFatura(tx, { faturaId, pagoEm: new Date(), forma: 'pix', agora: new Date() }));
    const paga = await pix(e, faturaId);
    expect(paga.status).toBe(409);
    expect(paga.body.code).toBe('fatura-nao-esta-em-aberto');
    const cartao = await empresa('Casa Brasa Cartão');
    const daCartao = await assinar(cartao, 'cartao');
    const nc = await pix(cartao, daCartao);
    expect(nc.status).toBe(409);
    expect(nc.body.code).toBe('fatura-nao-e-pix');
  }, 90_000);

  it('abaixo do mínimo do Asaas (R$ 5), a diferença da troca de plano não vira cobrança: o plano muda na hora (D-A7-32)', async () => {
    const e = await empresa('Casa Brasa Mínimo');
    const faturaId = await assinar(e);
    await withSystem(database.db, (tx) => pagarFatura(tx, { faturaId, pagoEm: new Date(), forma: 'pix', agora: new Date() }));
    // Uma versão de plano R$ 1 mais cara (é a distribuição que publica versões; fora das oferecidas, para não mudar a tela).
    const sufixo = Array.from(randomBytes(8), (b) => String.fromCharCode(97 + (b % 26))).join('');
    const [plano] = await ownerQuery<{ id: string; price_cents: string }>(
      `insert into liame.billing_plan (id, key, version, name, price_cents, agents, offered) values (gen_random_uuid(), $1, 1, 'Teste do mínimo', 25000, array['lia'], false) returning id, price_cents::text`,
      [`minimo_${sufixo}`],
    );
    const troca = await withSystem(database.db, async (tx) => {
      const s = await assinaturaVivaTravada(tx, e.brandId);
      return trocarPlano(tx, s!, plano!, new Date());
    });
    expect(troca).toEqual({ tipo: 'subir', diferencaCents: 0, faturaId: null });
    const [s] = await ownerQuery<{ plan_id: string }>(`select plan_id from liame.subscription where brand_id = $1 and status <> 'encerrada'`, [e.brandId]);
    expect(s!.plan_id).toBe(plano!.id);
    expect(await ownerQuery(`select 1 from liame.billing_invoice where brand_id = $1 and kind = 'diferenca'`, [e.brandId])).toHaveLength(0);
  }, 60_000);

  // ------------------------------------------------------------ W2a, parte 2: o aviso e a releitura

  it('o aviso pela rota: sem o token ou com outro, 401; com o certo, 200, e o mesmo evento de novo, 200 e uma linha só; o aviso marca a fatura, e a releitura paga, com o dia do Asaas', async () => {
    const { e, faturaId, c } = await comCobranca('Casa Brasa Aviso');
    const hoje = diaNoFuso(new Date(), SP);
    // A cobrança nova fica para a releitura do dia seguinte.
    expect((await fatura(faturaId)).charge_next_at!.getTime()).toBeGreaterThan(Date.now() + 23 * 3_600_000);
    asaas.pagar(c.id, hoje);
    const corpo = asaas.aviso(c);
    expect((await avisar(corpo, null)).status).toBe(401);
    expect((await avisar(corpo, `${MARCA_DO_AVISO_DE_TESTE}-outra`)).status).toBe(401);
    const r = await avisar(corpo);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect((await avisar(corpo)).status).toBe(200);
    expect(await ownerQuery(`select type from liame.inbox_event where provider = 'asaas' and external_event_id = $1`, [JSON.parse(corpo).id])).toEqual([{ type: 'PAYMENT_RECEIVED' }]);
    // O token nunca é guardado com o evento.
    const [h] = await ownerQuery<{ headers: Record<string, unknown> }>(`select headers from liame.inbox_event where provider = 'asaas' and external_event_id = $1`, [JSON.parse(corpo).id]);
    expect(Object.keys(h!.headers)).not.toContain('asaas-access-token');

    await processarAviso(corpo);
    expect((await fatura(faturaId)).charge_next_at!.getTime()).toBeLessThanOrEqual(Date.now() + 1000);
    expect(await daReleitura(e)).toEqual([{ fatura: faturaId, tenantId: e.tenantId, resultado: 'paga' }]);
    expect(await linha(faturaId)).toMatchObject({ status: 'paga', paid_method: 'pix', period_start: hoje });
    const [s] = await ownerQuery<{ status: string }>(`select status from liame.subscription where brand_id = $1 and status <> 'encerrada'`, [e.brandId]);
    expect(s!.status).toBe('ativa');
    expect(await fatura(faturaId)).toMatchObject({ provider_status: 'RECEIVED', charge_next_at: null, charge_error: null, charge_locked_until: null });
    expect(await ownerQuery(`select action from liame.audit_event where tenant_id = $1 and action = 'cobranca.pagamento'`, [e.tenantId])).toHaveLength(1);
    // De novo, nada: a fatura paga saiu da fila.
    expect(await daReleitura(e, umDiaDepois())).toEqual([]);
  }, 90_000);

  it('sem aviso, a releitura de cada dia: a cobrança pendente é relida e fica para o dia seguinte', async () => {
    const { e, faturaId, c } = await comCobranca('Casa Brasa Diária');
    const proxima = (await fatura(faturaId)).charge_next_at!;
    expect(await daReleitura(e)).toEqual([]);
    const depois = new Date(proxima.getTime() + 1000);
    expect(await daReleitura(e, depois)).toEqual([{ fatura: faturaId, tenantId: e.tenantId, resultado: 'esperando' }]);
    expect(pedidos('GET', `/payments/${c.id}`)).toHaveLength(1);
    const f = await fatura(faturaId);
    expect(f).toMatchObject({ provider_status: 'PENDING', charge_locked_until: null, charge_error: null });
    expect(f.charge_next_at!.getTime()).toBe(depois.getTime() + 24 * 3_600_000);
    expect((await linha(faturaId)).status).toBe('aberta');
  }, 60_000);

  it('a fatura cancelada no Liame (outro plano antes do primeiro pagamento): a cobrança sai do Asaas na hora, e a fila acaba', async () => {
    const { e, faturaId, c } = await comCobranca('Casa Brasa Cancelada');
    const r = await api.call('POST', '/v1/billing/subscription', { cookie: e.cookie, body: { brand_id: e.brandId, plan: 'completo', method: 'pix' } });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect((await linha(faturaId)).status).toBe('cancelada');
    expect((await fatura(faturaId)).charge_next_at!.getTime()).toBeLessThanOrEqual(Date.now() + 1000);
    expect(await daReleitura(e)).toEqual([{ fatura: faturaId, tenantId: e.tenantId, resultado: 'removida' }]);
    expect(pedidos('DELETE', `/payments/${c.id}`)).toHaveLength(1);
    expect(asaas.cobrancas.find((x) => x.id === c.id)!.deleted).toBe(true);
    expect(await fatura(faturaId)).toMatchObject({ provider_status: 'DELETED', charge_next_at: null, charge_locked_until: null });
  }, 60_000);

  it('o valor da mensalidade em aberto mudou no Liame (desceu de plano): a cobrança velha sai e nasce outra com o valor novo', async () => {
    const e = await empresa('Casa Brasa Troca');
    const primeira = await assinar(e);
    const pago = new Date();
    await withSystem(database.db, (tx) => pagarFatura(tx, { faturaId: primeira, pagoEm: pago, forma: 'pix', agora: pago }));
    const [s] = await ownerQuery<{ id: string; period_end: string }>(`select id, period_end::text as period_end from liame.subscription where brand_id = $1 and status <> 'encerrada'`, [e.brandId]);
    // A mensalidade seguinte nasce 5 dias antes do vencimento (W1), e a rotina cria a cobrança dela.
    const antes = meioDia(somarDias(s!.period_end, -5));
    await withSystem(database.db, (tx) => vezDaAssinatura(tx, s!.id, antes));
    const [seguinte] = await ownerQuery<{ id: string }>(`select id from liame.billing_invoice where subscription_id = $1 and status = 'aberta'`, [s!.id]);
    expect((await daRotina(e, antes))[0]).toMatchObject({ fatura: seguinte!.id, resultado: 'pronta' });
    expect(asaas.cobrancasDa(seguinte!.id).map((x) => x.value)).toEqual([249]);

    // Uma versão de plano mais barata (fora das oferecidas, para não mudar a tela): descer vale no período seguinte.
    const sufixo = Array.from(randomBytes(8), (b) => String.fromCharCode(97 + (b % 26))).join('');
    const [barato] = await ownerQuery<{ id: string; price_cents: string }>(
      `insert into liame.billing_plan (id, key, version, name, price_cents, agents, offered) values (gen_random_uuid(), $1, 1, 'Teste do mais barato', 19900, array['lia'], false) returning id, price_cents::text`,
      [`barato_${sufixo}`],
    );
    const troca = await withSystem(database.db, async (tx) => {
      const viva = await assinaturaVivaTravada(tx, e.brandId);
      return trocarPlano(tx, viva!, barato!, antes);
    });
    expect(troca).toMatchObject({ tipo: 'descer' });
    expect((await linha(seguinte!.id)).amount_cents).toBe('19900');
    expect((await fatura(seguinte!.id)).charge_next_at!.getTime()).toBe(antes.getTime());

    expect(await daReleitura(e, antes)).toEqual([{ fatura: seguinte!.id, tenantId: e.tenantId, resultado: 'refeita' }]);
    expect(await fatura(seguinte!.id)).toMatchObject({ provider: null, external_id: null });
    expect((await daRotina(e, antes))[0]).toMatchObject({ fatura: seguinte!.id, resultado: 'pronta' });
    const cobrancas = asaas.cobrancasDa(seguinte!.id);
    expect(cobrancas.map((x) => ({ valor: x.value, removida: x.deleted }))).toEqual([
      { valor: 249, removida: true },
      { valor: 199, removida: false },
    ]);
    expect((await fatura(seguinte!.id)).external_id).toBe(cobrancas[1]!.id);
  }, 90_000);

  it('a cobrança removida no painel do Asaas (ele responde 404): a releitura refaz, e a rotina cria outra', async () => {
    const { e, faturaId, c } = await comCobranca('Casa Brasa Removida');
    asaas.removerNoPainel(c.id);
    const depois = umDiaDepois();
    expect(await daReleitura(e, depois)).toEqual([{ fatura: faturaId, tenantId: e.tenantId, resultado: 'refeita' }]);
    expect(pedidos('DELETE', `/payments/${c.id}`)).toHaveLength(0);
    expect((await daRotina(e, depois))[0]).toMatchObject({ fatura: faturaId, resultado: 'pronta' });
    const vivas = asaas.cobrancasDa(faturaId).filter((x) => !x.deleted);
    expect(vivas).toHaveLength(1);
    expect((await fatura(faturaId)).external_id).toBe(vivas[0]!.id);
  }, 60_000);

  it('paga com o valor menor que o da fatura: a releitura para (`valor_divergente`), sem pagar a fatura', async () => {
    const { e, faturaId, c } = await comCobranca('Casa Brasa Divergente');
    asaas.pagar(c.id, diaNoFuso(new Date(), SP), { valor: 200 });
    const corpo = asaas.aviso(c);
    expect((await avisar(corpo)).status).toBe(200);
    await processarAviso(corpo);
    expect(await daReleitura(e)).toEqual([{ fatura: faturaId, tenantId: e.tenantId, resultado: 'parada' }]);
    expect(await fatura(faturaId)).toMatchObject({ charge_error: 'valor_divergente', charge_next_at: null, provider_status: 'RECEIVED' });
    expect((await linha(faturaId)).status).toBe('aberta');
  }, 60_000);

  it('paga no Asaas depois de cancelada no Liame: a releitura para (`paga_apos_cancelar`), e a cobrança não é removida', async () => {
    const { e, faturaId, c } = await comCobranca('Casa Brasa Paga Depois');
    asaas.pagar(c.id, diaNoFuso(new Date(), SP));
    expect((await api.call('POST', '/v1/billing/subscription', { cookie: e.cookie, body: { brand_id: e.brandId, plan: 'completo', method: 'pix' } })).status).toBe(200);
    expect(await daReleitura(e)).toEqual([{ fatura: faturaId, tenantId: e.tenantId, resultado: 'parada' }]);
    expect(pedidos('DELETE', `/payments/${c.id}`)).toHaveLength(0);
    expect(await fatura(faturaId)).toMatchObject({ charge_error: 'paga_apos_cancelar', charge_next_at: null });
    expect((await linha(faturaId)).status).toBe('cancelada');
  }, 60_000);

  it('o aviso que chega no meio da releitura não se perde (V49): quem termina a vez não empurra a fatura para o dia seguinte', async () => {
    const { e, faturaId, c } = await comCobranca('Casa Brasa No Meio');
    let soltar!: () => void;
    asaas.segurarLeitura = new Promise<void>((ok) => {
      soltar = ok;
    });
    const vez = daReleitura(e, umDiaDepois());
    for (let i = 0; i < 100 && pedidos('GET', `/payments/${c.id}`).length === 0; i++) await new Promise((ok) => setTimeout(ok, 50));
    expect(pedidos('GET', `/payments/${c.id}`)).toHaveLength(1);
    const corpo = asaas.aviso(c, 'PAYMENT_UPDATED');
    expect((await avisar(corpo)).status).toBe(200);
    await processarAviso(corpo);
    soltar();
    expect((await vez)[0]!.resultado).toBe('esperando');
    // A marca do aviso ficou: a próxima vez é agora, e não o dia seguinte ao relógio da releitura.
    expect((await fatura(faturaId)).charge_next_at!.getTime()).toBeLessThanOrEqual(Date.now() + 1000);
    expect((await daReleitura(e))[0]!.resultado).toBe('esperando');
  }, 60_000);

  it('a releitura com o Asaas fora do ar: espera 1 minuto, com o porquê em código', async () => {
    const { e, faturaId } = await comCobranca('Casa Brasa Releitura Fora');
    asaas.ler = 'fora';
    const depois = umDiaDepois();
    expect((await daReleitura(e, depois))[0]!.resultado).toBe('falhou');
    const f = await fatura(faturaId);
    expect(f).toMatchObject({ charge_error: 'meio_fora_do_ar', charge_attempts: 1, charge_locked_until: null });
    expect(f.charge_next_at!.getTime() - depois.getTime()).toBe(60_000);
  }, 60_000);

  it('o aviso que chega antes de a referência ser gravada (o Asaas criou e caiu, e o cliente pagou): o aviso acha a fatura pelo id dela, e ela é paga na hora', async () => {
    const e = await empresa('Casa Brasa Antes da Referência');
    const faturaId = await assinar(e);
    asaas.caiDepoisDeCriar = true;
    expect((await daRotina(e))[0]!.resultado).toBe('falhou');
    asaas.caiDepoisDeCriar = false;
    const [c] = asaas.cobrancasDa(faturaId);
    asaas.pagar(c!.id, diaNoFuso(new Date(), SP));
    const corpo = asaas.aviso(c!);
    expect((await avisar(corpo)).status).toBe(200);
    await processarAviso(corpo);
    expect(await fatura(faturaId)).toMatchObject({ external_id: null });
    expect((await fatura(faturaId)).charge_next_at!.getTime()).toBeLessThanOrEqual(Date.now() + 1000);
    // A fila da criação acha a cobrança pelo id da fatura, já paga: grava e marca a releitura para agora.
    expect((await daRotina(e))[0]!.resultado).toBe('pronta');
    expect(asaas.cobrancasDa(faturaId)).toHaveLength(1);
    expect(await daReleitura(e)).toEqual([{ fatura: faturaId, tenantId: e.tenantId, resultado: 'paga' }]);
    expect((await linha(faturaId)).status).toBe('paga');
  }, 60_000);

  it('as restrições novas (V119): o endereço da fatura só com https, a situação do meio e o porquê em código, e o cliente do meio de uma empresa só', async () => {
    const e = await empresa('Casa Brasa Restrições do PIX');
    const faturaId = await assinar(e);
    const erro = async (sqlText: string, params: unknown[]) => {
      try {
        await ownerQuery(sqlText, params);
        return null;
      } catch (err) {
        return (err as { constraint?: string }).constraint ?? (err as { code?: string }).code ?? 'erro';
      }
    };
    expect(await erro(`update liame.billing_invoice set provider_url = 'http://sandbox.asaas.com/i/x' where id = $1`, [faturaId])).toBe('billing_invoice_provider_url_check');
    expect(await erro(`update liame.billing_invoice set provider_url = 'https://sandbox.asaas.com/i/x' where id = $1`, [faturaId])).toBeNull();
    expect(await erro(`update liame.billing_invoice set provider_status = 'pago' where id = $1`, [faturaId])).toBe('billing_invoice_provider_status_check');
    expect(await erro(`update liame.billing_invoice set provider_status = 'RECEIVED' where id = $1`, [faturaId])).toBeNull();
    expect(await erro(`update liame.billing_invoice set charge_error = 'Caiu a conexão' where id = $1`, [faturaId])).toBe('billing_invoice_charge_error_check');
    expect(await erro(`update liame.billing_invoice set charge_error = 'meio_fora_do_ar' where id = $1`, [faturaId])).toBeNull();
    // O banco de teste não é zerado entre as execuções: os ids do Asaas são novos a cada vez.
    const outra = await empresa('Casa Brasa Outra do PIX');
    const [um, dois] = [`cus_${randomBytes(6).toString('hex')}`, `cus_${randomBytes(6).toString('hex')}`];
    await ownerQuery(`insert into liame.billing_customer (tenant_id, provider, external_id) values ($1, 'asaas', $2)`, [e.tenantId, um]);
    expect(await erro(`insert into liame.billing_customer (tenant_id, provider, external_id) values ($1, 'asaas', $2)`, [outra.tenantId, um])).toBe('billing_customer_externo');
    expect(await erro(`insert into liame.billing_customer (tenant_id, provider, external_id) values ($1, 'asaas', $2)`, [e.tenantId, dois])).toBe('billing_customer_pk');
  }, 60_000);
});
