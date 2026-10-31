import { createDatabase, type Database, withSystem } from '@liame/database';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { criarAssinatura, pagarFatura } from '../../src/cobranca/assinatura.js';
import { APP_CONFIG, type AppConfig } from '../../src/config.js';
import { FlagService } from '../../src/flags/flag.service.js';
import { Mailer, type MailMessage } from '../../src/mail/mailer.js';
import { AssinaturasLoop } from '../../src/worker/assinaturas-loop.js';
import { AvisosDeAtrasoService } from '../../src/worker/avisos-de-atraso.service.js';
import { enableMfa, ownerQuery, PASSWORD, resetIpRateLimits, signupAndLogin, startApi, TERMOS, type TestApi, tokenFrom, uniqueEmail } from '../helpers/api.js';
import { ligarFlagDaEmpresa } from '../helpers/meta-de-mentira.js';
import { APP_URL, hasDb } from './env.js';

// A7 · W3, parte 2 (migration 0095; D-A7-15, D-A7-39; Termos 10.4): o aviso do atraso por e-mail, com o relógio do
// teste na rotina das assinaturas e na dos avisos. Quem recebe (o Dono e o Administrador com a cobrança liberada; nunca
// o Administrador sem ela nem o Gestor), em que dias, uma vez por fatura, dia e pessoa; a falha que tenta de novo; a
// entrega reservada por uma volta que caiu; pagou, nada mais; a função desligada; e as restrições da tabela (V119).

const SP = 'America/Sao_Paulo';
const meioDia = (dia: string) => new Date(`${dia}T15:00:00Z`);

/** O carteiro do teste: guarda o que saiu e falha para os endereços marcados. */
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

