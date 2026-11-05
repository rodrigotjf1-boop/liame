import { BrandPhoto, BrandPhotosResponse, BrandVideoUploadResponse } from '@liame/contracts';
import { createDatabase, type Database } from '@liame/database';
import sharp from 'sharp';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { chaveDaMiniatura, chaveDoVideo } from '../../src/fotos/conferencia.js';
import { ARMAZEM_DE_IMAGENS, type ArmazemNaMemoria } from '../../src/imagens/armazem.js';
import { ENVIO_ABANDONADO_MIN, ENVIO_DO_VIDEO_ABANDONADO_MIN, FotosLoop } from '../../src/worker/fotos-loop.js';
import { enableMfa, ownerQuery, resetIpRateLimits, signupAndLogin, startApi, type TestApi } from '../helpers/api.js';
import { ligarFlagDaEmpresa } from '../helpers/meta-de-mentira.js';
import { videoDeMentira } from '../helpers/video-de-mentira.js';
import { APP_URL, hasDb } from './env.js';

// A6 · Z10, parte 1 (D-A6-67, D-A6-68, D-A6-70; P37): o vídeo nas Fotos, pelo caminho inteiro. A pessoa pede o envio, o
// navegador manda o arquivo direto ao armazenamento (aqui, o da memória: `chegou` faz o papel do navegador), o Liame
// confere o cabeçalho e o vídeo fica pronto, com a auditoria. Depois: a capa (um quadro do vídeo), as recusas com o
// motivo da tela, a leitura que falha, a outra empresa, o post que não aceita o vídeo no lugar da foto (o post com vídeo
// é a parte 3), a limpeza com o prazo do vídeo (2 horas) e as restrições novas da tabela (V119).

type Empresa = { cookie: string; tenantId: string; brandId: string };

function jpeg(largura: number, altura: number): Promise<Buffer> {
  return sharp({ create: { width: largura, height: altura, channels: 3, background: { r: 201, g: 139, b: 78 } } }).jpeg({ quality: 80 }).toBuffer();
}

