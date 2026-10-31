import { randomUUID } from 'node:crypto';
import { createDatabase, type Database, withSystem } from '@liame/database';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { criarAssinatura, pagarFatura } from '../../src/cobranca/assinatura.js';
import { FlagService } from '../../src/flags/flag.service.js';
import { AssinaturasLoop } from '../../src/worker/assinaturas-loop.js';
import { enableMfa, ownerQuery, PASSWORD, resetIpRateLimits, signupAndLogin, startApi, TERMOS, type TestApi, tokenFrom, uniqueEmail } from '../helpers/api.js';
import { ligarFlagDaEmpresa } from '../helpers/meta-de-mentira.js';
import { APP_URL, hasDb } from './env.js';

// A7 · W3, parte 3 (Termos 10.4; `plano-a7.md` D-A7-6 e D-A7-40; P26): no 30º dia de atraso, a conta da marca fica
// suspensa e só o Dono entra, para pagar ou exportar os dados. Pelo caminho inteiro: a rotina com o relógio leva a
// assinatura à suspensão; a equipe (o Gestor e o Administrador com a cobrança liberada) recebe 403 `marca-suspensa`
// nas rotas da marca, e em todas as da empresa quando todas as marcas estão suspensas; o Dono lê, exporta e muda só a
// cobrança; a outra marca da empresa segue; a função desligada não trava ninguém; e pagar devolve tudo na hora.

type Pessoa = { cookie: string; userId: string };
type Empresa = Pessoa & { tenantId: string; brandId: string };

const SP = 'America/Sao_Paulo';
const REAL = 1_000_000;
const meioDia = (dia: string) => new Date(`${dia}T15:00:00Z`);

