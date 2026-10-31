import { createDatabase, type Database, withSystem } from '@liame/database';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { criarAssinatura, pagarFatura } from '../../src/cobranca/assinatura.js';
import { MeioAsaas } from '../../src/cobranca/meio-asaas.js';
import { APP_CONFIG, type AppConfig } from '../../src/config.js';
import { PROVIDER_ASAAS } from '../../src/connectors/asaas/api-asaas.js';
import { chaveDe } from '../../src/connectors/cota.js';
import { FlagService } from '../../src/flags/flag.service.js';
import { Mailer, type MailMessage } from '../../src/mail/mailer.js';
import { AssinaturasLoop } from '../../src/worker/assinaturas-loop.js';
import { CobrancasDoMesService } from '../../src/worker/cobrancas-do-mes.service.js';
import { CobrancasPixLoop } from '../../src/worker/cobrancas-pix-loop.js';
import { AsaasDeMentira } from '../helpers/asaas-de-mentira.js';
import { enableMfa, ownerQuery, PASSWORD, resetIpRateLimits, startApi, TERMOS, type TestApi, tokenFrom, uniqueEmail } from '../helpers/api.js';
import { ligarFlagDaEmpresa } from '../helpers/meta-de-mentira.js';
import { APP_URL, hasDb } from './env.js';

// A cobrança do mês por e-mail, com o PIX (A7; migration 0096; D-A7-17, D-A7-44), contra um Asaas local e com o relógio
// do teste nas rotinas: a fatura do período seguinte nasce 5 dias antes (a rotina das assinaturas), ganha a cobrança no
// Asaas (a rotina do PIX), e o e-mail sai a quem paga, com o código do PIX, uma vez por fatura e pessoa. Nada antes da
// cobrança existir; a primeira mensalidade fica de fora; o Asaas fora do ar não reserva nada; a falha do envio tenta de
// novo; a função desligada; e a regra do dia na tabela (V119).

const SP = 'America/Sao_Paulo';
/** O CNPJ de exemplo das documentações (11.222.333/0001-81), nunca o de um cliente. */
const CNPJ_DE_EXEMPLO = '11222333000181';
const meioDia = (dia: string) => new Date(`${dia}T15:00:00Z`);

class CarteiroDeTeste extends Mailer {
  readonly enviados: MailMessage[] = [];
  readonly falhar = new Set<string>();
  async send(m: MailMessage): Promise<void> {
    if (this.falhar.has(m.to)) {
      const erro = new Error('caixa cheia');
      erro.name = 'SesRecusou';
      throw erro;
    }
    this.enviados.push(m);
  }
}

type Empresa = { cookie: string; email: string; tenantId: string; brandId: string; userId: string };

