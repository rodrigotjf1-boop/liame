import { resolve } from 'node:path';
import { runMigrations } from '@liame/database';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ARMAZEM_DE_IMAGENS, type ArmazemNaMemoria } from '../../src/imagens/armazem.js';
import { enableMfa, ownerQuery, resetIpRateLimits, signupAndLogin, startApi, type TestApi } from '../helpers/api.js';
import { ligarFlagDaEmpresa } from '../helpers/meta-de-mentira.js';
import { fotoGuardada, videoGuardado } from '../helpers/posts-semeados.js';
import { hasDb, OWNER_URL } from './env.js';

// O vídeo montado pelo Liame (A6 · Z15, parte 2a; P43; D-A6-133 a D-A6-138): o pedido conferido entra na fila; cada
// modelo aceita as suas fotos; o vídeo e o som original só na "Novidade"; a logo só com a logo de Minha marca; os
// textos pelo Compliance (o preço só o da oferta; o que a marca não diz); o limite do dia (o que não deu não conta); a
// fila conta os de todas as marcas; e a função desligada recusa. "Os melhores momentos" (Z16): a função própria, só
// vídeos, 10, 15 ou 20 s, sem título nem chamada e os cortes pela régua dos cortes, com o campo de cada recusa.

type Empresa = { cookie: string; tenantId: string; brandId: string };

const DOSSIE = {
  identity: { summary: 'Hamburgueria de bairro com smash feito na chapa', audience: 'Quem mora ou trabalha no Centro', differentiator: 'Pão feito na casa todo dia', since: '2019' },
  voice: { traits: ['Direta'], rules: ['Frases curtas.'], do_example: 'Bateu a fome? O smash sai da chapa rapidinho.', dont_example: '' },
  products: { items: ['Smash Clássico R$ 29,90'] },
  offers: { items: ['Combo sexta: smash, batata e refri por R$ 39,90'] },
  forbidden: { items: [{ text: 'o melhor hambúrguer do Rio', why: 'não temos como provar' }] },
  region: { area: 'Centro e Lapa', pickup: true },
};

