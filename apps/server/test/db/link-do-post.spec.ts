import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { codigoDoPost } from '../../src/links/construtor.js';
import { ownerQuery, resetIpRateLimits, startApi, type TestApi } from '../helpers/api.js';
import { type EmpresaComCanais, empresaComCanais, fotoPronta, lojaComCardapio } from '../helpers/posts-semeados.js';
import { hasDb } from './env.js';

// A6 · Z7, parte a: o link do post (D-A6-16; decisões técnicas D-A6-46 e D-A6-47). Cada post com a Página, e cada
// pacote, ganha um link do Liame só dele, para o cardápio da loja da marca. Na Página, o link vai no fim do texto já na
// criação (é o que vai para Aprovações e o que sai); no pacote, é o link da bio. O que se prova aqui:
//   - a Página com o Instagram: o link no fim do texto da Página (não no do Instagram), o mesmo no estado do pedido e na
//     resposta, o link marcado como de post, sem campanha, e fora da tela Links;
//   - o pacote: o link da bio, com o texto como veio;
//   - sem link: só o Instagram; a marca sem loja com cardápio; a marca com duas lojas (e a Agenda diz o porquê);
//   - o limite da Página conta o link;
//   - as travas do banco: link de post com campanha (ou anúncio) e link de campanha preso a post são recusados (V119).
// A atribuição do clique no link do post (D-A6-48) está nos casos de referência (`test/db/atribuicao.spec.ts`).

