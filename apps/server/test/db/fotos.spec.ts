import { BrandPhoto, BrandPhotosResponse } from '@liame/contracts';
import { createDatabase, type Database } from '@liame/database';
import sharp from 'sharp';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { chaveDaFoto, chaveDaMiniatura } from '../../src/fotos/conferencia.js';
import { ARMAZEM_DE_IMAGENS, type ArmazemNaMemoria } from '../../src/imagens/armazem.js';
import { Mailer } from '../../src/mail/mailer.js';
import { VaultService } from '../../src/vault/vault.service.js';
import { ENVIO_ABANDONADO_MIN, FotosLoop } from '../../src/worker/fotos-loop.js';
import { LifecyclePurgeService } from '../../src/worker/lifecycle-purge.service.js';
import { enableMfa, ownerQuery, resetIpRateLimits, signupAndLogin, startApi, type TestApi } from '../helpers/api.js';
import { ligarFlagDaEmpresa } from '../helpers/meta-de-mentira.js';
import { APP_URL, hasDb } from './env.js';

// A6 · Z4: as fotos dos produtos (ADR-021; P20; D-A6-19), pelo caminho inteiro: a pessoa envia o arquivo cru, o
// servidor confere e regrava, a linha nasce `enviando`, o arquivo vai ao armazenamento (aqui, o da memória, o mesmo da
// API) e a foto fica `pronta` com o evento de auditoria. Depois: a lista com os endereços assinados e os produtos de
// Minha marca (salva pela rota), mudar o produto, apagar, a rotina que tira o arquivo e depois a linha (com o
// armazenamento falhando e voltando), o envio que não terminou, o expurgo da marca e da empresa, a função desligada,
// a outra empresa e as restrições da tabela (V119).

type Empresa = { cookie: string; tenantId: string; brandId: string };

const PRODUTOS = ['Smash duplo', 'Combo sexta: smash, batata e refrigerante'];

function jpeg(largura: number, altura: number, cor = { r: 201, g: 139, b: 78 }): Promise<Buffer> {
  return sharp({ create: { width: largura, height: altura, channels: 3, background: cor } }).jpeg({ quality: 80 }).toBuffer();
}

