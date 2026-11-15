import { createDatabase, type Database, withSystem } from '@liame/database';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { criarAssinatura, pagarFatura } from '../../src/cobranca/assinatura.js';
import { APP_CONFIG, type AppConfig } from '../../src/config.js';
import { FlagService } from '../../src/flags/flag.service.js';
import { Mailer, type MailMessage } from '../../src/mail/mailer.js';
import { AssinaturasLoop } from '../../src/worker/assinaturas-loop.js';
import { AvisosDoApagamentoService } from '../../src/worker/avisos-do-apagamento.service.js';
import { enableMfa, ownerQuery, resetIpRateLimits, signupAndLogin, startApi, type TestApi } from '../helpers/api.js';
import { ligarFlagDaEmpresa } from '../helpers/meta-de-mentira.js';
import { APP_URL, hasDb } from './env.js';

// A7 · W3, parte 4b (migration 0161; D-A7-106 e D-A7-107; Termos 11.2): o aviso do apagamento por e-mail, com o relógio
// do teste na rotina das assinaturas e na dos avisos. A assinatura cancelada (o dia gravado no fim) e a que segue em atraso
// (o 60º dia): 7 dias antes e na véspera, a quem paga, uma vez por assinatura, dia, aviso e pessoa; o que sai pela regra do
// dia (só a marca, com outra viva; a empresa inteira, sendo a última); a marca que vai esperar outra não manda; a
// assinatura nova suspende; a função desligada; pagou, nada mais; e o dia do apagamento em Plano e cobrança.

const SP = 'America/Sao_Paulo';
const meioDia = (dia: string) => new Date(`${dia}T15:00:00Z`);

class CarteiroDeTeste extends Mailer {
  readonly enviados: MailMessage[] = [];
  async send(m: MailMessage): Promise<void> {
    this.enviados.push(m);
  }
}

type Empresa = { cookie: string; email: string; tenantId: string; brandId: string; userId: string };

