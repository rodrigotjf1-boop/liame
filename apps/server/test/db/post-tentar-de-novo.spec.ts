import type { Database } from '@liame/database';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { BudgetService } from '../../src/actions/budget.service.js';
import { type DependenciasDoPost, postNaPaginaConnector, postNoInstagramConnector } from '../../src/actions/post-publicacao.js';
import { currentStep, totpCode } from '../../src/auth/totp.js';
import { ClienteConector } from '../../src/connectors/cliente-http.js';
import { versaoRegistrada } from '../../src/connectors/tipos.js';
import { DATABASE } from '../../src/database/database.module.js';
import { FlagService } from '../../src/flags/flag.service.js';
import { ARMAZEM_DE_IMAGENS, type ArmazemNaMemoria } from '../../src/imagens/armazem.js';
import { KillSwitchService } from '../../src/kill-switch/kill-switch.service.js';
import { VaultService } from '../../src/vault/vault.service.js';
import { ActionExecutor } from '../../src/worker/action-executor.js';
import { ownerQuery, resetIpRateLimits, startApi, type TestApi } from '../helpers/api.js';
import { InstagramDeMentira, SEGREDO_DO_APP, TOKEN_DO_INSTAGRAM } from '../helpers/instagram-de-mentira.js';
import { ligarFlagDaEmpresa } from '../helpers/meta-de-mentira.js';
import { type EmpresaComCanais, empresaComCanais, fotoGuardada } from '../helpers/posts-semeados.js';
import { hasDb } from './env.js';

// A6 · Z5d, parte 1: "Tentar de novo" no canal que não saiu (P19, aprovado pelo dono em 21/10/2026; D-A6-54), contra o
// Postgres e a Meta de mentira. O que se prova aqui:
//   - o post que saiu no Instagram e não na Página (sem a tarefa de publicar nela) diz em cada canal até quando dá para
//     tentar de novo; corrigido o motivo, "Tentar de novo" põe a Página de volta na espera e faz o pedido da nova
//     tentativa, que nasce aprovado (AUTO, pela pessoa, sem o código do app; a política v10) e passa a ser o pedido do
//     post; o executor publica só na Página, uma vez, e o post fica publicado;
//   - as recusas: o pedido que ainda sai, o prazo de 24 horas que passou, o motivo que pede um post novo, o pacote, o
//     pedido direto pela rota das ações, a trava do `post_publicar` (no pedido, e na execução), a função desligada e a
//     segunda tentativa enquanto a primeira sai; cada recusa deixa o canal como estava.

const LEGENDA = 'Hoje tem smash duplo na Casa Brasa. Peça pelo link da bio.';
const FUSO_DO_PEDIDO = 'America/Sao_Paulo';
const DOIS_CANAIS = [
  { channel: 'instagram', text: LEGENDA },
  { channel: 'facebook', text: 'Hoje tem smash duplo na Casa Brasa. Peça pelo link: liame.link/abc' },
];
/** A frase da foto grande demais para a Página (um motivo que pede um post novo). */
const FOTO_GRANDE = 'A foto deste post passa de 4 MB, o limite da Página do Facebook. O post não saiu na Página do Facebook.';

