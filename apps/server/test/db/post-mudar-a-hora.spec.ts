import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { BudgetService } from '../../src/actions/budget.service.js';
import { currentStep, totpCode } from '../../src/auth/totp.js';
import { DATABASE } from '../../src/database/database.module.js';
import { FlagService } from '../../src/flags/flag.service.js';
import { KillSwitchService } from '../../src/kill-switch/kill-switch.service.js';
import { ActionExecutor } from '../../src/worker/action-executor.js';
import { ownerQuery, resetIpRateLimits, startApi, type TestApi } from '../helpers/api.js';
import { ligarFlagDaEmpresa } from '../helpers/meta-de-mentira.js';
import { type EmpresaComCanais, empresaComCanais, fotoPronta } from '../helpers/posts-semeados.js';
import { hasDb } from './env.js';

// A6 · Z5d, parte 3: mudar a hora de um post aprovado (P19, aprovado pelo dono em 21/10/2026; D-A6-23 e D-A6-55), contra
// o Postgres, sem rede. O que se prova aqui:
//   - o post aprovado que espera a hora muda de hora com o código do app de quem pode aprovar: o pedido aprovado fica
//     cancelado (o motivo diz a hora nova), o post muda de hora e de versão, e um pedido novo nasce aprovado (com a
//     aprovação pelo código, do plano novo) e sai na hora nova; ele passa a ser o pedido do post; a auditoria guarda o
//     antes e o depois; o executor não pega o pedido antes da hora nova;
//   - o código errado deixa tudo como estava (o post, o pedido aprovado, nenhum pedido novo);
//   - as recusas: o post que ainda espera a aprovação, a hora fora da janela, a mesma hora, o pacote e a função desligada.

const FUSO = 'America/Sao_Paulo';
const DIA_MS = 86_400_000;
function diaNoFuso(n: number): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: FUSO, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(Date.now() + n * DIA_MS));
}
const horaNoFuso = (n: number, hhmm: string): string => `${diaNoFuso(n)}T${hhmm}:00-03:00`;
const ddmm = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;