describe.skipIf(!hasDb)('O vídeo nas Fotos: o envio direto, a conferência, a capa e a limpeza (A6 · Z10, parte 1)', () => {
  let api: TestApi;
  let database: Database;
  let armazem: ArmazemNaMemoria;
  let loop: FotosLoop;

  beforeAll(async () => {
    api = await startApi();
    await resetIpRateLimits();
    database = createDatabase({ connectionString: APP_URL, max: 4, applicationName: 'liame-test' });
    armazem = api.app.get(ARMAZEM_DE_IMAGENS) as ArmazemNaMemoria;
    loop = new FotosLoop(database, armazem);
  }, 120_000);
  beforeEach(async () => {
    await resetIpRateLimits();
    armazem.falhar = {};
    vi.restoreAllMocks();
  });
  afterAll(async () => {
    await api?.close();
    await database?.close();
  });

  async function empresa(nome: string, { videos = true } = {}): Promise<Empresa> {
    const s = await signupAndLogin(api, undefined, nome);
    await enableMfa(api, s.cookie);
    const tenantId = s.me.active_organization_id as string;
    const marcas = await api.call('GET', '/v1/brands', { cookie: s.cookie });
    const brandId = marcas.body.items[0].id as string;
    await ligarFlagDaEmpresa(api, 'fotos', tenantId, true);
    if (videos) await ligarFlagDaEmpresa(api, 'videos', tenantId, true);
    return { cookie: s.cookie, tenantId, brandId };
  }

  function pedir(e: Empresa, bytes = 50_000, media_type = 'video/mp4', brandId = e.brandId) {
    return api.call('POST', '/v1/brand-photos/videos', { cookie: e.cookie, body: { brand_id: brandId, media_type, bytes } });
  }

  const concluir = (e: Empresa, id: string) => api.call('POST', `/v1/brand-photos/${id}/video`, { cookie: e.cookie });
  const capa = (e: Empresa, id: string, data: Uint8Array, type = 'image/jpeg') => api.call('PUT', `/v1/brand-photos/${id}/cover`, { cookie: e.cookie, raw: { data, type } });

  async function lista(e: Empresa): Promise<BrandPhotosResponse> {
    const r = await api.call('GET', `/v1/brand-photos?brand_id=${e.brandId}`, { cookie: e.cookie });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    return BrandPhotosResponse.parse(r.body);
  }

  /** O envio inteiro: pede, o arquivo "chega" (como o navegador faria) e o Liame confere. */
  async function enviarVideo(e: Empresa, arquivo: Buffer, media_type: 'video/mp4' | 'video/quicktime' = 'video/mp4') {
    const p = await pedir(e, arquivo.length, media_type);
    expect(p.status, JSON.stringify(p.body)).toBe(201);
    const { id } = BrandVideoUploadResponse.parse(p.body);
    const chave = chaveDoVideo(e.tenantId, e.brandId, id, media_type);
    armazem.chegou(chave, arquivo);
    return { id, chave, resposta: await concluir(e, id) };
  }

  const auditoria = (tenantId: string, acao: string) =>
    ownerQuery<{ resource_id: string; after: Record<string, unknown> }>(
      `select resource_id, after from liame.audit_event where chain_key = $1 and action = $2 order by chain_seq`,
      [tenantId, acao],
    );

  it('sem a função `videos`: a lista diz que o vídeo está desligado e o pedido de envio é recusado (409), sem gravar nada', async () => {
    const e = await empresa('Casa Brasa Sem Video', { videos: false });
    expect(await lista(e)).toMatchObject({ enabled: true, videos_enabled: false, items: [] });
    const r = await pedir(e);
    expect({ code: r.body.code, status: r.status }).toEqual({ code: 'funcao-desligada', status: 409 });
    expect(await ownerQuery(`select 1 from liame.brand_photo where tenant_id = $1`, [e.tenantId])).toHaveLength(0);
    // Com a função das Fotos desligada, a de vídeo sozinha não liga nada.
    await ligarFlagDaEmpresa(api, 'videos', e.tenantId, true);
    await ligarFlagDaEmpresa(api, 'fotos', e.tenantId, false);
    expect((await pedir(e)).status).toBe(409);
  }, 60_000);

  it('o caminho inteiro: o endereço de envio, o vídeo que ainda não chegou, a conferência que o deixa pronto (com auditoria) e o pedido repetido', async () => {
    const e = await empresa('Casa Brasa Video');
    const antes = Date.now();
    const p = await pedir(e, 123_456);
    expect(p.status, JSON.stringify(p.body)).toBe(201);
    const pedido = BrandVideoUploadResponse.parse(p.body);
    const chave = chaveDoVideo(e.tenantId, e.brandId, pedido.id, 'video/mp4');
    expect(pedido.upload).toMatchObject({ url: `memoria://envio/${chave}?tipo=video%2Fmp4&bytes=123456&valido=600`, method: 'PUT', headers: { 'content-type': 'video/mp4' } });
    const expira = Date.parse(pedido.upload.expires_at) - antes;
    expect(expira).toBeGreaterThanOrEqual(600_000);
    expect(expira).toBeLessThan(660_000);
    const [linha] = await ownerQuery<Record<string, unknown>>(
      `select kind, status, object_key, bytes, media_type, width, height, duration_ms, sha256, has_cover from liame.brand_photo where id = $1`,
      [pedido.id],
    );
    expect(linha).toEqual({ kind: 'video', status: 'enviando', object_key: chave, bytes: 123_456, media_type: 'video/mp4', width: null, height: null, duration_ms: null, sha256: null, has_cover: false });
    expect(await auditoria(e.tenantId, 'fotos.video_pedir')).toEqual([
      { resource_id: pedido.id, after: { brand_id: e.brandId, media_type: 'video/mp4', bytes: 123_456 } },
    ]);
    // O pedido ainda sem o arquivo não aparece na lista; conferir antes de o arquivo chegar diz que não chegou.
    expect((await lista(e)).items).toEqual([]);
    const cedo = await concluir(e, pedido.id);
    expect({ code: cedo.body.code, status: cedo.status }).toEqual({ code: 'video-nao-chegou', status: 409 });
    expect(await ownerQuery(`select 1 from liame.brand_photo where id = $1 and status = 'enviando' and removed_at is null`, [pedido.id])).toHaveLength(1);

    const arquivo = videoDeMentira({ dados: 40_000 });
    armazem.chegou(chave, arquivo);
    const r = await concluir(e, pedido.id);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const video = BrandPhoto.parse(r.body);
    expect(video).toMatchObject({
      id: pedido.id,
      kind: 'video',
      width: 1080,
      height: 1920,
      bytes: arquivo.length,
      orientation: 'vertical',
      narrow_for_instagram: false,
      instagram_crop: 'nenhum',
      uploaded_by: { name: 'Pessoa de Teste' },
      video: { duration_ms: 30_000, media_type: 'video/mp4', has_audio: true, has_cover: false },
    });
    // Sem a capa, a grade mostra o próprio vídeo.
    expect(video.url).toBe(`memoria://imagens/${chave}?valido=300`);
    expect(video.thumbnail_url).toBe(video.url);
    expect(await auditoria(e.tenantId, 'fotos.video_concluir')).toEqual([
      { resource_id: pedido.id, after: { brand_id: e.brandId, width: 1080, height: 1920, duration_ms: 30_000, bytes: arquivo.length, has_audio: true } },
    ]);
    // O navegador repete o pedido: o mesmo vídeo, sem auditoria nova.
    const repetido = await concluir(e, pedido.id);
    expect(repetido.status).toBe(200);
    expect(BrandPhoto.parse(repetido.body)).toEqual({ ...video, urls_expire_at: repetido.body.urls_expire_at });
    expect(await auditoria(e.tenantId, 'fotos.video_concluir')).toHaveLength(1);
    const l = await lista(e);
    expect(l).toMatchObject({ videos_enabled: true });
    expect(l.items.map((i) => [i.id, i.kind])).toEqual([[pedido.id, 'video']]);
    // O MOV do iPhone, sem som, com a moov depois dos dados.
    const mov = await enviarVideo(e, videoDeMentira({ marca: 'qt  ', codec: 'hvc1', audio: null, moovNoFim: true, segundos: 8 }), 'video/quicktime');
    expect(mov.resposta.status, JSON.stringify(mov.resposta.body)).toBe(200);
    expect(mov.chave.endsWith('.mov')).toBe(true);
    expect(mov.resposta.body).toMatchObject({ video: { duration_ms: 8_000, media_type: 'video/quicktime', has_audio: false } });
  }, 60_000);

  it('a capa: um quadro do vídeo vira a miniatura, com auditoria; só no vídeo pronto; apagar leva o vídeo e a capa', async () => {
    const e = await empresa('Casa Brasa Capa');
    const { id, chave, resposta } = await enviarVideo(e, videoDeMentira());
    expect(resposta.status).toBe(200);
    const r = await capa(e, id, await jpeg(1080, 1920));
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const video = BrandPhoto.parse(r.body);
    expect(video.video).toMatchObject({ has_cover: true });
    expect(video.thumbnail_url).toBe(`memoria://imagens/${chaveDaMiniatura(chave)}?valido=300`);
    expect(armazem.objetos.has(chaveDaMiniatura(chave))).toBe(true);
    const [gravada] = await auditoria(e.tenantId, 'fotos.capa');
    expect(gravada?.resource_id).toBe(id);
    expect((await lista(e)).items[0]?.thumbnail_url).toBe(video.thumbnail_url);

    // O que a capa recusa: sem arquivo, o que não é imagem, a foto (não vídeo) e o vídeo que ainda não ficou pronto.
    const semArquivo = await api.call('PUT', `/v1/brand-photos/${id}/cover`, { cookie: e.cookie, body: {} });
    expect({ code: semArquivo.body.code, status: semArquivo.status }).toEqual({ code: 'capa-sem-arquivo', status: 400 });
    const naoImagem = await capa(e, id, Buffer.from('isto não é uma imagem'));
    expect({ code: naoImagem.body.code, status: naoImagem.status }).toEqual({ code: 'foto-formato', status: 422 });
    const foto = await api.call('POST', `/v1/brand-photos?brand_id=${e.brandId}`, { cookie: e.cookie, raw: { data: await jpeg(1200, 1200), type: 'image/jpeg' } });
    expect(foto.status).toBe(201);
    expect((await capa(e, foto.body.id as string, await jpeg(1080, 1920))).status).toBe(404);
    const esperando = BrandVideoUploadResponse.parse((await pedir(e)).body);
    expect((await capa(e, esperando.id, await jpeg(1080, 1920))).status).toBe(404);

    // Apagar: some da lista, e a rotina tira o vídeo e a capa do armazenamento e depois a linha.
    expect((await api.call('DELETE', `/v1/brand-photos/${id}`, { cookie: e.cookie })).status).toBe(204);
    expect((await lista(e)).items.map((i) => i.id)).toEqual([foto.body.id]);
    expect(await loop.executarLote(20, { tenantIds: [e.tenantId] })).toEqual([id]);
    expect(armazem.objetos.has(chave)).toBe(false);
    expect(armazem.objetos.has(chaveDaMiniatura(chave))).toBe(false);
  }, 60_000);

  it('recusa com o motivo da tela e tira o vídeo da lista: longo, curto, 4K, codec, o que não é vídeo e acima de 300 MB', async () => {
    const e = await empresa('Casa Brasa Recusa Video');
    const casos: Array<[Buffer, string]> = [
      [videoDeMentira({ segundos: 91 }), 'video-longo'],
      [videoDeMentira({ segundos: 2 }), 'video-curto'],
      [videoDeMentira({ largura: 2160, altura: 3840 }), 'video-resolucao'],
      [videoDeMentira({ codec: 'vp09' }), 'video-codec'],
      [await jpeg(1080, 1920), 'video-nao-abre'],
    ];
    const recusados: string[] = [];
    for (const [arquivo, code] of casos) {
      const { id, chave, resposta } = await enviarVideo(e, arquivo);
      expect({ code: resposta.body.code, status: resposta.status }).toEqual({ code, status: 422 });
      expect(armazem.objetos.has(chave)).toBe(true);
      recusados.push(id);
    }
    // Acima de 300 MB pelo tamanho que o armazenamento informa (o arquivo nem é lido).
    const lerTrecho = vi.spyOn(armazem, 'lerTrecho');
    vi.spyOn(armazem, 'tamanho').mockResolvedValueOnce(300 * 1024 * 1024 + 1);
    const grande = await enviarVideo(e, videoDeMentira());
    expect({ code: grande.resposta.body.code, status: grande.resposta.status }).toEqual({ code: 'video-grande-demais', status: 422 });
    expect(lerTrecho).not.toHaveBeenCalled();
    recusados.push(grande.id);
    // O pedido que já declara mais de 300 MB, ou outro formato, nem chega a ter endereço.
    expect((await pedir(e, 300 * 1024 * 1024 + 1)).status).toBe(400);
    expect((await pedir(e, 1000, 'video/webm')).status).toBe(400);

    expect((await lista(e)).items).toEqual([]);
    const marcadas = await ownerQuery<{ id: string }>(`select id from liame.brand_photo where tenant_id = $1 and removed_at is not null order by id`, [e.tenantId]);
    expect(marcadas.map((m) => m.id)).toEqual([...recusados].sort());
    // A rotina tira os arquivos recusados e depois as linhas.
    expect((await loop.executarLote(20, { tenantIds: [e.tenantId] })).sort()).toEqual([...recusados].sort());
    expect([...armazem.objetos.keys()].filter((k) => k.startsWith(`t/${e.tenantId}/`))).toEqual([]);
  }, 60_000);

  it('a leitura que falha não recusa: 502, o vídeo segue esperando e a nova tentativa o deixa pronto', async () => {
    const e = await empresa('Casa Brasa Leitura');
    const p = BrandVideoUploadResponse.parse((await pedir(e)).body);
    armazem.chegou(chaveDoVideo(e.tenantId, e.brandId, p.id, 'video/mp4'), videoDeMentira());
    armazem.falhar = { ler: true };
    const r = await concluir(e, p.id);
    expect({ code: r.body.code, status: r.status }).toEqual({ code: 'video-nao-conferido', status: 502 });
    expect(await ownerQuery(`select 1 from liame.brand_photo where id = $1 and status = 'enviando' and removed_at is null`, [p.id])).toHaveLength(1);
    armazem.falhar = {};
    expect((await concluir(e, p.id)).status).toBe(200);
  }, 60_000);

  it('a outra empresa não acha o vídeo; o novo post não aceita o vídeo no lugar da foto (o post com vídeo é a parte 3)', async () => {
    const e = await empresa('Casa Brasa Dona');
    const { id, resposta } = await enviarVideo(e, videoDeMentira());
    expect(resposta.status).toBe(200);
    const outra = await empresa('Casa Brasa Curiosa');
    expect((await concluir(outra, id)).status).toBe(404);
    expect((await capa(outra, id, await jpeg(1080, 1920))).status).toBe(404);
    expect((await api.call('DELETE', `/v1/brand-photos/${id}`, { cookie: outra.cookie })).status).toBe(404);
    expect((await pedir(outra, 1000, 'video/mp4', e.brandId)).status).toBe(404);

    await ligarFlagDaEmpresa(api, 'social_write', e.tenantId, true);
    const post = await api.call('POST', '/v1/posts', {
      cookie: e.cookie,
      body: { brand_id: e.brandId, photo_id: id, publish_at: new Date(Date.now() + 2 * 86_400_000).toISOString(), channels: [{ channel: 'instagram', text: 'O smash da sexta.' }] },
    });
    expect({ code: post.body.code, status: post.status }).toEqual({ code: 'foto-fora-da-marca', status: 422 });
  }, 60_000);

  it('a limpeza: o envio do vídeo que não terminou tem 2 horas (a foto tem 15 minutos), e sai com o arquivo que chegou', async () => {
    const e = await empresa('Casa Brasa Abandono Video');
    const p = BrandVideoUploadResponse.parse((await pedir(e)).body);
    const chave = chaveDoVideo(e.tenantId, e.brandId, p.id, 'video/mp4');
    armazem.chegou(chave, Buffer.from('meio vídeo'));
    const atrasar = (min: number) =>
      ownerQuery(`update liame.brand_photo set created_at = now() - make_interval(mins => $2), updated_at = now() - make_interval(mins => $2) where id = $1`, [p.id, min]);
    await atrasar(ENVIO_ABANDONADO_MIN + 1);
    expect(await loop.executarLote(20, { tenantIds: [e.tenantId] })).toEqual([]);
    await atrasar(ENVIO_DO_VIDEO_ABANDONADO_MIN - 1);
    expect(await loop.executarLote(20, { tenantIds: [e.tenantId] })).toEqual([]);
    await atrasar(ENVIO_DO_VIDEO_ABANDONADO_MIN + 1);
    expect(await loop.executarLote(20, { tenantIds: [e.tenantId] })).toEqual([p.id]);
    expect(armazem.objetos.has(chave)).toBe(false);
    expect(await ownerQuery(`select 1 from liame.brand_photo where id = $1`, [p.id])).toHaveLength(0);
  }, 60_000);

  it('a tabela recusa o que o desenho não aceita (V119): o tipo, o formato, a duração, o tamanho do vídeo e a mistura de foto e vídeo', async () => {
    const e = await empresa('Casa Brasa Restricoes Video', { videos: false });
    const base = (kind: string): Record<string, unknown> =>
      kind === 'video'
        ? { kind, status: 'pronta', media_type: 'video/mp4', bytes: 1000, width: 1080, height: 1920, duration_ms: 30_000, has_audio: true }
        : { kind, status: 'pronta', sha256: 'a'.repeat(64), bytes: 10, width: 1080, height: 1080 };
    const inserir = (linha: Record<string, unknown>) => {
      const tudo: Record<string, unknown> = { tenant_id: e.tenantId, brand_id: e.brandId, object_key: `t/teste/${crypto.randomUUID()}`, ...linha };
      const colunas = Object.keys(tudo);
      return ownerQuery(
        `insert into liame.brand_photo (id, ${colunas.join(', ')}) values (gen_random_uuid(), ${colunas.map((_, i) => `$${i + 1}`).join(', ')})`,
        Object.values(tudo),
      ).then(
        () => 'passou',
        (err: { code?: string; constraint?: string }) => `${err.code}:${err.constraint}`,
      );
    };
    // O que entra: a foto, o vídeo pronto, o vídeo esperando (sem medidas nem hash) e o vídeo de 300 MB.
    expect(await inserir(base('foto_produto'))).toBe('passou');
    expect(await inserir(base('video'))).toBe('passou');
    expect(await inserir({ kind: 'video', status: 'enviando', media_type: 'video/quicktime', bytes: 5 })).toBe('passou');
    expect(await inserir({ ...base('video'), bytes: 300 * 1024 * 1024 })).toBe('passou');
    const recusas: Array<[string, Record<string, unknown>, string]> = [
      ['outro tipo', { ...base('video'), kind: 'audio' }, 'brand_photo_kind_check'],
      ['vídeo acima de 300 MB', { ...base('video'), bytes: 300 * 1024 * 1024 + 1 }, 'brand_photo_bytes_check'],
      ['foto acima de 10 MB', { ...base('foto_produto'), bytes: 10 * 1024 * 1024 + 1 }, 'brand_photo_bytes_check'],
      ['formato fora da lista', { ...base('video'), media_type: 'video/webm' }, 'brand_photo_media_type_check'],
      ['duração zero', { ...base('video'), duration_ms: 0 }, 'brand_photo_duracao_check'],
      ['vídeo sem formato', { ...base('video'), media_type: null }, 'brand_photo_tipo_check'],
      ['vídeo pronto sem duração', { ...base('video'), duration_ms: null }, 'brand_photo_tipo_check'],
      ['vídeo pronto sem medidas', { ...base('video'), width: null }, 'brand_photo_tipo_check'],
      ['foto sem hash', { ...base('foto_produto'), sha256: null }, 'brand_photo_tipo_check'],
      ['foto sem medidas', { ...base('foto_produto'), height: null }, 'brand_photo_tipo_check'],
      ['foto com duração', { ...base('foto_produto'), duration_ms: 1000 }, 'brand_photo_tipo_check'],
      ['foto com formato de vídeo', { ...base('foto_produto'), media_type: 'video/mp4' }, 'brand_photo_tipo_check'],
    ];
    for (const [caso, linha, restricao] of recusas) expect({ caso, r: await inserir(linha) }).toEqual({ caso, r: `23514:${restricao}` });
  }, 60_000);
});
