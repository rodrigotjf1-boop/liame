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

// A6 · Z5b, parte 1: o post da marca no trilho, sem publicar em rede nenhuma (a publicação é a parte seguinte). O que
// se prova aqui:
//   - criar o post grava o post, os canais e o pedido em Aprovações (a ferramenta `post_publicar`, recurso `post:<id>`,
//     pela conta do primeiro canal), com a política em Aprovação (v9) e o texto dos canais no plano (as palavras
//     proibidas valem para ele);
//   - as recusas: a função desligada, a hora (no passado, longe demais, fora das 8h às 22h), a foto de outra marca, o
//     canal sem conta ligada, o canal repetido e o texto longo demais para o Instagram;
//   - o recorte do Instagram só quando a foto não cabe nele (no centro, sem a posição);
//   - aprovado com o código do app, o pedido espera a hora marcada (A6-8, D-A6-8): o executor não o pega antes dela;
//   - a Agenda diz a situação de cada post (esperando, agendado, cancelado, recusado, não saiu) e não mostra o de outra
//     empresa; as restrições das tabelas (V119).

const FUSO = 'America/Sao_Paulo';
const DIA_MS = 86_400_000;

/** O dia de hoje mais `n`, no fuso da empresa (`AAAA-MM-DD`). */
function diaNoFuso(n: number): string {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: FUSO, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(Date.now() + n * DIA_MS));
  return p;
}
/** A hora `HH:MM` do dia de hoje mais `n`, em São Paulo (UTC-3, sem horário de verão). */
const horaNoFuso = (n: number, hhmm: string): string => `${diaNoFuso(n)}T${hhmm}:00-03:00`;

