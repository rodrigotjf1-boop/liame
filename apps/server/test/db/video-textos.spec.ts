import { resolve } from 'node:path';
import { runMigrations } from '@liame/database';
import { MockLanguageModelV4 } from 'ai/test';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ModelosIa } from '../../src/ai/modelos.js';
import { TAREFA_SOCIAL_VIDEO } from '../../src/ai/social/video.js';
import { APP_CONFIG } from '../../src/config.js';
import { FlagService } from '../../src/flags/flag.service.js';
import { ARMAZEM_DE_IMAGENS, type ArmazemNaMemoria } from '../../src/imagens/armazem.js';
import { enableMfa, ownerQuery, resetIpRateLimits, signupAndLogin, startApi, type TestApi } from '../helpers/api.js';
import { ligarIa, ModelosDeTeste, responde, rotaCompartilhada } from '../helpers/ia.js';
import { ligarFlagDaEmpresa } from '../helpers/meta-de-mentira.js';
import { fotoGuardada } from '../helpers/posts-semeados.js';
import { hasDb, OWNER_URL } from './env.js';

// Os textos do vídeo pelo Social media (A6 · Z15, parte 3b; D-A6-135), com o modelo simulado: a proposta conferida
// volta com a oferta de onde veio o preço; o que vai ao modelo é o produto e a descrição das fotos (nunca o arquivo); a
// proposta barrada pelo Compliance volta sem texto; sem a IA ligada, sem IA; a função desligada e a foto de outra marca
// recusam antes de qualquer chamada.

type Empresa = { cookie: string; tenantId: string; brandId: string };

const DOSSIE = {
  identity: { summary: 'Hamburgueria de bairro com smash feito na chapa', audience: 'Quem mora ou trabalha no Centro', differentiator: 'Pão feito na casa todo dia', since: '2019' },
  voice: { traits: ['Direta'], rules: ['Frases curtas.'], do_example: 'Bateu a fome? O smash sai da chapa rapidinho.', dont_example: '' },
  products: { items: ['Smash Clássico R$ 29,90'] },
  offers: { items: ['Combo sexta: smash, batata e refri por R$ 39,90'] },
  forbidden: { items: [{ text: 'o melhor hambúrguer do Rio', why: 'não temos como provar' }] },
  region: { area: 'Centro e Lapa', pickup: true },
};

