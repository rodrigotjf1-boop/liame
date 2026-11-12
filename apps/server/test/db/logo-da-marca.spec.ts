import { resolve } from 'node:path';
import { createDatabase, type Database, runMigrations } from '@liame/database';
import sharp from 'sharp';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ARMAZEM_DE_IMAGENS, type ArmazemNaMemoria } from '../../src/imagens/armazem.js';
import { Mailer } from '../../src/mail/mailer.js';
import { chaveDaLogoDaMarca } from '../../src/marca/logo-da-marca.service.js';
import { VaultService } from '../../src/vault/vault.service.js';
import { LifecyclePurgeService } from '../../src/worker/lifecycle-purge.service.js';
import { enableMfa, ownerQuery, resetIpRateLimits, signupAndLogin, startApi, type TestApi } from '../helpers/api.js';
import { APP_URL, hasDb, OWNER_URL } from './env.js';

// A logo do restaurante em Minha marca (A6 · Z15, parte 1; D-A6-138), pelo caminho inteiro: chega crua, é conferida e
// regravada em JPEG sobre fundo branco, cabendo em 512 × 512, no prefixo da marca (aqui, o armazenamento da memória); a
// anterior sai na troca; tirar apaga; a marca de outra empresa é 404; e o expurgo da marca leva a logo junto.

function png(largura: number, altura: number, alfa = false): Promise<Buffer> {
  return sharp({ create: { width: largura, height: altura, channels: alfa ? 4 : 3, background: alfa ? { r: 200, g: 30, b: 30, alpha: 0 } : { r: 200, g: 30, b: 30 } } })
    .png()
    .toBuffer();
}

describe.skipIf(!hasDb)('a logo do restaurante em Minha marca', () => {
  let api: TestApi;
  let database: Database;
  let armazem: ArmazemNaMemoria;
  let purge: LifecyclePurgeService;

  beforeAll(async () => {
    await runMigrations({ connectionString: OWNER_URL, dir: resolve(process.cwd(), '../../packages/database/migrations') });
    api = await startApi();
    database = createDatabase({ connectionString: APP_URL, max: 4, applicationName: 'liame-test' });
    armazem = api.app.get(ARMAZEM_DE_IMAGENS) as ArmazemNaMemoria;
    purge = new LifecyclePurgeService(database, api.app.get(VaultService), api.app.get(Mailer), armazem);
  }, 120_000);
  beforeEach(async () => {
    await resetIpRateLimits();
    armazem.falhar = {};
  });
  afterAll(async () => {
    await api?.close();
    await database?.close();
  });

  async function empresa(nome: string): Promise<{ cookie: string; brandId: string; tenantId: string }> {
    const d = await signupAndLogin(api, undefined, nome);
    // Minha marca pede o app autenticador ativo (como as outras telas da empresa).
    await enableMfa(api, d.cookie);
    const marcas = await api.call('GET', '/v1/brands', { cookie: d.cookie });
    expect(marcas.status, JSON.stringify(marcas.body)).toBe(200);
    return { cookie: d.cookie, brandId: marcas.body.items[0].id as string, tenantId: d.me.active_organization_id as string };
  }
  const logo = (e: { cookie: string; brandId: string }, data: Uint8Array, type = 'image/png') =>
    api.call('PUT', `/v1/brands/${e.brandId}/logo`, { cookie: e.cookie, raw: { data, type } });
  const ler = (e: { cookie: string; brandId: string }) => api.call('GET', `/v1/brands/${e.brandId}/logo`, { cookie: e.cookie });
  const linha = async (brandId: string) =>
    (await ownerQuery<{ logo_id: string | null; logo_width: number | null; logo_height: number | null }>(`select logo_id, logo_width, logo_height from liame.brand where id = $1`, [brandId]))[0]!;

  it('envia, regrava em 512 × 512 sobre fundo branco, troca (a anterior sai) e tira', async () => {
    const e = await empresa('Brasa Logo da Marca');
    expect((await ler(e)).body).toEqual({ brand_id: e.brandId, logo: null, logo_available: true });

    // Uma logo grande e transparente: cabe em 512 × 512, em JPEG, sem a transparência.
    const r = await logo(e, await png(1200, 800, true));
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.logo).toMatchObject({ width: 512, height: 341, url: expect.any(String) });
    const primeira = await linha(e.brandId);
    const chave = chaveDaLogoDaMarca(e.tenantId, e.brandId, primeira.logo_id!);
    const meta = await sharp(armazem.objetos.get(chave)!).metadata();
    expect([meta.format, meta.width, meta.height, meta.hasAlpha]).toEqual(['jpeg', 512, 341, false]);

    // A troca: a anterior sai do armazenamento.
    expect((await logo(e, await png(300, 300))).status).toBe(200);
    const segunda = await linha(e.brandId);
    expect(segunda.logo_id).not.toBe(primeira.logo_id);
    await new Promise((ok) => setTimeout(ok, 50));
    expect(armazem.objetos.has(chave)).toBe(false);
    expect(segunda).toMatchObject({ logo_width: 300, logo_height: 300 });

    // As recusas: SVG (o tipo pelo conteúdo), pequena demais.
    const svg = await logo(e, Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"></svg>'), 'image/png');
    expect([svg.status, svg.body.code]).toEqual([422, 'logo-formato']);
    expect((await logo(e, await png(20, 20))).body.code).toBe('logo-pequeno');

    // Tirar: o arquivo sai, e a linha fica sem logo.
    expect((await api.call('DELETE', `/v1/brands/${e.brandId}/logo`, { cookie: e.cookie })).status).toBe(204);
    await new Promise((ok) => setTimeout(ok, 50));
    expect(await linha(e.brandId)).toEqual({ logo_id: null, logo_width: null, logo_height: null });
    expect(armazem.objetos.has(chaveDaLogoDaMarca(e.tenantId, e.brandId, segunda.logo_id!))).toBe(false);
    expect((await ler(e)).body.logo).toBeNull();
  }, 60_000);

  it('a marca de outra empresa é 404; o armazenamento que falha não muda a logo; o expurgo da marca leva a logo', async () => {
    const a = await empresa('Brasa Logo A');
    const b = await empresa('Brasa Logo B');
    expect((await logo(a, await png(200, 200))).status).toBe(200);
    expect((await api.call('PUT', `/v1/brands/${a.brandId}/logo`, { cookie: b.cookie, raw: { data: await png(200, 200), type: 'image/png' } })).status).toBe(404);
    expect((await api.call('GET', `/v1/brands/${a.brandId}/logo`, { cookie: b.cookie })).status).toBe(404);

    const antes = await linha(a.brandId);
    armazem.falhar = { gravar: true };
    const falhou = await logo(a, await png(250, 250));
    expect([falhou.status, falhou.body.code]).toEqual([502, 'logo-nao-guardado']);
    armazem.falhar = {};
    expect(await linha(a.brandId)).toEqual(antes);

    const chave = chaveDaLogoDaMarca(a.tenantId, a.brandId, antes.logo_id!);
    expect(armazem.objetos.has(chave)).toBe(true);
    expect(await purge.purgeBrand(a.tenantId, a.brandId)).toBe(true);
    expect(armazem.objetos.has(chave)).toBe(false);
  }, 60_000);
});