describe.skipIf(!hasDb)('Fotos dos produtos: as rotas, a limpeza e o expurgo (A6 · Z4)', () => {
  let api: TestApi;
  let database: Database;
  let armazem: ArmazemNaMemoria;
  let loop: FotosLoop;
  let purge: LifecyclePurgeService;

  beforeAll(async () => {
    api = await startApi();
    await resetIpRateLimits();
    database = createDatabase({ connectionString: APP_URL, max: 4, applicationName: 'liame-test' });
    armazem = api.app.get(ARMAZEM_DE_IMAGENS) as ArmazemNaMemoria;
    loop = new FotosLoop(database, armazem);
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

  async function empresa(nome: string, { ligada = true } = {}): Promise<Empresa> {
    const s = await signupAndLogin(api, undefined, nome);
    await enableMfa(api, s.cookie);
    const tenantId = s.me.active_organization_id as string;
    const marcas = await api.call('GET', '/v1/brands', { cookie: s.cookie });
    const brandId = marcas.body.items[0].id as string;
    if (ligada) await ligarFlagDaEmpresa(api, 'fotos', tenantId, true);
    // Os produtos entram por Minha marca, pela rota (V46).
    const salvo = await api.call('PUT', '/v1/brand-dossier', {
      cookie: s.cookie,
      body: { brand_id: brandId, base_version: 0, content: { products: { items: PRODUTOS } } },
    });
    expect(salvo.status, JSON.stringify(salvo.body)).toBe(200);
    return { cookie: s.cookie, tenantId, brandId };
  }

  function enviar(e: Empresa, data: Uint8Array, type = 'image/jpeg', brandId = e.brandId) {
    return api.call('POST', `/v1/brand-photos?brand_id=${brandId}`, { cookie: e.cookie, raw: { data, type } });
  }

  async function lista(e: Empresa): Promise<BrandPhotosResponse> {
    const r = await api.call('GET', `/v1/brand-photos?brand_id=${e.brandId}`, { cookie: e.cookie });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    return BrandPhotosResponse.parse(r.body);
  }

  it('desligada: a lista vem vazia e o envio é recusado (409), sem gravar nada', async () => {
    const e = await empresa('Casa Brasa Sem Fotos', { ligada: false });
    expect(await lista(e)).toMatchObject({ enabled: false, can_manage: true, products: [], items: [] });
    const r = await enviar(e, await jpeg(1200, 1200));
    expect(r.status, JSON.stringify(r.body)).toBe(409);
    expect(r.body.code).toBe('funcao-desligada');
    expect(await ownerQuery(`select 1 from liame.brand_photo where tenant_id = $1`, [e.tenantId])).toHaveLength(0);
  }, 60_000);

  it('envia: a cópia regravada e a miniatura vão ao armazenamento, a foto fica pronta, com auditoria; a lista traz os endereços e os produtos', async () => {
    const e = await empresa('Casa Brasa Fotos');
    const r = await enviar(e, await jpeg(3024, 4032));
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const foto = BrandPhoto.parse(r.body);
    expect(foto).toMatchObject({
      brand_id: e.brandId,
      product: null,
      description: '',
      width: 1536,
      height: 2048,
      orientation: 'vertical',
      narrow_for_instagram: false,
      instagram_crop: 'alta',
      uploaded_by: { name: 'Pessoa de Teste' },
    });
    const chave = chaveDaFoto(e.tenantId, e.brandId, foto.id);
    expect(armazem.objetos.has(chave)).toBe(true);
    expect(armazem.objetos.has(chaveDaMiniatura(chave))).toBe(true);
    expect(foto.url).toBe(`memoria://imagens/${chave}?valido=300`);
    expect(foto.thumbnail_url).toBe(`memoria://imagens/${chaveDaMiniatura(chave)}?valido=300`);
    // O nome do arquivo não existe na linha; o hash é do arquivo enviado.
    const [linha] = await ownerQuery<{ status: string; sha256: string; object_key: string }>(`select status, sha256, object_key from liame.brand_photo where id = $1`, [foto.id]);
    expect(linha).toMatchObject({ status: 'pronta', object_key: chave });
    const [auditoria] = await ownerQuery<{ action: string; resource_id: string; after: Record<string, unknown> }>(
      `select action, resource_id, after from liame.audit_event where chain_key = $1 and action = 'fotos.enviar' order by chain_seq desc limit 1`,
      [e.tenantId],
    );
    expect(auditoria).toMatchObject({ resource_id: foto.id, after: { brand_id: e.brandId, width: 1536, height: 2048 } });
    const l = await lista(e);
    expect(l).toMatchObject({ enabled: true, can_manage: true, products: PRODUTOS });
    expect(l.items.map((i) => i.id)).toEqual([foto.id]);
    // A mesma foto não entra duas vezes.
    const repetida = await enviar(e, await jpeg(3024, 4032));
    expect(repetida.status).toBe(409);
    expect(repetida.body.code).toBe('foto-repetida');
  }, 60_000);

  it('recusa com o motivo da tela: HEIC, formato, pequena, sem arquivo, outra empresa e acima de 10 MB (413 pelo filtro)', async () => {
    const e = await empresa('Casa Brasa Recusas');
    const heic = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypheic', 'latin1'), Buffer.alloc(64)]);
    const casos: Array<[Buffer, string, number, string]> = [
      [heic, 'image/heic', 422, 'foto-heic'],
      [await sharp({ create: { width: 800, height: 800, channels: 3, background: '#c98b4e' } }).gif().toBuffer(), 'image/gif', 422, 'foto-formato'],
      [await jpeg(500, 500), 'image/jpeg', 422, 'foto-pequena'],
    ];
    for (const [dados, tipo, status, code] of casos) {
      const r = await enviar(e, dados, tipo);
      expect({ code: r.body.code, status: r.status }).toEqual({ code, status });
    }
    const semArquivo = await api.call('POST', `/v1/brand-photos?brand_id=${e.brandId}`, { cookie: e.cookie, body: {} });
    expect({ code: semArquivo.body.code, status: semArquivo.status }).toEqual({ code: 'foto-sem-arquivo', status: 400 });
    const outra = await empresa('Casa Brasa Outra');
    const deFora = await enviar(outra, await jpeg(1200, 1200), 'image/jpeg', e.brandId);
    expect(deFora.status).toBe(404);
    const grande = await enviar(e, Buffer.alloc(10 * 1024 * 1024 + 1, 1));
    expect({ code: grande.body.code, status: grande.status }).toEqual({ code: 'grande-demais', status: 413 });
    expect(await ownerQuery(`select 1 from liame.brand_photo where tenant_id = $1`, [e.tenantId])).toHaveLength(0);
  }, 60_000);

  it('muda o produto (só os de Minha marca) e o que aparece; a outra empresa não acha a foto', async () => {
    const e = await empresa('Casa Brasa Produto');
    const foto = BrandPhoto.parse((await enviar(e, await jpeg(1600, 900))).body);
    expect(foto).toMatchObject({ orientation: 'horizontal', narrow_for_instagram: false, instagram_crop: 'nenhum' });
    const mudou = await api.call('PATCH', `/v1/brand-photos/${foto.id}`, { cookie: e.cookie, body: { product: PRODUTOS[1], description: 'O combo na mesa' } });
    expect(mudou.status, JSON.stringify(mudou.body)).toBe(200);
    expect(mudou.body).toMatchObject({ product: PRODUTOS[1], description: 'O combo na mesa' });
    const fora = await api.call('PATCH', `/v1/brand-photos/${foto.id}`, { cookie: e.cookie, body: { product: 'Pizza' } });
    expect({ code: fora.body.code, status: fora.status }).toEqual({ code: 'produto-fora-da-marca', status: 422 });
    const longa = await api.call('PATCH', `/v1/brand-photos/${foto.id}`, { cookie: e.cookie, body: { description: 'x'.repeat(121) } });
    expect(longa.status).toBe(400);
    const semProduto = await api.call('PATCH', `/v1/brand-photos/${foto.id}`, { cookie: e.cookie, body: { product: null } });
    expect(semProduto.body).toMatchObject({ product: null, description: 'O combo na mesa' });
    const outra = await empresa('Casa Brasa Vizinha');
    expect((await api.call('PATCH', `/v1/brand-photos/${foto.id}`, { cookie: outra.cookie, body: { description: 'invasão' } })).status).toBe(404);
    expect((await api.call('DELETE', `/v1/brand-photos/${foto.id}`, { cookie: outra.cookie })).status).toBe(404);
  }, 60_000);

  it('apaga: some da lista na hora; a rotina tira o arquivo e depois a linha, e tenta de novo quando o armazenamento falha', async () => {
    const e = await empresa('Casa Brasa Apaga');
    const foto = BrandPhoto.parse((await enviar(e, await jpeg(1080, 1080))).body);
    const chave = chaveDaFoto(e.tenantId, e.brandId, foto.id);
    expect((await api.call('DELETE', `/v1/brand-photos/${foto.id}`, { cookie: e.cookie })).status).toBe(204);
    expect((await lista(e)).items).toEqual([]);
    expect((await api.call('DELETE', `/v1/brand-photos/${foto.id}`, { cookie: e.cookie })).status).toBe(404);
    const [auditoria] = await ownerQuery<{ action: string }>(`select action from liame.audit_event where chain_key = $1 order by chain_seq desc limit 1`, [e.tenantId]);
    expect(auditoria?.action).toBe('fotos.apagar');

    armazem.falhar = { apagar: true };
    const agora = new Date();
    expect(await loop.executarLote(20, { tenantIds: [e.tenantId] }, agora)).toEqual([]);
    expect(armazem.objetos.has(chave)).toBe(true);
    const [presa] = await ownerQuery<{ updated_at: Date }>(`select updated_at from liame.brand_photo where id = $1`, [foto.id]);
    expect(presa?.updated_at.toISOString()).toBe(agora.toISOString());

    armazem.falhar = {};
    expect(await loop.executarLote(20, { tenantIds: [e.tenantId] })).toEqual([foto.id]);
    expect(armazem.objetos.has(chave)).toBe(false);
    expect(armazem.objetos.has(chaveDaMiniatura(chave))).toBe(false);
    expect(await ownerQuery(`select 1 from liame.brand_photo where id = $1`, [foto.id])).toHaveLength(0);
    // A mesma foto pode entrar de novo depois de apagada.
    expect((await enviar(e, await jpeg(1080, 1080))).status).toBe(201);
  }, 60_000);

  it('o armazenamento que falha ao gravar: 502, a linha sai da conta das repetidas, e a mesma foto entra na nova tentativa', async () => {
    const e = await empresa('Casa Brasa Falha');
    const dados = await jpeg(1300, 1300);
    armazem.falhar = { gravar: true };
    const r = await enviar(e, dados);
    expect({ code: r.body.code, status: r.status }).toEqual({ code: 'foto-nao-guardada', status: 502 });
    const [marcada] = await ownerQuery<{ status: string; removed_at: Date | null }>(`select status, removed_at from liame.brand_photo where tenant_id = $1`, [e.tenantId]);
    expect(marcada?.status).toBe('enviando');
    expect(marcada?.removed_at).not.toBeNull();
    armazem.falhar = {};
    expect((await enviar(e, dados)).status).toBe(201);
    // A linha que falhou sai pela rotina; a foto boa fica.
    expect(await loop.executarLote(20, { tenantIds: [e.tenantId] })).toHaveLength(1);
    expect((await lista(e)).items).toHaveLength(1);
  }, 60_000);

  it('o envio que não terminou (a rota caiu no meio) é limpo depois de 15 minutos, com o arquivo que chegou a ir', async () => {
    const e = await empresa('Casa Brasa Abandono');
    const id = '0192f1d4-3c1a-7b2e-9a10-5f1e2d3c4b60';
    const chave = chaveDaFoto(e.tenantId, e.brandId, id);
    await ownerQuery(
      `insert into liame.brand_photo (id, tenant_id, brand_id, status, object_key, sha256, bytes, width, height, created_at, updated_at)
       values ($1, $2, $3, 'enviando', $4, repeat('a', 64), 10, 1080, 1080, now() - make_interval(mins => $5), now() - make_interval(mins => $5))`,
      [id, e.tenantId, e.brandId, chave, ENVIO_ABANDONADO_MIN + 1],
    );
    await armazem.gravar(chave, Buffer.from('meio'));
    const cedo = new Date(Date.now() - 2 * 60_000 - ENVIO_ABANDONADO_MIN * 60_000);
    expect(await loop.executarLote(20, { tenantIds: [e.tenantId] }, cedo)).toEqual([]);
    expect(await loop.executarLote(20, { tenantIds: [e.tenantId] })).toEqual([id]);
    expect(armazem.objetos.has(chave)).toBe(false);
  }, 60_000);

  it('o expurgo: a marca arquivada e a empresa encerrada levam as fotos do armazenamento antes das linhas; com falha, a marca fica para amanhã', async () => {
    const e = await empresa('Casa Brasa Expurgo');
    const nova = await api.call('POST', '/v1/brands', { cookie: e.cookie, body: { name: 'Filial das fotos' } });
    expect(nova.status).toBe(201);
    const filial: Empresa = { ...e, brandId: nova.body.id as string };
    const foto = BrandPhoto.parse((await enviar(filial, await jpeg(1200, 1200))).body);
    const chave = chaveDaFoto(e.tenantId, filial.brandId, foto.id);
    expect((await api.call('POST', `/v1/brands/${filial.brandId}/archive`, { cookie: e.cookie })).status).toBe(200);
    await ownerQuery(`update liame.brand set purge_after = now() - interval '1 second' where id = $1`, [filial.brandId]);

    armazem.falhar = { apagar: true };
    expect(await purge.purgeArchivedBrands({ tenantIds: [e.tenantId] })).toBe(0);
    expect(await ownerQuery(`select 1 from liame.brand where id = $1`, [filial.brandId])).toHaveLength(1);
    expect(armazem.objetos.has(chave)).toBe(true);

    armazem.falhar = {};
    expect(await purge.purgeArchivedBrands({ tenantIds: [e.tenantId] })).toBe(1);
    expect(armazem.objetos.has(chave)).toBe(false);
    expect(await ownerQuery(`select 1 from liame.brand_photo where id = $1`, [foto.id])).toHaveLength(0);

    // A empresa inteira: as imagens dela saem antes da chave e das linhas.
    const daMatriz = BrandPhoto.parse((await enviar(e, await jpeg(1400, 1400))).body);
    const chaveDaMatriz = chaveDaFoto(e.tenantId, e.brandId, daMatriz.id);
    armazem.falhar = { apagar: true };
    await expect(purge.purgeTenant(e.tenantId)).rejects.toThrow();
    expect(await ownerQuery(`select 1 from liame.organization where id = $1`, [e.tenantId])).toHaveLength(1);
    armazem.falhar = {};
    await purge.purgeTenant(e.tenantId);
    expect(armazem.objetos.has(chaveDaMatriz)).toBe(false);
    expect(await ownerQuery(`select 1 from liame.organization where id = $1`, [e.tenantId])).toHaveLength(0);
  }, 90_000);

  it('a tabela recusa o que o desenho não aceita (V119): hash fora do formato, medida acima da cópia, texto longo e situação desconhecida', async () => {
    const e = await empresa('Casa Brasa Restricoes', { ligada: false });
    // Uma linha boa, com uma coluna trocada pelo valor que a tabela tem de recusar.
    const inserir = (coluna: string, valor: unknown) => {
      const linha: Record<string, unknown> = {
        tenant_id: e.tenantId,
        brand_id: e.brandId,
        object_key: `t/teste/${crypto.randomUUID()}`,
        sha256: 'a'.repeat(64),
        bytes: 10,
        width: 1080,
        height: 1080,
      };
      if (coluna) linha[coluna] = valor;
      const colunas = Object.keys(linha);
      return ownerQuery(
        `insert into liame.brand_photo (id, ${colunas.join(', ')}) values (gen_random_uuid(), ${colunas.map((_, i) => `$${i + 1}`).join(', ')})`,
        Object.values(linha),
      ).then(
        () => 'passou',
        (err: { code?: string; constraint?: string }) => `${err.code}:${err.constraint}`,
      );
    };
    expect(await inserir('', null)).toBe('passou');
    const recusas: Array<[string, unknown, string]> = [
      ['sha256', 'ABC', 'brand_photo_sha256_check'],
      ['width', 2049, 'brand_photo_width_check'],
      ['description', 'x'.repeat(121), 'brand_photo_description_check'],
      ['status', 'perdida', 'brand_photo_status_check'],
      ['product', '', 'brand_photo_product_check'],
      ['bytes', 10 * 1024 * 1024 + 1, 'brand_photo_bytes_check'],
    ];
    for (const [coluna, valor, restricao] of recusas) expect({ coluna, r: await inserir(coluna, valor) }).toEqual({ coluna, r: `23514:${restricao}` });
  }, 60_000);
});