describe.skipIf(!hasDb)('o post da marca no trilho (A6 · Z5b, parte 1)', () => {
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
  /** O código do app de agora (o passo usado ao ligar o segundo fator e o limite de tentativas são zerados, como nos outros testes de aprovação). */
  const aprovar = async (e: EmpresaComCanais, pedido: { id: string; plan_hash: string }) => {
    await ownerQuery(`update liame.app_user set totp_last_step = null where id = $1`, [e.userId]);
    await ownerQuery(`delete from liame.rate_limit where key = $1`, [`segundo-fator:${e.userId}`]);
    return api.call('POST', `/v1/actions/${pedido.id}/approve`, { cookie: e.cookie, body: { plan_hash: pedido.plan_hash, code: totpCode(e.secret, currentStep()) } });
  };
  const pedidoDe = async (id: string) =>
    (
      await ownerQuery<{ tool: string; provider: string; account_id: string; resource_id: string; status: string; mode: string; next_attempt_at: Date | null; plan_hash: string; action: string }>(
        `select tool, provider, account_id, resource_id, status, mode, next_attempt_at, plan_hash, action from liame.action_request where id = $1`,
        [id],
      )
    )[0]!;
  const agenda = async (e: EmpresaComCanais) =>
    api.call('GET', `/v1/posts?brand_id=${e.brandId}&from=${diaNoFuso(-1)}&to=${diaNoFuso(7)}`, { cookie: e.cookie });

  it('com a função desligada, a Agenda vem vazia e o novo post responde 409, antes de qualquer conferência', async () => {
    const e = await empresaComCanais(api, 'Casa Brasa Posts Desligados', { ligada: false });
    const foto = await fotoPronta(e);
    expect((await agenda(e)).body).toEqual({ enabled: false, timezone: FUSO, channels: [], items: [] });
    const r = await novo(e, foto.id, { publish_at: horaNoFuso(-3, '19:00') });
    expect([r.status, r.body.code]).toEqual([409, 'funcao-desligada']);
    expect(await ownerQuery(`select 1 from liame.social_post where tenant_id = $1`, [e.tenantId])).toHaveLength(0);
  });

  it('o novo post grava os canais e faz o pedido em Aprovações pela conta do Instagram; aprovado, espera a hora marcada', async () => {
    const e = await empresaComCanais(api, 'Casa Brasa Posts');
    const foto = await fotoPronta(e);
    const r = await novo(e, foto.id);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body).toMatchObject({
      brand_id: e.brandId,
      photo_id: foto.id,
      // A foto deitada de 3:2 cabe no Instagram: sem recorte.
      crop_pos: null,
      publish_at: new Date(horaNoFuso(1, '19:00')).toISOString(),
      status: 'esperando_aprovacao',
    });
    // O Instagram primeiro, como o Liame publica.
    expect(r.body.channels.map((c: { channel: string; account_id: string; account_name: string; status: string }) => [c.channel, c.account_id, c.account_name, c.status])).toEqual([
      ['instagram', e.instagram!.id, '@casabrasa', 'aguardando'],
      ['facebook', e.pagina!.id, 'Casa Brasa', 'aguardando'],
    ]);
    const pedido = await pedidoDe(r.body.action_id);
    expect(pedido).toMatchObject({ tool: 'post_publicar', provider: 'instagram', account_id: e.instagram!.id, resource_id: `post:${r.body.id}`, status: 'aguardando_aprovacao', mode: 'APPROVAL', action: 'post.publicar' });
    // O pedido pela API: a política da distribuição na versão 9 e o estado do post no plano.
    const doPedido = await api.call('GET', `/v1/actions/${r.body.action_id}`, { cookie: e.cookie });
    expect(doPedido.body.policy).toMatchObject({ allowed: true, mode: 'APPROVAL' });
    expect(doPedido.body.policy.versions[0]).toBe('plataforma@9');
    const [guardado] = await ownerQuery<{ before_state: Record<string, unknown> }>(`select before_state from liame.action_request where id = $1`, [r.body.action_id]);
    expect(guardado!.before_state).toMatchObject({ post: r.body.id, foto: { id: foto.id, sha256: foto.sha256 }, recorte: null, hora_local: '19:00' });

    // Aprovado com o código do app: a hora da execução é a marcada.
    const aprovado = await aprovar(e, { id: r.body.action_id, plan_hash: pedido.plan_hash });
    expect(aprovado.status, JSON.stringify(aprovado.body)).toBe(200);
    const depois = await pedidoDe(r.body.action_id);
    expect(depois.status).toBe('aprovada');
    expect(depois.next_attempt_at?.toISOString()).toBe(new Date(horaNoFuso(1, '19:00')).toISOString());
    expect((await agenda(e)).body.items.map((p: { id: string; status: string }) => [p.id, p.status])).toEqual([[r.body.id, 'agendado']]);
    // O executor não pega o pedido antes da hora.
    expect(await executor.executeBatch(20, { tenantIds: [e.tenantId] })).toBe(0);
    expect((await pedidoDe(r.body.action_id)).status).toBe('aprovada');

    // Se a vez do pedido chegar antes da hora marcada (um adiamento, uma volta da fila), o executor o devolve para a hora
    // marcada, sem tentar nada (parte 2: a hora da ferramenta é conferida a cada execução). A publicação na hora está em
    // `post-nas-redes.spec.ts`.
    await ownerQuery(`update liame.action_request set next_attempt_at = now() - interval '1 second' where id = $1`, [r.body.action_id]);
    expect(await executor.executeBatch(20, { tenantIds: [e.tenantId] })).toBe(1);
    const devolvido = await pedidoDe(r.body.action_id);
    expect(devolvido.status).toBe('aprovada');
    expect(devolvido.next_attempt_at?.toISOString()).toBe(new Date(horaNoFuso(1, '19:00')).toISOString());
    const ultimo = (await api.call('GET', `/v1/posts/${r.body.id}`, { cookie: e.cookie })).body;
    expect(ultimo.status).toBe('agendado');
    expect(ultimo.channels.every((c: { status: string }) => c.status === 'aguardando')).toBe(true);
  });

  it('as recusas do novo post: a hora, a foto, os canais e o texto', async () => {
    const e = await empresaComCanais(api, 'Casa Brasa Recusas', { pagina: false });
    const foto = await fotoPronta(e);
    const outra = await empresaComCanais(api, 'Outra Casa');
    const daOutra = await fotoPronta(outra);
    const so = (texto: string) => ({ channels: [{ channel: 'instagram', text: texto }] });
    const casos: Array<[Record<string, unknown>, string]> = [
      [{ ...so('ok'), publish_at: horaNoFuso(-1, '19:00') }, 'hora-no-passado'],
      [{ ...so('ok'), publish_at: horaNoFuso(61, '19:00') }, 'hora-longe-demais'],
      [{ ...so('ok'), publish_at: horaNoFuso(1, '22:01') }, 'hora-fora-da-janela'],
      [{ ...so('ok'), publish_at: horaNoFuso(1, '07:59') }, 'hora-fora-da-janela'],
      [{ ...so('ok'), photo_id: daOutra.id }, 'foto-fora-da-marca'],
      [{}, 'canal-nao-conectado'],
      [{ channels: [{ channel: 'instagram', text: 'um' }, { channel: 'instagram', text: 'dois' }] }, 'canal-repetido'],
      [so('a'.repeat(2201)), 'texto-longo-demais'],
    ];
    for (const [extra, codigo] of casos) {
      const r = await novo(e, foto.id, extra);
      expect([r.status, r.body.code], JSON.stringify(extra).slice(0, 80)).toEqual([422, codigo]);
    }
    // As pontas da janela valem: 8h e 22h.
    for (const hora of ['08:00', '22:00']) {
      const r = await novo(e, foto.id, { ...so(`às ${hora}`), publish_at: horaNoFuso(2, hora) });
      expect(r.status, JSON.stringify(r.body)).toBe(201);
    }
    expect(await ownerQuery(`select 1 from liame.social_post where tenant_id = $1`, [e.tenantId])).toHaveLength(2);
    // A conta ligada que a plataforma recusou (a leitura gravou `desconectada`) não serve para agir: conecte de novo.
    await ownerQuery(`update liame.connected_account set status = 'desconectada', status_reason = 'token recusado' where id = $1`, [e.instagram!.id]);
    const recusada = await novo(e, foto.id, { ...so('ok'), publish_at: horaNoFuso(3, '12:00') });
    expect([recusada.status, recusada.body.code]).toEqual([422, 'canal-nao-conectado']);
  });

  it('o recorte do Instagram só na foto que não cabe nele: no centro, sem a posição; com ela, onde a pessoa pôs', async () => {
    const e = await empresaComCanais(api, 'Casa Brasa Recorte');
    const alta = await fotoPronta(e, { largura: 1000, altura: 2000 });
    const semPosicao = await novo(e, alta.id);
    expect([semPosicao.status, semPosicao.body.crop_pos]).toEqual([201, 50]);
    const comPosicao = await novo(e, alta.id, { crop_pos: 20, publish_at: horaNoFuso(1, '20:00') });
    expect([comPosicao.status, comPosicao.body.crop_pos]).toEqual([201, 20]);
    // Sem o Instagram, a foto vai inteira: a posição não vale.
    const soPagina = await novo(e, alta.id, { crop_pos: 20, publish_at: horaNoFuso(1, '21:00'), channels: [{ channel: 'facebook', text: 'Só na Página.' }] });
    expect([soPagina.status, soPagina.body.crop_pos]).toEqual([201, null]);
    // Só a Página: o pedido é pela conta dela.
    expect((await pedidoDe(soPagina.body.action_id)).provider).toBe('facebook_page');
  });

  it('a Agenda: cancelado, recusado, o período e a outra empresa', async () => {
    const e = await empresaComCanais(api, 'Casa Brasa Agenda');
    const foto = await fotoPronta(e);
    const cancelar = (await novo(e, foto.id)).body;
    const recusar = (await novo(e, foto.id, { publish_at: horaNoFuso(2, '12:00') })).body;
    expect((await api.call('POST', `/v1/actions/${cancelar.action_id}/cancel`, { cookie: e.cookie })).status).toBe(200);
    const planoRecusar = await pedidoDe(recusar.action_id);
    expect((await api.call('POST', `/v1/actions/${recusar.action_id}/reject`, { cookie: e.cookie, body: { plan_hash: planoRecusar.plan_hash, reason: 'Não é a foto certa.' } })).status).toBe(200);
    const lista = (await agenda(e)).body;
    expect(lista.enabled).toBe(true);
    // O fuso da empresa e as contas conectadas de cada canal, na ordem em que o Liame publica (para o novo post e a
    // tela dizer o que falta conectar).
    expect(lista.timezone).toBe(FUSO);
    expect(lista.channels).toEqual([
      { channel: 'instagram', accounts: [{ id: e.instagram!.id, name: '@casabrasa' }] },
      { channel: 'facebook', accounts: [{ id: e.pagina!.id, name: 'Casa Brasa' }] },
    ]);
    // A conta recusada pela plataforma não vale para agir: sai da lista (o canal fica sem conta).
    await ownerQuery(`update liame.connected_account set status = 'desconectada' where id = $1`, [e.pagina!.id]);
    expect((await agenda(e)).body.channels).toEqual([
      { channel: 'instagram', accounts: [{ id: e.instagram!.id, name: '@casabrasa' }] },
      { channel: 'facebook', accounts: [] },
    ]);
    expect(lista.items.map((p: { id: string; status: string }) => [p.id, p.status])).toEqual([
      [cancelar.id, 'cancelado'],
      [recusar.id, 'recusado'],
    ]);
    // Fora do período, nada; período longo demais, 422.
    expect((await api.call('GET', `/v1/posts?brand_id=${e.brandId}&from=${diaNoFuso(5)}&to=${diaNoFuso(7)}`, { cookie: e.cookie })).body.items).toEqual([]);
    expect((await api.call('GET', `/v1/posts?brand_id=${e.brandId}&from=${diaNoFuso(0)}&to=${diaNoFuso(70)}`, { cookie: e.cookie })).body.code).toBe('periodo-invalido');
    // A outra empresa não vê o post nem a marca.
    const outra = await empresaComCanais(api, 'Outra Casa Agenda');
    expect((await api.call('GET', `/v1/posts/${cancelar.id}`, { cookie: outra.cookie })).status).toBe(404);
    expect((await api.call('GET', `/v1/posts?brand_id=${e.brandId}&from=${diaNoFuso(0)}&to=${diaNoFuso(3)}`, { cookie: outra.cookie })).status).toBe(404);
    // Desligada depois, a Agenda vem vazia (os posts ficam guardados).
    await ligarFlagDaEmpresa(api, 'social_write', e.tenantId, false);
    expect((await agenda(e)).body).toEqual({ enabled: false, timezone: FUSO, channels: [], items: [] });
  });

  it('as restrições das tabelas (V119): o canal, a situação, o recorte, o texto e o resumo da foto', async () => {
    const e = await empresaComCanais(api, 'Casa Brasa Restrições');
    const foto = await fotoPronta(e);
    const post = (await novo(e, foto.id)).body;
    const erro = async (q: string, p: unknown[]) => {
      try {
        await ownerQuery(q, p);
        return null;
      } catch (err) {
        const c = err as { code?: string; constraint?: string };
        return `${c.code}:${c.constraint}`;
      }
    };
    expect(await erro(`update liame.social_post set crop_pos = 101 where id = $1`, [post.id])).toBe('23514:social_post_crop_pos_check');
    expect(await erro(`update liame.social_post set photo_sha256 = 'abc' where id = $1`, [post.id])).toBe('23514:social_post_photo_sha256_check');
    expect(await erro(`update liame.social_post set version = 0 where id = $1`, [post.id])).toBe('23514:social_post_version_check');
    expect(await erro(`update liame.social_post_channel set channel = 'tiktok' where post_id = $1`, [post.id])).toBe('23514:social_post_channel_channel_check');
    expect(await erro(`update liame.social_post_channel set status = 'outra' where post_id = $1`, [post.id])).toBe('23514:social_post_channel_status_check');
    expect(await erro(`update liame.social_post_channel set body = '' where post_id = $1`, [post.id])).toBe('23514:social_post_channel_body_check');
    expect(await erro(`update liame.social_post_channel set channel = 'facebook' where post_id = $1 and channel = 'instagram'`, [post.id])).toBe('23505:social_post_channel_post_id_channel_key');
    // O que vale passa.
    expect(await erro(`update liame.social_post set crop_pos = 100, version = 2 where id = $1`, [post.id])).toBeNull();
  });
});
