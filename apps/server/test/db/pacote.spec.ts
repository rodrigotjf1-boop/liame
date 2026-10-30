import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ownerQuery, resetIpRateLimits, startApi, type TestApi } from '../helpers/api.js';
import { ligarFlagDaEmpresa } from '../helpers/meta-de-mentira.js';
import { type EmpresaComCanais, empresaComCanais, fotoPronta } from '../helpers/posts-semeados.js';
import { hasDb } from './env.js';

// A6 · Z8, parte a: o pacote pronto (P22, aprovado pelo dono em 21/10/2026; D-A6-12, D-A6-25 e as decisões técnicas
// D-A6-40 a D-A6-42). No TikTok e no YouTube o Liame não publica (A6-14): o "Novo post" monta um pacote para cada uma
// dessas redes (o texto, a foto e a hora), sem pedido em Aprovações, sem o código do app e sem conta ligada; a pessoa
// publica e marca "Publiquei", ou tira o pacote da Agenda. O que se prova aqui:
//   - só o TikTok: um pacote pronto, sem pedido; a Agenda o mostra; "Publiquei" o marca, uma vez só;
//   - o Instagram com o TikTok e o YouTube: o post com o pedido (só o Instagram nele) e um pacote para cada rede;
//   - tirar da Agenda; o "Publiquei" e o "Tirar" só no pacote, da empresa, com a função ligada;
//   - as recusas do pacote: o texto longo e a palavra que a política proíbe, sem gravar nada;
//   - a foto do pacote para baixar (Z8, parte b; D-A6-43): o endereço da cópia guardada, como arquivo, só do pacote
//     pronto ou publicado, com a foto ainda nas Fotos.