describe.skipIf(!hasDb)('mudar a hora de um post aprovado (A6 · Z5d, parte 3)', () => {
  let api: TestApi;
  let executor: ActionExecutor;

  beforeAll(async () => {
    api = await startApi();
    await resetIpRateLimits();
    executor = new ActionExecutor(api.app.get(DATABASE), api.app.get(BudgetService), api.app.get(KillSwitchService), api.app.get(FlagService));
  }, 120_000);
  beforeEach(async () => {
    await resetIpRateLimits();
  });
  afterAll(async () => {
    await api?.close();
  });

  const novo = (e: EmpresaComCanais, foto: string, extra: Record<string, unknown> = {}) =>
    api.call('POST', '/v1/posts', {
      cookie: e.cookie,
      body: {
        brand_id: e.brandId,
        photo_id: foto,
        publish_at: horaNoFuso(1, '19:00'),
        channels: [
          { channel: 'facebook', text: 'Hoje tem smash duplo na Casa Brasa. Peça pelo link: liame.link/abc' },
          { channel: 'instagram', text: 'Hoje tem smash duplo. Peça pelo link da bio.' },
        ],
        ...extra,
      },
    });
  /** O código do app de agora (o passo já usado e o limite de tentativas zerados, como nos outros testes de aprovação). */
  const codigo = async (e: EmpresaComCanais) => {
    await ownerQuery(`update liame.app_user set totp_last_step = null where id = $1`, [e.userId]);
    await ownerQuery(`delete from liame.rate_limit where key = $1`, [`segundo-fator:${e.userId}`]);
    return totpCode(e.secret, currentStep());
  };
  const aprovar = async (e: EmpresaComCanais, pedido: { id: string; plan_hash: string }) =>
    api.call('POST', `/v1/actions/${pedido.id}/approve`, { cookie: e.cookie, body: { plan_hash: pedido.plan_hash, code: await codigo(e) } });
  const pedidoDe = async (id: string) =>
    (
      await ownerQuery<{ tool: string; status: string; status_reason: string | null; next_attempt_at: Date | null; plan_hash: string; requested_by: string }>(
        `select tool, status, status_reason, next_attempt_at, plan_hash, requested_by from liame.action_request where id = $1`,
        [id],
      )
    )[0]!;
  const postDe = async (id: string) =>
    (await ownerQuery<{ publish_at: Date; version: number; action_id: string }>(`select publish_at, version, action_id from liame.social_post where id = $1`, [id]))[0]!;
  const mudar = async (e: EmpresaComCanais, post: string, publishAt: string, code?: string) =>
    api.call('POST', `/v1/posts/${post}/reschedule`, { cookie: e.cookie, body: { publish_at: publishAt, code: code ?? (await codigo(e)) } });

  /** O post nos dois canais, aprovado com o código do app: espera a hora (amanhã, 19h). */
  async function agendado(nome: string): Promise<{ e: EmpresaComCanais; post: string; pedido: string }> {
    const e = await empresaComCanais(api, nome);
    const foto = await fotoPronta(e);
    const r = await novo(e, foto.id);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const pedido = r.body.action_id as string;
    const ok = await aprovar(e, { id: pedido, plan_hash: (await pedidoDe(pedido)).plan_hash });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    return { e, post: r.body.id as string, pedido };
  }

  it('o post aprovado muda de hora com o código: o pedido antigo cancelado, o novo aprovado e na hora nova', async () => {
    const { e, post, pedido } = await agendado('Casa Brasa Muda A Hora');
    const nova = horaNoFuso(2, '20:30');
    const r = await mudar(e, post, nova);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ status: 'agendado', publish_at: new Date(nova).toISOString() });
    const novoPedido = r.body.action_id as string;
    expect(novoPedido).not.toBe(pedido);
    // O pedido antigo: cancelado, com a hora nova no motivo.
    expect(await pedidoDe(pedido)).toMatchObject({ status: 'cancelada', status_reason: `hora mudada para ${ddmm(diaNoFuso(2))}, 20:30` });
    // O novo: o mesmo post, aprovado pelo código de quem mudou (a aprovação é do plano novo), saindo na hora nova.
    const p = await pedidoDe(novoPedido);
    expect(p).toMatchObject({ tool: 'post_publicar', status: 'aprovada', requested_by: e.userId });
    expect(p.next_attempt_at?.toISOString()).toBe(new Date(nova).toISOString());
    const aprovacoes = await ownerQuery<{ plan_hash: string; approved_by: string; method: string; sufficient: boolean }>(
      `select plan_hash, approved_by, method, sufficient from liame.approval where action_request_id = $1`,
      [novoPedido],
    );
    expect(aprovacoes).toEqual([{ plan_hash: p.plan_hash, approved_by: e.userId, method: 'totp', sufficient: true }]);
    // O post: a hora nova, a versão nova, o pedido novo.
    expect(await postDe(post)).toMatchObject({ version: 2, action_id: novoPedido });
    const [ev] = await ownerQuery<{ before: Record<string, unknown>; after: Record<string, unknown> }>(
      `select before, after from liame.audit_event where tenant_id = $1 and action = 'posts.mudar_a_hora'`,
      [e.tenantId],
    );
    expect(ev).toMatchObject({ before: { publish_at: new Date(horaNoFuso(1, '19:00')).toISOString(), action_id: pedido }, after: { publish_at: new Date(nova).toISOString(), action_id: novoPedido, aprovado: true } });
    // O executor não pega o pedido antes da hora nova.
    expect(await executor.executeBatch(20, { tenantIds: [e.tenantId] })).toBe(0);
    // Mudar de novo vale (o pedido novo também é aprovado e espera a hora).
    const outra = await mudar(e, post, horaNoFuso(2, '12:00'));
    expect(outra.status, JSON.stringify(outra.body)).toBe(200);
    expect(await postDe(post)).toMatchObject({ version: 3, action_id: outra.body.action_id });
  });

  it('o código errado deixa tudo como estava', async () => {
    const { e, post, pedido } = await agendado('Casa Brasa Codigo Errado');
    const antes = await postDe(post);
    await ownerQuery(`delete from liame.rate_limit where key = $1`, [`segundo-fator:${e.userId}`]);
    const r = await mudar(e, post, horaNoFuso(2, '20:30'), '000000');
    expect(r).toMatchObject({ status: 401, body: { code: 'codigo-invalido' } });
    expect(await postDe(post)).toEqual(antes);
    expect((await pedidoDe(pedido)).status).toBe('aprovada');
    expect(await ownerQuery(`select 1 from liame.action_request where resource_id = $1`, [`post:${post}`])).toHaveLength(1);
  });

  it('as recusas: o post que espera a aprovação, a hora fora da janela, a mesma hora, o pacote e a função desligada', async () => {
    const e = await empresaComCanais(api, 'Casa Brasa Recusas Da Hora');
    const foto = await fotoPronta(e);
    const esperando = await novo(e, foto.id);
    expect(await mudar(e, esperando.body.id, horaNoFuso(2, '20:30'))).toMatchObject({ status: 409, body: { code: 'post-nao-agendado' } });

    const ok = await aprovar(e, { id: esperando.body.action_id, plan_hash: (await pedidoDe(esperando.body.action_id)).plan_hash });
    expect(ok.status).toBe(200);
    expect(await mudar(e, esperando.body.id, horaNoFuso(2, '23:30'))).toMatchObject({ status: 422, body: { code: 'hora-fora-da-janela' } });
    expect(await mudar(e, esperando.body.id, horaNoFuso(1, '19:00'))).toMatchObject({ status: 422, body: { code: 'mesma-hora' } });
    expect(await mudar(e, esperando.body.id, horaNoFuso(-1, '19:00'))).toMatchObject({ status: 422, body: { code: 'hora-no-passado' } });
    expect((await pedidoDe(esperando.body.action_id)).status).toBe('aprovada');

    const pacote = await novo(e, foto.id, { channels: [{ channel: 'tiktok', text: 'Smash duplo 🍔' }] });
    expect(pacote.status, JSON.stringify(pacote.body)).toBe(201);
    expect(await mudar(e, pacote.body.id, horaNoFuso(2, '20:30'))).toMatchObject({ status: 409, body: { code: 'e-pacote' } });

    await ligarFlagDaEmpresa(api, 'social_write', e.tenantId, false);
    expect(await mudar(e, esperando.body.id, horaNoFuso(2, '20:30'))).toMatchObject({ status: 409, body: { code: 'funcao-desligada' } });
  });
});
