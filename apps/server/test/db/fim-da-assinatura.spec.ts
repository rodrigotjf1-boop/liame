import { createDatabase, type Database, withSystem } from '@liame/database';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { criarAssinatura, encerrar, pagarFatura, planoOferecido } from '../../src/cobranca/assinatura.js';
import { somarDias } from '../../src/cobranca/vida.js';
import { DATABASE } from '../../src/database/database.module.js';
import { FlagService } from '../../src/flags/flag.service.js';
import type { MemoryMailer } from '../../src/mail/mailer.js';
import { Mailer } from '../../src/mail/mailer.js';
import { VaultService } from '../../src/vault/vault.service.js';
import { AssinaturasLoop } from '../../src/worker/assinaturas-loop.js';
import { FimDaAssinaturaService } from '../../src/worker/fim-da-assinatura.service.js';
import { LifecyclePurgeService } from '../../src/worker/lifecycle-purge.service.js';
import { enableMfa, ownerQuery, resetIpRateLimits, signupAndLogin, startApi, type TestApi } from '../helpers/api.js';
import { ligarFlagDaEmpresa } from '../helpers/meta-de-mentira.js';
import { APP_URL, hasDb } from './env.js';

// A7 · W3, parte 4a: o fim da assinatura (Termos 11.2; D-A7-106), com o relógio (A7-3): o dia do apagamento gravado no
// fim da assinatura paga (o fim + 30 dias, ou o 60º dia de atraso); a assinatura que termina sozinha no 60º dia; e a
// rotina do apagamento, que tira só a marca quando outra segue viva, a empresa inteira (com o certificado) quando todas
// estão na mesma situação, espera o meio de pagamento e a assinatura nova que espera o primeiro pagamento, e não faz
// nada com a função desligada nem na assinatura que nunca foi paga.

type Empresa = { tenantId: string; brandId: string; email: string; cookie: string; userId: string };

const SP = 'America/Sao_Paulo';
/** Meio-dia em São Paulo num dia do calendário (15h em Greenwich). */
const meioDia = (dia: string) => new Date(`${dia}T15:00:00Z`);
const D0 = '2026-03-10';

