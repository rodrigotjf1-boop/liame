import { resolve } from 'node:path';
import { type Database, runMigrations } from '@liame/database';
import { MockLanguageModelV4 } from 'ai/test';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ActionService } from '../../src/actions/action.service.js';
import { BudgetService } from '../../src/actions/budget.service.js';
import { comentarioNaPaginaConnector, comentarioNoInstagramConnector, type DependenciasDoComentario } from '../../src/actions/comentario-na-rede.js';
import { AiGateway } from '../../src/ai/gateway.js';
import { ModelosIa } from '../../src/ai/modelos.js';
import { RESPOSTAS_PRONTAS } from '../../src/ai/social/comentario.js';
import { ENFOQUES_DA_RECLAMACAO } from '../../src/ai/social/comentario-contexto.js';
import { currentStep, totpCode } from '../../src/auth/totp.js';
import { APP_CONFIG, type AppConfig, loadConfig } from '../../src/config.js';
import { ClienteConector } from '../../src/connectors/cliente-http.js';
import { versaoRegistrada } from '../../src/connectors/tipos.js';
import { DATABASE } from '../../src/database/database.module.js';
import { FlagService } from '../../src/flags/flag.service.js';
import { KillSwitchService } from '../../src/kill-switch/kill-switch.service.js';
import { ResultsService } from '../../src/results/results.service.js';
import { VaultService } from '../../src/vault/vault.service.js';
import { ActionExecutor } from '../../src/worker/action-executor.js';
import { ComentariosLoop } from '../../src/worker/comentarios-loop.js';
import { PedidosDosComentariosLoop } from '../../src/worker/pedidos-dos-comentarios-loop.js';
import { PedidosDosComentariosService } from '../../src/worker/pedidos-dos-comentarios.service.js';
import { ownerQuery, resetIpRateLimits, startApi, type TestApi } from '../helpers/api.js';
import * as ia from '../helpers/ia.js';
import { InstagramDeMentira, SEGREDO_DO_APP, TOKEN_DO_INSTAGRAM } from '../helpers/instagram-de-mentira.js';
import { ligarFlagDaEmpresa } from '../helpers/meta-de-mentira.js';
import { type EmpresaComCanais, empresaComCanais } from '../helpers/posts-semeados.js';
import { hasDb, OWNER_URL } from './env.js';

// A6 · Z11, parte 2d-2: os pedidos do Social media para os comentários (migration 0125; D-A6-88, D-A6-89, D-A6-94 e
// D-A6-98), da leitura à rede, contra Postgres, a Meta local e um modelo simulado (nenhum fornecedor é chamado). O que se
// prova:
//   - a leitura dos comentários abre a vez de cada um que pede uma ação da marca, só com a função ligada;
//   - o elogio e a marcação ganham o pedido com a resposta pronta (sem chamar o modelo), o golpe o de ocultar, a pergunta
//     a sugestão do Social media e a reclamação os três caminhos, todos em nome do dono e esperando a aprovação;
//   - o @ de quem comentou não vai ao modelo; a sugestão que a conferência barra não vira pedido;
//   - a IA que não atende (desligada, ou a tarefa sem rota) faz a pergunta esperar, sem contar tentativa;
//   - os pedidos prontos saem na rede com o lote de um código (2c-2).

const NA_MARCA = { identity: { summary: 'Hamburgueria de bairro com smash feito na chapa', audience: 'Quem mora ou trabalha no Centro', differentiator: 'Pão feito na casa todo dia', since: '2019' }, voice: { traits: ['Direta'], rules: ['Frases curtas.'], do_example: 'Bateu a fome? O smash sai da chapa rapidinho.', dont_example: '' }, products: { items: ['Combo duplo R$ 39,90'] }, offers: { items: [] }, forbidden: { items: [] }, competitors: { items: [] }, region: { area: 'Centro e Lapa', pickup: true } };
const DA_PERGUNTA = 'O Combo duplo sai por R$ 39,90. Qualquer dúvida, chama a gente pelos contatos do perfil da loja.';

type Pedido = { id: string; plan_hash: string; status: string };