describe.skipIf(!hasDb)('os textos do vídeo pelo Social media (Z15, parte 3b)', () => {
  let api: TestApi;
  let armazem: ArmazemNaMemoria;
  let flags: FlagService;
  let modelos: ModelosDeTeste;
  let alvo: Awaited<ReturnType<typeof rotaCompartilhada>>;

  beforeAll(async () => {
    await runMigrations({ connectionString: OWNER_URL, dir: resolve(process.cwd(), '../../packages/database/migrations') });
    api = await startApi();
    armazem = api.app.get(ARMAZEM_DE_IMAGENS) as ArmazemNaMemoria;
    flags = api.app.get(FlagService);
    modelos = new ModelosDeTeste(api.app.get(APP_CONFIG));
    api.app.get(ModelosIa).modelo = (provider, model) => modelos.modelo(provider, model);
    alvo = await rotaCompartilhada(modelos, TAREFA_SOCIAL_VIDEO, new MockLanguageModelV4({ doGenerate: [] }));
  }, 120_000);
  beforeEach(resetIpRateLimits);
  afterAll(async () => {
    await api?.close();
  });

  async function empresa(nome: string, o: { ia?: boolean; video?: boolean } = {}): Promise<Empresa> {
    const s = await signupAndLogin(api, undefined, nome);
    await enableMfa(api, s.cookie);
    const tenantId = s.me.active_organization_id as string;
    const brandId = (await ownerQuery<{ id: string }>(`select id from liame.brand where tenant_id = $1 limit 1`, [tenantId]))[0]!.id;
    await ligarFlagDaEmpresa(api, 'fotos', tenantId, true);
    if (o.video !== false) await ligarFlagDaEmpresa(api, 'video_montado', tenantId, true);
    if (o.ia !== false) await ligarIa(flags, tenantId);
    const salvo = await api.call('PUT', '/v1/brand-dossier', { cookie: s.cookie, body: { brand_id: brandId, base_version: 0, content: DOSSIE } });
    if (salvo.status !== 200) throw new Error(`dossiê não salvo: ${salvo.status} ${JSON.stringify(salvo.body)}`);
    return { cookie: s.cookie, tenantId, brandId };
  }
  async function fotoDoProduto(e: Empresa, produto: string): Promise<string> {
    const f = await fotoGuardada(e, armazem, { largura: 1080, altura: 1080 });
    await ownerQuery(`update liame.brand_photo set product = $2, description = 'Na chapa, saindo agora' where id = $1`, [f.id, produto]);
    return f.id;
  }
  const responder = (r: Record<string, unknown>) => {
    const mock = responde(JSON.stringify(r));
    modelos.porChave.set(`${alvo.provider}/${alvo.model}`, mock);
    return mock;
  };
  const pedir = (e: Empresa, media: string[], template = 'combo') =>
    api.call('POST', '/v1/video-montages/texts', { cookie: e.cookie, body: { brand_id: e.brandId, template, media_ids: media } });

  it('a proposta conferida volta com a oferta do preço; o modelo recebe o produto e a descrição, nunca o arquivo', async () => {
    const e = await empresa('Brasa Textos do Video');
    const fotos = [await fotoDoProduto(e, 'Smash Clássico'), await fotoDoProduto(e, 'Batata Rústica')];
    const mock = responder({ titulo: 'Sexta é dia de combo', linha_do_preco: 'R$ 39,90', chamada: 'Já escolheu o seu?', oferta: 1 });
    const r = await pedir(e, fotos);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({
      origin: 'ia',
      reason: null,
      texts: { title: 'Sexta é dia de combo', price_line: 'R$ 39,90', cta: 'Já escolheu o seu?' },
      offer: 'Combo sexta: smash, batata e refri por R$ 39,90',
      usage_id: expect.any(String),
    });
    const enviado = JSON.stringify(mock.doGenerateCalls[0]!.prompt);
    expect(enviado).toContain('Smash Clássico');
    expect(enviado).toContain('Batata Rústica');
    expect(enviado).toContain('Combo sexta');
    expect(enviado).not.toContain('foto_produto/');
  }, 120_000);

  it('o Compliance barra a proposta (sem texto); sem a IA ligada, sem IA; a função desligada e a foto de outra marca recusam', async () => {
    const e = await empresa('Brasa Textos Barrados');
    const foto = await fotoDoProduto(e, 'Smash Clássico');
    responder({ titulo: 'O melhor hambúrguer do Rio', linha_do_preco: '', chamada: 'Peça já', oferta: null });
    const barrada = await pedir(e, [foto], 'destaque');
    expect(barrada.body).toMatchObject({ origin: 'sem_ia', reason: 'barrado', texts: null, offer: null, usage_id: expect.any(String) });
    // O preço que não é o da oferta também barra.
    responder({ titulo: 'Smash na chapa', linha_do_preco: 'R$ 9,90', chamada: 'Peça já', oferta: 1 });
    expect((await pedir(e, [foto], 'destaque')).body).toMatchObject({ origin: 'sem_ia', reason: 'barrado' });

    const semIa = await empresa('Brasa Textos Sem IA', { ia: false });
    const fotoSemIa = await fotoDoProduto(semIa, 'Smash Clássico');
    expect((await pedir(semIa, [fotoSemIa], 'destaque')).body).toMatchObject({ origin: 'sem_ia', reason: 'ia_desligada', texts: null });

    const desligada = await empresa('Brasa Textos Desligada', { video: false });
    const fotoDesligada = await fotoDoProduto(desligada, 'Smash Clássico');
    expect((await pedir(desligada, [fotoDesligada], 'destaque')).body.code).toBe('funcao-desligada');
    expect((await pedir(e, [fotoDesligada], 'destaque')).body.code).toBe('midia-fora-das-fotos');
  }, 120_000);
});