const FUSO = 'America/Sao_Paulo';
const DIA_MS = 86_400_000;
const diaNoFuso = (n: number): string =>
  new Intl.DateTimeFormat('en-CA', { timeZone: FUSO, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(Date.now() + n * DIA_MS));
const horaNoFuso = (n: number, hhmm: string): string => `${diaNoFuso(n)}T${hhmm}:00-03:00`;
const CARDAPIO = 'https://cardapio.exemplo.com.br/casa-brasa-centro';
const TEXTO_PAGINA = 'Sexta tem combo: smash duplo e batata.';
const TEXTO_INSTAGRAM = 'Sexta tem combo. Peça pelo link da bio.';
const TEXTO_TIKTOK = 'Smash duplo saindo da chapa. Peça pelo link da bio!';

describe.skipIf(!hasDb)('o link do post (A6 · Z7, parte a)', () => {
  let api: TestApi;

  beforeAll(async () => {
    api = await startApi();
    await resetIpRateLimits();
  }, 120_000);
  beforeEach(async () => {
    await resetIpRateLimits();
  });
  afterAll(async () => {
    await api?.close();
  });

  const novo = (e: EmpresaComCanais, foto: string, canais: Array<{ channel: string; text: string }>) =>
    api.call('POST', '/v1/posts', { cookie: e.cookie, body: { brand_id: e.brandId, photo_id: foto, publish_at: horaNoFuso(1, '19:00'), channels: canais } });
  const agenda = (e: EmpresaComCanais) => api.call('GET', `/v1/posts?brand_id=${e.brandId}&from=${diaNoFuso(-1)}&to=${diaNoFuso(7)}`, { cookie: e.cookie });
  const linksDe = (e: EmpresaComCanais) =>
    ownerQuery<{ code: string; kind: string; post_id: string | null; campaign_id: string | null; unit_id: string | null; provider: string; utm_source: string; utm_medium: string; utm_campaign: string | null; destination_url: string }>(
      `select code, kind, post_id, campaign_id, unit_id, provider, utm_source, utm_medium, utm_campaign, destination_url from liame.tracking_link where tenant_id = $1 order by created_at, id`,
      [e.tenantId],
    );
  const esperado = (e: EmpresaComCanais, postId: string, rede: string) => `${CARDAPIO}?utm_source=${rede}&utm_medium=social&utm_campaign=post&lk=${codigoDoPost(e.tenantId, postId)}`;

  it('a Página com o Instagram: o link no fim do texto da Página, no pedido e na resposta; marcado como de post e fora da tela Links', async () => {
    const e = await empresaComCanais(api, 'Casa Brasa Link');
    const loja = await lojaComCardapio(e, 'Loja Centro', CARDAPIO);
    const foto = await fotoPronta(e);
    expect((await agenda(e)).body.post_link).toEqual({ ok: true, reason: null });
    const r = await novo(e, foto.id, [
      { channel: 'instagram', text: TEXTO_INSTAGRAM },
      { channel: 'facebook', text: TEXTO_PAGINA },
    ]);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const link = esperado(e, r.body.id, 'facebook');
    expect(r.body.link).toBe(link);
    const porCanal = Object.fromEntries((r.body.channels as Array<{ channel: string; text: string }>).map((c) => [c.channel, c.text]));
    expect(porCanal).toEqual({ instagram: TEXTO_INSTAGRAM, facebook: `${TEXTO_PAGINA}\n\n${link}` });
    // O estado do pedido em Aprovações: o texto da Página com o link (a aprovação cobre o link).
    const [pedido] = await ownerQuery<{ before_state: { canais: Array<{ canal: string; texto: string }> } }>(`select before_state from liame.action_request where id = $1`, [r.body.action_id]);
    expect(pedido!.before_state.canais.find((c) => c.canal === 'facebook')!.texto).toBe(`${TEXTO_PAGINA}\n\n${link}`);
    expect(pedido!.before_state.canais.find((c) => c.canal === 'instagram')!.texto).toBe(TEXTO_INSTAGRAM);
    // O link: de post, sem campanha, da loja, com o código só deste post.
    expect(await linksDe(e)).toEqual([
      { code: codigoDoPost(e.tenantId, r.body.id), kind: 'post', post_id: r.body.id, campaign_id: null, unit_id: loja.unitId, provider: 'facebook', utm_source: 'facebook', utm_medium: 'social', utm_campaign: 'post', destination_url: CARDAPIO },
    ]);
    // A Agenda e o pedido mostram o mesmo link.
    expect((await agenda(e)).body.items[0].link).toBe(link);
    const acao = await api.call('GET', `/v1/actions/${r.body.action_id}`, { cookie: e.cookie });
    expect(acao.body.post?.link).toBe(link);
    // A auditoria diz que o link foi criado.
    const [ev] = await ownerQuery<{ after: Record<string, unknown> }>(`select after from liame.audit_event where tenant_id = $1 and action = 'posts.criar'`, [e.tenantId]);
    expect(ev!.after.link_do_post).toBe('criado');
    // A tela Links não mostra o link do post.
    const links = await api.call('GET', `/v1/links?brand_id=${e.brandId}`, { cookie: e.cookie });
    expect(links.status, JSON.stringify(links.body)).toBe(200);
    expect(links.body.items).toEqual([]);
  }, 90_000);

  it('o pacote: o link da bio, com o texto como veio; só o Instagram não ganha link', async () => {
    const e = await empresaComCanais(api, 'Casa Brasa Link Pacote');
    await lojaComCardapio(e, 'Loja Centro', CARDAPIO);
    const foto = await fotoPronta(e);
    const pacote = (await novo(e, foto.id, [{ channel: 'tiktok', text: TEXTO_TIKTOK }])).body;
    expect(pacote).toMatchObject({ kind: 'pacote', link: esperado(e, pacote.id, 'tiktok') });
    expect(pacote.channels[0].text).toBe(TEXTO_TIKTOK);
    const soInstagram = (await novo(e, foto.id, [{ channel: 'instagram', text: TEXTO_INSTAGRAM }])).body;
    expect(soInstagram.link).toBeNull();
    expect((await linksDe(e)).map((l) => [l.post_id, l.utm_source])).toEqual([[pacote.id, 'tiktok']]);
  }, 90_000);

  it('sem link: a marca sem loja com cardápio, e a marca com duas lojas; a Agenda diz o porquê, e o texto da Página vai como veio', async () => {
    const semLoja = await empresaComCanais(api, 'Casa Brasa Sem Loja');
    await lojaComCardapio(semLoja, 'Loja sem cardápio', null);
    expect((await agenda(semLoja)).body.post_link).toEqual({ ok: false, reason: 'sem_cardapio' });
    const r1 = (await novo(semLoja, (await fotoPronta(semLoja)).id, [{ channel: 'facebook', text: TEXTO_PAGINA }])).body;
    expect([r1.link, r1.channels[0].text]).toEqual([null, TEXTO_PAGINA]);
    const [ev] = await ownerQuery<{ after: Record<string, unknown> }>(`select after from liame.audit_event where tenant_id = $1 and action = 'posts.criar'`, [semLoja.tenantId]);
    expect(ev!.after.link_do_post).toBe('sem_cardapio');

    const duas = await empresaComCanais(api, 'Casa Brasa Duas Lojas');
    await lojaComCardapio(duas, 'Loja Centro', CARDAPIO);
    await lojaComCardapio(duas, 'Loja Barra', 'https://cardapio.exemplo.com.br/casa-brasa-barra');
    expect((await agenda(duas)).body.post_link).toEqual({ ok: false, reason: 'varias_lojas' });
    const r2 = (await novo(duas, (await fotoPronta(duas)).id, [{ channel: 'facebook', text: TEXTO_PAGINA }])).body;
    expect([r2.link, r2.channels[0].text]).toEqual([null, TEXTO_PAGINA]);
    expect(await linksDe(duas)).toEqual([]);
  }, 120_000);

  it('o limite da Página conta o link: o texto que cabe sozinho e não cabe com o link é recusado, sem gravar nada', async () => {
    const e = await empresaComCanais(api, 'Casa Brasa Link Limite');
    await lojaComCardapio(e, 'Loja Centro', CARDAPIO);
    const foto = await fotoPronta(e);
    const longo = await novo(e, foto.id, [{ channel: 'facebook', text: 'a'.repeat(9990) }]);
    expect([longo.status, longo.body.code, longo.body.detail]).toEqual([422, 'texto-longo-demais', 'O texto da Página, com o link do post no fim, passa de 10.000 caracteres.']);
    expect(await linksDe(e)).toEqual([]);
    expect(await ownerQuery(`select 1 from liame.social_post where tenant_id = $1`, [e.tenantId])).toHaveLength(0);
  }, 90_000);

  it('as travas do banco (V119): o link de post com campanha ou anúncio, e o de campanha preso a um post, são recusados', async () => {
    const e = await empresaComCanais(api, 'Casa Brasa Link Travas');
    const postId = randomUUID();
    await ownerQuery(`insert into liame.social_post (id, tenant_id, brand_id, photo_sha256, publish_at) values ($1, $2, $3, $4, now())`, [postId, e.tenantId, e.brandId, 'b'.repeat(64)]);
    const campanha = randomUUID();
    const contaMeta = randomUUID();
    await ownerQuery(
      `insert into liame.connected_account (id, tenant_id, brand_id, provider, external_id, name, currency, timezone, provider_attributes) values ($1, $2, $3, 'meta_ads', $4, 'CA', 'BRL', 'America/Sao_Paulo', '{}'::jsonb)`,
      [contaMeta, e.tenantId, e.brandId, randomUUID()],
    );
    await ownerQuery(
      `insert into liame.campaign (id, tenant_id, connected_account_id, provider, external_id, name, status) values ($1, $2, $3, 'meta_ads', '120099', 'Combo', 'ativa')`,
      [campanha, e.tenantId, contaMeta],
    );
    const link = (kind: string, post: string | null, camp: string | null, codigo: string) =>
      ownerQuery(
        `insert into liame.tracking_link (id, tenant_id, brand_id, code, name, provider, kind, post_id, campaign_id, destination_url, utm_source, utm_medium)
         values ($1, $2, $3, $4, 'teste', 'facebook', $5, $6, $7, $8, 'facebook', 'social')`,
        [randomUUID(), e.tenantId, e.brandId, codigo, kind, post, camp, CARDAPIO],
      );
    await expect(link('post', postId, campanha, 'TRAVA00001')).rejects.toThrow(/tracking_link_post_check/);
    await expect(link('campanha', postId, campanha, 'TRAVA00002')).rejects.toThrow(/tracking_link_post_check/);
    await expect(link('outro', null, null, 'TRAVA00003')).rejects.toThrow(/tracking_link_kind_check/);
    // O de post sem post (a ligação sumiu) segue de post: a marca é o que o motor lê.
    await expect(link('post', null, null, 'TRAVA00004')).resolves.toBeDefined();
    await expect(link('post', postId, null, 'TRAVA00005')).resolves.toBeDefined();
    // Um link por post.
    await expect(link('post', postId, null, 'TRAVA00006')).rejects.toThrow(/uq_tracking_link_post/);
  }, 90_000);
});
