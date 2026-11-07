import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { type Database, runMigrations } from '@liame/database';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CAMPOS_DO_COMENTARIO_NA_PAGINA, CAMPOS_DO_COMENTARIO_NO_INSTAGRAM } from '../../src/comentarios/comentarios.js';
import { APP_CONFIG, type AppConfig } from '../../src/config.js';
import { DATABASE } from '../../src/database/database.module.js';
import { FlagService } from '../../src/flags/flag.service.js';
import { Mailer } from '../../src/mail/mailer.js';
import { VaultService } from '../../src/vault/vault.service.js';
import { ComentariosLoop } from '../../src/worker/comentarios-loop.js';
import { LifecyclePurgeService } from '../../src/worker/lifecycle-purge.service.js';
import { ownerQuery, resetIpRateLimits, startApi, type TestApi } from '../helpers/api.js';
import { InstagramDeMentira, SEGREDO_DO_APP, TOKEN_DO_INSTAGRAM } from '../helpers/instagram-de-mentira.js';
import { ligarFlagDaEmpresa } from '../helpers/meta-de-mentira.js';
import { type EmpresaComCanais, empresaComCanais } from '../helpers/posts-semeados.js';
import { hasDb, OWNER_URL } from './env.js';

// A6 · Z11, parte 1: a leitura dos comentários (migration 0123; P38, D-A6-84 a D-A6-90), contra a Meta local (o
// simulador do Instagram e da Página, com os comentários pelas páginas oficiais lidas em 07/11/2026). O que se prova:
//   - o Instagram de ponta a ponta: os posts dos últimos 30 dias, os comentários com as respostas, a resposta da marca
//     ("respondido"), o tipo pela regra, as contagens e a ordem da rota, o filtro, o canal e a busca; 15 minutos depois,
//     só o post recente; uma hora depois, o de 10 dias também; o apagado na rede sai, o oculto que não voltou fica; a
//     conta desligada leva tudo;
//   - a função desligada: a conta espera um dia, sem chamar a Meta, e a rota diz `desligada`;
//   - sem a permissão de ler os comentários: `sem_permissao`, um dia; a falha de um post deixa só ele para depois;
//   - a Página: sem a tarefa de moderar, `sem_permissao`; com ela, os posts publicados (sem o agendado), os comentários
//     de todos os níveis, o `from` que não vem (o pior caso) e a resposta da Página;
//   - o "Ler agora": a função desligada (409), o pedido (202, com todos os posts), de novo antes de 5 minutos (429) e a
//     conta que está sendo lida fica como está;
//   - o expurgo de 90 dias; o banco recusa o que está fora do desenho (V119); a rota não abre a marca de outra empresa.

const MIN_MS = 60_000;
const HORA_MS = 3_600_000;
const DIA_MS = 24 * HORA_MS;

type Comentario = { id: string; channel: string; post_id: string; author: string | null; message: string; hidden: boolean; kind: string | null; kind_source: string | null; situation: string; replies: Array<{ id: string; by_brand: boolean; author: string | null; message: string }> };
type Resposta = {
  brand_id: string;
  state: string;
  accounts: Array<{ channel: string; name: string; situation: string; read_at: string | null }>;
  counts: Record<string, number>;
  items: Comentario[];
  posts: Array<{ id: string; channel: string; kind: string | null; caption: string; thumbnail_url: string | null }>;
  refresh: { available: boolean; next_at: string | null };
};