describe.skipIf(!hasDb)('o aviso do apagamento por e-mail (A7 · W3, parte 4b)', () => {
  let api: TestApi;
  let database: Database;
  let rotina: AssinaturasLoop;
  let carteiro: CarteiroDeTeste;
  let avisos: AvisosDoApagamentoService;

  beforeAll(async () => {
    api = await startApi();
    await resetIpRateLimits();
    database = createDatabase({ connectionString: APP_URL, max: 4, applicationName: 'liame-test' });
    rotina = new AssinaturasLoop(database, api.app.get(FlagService));
    carteiro = new CarteiroDeTeste();
    avisos = new AvisosDoApagamentoService(database, api.app.get(FlagService), carteiro, api.app.get<AppConfig>(APP_CONFIG));
  }, 120_000);
  beforeEach(resetIpRateLimits);
  afterAll(async () => {
    await api?.close();
    await database?.close();
  });

  async function empresa(nome: string, { ligada = true } = {}): Promise<Empresa> {
    const s = await signupAndLogin(api, undefined, nome);
    await enableMfa(api, s.cookie);
    const tenantId = s.me.active_organization_id as string;
    const brandId = (await api.call('GET', '/v1/brands', { cookie: s.cookie })).body.items[0].id as string;
    const [u] = await ownerQuery<{ id: string }>(`select id from liame.app_user where email = $1`, [s.email]);
    await ownerQuery(`update liame.organization set timezone = $2 where id = $1`, [tenantId, SP]);
    if (ligada) await ligarFlagDaEmpresa(api, 'cobranca', tenantId, true);
    return { cookie: s.cookie, email: s.email as string, tenantId, brandId, userId: u!.id };
  }
  async function outraMarca(e: Empresa, nome: string): Promise<string> {
    const [b] = await ownerQuery<{ id: string }>(`insert into liame.brand (id, tenant_id, name) values (gen_random_uuid(), $1, $2) returning id`, [e.tenantId, nome]);
    return b!.id;
  }
  /** A assinatura paga em 22/10/2026: o período vai de 22/10 a 22/11, e a mensalidade de 22/11 nasce em 17/11. */
  async function assinada(e: Empresa, brandId = e.brandId): Promise<string> {
    const [plano] = await ownerQuery<{ id: string }>(`select id from liame.billing_plan where key = 'essencial' and offered`);
    const id = await withSystem(database.db, (tx) => criarAssinatura(tx, { tenantId: e.tenantId, brandId, planoId: plano!.id, forma: 'pix', quem: e.userId, agora: meioDia('2026-10-21') }));
    const [f] = await ownerQuery<{ id: string }>(`select id from liame.billing_invoice where subscription_id = $1 and status = 'aberta'`, [id]);
    await withSystem(database.db, (tx) => pagarFatura(tx, { faturaId: f!.id, pagoEm: meioDia('2026-10-22'), forma: 'pix', agora: meioDia('2026-10-22') }));
    return id;
  }
  const cancelarNoFim = (id: string) => ownerQuery(`update liame.subscription set cancel_at_period_end = true, cancel_requested_at = now() where id = $1`, [id]);
  async function rotinaEm(e: Empresa, dia: string) {
    await ownerQuery(`update liame.subscription set next_check_at = $2 where tenant_id = $1 and status <> 'encerrada'`, [e.tenantId, meioDia(dia).toISOString()]);
    return rotina.executarLote(20, { tenantIds: [e.tenantId] }, meioDia(dia));
  }
  const avisosEm = (e: Empresa, dia: string) => avisos.executarLote(100, { tenantIds: [e.tenantId] }, meioDia(dia));
  const resumo = (r: Awaited<ReturnType<typeof avisosEm>>) => r.map((x) => [x.brandId, x.aviso, x.enviados, x.resultado]);
  const entregas = (e: Empresa) =>
    ownerQuery<{ purge_on: string; day: number; status: string }>(`select purge_on::text, day, status from liame.subscription_purge_notice where tenant_id = $1 order by day desc, created_at`, [e.tenantId]);

  it('cancelada: 7 dias antes e na véspera, uma vez cada; só a marca, com outra viva; o dia em Plano e cobrança', async () => {
    const e = await empresa('Casa Brasa Apagamento');
    const outra = await outraMarca(e, 'Casa Brasa Segunda');
    const id = await assinada(e);
    await assinada(e, outra);
    await cancelarNoFim(id);
    await rotinaEm(e, '2026-11-22');
    const [s] = await ownerQuery<{ status: string; purge_on: string }>(`select status, purge_on::text from liame.subscription where id = $1`, [id]);
    expect(s).toEqual({ status: 'encerrada', purge_on: '2026-12-22' });

    // Oito dias antes, nada; com sete, o aviso ao Dono (o único que paga aqui), com o dia, só a marca e o link.
    let antes = carteiro.enviados.length;
    // (A outra marca, em dia, nem entra na lista.)
    expect(resumo(await avisosEm(e, '2026-12-14'))).toEqual([[e.brandId, null, 0, 'sem_aviso']]);
    expect(carteiro.enviados.length).toBe(antes);
    expect(resumo(await avisosEm(e, '2026-12-15'))).toEqual([[e.brandId, 7, 1, 'avisada']]);
    const sete = carteiro.enviados[antes]!;
    expect(sete.to).toBe(e.email);
    expect(sete.subject).toBe('Liame: os dados de Casa Brasa Apagamento serão apagados em 22/12/2026');
    expect(sete.text).toContain('As outras marcas da empresa continuam como estão');
    expect(sete.text).toContain(`/cobranca?marca=${e.brandId}`);
    // De novo no mesmo dia e no seguinte: nada em dobro.
    antes = carteiro.enviados.length;
    await avisosEm(e, '2026-12-15');
    await avisosEm(e, '2026-12-16');
    expect(carteiro.enviados.length).toBe(antes);
    // A véspera; e, no dia, nada (o apagamento roda).
    expect(resumo(await avisosEm(e, '2026-12-21'))).toEqual(expect.arrayContaining([[e.brandId, 1, 1, 'avisada']]));
    expect(carteiro.enviados[antes]!.subject).toBe('Liame: amanhã, os dados de Casa Brasa Apagamento são apagados');
    antes = carteiro.enviados.length;
    await avisosEm(e, '2026-12-22');
    expect(carteiro.enviados.length).toBe(antes);
    expect(await entregas(e)).toEqual([
      { purge_on: '2026-12-22', day: 7, status: 'enviado' },
      { purge_on: '2026-12-22', day: 1, status: 'enviado' },
    ]);

    // Plano e cobrança mostra o dia (a assinatura que terminou é a que a marca tem).
    const r = await api.call('GET', `/v1/billing?brand_id=${e.brandId}`, { cookie: e.cookie });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.subscription).toMatchObject({ status: 'encerrada', end_reason: 'cancelada', purge_on: '2026-12-22' });
    // A outra marca, viva, não tem dia.
    const viva = await api.call('GET', `/v1/billing?brand_id=${outra}`, { cookie: e.cookie });
    expect(viva.body.subscription.purge_on ?? null).toBeNull();
  });

  it('a última marca: a empresa inteira; a que vai esperar outra não manda, e a última diz o dia de verdade', async () => {
    const so = await empresa('Casa Brasa Unica');
    await cancelarNoFim(await assinada(so));
    await rotinaEm(so, '2026-11-22');
    const antes = carteiro.enviados.length;
    expect(resumo(await avisosEm(so, '2026-12-15'))).toEqual([[so.brandId, 7, 1, 'avisada']]);
    expect(carteiro.enviados[antes]!.text).toContain('a conta da empresa inteira, com todos os dados, porque Casa Brasa Unica é a última marca dela com assinatura');

    // Duas marcas canceladas, a segunda com o dia mais tarde: a primeira espera (a empresa sai no dia da segunda).
    const e = await empresa('Casa Brasa Duas');
    const segunda = await outraMarca(e, 'Casa Brasa Duas B');
    const a = await assinada(e);
    const b = await assinada(e, segunda);
    await cancelarNoFim(a);
    await cancelarNoFim(b);
    await rotinaEm(e, '2026-11-22');
    await ownerQuery(`update liame.subscription set purge_on = '2026-12-30' where id = $1`, [b]);
    const antesDuas = carteiro.enviados.length;
    expect(resumo(await avisosEm(e, '2026-12-15'))).toEqual(expect.arrayContaining([[e.brandId, 7, 0, 'esperar']]));
    expect(carteiro.enviados.length).toBe(antesDuas);
    // Sete dias antes do dia da segunda: o aviso dela, com a empresa inteira.
    expect(resumo(await avisosEm(e, '2026-12-23'))).toEqual(expect.arrayContaining([[segunda, 7, 1, 'avisada']]));
    expect(carteiro.enviados[antesDuas]!.text).toContain('a conta da empresa inteira');
    expect(carteiro.enviados[antesDuas]!.subject).toBe('Liame: os dados de Casa Brasa Duas B serão apagados em 30/12/2026');
  });

  it('em atraso: o 60º dia projetado, 7 dias antes e na véspera; pagou, nada mais', async () => {
    const e = await empresa('Casa Brasa Atraso');
    await assinada(e);
    // A mensalidade de 22/11 nasce em 17/11 e não é paga: em 22/12, a conta está suspensa; os dados sairiam em 21/01/2027.
    await rotinaEm(e, '2026-11-17');
    await rotinaEm(e, '2026-12-22');
    const [s] = await ownerQuery<{ status: string }>(`select status from liame.subscription where brand_id = $1`, [e.brandId]);
    expect(s!.status).toBe('suspensa');
    let antes = carteiro.enviados.length;
    expect(resumo(await avisosEm(e, '2027-01-13'))).toEqual([[e.brandId, null, 0, 'sem_aviso']]);
    expect(resumo(await avisosEm(e, '2027-01-14'))).toEqual([[e.brandId, 7, 1, 'avisada']]);
    const aviso = carteiro.enviados[antes]!;
    expect(aviso.subject).toBe('Liame: os dados de Casa Brasa Atraso serão apagados em 21/01/2027');
    expect(aviso.text).toContain('está em aberto há quase 60 dias');
    expect(aviso.text).toContain('pague a mensalidade em aberto');
    // Pagou: a assinatura volta, e a véspera não vai.
    const [f] = await ownerQuery<{ id: string }>(`select id from liame.billing_invoice where brand_id = $1 and status = 'aberta' order by due_date limit 1`, [e.brandId]);
    await withSystem(database.db, (tx) => pagarFatura(tx, { faturaId: f!.id, pagoEm: meioDia('2027-01-15'), forma: 'pix', agora: meioDia('2027-01-15') }));
    await rotinaEm(e, '2027-01-16');
    antes = carteiro.enviados.length;
    await avisosEm(e, '2027-01-20');
    expect(carteiro.enviados.length).toBe(antes);
  });

  it('a assinatura nova suspende; a função desligada não manda nada; a tabela recusa o aviso fora da lista', async () => {
    const e = await empresa('Casa Brasa Voltou');
    await cancelarNoFim(await assinada(e));
    await rotinaEm(e, '2026-11-22');
    // Assinou de novo (esperando o primeiro pagamento): a marca está viva, e nada sai.
    const [plano] = await ownerQuery<{ id: string }>(`select id from liame.billing_plan where key = 'essencial' and offered`);
    await withSystem(database.db, (tx) => criarAssinatura(tx, { tenantId: e.tenantId, brandId: e.brandId, planoId: plano!.id, forma: 'pix', quem: e.userId, agora: meioDia('2026-12-10') }));
    expect(await avisosEm(e, '2026-12-15')).toEqual([]);

    const desligada = await empresa('Casa Brasa Desligada');
    await cancelarNoFim(await assinada(desligada));
    await rotinaEm(desligada, '2026-11-22');
    await ligarFlagDaEmpresa(api, 'cobranca', desligada.tenantId, false);
    const antes = carteiro.enviados.length;
    expect(resumo(await avisosEm(desligada, '2026-12-15'))).toEqual([[desligada.brandId, null, 0, 'desligada']]);
    expect(carteiro.enviados.length).toBe(antes);

    const [sub] = await ownerQuery<{ id: string }>(`select id from liame.subscription where brand_id = $1 limit 1`, [desligada.brandId]);
    await expect(
      ownerQuery(
        `insert into liame.subscription_purge_notice (id, tenant_id, subscription_id, purge_on, day, user_id, status, claimed_at)
         values (gen_random_uuid(), $1, $2, '2026-12-22', 3, $3, 'enviando', now())`,
        [desligada.tenantId, sub!.id, desligada.userId],
      ),
    ).rejects.toThrow(/subscription_purge_notice_day_check/);
  });
});
