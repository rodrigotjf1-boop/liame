import { resolve } from 'node:path';
import { type Database, runMigrations } from '@liame/database';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ActionService, PREFIXO_RETIRADA } from '../../src/actions/action.service.js';
import { comentarioNaPaginaConnector, comentarioNoInstagramConnector, type DependenciasDoComentario } from '../../src/actions/comentario-na-rede.js';
import { AiGateway } from '../../src/ai/gateway.js';
import { APP_CONFIG, type AppConfig } from '../../src/config.js';
import { motivoDaRetirada } from '../../src/comentarios/pedidos.js';
import { ClienteConector } from '../../src/connectors/cliente-http.js';
import { versaoRegistrada } from '../../src/connectors/tipos.js';
import { DATABASE } from '../../src/database/database.module.js';
import { FlagService } from '../../src/flags/flag.service.js';
import { ResultsService } from '../../src/results/results.service.js';
import { VaultService } from '../../src/vault/vault.service.js';
import { ComentariosLoop } from '../../src/worker/comentarios-loop.js';
import { PedidosDosComentariosLoop } from '../../src/worker/pedidos-dos-comentarios-loop.js';
import { PedidosDosComentariosService } from '../../src/worker/pedidos-dos-comentarios.service.js';
import { ownerQuery, resetIpRateLimits, startApi, type TestApi } from '../helpers/api.js';
import { InstagramDeMentira, SEGREDO_DO_APP, TOKEN_DO_INSTAGRAM } from '../helpers/instagram-de-mentira.js';
import { ligarFlagDaEmpresa } from '../helpers/meta-de-mentira.js';
import { type EmpresaComCanais, empresaComCanais } from '../helpers/posts-semeados.js';
import { hasDb, OWNER_URL } from './env.js';

// A6 · Z11, parte 2d-5: a retirada do pedido do Social media quando o comentário muda (D-A6-102), contra Postgres e a
// Meta local (nenhum modelo: os pedidos são de elogio, com a resposta pronta, e de golpe, de ocultar). O que se prova:
//   - o pedido que espera a decisão sai de Aprovações quando o comentário é respondido direto na rede, ocultado (ou já
//     está oculto, no de ocultar), editado ou apagado, com o porquê no motivo do pedido e na vez;
//   - o que não mudou fica, e a vez marcada como olhada sai da conferência até a próxima leitura;
//   - a regra pura do porquê, caso a caso.

const NA_MARCA = { identity: { summary: 'Hamburgueria de bairro com smash feito na chapa', audience: 'Quem mora ou trabalha no Centro', differentiator: 'Pão feito na casa todo dia', since: '2019' }, voice: { traits: ['Direta'], rules: ['Frases curtas.'], do_example: 'Bateu a fome? O smash sai da chapa rapidinho.', dont_example: '' }, products: { items: ['Combo duplo R$ 39,90'] }, offers: { items: [] }, forbidden: { items: [] }, competitors: { items: [] }, region: { area: 'Centro e Lapa', pickup: true } };

describe('o porquê da retirada (A6 · Z11, parte 2d-5)', () => {
  const resposta = { ferramenta: 'comentario_responder', resumoDoPedido: 'a'.repeat(64) };
  const ocultar = { ferramenta: 'comentario_ocultar', resumoDoPedido: 'a'.repeat(64) };
  const igual = { oculto: false, respondido: false, resumoAgora: 'a'.repeat(64) };
  it('o comentário que saiu do Liame, o respondido na rede, o ocultado, o editado; e o que segue igual', () => {
    expect(motivoDaRetirada(resposta, null)).toBe('comentario_sumiu');
    expect(motivoDaRetirada(resposta, { ...igual, respondido: true })).toBe('respondido_na_rede');
    expect(motivoDaRetirada(resposta, { ...igual, oculto: true })).toBe('oculto_na_rede');
    expect(motivoDaRetirada(resposta, { ...igual, resumoAgora: 'b'.repeat(64) })).toBe('comentario_mudou');
    expect(motivoDaRetirada(resposta, igual)).toBeNull();
    // A resposta vence o oculto e o texto: o comentário já tem a resposta da marca.
    expect(motivoDaRetirada(resposta, { oculto: true, respondido: true, resumoAgora: 'b'.repeat(64) })).toBe('respondido_na_rede');
    // O pedido sem o resumo do texto (estado antigo) não se retira só pelo texto.
    expect(motivoDaRetirada({ ...resposta, resumoDoPedido: null }, { ...igual, resumoAgora: 'b'.repeat(64) })).toBeNull();
  });
  it('no pedido de ocultar, só o comentário que sumiu ou que já está oculto: a resposta e o texto não importam', () => {
    expect(motivoDaRetirada(ocultar, null)).toBe('comentario_sumiu');
    expect(motivoDaRetirada(ocultar, { ...igual, oculto: true })).toBe('ja_oculto');
    expect(motivoDaRetirada(ocultar, { ...igual, respondido: true, resumoAgora: 'b'.repeat(64) })).toBeNull();
  });
});

