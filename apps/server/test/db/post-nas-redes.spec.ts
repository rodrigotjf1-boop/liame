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
import { quandoSai } from '../../src/posts/post-plano.js';
import { VaultService } from '../../src/vault/vault.service.js';
import { ActionExecutor } from '../../src/worker/action-executor.js';
import { ownerQuery, resetIpRateLimits, startApi, type TestApi } from '../helpers/api.js';
import { InstagramDeMentira, SEGREDO_DO_APP, TOKEN_DO_INSTAGRAM } from '../helpers/instagram-de-mentira.js';
import { type EmpresaComCanais, empresaComCanais, fotoGuardada } from '../helpers/posts-semeados.js';
import { hasDb } from './env.js';

// A6 · Z5b, partes 2 e 3: o post aprovado sai no Instagram e na Página do Facebook, na hora marcada, contra uma Meta de
// mentira que segue as páginas oficiais lidas em 29/10/2026 (`helpers/instagram-de-mentira.ts`). O que se prova aqui:
//   - na hora, o post sai UMA vez (A6-9): o contêiner com a foto (a inteira, ou o recorte na posição aprovada, D-A6-21)
//     e a legenda, a publicação e o endereço do post; o canal guarda o post, e o recorte sai do armazenamento;
//   - o contêiner que ainda prepara a foto: o pedido espera um minuto e, na volta, publica o MESMO contêiner;
//   - a resposta da publicação que não chega: a volta seguinte acha o post entre os recentes e não publica de novo;
//   - o limite de posts do dia (A6-11): o pedido espera, sem criar contêiner;
//   - as recusas definitivas (a foto que o Instagram não aceita, a autorização e a permissão recusadas, o arquivo da foto
//     que sumiu) terminam o pedido com a frase em português, e o canal diz que não saiu;
//   - na hora de sair, o que mudou desde a aprovação não sai (A6-10: a foto apagada), sem chamar a rede;
//   - fora das 8h às 22h no fuso da empresa (D-A6-33), o pedido volta para a fila com a hora em que pode sair, sem contar
//     tentativa e sem chamar a rede;
//   - a Página (parte 3): o token dela pela lista das Páginas da autorização, a foto inteira com a legenda e o endereço do
//     post; cada canal sai por conta própria (sem a tarefa de publicar na Página, o Instagram sai e o post fica "em
//     parte"); a resposta da foto que não chega (a volta seguinte acha a foto e não publica de novo; sem poder ler as
//     fotos, não arrisca); a Página que a autorização não alcança; a trava da conta da Página; e o post só com a Página.

const LEGENDA = 'Hoje tem smash duplo na Casa Brasa. Peça pelo link da bio.';
const FUSO_DO_PEDIDO = 'America/Sao_Paulo';
/** O post nos dois canais, cada um com o texto dele. */
const DOIS_CANAIS = [
  { channel: 'instagram', text: LEGENDA },
  { channel: 'facebook', text: 'Hoje tem smash duplo na Casa Brasa. Peça pelo link: liame.link/abc' },
];