describe.skipIf(!hasDb)('o fim da assinatura: o dia do apagamento e a rotina (A7 · W3, parte 4a)', () => {
  let api: TestApi;
  let database: Database;
  let rotina: AssinaturasLoop;
  let fim: FimDaAssinaturaService;

  beforeAll(async () => {
    api = await startApi();
    await resetIpRateLimits();
    database = createDatabase({ connectionString: APP_URL, max: 4, applicationName: 'liame-test' });
    const flags = api.app.get(FlagService);
    rotina = new AssinaturasLoop(database, flags);
    const expurgo = new LifecyclePurgeService(api.app.get(DATABASE), api.app.get(VaultService), api.app.get(Mailer));
    fim = new FimDaAssinaturaService(api.app.get(DATABASE), flags, expurgo);
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
    const marcas = await api.call('GET', '/v1/brands', { cookie: s.cookie });
    await ownerQuery(`update liame.organization set timezone = $2 where id = $1`, [tenantId, SP]);
    if (ligada) await ligarFlagDaEmpresa(api, 'cobranca', tenantId, true);
    const [u] = await ownerQuery<{ id: string }>(`select id from liame.app_user where email = $1`, [s.email]);
    return { tenantId, brandId: marcas.body.items[0].id as string, email: s.email, cookie: s.cookie, userId: u!.id };
  }

  /** Uma assinatura nova da marca, no plano Essencial, esperando o primeiro pagamento. */
  function criar(e: Empresa, brandId: string, agora: Date): Promise<string> {
    return withSystem(database.db, async (tx) => {
      const plano = await planoOferecido(tx, 'essencial');
      return criarAssinatura(tx, { tenantId: e.tenantId, brandId, planoId: plano!.id, forma: 'pix', quem: e.userId, agora });
    });
  }

  async function outraMarca(e: Empresa, nome: string): Promise<string> {
    const [b] = await ownerQuery<{ id: string }>(
      `insert into liame.brand (id, tenant_id, name) values (gen_random_uuid(), $1, $2) returning id`,
      [e.tenantId, nome],
    );
    return b!.id;
  }

  /** Assina no dia D0 e paga a primeira mensalidade: o período vai de D0 ao mesmo dia do mês seguinte. */
  async function assinadaEPaga(e: Empresa, brandId = e.brandId): Promise<string> {
    const agora = meioDia(D0);
    const id = await criar(e, brandId, agora);
    const [f] = await ownerQuery<{ id: string }>(`select id from liame.billing_invoice where subscription_id = $1 and status = 'aberta'`, [id]);
    await withSystem(database.db, (tx) => pagarFatura(tx, { faturaId: f!.id, pagoEm: agora, forma: 'pix', agora }));
    return id;
  }

  const assinatura = async (id: string) =>
    (
      await ownerQuery<{ status: string; end_reason: string | null; purge_on: string | null; period_end: string | null }>(
        `select status, end_reason, purge_on::text, period_end::text from liame.subscription where id = $1`,
        [id],
      )
    )[0]!;

  async function rotinaEm(e: Empresa, agora: Date) {
    await ownerQuery(`update liame.subscription set next_check_at = $2 where tenant_id = $1 and status <> 'encerrada'`, [e.tenantId, agora.toISOString()]);
    return rotina.executarLote(20, { tenantIds: [e.tenantId] }, agora);
  }

  const apagarEm = (e: Empresa, dia: string) => fim.executarLote(20, { tenantIds: [e.tenantId] }, meioDia(dia));
  const existeMarca = async (id: string) => (await ownerQuery(`select 1 from liame.brand where id = $1`, [id])).length === 1;
  const existeEmpresa = async (id: string) => (await ownerQuery(`select 1 from liame.organization where id = $1`, [id])).length === 1;

  it('cancelada no fim do período: o apagamento fica para 30 dias depois; sai só a marca, porque a outra segue viva', async () => {
    const e = await empresa('Cantina Cancelada no Fim');
    const id = await assinadaEPaga(e);
    // A outra marca assina e paga no mesmo dia: segue viva no dia do apagamento.
    const outra = await outraMarca(e, 'Cantina Segunda Marca');
    await assinadaEPaga(e, outra);
    await ownerQuery(`update liame.subscription set cancel_at_period_end = true, cancel_requested_at = now() where id = $1`, [id]);
    const fimDoPeriodo = (await assinatura(id)).period_end!;

    expect((await rotinaEm(e, meioDia(fimDoPeriodo))).map((r) => r.resultado)).toContain('cancelada');
    expect(await assinatura(id)).toMatchObject({ status: 'encerrada', end_reason: 'cancelada', purge_on: somarDias(fimDoPeriodo, 30) });

    // Na véspera, nada; no dia, sai só a marca da assinatura que terminou.
    expect(await apagarEm(e, somarDias(fimDoPeriodo, 29))).toEqual([]);
    expect(await apagarEm(e, somarDias(fimDoPeriodo, 30))).toEqual([{ tenantId: e.tenantId, brandId: e.brandId, resultado: 'apagada' }]);
    expect(await existeMarca(e.brandId)).toBe(false);
    expect(await existeMarca(outra)).toBe(true);
    expect(await existeEmpresa(e.tenantId)).toBe(true);
    const [aud] = await ownerQuery<{ after: Record<string, number> }>(
      `select after from liame.audit_event where tenant_id = $1 and action = 'dados.expurgar' order by chain_seq desc limit 1`,
      [e.tenantId],
    );
    expect(aud?.after).toEqual({ marca_sem_assinatura: 1 });
  });

  it('no 60º dia de atraso a assinatura termina sozinha, e a empresa de uma marca só sai inteira, com o certificado ao Dono', async () => {
    const e = await empresa('Lanchonete Sem Pagar');
    const id = await assinadaEPaga(e);
    const venc = (await assinatura(id)).period_end!;

    // A mensalidade do período seguinte nasce 5 dias antes do vencimento, e fica sem pagar.
    await rotinaEm(e, meioDia(somarDias(venc, -5)));
    // No 59º dia, ainda suspensa; no 60º, encerrada pelo atraso, e o apagamento é no mesmo dia.
    await rotinaEm(e, meioDia(somarDias(venc, 59)));
    expect(await assinatura(id)).toMatchObject({ status: 'suspensa', purge_on: null });
    expect((await rotinaEm(e, meioDia(somarDias(venc, 60)))).map((r) => r.resultado)).toEqual(['atraso']);
    expect(await assinatura(id)).toMatchObject({ status: 'encerrada', end_reason: 'atraso', purge_on: somarDias(venc, 60) });
    const abertas = await ownerQuery(`select 1 from liame.billing_invoice where subscription_id = $1 and status = 'aberta'`, [id]);
    expect(abertas).toEqual([]);

    expect(await apagarEm(e, somarDias(venc, 60))).toEqual([{ tenantId: e.tenantId, brandId: e.brandId, resultado: 'empresa_apagada' }]);
    expect(await existeEmpresa(e.tenantId)).toBe(false);
    const [cert] = await ownerQuery<{ reason: string }>(`select reason from liame.purge_certificate where purged_tenant_id = $1`, [e.tenantId]);
    expect(cert?.reason).toBe('fim da assinatura');
    expect((api.mailer as MemoryMailer).lastTo(e.email)?.subject).toBe('Liame: certificado de expurgo de Lanchonete Sem Pagar');
  });

  it('cancelar em atraso: o apagamento fica no 60º dia do atraso, não 30 dias depois do cancelamento', async () => {
    const e = await empresa('Pastelaria Cancela Atrasada');
    const id = await assinadaEPaga(e);
    const venc = (await assinatura(id)).period_end!;
    await rotinaEm(e, meioDia(somarDias(venc, -5)));
    await rotinaEm(e, meioDia(somarDias(venc, 45)));
    await withSystem(database.db, (tx) => encerrar(tx, id, 'cancelada', meioDia(somarDias(venc, 45))));
    expect(await assinatura(id)).toMatchObject({ status: 'encerrada', end_reason: 'cancelada', purge_on: somarDias(venc, 60) });
  });

  it('espera o meio de pagamento, a assinatura nova que espera o primeiro pagamento e a outra marca que ainda não chegou ao dia', async () => {
    const e = await empresa('Hamburgueria Espera');
    const id = await assinadaEPaga(e);
    await withSystem(database.db, (tx) => encerrar(tx, id, 'desistencia', meioDia(D0)));
    const dia = somarDias(D0, 30);
    expect((await assinatura(id)).purge_on).toBe(dia);

    // Uma devolução em andamento no meio de pagamento: espera.
    await ownerQuery(`update liame.billing_invoice set refund_requested_at = now() where subscription_id = $1 and status = 'paga'`, [id]);
    expect(await apagarEm(e, dia)).toEqual([]);
    await ownerQuery(`update liame.billing_invoice set refunded_at = now(), status = 'devolvida' where subscription_id = $1 and status = 'paga'`, [id]);

    // Uma assinatura nova esperando o primeiro pagamento: espera; terminou sem pagamento, o apagamento volta.
    const nova = await criar(e, e.brandId, meioDia(dia));
    expect(await apagarEm(e, dia)).toEqual([]);
    await withSystem(database.db, (tx) => encerrar(tx, nova, 'nao_paga', meioDia(dia)));
    expect((await assinatura(nova)).purge_on).toBeNull();

    // Outra marca que também terminou, mas só apaga daqui a 10 dias: a empresa espera para sair inteira.
    const outra = await outraMarca(e, 'Hamburgueria Espera 2');
    const id2 = await assinadaEPaga(e, outra);
    await withSystem(database.db, (tx) => encerrar(tx, id2, 'desistencia', meioDia(somarDias(D0, 10))));
    expect(await apagarEm(e, dia)).toEqual([{ tenantId: e.tenantId, brandId: e.brandId, resultado: 'esperar' }]);
    expect(await existeMarca(e.brandId)).toBe(true);
    const r = await apagarEm(e, somarDias(dia, 10));
    expect(r.map((x) => x.resultado)).toEqual(['empresa_apagada']);
    expect(await existeEmpresa(e.tenantId)).toBe(false);
  });

  it('com a função desligada nada sai; a assinatura que nunca foi paga não marca dia nenhum', async () => {
    const e = await empresa('Doceria Desligada');
    const id = await assinadaEPaga(e);
    await withSystem(database.db, (tx) => encerrar(tx, id, 'cancelada', meioDia(D0)));
    await ligarFlagDaEmpresa(api, 'cobranca', e.tenantId, false);
    expect(await apagarEm(e, somarDias(D0, 30))).toEqual([{ tenantId: e.tenantId, brandId: e.brandId, resultado: 'desligada' }]);
    expect(await existeMarca(e.brandId)).toBe(true);

    const s = await empresa('Doceria Nunca Pagou');
    const nunca = await criar(s, s.brandId, meioDia(D0));
    await rotinaEm(s, meioDia(somarDias(D0, 7)));
    expect(await assinatura(nunca)).toMatchObject({ status: 'encerrada', end_reason: 'nao_paga', purge_on: null });
    expect(await apagarEm(s, somarDias(D0, 60))).toEqual([]);
  });

  it('as regras da tabela: o dia do apagamento só na assinatura paga que terminou, e o motivo novo do fim (V119)', async () => {
    const e = await empresa('Bistrô Regras');
    const id = await assinadaEPaga(e);
    await expect(ownerQuery(`update liame.subscription set purge_on = current_date where id = $1`, [id])).rejects.toThrow(/subscription_apagamento/);
    await expect(ownerQuery(`update liame.subscription set status = 'encerrada', ended_at = now(), end_reason = 'outro' where id = $1`, [id])).rejects.toThrow(
      /subscription_end_reason_check/,
    );
  });
});