describe.skipIf(!hasDb)('a retirada do pedido do Social media quando o comentário muda (A6 · Z11, parte 2d-5)', () => {
  let api: TestApi;
  let database: Database;
  let leitura: ComentariosLoop;
  let fila: PedidosDosComentariosLoop;
  const meta = new InstagramDeMentira();

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
    fila = new PedidosDosComentariosLoop(database, new PedidosDosComentariosService(database, flags, api.app.get(AiGateway), api.app.get(ResultsService), api.app.get(ActionService)));
  }, 120_000);
  beforeEach(async () => {
    await resetIpRateLimits();
    meta.normalizar();
  });
  afterAll(async () => {
    await meta.desligar();
    await api?.close();
  });

  async function empresa(nome: string): Promise<EmpresaComCanais> {
    const e = await empresaComCanais(api, nome, { token: TOKEN_DO_INSTAGRAM, instagram: true, pagina: false });
    const salvo = await api.call('PUT', '/v1/brand-dossier', { cookie: e.cookie, body: { brand_id: e.brandId, base_version: 0, content: NA_MARCA } });
    expect(salvo.status, JSON.stringify(salvo.body)).toBe(200);
    for (const flag of ['comentarios', 'comentarios_responder', 'ia', 'comentarios_sugeridos'] as const) await ligarFlagDaEmpresa(api, flag, e.tenantId, true);
    return e;
  }
  const ler = (e: EmpresaComCanais, agora: Date) => leitura.executarLote(10, { tenantIds: [e.tenantId] }, agora);
  const vezes = (e: EmpresaComCanais) =>
    ownerQuery<{ comment_id: string; status: string; reason: string | null; action_id: string | null }>(
      `select comment_id, status, reason, action_id from liame.comment_suggestion where tenant_id = $1`,
      [e.tenantId],
    );
  const pedido = async (id: string) => (await ownerQuery<{ status: string; status_reason: string | null }>(`select status, status_reason from liame.action_request where id = $1`, [id]))[0]!;

  it('o pedido sai de Aprovações quando o comentário é respondido na rede, ocultado, editado ou apagado; o que não mudou fica', async () => {
    const e = await empresa('Casa Brasa Retirada dos Comentários');
    const post = meta.publicadoForaDoLiame(e.instagram!.externo, { caption: 'Combo duplo na chapa', horas: 2, comments_count: 6 });
    const respondido = meta.comentouNoInstagram(post, { texto: 'Melhor smash da cidade!', usuario: 'ana_paula' });
    const editado = meta.comentouNoInstagram(post, { texto: 'Que delícia esse combo', usuario: 'rui_s' });
    const golpe = meta.comentouNoInstagram(post, { texto: 'Ganhe seguidores grátis no meu perfil', usuario: 'promo_fake' });
    const ocultado = meta.comentouNoInstagram(post, { texto: 'Top demais, parabéns!', usuario: 'bia_lima' });
    const apagado = meta.comentouNoInstagram(post, { texto: 'Amei o lanche', usuario: 'carla_m' });
    const igual = meta.comentouNoInstagram(post, { texto: 'Sensacional, voltarei', usuario: 'duda_r' });
    const t0 = new Date();
    expect((await ler(e, t0))[0]).toMatchObject({ status: 'ok', comentarios: 6, pedidos: 6 });
    meta.normalizar();
    expect((await fila.executarLote(10, { tenantIds: [e.tenantId] }, t0)).map((f) => f.feito.status)).toEqual(['pronta', 'pronta', 'pronta', 'pronta', 'pronta', 'pronta']);
    const pedidoDe = new Map((await vezes(e)).map((v) => [v.comment_id, v.action_id!]));
    // Sem leitura nova, nada a conferir.
    expect(await fila.executarRetiradas(20, { tenantIds: [e.tenantId] }, t0)).toEqual([]);

    // Na rede: a marca responde um direto no Instagram, quem comentou edita outro, o golpe e um elogio ficam ocultos e um some.
    const lista = meta.comentariosNoInstagram.get(post)!;
    meta.respondeuNoInstagram(post, respondido, { texto: 'Valeu demais!', usuario: meta.usuarioDaConta, deId: e.instagram!.externo });
    lista.find((c) => c.id === editado)!.text = 'Que delícia esse combo, mas a batata veio murcha';
    lista.find((c) => c.id === golpe)!.hidden = true;
    lista.find((c) => c.id === ocultado)!.hidden = true;
    lista.splice(
      lista.findIndex((c) => c.id === apagado),
      1,
    );
    const t1 = new Date(t0.getTime() + 20 * 60_000);
    expect((await ler(e, t1))[0]).toMatchObject({ status: 'ok' });
    meta.normalizar();

    const feitos = await fila.executarRetiradas(20, { tenantIds: [e.tenantId] }, t1);
    expect(Object.fromEntries(feitos.map((f) => [f.pedido, f.feito]))).toEqual({
      [pedidoDe.get(respondido)!]: { status: 'retirada', motivo: 'respondido_na_rede', pedido: pedidoDe.get(respondido) },
      [pedidoDe.get(editado)!]: { status: 'retirada', motivo: 'comentario_mudou', pedido: pedidoDe.get(editado) },
      [pedidoDe.get(golpe)!]: { status: 'retirada', motivo: 'ja_oculto', pedido: pedidoDe.get(golpe) },
      [pedidoDe.get(ocultado)!]: { status: 'retirada', motivo: 'oculto_na_rede', pedido: pedidoDe.get(ocultado) },
      [pedidoDe.get(apagado)!]: { status: 'retirada', motivo: 'comentario_sumiu', pedido: pedidoDe.get(apagado) },
      [pedidoDe.get(igual)!]: { status: 'igual' },
    });
    // O pedido sai de Aprovações com o porquê no motivo; o que não mudou segue esperando.
    expect(await pedido(pedidoDe.get(respondido)!)).toEqual({ status: 'cancelada', status_reason: `${PREFIXO_RETIRADA}respondido_na_rede` });
    expect(await pedido(pedidoDe.get(apagado)!)).toEqual({ status: 'cancelada', status_reason: `${PREFIXO_RETIRADA}comentario_sumiu` });
    expect((await pedido(pedidoDe.get(igual)!)).status).toBe('aguardando_aprovacao');
    // A rota do pedido diz o porquê no comentário (`comment.withdrawn`), para Aprovações dizer o que houve (parte 3a).
    const visto = await api.call('GET', `/v1/actions/${pedidoDe.get(respondido)}`, { cookie: e.cookie });
    expect(visto.status, JSON.stringify(visto.body)).toBe(200);
    expect((visto.body as { comment: { withdrawn: string | null } }).comment.withdrawn).toBe('respondido_na_rede');
    const esperando = await api.call('GET', `/v1/actions/${pedidoDe.get(igual)}`, { cookie: e.cookie });
    expect((esperando.body as { comment: { withdrawn: string | null } }).comment.withdrawn).toBeNull();
    // A vez acaba retirada, com o porquê (a do comentário apagado saiu com ele); a do que não mudou segue pronta.
    const depois = new Map((await vezes(e)).map((v) => [v.comment_id, [v.status, v.reason]]));
    expect([respondido, editado, golpe, ocultado, igual].map((id) => depois.get(id))).toEqual([
      ['retirada', 'respondido_na_rede'],
      ['retirada', 'comentario_mudou'],
      ['retirada', 'ja_oculto'],
      ['retirada', 'oculto_na_rede'],
      ['pronta', null],
    ]);
    expect(depois.has(apagado)).toBe(false);
    // A conferência seguinte, sem leitura nova, não volta a nenhum: o que não mudou ficou marcado como olhado.
    expect(await fila.executarRetiradas(20, { tenantIds: [e.tenantId] }, t1)).toEqual([]);
    // E a leitura seguinte não abre outra vez para os retirados (uma por comentário).
    expect((await ler(e, new Date(t1.getTime() + 20 * 60_000)))[0]).toMatchObject({ status: 'ok', pedidos: 0 });
    meta.normalizar();
  }, 120_000);
});