/** `AAAA-MM-DD` de hoje mais `n` dias, em São Paulo. */
const diaEmSaoPaulo = (n: number): string =>
  new Intl.DateTimeFormat('en-CA', { timeZone: FUSO_DO_PEDIDO, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(Date.now() + n * 86_400_000));

/**
 * Um fuso em que agora é `hora` no relógio (`Etc/GMT±N`): a janela das 8h às 22h vale a qualquer hora do dia em que o
 * teste roda. O sinal dos fusos `Etc` é o contrário do de costume (`Etc/GMT-3` é UTC+3).
 */
function fusoComAHora(hora: number): string {
  let diferenca = (hora - new Date().getUTCHours()) % 24;
  if (diferenca < 0) diferenca += 24;
  if (diferenca > 12) diferenca -= 24;
  return diferenca === 0 ? 'Etc/GMT' : `Etc/GMT${diferenca > 0 ? '-' : '+'}${Math.abs(diferenca)}`;
}

/** A cor de um ponto da imagem (para ver qual parte da foto foi ao Instagram). */
async function corNoPonto(imagem: Buffer, x: number, y: number): Promise<{ r: number; g: number; b: number }> {
  const px = await sharp(imagem).extract({ left: x, top: y, width: 1, height: 1 }).raw().toBuffer();
  return { r: px[0]!, g: px[1]!, b: px[2]! };
}

describe.skipIf(!hasDb)('o post no Instagram e na Página (A6 · Z5b, partes 2 e 3)', () => {
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
    // O Instagram busca a imagem pelo endereço que o Liame manda: no armazenamento dos testes, `memoria://imagens/<chave>`.
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
      // A trava da conta do outro canal, como o provedor da subida a liga (`escrita-posts.provider.ts`).
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

  const empresa = (nome: string, o: { pagina?: boolean; instagram?: boolean } = {}) =>
    empresaComCanais(api, nome, { pagina: o.pagina ?? false, instagram: o.instagram ?? true, token: TOKEN_DO_INSTAGRAM });
  /** A empresa com a Página que a autorização alcança, com as tarefas de quem autorizou (por padrão, publicar e moderar). */
  const comPagina = async (nome: string, tarefas = ['CREATE_CONTENT', 'MODERATE'], o: { instagram?: boolean } = {}) => {
    const e = await empresa(nome, { pagina: true, ...o });
    ig.paginas.set(e.pagina!.externo, tarefas);
    return e;
  };
  const pedidoDe = async (id: string) =>
    (
      await ownerQuery<{ status: string; status_reason: string | null; attempts: number; next_attempt_at: Date | null; plan_hash: string; before_state: Record<string, unknown> }>(
        `select status, status_reason, attempts, next_attempt_at, plan_hash, before_state from liame.action_request where id = $1`,
        [id],
      )
    )[0]!;
  const canalDe = async (post: string, canal = 'instagram') =>
    (
      await ownerQuery<{ status: string; container_id: string | null; external_id: string | null; permalink: string | null; error: string | null; published_at: Date | null }>(
        `select status, container_id, external_id, permalink, error, published_at from liame.social_post_channel where post_id = $1 and channel = $2`,
        [post, canal],
      )
    )[0]!;
  const executar = (e: EmpresaComCanais) => executor.executeBatch(20, { tenantIds: [e.tenantId] });
  /** A hora marcada chega: o pedido aprovado é de um minuto atrás, e o fuso da empresa tem `hora` agora no relógio. */
  const chegaAHora = async (e: EmpresaComCanais, pedido: string, hora = 12) => {
    await ownerQuery(`update liame.organization set timezone = $2 where id = $1`, [e.tenantId, fusoComAHora(hora)]);
    await ownerQuery(`update liame.action_request set next_attempt_at = now() - interval '1 second', before_state = jsonb_set(before_state, '{hora}', to_jsonb($2::text)) where id = $1`, [
      pedido,
      new Date(Date.now() - 60_000).toISOString(),
    ]);
  };
  /** Volta a vez do pedido adiado (a espera de um minuto, ou da cota, passou). */
  const passaAEspera = (pedido: string) => ownerQuery(`update liame.action_request set next_attempt_at = now() - interval '1 second' where id = $1`, [pedido]);

  /** O novo post (pela API, como a tela), aprovado com o código do app e na hora de sair. */
  async function postAprovado(
    e: EmpresaComCanais,
    foto: string,
    o: { canais?: Array<{ channel: string; text: string }>; crop?: number; hora?: number } = {},
  ): Promise<{ post: string; pedido: string }> {
    // O pedido nasce no fuso de São Paulo (amanhã, 19h); a hora chega depois, pelo `chegaAHora`.
    await ownerQuery(`update liame.organization set timezone = $2 where id = $1`, [e.tenantId, FUSO_DO_PEDIDO]);
    const r = await api.call('POST', '/v1/posts', {
      cookie: e.cookie,
      body: {
        brand_id: e.brandId,
        photo_id: foto,
        publish_at: `${diaEmSaoPaulo(1)}T19:00:00-03:00`,
        channels: o.canais ?? [{ channel: 'instagram', text: LEGENDA }],
        ...(o.crop === undefined ? {} : { crop_pos: o.crop }),
      },
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const pedido = r.body.action_id as string;
    await ownerQuery(`update liame.app_user set totp_last_step = null where id = $1`, [e.userId]);
    await ownerQuery(`delete from liame.rate_limit where key = $1`, [`segundo-fator:${e.userId}`]);
    const aprovado = await api.call('POST', `/v1/actions/${pedido}/approve`, {
      cookie: e.cookie,
      body: { plan_hash: (await pedidoDe(pedido)).plan_hash, code: totpCode(e.secret, currentStep()) },
    });
    expect(aprovado.status, JSON.stringify(aprovado.body)).toBe(200);
    await chegaAHora(e, pedido, o.hora);
    return { post: r.body.id as string, pedido };
  }

  it('na hora, o post sai uma vez: o contêiner com a foto inteira e a legenda, a publicação e o endereço; a Agenda diz publicado', async () => {
    const e = await empresa('Brasa IG Publica');
    // 4:3 deitada cabe no Instagram: vai a própria foto, sem recorte.
    const foto = await fotoGuardada(e, armazem, { largura: 1600, altura: 1200 });
    const { post, pedido } = await postAprovado(e, foto.id);
    expect(await executar(e)).toBe(1);

    expect(await pedidoDe(pedido)).toMatchObject({ status: 'executada', status_reason: null });
    const publicados = ig.postsDe(e.instagram!.externo);
    expect(publicados).toHaveLength(1);
    expect(publicados[0]!.caption).toBe(LEGENDA);
    // A imagem que o Instagram buscou é o arquivo da foto, pelo endereço assinado dela.
    expect(publicados[0]!.imagem?.equals(armazem.objetos.get(foto.chave)!)).toBe(true);
    expect(ig.conteineres.get(publicados[0]!.conteiner)!.endereco).toBe(`memoria://imagens/${foto.chave}?valido=300`);
    expect(await canalDe(post)).toMatchObject({ status: 'publicado', external_id: publicados[0]!.id, permalink: publicados[0]!.permalink, error: null });
    expect((await canalDe(post)).published_at).not.toBeNull();
    // A ordem: os recentes (já saiu?), o limite do dia, o contêiner, a situação dele, a publicação e o endereço.
    expect([ig.contar('media', 'GET'), ig.contar('content_publishing_limit'), ig.contar('media', 'POST'), ig.contar('status_code'), ig.contar('media_publish')]).toEqual([1, 1, 1, 1, 1]);
    // O token foi no cabeçalho, com a prova do segredo do app; nunca na URL.
    expect(ig.defeitos).toEqual([]);

    const r = await api.call('GET', `/v1/posts/${post}`, { cookie: e.cookie });
    expect(r.body.status).toBe('publicado');
    expect(r.body.channels[0]).toMatchObject({ channel: 'instagram', status: 'publicado', permalink: publicados[0]!.permalink, error: null });
    // Nada mais a fazer: o executor não pega o pedido de novo.
    expect(await executar(e)).toBe(0);
  });

  it('a foto que não cabe vai recortada na posição aprovada (o topo), e o recorte sai do armazenamento depois', async () => {
    const e = await empresa('Brasa IG Recorte');
    // 2:3 em pé é alta demais para o Instagram (o mínimo é 4:5): a pessoa escolheu o topo.
    const foto = await fotoGuardada(e, armazem, { largura: 1200, altura: 1800 });
    const { post, pedido } = await postAprovado(e, foto.id, { crop: 0 });
    expect(await executar(e)).toBe(1);
    expect((await pedidoDe(pedido)).status).toBe('executada');

    const [publicado] = ig.postsDe(e.instagram!.externo);
    const medidas = await sharp(publicado!.imagem!).metadata();
    expect([medidas.width, medidas.height]).toEqual([1200, 1500]);
    // O topo da foto (a faixa vermelha) está lá; a faixa azul do pé ficou de fora.
    expect((await corNoPonto(publicado!.imagem!, 600, 5)).r).toBeGreaterThan(180);
    // No pé do recorte, o fundo cinza (a faixa azul tem pouco vermelho).
    expect((await corNoPonto(publicado!.imagem!, 600, 1495)).r).toBeGreaterThan(180);
    // O endereço era o do recorte, ao lado das fotos da marca; publicado o post, o arquivo e a chave saem.
    expect(ig.conteineres.get(publicado!.conteiner)!.endereco).toBe(`memoria://imagens/t/${e.tenantId}/b/${e.brandId}/post/${post}-instagram.jpg?valido=300`);
    expect([...armazem.objetos.keys()].filter((k) => k.includes('/post/'))).toEqual([]);
    expect((await ownerQuery<{ instagram_object_key: string | null }>(`select instagram_object_key from liame.social_post where id = $1`, [post]))[0]!.instagram_object_key).toBeNull();
  });

  it('o contêiner que ainda prepara a foto: o pedido espera um minuto e, na volta, publica o MESMO contêiner', async () => {
    const e = await empresa('Brasa IG Preparo');
    const foto = await fotoGuardada(e, armazem, { largura: 1600, altura: 1200 });
    const { post, pedido } = await postAprovado(e, foto.id);
    ig.situacaoAoCriar = 'IN_PROGRESS';
    expect(await executar(e)).toBe(1);

    const adiado = await pedidoDe(pedido);
    expect(adiado).toMatchObject({ status: 'aprovada', attempts: 1, status_reason: 'o Instagram ainda prepara a foto do post' });
    expect(adiado.next_attempt_at!.getTime() - Date.now()).toBeGreaterThan(50_000);
    const preparando = await canalDe(post);
    expect(preparando.status).toBe('publicando');
    expect(preparando.container_id).not.toBeNull();
    expect(ig.contar('media_publish')).toBe(0);

    // Antes de ficar pronto, a volta só confere a situação: nem contêiner novo, nem publicação.
    await passaAEspera(pedido);
    expect(await executar(e)).toBe(1);
    expect(await pedidoDe(pedido)).toMatchObject({ status: 'aprovada', attempts: 2 });
    expect([ig.contar('media', 'POST'), ig.contar('media_publish')]).toEqual([1, 0]);

    ig.conteineres.get(preparando.container_id!)!.status = 'FINISHED';
    await passaAEspera(pedido);
    expect(await executar(e)).toBe(1);
    expect((await pedidoDe(pedido)).status).toBe('executada');
    expect([ig.contar('media', 'POST'), ig.contar('media_publish')]).toEqual([1, 1]);
    expect(ig.postsDe(e.instagram!.externo).map((p) => p.conteiner)).toEqual([preparando.container_id]);
    expect((await canalDe(post)).status).toBe('publicado');
  });

  it('a resposta da publicação que não chega: a volta seguinte acha o post entre os recentes e não publica de novo (A6-9)', async () => {
    const e = await empresa('Brasa IG Sem Resposta');
    const foto = await fotoGuardada(e, armazem, { largura: 1600, altura: 1200 });
    const { post, pedido } = await postAprovado(e, foto.id);
    ig.perderARespostaDaPublicacao = true;
    expect(await executar(e)).toBe(1);
    // O Instagram publicou, mas o Liame não soube: o pedido espera, sem dar o post como feito.
    expect(await pedidoDe(pedido)).toMatchObject({ status: 'aprovada', attempts: 1, status_reason: 'a Meta não respondeu' });
    expect((await canalDe(post)).status).toBe('publicando');
    expect(ig.postsDe(e.instagram!.externo)).toHaveLength(1);

    await passaAEspera(pedido);
    expect(await executar(e)).toBe(1);
    expect((await pedidoDe(pedido)).status).toBe('executada');
    const publicados = ig.postsDe(e.instagram!.externo);
    expect(publicados).toHaveLength(1);
    expect(ig.contar('media_publish')).toBe(1);
    expect(await canalDe(post)).toMatchObject({ status: 'publicado', external_id: publicados[0]!.id, permalink: publicados[0]!.permalink });
  });

  it('o limite de posts do dia (A6-11): o pedido espera, sem criar contêiner', async () => {
    const e = await empresa('Brasa IG Cota');
    const foto = await fotoGuardada(e, armazem, { largura: 1600, altura: 1200 });
    const { post, pedido } = await postAprovado(e, foto.id);
    ig.cota = { usados: 50, total: 50 };
    expect(await executar(e)).toBe(1);
    const adiado = await pedidoDe(pedido);
    expect(adiado).toMatchObject({ status: 'aprovada', attempts: 1, status_reason: 'o Instagram chegou ao limite de posts pela API nas últimas 24 horas' });
    expect(adiado.next_attempt_at!.getTime() - Date.now()).toBeGreaterThan(59 * 60_000);
    expect(ig.contar('media', 'POST')).toBe(0);
    expect((await canalDe(post)).status).toBe('aguardando');
  });

  it('as recusas definitivas terminam o pedido com a frase em português, e o canal diz que não saiu', async () => {
    const e = await empresa('Brasa IG Recusas');
    const foto = await fotoGuardada(e, armazem, { largura: 1600, altura: 1200 });
    const casos: Array<[string, () => void, string]> = [
      ['a foto que o Instagram não aceita', () => (ig.situacaoAoCriar = 'ERROR'), 'O Instagram não aceitou a foto deste post.'],
      ['a autorização recusada', () => ig.falhas.set('media', [{ status: 401, corpo: { error: { message: 'Error validating access token', code: 190 } } }]), 'Conecte a Meta de novo'],
      ['a permissão recusada', () => ig.falhas.set('media', [{ status: 403, corpo: { error: { message: 'Permission denied', code: 10 } } }]), 'a permissão de publicar não está concedida'],
    ];
    for (const [caso, combinar, frase] of casos) {
      ig.normalizar();
      const { post, pedido } = await postAprovado(e, foto.id, { canais: [{ channel: 'instagram', text: `${LEGENDA} (${caso})` }] });
      combinar();
      expect(await executar(e), caso).toBe(1);
      const p = await pedidoDe(pedido);
      expect(p.status, caso).toBe('falhou');
      expect(p.status_reason, caso).toContain(frase);
      const c = await canalDe(post);
      expect([c.status, c.error?.includes(frase)], caso).toEqual(['falhou', true]);
      expect((await api.call('GET', `/v1/posts/${post}`, { cookie: e.cookie })).body.status, caso).toBe('nao_saiu');
    }
    expect(ig.postsDe(e.instagram!.externo)).toHaveLength(0);
  });

  it('o arquivo da foto que sumiu do armazenamento: o recorte não sai, e o pedido termina com o motivo', async () => {
    const e = await empresa('Brasa IG Sem Arquivo');
    const foto = await fotoGuardada(e, armazem, { largura: 1200, altura: 1800 });
    const { post, pedido } = await postAprovado(e, foto.id, { crop: 50 });
    armazem.objetos.delete(foto.chave);
    expect(await executar(e)).toBe(1);
    expect((await pedidoDe(pedido)).status_reason).toContain('O arquivo da foto deste post não está mais guardado no Liame.');
    expect((await canalDe(post)).status).toBe('falhou');
    expect(ig.contar('media', 'POST')).toBe(0);
  });

  it('na hora de sair, a foto apagada depois da aprovação não sai (A6-10), sem chamar a rede', async () => {
    const e = await comPagina('Brasa IG Na Hora');
    const foto = await fotoGuardada(e, armazem, { largura: 1600, altura: 1200 });
    const apagada = await postAprovado(e, foto.id, { canais: DOIS_CANAIS });
    await ownerQuery(`update liame.brand_photo set removed_at = now() where id = $1`, [foto.id]);
    expect(await executar(e)).toBe(1);
    expect(await pedidoDe(apagada.pedido)).toMatchObject({ status: 'falhou', status_reason: 'A foto deste post foi apagada nas Fotos: o post não sai. Faça um post novo com outra foto.' });
    expect([(await canalDe(apagada.post)).status, (await canalDe(apagada.post, 'facebook')).status]).toEqual(['aguardando', 'aguardando']);
    expect(ig.chamadas).toEqual([]);
  });

  it('o post nos dois canais: o recorte no Instagram e a foto inteira na Página, com o token da Página e o endereço do post', async () => {
    const e = await comPagina('Brasa Dois Canais');
    const foto = await fotoGuardada(e, armazem, { largura: 1200, altura: 1800 });
    const { post, pedido } = await postAprovado(e, foto.id, { canais: DOIS_CANAIS, crop: 0 });
    expect(await executar(e)).toBe(1);
    expect(await pedidoDe(pedido)).toMatchObject({ status: 'executada', status_reason: null });

    const [noInstagram] = ig.postsDe(e.instagram!.externo);
    expect((await sharp(noInstagram!.imagem!).metadata()).height).toBe(1500);
    const fotos = ig.fotosDe(e.pagina!.externo);
    expect(fotos).toHaveLength(1);
    // A Página recebe a foto inteira (ela aceita qualquer proporção) e o texto dela.
    expect(fotos[0]!.imagem?.equals(armazem.objetos.get(foto.chave)!)).toBe(true);
    expect(fotos[0]!.name).toBe(DOIS_CANAIS[1]!.text);
    expect(await canalDe(post, 'facebook')).toMatchObject({
      status: 'publicado',
      external_id: fotos[0]!.page_story_id,
      permalink: `https://www.facebook.com/${e.pagina!.externo}/posts/${fotos[0]!.page_story_id.split('_')[1]}`,
      error: null,
    });
    // O token da Página veio da lista das Páginas da autorização, uma vez; os dois tokens foram no cabeçalho, com a prova.
    expect(ig.contar('accounts')).toBe(1);
    expect(ig.defeitos).toEqual([]);
    expect((await api.call('GET', `/v1/posts/${post}`, { cookie: e.cookie })).body.status).toBe('publicado');
  });

  it('cada canal por conta própria: sem a tarefa de publicar na Página, o Instagram sai, a Página não, e o post fica "em parte"', async () => {
    const e = await comPagina('Brasa Em Parte', ['ANALYZE', 'ADVERTISE']);
    const foto = await fotoGuardada(e, armazem, { largura: 1600, altura: 1200 });
    const { post, pedido } = await postAprovado(e, foto.id, { canais: DOIS_CANAIS });
    expect(await executar(e)).toBe(1);
    const p = await pedidoDe(pedido);
    expect(p.status).toBe('falhou');
    expect(p.status_reason).toMatch(/^O post saiu no Instagram\. A Meta não deixou o Liame publicar nesta Página/);
    expect([(await canalDe(post)).status, (await canalDe(post, 'facebook')).status]).toEqual(['publicado', 'falhou']);
    expect(ig.fotosDe(e.pagina!.externo)).toHaveLength(0);
    expect((await api.call('GET', `/v1/posts/${post}`, { cookie: e.cookie })).body.status).toBe('em_parte');
  });

  it('a resposta da foto que não chega: a volta seguinte acha a foto na Página e não publica de novo; sem poder ler as fotos, não arrisca', async () => {
    // Com a leitura das fotos: a volta seguinte acha a foto e dá o canal como publicado.
    const e = await comPagina('Brasa Pagina Sem Resposta');
    const foto = await fotoGuardada(e, armazem, { largura: 1600, altura: 1200 });
    const a = await postAprovado(e, foto.id, { canais: DOIS_CANAIS });
    ig.perderARespostaDaFoto = true;
    expect(await executar(e)).toBe(1);
    // O Instagram saiu na mesma volta; a Página publicou, mas o Liame não soube: o pedido espera.
    expect(await pedidoDe(a.pedido)).toMatchObject({ status: 'aprovada', attempts: 1, status_reason: 'a Meta não respondeu' });
    expect([(await canalDe(a.post)).status, (await canalDe(a.post, 'facebook')).status]).toEqual(['publicado', 'publicando']);
    await passaAEspera(a.pedido);
    expect(await executar(e)).toBe(1);
    expect((await pedidoDe(a.pedido)).status).toBe('executada');
    const fotos = ig.fotosDe(e.pagina!.externo);
    expect(fotos).toHaveLength(1);
    expect(ig.postsDe(e.instagram!.externo)).toHaveLength(1);
    expect(await canalDe(a.post, 'facebook')).toMatchObject({ status: 'publicado', external_id: fotos[0]!.page_story_id, permalink: fotos[0]!.link });

    // Sem a tarefa de moderar (ler as fotos da Página): a primeira tentativa publica; depois de uma sem resposta, não arrisca.
    const s = await comPagina('Brasa Pagina Sem Moderar', ['CREATE_CONTENT']);
    const outra = await fotoGuardada(s, armazem, { largura: 1600, altura: 1200 });
    const b = await postAprovado(s, outra.id, { canais: [{ channel: 'facebook', text: `${LEGENDA} Só na Página.` }] });
    ig.perderARespostaDaFoto = true;
    expect(await executar(s)).toBe(1);
    expect((await pedidoDe(b.pedido)).status).toBe('aprovada');
    await passaAEspera(b.pedido);
    expect(await executar(s)).toBe(1);
    const pb = await pedidoDe(b.pedido);
    expect(pb.status).toBe('falhou');
    expect(pb.status_reason).toContain('Para não publicar duas vezes, o Liame não tentou de novo');
    expect(ig.fotosDe(s.pagina!.externo)).toHaveLength(1);
  });

  it('a Página que a autorização não alcança mais, e a trava ligada para a conta da Página: o Instagram sai, a Página não', async () => {
    const fora = await comPagina('Brasa Pagina Fora');
    ig.paginas.delete(fora.pagina!.externo);
    const f1 = await fotoGuardada(fora, armazem, { largura: 1600, altura: 1200 });
    const a = await postAprovado(fora, f1.id, { canais: DOIS_CANAIS });
    expect(await executar(fora)).toBe(1);
    expect((await pedidoDe(a.pedido)).status_reason).toContain('A autorização da Meta não alcança mais esta Página.');
    expect([(await canalDe(a.post)).status, (await canalDe(a.post, 'facebook')).status]).toEqual(['publicado', 'falhou']);

    const travada = await comPagina('Brasa Pagina Travada');
    await ownerQuery(`insert into liame.kill_switch (id, level, tenant_id, provider, account_id, reason) values (gen_random_uuid(), 'account', $1, 'facebook_page', $2, 'teste: Página parada')`, [
      travada.tenantId,
      travada.pagina!.id,
    ]);
    const f2 = await fotoGuardada(travada, armazem, { largura: 1600, altura: 1200 });
    const b = await postAprovado(travada, f2.id, { canais: DOIS_CANAIS });
    const antes = ig.contar('accounts');
    expect(await executar(travada)).toBe(1);
    expect((await pedidoDe(b.pedido)).status_reason).toContain('Uma trava está ligada (account: teste: Página parada).');
    expect([(await canalDe(b.post)).status, (await canalDe(b.post, 'facebook')).status]).toEqual(['publicado', 'falhou']);
    // A Página travada nem chegou a ser chamada.
    expect(ig.contar('accounts')).toBe(antes);
    expect(ig.fotosDe(travada.pagina!.externo)).toHaveLength(0);
  });

  it('o post só com a Página: o pedido é pela conta da Página, e a foto sai nela', async () => {
    const e = await comPagina('Brasa So Pagina', undefined, { instagram: false });
    const foto = await fotoGuardada(e, armazem, { largura: 2048, altura: 800 });
    const { post, pedido } = await postAprovado(e, foto.id, { canais: [{ channel: 'facebook', text: `${LEGENDA} Só na Página.` }] });
    expect((await ownerQuery<{ provider: string; account_id: string }>(`select provider, account_id from liame.action_request where id = $1`, [pedido]))[0]).toEqual({
      provider: 'facebook_page',
      account_id: e.pagina!.id,
    });
    expect(await executar(e)).toBe(1);
    expect((await pedidoDe(pedido)).status).toBe('executada');
    expect((await canalDe(post, 'facebook')).status).toBe('publicado');
    // A foto deitada de 2,56:1 vai inteira à Página (o recorte é só do Instagram).
    expect(ig.fotosDe(e.pagina!.externo)[0]!.imagem?.equals(armazem.objetos.get(foto.chave)!)).toBe(true);
    expect([...armazem.objetos.keys()].filter((k) => k.includes('/post/'))).toEqual([]);
  });

  it('fora das 8h às 22h no fuso da empresa, o pedido volta para a fila com a hora em que pode sair, sem contar tentativa e sem chamar a rede', async () => {
    const e = await empresa('Brasa IG Janela');
    const foto = await fotoGuardada(e, armazem, { largura: 1600, altura: 1200 });
    const { post, pedido } = await postAprovado(e, foto.id, { hora: 23 });
    expect(await executar(e)).toBe(1);
    const p = await pedidoDe(pedido);
    expect(p).toMatchObject({ status: 'aprovada', attempts: 0, status_reason: 'espera a hora em que pode sair' });
    // As 8h do dia seguinte no fuso da empresa (agora são 23h lá): de 8 a 10 horas daqui.
    const esperado = quandoSai(String(p.before_state.hora), new Date(), fusoComAHora(23))!;
    expect(Math.abs(p.next_attempt_at!.getTime() - esperado.getTime())).toBeLessThan(120_000);
    expect(p.next_attempt_at!.getTime() - Date.now()).toBeGreaterThan(8 * 3_600_000);
    expect(ig.chamadas).toEqual([]);
    expect((await canalDe(post)).status).toBe('aguardando');
    expect(await ownerQuery(`select 1 from liame.audit_event where resource_id = $1 and action = 'acao.esperar_hora'`, [pedido])).toHaveLength(1);
  });
});
