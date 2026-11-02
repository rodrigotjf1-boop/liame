import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { createDatabase, type Database, runMigrations, withSystem } from '@liame/database';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { currentStep, totpCode } from '../../src/auth/totp.js';
import { criarAssinatura, pagarFatura } from '../../src/cobranca/assinatura.js';
import { FlagService } from '../../src/flags/flag.service.js';
import { AssinaturasLoop } from '../../src/worker/assinaturas-loop.js';
import { enableMfa, ownerQuery, PASSWORD, resetIpRateLimits, signupAndLogin, startApi, type TestApi, TERMOS, tokenFrom, uniqueEmail } from '../helpers/api.js';
import { ligarFlagDaEmpresa } from '../helpers/meta-de-mentira.js';
import { APP_URL, hasDb, OWNER_URL } from './env.js';

const REAL = 1_000_000; // micros
const SP = 'America/Sao_Paulo';
const meioDia = (dia: string) => new Date(`${dia}T15:00:00Z`);

type Pessoa = { cookie: string; email: string; userId: string; segredo: string };
type Atencao = { kind: string; count: number | null; since: string | null; owner_name: string | null };

// A lista de clientes da agência com o que pede atenção em cada um (A7, W7, parte 1; D-A7-52): quem cuida dos clientes
// (a dona e o administrador) vê todos, o time e os pedidos; o membro vê só os clientes em que está, sem o time e sem os
// pedidos; cada um vê o próprio acesso; e o que pede atenção é lido no cliente com o nível que a pessoa tem ali, sem a
// cobrança (a conta suspensa aparece só como suspensa, com o Dono e desde quando).
describe.skipIf(!hasDb)('os clientes da agência e o que pede atenção em cada um', () => {
  let api: TestApi;
  let flags: FlagService;
  let database: Database;
  let rotina: AssinaturasLoop;

  async function codigo(p: Pessoa): Promise<string> {
    await ownerQuery(`update liame.app_user set totp_last_step = null where id = $1`, [p.userId]);
    await ownerQuery(`delete from liame.rate_limit where key = $1`, [`segundo-fator:${p.userId}`]);
    return totpCode(p.segredo, currentStep());
  }

  /** A empresa (com a marca e o fuso), a agência com a dona, um membro no cliente e outro fora dele, e o vínculo aceito. */
  async function cenario(nome: string) {
    const s = await signupAndLogin(api, undefined, `Empresa ${nome}`);
    const tenantId = s.me.active_organization_id as string;
    const segredo = (await enableMfa(api, s.cookie)).secret;
    const marcas = await api.call('GET', '/v1/brands', { cookie: s.cookie });
    expect(marcas.status, JSON.stringify(marcas.body)).toBe(200);
    const e = { cookie: s.cookie, email: s.email, userId: s.me.user.id as string, segredo, tenantId, brandId: marcas.body.items[0].id as string };
    await ownerQuery(`update liame.organization set timezone = $2 where id = $1`, [tenantId, SP]);
    const d = await signupAndLogin(api, undefined, `Empresa da dona ${nome}`);
    const aberta = await api.call('POST', '/v1/agencies', { cookie: d.cookie, body: { name: `Agência ${nome}` } });
    const dona = { cookie: d.cookie, email: d.email, userId: d.me.user.id as string, segredo: (await enableMfa(api, d.cookie)).secret, agencyId: aberta.body.active_organization_id as string };
    const time: Record<string, Pessoa> = {};
    for (const chave of ['membro', 'outro']) {
      const email = uniqueEmail(chave);
      expect((await api.call('POST', '/v1/agency/invitations', { cookie: dona.cookie, body: { email, role: 'agencia_membro' } })).status).toBe(201);
      const r = await api.call('POST', '/v1/invitations/signup', {
        body: { token: tokenFrom(api.mailer, email), name: `Pessoa ${chave}`, password: PASSWORD, terms_version: TERMOS },
      });
      time[chave] = { cookie: r.cookie!, email, userId: r.body.user.id as string, segredo: (await enableMfa(api, r.cookie!)).secret };
    }
    await ownerQuery(
      `insert into liame.feature_flag_rule (id, flag_key, scope_type, scope_id, value, created_by) values (gen_random_uuid(), 'parceiros', 'tenant', $1, 'true'::jsonb, 'testes')`,
      [tenantId],
    );
    flags.invalidate();
    const pedido = await api.call('POST', '/v1/agency/requests', { cookie: dona.cookie, body: { owner_email: e.email, requested_role: 'gestor' } });
    const aceito = await api.call('POST', `/v1/partners/requests/${pedido.body.id}/accept`, {
      cookie: e.cookie,
      body: { max_role: 'gestor', approve_limit_micros: 50 * REAL, code: await codigo(e) },
    });
    expect(aceito.status, JSON.stringify(aceito.body)).toBe(200);
    const linkId = pedido.body.id as string;
    await nivel(dona, linkId, time.membro!, 'gestor');
    return { e, dona, time: time as Record<'membro' | 'outro', Pessoa>, linkId };
  }

  async function nivel(dona: { cookie: string }, linkId: string, p: Pessoa, role: string) {
    const r = await api.call('PUT', `/v1/agency/clients/${linkId}/team`, { cookie: dona.cookie, body: { members: [{ user_id: p.userId, role }] } });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
  }

  /** Uma conta de anúncios da marca principal do cliente, na situação pedida. */
  async function contaDeAnuncios(e: { tenantId: string; brandId: string }, status: 'ativa' | 'desconectada'): Promise<string> {
    const id = randomUUID();
    await ownerQuery(
      `insert into liame.connected_account (id, tenant_id, brand_id, provider, external_id, name, currency, timezone, status)
       values ($1, $2, $3, 'meta_ads', $4, 'Conta de anúncios', 'BRL', $5, $6)`,
      [id, e.tenantId, e.brandId, randomUUID(), SP, status],
    );
    return id;
  }

  /** Um pedido de ação esperando aprovação na marca principal do cliente. */
  async function pedidoEsperando(e: { tenantId: string; brandId: string; userId: string }, conta: string): Promise<string> {
    const id = randomUUID();
    await ownerQuery(
      `insert into liame.action_request (id, tenant_id, brand_id, tool, action, provider, account_id, resource_id, params, risk_level, budget_impact,
                                         before_state, desired_state, plan_hash, action_fingerprint, mode, policy_decision, status, requested_by, expires_at)
       values ($1, $2, $3, 'orcamento_ajustar', 'orcamento.aumentar', 'meta_ads', $4, 'campanha:1', '{}'::jsonb, 'R2', 'increase',
               '{}'::jsonb, '{}'::jsonb, $5, $5, 'APPROVAL', '{}'::jsonb, 'aguardando_aprovacao', $6, now() + interval '3 days')`,
      [id, e.tenantId, e.brandId, conta, `plano-${id}`, e.userId],
    );
    return id;
  }

  const clientes = (p: { cookie: string }) => api.call('GET', '/v1/agency/clients', { cookie: p.cookie });
  const atencao = async (p: { cookie: string }): Promise<Atencao[]> => (await clientes(p)).body.clients[0].attention;
  const tipos = (a: Atencao[]) => a.map((x) => x.kind).sort();

  beforeAll(async () => {
    await runMigrations({ connectionString: OWNER_URL, dir: resolve(process.cwd(), '../../packages/database/migrations') });
    api = await startApi();
    flags = api.app.get(FlagService);
    database = createDatabase({ connectionString: APP_URL, max: 4, applicationName: 'liame-test' });
    rotina = new AssinaturasLoop(database, flags);
  }, 120_000);
  beforeEach(resetIpRateLimits);
  afterAll(async () => {
    await api?.close();
    await database?.close();
  });

  it('a dona vê todos os clientes, o time e os pedidos; o membro vê só o cliente em que está, com o acesso dele; quem está fora não vê nada', async () => {
    const { dona, time, linkId } = await cenario('Brasa da Lista');
    const outroPedido = await api.call('POST', '/v1/agency/requests', { cookie: dona.cookie, body: { owner_email: uniqueEmail('dono'), requested_role: 'gestor' } });
    expect(outroPedido.status).toBe(201);

    const daDona = await clientes(dona);
    expect(daDona.status).toBe(200);
    expect(daDona.body.clients).toHaveLength(1);
    expect(daDona.body.clients[0]).toMatchObject({
      id: linkId,
      team: [{ user_id: time.membro.userId, name: 'Pessoa membro', role: 'gestor' }],
      my_access: null,
      attention: [{ kind: 'fora_do_time', count: null, since: null, owner_name: null }],
    });
    expect(daDona.body.requests.map((r: { id: string }) => r.id)).toEqual([outroPedido.body.id]);

    const doMembro = await clientes(time.membro);
    expect(doMembro.status, JSON.stringify(doMembro.body)).toBe(200);
    expect(doMembro.body.requests).toEqual([]);
    expect(doMembro.body.clients).toHaveLength(1);
    expect(doMembro.body.clients[0]).toMatchObject({
      id: linkId,
      team: [],
      my_access: { role: 'gestor', approve_limit_micros: 50 * REAL },
      attention: [{ kind: 'em_dia', count: null, since: null, owner_name: null }],
    });

    const doOutro = await clientes(time.outro);
    expect(doOutro.status).toBe(200);
    expect(doOutro.body).toEqual({ clients: [], requests: [] });

    // O vínculo desfeito some da lista do membro; a dona o vê como desfeito, sem o que pede atenção.
    expect((await api.call('DELETE', `/v1/agency/clients/${linkId}`, { cookie: dona.cookie })).status).toBe(204);
    expect((await clientes(time.membro)).body.clients).toEqual([]);
    const depois = (await clientes(dona)).body.clients[0];
    expect(depois.status).toBe('desfeito');
    expect(depois.attention).toBeUndefined();
  });

  it('o que pede atenção segue o nível da pessoa no cliente: quem aprova vê os pedidos, quem opera vê a conta que caiu, quem só lê não vê nenhum', async () => {
    const { e, dona, time, linkId } = await cenario('Brasa do Nível');
    const conta = await contaDeAnuncios(e, 'desconectada');
    const pedidoDeAcao = await pedidoEsperando(e, conta);

    // Gestor: aprova e opera.
    const doGestor = await atencao(time.membro);
    expect(tipos(doGestor)).toEqual(['aprovacoes', 'conta_desconectada']);
    expect(doGestor.find((a) => a.kind === 'aprovacoes')!.count).toBe(1);
    expect(doGestor.find((a) => a.kind === 'conta_desconectada')!.count).toBe(1);
    // Aprovador: só os pedidos.
    await nivel(dona, linkId, time.membro, 'aprovador');
    expect(tipos(await atencao(time.membro))).toEqual(['aprovacoes']);
    // Só leitura: nada esperando por ele.
    await nivel(dona, linkId, time.membro, 'somente_leitura');
    expect(tipos(await atencao(time.membro))).toEqual(['em_dia']);
    // O pedido decidido e a conta de volta: em dia para o gestor também.
    await nivel(dona, linkId, time.membro, 'gestor');
    await ownerQuery(`update liame.connected_account set status = 'ativa' where id = $1`, [conta]);
    await ownerQuery(`update liame.action_request set status = 'expirada' where id = $1`, [pedidoDeAcao]);
    expect(tipos(await atencao(time.membro))).toEqual(['em_dia']);
    // A dona, fora do time, não lê nada dentro do cliente.
    expect(tipos(await atencao(dona))).toEqual(['fora_do_time']);
  });

  it('a marca suspensa aparece com o Dono e desde quando, sem o valor; a empresa inteira suspensa fica só com o aviso; sem a cobrança, nada', async () => {
    const { e, time } = await cenario('Brasa Suspensa');
    await ligarFlagDaEmpresa(api, 'cobranca', e.tenantId, true);
    const nova = await api.call('POST', '/v1/brands', { cookie: e.cookie, body: { name: 'Brasa Delivery' } });
    expect(nova.status, JSON.stringify(nova.body)).toBe(201);
    await pedidoEsperando(e, await contaDeAnuncios(e, 'ativa'));
    const [plano] = await ownerQuery<{ id: string }>(`select id from liame.billing_plan where key = 'essencial' and offered`);
    await withSystem(database.db, (tx) =>
      criarAssinatura(tx, { tenantId: e.tenantId, brandId: e.brandId, planoId: plano!.id, forma: 'pix', quem: e.userId, agora: meioDia('2026-10-21') }),
    );
    const [f] = await ownerQuery<{ id: string }>(`select id from liame.billing_invoice where brand_id = $1 and status = 'aberta' order by due_date limit 1`, [e.brandId]);
    await withSystem(database.db, (tx) => pagarFatura(tx, { faturaId: f!.id, pagoEm: meioDia('2026-10-22'), forma: 'pix', agora: meioDia('2026-10-22') }));
    for (const dia of ['2026-11-17', '2026-12-22']) {
      await ownerQuery(`update liame.subscription set next_check_at = $2 where tenant_id = $1 and status <> 'encerrada'`, [e.tenantId, meioDia(dia).toISOString()]);
      await rotina.executarLote(20, { tenantIds: [e.tenantId] }, meioDia(dia));
    }
    const [s] = await ownerQuery<{ status: string }>(`select status from liame.subscription where brand_id = $1 and status <> 'encerrada'`, [e.brandId]);
    expect(s!.status).toBe('suspensa');
    const [dono] = await ownerQuery<{ name: string }>(`select name from liame.app_user where id = $1`, [e.userId]);

    // Uma marca de duas: a outra segue, e os pedidos esperando também contam.
    const lista = await clientes(time.membro);
    const umaDeDuas = lista.body.clients[0].attention as Atencao[];
    expect(tipos(umaDeDuas)).toEqual(['aprovacoes', 'marca_suspensa']);
    expect(umaDeDuas.find((a) => a.kind === 'marca_suspensa')).toEqual({ kind: 'marca_suspensa', count: 1, since: '2026-12-22', owner_name: dono!.name });
    expect(JSON.stringify(lista.body)).not.toMatch(/amount|invoice|fatura|valor/i);

    // Arquivada a outra marca, a empresa inteira fecha para o time: só o aviso da suspensão.
    expect((await api.call('POST', `/v1/brands/${nova.body.id}/archive`, { cookie: e.cookie })).status).toBe(200);
    expect(await atencao(time.membro)).toEqual([{ kind: 'suspensa', count: 1, since: '2026-12-22', owner_name: dono!.name }]);

    // Com a cobrança desligada, a suspensão não trava ninguém e não aparece.
    await ligarFlagDaEmpresa(api, 'cobranca', e.tenantId, false);
    expect(tipos(await atencao(time.membro))).toEqual(['aprovacoes']);
  });
});