const FUSO = 'America/Sao_Paulo';
const DIA_MS = 86_400_000;
const diaNoFuso = (n: number): string =>
  new Intl.DateTimeFormat('en-CA', { timeZone: FUSO, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(Date.now() + n * DIA_MS));
const horaNoFuso = (n: number, hhmm: string): string => `${diaNoFuso(n)}T${hhmm}:00-03:00`;
const TEXTO_TIKTOK = 'A batata nova chegou: crocante por fora, macia por dentro. Peça pelo link da bio! #batatafrita';
const TEXTO_YOUTUBE = 'A batata nova da Casa Brasa, saindo da fritadeira. Peça pelo cardápio no link do canal.';

describe.skipIf(!hasDb)('o pacote pronto: onde o Liame não publica (A6 · Z8, parte a)', () => {
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

  const novo = (e: EmpresaComCanais, foto: string, canais: Array<{ channel: string; text: string }>, extra: Record<string, unknown> = {}) =>
    api.call('POST', '/v1/posts', { cookie: e.cookie, body: { brand_id: e.brandId, photo_id: foto, publish_at: horaNoFuso(1, '12:00'), channels: canais, ...extra } });
  const agenda = (e: EmpresaComCanais) => api.call('GET', `/v1/posts?brand_id=${e.brandId}&from=${diaNoFuso(-1)}&to=${diaNoFuso(7)}`, { cookie: e.cookie });
  const postsDaEmpresa = (e: EmpresaComCanais) =>
    ownerQuery<{ kind: string; action_id: string | null; crop_pos: number | null }>(`select kind, action_id, crop_pos from liame.social_post where tenant_id = $1 order by kind, id`, [e.tenantId]);
  const canaisDe = (postId: string) =>
    ownerQuery<{ channel: string; status: string; connected_account_id: string | null; published_at: Date | null; removed_at: Date | null }>(
      `select channel, status, connected_account_id, published_at, removed_at from liame.social_post_channel where post_id = $1 order by channel`,
      [postId],
    );
  const pedidos = async (e: EmpresaComCanais) => (await ownerQuery(`select 1 from liame.action_request where tenant_id = $1`, [e.tenantId])).length;

  it('só o TikTok: um pacote pronto, sem pedido e sem conta; a Agenda o mostra; "Publiquei" o marca, e a segunda vez não muda nada', async () => {
    // A marca não precisa ter o Instagram nem a Página: o pacote não fala com rede nenhuma.
    const e = await empresaComCanais(api, 'Casa Brasa Pacote', { instagram: false, pagina: false });
    const foto = await fotoPronta(e);
    const r = await novo(e, foto.id, [{ channel: 'tiktok', text: TEXTO_TIKTOK }], { crop_pos: 10 });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    // O pacote não tem pedido de apagar das redes (A6, Z5d, parte 6): quem publicou apaga direto na rede.
    expect(r.body).toMatchObject({ kind: 'pacote', photo_id: foto.id, crop_pos: null, action_id: null, status: 'pacote_pronto', publish_at: new Date(horaNoFuso(1, '12:00')).toISOString(), removal: null });
    expect(r.body.channels).toEqual([
      {
        channel: 'tiktok',
        account_id: null,
        account_name: null,
        text: TEXTO_TIKTOK,
        status: 'pronto',
        permalink: null,
        error: null,
        published_at: null,
        removed_at: null,
        metrics: null,
        metrics_status: null,
        metrics_read_at: null,
        retry_until: null,
      },
    ]);
    expect(await pedidos(e)).toBe(0);
    // A Agenda: o pacote no dia e na hora, pronto.
    const lista = (await agenda(e)).body;
    expect(lista.items.map((p: { id: string; kind: string; status: string }) => [p.id, p.kind, p.status])).toEqual([[r.body.id, 'pacote', 'pacote_pronto']]);
    // A auditoria do novo post diz o pacote.
    const [ev] = await ownerQuery<{ after: Record<string, unknown> }>(`select after from liame.audit_event where tenant_id = $1 and action = 'posts.criar'`, [e.tenantId]);
    expect(ev!.after).toMatchObject({ action_id: null, canais: [], pacotes: [{ id: r.body.id, canal: 'tiktok' }] });

    const feito = await api.call('POST', `/v1/posts/${r.body.id}/published`, { cookie: e.cookie });
    expect(feito.status, JSON.stringify(feito.body)).toBe(200);
    expect(feito.body).toMatchObject({ kind: 'pacote', status: 'pacote_publicado' });
    expect(feito.body.channels[0]).toMatchObject({ channel: 'tiktok', status: 'publicado' });
    expect(feito.body.channels[0].published_at).not.toBeNull();
    const de = await api.call('POST', `/v1/posts/${r.body.id}/published`, { cookie: e.cookie });
    expect([de.status, de.body.channels[0].published_at]).toEqual([200, feito.body.channels[0].published_at]);
    expect(await ownerQuery(`select 1 from liame.audit_event where tenant_id = $1 and action = 'posts.pacote_publicado'`, [e.tenantId])).toHaveLength(2);
    // O publicado não sai da Agenda.
    const tirar = await api.call('POST', `/v1/posts/${r.body.id}/remove`, { cookie: e.cookie });
    expect([tirar.status, tirar.body.code]).toEqual([409, 'pacote-ja-publicado']);
  }, 90_000);

  it('o Instagram com o TikTok e o YouTube: o post com o pedido (só o Instagram nele) e um pacote para cada rede, na mesma hora; a resposta é o post', async () => {
    const e = await empresaComCanais(api, 'Casa Brasa Misto', { pagina: false });
    const foto = await fotoPronta(e);
    const r = await novo(e, foto.id, [
      { channel: 'youtube', text: TEXTO_YOUTUBE },
      { channel: 'instagram', text: 'Batata nova chegou. Peça pelo link da bio.' },
      { channel: 'tiktok', text: TEXTO_TIKTOK },
    ]);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body).toMatchObject({ kind: 'post', status: 'esperando_aprovacao' });
    expect(r.body.channels.map((c: { channel: string }) => c.channel)).toEqual(['instagram']);
    expect(await pedidos(e)).toBe(1);
    // O pedido só fala do Instagram: o estado do post no pedido não tem o TikTok nem o YouTube.
    const [pedido] = await ownerQuery<{ before_state: { canais: Array<{ canal: string }> } }>(`select before_state from liame.action_request where id = $1`, [r.body.action_id]);
    expect(pedido!.before_state.canais.map((c) => c.canal)).toEqual(['instagram']);
    const todos = await postsDaEmpresa(e);
    expect(todos.map((p) => [p.kind, p.action_id === null, p.crop_pos])).toEqual([
      ['pacote', true, null],
      ['pacote', true, null],
      ['post', false, null],
    ]);
    const lista = (await agenda(e)).body.items as Array<{ kind: string; status: string; publish_at: string; channels: Array<{ channel: string; status: string; account_id: string | null }> }>;
    expect(lista.map((p) => `${p.kind}:${p.channels.map((c) => `${c.channel}/${c.status}/${c.account_id ? 'conta' : 'sem-conta'}`).join(',')}:${p.status}`).sort()).toEqual([
      'pacote:tiktok/pronto/sem-conta:pacote_pronto',
      'pacote:youtube/pronto/sem-conta:pacote_pronto',
      'post:instagram/aguardando/conta:esperando_aprovacao',
    ]);
    expect(new Set(lista.map((p) => p.publish_at)).size).toBe(1);
  }, 90_000);

  it('tirar da Agenda: o pacote pronto sai, e "Publiquei" depois é 409; o post do Liame não tem os dois (409); a outra empresa não acha (404); a função desligada, 409', async () => {
    const e = await empresaComCanais(api, 'Casa Brasa Tira');
    const foto = await fotoPronta(e);
    const pacote = (await novo(e, foto.id, [{ channel: 'youtube', text: TEXTO_YOUTUBE }])).body;
    const tirou = await api.call('POST', `/v1/posts/${pacote.id}/remove`, { cookie: e.cookie });
    expect(tirou.status, JSON.stringify(tirou.body)).toBe(200);
    expect(tirou.body).toMatchObject({ status: 'cancelado' });
    const [c] = await canaisDe(pacote.id);
    expect(c).toMatchObject({ channel: 'youtube', status: 'cancelado', connected_account_id: null, published_at: null });
    expect(c!.removed_at).not.toBeNull();
    expect((await api.call('POST', `/v1/posts/${pacote.id}/remove`, { cookie: e.cookie })).status).toBe(200);
    const depois = await api.call('POST', `/v1/posts/${pacote.id}/published`, { cookie: e.cookie });
    expect([depois.status, depois.body.code]).toEqual([409, 'pacote-tirado']);
    expect(await ownerQuery(`select 1 from liame.audit_event where tenant_id = $1 and action = 'posts.pacote_tirado'`, [e.tenantId])).toHaveLength(2);

    const post = (await novo(e, foto.id, [{ channel: 'instagram', text: 'Batata nova. Peça pelo link da bio.' }])).body;
    for (const rota of ['published', 'remove']) {
      const r = await api.call('POST', `/v1/posts/${post.id}/${rota}`, { cookie: e.cookie });
      expect([r.status, r.body.code]).toEqual([409, 'nao-e-pacote']);
    }

    const outra = await empresaComCanais(api, 'Outra Casa Pacote');
    const outro = (await novo(outra, (await fotoPronta(outra)).id, [{ channel: 'tiktok', text: TEXTO_TIKTOK }])).body;
    expect((await api.call('POST', `/v1/posts/${outro.id}/published`, { cookie: e.cookie })).status).toBe(404);
    await ligarFlagDaEmpresa(api, 'social_write', outra.tenantId, false);
    const desligada = await api.call('POST', `/v1/posts/${outro.id}/published`, { cookie: outra.cookie });
    expect([desligada.status, desligada.body.code]).toEqual([409, 'funcao-desligada']);
  }, 120_000);

  it('as recusas do pacote: o texto longo (TikTok 2.200, YouTube 5.000) e a palavra que a política proíbe, sem gravar nada', async () => {
    const e = await empresaComCanais(api, 'Casa Brasa Recusa Pacote');
    const foto = await fotoPronta(e);
    const longo = await novo(e, foto.id, [{ channel: 'tiktok', text: 'a'.repeat(2201) }]);
    expect([longo.status, longo.body.code, longo.body.detail]).toEqual([422, 'texto-longo-demais', 'O texto do TikTok passa de 2.200 caracteres.']);
    expect((await novo(e, foto.id, [{ channel: 'tiktok', text: 'a'.repeat(2200) }])).status).toBe(201);
    // O contrato aceita até 10.000 por canal: o limite do YouTube é o do serviço.
    const youtube = await novo(e, foto.id, [{ channel: 'youtube', text: 'b'.repeat(5001) }]);
    expect([youtube.status, youtube.body.code, youtube.body.detail]).toEqual([422, 'texto-longo-demais', 'O texto do YouTube passa de 5.000 caracteres.']);
    // O que a empresa proíbe na política vale para o texto do pacote, como no pedido do post (D-A6-25).
    expect((await api.call('POST', '/v1/policies', { cookie: e.cookie, body: { document: { rules: [{ type: 'forbidden_words', words: ['gourmet'] }] } } })).status).toBe(201);
    const antes = (await postsDaEmpresa(e)).length;
    const proibida = await novo(e, foto.id, [
      { channel: 'instagram', text: 'Batata nova. Peça pelo link da bio.' },
      { channel: 'tiktok', text: 'A batata gourmet chegou.' },
    ]);
    expect([proibida.status, proibida.body.code]).toEqual([422, 'politica-negou']);
    expect(proibida.body.errors[0].path).toMatch(/^politica\.tenant\.\d+$/);
    // Nada gravado: nem o pacote, nem o post do Instagram que viria junto.
    expect((await postsDaEmpresa(e)).length).toBe(antes);
    expect(await pedidos(e)).toBe(0);
  }, 90_000);

  it('a foto do pacote para baixar (Z8, parte b; D-A6-43): o endereço da cópia guardada, como arquivo com o nome da rede e do dia, por 5 minutos; só o pacote pronto ou publicado, com a foto nas Fotos', async () => {
    const e = await empresaComCanais(api, 'Casa Brasa Foto do Pacote');
    const foto = await fotoPronta(e);
    const pacote = (await novo(e, foto.id, [{ channel: 'tiktok', text: TEXTO_TIKTOK }])).body;
    const antes = Date.now();
    const r = await api.call('GET', `/v1/posts/${pacote.id}/photo`, { cookie: e.cookie });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const nome = `liame-tiktok-${diaNoFuso(1)}.jpg`;
    expect(r.body).toMatchObject({ filename: nome, url: `memoria://imagens/t/${e.tenantId}/b/${e.brandId}/foto_produto/${foto.id}.jpg?valido=300&baixar=${nome}` });
    const vence = Date.parse(r.body.expires_at);
    expect(vence).toBeGreaterThanOrEqual(antes + 299_000);
    expect(vence).toBeLessThanOrEqual(Date.now() + 301_000);
    // Ler a foto não muda nada nem vira auditoria de mudança.
    expect(await ownerQuery(`select 1 from liame.audit_event where tenant_id = $1 and action like 'posts.pacote%'`, [e.tenantId])).toHaveLength(0);
    // Depois de "Publiquei", a foto continua ali (a pessoa pode precisar de novo).
    expect((await api.call('POST', `/v1/posts/${pacote.id}/published`, { cookie: e.cookie })).status).toBe(200);
    expect((await api.call('GET', `/v1/posts/${pacote.id}/photo`, { cookie: e.cookie })).status).toBe(200);

    // O tirado da Agenda não tem foto; o post do Liame não é pacote; a outra empresa não acha.
    const tirado = (await novo(e, foto.id, [{ channel: 'youtube', text: TEXTO_YOUTUBE }])).body;
    expect((await api.call('POST', `/v1/posts/${tirado.id}/remove`, { cookie: e.cookie })).status).toBe(200);
    const semFoto = await api.call('GET', `/v1/posts/${tirado.id}/photo`, { cookie: e.cookie });
    expect([semFoto.status, semFoto.body.code]).toEqual([409, 'pacote-tirado']);
    const post = (await novo(e, foto.id, [{ channel: 'instagram', text: 'Batata nova. Peça pelo link da bio.' }])).body;
    const doLiame = await api.call('GET', `/v1/posts/${post.id}/photo`, { cookie: e.cookie });
    expect([doLiame.status, doLiame.body.code]).toEqual([409, 'nao-e-pacote']);
    const outra = await empresaComCanais(api, 'Outra Casa Foto do Pacote');
    expect((await api.call('GET', `/v1/posts/${pacote.id}/photo`, { cookie: outra.cookie })).status).toBe(404);

    // A foto apagada nas Fotos (ou trocada: outro conteúdo com o mesmo id) não volta.
    const outroPacote = (await novo(e, foto.id, [{ channel: 'youtube', text: TEXTO_YOUTUBE }])).body;
    await ownerQuery(`update liame.brand_photo set sha256 = $2 where id = $1`, [foto.id, 'f'.repeat(64)]);
    const trocada = await api.call('GET', `/v1/posts/${outroPacote.id}/photo`, { cookie: e.cookie });
    expect([trocada.status, trocada.body.code]).toEqual([409, 'foto-apagada']);
    await ownerQuery(`update liame.brand_photo set sha256 = $2, removed_at = now() where id = $1`, [foto.id, foto.sha256]);
    const apagada = await api.call('GET', `/v1/posts/${outroPacote.id}/photo`, { cookie: e.cookie });
    expect([apagada.status, apagada.body.code]).toEqual([409, 'foto-apagada']);

    // Com a função desligada, nada.
    await ligarFlagDaEmpresa(api, 'social_write', e.tenantId, false);
    const desligada = await api.call('GET', `/v1/posts/${pacote.id}/photo`, { cookie: e.cookie });
    expect([desligada.status, desligada.body.code]).toEqual([409, 'funcao-desligada']);
  }, 120_000);
});