describe.skipIf(!hasDb)('o vídeo montado: os pedidos e a fila (Z15, parte 2a)', () => {
  let api: TestApi;
  let armazem: ArmazemNaMemoria;

  beforeAll(async () => {
    await runMigrations({ connectionString: OWNER_URL, dir: resolve(process.cwd(), '../../packages/database/migrations') });
    api = await startApi();
    armazem = api.app.get(ARMAZEM_DE_IMAGENS) as ArmazemNaMemoria;
  }, 120_000);
  beforeEach(async () => {
    await resetIpRateLimits();
  });
  afterAll(async () => {
    await api?.close();
  });

  async function empresa(nome: string, ligada = true): Promise<Empresa> {
    const s = await signupAndLogin(api, undefined, nome);
    await enableMfa(api, s.cookie);
    const tenantId = s.me.active_organization_id as string;
    const brandId = (await ownerQuery<{ id: string }>(`select id from liame.brand where tenant_id = $1 limit 1`, [tenantId]))[0]!.id;
    await ligarFlagDaEmpresa(api, 'fotos', tenantId, true);
    if (ligada) await ligarFlagDaEmpresa(api, 'video_montado', tenantId, true);
    // Minha marca com as ofertas em vigor e o que a marca não diz, pela rota de Minha marca.
    const salvo = await api.call('PUT', '/v1/brand-dossier', { cookie: s.cookie, body: { brand_id: brandId, base_version: 0, content: DOSSIE } });
    if (salvo.status !== 200) throw new Error(`dossiê não salvo: ${salvo.status} ${JSON.stringify(salvo.body)}`);
    return { cookie: s.cookie, tenantId, brandId };
  }
  const pedir = (e: Empresa, extra: Record<string, unknown>) =>
    api.call('POST', '/v1/video-montages', {
      cookie: e.cookie,
      body: { brand_id: e.brandId, template: 'destaque', format: '9x16', duration_s: 10, title: 'Smash duplo na chapa', cta: 'Peça pelo link da bio', ...extra },
    });

  it('a fila: o pedido conferido entra na fila, com quantos estão na frente; cada modelo aceita as suas fotos', async () => {
    const e = await empresa('Brasa Video Montado');
    const [f1, f2, f3] = await Promise.all([1, 2, 3].map(() => fotoGuardada(e, armazem, { largura: 1080, altura: 1080 })));
    const v = await videoGuardado(e, armazem, { capa: true });

    const r = await pedir(e, { media_ids: [f1!.id], price_line: 'R$ 39,90' });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body).toMatchObject({ status: 'na_fila', progress: 0, queue_ahead: expect.any(Number), price_line: 'R$ 39,90', photo_id: null });
    const segundo = await pedir(e, { template: 'combo', format: '4x5', duration_s: 15, media_ids: [f1!.id, f2!.id, f3!.id], title: 'Sexta é dia de combo', price_line: 'R$ 39,90', cta: 'Já escolheu o seu?' });
    expect(segundo.status, JSON.stringify(segundo.body)).toBe(201);
    // O segundo tem o primeiro na frente (e os de outras marcas que estiverem na fila).
    expect(segundo.body.queue_ahead).toBeGreaterThan(r.body.queue_ahead as number);

    // As recusas do modelo.
    expect((await pedir(e, { media_ids: [f1!.id, f2!.id] })).body.code).toBe('midias-do-modelo');
    expect((await pedir(e, { template: 'combo', media_ids: [f1!.id] })).body.code).toBe('midias-do-modelo');
    expect((await pedir(e, { media_ids: [v.id] })).body.code).toBe('video-no-modelo');
    expect((await pedir(e, { template: 'novidade', media_ids: [f1!.id], price_line: 'R$ 39,90' })).body.code).toBe('preco-no-modelo');
    expect((await pedir(e, { template: 'novidade', media_ids: [f1!.id], sound: 'original' })).body.code).toBe('som-sem-video');
    expect((await pedir(e, { template: 'novidade', media_ids: [v.id], sound: 'original' })).status).toBe(201);
    // O vídeo toca uma vez: precisa da duração escolhida; o som original só com o vídeo que tem som (parte 3).
    const curto = await videoGuardado(e, armazem, { capa: true, duracaoMs: 7_000 });
    const curtoRecusado = await pedir(e, { template: 'novidade', media_ids: [curto.id], duration_s: 10 });
    expect([curtoRecusado.body.code, curtoRecusado.body.detail]).toEqual(['video-curto', 'O vídeo tem 7 s: escolha uma duração de até 7 s, ou outro vídeo.']);
    const mudo = await videoGuardado(e, armazem, {});
    await ownerQuery(`update liame.brand_photo set has_audio = false where id = $1`, [mudo.id]);
    expect((await pedir(e, { template: 'novidade', media_ids: [mudo.id], sound: 'original' })).body.code).toBe('video-sem-som');
    expect((await pedir(e, { media_ids: [f1!.id], with_logo: true })).body.code).toBe('sem-logo');
    expect((await pedir(e, { template: 'combo', media_ids: [f1!.id, f1!.id] })).body.code).toBe('midia-repetida');

    // A lista: os pedidos, o limite do dia (3 contam) e a logo.
    const lista = await api.call('GET', `/v1/video-montages?brand_id=${e.brandId}`, { cookie: e.cookie });
    expect(lista.body).toMatchObject({ enabled: true, has_logo: false, today: { used: 3, limit: 10 } });
    expect(lista.body.items).toHaveLength(3);
  }, 120_000);

  it('os textos pelo Compliance: o preço fora da oferta e o que a marca não diz barram, com o trecho', async () => {
    const e = await empresa('Brasa Video Compliance');
    const f = await fotoGuardada(e, armazem, { largura: 1080, altura: 1350 });
    const preco = await pedir(e, { media_ids: [f.id], price_line: 'R$ 9,90' });
    expect([preco.status, preco.body.code]).toEqual([422, 'texto-barrado']);
    expect(preco.body.detail).toContain('9,90');
    expect(new Set(preco.body.errors.map((x: { path: string }) => x.path))).toEqual(new Set(['price_line']));
    const proibido = await pedir(e, { media_ids: [f.id], title: 'O melhor hambúrguer do Rio' });
    expect(proibido.body.code).toBe('texto-barrado');
    expect(proibido.body.detail).toContain('a marca não diz isso');
    expect(new Set(proibido.body.errors.map((x: { path: string }) => x.path))).toEqual(new Set(['title']));
    // Na chamada, o trecho barrado aponta a chamada.
    const naChamada = await pedir(e, { media_ids: [f.id], cta: 'O melhor hambúrguer do Rio' });
    expect(new Set(naChamada.body.errors.map((x: { path: string }) => x.path))).toEqual(new Set(['cta']));
    expect((await pedir(e, { media_ids: [f.id], price_line: 'R$ 39,90' })).status).toBe(201);
  }, 120_000);

  it('os melhores momentos (Z16): a função, só vídeos, as durações do modelo, sem título nem chamada e os cortes pela régua', async () => {
    const e = await empresa('Brasa Video Momentos');
    const v1 = await videoGuardado(e, armazem, { duracaoMs: 12_000 });
    const v2 = await videoGuardado(e, armazem, { duracaoMs: 9_000 });
    const f = await fotoGuardada(e, armazem, { largura: 1080, altura: 1080 });
    // 4 s + 4,5 s + 6 s = 14,5 s, dentro do vídeo de 15 s (de 12 s a 15,5 s).
    const cortes = [
      { media_id: v1.id, start_ms: 0, end_ms: 4_000, caption: 'A chapa no ponto.' },
      { media_id: v2.id, start_ms: 1_000, end_ms: 5_500, caption: 'O queijo derretendo' },
      { media_id: v1.id, start_ms: 6_000, end_ms: 12_000, caption: 'Peça pelo link da bio' },
    ];
    const momentos = (extra: Record<string, unknown> = {}) =>
      api.call('POST', '/v1/video-montages', {
        cookie: e.cookie,
        body: { brand_id: e.brandId, template: 'momentos', format: '9x16', duration_s: 15, media_ids: [v1.id, v2.id], cuts: cortes, ...extra },
      });
    const comCorte = (i: number, mudar: Record<string, unknown>) => cortes.map((c, k) => (k === i ? { ...c, ...mudar } : c));

    // A função `video_momentos`, desligada, recusa (por cima do vídeo montado).
    expect((await momentos()).body.code).toBe('funcao-desligada');
    await ligarFlagDaEmpresa(api, 'video_momentos', e.tenantId, true);

    const r = await momentos({ sound: 'original' });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body).toMatchObject({ template: 'momentos', duration_s: 15, title: 'Os melhores momentos', cta: '', price_line: null, sound: 'original', status: 'na_fila' });
    // Grava o conferido: o ponto final sai da legenda.
    expect(r.body.cuts).toEqual([{ ...cortes[0], caption: 'A chapa no ponto' }, cortes[1], cortes[2]]);
    const [linha] = await ownerQuery<{ cuts: unknown }>(`select cuts from liame.video_montage where id = $1`, [r.body.id]);
    expect(linha!.cuts).toEqual(r.body.cuts);
    // Os outros modelos saem com os cortes nulos.
    const destaque = await pedir(e, { media_ids: [f.id] });
    expect([destaque.status, destaque.body.cuts]).toEqual([201, null]);

    // As recusas do modelo.
    expect((await momentos({ media_ids: [v1.id, f.id] })).body.code).toBe('so-videos');
    expect((await momentos({ duration_s: 6 })).body.code).toBe('duracao-do-modelo');
    expect((await pedir(e, { media_ids: [f.id], duration_s: 20 })).body.code).toBe('duracao-do-modelo');
    expect((await momentos({ title: 'Smash duplo' })).body.code).toBe('texto-no-modelo');
    expect((await momentos({ cuts: undefined })).body.code).toBe('faltam-os-cortes');
    expect((await pedir(e, { media_ids: [f.id], cuts: cortes })).body.code).toBe('cortes-no-modelo');
    // Os modelos com texto seguem pedindo o título e a chamada.
    expect((await pedir(e, { media_ids: [f.id], title: undefined })).body.code).toBe('falta-o-titulo');
    expect((await pedir(e, { media_ids: [f.id], cta: undefined })).body.code).toBe('falta-a-chamada');

    // A régua dos cortes (a mesma da proposta do Social media), com o campo de cada recusa.
    const outro = await videoGuardado(e, armazem, { duracaoMs: 12_000 });
    const fora = await momentos({ cuts: comCorte(0, { media_id: outro.id }) });
    expect([fora.body.code, fora.body.errors[0].path]).toEqual(['corte-fora-dos-videos', 'cuts.0.media_id']);
    const passa = await momentos({ cuts: comCorte(1, { start_ms: 6_000, end_ms: 10_500 }) });
    expect([passa.body.code, passa.body.detail, passa.body.errors[0].path]).toEqual(['cortes-fora-da-regua', 'O corte 2 passa do fim do vídeo.', 'cuts.1.end_ms']);
    const curto = await momentos({ cuts: comCorte(1, { end_ms: 2_000 }) });
    expect([curto.body.detail, curto.body.errors[0].path]).toEqual(['O corte 2 tem menos de 1,5 s.', 'cuts.1.end_ms']);
    const repete = await momentos({ cuts: comCorte(2, { start_ms: 0, end_ms: 4_000 }) });
    expect([repete.body.detail, repete.body.errors[0].path]).toEqual(['O corte 3 repete um pedaço de outro corte do mesmo vídeo.', 'cuts.2.start_ms']);
    const total = await momentos({ duration_s: 20 });
    expect([total.body.code, total.body.detail]).toEqual(['cortes-fora-da-regua', 'Os cortes somam 14,5 s: o vídeo de 20 s leva de 16 s a 20 s de cortes.']);
    const hashtag = await momentos({ cuts: comCorte(0, { caption: 'A chapa #smash' }) });
    expect(hashtag.body.errors[0].path).toBe('cuts.0.caption');
    // As legendas pelo Compliance: o que a marca não diz e o preço fora da oferta, com o corte de onde veio.
    const proibido = await momentos({ cuts: comCorte(1, { caption: 'O melhor hambúrguer do Rio' }) });
    expect([proibido.body.code, proibido.body.errors.map((x: { path: string }) => x.path)]).toEqual(['texto-barrado', ['cuts.1.caption']]);
    const preco = await momentos({ cuts: comCorte(2, { caption: 'Smash por R$ 9,90' }) });
    expect([preco.body.code, preco.body.errors.map((x: { path: string }) => x.path)]).toEqual(['texto-barrado', ['cuts.2.caption']]);
    // Os textos do Social media não valem para este modelo: os cortes vêm do pedido dos cortes.
    const textos = await api.call('POST', '/v1/video-montages/texts', { cookie: e.cookie, body: { brand_id: e.brandId, template: 'momentos', media_ids: [v1.id] } });
    expect([textos.status, textos.body.code]).toEqual([422, 'texto-no-modelo']);
  }, 120_000);

  it('o limite do dia (o que não deu não conta), a função desligada e a marca de outra empresa', async () => {
    const e = await empresa('Brasa Video Limite');
    const f = await fotoGuardada(e, armazem, { largura: 1080, altura: 1080 });
    for (let i = 0; i < 10; i++) expect((await pedir(e, { media_ids: [f.id] })).status).toBe(201);
    expect((await pedir(e, { media_ids: [f.id] })).body.code).toBe('limite-do-dia');
    // O que não deu não conta.
    await ownerQuery(`update liame.video_montage set status = 'nao_deu', error = 'a foto saiu de Fotos' where id = (select id from liame.video_montage where brand_id = $1 order by created_at limit 1)`, [e.brandId]);
    expect((await pedir(e, { media_ids: [f.id] })).status).toBe(201);

    const desligada = await empresa('Brasa Video Desligada', false);
    const fd = await fotoGuardada(desligada, armazem, { largura: 1080, altura: 1080 });
    expect((await pedir(desligada, { media_ids: [fd.id] })).body.code).toBe('funcao-desligada');
    expect((await api.call('GET', `/v1/video-montages?brand_id=${e.brandId}`, { cookie: desligada.cookie })).status).toBe(404);
  }, 120_000);
});
