import type { Database } from '@liame/database';
import sharp from 'sharp';
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
import { InstagramDeMentira, SEGREDO_DO_APP, TOKEN_DA_PAGINA, TOKEN_DO_INSTAGRAM } from '../helpers/instagram-de-mentira.js';
import { ligarFlagDaEmpresa } from '../helpers/meta-de-mentira.js';
import { type EmpresaComCanais, empresaComCanais, fotoGuardada, videoGuardado } from '../helpers/posts-semeados.js';
import { hasDb } from './env.js';

// A6 · Z10, parte 3a: o post com vídeo (D-A6-68 a D-A6-70), contra a Meta de mentira que segue as páginas oficiais lidas
// em 06/11/2026 (a referência de `/{ig-user-id}/media`, com o Reels, e o "Reels Publishing" da Video API). O que se prova:
//   - montar: só com a função `videos` (sem ela, o vídeo é recusado como antes); sem o pacote e sem o recorte; no
//     Instagram, só o vídeo que cabe no Reels como está (até 1.920 px de largura e 25 Mbps); a capa presa no pedido (a do
//     próprio vídeo, pela versão, ou uma das Fotos, JPEG até 8 MB); e o estado do post de FOTO sem a chave do vídeo (o
//     pedido de foto já aprovado não muda de plano);
//   - o Instagram: o contêiner do Reels com o vídeo, a capa (ou o quadro do meio) e o Feed; a Meta que ainda prepara faz
//     o pedido esperar um minuto, sem contar tentativa; em 5 minutos, o canal não sai, e "Tentar de novo" publica o MESMO
//     contêiner, mesmo sem nenhum canal no ar;
//   - a Página: em pé, o Reels (o começo, o envio pelo `rupload` com o token da Página e o `file_url`, e o fim com a
//     legenda); deitado, o vídeo comum; a resposta que não chega não manda de novo; a Meta que ainda publica; a recusa
//     do vídeo; e o limite de 30 vídeos do Liame por Página em 24 horas;
//   - na hora de sair, o que mudou desde a aprovação não sai: o vídeo apagado e a capa trocada.

const LEGENDA = 'Olha o smash saindo da chapa na Casa Brasa. Peça pelo link da bio.';
const NA_PAGINA = 'O smash saindo da chapa, agora, na Casa Brasa.';
const FUSO_DO_PEDIDO = 'America/Sao_Paulo';

