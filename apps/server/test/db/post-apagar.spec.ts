import type { Database } from '@liame/database';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { BudgetService } from '../../src/actions/budget.service.js';
import { type DependenciasDoPost, postNaPaginaConnector, postNoInstagramConnector } from '../../src/actions/post-publicacao.js';
import { currentStep, totpCode } from '../../src/auth/totp.js';
import { ClienteConector } from '../../src/connectors/cliente-http.js';
import { versaoRegistrada } from '../../src/connectors/tipos.js';
import { DATABASE } from '../../src/database/database.module.js';
import { FlagService } from '../../src/flags/flag.service.js';
import { ARMAZEM_DE_IMAGENS, type ArmazemNaMemoria } from '../../src/imagens/armazem.js';
import { KillSwitchService } from '../../src/kill-switch/kill-switch.service.js';
import { VaultService } from '../../src/vault/vault.service.js';
import { ActionExecutor } from '../../src/worker/action-executor.js';
import { ownerQuery, resetIpRateLimits, startApi, type TestApi } from '../helpers/api.js';
import { InstagramDeMentira, SEGREDO_DO_APP, TOKEN_DO_INSTAGRAM } from '../helpers/instagram-de-mentira.js';
import { ligarFlagDaEmpresa } from '../helpers/meta-de-mentira.js';
import { type EmpresaComCanais, empresaComCanais, fotoGuardada } from '../helpers/posts-semeados.js';
import { hasDb } from './env.js';

// A6 · Z5d, parte 6: "Apagar das redes" (P19, aprovado pelo dono em 21/10/2026; D-A6-57), contra o Postgres e a Meta de
// mentira (`helpers/instagram-de-mentira.ts`, pelas páginas oficiais lidas em 30/10/2026). O que se prova aqui:
//   - o post no ar nos dois canais sai das redes: o pedido `post_apagar` (a volta da publicação) nasce e é aprovado com o
//     código do app na mesma chamada, executa na hora (fora da janela das 8h às 22h, que é só de publicar) e apaga uma vez
//     em cada canal; a Agenda diz apagado, quando e por quem; o canal deixa a fila dos números;
//   - cada canal por conta própria: o Instagram sem a permissão de apagar continua no ar, com o porquê, e a Página sai; com
//     a permissão, apagar de novo tira só o que faltou; a rede fora do ar faz o pedido esperar, e a volta apaga o resto; o
//     post que já não está na rede não vira "apagado" (a Meta não separa "não existe" de "não alcança"); a trava da conta
//     do outro canal segura só ele;
//   - as recusas, que deixam tudo como estava: o código errado, o post que não está no ar, o pacote, o pedido direto pela
//     rota das ações, a trava de apagar (a de publicar não segura o apagar) e a função desligada.

const LEGENDA = 'Hoje tem smash duplo na Casa Brasa. Peça pelo link da bio.';
const FUSO_DO_PEDIDO = 'America/Sao_Paulo';
const DOIS_CANAIS = [
  { channel: 'instagram', text: LEGENDA },
  { channel: 'facebook', text: 'Hoje tem smash duplo na Casa Brasa. Peça pelo link: liame.link/abc' },
];
const SEM_PERMISSAO_NO_INSTAGRAM =
  'A Meta não deixou o Liame apagar neste Instagram: a autorização não tem a permissão de apagar posts. Conecte a Meta de novo em Contas conectadas e confirme a permissão de apagar, ou apague direto no Instagram. O post continua no Instagram.';

