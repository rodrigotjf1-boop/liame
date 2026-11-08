import { resolve } from 'node:path';
import { type Database, runMigrations } from '@liame/database';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { BudgetService } from '../../src/actions/budget.service.js';
import { comentarioNaPaginaConnector, comentarioNoInstagramConnector, type DependenciasDoComentario } from '../../src/actions/comentario-na-rede.js';
import { currentStep, totpCode } from '../../src/auth/totp.js';
import { APP_CONFIG, type AppConfig } from '../../src/config.js';
import { ClienteConector } from '../../src/connectors/cliente-http.js';
import { versaoRegistrada } from '../../src/connectors/tipos.js';
import { DATABASE } from '../../src/database/database.module.js';
import { FlagService } from '../../src/flags/flag.service.js';
import { KillSwitchService } from '../../src/kill-switch/kill-switch.service.js';
import { VaultService } from '../../src/vault/vault.service.js';
import { ActionExecutor } from '../../src/worker/action-executor.js';
import { ComentariosLoop } from '../../src/worker/comentarios-loop.js';
import { ownerQuery, resetIpRateLimits, startApi, type TestApi } from '../helpers/api.js';
import { InstagramDeMentira, SEGREDO_DO_APP, TOKEN_DO_INSTAGRAM } from '../helpers/instagram-de-mentira.js';
import { ligarFlagDaEmpresa } from '../helpers/meta-de-mentira.js';
import { type EmpresaComCanais, empresaComCanais } from '../helpers/posts-semeados.js';
import { hasDb, OWNER_URL } from './env.js';

// A6 · Z11, parte 2: responder, apagar a resposta, ocultar e mostrar um comentário pelo trilho (migration 0124; P38,
// D-A6-88, D-A6-89 e D-A6-91), da leitura à rede, pela API e contra a Meta local (as escritas do comentário pelas
// referências lidas em 07/11/2026). O que se prova:
//   - no Instagram: a resposta só sai com a aprovação de uma pessoa, com o código do app; o que sai é o texto aprovado,
//     uma vez (a volta da Meta que se perde não faz a resposta sair duas vezes); a resposta aparece na tela Comentários;
//     o pedido não guarda o texto do comentário nem o @ de quem comentou; apagar a resposta pelo desfazer é direto;
//   - as duas flags (a do conector, `social_write`, e a da ferramenta, `comentarios_responder`), cada uma desligada;
//     o texto que não passa (a compensação prometida, o nome de quem comentou); o comentário oculto; o que o Liame não leu;
//   - o comentário que mudou depois do pedido não é respondido;
//   - ocultar com o código, e mostrar de novo (a volta) também com o código;
//   - na Página: sem a tarefa de moderar, o pedido não nasce; com ela, a resposta sai pelo token da Página.

const RESPOSTA = 'O combo duplo sai por R$ 39,90 no cardápio. Peça pelo link da bio!';

type Pedido = { id: string; plan_hash: string; status: string };