const diaEmSaoPaulo = (n: number): string =>
  new Intl.DateTimeFormat('en-CA', { timeZone: FUSO_DO_PEDIDO, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(Date.now() + n * 86_400_000));

/** Um fuso em que agora é `hora` no relógio (`Etc/GMT±N`), como no teste do post de foto. */
function fusoComAHora(hora: number): string {
  let diferenca = (hora - new Date().getUTCHours()) % 24;
  if (diferenca < 0) diferenca += 24;
  if (diferenca > 12) diferenca -= 24;
  return diferenca === 0 ? 'Etc/GMT' : `Etc/GMT${diferenca > 0 ? '-' : '+'}${Math.abs(diferenca)}`;
}

describe.skipIf(!hasDb)('o post com vídeo (A6 · Z10, parte 3a)', () => {
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
    // A Meta busca o vídeo e a capa pelo endereço que o Liame manda: no armazenamento dos testes, `memoria://imagens/<chave>`.
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
      trava: async (tx, alvo) => {
        const t = await api.app.get(KillSwitchService).check(tx, { ...alvo, tool: 'post_publicar' });
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

  /** A empresa com o Instagram e a Página ligados, a Página com as tarefas de publicar e moderar, e os vídeos ligados. */
  async function empresa(nome: string, o: { videos?: boolean } = {}): Promise<EmpresaComCanais> {
    const e = await empresaComCanais(api, nome, { pagina: true, instagram: true, token: TOKEN_DO_INSTAGRAM });
    ig.paginas.set(e.pagina!.externo, ['CREATE_CONTENT', 'MODERATE']);
    if (o.videos ?? true) await ligarFlagDaEmpresa(api, 'videos', e.tenantId, true);
    return e;
  }
  const pedidoDe = async (id: string) =>
    (
      await ownerQuery<{ status: string; status_reason: string | null; attempts: number; next_attempt_at: Date | null; plan_hash: string; before_state: Record<string, unknown> }>(
        `select status, status_reason, attempts, next_attempt_at, plan_hash, before_state from liame.action_request where id = $1`,
        [id],
      )
    )[0]!;
  const canalDe = async (post: string, canal = 'instagram') =>
    (
      await ownerQuery<{ status: string; container_id: string | null; external_id: string | null; permalink: string | null; error: string | null; preparing_since: Date | null }>(
        `select status, container_id, external_id, permalink, error, preparing_since from liame.social_post_channel where post_id = $1 and channel = $2`,
        [post, canal],
      )
    )[0]!;
  const executar = (e: EmpresaComCanais) => executor.executeBatch(20, { tenantIds: [e.tenantId] });
  /** A hora chega: o post e o pedido são de um minuto atrás (a nova tentativa sai pela hora do post), e agora são 12h no fuso. */
  const chegaAHora = async (e: EmpresaComCanais, post: string, pedido: string) => {
    const umMinutoAtras = new Date(Date.now() - 60_000).toISOString();
    await ownerQuery(`update liame.organization set timezone = $2 where id = $1`, [e.tenantId, fusoComAHora(12)]);
    await ownerQuery(`update liame.social_post set publish_at = $2::timestamptz where id = $1`, [post, umMinutoAtras]);
    await ownerQuery(`update liame.action_request set next_attempt_at = now() - interval '1 second', before_state = jsonb_set(before_state, '{hora}', to_jsonb($2::text)) where id = $1`, [
      pedido,
      umMinutoAtras,
    ]);
  };
  const passaAEspera = (pedido: string) => ownerQuery(`update liame.action_request set next_attempt_at = now() - interval '1 second' where id = $1`, [pedido]);
  /** Os 5 minutos do preparo passaram (D-A6-69). */
  const passamOsCincoMinutos = (post: string) => ownerQuery(`update liame.social_post_channel set preparing_since = now() - interval '6 minutes' where post_id = $1 and preparing_since is not null`, [post]);

  /** O novo post pela API, como a tela, sem aprovar. `quadro`: o tempo do quadro do vídeo escolhido como capa (parte 4a). */
  const novoPost = (e: EmpresaComCanais, midia: string, o: { canais?: Array<{ channel: string; text: string }>; crop?: number; capa?: string; quadro?: number } = {}) =>
    api.call('POST', '/v1/posts', {
      cookie: e.cookie,
      body: {
        brand_id: e.brandId,
        photo_id: midia,
        publish_at: `${diaEmSaoPaulo(1)}T19:00:00-03:00`,
        channels: o.canais ?? [{ channel: 'instagram', text: LEGENDA }],
        ...(o.crop === undefined ? {} : { crop_pos: o.crop }),
        ...(o.capa === undefined ? {} : { cover_photo_id: o.capa }),
        ...(o.quadro === undefined ? {} : { cover_offset_ms: o.quadro }),
      },
    });

  /** O novo post com o vídeo, aprovado com o código do app e na hora de sair. */
  async function postAprovado(
    e: EmpresaComCanais,
    midia: string,
    o: { canais?: Array<{ channel: string; text: string }>; capa?: string; quadro?: number } = {},
  ): Promise<{ post: string; pedido: string }> {
    await ownerQuery(`update liame.organization set timezone = $2 where id = $1`, [e.tenantId, FUSO_DO_PEDIDO]);
    const r = await novoPost(e, midia, o);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const pedido = r.body.action_id as string;
    await ownerQuery(`update liame.app_user set totp_last_step = null where id = $1`, [e.userId]);
    await ownerQuery(`delete from liame.rate_limit where key = $1`, [`segundo-fator:${e.userId}`]);
    const aprovado = await api.call('POST', `/v1/actions/${pedido}/approve`, {
      cookie: e.cookie,
      body: { plan_hash: (await pedidoDe(pedido)).plan_hash, code: totpCode(e.secret, currentStep()) },
    });
    expect(aprovado.status, JSON.stringify(aprovado.body)).toBe(200);
    await chegaAHora(e, r.body.id as string, pedido);
    return { post: r.body.id as string, pedido };
  }

  // ---- Montar ------------------------------------------------------------------------------------------------------

  it('montar: sem a função dos vídeos, o vídeo é recusado como antes; com ela, o post nasce com o vídeo e a capa presa', async () => {
    const e = await empresa('Brasa Video Monta', { videos: false });
    const video = await videoGuardado(e, armazem);
    const sem = await novoPost(e, video.id);
    expect(sem.status).toBe(422);
    expect(sem.body.code).toBe('foto-fora-da-marca');

    await ligarFlagDaEmpresa(api, 'videos', e.tenantId, true);
    const r = await novoPost(e, video.id, { canais: [{ channel: 'instagram', text: LEGENDA }, { channel: 'facebook', text: NA_PAGINA }] });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body).toMatchObject({ photo_id: video.id, media: 'video', cover_photo_id: null, crop_pos: null, status: 'esperando_aprovacao' });
    const [linha] = await ownerQuery<{ media: string; photo_sha256: string | null; cover_version: number | null; cover_photo_id: string | null }>(
      `select media, photo_sha256, cover_version, cover_photo_id from liame.social_post where id = $1`,
      [r.body.id],
    );
    // A capa do próprio vídeo, presa pela versão (a capa gravada na parte 2 é a versão 1).
    expect(linha).toEqual({ media: 'video', photo_sha256: null, cover_version: 1, cover_photo_id: null });
    // O estado do pedido leva o vídeo com a capa presa; o de foto não leva a chave (o teste abaixo).
    expect((await pedidoDe(r.body.action_id)).before_state.video).toEqual({ id: video.id, capa: 'capa:1' });
  });

  it('montar: as recusas do vídeo (o pacote, o recorte, o vídeo grande para o Reels e a capa) e o post de foto sem a chave do vídeo', async () => {
    const e = await empresa('Brasa Video Recusas');
    const video = await videoGuardado(e, armazem);
    const recusa = async (corpo: Parameters<typeof novoPost>[2], midia = video.id) => {
      const r = await novoPost(e, midia, corpo);
      expect(r.status, JSON.stringify(r.body)).toBe(422);
      return r.body.code as string;
    };
    expect(await recusa({ canais: [{ channel: 'instagram', text: LEGENDA }, { channel: 'tiktok', text: LEGENDA }] })).toBe('video-no-pacote');
    expect(await recusa({ crop: 50 })).toBe('recorte-so-na-foto');
    // O 4K em pé passa de 1.920 px de largura: no Instagram, ainda não (a redução é a parte 3b); só na Página, vai.
    const quatroK = await videoGuardado(e, armazem, { largura: 2160, altura: 3840 });
    expect(await recusa({}, quatroK.id)).toBe('video-grande-para-o-reels');
    expect((await novoPost(e, quatroK.id, { canais: [{ channel: 'facebook', text: NA_PAGINA }] })).status).toBe(201);
    // 300 MB em 24 s passa de 25 Mbps.
    const pesado = await videoGuardado(e, armazem, { bytes: 300_000_000, duracaoMs: 24_000 });
    expect(await recusa({}, pesado.id)).toBe('video-grande-para-o-reels');
    // A capa: uma das Fotos da marca, JPEG até 8 MB; o vídeo não é capa; a foto de outra marca não é capa.
    expect(await recusa({ capa: video.id })).toBe('capa-fora-da-marca');
    const outra = await empresa('Brasa Video Outra');
    const fotoDeOutra = await fotoGuardada(outra, armazem, { largura: 1080, altura: 1920 });
    expect(await recusa({ capa: fotoDeOutra.id })).toBe('capa-fora-da-marca');
    const grande = await fotoGuardada(e, armazem, { largura: 1080, altura: 1920 });
    await ownerQuery(`update liame.brand_photo set bytes = 9000000 where id = $1`, [grande.id]);
    expect(await recusa({ capa: grande.id })).toBe('capa-grande-demais');
    // O quadro do vídeo como capa (parte 4a): dentro da duração (24 s), e uma capa só.
    expect(await recusa({ quadro: 24_001 })).toBe('quadro-fora-do-video');
    const umaFoto = await fotoGuardada(e, armazem, { largura: 1080, altura: 1920 });
    expect(await recusa({ quadro: 1_000, capa: umaFoto.id })).toBe('capa-repetida');
    // A capa só no vídeo; e o post de foto segue com o estado de antes, sem a chave do vídeo.
    const foto = await fotoGuardada(e, armazem, { largura: 1600, altura: 1200 });
    expect(await recusa({ capa: foto.id }, foto.id)).toBe('capa-so-no-video');
    expect(await recusa({ quadro: 1_000 }, foto.id)).toBe('capa-so-no-video');
    const deFoto = await novoPost(e, foto.id);
    expect(deFoto.status).toBe(201);
    expect(deFoto.body.media).toBeUndefined();
    expect(Object.keys((await pedidoDe(deFoto.body.action_id)).before_state).sort()).toEqual(['canais', 'foto', 'hora', 'hora_local', 'post', 'recorte']);
  });

  // ---- O Instagram -------------------------------------------------------------------------------------------------

  it('Instagram: o Reels sai uma vez, com o vídeo como a loja gravou, a capa do próprio vídeo e no Feed', async () => {
    const e = await empresa('Brasa Reels IG');
    const video = await videoGuardado(e, armazem);
    const { post, pedido } = await postAprovado(e, video.id);
    expect(await executar(e)).toBe(1);
    expect(await pedidoDe(pedido)).toMatchObject({ status: 'executada', status_reason: null });

    const [publicado] = ig.postsDe(e.instagram!.externo);
    expect(ig.postsDe(e.instagram!.externo)).toHaveLength(1);
    const c = ig.conteineres.get(publicado!.conteiner)!;
    // O contêiner do Reels: o vídeo pelo endereço assinado de 590 segundos, a capa guardada, no Feed, e a legenda.
    expect(c).toMatchObject({ tipo: 'REELS', caption: LEGENDA, endereco: `memoria://imagens/${video.chave}?valido=590`, capa: `memoria://imagens/${video.capa}?valido=590`, quadro: null, noFeed: 'true' });
    expect(c.imagem?.equals(armazem.objetos.get(video.chave)!)).toBe(true);
    expect(await canalDe(post)).toMatchObject({ status: 'publicado', external_id: publicado!.id, permalink: publicado!.permalink, error: null, preparing_since: null });
    expect(ig.defeitos).toEqual([]);
    expect(await executar(e)).toBe(0);
  });

  it('Instagram: sem capa gravada, vai o quadro do meio; com uma das Fotos como capa, vai a foto', async () => {
    const e = await empresa('Brasa Reels Capa');
    const semCapa = await videoGuardado(e, armazem, { capa: false, duracaoMs: 30_000 });
    const a = await postAprovado(e, semCapa.id);
    expect(await executar(e)).toBe(1);
    expect((await pedidoDe(a.pedido)).status).toBe('executada');
    const doMeio = [...ig.conteineres.values()].find((c) => c.endereco.includes(semCapa.chave))!;
    expect(doMeio).toMatchObject({ capa: null, quadro: '15000' });

    const video = await videoGuardado(e, armazem);
    const foto = await fotoGuardada(e, armazem, { largura: 1080, altura: 1920 });
    // Uma legenda própria: com a mesma do post anterior, publicado no mesmo segundo, a conferência "já saiu?" acharia aquele.
    const b = await postAprovado(e, video.id, { capa: foto.id, canais: [{ channel: 'instagram', text: 'O smash com a capa da foto.' }] });
    expect((await pedidoDe(b.pedido)).before_state.video).toEqual({ id: video.id, capa: `foto:${foto.id}` });
    expect(await executar(e)).toBe(1);
    expect((await pedidoDe(b.pedido)).status).toBe('executada');
    const comFoto = [...ig.conteineres.values()].find((c) => c.endereco.includes(video.chave))!;
    expect(comFoto).toMatchObject({ capa: `memoria://imagens/${foto.chave}?valido=590`, quadro: null });

    // Um quadro do próprio vídeo, escolhido no novo post (A6, Z10, parte 4a): o tempo dele vai como `thumb_offset`.
    const outro = await videoGuardado(e, armazem, { duracaoMs: 20_000 });
    const c = await postAprovado(e, outro.id, { quadro: 5_000, canais: [{ channel: 'instagram', text: 'O smash no quadro dos 5 segundos.' }] });
    expect((await pedidoDe(c.pedido)).before_state.video).toEqual({ id: outro.id, capa: 'quadro:5000' });
    const lido = await api.call('GET', `/v1/posts/${c.post}`, { cookie: e.cookie });
    expect(lido.body).toMatchObject({ media: 'video', cover_photo_id: null, cover_offset_ms: 5000 });
    expect(await executar(e)).toBe(1);
    expect((await pedidoDe(c.pedido)).status).toBe('executada');
    const doQuadro = [...ig.conteineres.values()].find((x) => x.endereco.includes(outro.chave))!;
    expect(doQuadro).toMatchObject({ capa: null, quadro: '5000' });
  });

  it('Instagram: a Meta prepara o vídeo: espera de 1 minuto sem contar tentativa; em 5 minutos, não sai; "Tentar de novo" publica o mesmo contêiner', async () => {
    const e = await empresa('Brasa Reels Preparo');
    const video = await videoGuardado(e, armazem);
    ig.situacaoAoCriar = 'IN_PROGRESS';
    const { post, pedido } = await postAprovado(e, video.id);
    expect(await executar(e)).toBe(1);
    let p = await pedidoDe(pedido);
    expect(p).toMatchObject({ status: 'aprovada', status_reason: 'a Meta ainda prepara o vídeo do post', attempts: 0 });
    // Um minuto, sem dobrar.
    const espera = (new Date(p.next_attempt_at!).getTime() - Date.now()) / 1000;
    expect(espera).toBeGreaterThan(50);
    expect(espera).toBeLessThanOrEqual(61);
    expect((await canalDe(post)).preparing_since).not.toBeNull();

    // Na volta, ainda prepara: espera de novo, ainda sem contar.
    await passaAEspera(pedido);
    expect(await executar(e)).toBe(1);
    expect(await pedidoDe(pedido)).toMatchObject({ status: 'aprovada', attempts: 0 });

    // Passaram os 5 minutos: o canal não sai, com a frase do "Tentar de novo".
    await passamOsCincoMinutos(post);
    await passaAEspera(pedido);
    expect(await executar(e)).toBe(1);
    p = await pedidoDe(pedido);
    expect(p.status).toBe('falhou');
    expect(p.status_reason).toContain('não terminou de preparar o vídeo em 5 minutos');
    const canal = await canalDe(post);
    expect(canal).toMatchObject({ status: 'falhou', preparing_since: null });
    expect(canal.error).toContain('Tentar de novo');
    // A Agenda oferece "Tentar de novo", mesmo sem nenhum canal no ar.
    const lido = await api.call('GET', `/v1/posts/${post}`, { cookie: e.cookie });
    expect(lido.body.status).toBe('nao_saiu');
    expect(lido.body.channels[0].retry_until).not.toBeNull();

    // A Meta terminou: "Tentar de novo" publica o MESMO contêiner, uma vez.
    for (const c of ig.conteineres.values()) c.status = 'FINISHED';
    const de = await api.call('POST', `/v1/posts/${post}/retry`, { cookie: e.cookie });
    expect(de.status, JSON.stringify(de.body)).toBe(200);
    await ownerQuery(`update liame.organization set timezone = $2 where id = $1`, [e.tenantId, fusoComAHora(12)]);
    expect(await executar(e)).toBe(1);
    expect(ig.postsDe(e.instagram!.externo)).toHaveLength(1);
    expect(ig.contar('media', 'POST')).toBe(1);
    expect((await canalDe(post)).status).toBe('publicado');
  });

  // ---- A Página ----------------------------------------------------------------------------------------------------

  it('Página: em pé, o Reels (o começo, o envio pelo rupload com o token da Página e o file_url, o fim com a legenda), nos dois canais', async () => {
    const e = await empresa('Brasa Reels Pagina');
    const video = await videoGuardado(e, armazem);
    const { post, pedido } = await postAprovado(e, video.id, { canais: [{ channel: 'instagram', text: LEGENDA }, { channel: 'facebook', text: NA_PAGINA }] });
    expect(await executar(e)).toBe(1);
    expect(await pedidoDe(pedido)).toMatchObject({ status: 'executada', status_reason: null });

    const [v] = ig.videosDe(e.pagina!.externo);
    expect(ig.videosDe(e.pagina!.externo)).toHaveLength(1);
    expect(v).toMatchObject({ tipo: 'reels', description: NA_PAGINA, fase: 'publicado' });
    expect(v!.arquivo?.equals(armazem.objetos.get(video.chave)!)).toBe(true);
    const envio = ig.chamadas.find((c) => c.caminho.startsWith('/rupload/'))!;
    expect(envio.caminho).toBe(`/rupload/video-upload/v26.0/${v!.id}`);
    expect(envio.cabecalhos).toEqual({ authorization: `OAuth ${TOKEN_DA_PAGINA}`, file_url: `memoria://imagens/${video.chave}?valido=590` });
    const fim = ig.chamadas.find((c) => c.corpo?.upload_phase === 'finish')!;
    expect(fim.corpo).toEqual({ upload_phase: 'finish', video_id: v!.id, video_state: 'PUBLISHED', description: NA_PAGINA });
    // O endereço do vídeo vem sem o domínio: o Liame completa.
    expect(await canalDe(post, 'facebook')).toMatchObject({
      status: 'publicado',
      container_id: v!.id,
      external_id: v!.id,
      permalink: `https://www.facebook.com/${e.pagina!.externo}/videos/${v!.id}/`,
      error: null,
    });
    expect((await canalDe(post)).status).toBe('publicado');
    expect(ig.defeitos).toEqual([]);
  });

  it('Página: deitado, o vídeo comum; a resposta que não chega não manda o vídeo de novo', async () => {
    const e = await empresa('Brasa Video Deitado');
    const video = await videoGuardado(e, armazem, { largura: 1920, altura: 1080 });
    ig.perderARespostaDoVideo = true;
    const { post, pedido } = await postAprovado(e, video.id, { canais: [{ channel: 'facebook', text: NA_PAGINA }] });
    expect(await executar(e)).toBe(1);
    // A Meta não respondeu: o pedido espera (a falha passageira), e o vídeo já está na Página.
    expect((await pedidoDe(pedido)).status).toBe('aprovada');
    expect(ig.videosDe(e.pagina!.externo)).toHaveLength(1);

    await passaAEspera(pedido);
    expect(await executar(e)).toBe(1);
    expect((await pedidoDe(pedido)).status).toBe('executada');
    // Achado pela legenda entre os vídeos da Página: nenhum vídeo novo.
    const videos = ig.videosDe(e.pagina!.externo);
    expect(videos).toHaveLength(1);
    expect(videos[0]).toMatchObject({ tipo: 'video', description: NA_PAGINA });
    expect(ig.chamadas.filter((c) => c.metodo === 'POST' && c.caminho.endsWith('/videos'))).toHaveLength(1);
    expect(ig.chamadas.some((c) => c.caminho.endsWith('/video_reels'))).toBe(false);
    expect(await canalDe(post, 'facebook')).toMatchObject({ status: 'publicado', external_id: videos[0]!.id });
  });

  it('Página: o vídeo de outro post, com a mesma legenda, não conta como este (sem tentativa anterior, nada a procurar)', async () => {
    const e = await empresa('Brasa Video Mesma Legenda');
    const video = await videoGuardado(e, armazem, { largura: 1920, altura: 1080 });
    const { post, pedido } = await postAprovado(e, video.id, { canais: [{ channel: 'facebook', text: NA_PAGINA }] });
    // Outro vídeo da Página, com a mesma legenda, publicado depois da criação deste post (o de outro dia, o repetido).
    const antigo = { id: '90000000000001', pagina: e.pagina!.externo, tipo: 'video' as const, description: NA_PAGINA, created_time: `${new Date().toISOString().slice(0, 19)}+0000`, arquivo: null, fase: 'publicado' as const };
    ig.videosNaPagina.unshift(antigo);
    expect(await executar(e)).toBe(1);
    expect((await pedidoDe(pedido)).status).toBe('executada');
    const videos = ig.videosDe(e.pagina!.externo);
    expect(videos).toHaveLength(2);
    expect((await canalDe(post, 'facebook')).external_id).toBe(videos[0]!.id);
    expect(videos[0]!.id).not.toBe(antigo.id);
    expect(ig.chamadas.some((c) => c.metodo === 'GET' && c.caminho.endsWith('/videos'))).toBe(false);
  });

  it('Página: a Meta ainda publica: espera; em 5 minutos, a frase diz que pode aparecer; "Tentar de novo" confere sem mandar de novo', async () => {
    const e = await empresa('Brasa Reels Publica Depois');
    const video = await videoGuardado(e, armazem);
    ig.videoDaPaginaAoTerminar = 'processando';
    const { post, pedido } = await postAprovado(e, video.id, { canais: [{ channel: 'facebook', text: NA_PAGINA }] });
    expect(await executar(e)).toBe(1);
    expect(await pedidoDe(pedido)).toMatchObject({ status: 'aprovada', attempts: 0 });

    await passamOsCincoMinutos(post);
    await passaAEspera(pedido);
    expect(await executar(e)).toBe(1);
    expect((await pedidoDe(pedido)).status).toBe('falhou');
    expect((await canalDe(post, 'facebook')).error).toContain('pode aparecer lá daqui a pouco');

    // A Meta publicou depois: "Tentar de novo" confere o vídeo guardado e marca, sem começar outro Reels.
    ig.videosDe(e.pagina!.externo)[0]!.fase = 'publicado';
    const de = await api.call('POST', `/v1/posts/${post}/retry`, { cookie: e.cookie });
    expect(de.status, JSON.stringify(de.body)).toBe(200);
    await ownerQuery(`update liame.organization set timezone = $2 where id = $1`, [e.tenantId, fusoComAHora(12)]);
    expect(await executar(e)).toBe(1);
    expect((await canalDe(post, 'facebook')).status).toBe('publicado');
    expect(ig.chamadas.filter((c) => c.corpo?.upload_phase === 'start')).toHaveLength(1);
    expect(ig.videosDe(e.pagina!.externo)).toHaveLength(1);
  });

  it('Página: o vídeo que a Página recusa (a proporção) termina com a frase e pede um post novo', async () => {
    const e = await empresa('Brasa Reels Recusado');
    const video = await videoGuardado(e, armazem);
    ig.recusaDoReels = { codigo: 1363040, mensagem: 'Unsupported aspect ratio' };
    const { post, pedido } = await postAprovado(e, video.id, { canais: [{ channel: 'facebook', text: NA_PAGINA }] });
    expect(await executar(e)).toBe(1);
    expect((await pedidoDe(pedido)).status).toBe('falhou');
    expect((await canalDe(post, 'facebook')).error).toContain('não aceitou o vídeo deste post');
    const lido = await api.call('GET', `/v1/posts/${post}`, { cookie: e.cookie });
    expect(lido.body.channels[0].retry_until).toBeNull();
  });

  it('Página: o limite de 30 vídeos do Liame por Página em 24 horas faz o pedido esperar, sem começar o Reels', async () => {
    const e = await empresa('Brasa Reels Limite');
    const video = await videoGuardado(e, armazem);
    // 30 vídeos publicados pelo Liame nesta Página nas últimas 24 horas.
    await ownerQuery(
      `with p as (
         insert into liame.social_post (id, tenant_id, brand_id, media, photo_id, photo_sha256, publish_at, created_by)
         select gen_random_uuid(), $1, $2, 'video', $3, null, now() - interval '2 hours', null from generate_series(1, 30)
         returning id)
       insert into liame.social_post_channel (id, tenant_id, post_id, channel, connected_account_id, body, status, published_at)
       select gen_random_uuid(), $1, p.id, 'facebook', $4, 'antigo', 'publicado', now() - interval '1 hour' from p`,
      [e.tenantId, e.brandId, video.id, e.pagina!.id],
    );
    const { pedido } = await postAprovado(e, video.id, { canais: [{ channel: 'facebook', text: NA_PAGINA }] });
    expect(await executar(e)).toBe(1);
    expect(await pedidoDe(pedido)).toMatchObject({ status: 'aprovada', attempts: 1 });
    expect(ig.chamadas.some((c) => c.caminho.endsWith('/video_reels'))).toBe(false);
  });

  // ---- Na hora de sair ---------------------------------------------------------------------------------------------

  it('na hora de sair, o vídeo apagado e a capa trocada depois da aprovação não saem, sem chamar a rede', async () => {
    const e = await empresa('Brasa Video Mudou');
    const apagado = await videoGuardado(e, armazem);
    const a = await postAprovado(e, apagado.id);
    await ownerQuery(`update liame.brand_photo set removed_at = now() where id = $1`, [apagado.id]);
    const trocado = await videoGuardado(e, armazem);
    const b = await postAprovado(e, trocado.id);
    // A capa gravada de novo (a versão sobe), como o PUT da capa faz.
    await ownerQuery(`update liame.brand_photo set cover_version = cover_version + 1 where id = $1`, [trocado.id]);
    await executar(e);
    const pa = await pedidoDe(a.pedido);
    expect(pa.status).toBe('falhou');
    expect(pa.status_reason).toContain('O vídeo deste post foi apagado');
    const pb = await pedidoDe(b.pedido);
    expect(pb.status).toBe('falhou');
    expect(pb.status_reason).toContain('A capa do vídeo mudou depois da aprovação');
    expect(ig.chamadas).toEqual([]);
  });

  it('a capa gravada pela rota sobe a versão do vídeo (o post que prendeu a de antes não sai)', async () => {
    const e = await empresa('Brasa Video Capa Rota');
    await ligarFlagDaEmpresa(api, 'fotos', e.tenantId, true);
    const video = await videoGuardado(e, armazem);
    const jpeg = await sharp({ create: { width: 360, height: 640, channels: 3, background: { r: 10, g: 200, b: 90 } } }).jpeg().toBuffer();
    const r = await api.call('PUT', `/v1/brand-photos/${video.id}/cover`, { cookie: e.cookie, raw: { data: jpeg, type: 'image/jpeg' } });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const [linha] = await ownerQuery<{ cover_version: number }>(`select cover_version from liame.brand_photo where id = $1`, [video.id]);
    expect(linha!.cover_version).toBe(2);
  });
});
