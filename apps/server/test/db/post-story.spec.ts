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
import { type EmpresaComCanais, empresaComCanais, fotoGuardada, videoGuardado } from '../helpers/posts-semeados.js';
import { hasDb } from './env.js';

// A6 · Z13, parte 1: o Story (P41; D-A6-126 a D-A6-129, as recomendadas; a migration 0136), contra a Meta de mentira que
// segue as páginas lidas em 11/11/2026 (o Story pela referência de `/{ig-user-id}/media` e o Page Stories API). O que se
// prova:
//   - montar: só com a função `stories`; sem texto, sem o pacote, sem recorte e sem capa; o post de sempre continua pedindo
//     o texto; o vídeo de mais de 60 s não vai ao Story do Instagram, mas vai só à Página; o Story não leva link; a
//     resposta e o estado do pedido dizem o formato, e o post de foto segue sem a chave;
//   - o Instagram: o contêiner `STORIES` com a foto inteira (sem legenda) ou com o vídeo, e o `media_publish` de sempre;
//   - a Página: a foto sem post e o `photo_stories`; a resposta que não chega não publica de novo (a tentativa seguinte
//     acha o Story pela mídia); o vídeo pelo `video_stories` (o começo, o envio pelo `rupload` e o fim).

const FUSO_DO_PEDIDO = 'America/Sao_Paulo';
const diaEmSaoPaulo = (n: number): string =>
  new Intl.DateTimeFormat('en-CA', { timeZone: FUSO_DO_PEDIDO, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(Date.now() + n * 86_400_000));

/** Um fuso em que agora é `hora` no relógio (`Etc/GMT±N`), como no teste do post. */
function fusoComAHora(hora: number): string {
  let diferenca = (hora - new Date().getUTCHours()) % 24;
  if (diferenca < 0) diferenca += 24;
  if (diferenca > 12) diferenca -= 24;
  return diferenca === 0 ? 'Etc/GMT' : `Etc/GMT${diferenca > 0 ? '-' : '+'}${Math.abs(diferenca)}`;
}

describe.skipIf(!hasDb)('o Story (A6 · Z13, parte 1)', () => {
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
    // A Meta busca a foto e o vídeo pelo endereço que o Liame manda: no armazenamento dos testes, `memoria://imagens/<chave>`.
    ig.buscarImagem = (endereco) => {
      const m = /^memoria:\/\/imagens\/(.+)\?valido=\d+$/.exec(endereco);
      return m ? (armazem.objetos.get(m[1]!) ?? null) : null;
    };
    const vault = api.app.get(VaultService);
    const deps: DependenciasDoPost = {
      lerSegredo: (tx, id) => vault.readSecret(tx, id),
      cliente: () => new ClienteConector(database.db, { enderecos: { meta_ads: [ig.base, ig.rupload] }, tentativas: 1, balde: { capacidade: 10_000, porSegundo: 1_000 } }),
      graphUrl: ig.base,
      ruploadUrl: ig.rupload,
      appSecret: SEGREDO_DO_APP,
      versao: (capacidade) => versaoRegistrada(database.db, 'meta_ads', capacidade),
      armazem,
      esperaDoConteinerMs: 0,
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

  /** A empresa com o Instagram e a Página ligados, a Página com a tarefa de publicar, os vídeos e (ou não) os Stories. */
  async function empresa(nome: string, o: { stories?: boolean } = {}): Promise<EmpresaComCanais> {
    const e = await empresaComCanais(api, nome, { pagina: true, instagram: true, token: TOKEN_DO_INSTAGRAM });
    ig.paginas.set(e.pagina!.externo, ['CREATE_CONTENT', 'MODERATE']);
    await ligarFlagDaEmpresa(api, 'videos', e.tenantId, true);
    if (o.stories ?? true) await ligarFlagDaEmpresa(api, 'stories', e.tenantId, true);
    return e;
  }
  const pedidoDe = async (id: string) =>
    (
      await ownerQuery<{ status: string; status_reason: string | null; plan_hash: string; before_state: Record<string, unknown> }>(
        `select status, status_reason, plan_hash, before_state from liame.action_request where id = $1`,
        [id],
      )
    )[0]!;
  const canalDe = async (post: string, canal: string) =>
    (
      await ownerQuery<{ status: string; body: string; container_id: string | null; external_id: string | null; permalink: string | null; error: string | null }>(
        `select status, body, container_id, external_id, permalink, error from liame.social_post_channel where post_id = $1 and channel = $2`,
        [post, canal],
      )
    )[0]!;
  const executar = (e: EmpresaComCanais) => executor.executeBatch(20, { tenantIds: [e.tenantId] });
  const passaAEspera = (pedido: string) => ownerQuery(`update liame.action_request set next_attempt_at = now() - interval '1 second' where id = $1`, [pedido]);
  const chamadasA = (fim: string, metodo = 'POST') => ig.chamadas.filter((c) => c.metodo === metodo && c.caminho.endsWith(fim));

  /** O novo Story pela API, como a tela, sem aprovar: os canais sem texto. */
  const novoStory = (e: EmpresaComCanais, midia: string, o: { canais?: Array<{ channel: string; text?: string }>; extra?: Record<string, unknown> } = {}) =>
    api.call('POST', '/v1/posts', {
      cookie: e.cookie,
      body: {
        brand_id: e.brandId,
        format: 'story',
        photo_id: midia,
        publish_at: `${diaEmSaoPaulo(1)}T19:00:00-03:00`,
        channels: o.canais ?? [{ channel: 'instagram' }, { channel: 'facebook' }],
        ...(o.extra ?? {}),
      },
    });

  /** O Story aprovado com o código do app e na hora de sair (agora são 12h no fuso da empresa). */
  async function storyAprovado(e: EmpresaComCanais, midia: string, canais: string[]): Promise<{ post: string; pedido: string }> {
    await ownerQuery(`update liame.organization set timezone = $2 where id = $1`, [e.tenantId, FUSO_DO_PEDIDO]);
    const r = await novoStory(e, midia, { canais: canais.map((channel) => ({ channel })) });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const pedido = r.body.action_id as string;
    await ownerQuery(`update liame.app_user set totp_last_step = null where id = $1`, [e.userId]);
    await ownerQuery(`delete from liame.rate_limit where key = $1`, [`segundo-fator:${e.userId}`]);
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

  it('montar: só com a função; sem texto, sem pacote, sem recorte e sem capa; o vídeo longo só na Página; o formato na resposta e no pedido', async () => {
    const e = await empresa('Brasa Story Monta', { stories: false });
    const foto = await fotoGuardada(e, armazem, { largura: 1080, altura: 1920 });
    const recusa = async (r: { status: number; body: Record<string, unknown> }) => [r.status, r.body.code];
    expect(await recusa(await novoStory(e, foto.id))).toEqual([409, 'funcao-desligada']);

    await ligarFlagDaEmpresa(api, 'stories', e.tenantId, true);
    expect(await recusa(await novoStory(e, foto.id, { canais: [{ channel: 'instagram', text: 'Olha o smash!' }] }))).toEqual([422, 'story-sem-texto']);
    expect(await recusa(await novoStory(e, foto.id, { canais: [{ channel: 'instagram' }, { channel: 'tiktok' }] }))).toEqual([422, 'story-sem-pacote']);
    expect(await recusa(await novoStory(e, foto.id, { extra: { crop_pos: 50 } }))).toEqual([422, 'story-sem-recorte']);
    // O post de sempre continua pedindo o texto de cada canal.
    const semTexto = await api.call('POST', '/v1/posts', {
      cookie: e.cookie,
      body: { brand_id: e.brandId, photo_id: foto.id, publish_at: `${diaEmSaoPaulo(1)}T19:00:00-03:00`, channels: [{ channel: 'instagram' }] },
    });
    expect(await recusa(semTexto)).toEqual([422, 'texto-vazio']);

    const r = await novoStory(e, foto.id);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body).toMatchObject({ format: 'story', kind: 'post', crop_pos: null, link: null, status: 'esperando_aprovacao' });
    expect((r.body.channels as Array<{ channel: string; text: string }>).map((c) => [c.channel, c.text])).toEqual([
      ['instagram', ''],
      ['facebook', ''],
    ]);
    const estado = (await pedidoDe(r.body.action_id)).before_state as { formato?: string; canais: Array<{ texto: string }> };
    expect(estado.formato).toBe('story');
    expect(estado.canais.map((c) => c.texto)).toEqual(['', '']);
    const [ev] = await ownerQuery<{ after: Record<string, unknown> }>(`select after from liame.audit_event where tenant_id = $1 and action = 'posts.criar' and resource_id = $2`, [e.tenantId, r.body.id]);
    expect(ev!.after).toMatchObject({ format: 'story', link_do_post: null, canais: ['instagram', 'facebook'] });

    // O vídeo de 1:15: o Story do Instagram vai até 60 s; só na Página, vai.
    const longo = await videoGuardado(e, armazem, { duracaoMs: 75_000 });
    expect(await recusa(await novoStory(e, longo.id))).toEqual([422, 'story-fora-do-limite']);
    expect((await novoStory(e, longo.id, { canais: [{ channel: 'facebook' }] })).status).toBe(201);
    // A capa vale para o Reels: o Story não tem.
    const curto = await videoGuardado(e, armazem, { duracaoMs: 18_000 });
    expect(await recusa(await novoStory(e, curto.id, { extra: { cover_offset_ms: 1_000 } }))).toEqual([422, 'story-sem-capa']);

    // O post de foto segue sem a chave do formato, na resposta e no pedido.
    const post = await api.call('POST', '/v1/posts', {
      cookie: e.cookie,
      body: { brand_id: e.brandId, photo_id: foto.id, publish_at: `${diaEmSaoPaulo(1)}T19:00:00-03:00`, channels: [{ channel: 'instagram', text: 'Olha o smash!' }] },
    });
    expect(post.status, JSON.stringify(post.body)).toBe(201);
    expect(post.body.format).toBeUndefined();
    expect((await pedidoDe(post.body.action_id)).before_state.formato).toBeUndefined();
  }, 120_000);

  it('o Instagram: o contêiner STORIES com a foto inteira, sem legenda, e o vídeo como Story', async () => {
    const e = await empresa('Brasa Story Instagram');
    // A foto quadrada: no post ela caberia; no Story, vai inteira, sem recorte.
    const foto = await fotoGuardada(e, armazem, { largura: 1080, altura: 1080 });
    const { post, pedido } = await storyAprovado(e, foto.id, ['instagram']);
    await executar(e);
    expect((await pedidoDe(pedido)).status).toBe('executada');
    const canal = await canalDe(post, 'instagram');
    expect(canal).toMatchObject({ status: 'publicado', body: '', error: null });
    expect(canal.permalink).toMatch(/^https:\/\/www\.instagram\.com\/stories\//);
    const criar = chamadasA('/media');
    expect(criar).toHaveLength(1);
    expect(criar[0]!.corpo).toMatchObject({ media_type: 'STORIES' });
    expect(Object.keys(criar[0]!.corpo ?? {}).sort()).toEqual(['image_url', 'media_type']);
    expect(ig.stories.filter((s) => s.onde === e.instagram!.externo).map((s) => s.media_type)).toEqual(['photo']);
    // Nada de recorte guardado: o Story vai inteiro.
    const [linha] = await ownerQuery<{ instagram_object_key: string | null }>(`select instagram_object_key from liame.social_post where id = $1`, [post]);
    expect(linha!.instagram_object_key).toBeNull();

    // O vídeo de 18 s como Story: `video_url`, sem capa e sem o Feed.
    ig.normalizar();
    const video = await videoGuardado(e, armazem, { duracaoMs: 18_000 });
    const doVideo = await storyAprovado(e, video.id, ['instagram']);
    await executar(e);
    expect((await canalDe(doVideo.post, 'instagram')).status).toBe('publicado');
    expect(Object.keys(chamadasA('/media')[0]!.corpo ?? {}).sort()).toEqual(['media_type', 'video_url']);
    expect(ig.defeitos).toEqual([]);
  }, 120_000);

  it('a Página: a foto sem post e o photo_stories; a resposta perdida não publica de novo; o vídeo pelo video_stories', async () => {
    const e = await empresa('Brasa Story Pagina');
    const pagina = e.pagina!.externo;
    const foto = await fotoGuardada(e, armazem, { largura: 1080, altura: 1920 });
    const { post, pedido } = await storyAprovado(e, foto.id, ['facebook']);
    // A Meta publica o Story, mas a resposta não chega: a tentativa seguinte acha o Story pela foto e não publica de novo.
    ig.perderARespostaDoStory = true;
    await executar(e);
    expect((await pedidoDe(pedido)).status).toBe('aprovada');
    const meio = await canalDe(post, 'facebook');
    expect(meio.status).toBe('publicando');
    expect(meio.container_id).toBe(ig.fotosSemPost[0]!.id);
    await passaAEspera(pedido);
    await executar(e);
    expect((await pedidoDe(pedido)).status).toBe('executada');
    const canal = await canalDe(post, 'facebook');
    const doStory = ig.stories.filter((s) => s.onde === pagina);
    expect(doStory).toHaveLength(1);
    expect(canal).toMatchObject({ status: 'publicado', body: '', external_id: doStory[0]!.post_id });
    // A foto foi sem post (`published=false`) e nada saiu no feed da Página.
    expect(chamadasA(`/${pagina}/photos`)[0]!.corpo).toMatchObject({ published: 'false' });
    expect(chamadasA(`/${pagina}/photo_stories`)).toHaveLength(1);
    expect(ig.fotosNaPagina.filter((f) => f.pagina === pagina)).toEqual([]);

    // O vídeo de 1:15 como Story da Página: o começo, o envio pelo rupload e o fim.
    ig.normalizar();
    const video = await videoGuardado(e, armazem, { duracaoMs: 75_000 });
    const doVideo = await storyAprovado(e, video.id, ['facebook']);
    await executar(e);
    expect((await pedidoDe(doVideo.pedido)).status).toBe('executada');
    expect((await canalDe(doVideo.post, 'facebook')).status).toBe('publicado');
    expect(chamadasA(`/${pagina}/video_stories`).map((c) => c.corpo?.upload_phase)).toEqual(['start', 'finish']);
    expect(ig.chamadas.filter((c) => c.caminho.startsWith('/rupload/'))).toHaveLength(1);
    expect(ig.stories.filter((s) => s.onde === pagina).map((s) => s.media_type)).toEqual(['video', 'photo']);
    expect(ig.defeitos).toEqual([]);
  }, 120_000);

  /** "Tirar do ar" com o código do app de agora (o mesmo passo já aprovou a publicação). */
  const tirar = async (e: EmpresaComCanais, post: string) => {
    await ownerQuery(`update liame.app_user set totp_last_step = null where id = $1`, [e.userId]);
    await ownerQuery(`delete from liame.rate_limit where key = $1`, [`segundo-fator:${e.userId}`]);
    return api.call('POST', `/v1/posts/${post}/unpublish`, { cookie: e.cookie, body: { code: totpCode(e.secret, currentStep()) } });
  };

  it('tirar do ar (parte 2; D-A6-132): só do Instagram e nas 24 horas; a Página fica; o Story sem o id não é procurado pela legenda', async () => {
    const e = await empresa('Brasa Story Tira');
    const ig1 = e.instagram!.externo;
    const pagina = e.pagina!.externo;
    const foto = await fotoGuardada(e, armazem, { largura: 1080, altura: 1920 });
    const { post } = await storyAprovado(e, foto.id, ['instagram', 'facebook']);
    await executar(e);
    expect([(await canalDe(post, 'instagram')).status, (await canalDe(post, 'facebook')).status]).toEqual(['publicado', 'publicado']);
    // O Story não agenda a leitura dos números (D-A6-130).
    const leituras = await ownerQuery<{ metrics_next_at: Date | null }>(`select metrics_next_at from liame.social_post_channel where post_id = $1`, [post]);
    expect(leituras.map((l) => l.metrics_next_at)).toEqual([null, null]);

    // Sai do Instagram (`DELETE /<IG_MEDIA_ID>`); a Página não tem como (o Page Stories API), e o Story fica lá.
    const r = await tirar(e, post);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.removal).toMatchObject({ status: 'apagando' });
    await executar(e);
    expect((await pedidoDe(r.body.removal.action_id)).status).toBe('executada');
    expect([(await canalDe(post, 'instagram')).status, (await canalDe(post, 'facebook')).status]).toEqual(['apagado', 'publicado']);
    expect(ig.chamadas.filter((c) => c.metodo === 'DELETE')).toHaveLength(1);
    expect(ig.stories.filter((s) => s.onde === ig1)).toEqual([]);
    expect(ig.stories.filter((s) => s.onde === pagina)).toHaveLength(1);
    // De novo: só a Página no ar, e a Meta não deixa tirar de lá.
    expect(await tirar(e, post)).toMatchObject({ status: 409, body: { code: 'story-so-na-pagina' } });

    // Passou das 24 horas (contadas do primeiro canal em que saiu): já saiu do ar.
    const outro = await storyAprovado(e, foto.id, ['instagram']);
    await executar(e);
    await ownerQuery(`update liame.social_post_channel set published_at = now() - interval '25 hours' where post_id = $1`, [outro.post]);
    expect(await tirar(e, outro.post)).toMatchObject({ status: 409, body: { code: 'story-fora-do-ar' } });

    // A resposta da publicação que não chegou: o Story saiu, sem o id guardado. Tirar do ar não procura pela legenda
    // (vazia, podia achar outro post): diz para tirar direto no Instagram.
    ig.normalizar();
    const semId = await storyAprovado(e, foto.id, ['instagram']);
    ig.perderARespostaDaPublicacao = true;
    await executar(e);
    await passaAEspera(semId.pedido);
    await executar(e);
    expect(await canalDe(semId.post, 'instagram')).toMatchObject({ status: 'publicado', external_id: null });
    const t = await tirar(e, semId.post);
    expect(t.status, JSON.stringify(t.body)).toBe(200);
    await executar(e);
    const depois = await api.call('GET', `/v1/posts/${semId.post}`, { cookie: e.cookie });
    expect(depois.body.removal).toMatchObject({ status: 'nao_apagou' });
    expect(depois.body.removal.reason).toContain('Tire direto no Instagram');
    expect(ig.chamadas.filter((c) => c.metodo === 'DELETE' || (c.metodo === 'GET' && c.caminho.endsWith(`/${ig1}/media`)))).toEqual([]);
    expect((await canalDe(semId.post, 'instagram')).status).toBe('publicado');
    expect(ig.defeitos).toEqual([]);
  }, 120_000);
});
