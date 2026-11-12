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
// fila conta os de todas as marcas; e a função desligada recusa.

type Empresa = { cookie: string; tenantId: string; brandId: string };

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
    // Minha marca com as ofertas em vigor e o que a marca não diz.
    await ownerQuery(
      `insert into liame.brand_dossier_version (id, tenant_id, brand_id, version, content, content_version, text_hash, source, created_by)
       values (gen_random_uuid(), $1, $2, 1, $3::jsonb, 1, encode(sha256($3::bytea), 'hex'), 'pessoa', null)`,
      [tenantId, brandId, JSON.stringify({ offers: { items: ['Combo sexta: smash, batata e refri por R$ 39,90'] }, forbidden: { items: [{ text: 'o melhor hambúrguer do Rio', why: 'não temos como provar' }] } })],
    );
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
    expect(preco.body.detail).toContain('R$ 9,90');
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