describe.skipIf(!hasDb)('Comentários: a leitura e a rota (A6 · Z11, parte 1)', () => {
  let api: TestApi;
  let loop: ComentariosLoop;
  let database: Database;
  const meta = new InstagramDeMentira();

  beforeAll(async () => {
    await runMigrations({ connectionString: OWNER_URL, dir: resolve(process.cwd(), '../../packages/database/migrations') });
    api = await startApi();
    await resetIpRateLimits();
    await meta.ligar();
    const config: AppConfig = api.app.get(APP_CONFIG);
    database = api.app.get(DATABASE);
    // A rotina como no worker, com a Graph apontando para a Meta local.
    loop = new ComentariosLoop(
      database,
      { ...config, plataformas: { ...config.plataformas, metaGraphUrl: meta.base, metaAppSecret: SEGREDO_DO_APP } },
      api.app.get(VaultService),
      api.app.get(FlagService),
    );
  }, 120_000);
  beforeEach(async () => {
    await resetIpRateLimits();
    meta.normalizar();
  });
  afterAll(async () => {
    await meta.desligar();
    await api?.close();
  });

  async function empresa(nome: string, o: { instagram?: boolean; pagina?: boolean; ligada?: boolean } = {}): Promise<EmpresaComCanais> {
    const e = await empresaComCanais(api, nome, { token: TOKEN_DO_INSTAGRAM, instagram: o.instagram ?? true, pagina: o.pagina ?? true });
    await ligarFlagDaEmpresa(api, 'comentarios', e.tenantId, o.ligada ?? true);
    return e;
  }
  const ler = (e: EmpresaComCanais, agora = new Date()) => loop.executarLote(10, { tenantIds: [e.tenantId] }, agora);
  const rota = async (e: EmpresaComCanais, consulta = ''): Promise<Resposta> => {
    const r = await api.call('GET', `/v1/comments?brand_id=${e.brandId}${consulta}`, { cookie: e.cookie });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    return r.body as Resposta;
  };
  const estado = (contaId: string) =>
    ownerQuery<{ last_success_at: Date | null; last_error: string | null; cursor: Record<string, unknown> }>(
      `select last_success_at, last_error, cursor from liame.sync_state where connected_account_id = $1 and dataset = 'comentarios'`,
      [contaId],
    ).then((r) => r[0]);
  const chamadasDosComentarios = () => meta.chamadas.filter((c) => c.caminho.endsWith('/comments'));
  const guardados = (contaId: string) =>
    ownerQuery<{ comment_id: string }>(`select comment_id from liame.social_comment where connected_account_id = $1 order by comment_id collate "C"`, [contaId]).then((r) => r.map((x) => x.comment_id));

  it('o Instagram de ponta a ponta: os posts da janela, os comentários com as respostas, a situação de cada um, a fila de cada post e o que sai', async () => {
    const e = await empresa('Casa Brasa Comentários', { pagina: false });
    const ig = e.instagram!.externo;
    const recente = meta.publicadoForaDoLiame(ig, { caption: 'Smash duplo saindo da chapa 🔥', media_type: 'VIDEO', media_product_type: 'REELS', horas: 2, comments_count: 3 });
    const deDezDias = meta.publicadoForaDoLiame(ig, { caption: 'O combo da semana', horas: 10 * 24, comments_count: 1 });
    meta.publicadoForaDoLiame(ig, { caption: 'Antigo', horas: 40 * 24, comments_count: 5 });
    const pergunta = meta.comentouNoInstagram(recente, { texto: 'Quanto custa o combo duplo?', usuario: 'ana_paula', deId: '9001', horas: 1.5 });
    meta.respondeuNoInstagram(recente, pergunta, { texto: 'R$ 39,90, com batata!', usuario: 'casabrasa', deId: ig });
    const golpe = meta.comentouNoInstagram(recente, { texto: 'Ganhe seguidores grátis no meu perfil', usuario: 'promo_fake', horas: 1 });
    const oculto = meta.comentouNoInstagram(recente, { texto: 'Que delícia 😍', usuario: 'bia', horas: 0.5, oculto: true });
    const reclamacao = meta.comentouNoInstagram(deDezDias, { texto: 'Pedi ontem e veio frio, demorou 1h30', usuario: 'carlos.r', horas: 20 });

    // Antes de ler: a conta ligada, a primeira leitura.
    expect(await rota(e)).toMatchObject({
      state: 'pronta',
      accounts: [{ channel: 'instagram', name: '@casabrasa', situation: 'primeira_leitura', read_at: null }],
      counts: { pedem: 0, ocultar: 0, respondidos: 0, ocultos: 0, todos: 0 },
      items: [],
      refresh: { available: true, next_at: null },
    });

    const agora = new Date();
    expect(await ler(e, agora)).toEqual([{ conta: e.instagram!.id, status: 'ok', posts: 2, lidos: 2, comentarios: 5 }]);
    // Os comentários de cada post da janela, com os campos do Liame, 50 por vez; o token no cabeçalho e a prova do segredo.
    expect(chamadasDosComentarios().map((c) => [c.caminho.split('/').at(-2), c.params.fields, c.params.limit]).sort()).toEqual(
      [
        [recente, CAMPOS_DO_COMENTARIO_NO_INSTAGRAM, '50'],
        [deDezDias, CAMPOS_DO_COMENTARIO_NO_INSTAGRAM, '50'],
      ].sort(),
    );
    expect(meta.defeitos).toEqual([]);

    const r = await rota(e);
    expect(r.accounts).toEqual([{ channel: 'instagram', name: '@casabrasa', situation: 'lido', read_at: agora.toISOString() }]);
    expect(r.counts).toEqual({ pedem: 1, ocultar: 1, respondidos: 1, ocultos: 1, todos: 4 });
    // A ordem: o que pede resposta, o para ocultar, o resto, o respondido e o oculto.
    expect(r.items.map((c) => [c.id, c.kind, c.situation])).toEqual([
      [reclamacao, 'reclamacao', 'pede_resposta'],
      [golpe, 'golpe', 'para_ocultar'],
      [pergunta, 'pergunta', 'respondido'],
      [oculto, 'elogio', 'oculto'],
    ]);
    expect(r.items[0]).toMatchObject({ channel: 'instagram', post_id: deDezDias, author: 'carlos.r', kind_source: 'regra', hidden: false, replies: [] });
    expect(r.items[2]!.replies).toEqual([expect.objectContaining({ by_brand: true, author: 'casabrasa', message: 'R$ 39,90, com batata!' })]);
    expect(r.posts.map((p) => [p.id, p.channel, p.kind, p.caption])).toEqual([
      [recente, 'instagram', 'reels', 'Smash duplo saindo da chapa 🔥'],
      [deDezDias, 'instagram', 'foto', 'O combo da semana'],
    ]);

    // O filtro, o canal e a busca.
    expect((await rota(e, '&filter=pedem')).items.map((c) => c.id)).toEqual([reclamacao]);
    expect((await rota(e, '&filter=ocultos')).items.map((c) => c.id)).toEqual([oculto]);
    expect((await rota(e, '&q=COMBO')).items.map((c) => c.id)).toEqual([pergunta]);
    expect((await rota(e, '&q=carlos')).items.map((c) => c.id)).toEqual([reclamacao]);
    expect(await rota(e, '&channel=facebook')).toMatchObject({ counts: { todos: 0 }, items: [], posts: [] });

    // 15 minutos depois: só o post recente é lido de novo. O golpe foi apagado no Instagram: sai daqui. O oculto não voltou
    // na leitura: fica (a documentação não diz se a Meta devolve o oculto).
    const naRede = meta.comentariosNoInstagram.get(recente)!;
    naRede.splice(naRede.findIndex((c) => c.id === golpe), 1);
    naRede.splice(naRede.findIndex((c) => c.id === oculto), 1);
    meta.normalizar();
    const depois = new Date(agora.getTime() + 16 * MIN_MS);
    expect(await ler(e, depois)).toEqual([{ conta: e.instagram!.id, status: 'ok', posts: 2, lidos: 1, comentarios: 2 }]);
    expect(chamadasDosComentarios().map((c) => c.caminho.split('/').at(-2))).toEqual([recente]);
    expect(await guardados(e.instagram!.id)).not.toContain(golpe);
    expect(await guardados(e.instagram!.id)).toContain(oculto);

    // Uma hora depois da primeira: o de 10 dias também.
    meta.normalizar();
    expect(await ler(e, new Date(agora.getTime() + 56 * MIN_MS))).toEqual([{ conta: e.instagram!.id, status: 'ok', posts: 2, lidos: 2, comentarios: 3 }]);

    // O post apagado no Instagram sai com os comentários.
    meta.posts.splice(meta.posts.findIndex((p) => p.id === deDezDias), 1);
    meta.normalizar();
    await ler(e, new Date(agora.getTime() + 72 * MIN_MS));
    expect(await guardados(e.instagram!.id)).not.toContain(reclamacao);
    expect((await rota(e)).posts.map((p) => p.id)).toEqual([recente]);

    // A conta desligada: na volta seguinte da rotina, o que foi lido dela sai.
    await ownerQuery(`update liame.connected_account set disconnected_at = now() where id = $1`, [e.instagram!.id]);
    meta.normalizar();
    expect(await ler(e, new Date(agora.getTime() + 90 * MIN_MS))).toEqual([]);
    expect(meta.chamadas).toEqual([]);
    expect(await guardados(e.instagram!.id)).toEqual([]);
    expect(await rota(e)).toMatchObject({ state: 'sem_conta', items: [] });
  }, 120_000);

  it('a função desligada: a conta espera um dia, sem chamar a Meta, e a rota diz "desligada"', async () => {
    const e = await empresa('Casa Brasa Comentários Desligados', { pagina: false, ligada: false });
    meta.publicadoForaDoLiame(e.instagram!.externo, { caption: 'Combo', comments_count: 1 });
    const agora = new Date();
    expect(await ler(e, agora)).toEqual([{ conta: e.instagram!.id, status: 'desligada' }]);
    expect(meta.chamadas).toEqual([]);
    const s = await estado(e.instagram!.id);
    expect([s!.last_success_at, s!.last_error, new Date(String(s!.cursor.proxima)).getTime()]).toEqual([null, null, agora.getTime() + DIA_MS]);
    expect(s!.cursor.lendo).toBeUndefined();
    expect(await rota(e)).toEqual({
      brand_id: e.brandId,
      state: 'desligada',
      accounts: [],
      counts: { pedem: 0, ocultar: 0, respondidos: 0, ocultos: 0, todos: 0 },
      items: [],
      posts: [],
      refresh: { available: false, next_at: null },
    });
    // Sem Instagram nem Página na marca.
    const sem = await empresa('Casa Brasa Comentários Sem Conta', { pagina: false, instagram: false });
    expect(await rota(sem)).toMatchObject({ state: 'sem_conta', accounts: [], items: [] });
  }, 120_000);

  it('sem a permissão de ler os comentários: sem_permissao, um dia; a falha de um post deixa só ele para a próxima vez', async () => {
    const e = await empresa('Casa Brasa Comentários Permissão', { pagina: false });
    const post = meta.publicadoForaDoLiame(e.instagram!.externo, { caption: 'Combo', comments_count: 1 });
    meta.comentouNoInstagram(post, { texto: 'Abre hoje?' });
    meta.semPermissaoDeComentarios = true;
    const agora = new Date();
    expect((await ler(e, agora))[0]).toMatchObject({ status: 'sem_permissao' });
    const s = await estado(e.instagram!.id);
    expect(s!.cursor).toMatchObject({ falha: 'permissao', falhas_seguidas: 1, proxima: new Date(agora.getTime() + DIA_MS).toISOString() });
    expect(s!.cursor.lendo).toBeUndefined();
    expect(await rota(e)).toMatchObject({ accounts: [{ situation: 'sem_permissao' }], items: [] });

    // A falha passageira num post: o outro é lido, e o que falhou fica para a próxima vez.
    meta.normalizar();
    const p = await empresa('Casa Brasa Comentários Passageira', { pagina: false });
    const a = meta.publicadoForaDoLiame(p.instagram!.externo, { caption: 'A', horas: 3, comments_count: 1 });
    const b = meta.publicadoForaDoLiame(p.instagram!.externo, { caption: 'B', horas: 2, comments_count: 1 });
    const deA = meta.comentouNoInstagram(a, { texto: 'Abre hoje?' });
    const deB = meta.comentouNoInstagram(b, { texto: 'Qual o valor?' });
    meta.falhas.set('comments', [{ status: 503, corpo: { error: { message: 'Service temporarily unavailable', type: 'OAuthException', code: 2, fbtrace_id: 't' } } }]);
    expect(await ler(p, agora)).toEqual([{ conta: p.instagram!.id, status: 'ok', posts: 2, lidos: 1, comentarios: 1 }]);
    // A lista vem do mais novo (B) ao mais velho (A): o primeiro pedido (B) falhou.
    expect(await guardados(p.instagram!.id)).toEqual([deA]);
    const lidoEm = await ownerQuery<{ post_id: string; comments_read_at: Date | null }>(`select post_id, comments_read_at from liame.social_comment_post where connected_account_id = $1`, [p.instagram!.id]);
    expect(lidoEm.find((x) => x.post_id === b)!.comments_read_at).toBeNull();
    meta.normalizar();
    await ler(p, new Date(agora.getTime() + 16 * MIN_MS));
    expect((await guardados(p.instagram!.id)).sort()).toEqual([deA, deB].sort());
  }, 120_000);

  it('a Página: sem a tarefa de moderar, sem_permissao; com ela, os posts publicados, os comentários de todos os níveis e o from que não vem', async () => {
    const e = await empresa('Casa Brasa Comentários Página', { instagram: false });
    const pagina = e.pagina!.externo;
    meta.paginas.set(pagina, ['CREATE_CONTENT']);
    const post = meta.postouNaPagina(pagina, { message: 'Sexta tem combo em dobro', horas: 3 });
    meta.postouNaPagina(pagina, { message: 'Agendado', horas: 1, publicado: false });
    meta.postouNaPagina(pagina, { message: 'Antigo', horas: 40 * 24 });
    const pergunta = meta.comentouNaPagina(post, { message: 'Vocês abrem no feriado?' });
    meta.comentouNaPagina(post, { message: 'Abrimos sim, das 18h às 23h', deId: pagina, nome: 'Casa Brasa', pai: pergunta });
    const agora = new Date();
    expect((await ler(e, agora))[0]).toMatchObject({ status: 'sem_permissao' });
    expect((await estado(e.pagina!.id))!.last_error).toContain('moderar');
    expect(await rota(e)).toMatchObject({ accounts: [{ channel: 'facebook', name: 'Casa Brasa', situation: 'sem_permissao' }], items: [] });

    // Com a tarefa de moderar (no dia seguinte, a vez da conta).
    meta.paginas.set(pagina, ['CREATE_CONTENT', 'MODERATE']);
    meta.normalizar();
    const amanha = new Date(agora.getTime() + DIA_MS + MIN_MS);
    expect(await ler(e, amanha)).toEqual([{ conta: e.pagina!.id, status: 'ok', posts: 1, lidos: 1, comentarios: 2 }]);
    const pedido = chamadasDosComentarios();
    expect(pedido.map((c) => [c.caminho.split('/').at(-2), c.params.filter, c.params.fields, c.params.limit])).toEqual([[post, 'stream', CAMPOS_DO_COMENTARIO_NA_PAGINA, '100']]);
    expect(meta.defeitos).toEqual([]);
    const r = await rota(e);
    // O from de quem comentou não veio (o pior caso): sem o nome; a resposta da Página conta como resposta da marca.
    expect(r.items).toEqual([
      expect.objectContaining({ id: pergunta, channel: 'facebook', author: null, kind: 'pergunta', situation: 'respondido', replies: [expect.objectContaining({ by_brand: true, author: 'Casa Brasa' })] }),
    ]);
    expect(r.posts).toEqual([expect.objectContaining({ id: post, channel: 'facebook', kind: null, caption: 'Sexta tem combo em dobro' })]);
    expect(r.posts[0]!.thumbnail_url).toContain('fbcdn.net');

    // Quando a Página manda o from: o nome de quem comentou.
    meta.paginaDevolveQuemComentou = true;
    const elogio = meta.comentouNaPagina(post, { message: 'Melhor hambúrguer da Tijuca', nome: 'Maria Souza' });
    await ler(e, new Date(amanha.getTime() + 16 * MIN_MS));
    expect((await rota(e)).items.find((c) => c.id === elogio)).toMatchObject({ author: 'Maria Souza', kind: 'elogio', situation: 'sem_resposta' });
  }, 120_000);

  it('o "Ler agora": a função desligada, o pedido com todos os posts, de novo antes de 5 minutos e a conta que está sendo lida', async () => {
    const e = await empresa('Casa Brasa Comentários Ler Agora', { pagina: false });
    const pedir = (x: EmpresaComCanais) => api.call('POST', '/v1/comments/refresh', { cookie: x.cookie, body: { brand_id: x.brandId } });
    await ligarFlagDaEmpresa(api, 'comentarios', e.tenantId, false);
    const desligada = await pedir(e);
    expect(desligada.status, JSON.stringify(desligada.body)).toBe(409);
    expect(desligada.body).toMatchObject({ code: 'funcao-desligada' });
    await ligarFlagDaEmpresa(api, 'comentarios', e.tenantId, true);

    // A primeira leitura: os dois posts; 16 minutos depois, o de 10 dias não é devido.
    const ig = e.instagram!.externo;
    meta.publicadoForaDoLiame(ig, { caption: 'Recente', horas: 2, comments_count: 0 });
    const antigo = meta.publicadoForaDoLiame(ig, { caption: 'Dez dias', horas: 10 * 24, comments_count: 1 });
    meta.comentouNoInstagram(antigo, { texto: 'Qual o valor do combo?' });
    const agora = new Date();
    await ler(e, agora);

    const pedido = await pedir(e);
    expect(pedido.status, JSON.stringify(pedido.body)).toBe(202);
    expect(pedido.body).toMatchObject({ accounts: 1 });
    expect((await estado(e.instagram!.id))!.cursor).toMatchObject({ tudo: true });
    const de = await rota(e);
    // A janela é fixa, alinhada ao relógio (V70): a próxima vez é o fim da janela de 5 minutos em que o pedido caiu.
    expect(de.refresh.available).toBe(false);
    expect(new Date(de.refresh.next_at!).getTime()).toBeGreaterThan(Date.now());
    expect(new Date(de.refresh.next_at!).getTime()).toBeLessThanOrEqual(Date.now() + 5 * MIN_MS);
    // De novo agora: 429, com a espera.
    const deNovo = await pedir(e);
    expect(deNovo.status, JSON.stringify(deNovo.body)).toBe(429);
    expect(deNovo.body).toMatchObject({ code: 'leitura-recente' });
    expect(Number(deNovo.headers.get('retry-after'))).toBeGreaterThan(0);
    // O worker pega na volta seguinte, com todos os posts (o de 10 dias também, lido há pouco).
    meta.normalizar();
    expect(await ler(e, new Date(agora.getTime() + 2 * MIN_MS))).toEqual([{ conta: e.instagram!.id, status: 'ok', posts: 2, lidos: 2, comentarios: 1 }]);
    expect((await estado(e.instagram!.id))!.cursor.tudo).toBeUndefined();

    // A conta que está sendo lida (a reserva marcada): o "Ler agora" não mexe nela.
    const lendo = await empresa('Casa Brasa Comentários Lendo', { pagina: false });
    await ler(lendo, agora);
    const futuro = new Date(Date.now() + 20 * MIN_MS).toISOString();
    await ownerQuery(`update liame.sync_state set cursor = jsonb_build_object('proxima', $2::text, 'lendo', now()::text) where connected_account_id = $1 and dataset = 'comentarios'`, [lendo.instagram!.id, futuro]);
    expect((await pedir(lendo)).status).toBe(202);
    expect((await estado(lendo.instagram!.id))!.cursor).toMatchObject({ proxima: futuro });
    expect((await estado(lendo.instagram!.id))!.cursor.tudo).toBeUndefined();
  }, 120_000);

  it('o expurgo: o comentário sai 90 dias depois de feito, e o post antigo sem comentário guardado sai junto', async () => {
    const e = await empresa('Casa Brasa Comentários Expurgo', { pagina: false });
    const conta = e.instagram!.id;
    const post = (id: string, dias: number) =>
      ownerQuery(
        `insert into liame.social_comment_post (connected_account_id, tenant_id, brand_id, post_id, channel, published_at) values ($1, $2, $3, $4, 'instagram', now() - make_interval(days => $5))`,
        [conta, e.tenantId, e.brandId, id, dias],
      );
    const comentario = (id: string, postId: string, dias: number) =>
      ownerQuery(
        `insert into liame.social_comment (connected_account_id, tenant_id, brand_id, comment_id, post_id, channel, message, published_at) values ($1, $2, $3, $4, $5, 'instagram', 'oi', now() - make_interval(days => $6))`,
        [conta, e.tenantId, e.brandId, id, postId, dias],
      );
    await post('7001', 100);
    await comentario('8001', '7001', 95);
    await post('7002', 100);
    await comentario('8002', '7002', 91);
    await comentario('8003', '7002', 85);
    await post('7003', 20);
    await comentario('8004', '7003', 19);
    const purge = new LifecyclePurgeService(database, api.app.get(VaultService), api.app.get(Mailer));
    const counts = await purge.purgeRetention({ tenantIds: [e.tenantId], userIds: [e.userId] });
    expect(counts).toMatchObject({ comentario: 2, post_comentado: 1 });
    expect(await guardados(conta)).toEqual(['8003', '8004']);
    expect((await ownerQuery<{ post_id: string }>(`select post_id from liame.social_comment_post where connected_account_id = $1 order by post_id`, [conta])).map((p) => p.post_id)).toEqual(['7002', '7003']);
  }, 120_000);

  it('o banco recusa o que está fora do desenho (V119), e a rota não abre a marca de outra empresa', async () => {
    const e = await empresa('Casa Brasa Comentários Banco', { pagina: false });
    const conta = e.instagram!.id;
    const inserirPost = (o: Record<string, unknown>) =>
      ownerQuery(
        `insert into liame.social_comment_post (connected_account_id, tenant_id, brand_id, post_id, channel, kind, caption, permalink, thumbnail_url, comment_count, published_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now())`,
        [conta, e.tenantId, e.brandId, o.post_id ?? randomUUID().slice(0, 18), o.channel ?? 'instagram', o.kind ?? null, o.caption ?? '', o.permalink ?? null, o.thumbnail_url ?? null, o.comment_count ?? null],
      );
    const recusaPost = async (o: Record<string, unknown>, restricao: string) => {
      await expect(inserirPost(o), restricao).rejects.toMatchObject({ constraint: restricao });
    };
    // O que passa: cada regra no limite, e os opcionais nulos.
    await inserirPost({ post_id: 'p'.repeat(80), kind: 'reels', caption: 'a'.repeat(2200), permalink: 'x'.repeat(500), thumbnail_url: 't'.repeat(2000), comment_count: 0 });
    await inserirPost({ post_id: 'base', channel: 'facebook' });
    await recusaPost({ post_id: '' }, 'social_comment_post_id');
    await recusaPost({ post_id: 'p'.repeat(81) }, 'social_comment_post_id');
    await recusaPost({ channel: 'tiktok' }, 'social_comment_post_canal');
    await recusaPost({ kind: 'story' }, 'social_comment_post_tipo');
    await recusaPost({ caption: 'a'.repeat(2201) }, 'social_comment_post_legenda');
    await recusaPost({ permalink: '' }, 'social_comment_post_endereco');
    await recusaPost({ permalink: 'x'.repeat(501) }, 'social_comment_post_endereco');
    await recusaPost({ thumbnail_url: '' }, 'social_comment_post_miniatura');
    await recusaPost({ thumbnail_url: 't'.repeat(2001) }, 'social_comment_post_miniatura');
    await recusaPost({ comment_count: -1 }, 'social_comment_post_contagem');

    const inserir = (o: Record<string, unknown>) =>
      ownerQuery(
        `insert into liame.social_comment (connected_account_id, tenant_id, brand_id, comment_id, post_id, channel, parent_comment_id, author_name, author_key, message,
                                           like_count, reply_count, kind, kind_source, published_at)
         values ($1, $2, $3, $4, 'base', $5, $6, $7, $8, $9, $10, $11, $12, $13, now())`,
        [
          conta,
          e.tenantId,
          e.brandId,
          o.comment_id ?? randomUUID().slice(0, 18),
          o.channel ?? 'instagram',
          o.parent_comment_id ?? null,
          o.author_name ?? null,
          o.author_key ?? null,
          o.message ?? '',
          o.like_count ?? null,
          o.reply_count ?? null,
          o.kind ?? null,
          o.kind_source ?? null,
        ],
      );
    const recusa = async (o: Record<string, unknown>, restricao: string) => {
      await expect(inserir(o), restricao).rejects.toMatchObject({ constraint: restricao });
    };
    await inserir({ comment_id: 'c'.repeat(120), parent_comment_id: 'p'.repeat(120), author_name: 'a'.repeat(200), author_key: 'f'.repeat(64), message: 'm'.repeat(8000), like_count: 0, reply_count: 0, kind: 'golpe', kind_source: 'ia' });
    await inserir({ kind: 'pergunta', kind_source: 'regra' });
    await inserir({});
    await recusa({ comment_id: '' }, 'social_comment_id');
    await recusa({ comment_id: 'c'.repeat(121) }, 'social_comment_id');
    await recusa({ parent_comment_id: '' }, 'social_comment_pai');
    await recusa({ channel: 'tiktok' }, 'social_comment_canal');
    await recusa({ author_name: '' }, 'social_comment_autor');
    await recusa({ author_name: 'a'.repeat(201) }, 'social_comment_autor');
    await recusa({ author_key: 'f'.repeat(63) }, 'social_comment_chave');
    await recusa({ message: 'm'.repeat(8001) }, 'social_comment_texto');
    await recusa({ like_count: -1 }, 'social_comment_numeros');
    await recusa({ reply_count: -1 }, 'social_comment_numeros');
    await recusa({ kind: 'spam', kind_source: 'regra' }, 'social_comment_tipo');
    // O tipo sem quem decidiu, quem decidiu sem o tipo, e quem decidiu fora da lista.
    await recusa({ kind: 'pergunta' }, 'social_comment_quem_decidiu');
    await recusa({ kind_source: 'regra' }, 'social_comment_quem_decidiu');
    await recusa({ kind: 'pergunta', kind_source: 'pessoa' }, 'social_comment_quem_decidiu');

    // A marca de outra empresa: a RLS esconde, 404 (a rota e o "Ler agora").
    const outra = await empresa('Casa Brasa Comentários Outra', { pagina: false });
    const r = await api.call('GET', `/v1/comments?brand_id=${e.brandId}`, { cookie: outra.cookie });
    expect(r.status, JSON.stringify(r.body)).toBe(404);
    const l = await api.call('POST', '/v1/comments/refresh', { cookie: outra.cookie, body: { brand_id: e.brandId } });
    expect(l.status, JSON.stringify(l.body)).toBe(404);
  }, 120_000);
});