describe.skipIf(!hasDb)('A conta suspensa no 30º dia de atraso: só o Dono entra (A7 · W3, parte 3)', () => {
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

  async function empresa(nome: string): Promise<Empresa> {
    const s = await signupAndLogin(api, undefined, nome);
    await enableMfa(api, s.cookie);
    const tenantId = s.me.active_organization_id as string;
    const marcas = await api.call('GET', '/v1/brands', { cookie: s.cookie });
    const brandId = marcas.body.items[0].id as string;
    const [u] = await ownerQuery<{ id: string }>(`select id from liame.app_user where email = $1`, [s.email]);
    await ownerQuery(`update liame.organization set timezone = $2 where id = $1`, [tenantId, SP]);
    await ligarFlagDaEmpresa(api, 'cobranca', tenantId, true);
    return { cookie: s.cookie, tenantId, brandId, userId: u!.id };
  }

  async function convidado(e: Empresa, papel: string, extra: Record<string, unknown> = {}): Promise<Pessoa> {
    const email = uniqueEmail(papel);
    const inv = await api.call('POST', '/v1/invitations', { cookie: e.cookie, body: { email, role: papel, approve_limit_micros: 100 * REAL, ...extra } });
    expect(inv.status, JSON.stringify(inv.body)).toBe(201);
    const s = await api.call('POST', '/v1/invitations/signup', { body: { token: tokenFrom(api.mailer, email), name: `Pessoa ${papel}`, password: PASSWORD, terms_version: TERMOS } });
    expect(s.status).toBe(200);
    await enableMfa(api, s.cookie!);
    return { cookie: s.cookie!, userId: s.body.user.id as string };
  }

  /** Assinada em 21/10/2026 e paga em 22/10 (vencimento no dia 22); a rotina, só nesta empresa, com o relógio do teste. */
  async function assinada(e: Empresa): Promise<void> {
    const [plano] = await ownerQuery<{ id: string }>(`select id from liame.billing_plan where key = 'essencial' and offered`);
    await withSystem(database.db, (tx) => criarAssinatura(tx, { tenantId: e.tenantId, brandId: e.brandId, planoId: plano!.id, forma: 'pix', quem: e.userId, agora: meioDia('2026-10-21') }));
    await pagar(e, meioDia('2026-10-22'));
  }

  async function rotinaEm(e: Empresa, dia: string): Promise<string> {
    const agora = meioDia(dia);
    await ownerQuery(`update liame.subscription set next_check_at = $2 where tenant_id = $1 and status <> 'encerrada'`, [e.tenantId, agora.toISOString()]);
    await rotina.executarLote(20, { tenantIds: [e.tenantId] }, agora);
    const [s] = await ownerQuery<{ status: string }>(`select status from liame.subscription where brand_id = $1 and status <> 'encerrada'`, [e.brandId]);
    return s!.status;
  }

  /** Paga a mensalidade em aberto mais antiga da marca. */
  async function pagar(e: Empresa, pagoEm: Date): Promise<void> {
    const [f] = await ownerQuery<{ id: string }>(
      `select id from liame.billing_invoice where brand_id = $1 and status = 'aberta' order by due_date, created_at limit 1`,
      [e.brandId],
    );
    await withSystem(database.db, (tx) => pagarFatura(tx, { faturaId: f!.id, pagoEm, forma: 'pix', agora: pagoEm }));
  }

  const ler = (p: Pessoa, caminho: string) => api.call('GET', caminho, { cookie: p.cookie });
  const codigo = (r: { status: number; body: { code?: string } }) => (r.status === 403 ? r.body.code : r.status);

  it('no 30º dia, a equipe não entra (nem quem tem a cobrança liberada) e o Dono só paga e exporta; pagou, tudo volta na hora', async () => {
    const e = await empresa('Casa Brasa Suspensa');
    const adm = await convidado(e, 'administrador', { billing_access: true });
    const gestor = await convidado(e, 'gestor');
    await assinada(e);
    const daMarca = `/v1/team?brand_id=${e.brandId}`;

    const [dono] = await ownerQuery<{ name: string }>(`select name from liame.app_user where id = $1`, [e.userId]);
    const quemCuida = [
      { name: dono!.name, role: 'dono' },
      { name: 'Pessoa administrador', role: 'administrador' },
    ];
    // A faixa do atraso (W5, parte 4; D-A7-15): no 1º dia, só quem paga vê, com o valor e a fatura; o Gestor, nada.
    await rotinaEm(e, '2026-11-17');
    expect(await rotinaEm(e, '2026-11-23')).toBe('em_atraso');
    const [aberta] = await ownerQuery<{ id: string }>(`select id from liame.billing_invoice where brand_id = $1 and status = 'aberta' and due_date = '2026-11-22'`, [e.brandId]);
    const atraso = (status: string, comValor: boolean) => ({
      brand_id: e.brandId,
      brand_name: expect.any(String),
      status,
      plan_name: 'Essencial',
      due_date: '2026-11-22',
      days: expect.any(Number),
      actions_stop_on: '2026-12-02',
      suspends_on: '2026-12-22',
      amount_cents: comValor ? '24900' : null,
      invoice_id: comValor ? aberta!.id : null,
    });
    expect((await ler(adm, '/v1/billing/contacts')).body).toEqual({ enabled: true, items: quemCuida, suspended: [], all_suspended: false, overdue: [atraso('em_atraso', true)] });
    expect((await ler(gestor, '/v1/billing/contacts')).body.overdue).toEqual([]);

    // No 10º dia, as ações param, mas todo mundo entra e lê (a parada é a da W3, parte 1); a equipe passa a ver a faixa,
    // sem o valor.
    expect(await rotinaEm(e, '2026-12-21')).toBe('acoes_paradas');
    expect(codigo(await ler(gestor, daMarca))).toBe(200);
    expect(codigo(await ler(adm, `/v1/billing?brand_id=${e.brandId}`))).toBe(200);
    // Quem cuida da cobrança (W5, parte 1; D-A7-41): o Dono primeiro e quem tem a cobrança liberada, nunca o Gestor; ainda
    // sem marca suspensa.
    expect((await ler(gestor, '/v1/billing/contacts')).body).toEqual({ enabled: true, items: quemCuida, suspended: [], all_suspended: false, overdue: [atraso('acoes_paradas', false)] });
    expect((await ler(e, '/v1/billing/contacts')).body.overdue).toEqual([atraso('acoes_paradas', true)]);

    // No 30º dia, suspensa: a equipe recebe 403 `marca-suspensa` na marca e, como a empresa só tem esta marca, em toda
    // rota da empresa. Ver quem sou, trocar de empresa e sair continuam (não são da empresa).
    expect(await rotinaEm(e, '2026-12-22')).toBe('suspensa');
    const negado = await ler(gestor, daMarca);
    expect(negado.status).toBe(403);
    expect(negado.body).toMatchObject({ code: 'marca-suspensa' });
    expect(negado.body.detail).toContain('só o Dono entra');
    expect(codigo(await ler(gestor, '/v1/organization'))).toBe('marca-suspensa');
    expect(codigo(await ler(gestor, '/v1/brands'))).toBe('marca-suspensa');
    expect(codigo(await ler(adm, `/v1/billing?brand_id=${e.brandId}`))).toBe('marca-suspensa');
    expect(codigo(await ler(gestor, '/v1/me'))).toBe(200);
    // A rota de quem cuida fica aberta a todos com a conta suspensa: diz quem resolve e desde quando (o 30º dia da
    // mensalidade de 22/11).
    const suspensa = { brand_id: e.brandId, brand_name: expect.any(String), since: '2026-12-22' };
    expect((await ler(gestor, '/v1/billing/contacts')).body).toEqual({ enabled: true, items: quemCuida, suspended: [suspensa], all_suspended: true, overdue: [atraso('suspensa', false)] });
    expect((await ler(adm, '/v1/billing/contacts')).body.suspended).toEqual([suspensa]);

    // O Dono lê tudo e exporta os dados; mudar alguma coisa, só na cobrança.
    expect(codigo(await ler(e, daMarca))).toBe(200);
    expect(codigo(await ler(e, '/v1/organization'))).toBe(200);
    expect(codigo(await ler(e, '/v1/export'))).toBe(200);
    const estado = await ler(e, `/v1/billing?brand_id=${e.brandId}`);
    expect(estado.status).toBe(200);
    expect(estado.body.subscription.status).toBe('suspensa');
    expect(codigo(await api.call('POST', '/v1/brands', { cookie: e.cookie, body: { name: 'Marca nova' } }))).toBe('marca-suspensa');
    expect(codigo(await api.call('POST', `/v1/brands/${e.brandId}/archive`, { cookie: e.cookie }))).toBe('marca-suspensa');
    // A cobrança passa pela guarda; quem decide é o serviço dela (manter a assinatura que não foi cancelada: 409).
    const manter = await api.call('POST', '/v1/billing/subscription/keep', { cookie: e.cookie, body: { brand_id: e.brandId } });
    expect(manter.body.code).not.toBe('marca-suspensa');
    // O freio nunca trava: o Dono aciona e retoma a parada e desliga um funcionário; o Gestor, não (nem entra).
    const parada = await api.call('POST', '/v1/kill-switches', { cookie: e.cookie, body: { level: 'tenant', reason: 'Parando para revisar' } });
    expect(parada.status, JSON.stringify(parada.body)).toBe(201);
    expect((await api.call('DELETE', `/v1/kill-switches/${parada.body.id}`, { cookie: e.cookie })).status).toBe(204);
    const desligar = await api.call('POST', '/v1/team/members/estrategista/pause', { cookie: e.cookie, body: { brand_id: e.brandId } });
    expect(desligar.body?.code, JSON.stringify(desligar.body)).not.toBe('marca-suspensa');
    expect(codigo(await api.call('POST', '/v1/kill-switches', { cookie: gestor.cookie, body: { level: 'tenant', reason: 'Parando' } }))).toBe('marca-suspensa');

    // Pagou a de novembro e a de dezembro: tudo volta na hora, sem esperar a rotina.
    await pagar(e, meioDia('2026-12-23'));
    await pagar(e, meioDia('2026-12-23'));
    expect(codigo(await ler(gestor, daMarca))).toBe(200);
    expect(codigo(await ler(gestor, '/v1/organization'))).toBe(200);
    expect(codigo(await ler(adm, `/v1/billing?brand_id=${e.brandId}`))).toBe(200);
    expect((await ler(gestor, '/v1/billing/contacts')).body).toMatchObject({ suspended: [], all_suspended: false, overdue: [] });
  }, 120_000);

  it('a outra marca da empresa segue; arquivada a outra, a empresa inteira fica suspensa; e a função desligada não trava ninguém', async () => {
    const e = await empresa('Casa Brasa Duas Marcas');
    const gestor = await convidado(e, 'gestor');
    const nova = await api.call('POST', '/v1/brands', { cookie: e.cookie, body: { name: 'Brasa Delivery' } });
    expect(nova.status, JSON.stringify(nova.body)).toBe(201);
    const outra = nova.body.id as string;
    await assinada(e);
    await rotinaEm(e, '2026-11-17');
    expect(await rotinaEm(e, '2026-12-22')).toBe('suspensa');

    // Só a marca da assinatura trava: a outra e as rotas da empresa seguem para a equipe e para o Dono.
    expect(codigo(await ler(gestor, `/v1/team?brand_id=${e.brandId}`))).toBe('marca-suspensa');
    expect(codigo(await ler(gestor, `/v1/team?brand_id=${outra}`))).toBe(200);
    expect(codigo(await ler(gestor, '/v1/organization'))).toBe(200);
    // Com a outra marca viva, a conta não está inteira suspensa (a tela da equipe segue; só a marca trava).
    expect((await ler(gestor, '/v1/billing/contacts')).body).toMatchObject({ all_suspended: false, suspended: [{ brand_id: e.brandId }] });
    // A marca no caminho e no corpo também contam: o Dono não muda a marca suspensa (nem conversa com a LIA nela).
    expect(codigo(await api.call('POST', `/v1/brands/${e.brandId}/archive`, { cookie: e.cookie }))).toBe('marca-suspensa');
    const conversa = { message_id: randomUUID(), brand_id: e.brandId, text: 'Como foram as vendas?' };
    expect(codigo(await api.call('POST', '/v1/conversations/messages', { cookie: e.cookie, body: conversa }))).toBe('marca-suspensa');
    // Assinar de novo passa pela guarda (é da cobrança); o serviço recusa, porque a marca já assina.
    const assinar = await api.call('POST', '/v1/billing/subscription', { cookie: e.cookie, body: { brand_id: e.brandId, plan: 'essencial', method: 'pix' } });
    expect(assinar.body.code).toBe('assinatura-existe');

    // Arquivada a outra marca, a empresa só tem a marca suspensa: a equipe não entra em nada da empresa.
    expect((await api.call('POST', `/v1/brands/${outra}/archive`, { cookie: e.cookie })).status).toBe(200);
    expect(codigo(await ler(gestor, '/v1/organization'))).toBe('marca-suspensa');
    expect((await ler(gestor, '/v1/billing/contacts')).body.all_suspended).toBe(true);

    // A função desligada para a empresa: a suspensão não trava ninguém (a situação gravada fica como está).
    await ligarFlagDaEmpresa(api, 'cobranca', e.tenantId, false);
    expect(codigo(await ler(gestor, `/v1/team?brand_id=${e.brandId}`))).toBe(200);
    expect(codigo(await ler(gestor, '/v1/organization'))).toBe(200);
    // E a rota de quem cuida diz que a função está desligada, sem listas.
    expect((await ler(gestor, '/v1/billing/contacts')).body).toEqual({ enabled: false, items: [], suspended: [], all_suspended: false, overdue: [] });
  }, 120_000);
});
