import { randomUUID } from 'node:crypto';
import type { Database } from '@liame/database';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { APP_CONFIG, type AppConfig } from '../../src/config.js';
import { DATABASE } from '../../src/database/database.module.js';
import { FlagService } from '../../src/flags/flag.service.js';
import { CAMPOS_DA_LISTA } from '../../src/fotos/do-seu-instagram.js';
import { VaultService } from '../../src/vault/vault.service.js';
import { DoSeuInstagramLoop } from '../../src/worker/do-seu-instagram-loop.js';
import { ownerQuery, resetIpRateLimits, startApi, type TestApi } from '../helpers/api.js';
import { InstagramDeMentira, SEGREDO_DO_APP, TOKEN_DO_INSTAGRAM } from '../helpers/instagram-de-mentira.js';
import { ligarFlagDaEmpresa } from '../helpers/meta-de-mentira.js';
import { type EmpresaComCanais, empresaComCanais } from '../helpers/posts-semeados.js';
import { hasDb } from './env.js';

// A6 · Z10, parte 5: "Do seu Instagram" (migration 0122; D-A6-71 e D-A6-83), contra um Instagram local (o simulador da
// publicação, com a lista da conta pela referência lida em 07/11/2026). O que se prova aqui:
//   - a conta ligada é lida pela rotina: a lista (sem o Story), os números de cada publicação, a miniatura (a capa no
//     Reels), o Reels com música do Instagram sem o arquivo, e a rota devolve a que mais rendeu primeiro; de novo, nada
//     devido; amanhã, só as publicações recentes relêem os números; a apagada no Instagram sai daqui;
//   - as funções desligadas: a conta espera um dia, sem chamar a Meta, e a rota diz `desligada`;
//   - sem conta, a primeira leitura e duas contas na marca;
//   - sem a permissão de ler a lista; sem a de ler os números (a lista fica); a falha passageira (1 hora);
//   - o banco recusa o que está fora do desenho (V119) e a rota não abre a marca de outra empresa.

const DIA_MS = 86_400_000;
const HORA_MS = 3_600_000;
const metrica = (name: string, value: unknown) => ({ name, period: 'lifetime', values: [{ value }], title: name, description: name, id: `x/insights/${name}/lifetime` });
const numerosDoIg = (views: number, reach: number, saved: number, shares: number) => [metrica('views', views), metrica('reach', reach), metrica('likes', 1), metrica('comments', 1), metrica('saved', saved), metrica('shares', shares)];

type Resposta = {
  enabled: boolean;
  account: { name: string } | null;
  situation: string;
  read_at: string | null;
  items: Array<{ id: string; kind: string; caption: string; thumbnail_url: string | null; has_file: boolean; metrics: Record<string, number | null>; metrics_read_at: string | null }>;
};