describe.skipIf(!hasDb)('a cobrança do mês por e-mail, com o PIX (A7; D-A7-44)', () => {
  let asaas: AsaasDeMentira;
  let api: TestApi;
  let database: Database;
  let assinaturas: AssinaturasLoop;
  let pixDoMes: CobrancasPixLoop;
  let carteiro: CarteiroDeTeste;
  let rotina: CobrancasDoMesService;

  beforeAll(async () => {
    // O Asaas sobe antes da API: a configuração lê o endereço e a chave dele do ambiente.
    asaas = new AsaasDeMentira();
    await asaas.subir();
    api = await startApi();
    await resetIpRateLimits();
    database = createDatabase({ connectionString: APP_URL, max: 4, applicationName: 'liame-test' });
    assinaturas = new AssinaturasLoop(database, api.app.get(FlagService));
    pixDoMes = new CobrancasPixLoop(database, api.app.get(MeioAsaas), api.app.get(FlagService));
    carteiro = new CarteiroDeTeste();
    rotina = new CobrancasDoMesService(database, api.app.get(FlagService), carteiro, api.app.get(MeioAsaas), api.app.get<AppConfig>(APP_CONFIG));
  }, 120_000);
  beforeEach(async () => {
    await resetIpRateLimits();
    const chave = chaveDe(PROVIDER_ASAAS, 'liame');
    await ownerQuery(`delete from liame.circuit_state where circuit_key = $1`, [chave]);
    await ownerQuery(`delete from liame.quota_bucket where bucket_key = $1`, [chave]);
    asaas.criar = 'ok';
    asaas.qrCode = 'ok';
  });
  afterAll(async () => {
    await api?.close();
    await database?.close();
    await asaas?.fechar();
  });

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
    await enableMfa(api, cookie);
    const tenantId = login.body.active_organization_id as string;
    const brandId = (await api.call('GET', '/v1/brands', { cookie })).body.items[0].id as string;
    const [u] = await ownerQuery<{ id: string }>(`select id from liame.app_user where email = $1`, [email]);
    await ownerQuery(`update liame.organization set timezone = $2 where id = $1`, [tenantId, SP]);
    await ligarFlagDaEmpresa(api, 'cobranca', tenantId, true);
    return { cookie, email, tenantId, brandId, userId: u!.id };
  }
  async function convidado(e: Empresa, papel: string, extra: Record<string, unknown> = {}): Promise<string> {
    const email = uniqueEmail(papel);
    const inv = await api.call('POST', '/v1/invitations', { cookie: e.cookie, body: { email, role: papel, approve_limit_micros: 100_000_000, ...extra } });
    expect(inv.status, JSON.stringify(inv.body)).toBe(201);
    const s = await api.call('POST', '/v1/invitations/signup', { body: { token: tokenFrom(api.mailer, email), name: `Pessoa ${papel}`, password: PASSWORD, terms_version: TERMOS } });
    expect(s.status).toBe(200);
    return email;
  }
  /** Assinada em 21/10/2026 e paga em 22/10, no PIX: o período vai de 22/10 a 22/11; a de 22/11 nasce em 17/11. */
  async function assinada(e: Empresa): Promise<string> {
    const [plano] = await ownerQuery<{ id: string }>(`select id from liame.billing_plan where key = 'essencial' and offered`);
    await withSystem(database.db, (tx) => criarAssinatura(tx, { tenantId: e.tenantId, brandId: e.brandId, planoId: plano!.id, forma: 'pix', quem: e.userId, agora: meioDia('2026-10-21') }));
    const [f] = await ownerQuery<{ id: string }>(`select id from liame.billing_invoice where brand_id = $1 and status = 'aberta'`, [e.brandId]);
    // A primeira mensalidade ganha a cobrança no Asaas antes de ser paga: mesmo assim, ela nunca recebe o e-mail do mês.
    await pixDoMes.executarLote(10, { tenantIds: [e.tenantId] }, meioDia('2026-10-21'));
    expect(await rotina.executarLote(100, { tenantIds: [e.tenantId] }, meioDia('2026-10-21'))).toEqual([]);
    await withSystem(database.db, (tx) => pagarFatura(tx, { faturaId: f!.id, pagoEm: meioDia('2026-10-22'), forma: 'pix', agora: meioDia('2026-10-22') }));
    return f!.id;
  }
  /** O dia: a rotina das assinaturas (a fatura nasce), a do PIX (a cobrança no Asaas) e a da cobrança do mês. */
  async function noDia(e: Empresa, dia: string, { comPix = true } = {}) {
    await ownerQuery(`update liame.subscription set next_check_at = $2 where tenant_id = $1 and status <> 'encerrada'`, [e.tenantId, meioDia(dia).toISOString()]);
    await assinaturas.executarLote(20, { tenantIds: [e.tenantId] }, meioDia(dia));
    if (comPix) {
      await ownerQuery(`update liame.billing_invoice set charge_next_at = null where tenant_id = $1 and status = 'aberta' and external_id is null`, [e.tenantId]);
      await pixDoMes.executarLote(10, { tenantIds: [e.tenantId] }, meioDia(dia));
    }
    return rotina.executarLote(100, { tenantIds: [e.tenantId] }, meioDia(dia));
  }
  const entregas = (e: Empresa) =>
    ownerQuery<{ day: number; status: string; attempts: number; error: string | null }>(
      `select day, status, attempts, error from liame.billing_notice where tenant_id = $1 order by created_at`,
      [e.tenantId],
    );
  const novembro = async (e: Empresa) =>
    (await ownerQuery<{ id: string; external_id: string | null }>(`select id, external_id from liame.billing_invoice where brand_id = $1 and due_date = '2026-11-22'`, [e.brandId]))[0];

  it('a fatura de 22/11, com a cobrança no Asaas, vai por e-mail a quem paga com o código do PIX, uma vez só', async () => {
    const e = await empresa('Casa Brasa Mês');
    const adm = await convidado(e, 'administrador', { billing_access: true });
    await convidado(e, 'administrador');
    await convidado(e, 'gestor');
    await assinada(e);

    // 16/11: a fatura ainda não nasceu; nada.
    expect(await noDia(e, '2026-11-16')).toEqual([]);
    // 17/11: nasce a de 22/11; sem a cobrança no Asaas ainda (a rotina do PIX não rodou), nada sai.
    expect(await noDia(e, '2026-11-17', { comPix: false })).toEqual([]);
    expect(carteiro.enviados.filter((m) => m.to === e.email)).toEqual([]);

    // Com a cobrança no Asaas: o e-mail a quem paga (o Dono e o Administrador com a cobrança liberada).
    const antes = carteiro.enviados.length;
    expect((await noDia(e, '2026-11-17')).map((r) => [r.enviados, r.resultado])).toEqual([[2, 'avisada']]);
    const novos = carteiro.enviados.slice(antes);
    expect(novos.map((m) => m.to).sort()).toEqual([e.email, adm].sort());
    const f = (await novembro(e))!;
    expect(f.external_id).not.toBeNull();
    expect(novos[0]!.subject).toMatch(/^Liame: a mensalidade de novembro da .+ vence em 22\/11$/);
    expect(novos[0]!.text).toContain('de R$ 249,00, vence em 22/11.');
    expect(novos[0]!.text).toContain(`br.gov.bcb.pix2560${f.external_id}`);
    expect(novos[0]!.text).toContain(`/cobranca?marca=${e.brandId}`);
    expect(await entregas(e)).toEqual([
      { day: 0, status: 'enviado', attempts: 1, error: null },
      { day: 0, status: 'enviado', attempts: 1, error: null },
    ]);

    // De novo no mesmo dia, e no dia seguinte: nada em dobro, e o Asaas nem é chamado.
    const qrAntes = asaas.vistos.filter((v) => v.caminho.endsWith('/pixQrCode')).length;
    expect((await noDia(e, '2026-11-17')).map((r) => r.resultado)).toEqual(['ja_avisada']);
    expect((await noDia(e, '2026-11-18')).map((r) => r.resultado)).toEqual(['ja_avisada']);
    expect(asaas.vistos.filter((v) => v.caminho.endsWith('/pixQrCode')).length).toBe(qrAntes);
    expect(carteiro.enviados.length).toBe(antes + 2);

    // Paga a de novembro: nada mais dela.
    await withSystem(database.db, (tx) => pagarFatura(tx, { faturaId: f.id, pagoEm: meioDia('2026-11-19'), forma: 'pix', agora: meioDia('2026-11-19') }));
    expect(await noDia(e, '2026-11-19')).toEqual([]);
  }, 120_000);

  it('o Asaas fora do ar não reserva ninguém; a falha do envio tenta de novo; a função desligada segura o envio', async () => {
    const e = await empresa('Casa Brasa Mês Falha');
    await assinada(e);
    await noDia(e, '2026-11-16');

    // O Asaas não devolve o código: ninguém é reservado, e a próxima volta tenta de novo.
    asaas.qrCode = 'fora';
    expect((await noDia(e, '2026-11-17')).map((r) => r.resultado)).toEqual(['sem_codigo']);
    expect(await entregas(e)).toEqual([]);
    expect(carteiro.enviados.filter((m) => m.to === e.email)).toEqual([]);

    // O Asaas volta, e o envio falha: a entrega fica com o tipo do erro, sem o endereço.
    asaas.qrCode = 'ok';
    carteiro.falhar.add(e.email);
    expect((await noDia(e, '2026-11-17')).map((r) => [r.falhas, r.resultado])).toEqual([[1, 'avisada']]);
    expect(await entregas(e)).toEqual([{ day: 0, status: 'falhou', attempts: 1, error: 'SesRecusou' }]);
    carteiro.falhar.delete(e.email);

    // A função desligada: a entrega que falta não sai, nem é reservada.
    await ligarFlagDaEmpresa(api, 'cobranca', e.tenantId, false);
    expect((await rotina.executarLote(100, { tenantIds: [e.tenantId] }, meioDia('2026-11-18'))).map((r) => r.resultado)).toEqual(['desligada']);
    expect(await entregas(e)).toEqual([{ day: 0, status: 'falhou', attempts: 1, error: 'SesRecusou' }]);
    expect(carteiro.enviados.filter((m) => m.to === e.email)).toEqual([]);

    // Religada, a próxima volta manda.
    await ligarFlagDaEmpresa(api, 'cobranca', e.tenantId, true);
    expect((await noDia(e, '2026-11-18')).map((r) => [r.enviados, r.resultado])).toEqual([[1, 'avisada']]);
    expect(await entregas(e)).toEqual([{ day: 0, status: 'enviado', attempts: 2, error: null }]);
    expect(carteiro.enviados.filter((m) => m.to === e.email)).toHaveLength(1);
  }, 120_000);

  it('V119: a tabela das entregas aceita o dia 0 e segue recusando um dia fora da lista', async () => {
    const e = await empresa('Casa Brasa Mês Regra');
    const fatura = await assinada(e);
    const [s] = await ownerQuery<{ id: string }>(`select id from liame.subscription where brand_id = $1`, [e.brandId]);
    const inserir = (dia: number) =>
      ownerQuery(
        `insert into liame.billing_notice (id, tenant_id, subscription_id, invoice_id, day, user_id, status, attempts, claimed_at)
         values (gen_random_uuid(), $1, $2, $3, $4, $5, 'enviando', 1, now())`,
        [e.tenantId, s!.id, fatura, dia, e.userId],
      );
    await expect(inserir(0)).resolves.toBeDefined();
    await expect(inserir(2)).rejects.toThrow(/billing_notice_day_check/);
  });
});