describe.skipIf(!hasDb)('os pedidos do Social media para os comentários (A6 · Z11, parte 2d-2)', () => {
  let api: TestApi;
  let database: Database;
  let leitura: ComentariosLoop;
  let fila: PedidosDosComentariosLoop;
  let executor: ActionExecutor;
  let modelos: ia.ModelosDeTeste;
  const meta = new InstagramDeMentira();

  /** O que o modelo simulado escreve, pelo pedido que recebeu (a mensagem e o contexto, como texto). */
  let responder: (pedido: string) => unknown = () => ({ sugestoes: [] });
  const vistos: string[] = [];
  const simulado = new MockLanguageModelV4({
    doGenerate: async (opcoes) => {
      const pedido = JSON.stringify(opcoes.prompt);
      vistos.push(pedido);
      return { content: [{ type: 'text' as const, text: JSON.stringify(responder(pedido)) }], finishReason: { unified: 'stop' as const, raw: undefined }, usage: ia.uso(1200, 150), warnings: [] };
    },
  });
  const padrao = (pedido: string) =>
    pedido.includes('O tipo do comentário: reclamação')
      ? { sugestoes: [...ENFOQUES_DA_RECLAMACAO].map((enfoque, i) => ({ enfoque, texto: `${['Desculpa pela demora.', 'O pedido atrasou na saída.', 'Obrigado pelo aviso.'][i]} Chama a gente pelos contatos do perfil da loja com o número do pedido.` })) }
      : { sugestoes: [{ enfoque: 'Responde e chama a equipe', texto: DA_PERGUNTA }] };

  beforeAll(async () => {
    await runMigrations({ connectionString: OWNER_URL, dir: resolve(process.cwd(), '../../packages/database/migrations') });
    api = await startApi();
    await resetIpRateLimits();
    await meta.ligar();
    const config: AppConfig = api.app.get(APP_CONFIG);
    database = api.app.get(DATABASE);
    const vault = api.app.get(VaultService);
    const flags = api.app.get(FlagService);
    leitura = new ComentariosLoop(database, { ...config, plataformas: { ...config.plataformas, metaGraphUrl: meta.base, metaAppSecret: SEGREDO_DO_APP } }, vault, flags);
    executor = new ActionExecutor(database, api.app.get(BudgetService), api.app.get(KillSwitchService), flags);
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
    // O modelo de IA é o simulado: nenhum fornecedor é chamado. A rota da tarefa tem nome fixo e ninguém apaga (V76).
    modelos = new ia.ModelosDeTeste(loadConfig());
    api.app.get(ModelosIa).modelo = (provider, model) => modelos.modelo(provider, model);
    const servico = new PedidosDosComentariosService(database, flags, api.app.get(AiGateway), api.app.get(ResultsService), api.app.get(ActionService));
    fila = new PedidosDosComentariosLoop(database, servico);
  }, 120_000);
  beforeEach(async () => {
    await resetIpRateLimits();
    meta.normalizar();
    responder = padrao;
    vistos.length = 0;
    simulado.doGenerateCalls.length = 0;
  });
  afterAll(async () => {
    await meta.desligar();
    await api?.close();
  });

  async function empresa(nome: string, o: { pedidos?: boolean } = {}): Promise<EmpresaComCanais> {
    const e = await empresaComCanais(api, nome, { token: TOKEN_DO_INSTAGRAM, instagram: true, pagina: false });
    const salvo = await api.call('PUT', '/v1/brand-dossier', { cookie: e.cookie, body: { brand_id: e.brandId, base_version: 0, content: NA_MARCA } });
    expect(salvo.status, JSON.stringify(salvo.body)).toBe(200);
    for (const flag of ['comentarios', 'comentarios_responder', 'ia'] as const) await ligarFlagDaEmpresa(api, flag, e.tenantId, true);
    await ligarFlagDaEmpresa(api, 'comentarios_sugeridos', e.tenantId, o.pedidos ?? true);
    return e;
  }
  const ler = (e: EmpresaComCanais, agora = new Date()) => leitura.executarLote(10, { tenantIds: [e.tenantId] }, agora);
  const vezes = (e: EmpresaComCanais) =>
    ownerQuery<{ comment_id: string; status: string; operation: string; reason: string | null; suggestions: number | null; action_id: string | null; attempts: number }>(
      `select comment_id, status, operation, reason, suggestions, action_id, attempts from liame.comment_suggestion where tenant_id = $1 order by created_at, comment_id`,
      [e.tenantId],
    );
  const pedidoDe = async (e: EmpresaComCanais, id: string) =>
    (
      await ownerQuery<{ tool: string; status: string; params: { texto?: string; sugestoes?: Array<{ enfoque: string; texto: string }> }; actor_type: string; agent_key: string | null; requested_by: string; plan_hash: string }>(
        `select tool, status, params, actor_type, agent_key, requested_by, plan_hash from liame.action_request where id = $1 and tenant_id = $2`,
        [id, e.tenantId],
      )
    )[0]!;
  async function codigo(e: EmpresaComCanais): Promise<string> {
    await ownerQuery(`update liame.app_user set totp_last_step = null where id = $1`, [e.userId]);
    await ownerQuery(`delete from liame.rate_limit where key = $1`, [`segundo-fator:${e.userId}`]);
    return totpCode(e.secret, currentStep());
  }

  it('cada tipo ganha o seu pedido em Aprovações, em nome do dono; o modelo só é chamado na pergunta e na reclamação, sem o @ de quem comentou', async () => {
    await ia.rotaCompartilhada(modelos, 'social_comentario', simulado);
    modelos.porChave.set('teste/compartilhado_social_comentario', simulado);
    const e = await empresa('Casa Brasa Pedidos dos Comentários');
    const post = meta.publicadoForaDoLiame(e.instagram!.externo, { caption: 'Combo duplo na chapa', horas: 2, comments_count: 5 });
    const elogio = meta.comentouNoInstagram(post, { texto: 'Melhor smash da cidade, parabéns!', usuario: 'bia_lima' });
    const marcacao = meta.comentouNoInstagram(post, { texto: '@joana_s bora?', usuario: 'carla_m' });
    const pergunta = meta.comentouNoInstagram(post, { texto: 'Quanto custa o combo duplo?', usuario: 'ana_paula' });
    const reclamacao = meta.comentouNoInstagram(post, { texto: 'Demorou demais e veio frio', usuario: 'rui_s' });
    const golpe = meta.comentouNoInstagram(post, { texto: 'Ganhe seguidores grátis no meu perfil', usuario: 'promo_fake' });
    expect((await ler(e))[0]).toMatchObject({ status: 'ok', comentarios: 5, pedidos: 5 });
    meta.normalizar();

    const feitos = await fila.executarLote(10, { tenantIds: [e.tenantId] });
    expect(feitos.map((f) => f.feito.status)).toEqual(['pronta', 'pronta', 'pronta', 'pronta', 'pronta']);
    const porComentario = new Map((await vezes(e)).map((v) => [v.comment_id, v]));
    expect([elogio, marcacao, pergunta, reclamacao, golpe].map((id) => [porComentario.get(id)!.operation, porComentario.get(id)!.suggestions])).toEqual([
      ['responder', 1],
      ['responder', 1],
      ['responder', 1],
      ['responder', 3],
      ['ocultar', null],
    ]);
    // O modelo foi chamado duas vezes (a pergunta e a reclamação), sem o @ de ninguém.
    expect(simulado.doGenerateCalls.length).toBe(2);
    for (const v of vistos) for (const quem of ['ana_paula', 'rui_s', 'bia_lima', 'carla_m']) expect(v).not.toContain(quem);

    const pedidoDoElogio = await pedidoDe(e, porComentario.get(elogio)!.action_id!);
    expect(pedidoDoElogio).toMatchObject({ tool: 'comentario_responder', status: 'aguardando_aprovacao', actor_type: 'agent', agent_key: 'social', requested_by: e.userId });
    expect(RESPOSTAS_PRONTAS.elogio).toContain(pedidoDoElogio.params.texto);
    expect(RESPOSTAS_PRONTAS.marcacao).toContain((await pedidoDe(e, porComentario.get(marcacao)!.action_id!)).params.texto);
    expect((await pedidoDe(e, porComentario.get(pergunta)!.action_id!)).params).toEqual({ texto: DA_PERGUNTA, sugestoes: [{ enfoque: 'Responde e chama a equipe', texto: DA_PERGUNTA, rodada: 1 }] });
    expect((await pedidoDe(e, porComentario.get(reclamacao)!.action_id!)).params.sugestoes!.map((s) => s.enfoque)).toEqual([...ENFOQUES_DA_RECLAMACAO]);
    expect(await pedidoDe(e, porComentario.get(golpe)!.action_id!)).toMatchObject({ tool: 'comentario_ocultar', status: 'aguardando_aprovacao', agent_key: 'social' });
    // Nada saiu na rede sem a aprovação.
    await executor.runCycle(20, { tenantIds: [e.tenantId] });
    expect(meta.comentariosNoInstagram.get(post)!.every((c) => c.respostas.length === 0 && !c.hidden)).toBe(true);

    // A leitura seguinte não abre a vez de novo (uma por comentário), e o lote de um código aprova o elogio e o golpe.
    expect((await ler(e, new Date(Date.now() + 20 * 60_000)))[0]).toMatchObject({ status: 'ok', pedidos: 0 });
    meta.normalizar();
    const lote = [porComentario.get(elogio)!.action_id!, porComentario.get(golpe)!.action_id!];
    const itens = await Promise.all(lote.map(async (id) => ({ id, plan_hash: (await pedidoDe(e, id)).plan_hash })));
    const aprovado = await api.call('POST', '/v1/actions/approve-batch', { cookie: e.cookie, body: { items: itens, code: await codigo(e) } });
    expect(aprovado.status, JSON.stringify(aprovado.body)).toBe(200);
    await executor.runCycle(20, { tenantIds: [e.tenantId] });
    const naRede = meta.comentariosNoInstagram.get(post)!;
    expect(naRede.find((c) => c.id === elogio)!.respostas.map((r) => r.text)).toEqual([pedidoDoElogio.params.texto]);
    expect(naRede.find((c) => c.id === golpe)!.hidden).toBe(true);
    expect(meta.defeitos).toEqual([]);
  }, 120_000);

  it('o "Pedir outra" (parte 3c): uma vez por comentário, só onde há sugestões; as novas entram no mesmo pedido, antes das que já estavam, e o texto ajustado fica', async () => {
    await ia.rotaCompartilhada(modelos, 'social_comentario', simulado);
    modelos.porChave.set('teste/compartilhado_social_comentario', simulado);
    const e = await empresa('Casa Brasa Pedir Outra');
    const post = meta.publicadoForaDoLiame(e.instagram!.externo, { caption: 'Combo duplo na chapa', horas: 2, comments_count: 3 });
    const elogio = meta.comentouNoInstagram(post, { texto: 'Melhor smash da cidade, parabéns!', usuario: 'bia_lima' });
    const pergunta = meta.comentouNoInstagram(post, { texto: 'Quanto custa o combo duplo?', usuario: 'ana_paula' });
    const reclamacao = meta.comentouNoInstagram(post, { texto: 'Demorou demais e veio frio', usuario: 'rui_s' });
    await ler(e);
    meta.normalizar();
    expect((await fila.executarLote(10, { tenantIds: [e.tenantId] })).map((f) => f.feito.status)).toEqual(['pronta', 'pronta', 'pronta']);
    const porComentario = new Map((await vezes(e)).map((v) => [v.comment_id, v.action_id!]));
    const ver = async (id: string) => (await api.call('GET', `/v1/actions/${id}`, { cookie: e.cookie })).body as { plan_hash: string; comment: Record<string, unknown> };
    const pedirOutra = (id: string) => api.call('POST', `/v1/actions/${id}/more-suggestions`, { cookie: e.cookie });

    // A resposta pronta do elogio não tem sugestões: nada a pedir.
    expect((await ver(porComentario.get(elogio)!)).comment).toMatchObject({ suggestions: null, more_suggestions: null });
    const semSugestoes = await pedirOutra(porComentario.get(elogio)!);
    expect([semSugestoes.status, (semSugestoes.body as { code: string }).code]).toEqual([409, 'sem-sugestoes']);

    // A pergunta: uma sugestão; pede outra, e a segunda vez é recusada.
    const daPergunta = porComentario.get(pergunta)!;
    expect((await ver(daPergunta)).comment).toMatchObject({ suggestions: [{ focus: 'Responde e chama a equipe', text: DA_PERGUNTA, round: 1 }], more_suggestions: 'pode_pedir', more_suggestions_asked_at: null });
    const hashAntes = (await ver(daPergunta)).plan_hash;
    const pedida = await pedirOutra(daPergunta);
    expect(pedida.status, JSON.stringify(pedida.body)).toBe(200);
    expect((pedida.body as { comment: Record<string, unknown> }).comment).toMatchObject({ more_suggestions: 'escrevendo', more_suggestions_asked_at: expect.any(String) });
    const deNovo = await pedirOutra(daPergunta);
    expect([deNovo.status, (deNovo.body as { code: string }).code]).toEqual([409, 'outras-ja-pedidas']);

    // A reclamação: a pessoa ajustou o texto antes de pedir outras; o ajuste fica.
    const daReclamacao = porComentario.get(reclamacao)!;
    const AJUSTADO = 'Sentimos muito pela demora. Chama a gente pelos contatos do perfil da loja com o número do pedido.';
    const ajuste = await api.call('PATCH', `/v1/actions/${daReclamacao}`, { cookie: e.cookie, body: { params: { texto: AJUSTADO } } });
    expect(ajuste.status, JSON.stringify(ajuste.body)).toBe(200);
    expect((await pedirOutra(daReclamacao)).status).toBe(200);

    const OUTRA = 'Sai por R$ 39,90 o Combo duplo. Se quiser saber mais, chama a gente pelos contatos do perfil da loja.';
    responder = (pedido) =>
      pedido.includes('O tipo do comentário: reclamação')
        ? { sugestoes: [...ENFOQUES_DA_RECLAMACAO].map((enfoque, i) => ({ enfoque, texto: `${['Poxa, sentimos muito.', 'Na sexta a saída atrasou.', 'Valeu por avisar.'][i]} Chama a gente pelos contatos do perfil da loja com o número do pedido.` })) }
        : { sugestoes: [{ enfoque: 'Responde e chama a equipe', texto: OUTRA }] };
    // As duas vezes do "Pedir outra" saem primeiro na fila; o modelo viu as sugestões que a pessoa já tinha visto.
    const feitas = await fila.executarLote(10, { tenantIds: [e.tenantId] });
    expect(feitas.map((f) => f.feito)).toEqual([
      { status: 'pronta', pedido: daPergunta, sugestoes: 1 },
      { status: 'pronta', pedido: daReclamacao, sugestoes: 3 },
    ]);
    expect(vistos.some((v) => v.includes('A sugestão que a pessoa já viu e quer trocar') && v.includes(DA_PERGUNTA))).toBe(true);
    expect(vistos.some((v) => v.includes('As sugestões que a pessoa já viu e quer trocar') && v.includes('Desculpa pela demora.'))).toBe(true);
    for (const v of vistos) for (const quem of ['ana_paula', 'rui_s']) expect(v).not.toContain(quem);

    // A pergunta: o texto passa a ser o da nova; o plano é outro, e a resposta é a da tela.
    expect((await pedidoDe(e, daPergunta)).params).toEqual({
      texto: OUTRA,
      sugestoes: [
        { enfoque: 'Responde e chama a equipe', texto: OUTRA, rodada: 2 },
        { enfoque: 'Responde e chama a equipe', texto: DA_PERGUNTA, rodada: 1 },
      ],
    });
    const pergundaDepois = await ver(daPergunta);
    expect(pergundaDepois.plan_hash).not.toBe(hashAntes);
    expect(pergundaDepois.comment).toMatchObject({ reply_text: OUTRA, more_suggestions: 'feitas' });
    // A reclamação: as seis (as três novas antes), e o texto ajustado continua o do pedido.
    const daReclamacaoDepois = await pedidoDe(e, daReclamacao);
    expect(daReclamacaoDepois.params.texto).toBe(AJUSTADO);
    expect(daReclamacaoDepois.params.sugestoes!.map((s) => [s.enfoque, (s as { rodada: number }).rodada])).toEqual([
      ...ENFOQUES_DA_RECLAMACAO.map((x) => [x, 2]),
      ...ENFOQUES_DA_RECLAMACAO.map((x) => [x, 1]),
    ]);
    // As vezes da rodada 2 acabam prontas, sem apontar o pedido (ele é da rodada 1).
    const segundas = await ownerQuery<{ status: string; action_id: string | null; requested_by: string | null }>(
      `select status, action_id, requested_by from liame.comment_suggestion where tenant_id = $1 and round = 2`,
      [e.tenantId],
    );
    expect(segundas).toEqual([
      { status: 'pronta', action_id: null, requested_by: e.userId },
      { status: 'pronta', action_id: null, requested_by: e.userId },
    ]);

    // Aprovado o texto novo, é ele que sai na rede.
    const aprovado = await api.call('POST', `/v1/actions/${daPergunta}/approve`, { cookie: e.cookie, body: { plan_hash: pergundaDepois.plan_hash, code: await codigo(e) } });
    expect(aprovado.status, JSON.stringify(aprovado.body)).toBe(200);
    await executor.runCycle(20, { tenantIds: [e.tenantId] });
    expect(meta.comentariosNoInstagram.get(post)!.find((c) => c.id === pergunta)!.respostas.map((r) => r.text)).toEqual([OUTRA]);
    expect(meta.defeitos).toEqual([]);
  }, 120_000);

  it('a IA que não atende faz a pergunta esperar, sem contar tentativa; a conferência barra a sugestão com o preço inventado; e a função desligada não abre a vez', async () => {
    // Sem a função, a leitura não abre a vez de ninguém.
    const desligada = await empresa('Casa Brasa Pedidos Desligados', { pedidos: false });
    const postDesligado = meta.publicadoForaDoLiame(desligada.instagram!.externo, { caption: 'Combo', horas: 2, comments_count: 1 });
    meta.comentouNoInstagram(postDesligado, { texto: 'Melhor smash da cidade!', usuario: 'bia_lima' });
    const lidaDesligada = (await ler(desligada))[0]!;
    expect(lidaDesligada).toMatchObject({ status: 'ok', comentarios: 1 });
    expect(lidaDesligada).not.toHaveProperty('pedidos');
    expect(await vezes(desligada)).toEqual([]);
    meta.normalizar();

    const e = await empresa('Casa Brasa Pedidos Sem Rota');
    const post = meta.publicadoForaDoLiame(e.instagram!.externo, { caption: 'Combo duplo na chapa', horas: 2, comments_count: 2 });
    const pergunta = meta.comentouNoInstagram(post, { texto: 'Quanto custa o combo duplo?', usuario: 'ana_paula' });
    const outra = meta.comentouNoInstagram(post, { texto: 'Vocês entregam na Lapa?', usuario: 'rui_s' });
    expect((await ler(e))[0]).toMatchObject({ status: 'ok', pedidos: 2 });
    meta.normalizar();
    // A IA que não atende (aqui, desligada para a empresa; na produção, até a migration 0126, a tarefa sem rota): a
    // vez espera, com o porquê, sem chamar modelo nem contar tentativa. A rota da tarefa é compartilhada entre os
    // arquivos de teste e não se mexe nela (V76).
    await ia.rotaCompartilhada(modelos, 'social_comentario', simulado);
    modelos.porChave.set('teste/compartilhado_social_comentario', simulado);
    await ligarFlagDaEmpresa(api, 'ia', e.tenantId, false);
    const semIa = await fila.executarLote(10, { tenantIds: [e.tenantId] });
    expect(semIa.map((f) => f.feito)).toEqual([
      { status: 'esperando', motivo: 'ia_desligada' },
      { status: 'esperando', motivo: 'ia_desligada' },
    ]);
    expect((await vezes(e)).map((v) => [v.status, v.reason, v.attempts])).toEqual([
      ['esperando', 'ia_desligada', 0],
      ['esperando', 'ia_desligada', 0],
    ]);
    expect(simulado.doGenerateCalls.length).toBe(0);

    // Com a IA de volta, o modelo escreve um preço que Minha marca não tem: a conferência barra, e nada vai a Aprovações.
    await ligarFlagDaEmpresa(api, 'ia', e.tenantId, true);
    responder = () => ({ sugestoes: [{ enfoque: 'Responde', texto: 'O Combo duplo sai por R$ 29,90. Chama a gente pelos contatos do perfil da loja.' }] });
    await ownerQuery(`update liame.comment_suggestion set next_attempt_at = now() - interval '1 second' where tenant_id = $1`, [e.tenantId]);
    const barradas = await fila.executarLote(10, { tenantIds: [e.tenantId] });
    expect(barradas.map((f) => f.feito.status)).toEqual(['barrada', 'barrada']);
    // As duas vezes nascem na mesma leitura (o mesmo instante): confere por comentário, sem depender da ordem.
    expect(Object.fromEntries((await vezes(e)).map((v) => [v.comment_id, [v.status, v.action_id]]))).toEqual({
      [pergunta]: ['barrada', null],
      [outra]: ['barrada', null],
    });
    const pedidos = await ownerQuery<{ n: string }>(`select count(*) as n from liame.action_request where tenant_id = $1 and tool like 'comentario_%'`, [e.tenantId]);
    expect(Number(pedidos[0]!.n)).toBe(0);
  }, 120_000);

  it('as regras da tabela (V119): a operação, a situação, o porquê, o ocultar sem sugestões, a pronta de responder com quantas foram, a barrada e o fim', async () => {
    const e = await empresa('Casa Brasa Regras dos Pedidos', { pedidos: false });
    const post = meta.publicadoForaDoLiame(e.instagram!.externo, { caption: 'Combo', horas: 2, comments_count: 1 });
    const comentario = meta.comentouNoInstagram(post, { texto: 'Melhor smash da cidade!', usuario: 'bia_lima' });
    expect((await ler(e))[0]).toMatchObject({ status: 'ok', comentarios: 1 });
    meta.normalizar();
    const inserir = (colunas: Record<string, unknown>) => {
      const linha: Record<string, unknown> = { id: crypto.randomUUID(), tenant_id: e.tenantId, brand_id: e.brandId, connected_account_id: e.instagram!.id, comment_id: comentario, round: 1, status: 'esperando', operation: 'responder', ...colunas };
      const nomes = Object.keys(linha);
      return ownerQuery(`insert into liame.comment_suggestion (${nomes.join(', ')}) values (${nomes.map((_, i) => `$${i + 1}`).join(', ')})`, Object.values(linha)).then(
        () => 'passou',
        (err: { constraint?: string; code?: string }) => err.constraint ?? err.code ?? 'erro',
      );
    };
    const fim = new Date().toISOString();
    // O que não passa, pelo nome da restrição (o texto do erro muda com o idioma do Postgres; V119).
    expect(await inserir({ operation: 'apagar' })).toBe('comment_suggestion_operation_check');
    // Os checks são conferidos em ordem alfabética do nome: o da situação vai com a hora de fim, para sobrar só ele.
    expect(await inserir({ status: 'outra', finished_at: fim })).toBe('comment_suggestion_status_check');
    expect(await inserir({ reason: 'Com Espaço' })).toBe('comment_suggestion_reason_check');
    expect(await inserir({ operation: 'ocultar', suggestions: 1 })).toBe('comment_suggestion_ocultar');
    expect(await inserir({ status: 'pronta', finished_at: fim })).toBe('comment_suggestion_pronta');
    expect(await inserir({ status: 'barrada', finished_at: fim })).toBe('comment_suggestion_barrada');
    expect(await inserir({ barred_by: '{numeros}' })).toBe('comment_suggestion_barrada');
    expect(await inserir({ status: 'descartada' })).toBe('comment_suggestion_fim');
    expect(await inserir({ finished_at: fim })).toBe('comment_suggestion_fim');
    expect(await inserir({ suggestions: 4, status: 'pronta', finished_at: fim })).toBe('comment_suggestion_suggestions_check');
    // O que passa: o ocultar pronto sem sugestões, a resposta pronta com três (a reclamação) e, na mesma rodada, só uma.
    expect(await inserir({ operation: 'ocultar', status: 'pronta', finished_at: fim })).toBe('passou');
    expect(await inserir({ round: 2, status: 'pronta', suggestions: 3, finished_at: fim })).toBe('passou');
    expect(await inserir({ round: 2, status: 'barrada', barred_by: '{numeros}', finished_at: fim })).toBe('comment_suggestion_rodada');
  }, 120_000);
});