describe.skipIf(!hasDb)('"Do seu Instagram": a leitura e a rota (A6 · Z10, parte 5)', () => {
  let api: TestApi;
  let loop: DoSeuInstagramLoop;
  const ig = new InstagramDeMentira();

  beforeAll(async () => {
    api = await startApi();
    await resetIpRateLimits();
    await ig.ligar();
    const config: AppConfig = api.app.get(APP_CONFIG);
    const database: Database = api.app.get(DATABASE);
    // A rotina como no worker, com a Graph apontando para o Instagram local.
    loop = new DoSeuInstagramLoop(
      database,
      { ...config, plataformas: { ...config.plataformas, metaGraphUrl: ig.base, metaAppSecret: SEGREDO_DO_APP } },
      api.app.get(VaultService),
      api.app.get(FlagService),
    );
  }, 120_000);
  beforeEach(async () => {
    await resetIpRateLimits();
    ig.normalizar();
  });
  afterAll(async () => {
    await ig.desligar();
    await api?.close();
  });

  async function empresa(nome: string, o: { instagram?: boolean } = {}): Promise<EmpresaComCanais> {
    const e = await empresaComCanais(api, nome, { token: TOKEN_DO_INSTAGRAM, instagram: o.instagram ?? true });
    await ligarFlagDaEmpresa(api, 'fotos', e.tenantId, true);
    await ligarFlagDaEmpresa(api, 'videos', e.tenantId, true);
    return e;
  }
  const ler = (e: EmpresaComCanais, agora = new Date()) => loop.executarLote(10, { tenantIds: [e.tenantId] }, agora);
  const rota = async (e: EmpresaComCanais): Promise<Resposta> => {
    const r = await api.call('GET', `/v1/brand-photos/instagram?brand_id=${e.brandId}`, { cookie: e.cookie });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    return r.body as Resposta;
  };
  const estado = (contaId: string) =>
    ownerQuery<{ last_success_at: Date | null; last_error: string | null; cursor: Record<string, unknown> }>(
      `select last_success_at, last_error, cursor from liame.sync_state where connected_account_id = $1 and dataset = 'instagram_publicacoes'`,
      [contaId],
    ).then((r) => r[0]);

  it('a conta ligada é lida: a lista sem o Story, os números, a capa no Reels, o Reels com música sem o arquivo; a rota mostra a que mais rendeu primeiro', async () => {
    const e = await empresa('Casa Brasa Do Seu Instagram');
    const conta = e.instagram!.externo;
    const antiga = ig.publicadoForaDoLiame(conta, { caption: 'O vegano da casa 🌱', horas: 40 * 24, like_count: 98, comments_count: 4 });
    const carrossel = ig.publicadoForaDoLiame(conta, { caption: 'O cardápio da semana', media_type: 'CAROUSEL_ALBUM', horas: 72, like_count: 160, comments_count: 9 });
    const comMusica = ig.publicadoForaDoLiame(conta, { caption: 'Sexta é dia de combo', media_type: 'VIDEO', media_product_type: 'REELS', media_url: null, horas: 48, like_count: null, comments_count: 21 });
    const reels = ig.publicadoForaDoLiame(conta, { caption: 'Smash duplo saindo da chapa 🔥', media_type: 'VIDEO', media_product_type: 'REELS', horas: 5, like_count: 512, comments_count: 38 });
    ig.publicadoForaDoLiame(conta, { caption: 'O story do dia', media_product_type: 'STORY', horas: 2 });
    ig.numeros.set(reels, numerosDoIg(8420, 6100, 96, 40));
    ig.numeros.set(comMusica, numerosDoIg(5310, 4000, 54, 12));
    ig.numeros.set(carrossel, numerosDoIg(2410, 1900, 18, 3));
    ig.numeros.set(antiga, numerosDoIg(1190, 900, 11, 1));

    // Antes de ler: a conta ligada, a primeira leitura.
    expect(await rota(e)).toMatchObject({ enabled: true, account: { name: '@casabrasa' }, situation: 'primeira_leitura', read_at: null, items: [] });

    const agora = new Date();
    expect(await ler(e, agora)).toEqual([{ conta: e.instagram!.id, status: 'ok', publicacoes: 4, numeros: 4 }]);
    // A lista com os campos do Liame, as 50 mais novas; os números de cada uma; o token no cabeçalho e a prova do segredo.
    const lista = ig.chamadas.filter((c) => c.caminho.endsWith(`/${conta}/media`));
    expect(lista.map((c) => [c.metodo, c.params.fields, c.params.limit])).toEqual([['GET', CAMPOS_DA_LISTA, '50']]);
    expect(ig.contar('insights')).toBe(4);
    expect(ig.defeitos).toEqual([]);

    const r = await rota(e);
    expect(r).toMatchObject({ enabled: true, account: { name: '@casabrasa' }, situation: 'lido', read_at: agora.toISOString() });
    expect(r.items.map((x) => [x.id, x.kind])).toEqual([
      [reels, 'reels'],
      [comMusica, 'reels'],
      [carrossel, 'carrossel'],
      [antiga, 'foto'],
    ]);
    const [doReels, daMusica] = r.items;
    expect(doReels).toMatchObject({
      caption: 'Smash duplo saindo da chapa 🔥',
      thumbnail_url: `https://scontent.cdninstagram.com/v/${reels}-capa.jpg?oe=teste`,
      has_file: true,
      metrics: { views: 8420, reach: 6100, likes: 512, comments: 38, saved: 96, shares: 40 },
      metrics_read_at: agora.toISOString(),
    });
    // A conta que esconde as curtidas deste: fica a curtida dos números; o Reels com música, sem o arquivo.
    expect(daMusica).toMatchObject({ has_file: false, metrics: { views: 5310, likes: 1, comments: 21 } });
    expect(r.items[3]!.thumbnail_url).toBe(`https://scontent.cdninstagram.com/v/${antiga}.jpg?oe=teste`);

    // De novo agora: nada devido (a próxima é amanhã).
    expect(await ler(e, agora)).toEqual([]);
    expect(new Date(String((await estado(e.instagram!.id))!.cursor.proxima)).getTime()).toBe(agora.getTime() + DIA_MS);

    // Amanhã: a lista de novo; os números só das recentes (a de 40 dias já foi lida). A apagada no Instagram sai daqui.
    ig.normalizar();
    ig.posts.splice(
      ig.posts.findIndex((p) => p.id === carrossel),
      1,
    );
    ig.numeros.set(reels, numerosDoIg(9100, 6500, 120, 44));
    const amanha = new Date(agora.getTime() + DIA_MS + 60_000);
    expect(await ler(e, amanha)).toEqual([{ conta: e.instagram!.id, status: 'ok', publicacoes: 3, numeros: 2 }]);
    expect(ig.contar('insights')).toBe(2);
    const r2 = await rota(e);
    expect(r2.items.map((x) => x.id)).toEqual([reels, comMusica, antiga]);
    expect(r2.items[0]!.metrics).toMatchObject({ views: 9100, saved: 120 });
    // A de 40 dias guarda os números lidos ontem.
    expect(r2.items[2]).toMatchObject({ metrics: { views: 1190 }, metrics_read_at: agora.toISOString() });

    // A conta desligada: na volta seguinte da rotina, o que foi lido dela sai (a guarda é "com a conta conectada").
    await ownerQuery(`update liame.connected_account set disconnected_at = now() where id = $1`, [e.instagram!.id]);
    ig.normalizar();
    expect(await ler(e, new Date(amanha.getTime() + DIA_MS))).toEqual([]);
    expect(ig.chamadas).toEqual([]);
    expect(await ownerQuery(`select media_id from liame.instagram_media where connected_account_id = $1`, [e.instagram!.id])).toEqual([]);
    expect(await rota(e)).toMatchObject({ situation: 'sem_conta', items: [] });
  }, 120_000);

  it('as funções desligadas: a conta espera um dia, sem chamar a Meta, e a rota diz "desligada"', async () => {
    const e = await empresa('Casa Brasa Instagram Desligado');
    ig.publicadoForaDoLiame(e.instagram!.externo, { caption: 'Combo' });
    await ligarFlagDaEmpresa(api, 'videos', e.tenantId, false);
    const agora = new Date();
    expect(await ler(e, agora)).toEqual([{ conta: e.instagram!.id, status: 'desligada' }]);
    expect(ig.chamadas).toEqual([]);
    const s = await estado(e.instagram!.id);
    expect([s!.last_success_at, s!.last_error, new Date(String(s!.cursor.proxima)).getTime()]).toEqual([null, null, agora.getTime() + DIA_MS]);
    expect(await rota(e)).toEqual({ brand_id: e.brandId, enabled: false, account: null, situation: 'desligada', read_at: null, items: [] });
  }, 120_000);

  it('sem conta do Instagram na marca, e com duas contas: a rota diz qual, sem lista', async () => {
    const sem = await empresa('Casa Brasa Sem Instagram', { instagram: false });
    expect(await rota(sem)).toMatchObject({ enabled: true, account: null, situation: 'sem_conta', items: [] });
    const duas = await empresa('Casa Brasa Duas Contas');
    const segredo = (await ownerQuery<{ credential_secret_id: string }>(`select credential_secret_id from liame.connected_account where id = $1`, [duas.instagram!.id]))[0]!.credential_secret_id;
    await ownerQuery(
      `insert into liame.connected_account (id, tenant_id, brand_id, provider, external_id, name, credential_secret_id) values ($1, $2, $3, 'instagram', $4, '@casabrasa2', $5)`,
      [randomUUID(), duas.tenantId, duas.brandId, `1789${Date.now()}`.slice(0, 17), segredo],
    );
    expect(await rota(duas)).toMatchObject({ enabled: true, account: null, situation: 'duas_contas', items: [] });
  }, 120_000);

  it('sem a permissão de ler a lista: sem_permissao, um dia; sem a de ler os números: a lista fica; a falha passageira: 1 hora', async () => {
    // A lista recusada (#10): nada gravado, a rota diz sem_permissao.
    const e = await empresa('Casa Brasa Instagram Permissão');
    ig.publicadoForaDoLiame(e.instagram!.externo, { caption: 'Combo' });
    ig.falhas.set('media', [{ status: 403, corpo: { error: { message: '(#10) Application does not have permission for this action', type: 'OAuthException', code: 10, fbtrace_id: 't' } } }]);
    const agora = new Date();
    const [vez] = await ler(e, agora);
    expect(vez).toMatchObject({ status: 'sem_permissao' });
    const s = await estado(e.instagram!.id);
    expect(s!.cursor).toMatchObject({ falha: 'permissao', falhas_seguidas: 1, proxima: new Date(agora.getTime() + DIA_MS).toISOString() });
    expect(await rota(e)).toMatchObject({ situation: 'sem_permissao', items: [] });

    // Os números recusados: a lista é gravada sem eles, e a leitura deu certo.
    const n = await empresa('Casa Brasa Instagram Sem Números');
    const id = ig.publicadoForaDoLiame(n.instagram!.externo, { caption: 'Smash', like_count: 70, comments_count: 3 });
    ig.semPermissaoDeNumeros = true;
    expect(await ler(n, agora)).toEqual([{ conta: n.instagram!.id, status: 'ok', publicacoes: 1, numeros: 0 }]);
    expect((await estado(n.instagram!.id))!.cursor).toMatchObject({ numeros: 'sem_permissao' });
    const r = await rota(n);
    expect(r).toMatchObject({ situation: 'lido' });
    expect(r.items).toEqual([expect.objectContaining({ id, metrics: { views: null, reach: null, likes: 70, comments: 3, saved: null, shares: null }, metrics_read_at: null })]);

    // A falha passageira, sem nunca ter lido: falhou, 1 hora.
    ig.normalizar();
    const p = await empresa('Casa Brasa Instagram Passageira');
    ig.publicadoForaDoLiame(p.instagram!.externo, { caption: 'Combo' });
    ig.falhas.set('media', [{ status: 503, corpo: { error: { message: 'Service temporarily unavailable', type: 'OAuthException', code: 2, fbtrace_id: 't' } } }]);
    expect((await ler(p, agora))[0]).toMatchObject({ status: 'falhou' });
    expect((await estado(p.instagram!.id))!.cursor).toMatchObject({ falha: 'transitorio', proxima: new Date(agora.getTime() + HORA_MS).toISOString() });
    expect(await rota(p)).toMatchObject({ situation: 'falhou', items: [] });
  }, 120_000);

  it('o banco recusa o que está fora do desenho (V119), e a rota não abre a marca de outra empresa', async () => {
    const e = await empresa('Casa Brasa Instagram Banco');
    const inserir = (o: Record<string, unknown>) =>
      ownerQuery(
        `insert into liame.instagram_media (connected_account_id, tenant_id, brand_id, media_id, kind, caption, permalink, thumbnail_url, published_at, views)
         values ($1, $2, $3, $4, $5, $6, $7, $8, now(), $9)`,
        [e.instagram!.id, e.tenantId, e.brandId, o.media_id ?? randomUUID().slice(0, 18), o.kind ?? 'foto', o.caption ?? '', o.permalink ?? null, o.thumbnail_url ?? null, o.views ?? null],
      );
    const recusa = async (o: Record<string, unknown>, restricao: string) => {
      await expect(inserir(o), restricao).rejects.toMatchObject({ constraint: restricao });
    };
    // O que passa: cada regra no limite, e os campos opcionais nulos.
    await inserir({ media_id: 'x'.repeat(40), kind: 'reels', caption: 'a'.repeat(2200), permalink: 'p'.repeat(500), thumbnail_url: 't'.repeat(2000), views: 0 });
    await inserir({ kind: 'carrossel' });
    await inserir({ kind: 'video' });
    // O que não passa.
    await recusa({ media_id: '' }, 'instagram_media_id');
    await recusa({ media_id: 'x'.repeat(41) }, 'instagram_media_id');
    await recusa({ kind: 'story' }, 'instagram_media_tipo');
    await recusa({ caption: 'a'.repeat(2201) }, 'instagram_media_legenda');
    await recusa({ permalink: '' }, 'instagram_media_endereco');
    await recusa({ permalink: 'p'.repeat(501) }, 'instagram_media_endereco');
    await recusa({ thumbnail_url: '' }, 'instagram_media_miniatura');
    await recusa({ thumbnail_url: 't'.repeat(2001) }, 'instagram_media_miniatura');
    await recusa({ views: -1 }, 'instagram_media_numeros');

    // A marca de outra empresa: a RLS esconde, 404.
    const outra = await empresa('Casa Brasa Instagram Outra');
    const r = await api.call('GET', `/v1/brand-photos/instagram?brand_id=${e.brandId}`, { cookie: outra.cookie });
    expect(r.status, JSON.stringify(r.body)).toBe(404);
  }, 120_000);
});