describe.skipIf(!hasDb)('o aviso do atraso por e-mail (A7 · W3, parte 2)', () => {
  let api: TestApi;
  let database: Database;
  let rotina: AssinaturasLoop;
  let carteiro: CarteiroDeTeste;
  let avisos: AvisosDeAtrasoService;

  beforeAll(async () => {
    api = await startApi();
    await resetIpRateLimits();
    database = createDatabase({ connectionString: APP_URL, max: 4, applicationName: 'liame-test' });
    rotina = new AssinaturasLoop(database, api.app.get(FlagService));
    carteiro = new CarteiroDeTeste();
    avisos = new AvisosDeAtrasoService(database, api.app.get(FlagService), carteiro, api.app.get<AppConfig>(APP_CONFIG));
  }, 120_000);
  beforeEach(resetIpRateLimits);
  afterAll(async () => {
    await api?.close();
    await database?.close();
  });

  async function empresa(nome: string, { ligada = true } = {}) {
    const s = await signupAndLogin(api, undefined, nome);
    await enableMfa(api, s.cookie);
    const tenantId = s.me.active_organization_id as string;
    const brandId = (await api.call('GET', '/v1/brands', { cookie: s.cookie })).body.items[0].id as string;
    const [u] = await ownerQuery<{ id: string }>(`select id from liame.app_user where email = $1`, [s.email]);
    await ownerQuery(`update liame.organization set timezone = $2 where id = $1`, [tenantId, SP]);
    if (ligada) await ligarFlagDaEmpresa(api, 'cobranca', tenantId, true);
    return { cookie: s.cookie, email: s.email as string, tenantId, brandId, userId: u!.id };
  }
  async function convidado(e: { cookie: string }, papel: string, extra: Record<string, unknown> = {}) {
    const email = uniqueEmail(papel);
    const inv = await api.call('POST', '/v1/invitations', { cookie: e.cookie, body: { email, role: papel, approve_limit_micros: 100_000_000, ...extra } });
    expect(inv.status, JSON.stringify(inv.body)).toBe(201);
    const s = await api.call('POST', '/v1/invitations/signup', { body: { token: tokenFrom(api.mailer, email), name: `Pessoa ${papel}`, password: PASSWORD, terms_version: TERMOS } });
    expect(s.status).toBe(200);
    return email;
  }
  /** A assinatura paga em 22/10/2026: o período vai de 22/10 a 22/11, e a de 22/11 nasce em 17/11. */
  async function assinada(e: { tenantId: string; brandId: string; userId: string }) {
    const [plano] = await ownerQuery<{ id: string }>(`select id from liame.billing_plan where key = 'essencial' and offered`);
    await withSystem(database.db, (tx) => criarAssinatura(tx, { tenantId: e.tenantId, brandId: e.brandId, planoId: plano!.id, forma: 'pix', quem: e.userId, agora: meioDia('2026-10-21') }));
    const [f] = await ownerQuery<{ id: string }>(`select id from liame.billing_invoice where brand_id = $1 and status = 'aberta'`, [e.brandId]);
    await withSystem(database.db, (tx) => pagarFatura(tx, { faturaId: f!.id, pagoEm: meioDia('2026-10-22'), forma: 'pix', agora: meioDia('2026-10-22') }));
  }
  async function noDia(e: { tenantId: string }, dia: string) {
    await ownerQuery(`update liame.subscription set next_check_at = $2 where tenant_id = $1 and status <> 'encerrada'`, [e.tenantId, meioDia(dia).toISOString()]);
    await rotina.executarLote(20, { tenantIds: [e.tenantId] }, meioDia(dia));
    return avisos.executarLote(100, { tenantIds: [e.tenantId] }, meioDia(dia));
  }
  const paraQuem = (de: number) => carteiro.enviados.slice(de).map((m) => m.to).sort();
  const entregas = (e: { tenantId: string }) =>
    ownerQuery<{ day: number; status: string; attempts: number; error: string | null }>(
      `select day, status, attempts, error from liame.billing_notice where tenant_id = $1 order by day, created_at`,
      [e.tenantId],
    );

  it('no 1º, no 7º, no 10º e no 30º dia, a quem paga, uma vez por fatura, dia e pessoa; a falha tenta de novo; pagou, nada mais', async () => {
    const e = await empresa('Casa Brasa Aviso');
    const adm = await convidado(e, 'administrador', { billing_access: true });
    await convidado(e, 'administrador');
    await convidado(e, 'gestor');
    await assinada(e);
    const quemPaga = [e.email, adm].sort();

    // Em dia (16/11), e no próprio vencimento (22/11): nenhum aviso.
    let antes = carteiro.enviados.length;
    await noDia(e, '2026-11-17');
    expect(await noDia(e, '2026-11-22')).toEqual([]);
    expect(carteiro.enviados.length).toBe(antes);

    // 1º dia (23/11): o aviso a quem paga, com a marca, o valor e o link de Plano e cobrança.
    antes = carteiro.enviados.length;
    expect((await noDia(e, '2026-11-23')).map((r) => [r.aviso, r.enviados, r.resultado])).toEqual([[1, 2, 'avisada']]);
    expect(paraQuem(antes)).toEqual(quemPaga);
    const primeiro = carteiro.enviados[antes]!;
    expect(primeiro.subject).toMatch(/^Liame: a mensalidade de .+ venceu em 22\/11$/);
    expect(primeiro.text).toContain('(R$ 249,00), que venceu em 22/11.');
    expect(primeiro.text).toContain(`/cobranca?marca=${e.brandId}`);
    // A rotina de novo no mesmo dia, e no 6º: nada em dobro.
    antes = carteiro.enviados.length;
    await noDia(e, '2026-11-23');
    await noDia(e, '2026-11-28');
    expect(carteiro.enviados.length).toBe(antes);

    // 7º dia (29/11), com o envio ao Administrador falhando: o Dono recebe; a falha fica gravada, sem o endereço, e tenta
    // de novo na volta seguinte.
    carteiro.falhar.add(adm);
    antes = carteiro.enviados.length;
    expect((await noDia(e, '2026-11-29')).map((r) => [r.aviso, r.enviados, r.falhas])).toEqual([[7, 1, 1]]);
    expect(paraQuem(antes)).toEqual([e.email]);
    expect((await entregas(e)).filter((x) => x.day === 7)).toEqual(
      expect.arrayContaining([{ day: 7, status: 'enviado', attempts: 1, error: null }, { day: 7, status: 'falhou', attempts: 1, error: 'SesRecusou' }]),
    );
    carteiro.falhar.delete(adm);
    antes = carteiro.enviados.length;
    await noDia(e, '2026-11-29');
    expect(paraQuem(antes)).toEqual([adm]);
    expect((await entregas(e)).filter((x) => x.day === 7).map((x) => [x.status, x.attempts]).sort()).toEqual([
      ['enviado', 1],
      ['enviado', 2],
    ]);

    // 10º dia (02/12): as ações param, e o aviso diz isso.
    antes = carteiro.enviados.length;
    await noDia(e, '2026-12-02');
    expect(carteiro.enviados.slice(antes).map((m) => m.subject)).toEqual([expect.stringContaining('estão parados'), expect.stringContaining('estão parados')]);

    // A entrega reservada por uma volta que caiu no meio (há uma hora, sem enviar) volta a ser tentada.
    const [fatura] = await ownerQuery<{ id: string; subscription_id: string }>(
      `select id, subscription_id from liame.billing_invoice where brand_id = $1 and status = 'aberta' order by due_date limit 1`,
      [e.brandId],
    );
    await ownerQuery(
      `insert into liame.billing_notice (id, tenant_id, subscription_id, invoice_id, day, user_id, status, attempts, claimed_at)
       values (gen_random_uuid(), $1, $2, $3, 30, $4, 'enviando', 1, $5::timestamptz - interval '1 hour')`,
      [e.tenantId, fatura!.subscription_id, fatura!.id, e.userId, meioDia('2026-12-22').toISOString()],
    );
    // 30º dia (22/12): a conta é suspensa; o Dono (pela entrega retomada) e o Administrador recebem.
    antes = carteiro.enviados.length;
    await noDia(e, '2026-12-22');
    expect(paraQuem(antes)).toEqual(quemPaga);
    expect(carteiro.enviados.slice(antes)[0]!.subject).toMatch(/está suspensa$/);
    expect((await entregas(e)).filter((x) => x.day === 30).map((x) => [x.status, x.attempts]).sort()).toEqual([
      ['enviado', 1],
      ['enviado', 2],
    ]);

    // Pagou as duas em aberto: em dia, e nenhum aviso mais.
    for (const f of await ownerQuery<{ id: string }>(`select id from liame.billing_invoice where brand_id = $1 and status = 'aberta' order by due_date`, [e.brandId])) {
      await withSystem(database.db, (tx) => pagarFatura(tx, { faturaId: f.id, pagoEm: meioDia('2026-12-23'), forma: 'pix', agora: meioDia('2026-12-23') }));
    }
    antes = carteiro.enviados.length;
    expect(await noDia(e, '2026-12-23')).toEqual([]);
    expect(carteiro.enviados.length).toBe(antes);
  }, 180_000);

  it('a função desligada: nenhum aviso sai; e as restrições da tabela (V119)', async () => {
    const e = await empresa('Casa Brasa Aviso Desligada');
    await assinada(e);
    await noDia(e, '2026-11-17');
    await ownerQuery(`delete from liame.feature_flag_rule where flag_key = 'cobranca' and scope_id = $1`, [e.tenantId]);
    api.app.get(FlagService).invalidate();
    // A rotina das assinaturas também para com a função desligada: a situação vai à mão para o 1º dia.
    await ownerQuery(`update liame.subscription set status = 'em_atraso' where tenant_id = $1`, [e.tenantId]);
    const antes = carteiro.enviados.length;
    expect((await avisos.executarLote(100, { tenantIds: [e.tenantId] }, meioDia('2026-11-23'))).map((r) => r.resultado)).toEqual(['desligada']);
    expect(carteiro.enviados.length).toBe(antes);

    const [s] = await ownerQuery<{ id: string }>(`select id from liame.subscription where tenant_id = $1`, [e.tenantId]);
    const [f] = await ownerQuery<{ id: string }>(`select id from liame.billing_invoice where brand_id = $1 and status = 'aberta' order by due_date limit 1`, [e.brandId]);
    const inserir = (o: { day?: number; status?: string; attempts?: number; sent?: boolean }) =>
      ownerQuery(
        `insert into liame.billing_notice (id, tenant_id, subscription_id, invoice_id, day, user_id, status, attempts, claimed_at, sent_at)
         values (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, now(), case when $8::boolean then now() end)`,
        [e.tenantId, s!.id, f!.id, o.day ?? 1, e.userId, o.status ?? 'enviado', o.attempts ?? 1, o.sent ?? true],
      );
    await inserir({});
    await expect(inserir({})).rejects.toMatchObject({ code: '23505', constraint: 'billing_notice_uma_vez' });
    await expect(inserir({ day: 7, attempts: 0 })).rejects.toMatchObject({ code: '23514', constraint: 'billing_notice_attempts_check' });
    await expect(inserir({ day: 7, sent: false })).rejects.toMatchObject({ code: '23514', constraint: 'billing_notice_enviado' });
    await expect(inserir({ day: 7, status: 'falhou' })).rejects.toMatchObject({ code: '23514', constraint: 'billing_notice_enviado' });
    await expect(inserir({ day: 2 })).rejects.toMatchObject({ code: '23514', constraint: 'billing_notice_day_check' });
    await expect(inserir({ day: 7, status: 'lido', sent: false })).rejects.toMatchObject({ code: '23514', constraint: 'billing_notice_status_check' });
  }, 120_000);
});