const diaEmSaoPaulo = (n: number): string =>
  new Intl.DateTimeFormat('en-CA', { timeZone: FUSO_DO_PEDIDO, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(Date.now() + n * 86_400_000));

/** Um fuso em que agora é `hora` no relógio (`Etc/GMT±N`; o sinal dos fusos `Etc` é o contrário do de costume). */
function fusoComAHora(hora: number): string {
  let diferenca = (hora - new Date().getUTCHours()) % 24;
  if (diferenca < 0) diferenca += 24;
  if (diferenca > 12) diferenca -= 24;
  return diferenca === 0 ? 'Etc/GMT' : `Etc/GMT${diferenca > 0 ? '-' : '+'}${Math.abs(diferenca)}`;
}

type Canal = { channel: string; status: string; removed_at: string | null };

describe.skipIf(!hasDb)('"Apagar das redes" (A6 · Z5d, parte 6)', () => {
  let api: TestApi;
  let executor: ActionExecutor;
  let armazem: ArmazemNaMemoria;
  const ig = new InstagramDeMentira();

  beforeAll(async () => {
    api = await startApi();
    await resetIpRateLimits();
    await ig.ligar();
    const database: Database = api.app.get(DATABASE);
    executor = new ActionExecutor(database, api.app.get(BudgetService), api.app.get(KillSwitchService), api.app.get(FlagService));
    armazem = api.app.get(ARMAZEM_DE_IMAGENS);
    ig.buscarImagem = (endereco) => {
      const m = /^memoria:\/\/imagens\/(.+)\?valido=\d+$/.exec(endereco);
      return m ? (armazem.objetos.get(m[1]!) ?? null) : null;
    };
    const vault = api.app.get(VaultService);
    const deps: DependenciasDoPost = {
      lerSegredo: (tx, id) => vault.readSecret(tx, id),
      cliente: () => new ClienteConector(database.db, { enderecos: { meta_ads: [ig.base] }, tentativas: 1, balde: { capacidade: 10_000, porSegundo: 1_000 } }),
      graphUrl: ig.base,
      appSecret: SEGREDO_DO_APP,
      versao: (capacidade) => versaoRegistrada(database.db, 'meta_ads', capacidade),
      armazem,
      esperaDoConteinerMs: 0,
      // Como o provedor da subida (`escrita-posts.provider.ts`): a trava na ferramenta do pedido (publicar ou apagar).
      trava: async (tx, alvo) => {
        const t = await api.app.get(KillSwitchService).check(tx, alvo);
        return t ? `${t.level}: ${t.reason}` : null;
      },
    };
    postNoInstagramConnector.ligar(deps);
    postNaPaginaConnector.ligar(deps);
  }, 120_000);
  beforeEach(async () => {
    await resetIpRateLimits();
    ig.normalizar();
  });
  afterAll(async () => {
    await ig.desligar();
    await api?.close();
  });

  /** A empresa com o Instagram e a Página; quem autorizou publica e modera na Página. */
  const comOsDois = async (nome: string) => {
    const e = await empresaComCanais(api, nome, { pagina: true, instagram: true, token: TOKEN_DO_INSTAGRAM });
    ig.paginas.set(e.pagina!.externo, ['CREATE_CONTENT', 'MODERATE']);
    return e;
  };
  const pedidoDe = async (id: string) =>
    (
      await ownerQuery<{
        tool: string;
        status: string;
        status_reason: string | null;
        mode: string;
        provider: string;
        account_id: string;
        plan_hash: string;
        requested_by: string;
        compensates_action_id: string | null;
        next_attempt_at: Date | null;
      }>(
        `select tool, status, status_reason, mode, provider, account_id, plan_hash, requested_by, compensates_action_id, next_attempt_at from liame.action_request where id = $1`,
        [id],
      )
    )[0]!;
  const pedidosDeApagar = (post: string) => ownerQuery<{ id: string }>(`select id from liame.action_request where tool = 'post_apagar' and resource_id = $1`, [`post:${post}`]);
  const canalDe = async (post: string, canal: string) =>
    (
      await ownerQuery<{ status: string; removed_at: Date | null; metrics_next_at: Date | null; external_id: string | null }>(
        `select status, removed_at, metrics_next_at, external_id from liame.social_post_channel where post_id = $1 and channel = $2`,
        [post, canal],
      )
    )[0]!;
  const executar = (e: EmpresaComCanais) => executor.executeBatch(20, { tenantIds: [e.tenantId] });
  const obter = (e: EmpresaComCanais, post: string) => api.call('GET', `/v1/posts/${post}`, { cookie: e.cookie });
  const deletes = () => ig.chamadas.filter((c) => c.metodo === 'DELETE').length;
  /** O código do app de agora vale de novo (o mesmo passo já aprovou a publicação). */
  const codigoDeNovo = async (e: EmpresaComCanais) => {
    await ownerQuery(`update liame.app_user set totp_last_step = null where id = $1`, [e.userId]);
    await ownerQuery(`delete from liame.rate_limit where key = $1`, [`segundo-fator:${e.userId}`]);
  };
  const apagar = async (e: EmpresaComCanais, post: string, codigo?: string) => {
    await codigoDeNovo(e);
    return api.call('POST', `/v1/posts/${post}/unpublish`, { cookie: e.cookie, body: { code: codigo ?? totpCode(e.secret, currentStep()) } });
  };
  const passaAEspera = (pedido: string) => ownerQuery(`update liame.action_request set next_attempt_at = now() - interval '1 second' where id = $1`, [pedido]);

  /** O post nos dois canais, aprovado com o código do app e na hora de sair (agora são 12h no fuso da empresa). */
  async function postAprovado(e: EmpresaComCanais, foto: string, canais = DOIS_CANAIS): Promise<{ post: string; pedido: string }> {
    await ownerQuery(`update liame.organization set timezone = $2 where id = $1`, [e.tenantId, FUSO_DO_PEDIDO]);
    const r = await api.call('POST', '/v1/posts', {
      cookie: e.cookie,
      body: { brand_id: e.brandId, photo_id: foto, publish_at: `${diaEmSaoPaulo(1)}T19:00:00-03:00`, channels: canais },
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const pedido = r.body.action_id as string;
    await codigoDeNovo(e);
    const aprovado = await api.call('POST', `/v1/actions/${pedido}/approve`, {
      cookie: e.cookie,
      body: { plan_hash: (await pedidoDe(pedido)).plan_hash, code: totpCode(e.secret, currentStep()) },
    });
    expect(aprovado.status, JSON.stringify(aprovado.body)).toBe(200);
    const umMinutoAtras = new Date(Date.now() - 60_000).toISOString();
    await ownerQuery(`update liame.organization set timezone = $2 where id = $1`, [e.tenantId, fusoComAHora(12)]);
    await ownerQuery(`update liame.social_post set publish_at = $2::timestamptz where id = $1`, [r.body.id, umMinutoAtras]);
    await ownerQuery(`update liame.action_request set next_attempt_at = now() - interval '1 second', before_state = jsonb_set(before_state, '{hora}', to_jsonb($2::text)) where id = $1`, [
      pedido,
      umMinutoAtras,
    ]);
    return { post: r.body.id as string, pedido };
  }

  /** O post publicado nos dois canais. */
  async function noAr(nome: string): Promise<{ e: EmpresaComCanais; post: string; pedido: string }> {
    const e = await comOsDois(nome);
    const foto = await fotoGuardada(e, armazem, { largura: 1600, altura: 1200 });
    const { post, pedido } = await postAprovado(e, foto.id);
    expect(await executar(e)).toBe(1);
    expect([(await canalDe(post, 'instagram')).status, (await canalDe(post, 'facebook')).status]).toEqual(['publicado', 'publicado']);
    expect(ig.postsDe(e.instagram!.externo)).toHaveLength(1);
    expect(ig.fotosDe(e.pagina!.externo)).toHaveLength(1);
    ig.chamadas.length = 0;
    return { e, post, pedido };
  }

  it('o post no ar nos dois canais sai das redes, com o código, a qualquer hora, uma vez em cada canal; a Agenda diz apagado, quando e por quem', async () => {
    const { e, post, pedido } = await noAr('Brasa Apaga');
    // Agora são 23h no fuso da empresa: publicar esperaria as 8h; apagar não espera.
    await ownerQuery(`update liame.organization set timezone = $2 where id = $1`, [e.tenantId, fusoComAHora(23)]);

    const r = await apagar(e, post);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.status).toBe('publicado');
    expect(r.body.action_id).toBe(pedido);
    expect(r.body.removal).toMatchObject({ status: 'apagando', reason: null, requested_by_name: expect.any(String) });
    const [quem] = await ownerQuery<{ name: string }>(`select name from liame.app_user where id = $1`, [e.userId]);
    expect(r.body.removal.requested_by_name).toBe(quem!.name);
    // O pedido: a volta da publicação, aprovado com o código (a regra `post.*` da política), pela conta do Instagram.
    const novo = await pedidoDe(r.body.removal.action_id);
    expect(novo).toMatchObject({ tool: 'post_apagar', status: 'aprovada', mode: 'APPROVAL', provider: 'instagram', account_id: e.instagram!.id, requested_by: e.userId, compensates_action_id: pedido });
    const doPedido = await api.call('GET', `/v1/actions/${r.body.removal.action_id}`, { cookie: e.cookie });
    expect(doPedido.body.policy.versions[0]).toBe('plataforma@10');
    const [ev] = await ownerQuery<{ before: Record<string, unknown>; after: Record<string, unknown> }>(
      `select before, after from liame.audit_event where tenant_id = $1 and action = 'posts.apagar_das_redes'`,
      [e.tenantId],
    );
    expect(ev).toMatchObject({ before: { canais_no_ar: ['instagram', 'facebook'] }, after: { action_id: r.body.removal.action_id, aprovado: true } });
    // Enquanto sai das redes, pedir de novo: 409.
    expect(await apagar(e, post)).toMatchObject({ status: 409, body: { code: 'post-saindo-das-redes' } });

    // O executor apaga na hora (às 23h), uma vez em cada canal.
    expect(await executar(e)).toBe(1);
    expect((await pedidoDe(r.body.removal.action_id)).status).toBe('executada');
    expect(deletes()).toBe(2);
    expect(ig.postsDe(e.instagram!.externo)).toHaveLength(0);
    expect(ig.fotosDe(e.pagina!.externo)).toHaveLength(0);
    for (const canal of ['instagram', 'facebook']) {
      const c = await canalDe(post, canal);
      expect(c).toMatchObject({ status: 'apagado', metrics_next_at: null });
      expect(c.removed_at).not.toBeNull();
    }
    const depois = await obter(e, post);
    expect(depois.body.status).toBe('apagado');
    expect(depois.body.removal).toMatchObject({ action_id: r.body.removal.action_id, status: 'apagado', reason: null });
    expect((depois.body.channels as Canal[]).map((c) => [c.channel, c.status, c.removed_at !== null])).toEqual([
      ['instagram', 'apagado', true],
      ['facebook', 'apagado', true],
    ]);
    // Na Agenda também, e o pedido de publicar continua o do post.
    const agenda = await api.call('GET', `/v1/posts?brand_id=${e.brandId}&from=${diaEmSaoPaulo(-1)}&to=${diaEmSaoPaulo(1)}`, { cookie: e.cookie });
    expect(agenda.status, JSON.stringify(agenda.body)).toBe(200);
    expect(agenda.body.items.find((p: { id: string }) => p.id === post)).toMatchObject({ status: 'apagado', action_id: pedido, removal: { status: 'apagado' } });

    // Nada mais no ar: 409, e nada a executar.
    expect(await apagar(e, post)).toMatchObject({ status: 409, body: { code: 'post-fora-do-ar' } });
    expect(await executar(e)).toBe(0);
    expect(deletes()).toBe(2);
  });

  it('cada canal por conta própria: o Instagram sem a permissão de apagar continua no ar, com o porquê; com ela, apagar de novo tira só o que faltou', async () => {
    const { e, post } = await noAr('Brasa Sem Permissao De Apagar');
    ig.semPermissaoDeApagar = true;
    const r = await apagar(e, post);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(await executar(e)).toBe(1);
    const primeiro = await pedidoDe(r.body.removal.action_id);
    expect(primeiro).toMatchObject({ status: 'falhou', status_reason: `O post saiu da Página do Facebook. ${SEM_PERMISSAO_NO_INSTAGRAM}` });
    expect([(await canalDe(post, 'instagram')).status, (await canalDe(post, 'facebook')).status]).toEqual(['publicado', 'apagado']);
    expect(ig.postsDe(e.instagram!.externo)).toHaveLength(1);
    expect(ig.fotosDe(e.pagina!.externo)).toHaveLength(0);
    // O que continua no ar num canal é "publicado"; o pedido diz em parte, com o porquê.
    const emParte = await obter(e, post);
    expect(emParte.body.status).toBe('publicado');
    expect(emParte.body.removal).toMatchObject({ status: 'em_parte', reason: `O post saiu da Página do Facebook. ${SEM_PERMISSAO_NO_INSTAGRAM}` });

    // Com a permissão (a pessoa conectou a Meta de novo), apagar de novo tira só o Instagram.
    ig.semPermissaoDeApagar = false;
    ig.chamadas.length = 0;
    const de = await apagar(e, post);
    expect(de.status, JSON.stringify(de.body)).toBe(200);
    expect(de.body.removal.action_id).not.toBe(r.body.removal.action_id);
    expect(await executar(e)).toBe(1);
    expect((await pedidoDe(de.body.removal.action_id)).status).toBe('executada');
    expect(ig.chamadas.filter((c) => c.metodo === 'DELETE').map((c) => c.caminho.split('/').pop())).toEqual([(await canalDe(post, 'instagram')).external_id]);
    expect(ig.postsDe(e.instagram!.externo)).toHaveLength(0);
    const depois = await obter(e, post);
    expect(depois.body).toMatchObject({ status: 'apagado', removal: { status: 'apagado', reason: null } });
  });

  it('a rede fora do ar faz o pedido esperar, e a volta apaga o resto; o post que já não está na rede não vira apagado; a trava da conta da Página segura só ela', async () => {
    // A Meta fora do ar (503) na vez da Página, depois de o Instagram sair: o pedido espera, o Instagram fica apagado, e a
    // volta tira a Página. (Só o caminho da Página lê a lista das Páginas da autorização.)
    const a = await noAr('Brasa Rede Fora');
    const r = await apagar(a.e, a.post);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    ig.falhas.set('accounts', [{ status: 503, corpo: { error: { message: 'Service temporarily unavailable', type: 'OAuthException', code: 2, fbtrace_id: 'teste' } } }]);
    expect(await executar(a.e)).toBe(1);
    const esperando = await pedidoDe(r.body.removal.action_id);
    expect(esperando.status).toBe('aprovada');
    expect(esperando.next_attempt_at!.getTime()).toBeGreaterThan(Date.now());
    expect([(await canalDe(a.post, 'instagram')).status, (await canalDe(a.post, 'facebook')).status]).toEqual(['apagado', 'publicado']);
    expect((await obter(a.e, a.post)).body.removal.status).toBe('apagando');
    await passaAEspera(r.body.removal.action_id);
    ig.chamadas.length = 0;
    expect(await executar(a.e)).toBe(1);
    expect((await pedidoDe(r.body.removal.action_id)).status).toBe('executada');
    // A volta só apaga a Página: o Instagram já tinha saído.
    expect(ig.chamadas.filter((c) => c.metodo === 'DELETE').map((c) => c.caminho.split('/').pop())).toEqual([(await canalDe(a.post, 'facebook')).external_id]);
    expect((await obter(a.e, a.post)).body.status).toBe('apagado');

    // O post que alguém já apagou direto no Instagram: a Meta responde "não existe" (100/33), e o Liame não afirma que saiu.
    const b = await noAr('Brasa Ja Apagado');
    const naRede = ig.postsDe(b.e.instagram!.externo)[0]!;
    ig.posts.splice(ig.posts.indexOf(naRede), 1);
    expect(ig.postsDe(b.e.instagram!.externo)).toHaveLength(0);
    const rb = await apagar(b.e, b.post);
    expect(rb.status, JSON.stringify(rb.body)).toBe(200);
    expect(await executar(b.e)).toBe(1);
    expect((await pedidoDe(rb.body.removal.action_id)).status_reason).toBe(
      'O post saiu da Página do Facebook. O Instagram não achou este post para apagar: ele pode já ter sido apagado direto na rede. Confira no Instagram.',
    );
    expect([(await canalDe(b.post, 'instagram')).status, (await canalDe(b.post, 'facebook')).status]).toEqual(['publicado', 'apagado']);

    // A trava da conta da Página (o outro canal do pedido, que é pela conta do Instagram): o Instagram sai, a Página fica.
    const c = await noAr('Brasa Trava Da Pagina');
    const trava = await api.call('POST', '/v1/kill-switches', {
      cookie: c.e.cookie,
      body: { level: 'account', provider: 'facebook_page', account_id: c.e.pagina!.id, reason: 'conferindo a Página' },
    });
    expect(trava.status, JSON.stringify(trava.body)).toBe(201);
    const rc = await apagar(c.e, c.post);
    expect(rc.status, JSON.stringify(rc.body)).toBe(200);
    expect(await executar(c.e)).toBe(1);
    expect((await pedidoDe(rc.body.removal.action_id)).status_reason).toBe(
      'O post saiu do Instagram. Uma trava está ligada (account: conferindo a Página). O post continua na Página do Facebook.',
    );
    expect([(await canalDe(c.post, 'instagram')).status, (await canalDe(c.post, 'facebook')).status]).toEqual(['apagado', 'publicado']);
    expect(ig.fotosDe(c.e.pagina!.externo)).toHaveLength(1);
    await api.call('DELETE', `/v1/kill-switches/${trava.body.id}`, { cookie: c.e.cookie });
  });

  it('as recusas deixam tudo como estava: o código errado, o post fora do ar, o pacote, o pedido direto, a trava de apagar e a função desligada', async () => {
    const { e, post } = await noAr('Brasa Recusas Do Apagar');

    // O código errado: 401, e nenhum pedido de apagar fica.
    await codigoDeNovo(e);
    expect(await api.call('POST', `/v1/posts/${post}/unpublish`, { cookie: e.cookie, body: { code: '000000' } })).toMatchObject({ status: 401, body: { code: 'codigo-invalido' } });
    expect(await pedidosDeApagar(post)).toHaveLength(0);
    // O corpo sem os 6 números: 400.
    expect(await api.call('POST', `/v1/posts/${post}/unpublish`, { cookie: e.cookie, body: { code: '12' } })).toMatchObject({ status: 400 });

    // O post aprovado que ainda espera a hora não está no ar.
    const foto = await fotoGuardada(e, armazem, { largura: 1080, altura: 1080 });
    await ownerQuery(`update liame.organization set timezone = $2 where id = $1`, [e.tenantId, FUSO_DO_PEDIDO]);
    const esperando = await api.call('POST', '/v1/posts', {
      cookie: e.cookie,
      body: { brand_id: e.brandId, photo_id: foto.id, publish_at: `${diaEmSaoPaulo(1)}T19:00:00-03:00`, channels: DOIS_CANAIS },
    });
    expect(esperando.status, JSON.stringify(esperando.body)).toBe(201);
    expect(await apagar(e, esperando.body.id)).toMatchObject({ status: 409, body: { code: 'post-fora-do-ar' } });

    // O pacote, quem publicou apaga direto na rede.
    const pacote = await api.call('POST', '/v1/posts', {
      cookie: e.cookie,
      body: { brand_id: e.brandId, photo_id: foto.id, publish_at: `${diaEmSaoPaulo(1)}T19:00:00-03:00`, channels: [{ channel: 'tiktok', text: 'Smash duplo 🍔' }] },
    });
    expect(pacote.status, JSON.stringify(pacote.body)).toBe(201);
    expect(await apagar(e, pacote.body.id)).toMatchObject({ status: 409, body: { code: 'e-pacote' } });

    // A ferramenta não se pede direto, pela rota das ações.
    const direto = await api.call('POST', '/v1/actions', {
      cookie: e.cookie,
      body: { tool: 'post_apagar', brand_id: e.brandId, provider: 'instagram', account_id: e.instagram!.id, resource_id: `post:${post}`, params: {} },
    });
    expect(direto).toMatchObject({ status: 422, body: { code: 'acao-so-como-volta' } });

    // A trava de apagar: 423. A de publicar não segura o apagar.
    const deApagar = await api.call('POST', '/v1/kill-switches', { cookie: e.cookie, body: { level: 'tool', tool: 'post_apagar', reason: 'conferindo' } });
    expect(deApagar.status, JSON.stringify(deApagar.body)).toBe(201);
    expect(await apagar(e, post)).toMatchObject({ status: 423, body: { code: 'parada-acionada' } });
    expect(await pedidosDeApagar(post)).toHaveLength(0);
    await api.call('DELETE', `/v1/kill-switches/${deApagar.body.id}`, { cookie: e.cookie });

    // A função desligada: 409, antes de tudo.
    await ligarFlagDaEmpresa(api, 'social_write', e.tenantId, false);
    expect(await apagar(e, post)).toMatchObject({ status: 409, body: { code: 'funcao-desligada' } });
    await ligarFlagDaEmpresa(api, 'social_write', e.tenantId, true);

    const travaDePublicar = await api.call('POST', '/v1/kill-switches', { cookie: e.cookie, body: { level: 'tool', tool: 'post_publicar', reason: 'sem posts novos' } });
    expect(travaDePublicar.status, JSON.stringify(travaDePublicar.body)).toBe(201);
    const ok = await apagar(e, post);
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(await executar(e)).toBe(1);
    expect((await obter(e, post)).body.status).toBe('apagado');
    await api.call('DELETE', `/v1/kill-switches/${travaDePublicar.body.id}`, { cookie: e.cookie });
  });
});