const diaEmSaoPaulo = (n: number): string =>
  new Intl.DateTimeFormat('en-CA', { timeZone: FUSO_DO_PEDIDO, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(Date.now() + n * 86_400_000));

/** Um fuso em que agora é `hora` no relógio: a janela das 8h às 22h vale a qualquer hora em que o teste roda. */
function fusoComAHora(hora: number): string {
  let diferenca = (hora - new Date().getUTCHours()) % 24;
  if (diferenca < 0) diferenca += 24;
  if (diferenca > 12) diferenca -= 24;
  return diferenca === 0 ? 'Etc/GMT' : `Etc/GMT${diferenca > 0 ? '-' : '+'}${Math.abs(diferenca)}`;
}

describe.skipIf(!hasDb)('"Tentar de novo" no canal que não saiu (A6 · Z5d, parte 1)', () => {
  let api: TestApi;
  let executor: ActionExecutor;
  let armazem: ArmazemNaMemoria;
  const ig = new InstagramDeMentira();

  beforeAll(async () => {
    api = await startApi();
    await resetIpRateLimits();
    await ig.ligar();
    const database: Database = api.app.get(DATABASE);
    executor = new ActionExecutor(database, api.app.get(BudgetService), api.app.get(KillSwitchService), api.app.get(FlagService));
    armazem = api.app.get(ARMAZEM_DE_IMAGENS);
    ig.buscarImagem = (endereco) => {
      const m = /^memoria:\/\/imagens\/(.+)\?valido=\d+$/.exec(endereco);
      return m ? (armazem.objetos.get(m[1]!) ?? null) : null;
    };
    const vault = api.app.get(VaultService);
    const deps: DependenciasDoPost = {
      lerSegredo: (tx, id) => vault.readSecret(tx, id),
      cliente: () => new ClienteConector(database.db, { enderecos: { meta_ads: [ig.base] }, tentativas: 1, balde: { capacidade: 10_000, porSegundo: 1_000 } }),
      graphUrl: ig.base,
      appSecret: SEGREDO_DO_APP,
      versao: (capacidade) => versaoRegistrada(database.db, 'meta_ads', capacidade),
      armazem,
      esperaDoConteinerMs: 0,
      trava: async (tx, alvo) => {
        const t = await api.app.get(KillSwitchService).check(tx, { ...alvo, tool: 'post_publicar' });
        return t ? `${t.level}: ${t.reason}` : null;
      },
    };
    postNoInstagramConnector.ligar(deps);
    postNaPaginaConnector.ligar(deps);
  }, 120_000);
  beforeEach(async () => {
    await resetIpRateLimits();
    ig.normalizar();
  });
  afterAll(async () => {
    await ig.desligar();
    await api?.close();
  });

  /** A empresa com o Instagram e a Página; quem autorizou NÃO pode publicar na Página (só ver os números e anunciar). */
  const semPublicarNaPagina = async (nome: string) => {
    const e = await empresaComCanais(api, nome, { pagina: true, instagram: true, token: TOKEN_DO_INSTAGRAM });
    ig.paginas.set(e.pagina!.externo, ['ANALYZE', 'ADVERTISE']);
    return e;
  };
  const pedidoDe = async (id: string) =>
    (
      await ownerQuery<{ tool: string; status: string; status_reason: string | null; mode: string; actor_type: string; provider: string; account_id: string; plan_hash: string; requested_by: string }>(
        `select tool, status, status_reason, mode, actor_type, provider, account_id, plan_hash, requested_by from liame.action_request where id = $1`,
        [id],
      )
    )[0]!;
  const canalDe = async (post: string, canal: string) =>
    (await ownerQuery<{ status: string; error: string | null; published_at: Date | null }>(`select status, error, published_at from liame.social_post_channel where post_id = $1 and channel = $2`, [post, canal]))[0]!;
  const executar = (e: EmpresaComCanais) => executor.executeBatch(20, { tenantIds: [e.tenantId] });
  const obter = (e: EmpresaComCanais, post: string) => api.call('GET', `/v1/posts/${post}`, { cookie: e.cookie });
  const tentar = (e: EmpresaComCanais, post: string) => api.call('POST', `/v1/posts/${post}/retry`, { cookie: e.cookie });

  /** O post nos dois canais, aprovado com o código do app e na hora de sair (agora são 12h no fuso da empresa). */
  async function postAprovado(e: EmpresaComCanais, foto: string): Promise<{ post: string; pedido: string }> {
    await ownerQuery(`update liame.organization set timezone = $2 where id = $1`, [e.tenantId, FUSO_DO_PEDIDO]);
    const r = await api.call('POST', '/v1/posts', {
      cookie: e.cookie,
      body: { brand_id: e.brandId, photo_id: foto, publish_at: `${diaEmSaoPaulo(1)}T19:00:00-03:00`, channels: DOIS_CANAIS },
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const pedido = r.body.action_id as string;
    await ownerQuery(`update liame.app_user set totp_last_step = null where id = $1`, [e.userId]);
    await ownerQuery(`delete from liame.rate_limit where key = $1`, [`segundo-fator:${e.userId}`]);
    const aprovado = await api.call('POST', `/v1/actions/${pedido}/approve`, {
      cookie: e.cookie,
      body: { plan_hash: (await pedidoDe(pedido)).plan_hash, code: totpCode(e.secret, currentStep()) },
    });
    expect(aprovado.status, JSON.stringify(aprovado.body)).toBe(200);
    // A hora chega: o post e o pedido são de um minuto atrás, e agora são 12h no fuso da empresa (a nova tentativa sai
    // pela hora do post, que já passou).
    const umMinutoAtras = new Date(Date.now() - 60_000).toISOString();
    await ownerQuery(`update liame.organization set timezone = $2 where id = $1`, [e.tenantId, fusoComAHora(12)]);
    await ownerQuery(`update liame.social_post set publish_at = $2::timestamptz where id = $1`, [r.body.id, umMinutoAtras]);
    await ownerQuery(`update liame.action_request set next_attempt_at = now() - interval '1 second', before_state = jsonb_set(before_state, '{hora}', to_jsonb($2::text)) where id = $1`, [
      pedido,
      umMinutoAtras,
    ]);
    return { post: r.body.id as string, pedido };
  }

  /** O post que saiu no Instagram e não na Página. */
  async function emParte(nome: string): Promise<{ e: EmpresaComCanais; post: string; pedido: string }> {
    const e = await semPublicarNaPagina(nome);
    const foto = await fotoGuardada(e, armazem, { largura: 1600, altura: 1200 });
    const { post, pedido } = await postAprovado(e, foto.id);
    expect(await executar(e)).toBe(1);
    expect([(await canalDe(post, 'instagram')).status, (await canalDe(post, 'facebook')).status]).toEqual(['publicado', 'falhou']);
    return { e, post, pedido };
  }

  it('o post em parte: a Página corrigida, "Tentar de novo" sai só nela, uma vez, sem o código, e o post fica publicado', async () => {
    const { e, post, pedido } = await emParte('Brasa Tenta De Novo');
    const antes = await obter(e, post);
    expect(antes.body.status).toBe('em_parte');
    const saiuNoIg = (await canalDe(post, 'instagram')).published_at!;
    const [noIg, naPagina] = antes.body.channels as Array<{ channel: string; retry_until: string | null; error: string | null }>;
    expect(noIg!.retry_until).toBeNull();
    // Até 24 horas depois de o post sair no Instagram.
    expect(naPagina!.retry_until).toBe(new Date(new Date(saiuNoIg).getTime() + 24 * 3_600_000).toISOString());
    expect(naPagina!.error).toMatch(/^A Meta não deixou o Liame publicar nesta Página/);

    // A pessoa corrige (a tarefa de publicar na Página) e tenta de novo.
    ig.paginas.set(e.pagina!.externo, ['CREATE_CONTENT', 'MODERATE']);
    const r = await tentar(e, post);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.status).toBe('publicando');
    expect(r.body.action_id).not.toBe(pedido);
    expect((r.body.channels as Array<{ channel: string; status: string; error: string | null; retry_until: string | null }>).map((c) => [c.channel, c.status, c.error, c.retry_until])).toEqual([
      ['instagram', 'publicado', null, null],
      ['facebook', 'aguardando', null, null],
    ]);
    // O pedido novo: a nova tentativa, aprovada pela pessoa sem o código (AUTO, a política v10), pela conta da Página.
    const novo = await pedidoDe(r.body.action_id);
    expect(novo).toMatchObject({ tool: 'post_tentar_de_novo', status: 'aprovada', mode: 'AUTO', actor_type: 'human', provider: 'facebook_page', account_id: e.pagina!.id, requested_by: e.userId });
    const doPedido = await api.call('GET', `/v1/actions/${r.body.action_id}`, { cookie: e.cookie });
    expect(doPedido.body.policy.versions[0]).toBe('plataforma@10');
    const [ev] = await ownerQuery<{ before: Record<string, unknown>; after: Record<string, unknown> }>(
      `select before, after from liame.audit_event where tenant_id = $1 and action = 'posts.tentar_de_novo'`,
      [e.tenantId],
    );
    expect(ev).toMatchObject({ before: { canal: 'facebook', situacao: 'falhou', action_id: pedido }, after: { canal: 'facebook', situacao: 'aguardando', action_id: r.body.action_id } });

    // O executor publica só na Página, uma vez; o Instagram não sai de novo.
    expect(await executar(e)).toBe(1);
    expect((await pedidoDe(r.body.action_id)).status).toBe('executada');
    expect((await pedidoDe(pedido)).status).toBe('falhou');
    expect(ig.postsDe(e.instagram!.externo)).toHaveLength(1);
    expect(ig.fotosDe(e.pagina!.externo)).toHaveLength(1);
    const depois = await obter(e, post);
    expect(depois.body.status).toBe('publicado');
    expect((depois.body.channels as Array<{ status: string; retry_until: string | null }>).map((c) => [c.status, c.retry_until])).toEqual([
      ['publicado', null],
      ['publicado', null],
    ]);
    // Sem nada a tentar: 409.
    expect(await tentar(e, post)).toMatchObject({ status: 409, body: { code: 'post-ja-saiu' } });
  });

  it('as recusas deixam o canal como estava: o pedido que ainda sai, o prazo, o motivo que pede post novo, o pacote e o pedido direto', async () => {
    // O pedido aprovado que ainda espera a hora.
    const a = await semPublicarNaPagina('Brasa Ainda Sai');
    const fotoA = await fotoGuardada(a, armazem, { largura: 1600, altura: 1200 });
    const agendado = await postAprovado(a, fotoA.id);
    expect(await tentar(a, agendado.post)).toMatchObject({ status: 409, body: { code: 'post-ainda-sai' } });

    // O prazo de 24 horas: o post saiu no Instagram há 25 horas.
    const { e, post } = await emParte('Brasa Passou O Prazo');
    ig.paginas.set(e.pagina!.externo, ['CREATE_CONTENT', 'MODERATE']);
    await ownerQuery(`update liame.social_post_channel set published_at = now() - interval '25 hours' where post_id = $1 and channel = 'instagram'`, [post]);
    expect((await obter(e, post)).body.channels[1].retry_until).toBeNull();
    const prazo = await tentar(e, post);
    expect(prazo).toMatchObject({ status: 409, body: { code: 'prazo-da-tentativa' } });
    expect(prazo.body.detail).toBe('Já passou um dia desde que o post saiu no Instagram: a hora mudaria quem vê o post. Para publicar na Página do Facebook, faça um post novo.');

    // O motivo que pede um post novo (a foto grande demais para a Página).
    await ownerQuery(`update liame.social_post_channel set published_at = now(), updated_at = now() where post_id = $1 and channel = 'instagram'`, [post]);
    await ownerQuery(`update liame.social_post_channel set error = $2 where post_id = $1 and channel = 'facebook'`, [post, FOTO_GRANDE]);
    expect((await obter(e, post)).body.channels[1].retry_until).toBeNull();
    expect(await tentar(e, post)).toMatchObject({ status: 409, body: { code: 'tentar-nao-adianta' } });
    expect(await canalDe(post, 'facebook')).toMatchObject({ status: 'falhou', error: FOTO_GRANDE });

    // O pacote, quem publica é a pessoa. Ele nasce no fuso de São Paulo, como o post do teste: no fuso "de agora são 12h",
    // as 19h de amanhã em São Paulo caem fora das 8h às 22h em parte do dia (ERR-190).
    await ownerQuery(`update liame.organization set timezone = $2 where id = $1`, [e.tenantId, FUSO_DO_PEDIDO]);
    const pacote = await api.call('POST', '/v1/posts', {
      cookie: e.cookie,
      body: { brand_id: e.brandId, photo_id: (await fotoGuardada(e, armazem, { largura: 1080, altura: 1080 })).id, publish_at: `${diaEmSaoPaulo(1)}T19:00:00-03:00`, channels: [{ channel: 'tiktok', text: 'Smash duplo 🍔' }] },
    });
    expect(pacote.status, JSON.stringify(pacote.body)).toBe(201);
    expect(await tentar(e, pacote.body.id)).toMatchObject({ status: 409, body: { code: 'e-pacote' } });

    // A ferramenta não se pede direto, pela rota das ações.
    await ownerQuery(`update liame.social_post_channel set error = null, status = 'aguardando' where post_id = $1 and channel = 'facebook'`, [post]);
    const direto = await api.call('POST', '/v1/actions', {
      cookie: e.cookie,
      body: { tool: 'post_tentar_de_novo', brand_id: e.brandId, provider: 'facebook_page', account_id: e.pagina!.id, resource_id: `post:${post}`, params: {} },
    });
    expect(direto).toMatchObject({ status: 422, body: { code: 'acao-so-como-nova-tentativa' } });
    expect(await api.call('GET', '/v1/posts/00000000-0000-7000-8000-000000000999', { cookie: e.cookie })).toMatchObject({ status: 404 });
  });

  it('a trava do post_publicar para a nova tentativa, no pedido e na execução; a função desligada; a segunda tentativa enquanto a primeira sai', async () => {
    const { e, post } = await emParte('Brasa Travada');
    ig.paginas.set(e.pagina!.externo, ['CREATE_CONTENT', 'MODERATE']);

    // A trava da ferramenta de publicar o post vale para a nova tentativa: 423, e o canal fica como estava.
    const trava = await api.call('POST', '/v1/kill-switches', { cookie: e.cookie, body: { level: 'tool', tool: 'post_publicar', reason: 'conferindo as fotos' } });
    expect(trava.status, JSON.stringify(trava.body)).toBe(201);
    expect(await tentar(e, post)).toMatchObject({ status: 423, body: { code: 'parada-acionada' } });
    expect((await canalDe(post, 'facebook')).status).toBe('falhou');
    expect(await ownerQuery(`select 1 from liame.action_request where tenant_id = $1 and tool = 'post_tentar_de_novo'`, [e.tenantId])).toHaveLength(0);
    await api.call('DELETE', `/v1/kill-switches/${trava.body.id}`, { cookie: e.cookie });

    // A segunda tentativa enquanto a primeira ainda não saiu: 409.
    const r = await tentar(e, post);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(await tentar(e, post)).toMatchObject({ status: 409, body: { code: 'post-ainda-sai' } });

    // A trava ligada depois do pedido barra a execução; o post volta a "em parte" e dá para tentar de novo.
    const depois = await api.call('POST', '/v1/kill-switches', { cookie: e.cookie, body: { level: 'tool', tool: 'post_publicar', reason: 'parei de novo' } });
    expect(depois.status).toBe(201);
    expect(await executar(e)).toBe(1);
    expect(await pedidoDe(r.body.action_id)).toMatchObject({ status: 'falhou', status_reason: 'trava ativa (tool): parei de novo' });
    expect(ig.fotosDe(e.pagina!.externo)).toHaveLength(0);
    const travado = await obter(e, post);
    expect(travado.body.status).toBe('em_parte');
    expect(travado.body.channels[1].retry_until).not.toBeNull();
    await api.call('DELETE', `/v1/kill-switches/${depois.body.id}`, { cookie: e.cookie });

    // A função desligada: 409, antes de tudo.
    await ligarFlagDaEmpresa(api, 'social_write', e.tenantId, false);
    expect(await tentar(e, post)).toMatchObject({ status: 409, body: { code: 'funcao-desligada' } });
    await ligarFlagDaEmpresa(api, 'social_write', e.tenantId, true);
    const outra = await tentar(e, post);
    expect(outra.status, JSON.stringify(outra.body)).toBe(200);
    expect(await executar(e)).toBe(1);
    expect((await obter(e, post)).body.status).toBe('publicado');
    expect(ig.fotosDe(e.pagina!.externo)).toHaveLength(1);
  });
});