describe.skipIf(!hasDb)('responder e ocultar comentários pelo trilho (A6 · Z11, parte 2)', () => {
  let api: TestApi;
  let loop: ComentariosLoop;
  let executor: ActionExecutor;
  const meta = new InstagramDeMentira();

  beforeAll(async () => {
    await runMigrations({ connectionString: OWNER_URL, dir: resolve(process.cwd(), '../../packages/database/migrations') });
    api = await startApi();
    await resetIpRateLimits();
    await meta.ligar();
    const config: AppConfig = api.app.get(APP_CONFIG);
    const database: Database = api.app.get(DATABASE);
    const vault = api.app.get(VaultService);
    const flags = api.app.get(FlagService);
    loop = new ComentariosLoop(database, { ...config, plataformas: { ...config.plataformas, metaGraphUrl: meta.base, metaAppSecret: SEGREDO_DO_APP } }, vault, flags);
    executor = new ActionExecutor(database, api.app.get(BudgetService), api.app.get(KillSwitchService), flags);
    // O conector do comentário, como o provedor da subida o liga (`escrita-posts.provider.ts`), apontando para a Meta local.
    const deps: DependenciasDoComentario = {
      lerSegredo: (tx, id) => vault.readSecret(tx, id),
      cliente: (tempoLimiteMs) =>
        new ClienteConector(database.db, { enderecos: { meta_ads: [meta.base] }, tentativas: 1, balde: { capacidade: 10_000, porSegundo: 1_000 }, ...(tempoLimiteMs ? { tempoLimiteMs } : {}) }),
      graphUrl: meta.base,
      appSecret: SEGREDO_DO_APP,
      versao: (capacidade) => versaoRegistrada(database.db, 'meta_ads', capacidade),
    };
    comentarioNoInstagramConnector.ligar(deps);
    comentarioNaPaginaConnector.ligar(deps);
  }, 120_000);
  beforeEach(async () => {
    await resetIpRateLimits();
    meta.normalizar();
  });
  afterAll(async () => {
    await meta.desligar();
    await api?.close();
  });

  async function empresa(nome: string, o: { instagram?: boolean; pagina?: boolean; escrita?: boolean } = {}): Promise<EmpresaComCanais> {
    const e = await empresaComCanais(api, nome, { token: TOKEN_DO_INSTAGRAM, instagram: o.instagram ?? true, pagina: o.pagina ?? false });
    await ligarFlagDaEmpresa(api, 'comentarios', e.tenantId, true);
    await ligarFlagDaEmpresa(api, 'comentarios_responder', e.tenantId, o.escrita ?? true);
    return e;
  }
  const ler = (e: EmpresaComCanais, agora = new Date()) => loop.executarLote(10, { tenantIds: [e.tenantId] }, agora);
  const conta = (e: EmpresaComCanais, provider: 'instagram' | 'facebook_page') => (provider === 'instagram' ? e.instagram!.id : e.pagina!.id);
  const pedir = (e: EmpresaComCanais, tool: string, comentario: string, params: Record<string, unknown> = {}, provider: 'instagram' | 'facebook_page' = 'instagram') =>
    api.call('POST', '/v1/actions', { cookie: e.cookie, body: { tool, provider, account_id: conta(e, provider), resource_id: `comentario:${comentario}`, params } });
  /** O código do app de agora (o passo usado e o limite de tentativas são zerados: o teste aprova mais de uma vez). */
  async function codigo(e: EmpresaComCanais): Promise<string> {
    await ownerQuery(`update liame.app_user set totp_last_step = null where id = $1`, [e.userId]);
    await ownerQuery(`delete from liame.rate_limit where key = $1`, [`segundo-fator:${e.userId}`]);
    return totpCode(e.secret, currentStep());
  }
  const aprovar = async (e: EmpresaComCanais, p: Pedido) => api.call('POST', `/v1/actions/${p.id}/approve`, { cookie: e.cookie, body: { plan_hash: p.plan_hash, code: await codigo(e) } });
  const ciclo = (e: EmpresaComCanais) => executor.runCycle(20, { tenantIds: [e.tenantId] });
  /** A próxima tentativa do pedido adiado vem agora (o executor só pega o que venceu). */
  const vencer = (id: string) => ownerQuery(`update liame.action_request set next_attempt_at = now() - interval '1 second' where id = $1`, [id]);
  const ver = async (e: EmpresaComCanais, id: string) => (await api.call('GET', `/v1/actions/${id}`, { cookie: e.cookie })).body as Record<string, unknown>;
  const situacaoNaTela = async (e: EmpresaComCanais, id: string) => {
    const r = await api.call('GET', `/v1/comments?brand_id=${e.brandId}`, { cookie: e.cookie });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    return (r.body.items as Array<{ id: string; situation: string; replies: Array<{ by_brand: boolean; message: string }> }>).find((c) => c.id === id);
  };

  /** Uma empresa com o Instagram, um post recente e uma pergunta de outra pessoa, já lida pela rotina. */
  async function comPergunta(nome: string, o: { escrita?: boolean } = {}) {
    const e = await empresa(nome, o);
    const post = meta.publicadoForaDoLiame(e.instagram!.externo, { caption: 'Smash duplo', horas: 2, comments_count: 1 });
    const pergunta = meta.comentouNoInstagram(post, { texto: 'Quanto custa o combo duplo?', usuario: 'ana_paula', deId: '9001', horas: 1 });
    expect((await ler(e))[0]).toMatchObject({ status: 'ok', comentarios: 1 });
    meta.normalizar();
    return { e, post, pergunta };
  }

  it('no Instagram: a resposta sai uma vez, só com o código do app, e o desfazer apaga direto', async () => {
    const { e, post, pergunta } = await comPergunta('Casa Brasa Responder Comentário');
    const p = await pedir(e, 'comentario_responder', pergunta, { texto: RESPOSTA });
    expect(p.status, JSON.stringify(p.body)).toBe(201);
    expect(p.body).toMatchObject({ tool: 'comentario_responder', status: 'aguardando_aprovacao' });
    // O pedido não guarda o texto do comentário nem o @ de quem comentou.
    const linha = (await ownerQuery<{ todo: string }>(`select row_to_json(a)::text as todo from liame.action_request a where id = $1`, [p.body.id]))[0]!.todo;
    expect(linha).not.toContain('Quanto custa');
    expect(linha).not.toContain('ana_paula');
    // Sem aprovação, nada sai.
    await ciclo(e);
    expect(meta.comentariosNoInstagram.get(post)![0]!.respostas).toEqual([]);

    expect((await aprovar(e, p.body as Pedido)).status).toBe(200);
    // A Meta cria a resposta e a volta se perde: o pedido espera a próxima tentativa, que lê antes e não manda de novo.
    meta.perderARespostaDoComentario = true;
    await ciclo(e);
    expect(await ver(e, p.body.id)).toMatchObject({ status: 'aprovada' });
    await vencer(p.body.id);
    await ciclo(e);
    expect(await ver(e, p.body.id)).toMatchObject({ status: 'executada' });
    const respostas = meta.comentariosNoInstagram.get(post)![0]!.respostas;
    expect(respostas.map((r) => [r.text, r.deId])).toEqual([[RESPOSTA, e.instagram!.externo]]);
    expect(meta.defeitos).toEqual([]);
    // A tela Comentários mostra a resposta sem esperar a leitura.
    expect(await situacaoNaTela(e, pergunta)).toMatchObject({ situation: 'respondido', replies: [{ by_brand: true, message: RESPOSTA }] });

    // O desfazer apaga a resposta direto (a pessoa confirma na tela), sem o código.
    const volta = await api.call('POST', `/v1/actions/${p.body.id}/undo`, { cookie: e.cookie });
    expect(volta.status, JSON.stringify(volta.body)).toBe(201);
    expect(volta.body).toMatchObject({ tool: 'comentario_apagar_resposta', status: 'aprovada' });
    await ciclo(e);
    expect(await ver(e, volta.body.id)).toMatchObject({ status: 'executada' });
    expect(meta.comentariosNoInstagram.get(post)![0]!.respostas).toEqual([]);
    expect(await situacaoNaTela(e, pergunta)).toMatchObject({ situation: 'pede_resposta', replies: [] });
  }, 120_000);

  it('as duas flags, o texto que não passa, o comentário oculto e o que o Liame não leu: o pedido não nasce', async () => {
    const desligada = await comPergunta('Casa Brasa Comentário Sem Escrita', { escrita: false });
    const semEscrita = await pedir(desligada.e, 'comentario_responder', desligada.pergunta, { texto: RESPOSTA });
    expect([semEscrita.status, semEscrita.body.code]).toEqual([403, 'escrita-desligada']);
    expect(meta.chamadas).toEqual([]);
    // Com a da ferramenta e sem a do conector (a dos posts).
    await ligarFlagDaEmpresa(api, 'comentarios_responder', desligada.e.tenantId, true);
    await ligarFlagDaEmpresa(api, 'social_write', desligada.e.tenantId, false);
    const semPosts = await pedir(desligada.e, 'comentario_responder', desligada.pergunta, { texto: RESPOSTA });
    expect([semPosts.status, semPosts.body.code]).toEqual([403, 'escrita-desligada']);
    expect(meta.chamadas).toEqual([]);

    const { e, post, pergunta } = await comPergunta('Casa Brasa Comentário Recusas');
    const promete = await pedir(e, 'comentario_responder', pergunta, { texto: 'Desculpe! Vamos te dar um desconto no próximo pedido.' });
    expect([promete.status, promete.body.code]).toEqual([422, 'plano-recusado']);
    expect(promete.body.detail).toContain('compensação');
    const comONome = await pedir(e, 'comentario_responder', pergunta, { texto: 'Oi, Ana! O combo sai por R$ 39,90.' });
    expect([comONome.status, comONome.body.code]).toEqual([422, 'plano-recusado']);
    expect(comONome.body.detail).toContain('o nome de quem comentou');
    // O comentário que a rotina não leu não é alcançado.
    const outro = meta.comentouNoInstagram(post, { texto: 'Abre hoje?' });
    expect((await pedir(e, 'comentario_responder', outro, { texto: RESPOSTA })).status).toBe(404);
    // O oculto: a rede não deixa responder.
    meta.comentariosNoInstagram.get(post)!.find((c) => c.id === pergunta)!.hidden = true;
    const oculto = await pedir(e, 'comentario_responder', pergunta, { texto: RESPOSTA });
    expect([oculto.status, oculto.body.code]).toEqual([422, 'plano-recusado']);
    expect(oculto.body.detail).toContain('oculto');
    expect(Number((await ownerQuery<{ n: string }>(`select count(*)::text as n from liame.action_request where tenant_id = $1`, [e.tenantId]))[0]!.n)).toBe(0);
  }, 120_000);

  it('o comentário que mudou depois do pedido (foi ocultado direto na rede) não é respondido', async () => {
    const { e, post, pergunta } = await comPergunta('Casa Brasa Comentário Mudou');
    const p = await pedir(e, 'comentario_responder', pergunta, { texto: RESPOSTA });
    expect((await aprovar(e, p.body as Pedido)).status).toBe(200);
    meta.comentariosNoInstagram.get(post)!.find((c) => c.id === pergunta)!.hidden = true;
    await ciclo(e);
    expect(await ver(e, p.body.id)).toMatchObject({ status: 'falhou', status_reason: 'o recurso mudou desde o pedido; nada foi sobrescrito', execution: { status: 'estado_mudou' } });
    expect(meta.comentariosNoInstagram.get(post)!.find((c) => c.id === pergunta)!.respostas).toEqual([]);
  }, 120_000);

  it('ocultar com o código; mostrar de novo (a volta) também com o código', async () => {
    const e = await empresa('Casa Brasa Ocultar Comentário');
    const post = meta.publicadoForaDoLiame(e.instagram!.externo, { caption: 'Combo', horas: 2, comments_count: 1 });
    const golpe = meta.comentouNoInstagram(post, { texto: 'Ganhe seguidores grátis no meu perfil', usuario: 'promo_fake' });
    await ler(e);
    meta.normalizar();
    expect(await situacaoNaTela(e, golpe)).toMatchObject({ situation: 'para_ocultar' });
    const p = await pedir(e, 'comentario_ocultar', golpe);
    expect(p.body).toMatchObject({ tool: 'comentario_ocultar', status: 'aguardando_aprovacao' });
    expect((await aprovar(e, p.body as Pedido)).status).toBe(200);
    await ciclo(e);
    expect(await ver(e, p.body.id)).toMatchObject({ status: 'executada' });
    expect(meta.comentariosNoInstagram.get(post)![0]!.hidden).toBe(true);
    expect(await situacaoNaTela(e, golpe)).toMatchObject({ situation: 'oculto' });

    const volta = await api.call('POST', `/v1/actions/${p.body.id}/undo`, { cookie: e.cookie });
    expect(volta.body, JSON.stringify(volta.body)).toMatchObject({ tool: 'comentario_mostrar', status: 'aguardando_aprovacao' });
    await ciclo(e);
    expect(meta.comentariosNoInstagram.get(post)![0]!.hidden).toBe(true);
    expect((await aprovar(e, volta.body as Pedido)).status).toBe(200);
    await ciclo(e);
    expect(meta.comentariosNoInstagram.get(post)![0]!.hidden).toBe(false);
    expect(await situacaoNaTela(e, golpe)).toMatchObject({ situation: 'para_ocultar' });
  }, 120_000);

  it('na Página: sem a tarefa de moderar, o pedido não nasce; com ela, a resposta sai pelo token da Página', async () => {
    const e = await empresa('Casa Brasa Comentário Página', { instagram: false, pagina: true });
    const pagina = e.pagina!.externo;
    meta.paginas.set(pagina, ['CREATE_CONTENT', 'MODERATE']);
    const post = meta.postouNaPagina(pagina, { message: 'Sexta tem combo', horas: 3 });
    const pergunta = meta.comentouNaPagina(post, { message: 'Vocês abrem no feriado?' });
    expect((await ler(e))[0]).toMatchObject({ status: 'ok', comentarios: 1 });
    meta.normalizar();

    meta.paginas.set(pagina, ['CREATE_CONTENT']);
    const sem = await pedir(e, 'comentario_responder', pergunta, { texto: 'Abrimos sim, das 18h às 23h.' }, 'facebook_page');
    expect([sem.status, sem.body.code]).toEqual([409, 'sem-permissao-na-plataforma']);

    meta.paginas.set(pagina, ['CREATE_CONTENT', 'MODERATE']);
    const p = await pedir(e, 'comentario_responder', pergunta, { texto: 'Abrimos sim, das 18h às 23h.' }, 'facebook_page');
    expect(p.status, JSON.stringify(p.body)).toBe(201);
    expect((await aprovar(e, p.body as Pedido)).status).toBe(200);
    await ciclo(e);
    expect(await ver(e, p.body.id)).toMatchObject({ status: 'executada' });
    const naRede = meta.comentariosNaPagina.get(post)!;
    expect(naRede.filter((c) => c.parent === pergunta).map((c) => [c.message, c.deId])).toEqual([['Abrimos sim, das 18h às 23h.', pagina]]);
    expect(meta.defeitos).toEqual([]);
    expect(await situacaoNaTela(e, pergunta)).toMatchObject({ situation: 'respondido' });
  }, 120_000);
});
