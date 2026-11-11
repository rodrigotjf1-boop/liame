import { resolve } from 'node:path';
import { type Database, runMigrations } from '@liame/database';
import { MockLanguageModelV4 } from 'ai/test';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ActionService } from '../../src/actions/action.service.js';
import { comentarioNaPaginaConnector, comentarioNoInstagramConnector, type DependenciasDoComentario } from '../../src/actions/comentario-na-rede.js';
import { AiGateway } from '../../src/ai/gateway.js';
import { ModelosIa } from '../../src/ai/modelos.js';
import { RESPOSTAS_PRONTAS } from '../../src/ai/social/comentario.js';
import { APP_CONFIG, type AppConfig, loadConfig } from '../../src/config.js';
import { marcaDoTexto } from '../../src/comentarios/tipos.js';
import { ClienteConector } from '../../src/connectors/cliente-http.js';
import { versaoRegistrada } from '../../src/connectors/tipos.js';
import { DATABASE } from '../../src/database/database.module.js';
import { FlagService } from '../../src/flags/flag.service.js';
import { ResultsService } from '../../src/results/results.service.js';
import { VaultService } from '../../src/vault/vault.service.js';
import { ComentariosLoop } from '../../src/worker/comentarios-loop.js';
import { PedidosDosComentariosLoop } from '../../src/worker/pedidos-dos-comentarios-loop.js';
import { PedidosDosComentariosService } from '../../src/worker/pedidos-dos-comentarios.service.js';
import { TiposDosComentariosLoop } from '../../src/worker/tipos-dos-comentarios-loop.js';
import { TiposDosComentariosService } from '../../src/worker/tipos-dos-comentarios.service.js';
import { ownerQuery, resetIpRateLimits, startApi, type TestApi } from '../helpers/api.js';
import * as ia from '../helpers/ia.js';
import { InstagramDeMentira, SEGREDO_DO_APP, TOKEN_DO_INSTAGRAM } from '../helpers/instagram-de-mentira.js';
import { ligarFlagDaEmpresa } from '../helpers/meta-de-mentira.js';
import { type EmpresaComCanais, empresaComCanais } from '../helpers/posts-semeados.js';
import { hasDb, OWNER_URL } from './env.js';

// A6 · Z11, parte 2d-4c: o tipo do comentário pela IA (migration 0128; D-A6-87 e D-A6-101), da leitura ao pedido, contra
// Postgres, a Meta local e um modelo simulado (nenhum fornecedor é chamado). O que se prova:
//   - a leitura abre a vez do tipo só do comentário que a regra deixou sem tipo, e só com os pedidos ligados;
//   - o tipo que sai vai para o comentário (`kind_source = 'ia'`) e abre a vez do pedido, que a rotina dos pedidos monta;
//   - o "nenhum" (e a marcação sem o @ de outra pessoa) fica só na vez: o comentário segue sem tipo e sem pedido;
//   - o mesmo texto não volta ao modelo; o texto editado ganha uma vez nova;
//   - nenhum @ chega ao modelo; a IA que não atende faz esperar, sem contar tentativa; a resposta fora do formato (que o
//     gateway trata como falha da rota) conta e, na terceira, fecha como `falhou`.

const NA_MARCA = { identity: { summary: 'Hamburgueria de bairro com smash feito na chapa', audience: 'Quem mora ou trabalha no Centro', differentiator: 'Pão feito na casa todo dia', since: '2019' }, voice: { traits: ['Direta'], rules: ['Frases curtas.'], do_example: 'Bateu a fome? O smash sai da chapa rapidinho.', dont_example: '' }, products: { items: ['Combo duplo R$ 39,90'] }, offers: { items: [] }, forbidden: { items: [] }, competitors: { items: [] }, region: { area: 'Centro e Lapa', pickup: true } };
const DA_PERGUNTA = 'Entregamos no Centro e na Lapa. Qualquer dúvida, chama a gente pelos contatos do perfil da loja.';

// Os comentários que a regra deixa sem tipo (o mesmo cuidado do eval: nenhuma palavra que ela conhece).
const PERGUNTA = 'Gostaria de saber se vocês entregam na Tijuca';
const RISADA = 'kkkkkkk';
const CONVITE = '@perfil_da_ana olha esse lanche, a gente precisa ir lá no sábado depois do trabalho';
const LEMBRANCA = 'Esse aqui eu já conhecia desde a época da faculdade';

describe.skipIf(!hasDb)('o tipo do comentário pela IA (A6 · Z11, parte 2d-4c)', () => {
  let api: TestApi;
  let database: Database;
  let leitura: ComentariosLoop;
  let filaDosTipos: TiposDosComentariosLoop;
  let filaDosPedidos: PedidosDosComentariosLoop;
  let modelos: ia.ModelosDeTeste;
  const meta = new InstagramDeMentira();

  /** O que o modelo simulado responde, pelo pedido que recebeu: o do tipo pela linha que o sistema escreve (V184). */
  let tipoDe: (pedido: string) => unknown = () => ({ tipo: 'nenhum' });
  const vistos: string[] = [];
  const simulado = new MockLanguageModelV4({
    doGenerate: async (opcoes) => {
      const pedido = JSON.stringify(opcoes.prompt);
      const doTipo = pedido.includes('Diga de que tipo é o comentário abaixo.');
      if (doTipo) vistos.push(pedido);
      const resposta = doTipo ? tipoDe(pedido) : { sugestoes: [{ enfoque: 'Responde e chama a equipe', texto: DA_PERGUNTA }], respondida: 'sim' };
      return { content: [{ type: 'text' as const, text: JSON.stringify(resposta) }], finishReason: { unified: 'stop' as const, raw: undefined }, usage: ia.uso(900, 10), warnings: [] };
    },
  });
  /** O tipo pelo comentário entre as marcas (o texto de cada caso é único neste arquivo). */
  const padrao = (pedido: string) => {
    if (pedido.includes('entregam na Tijuca')) return { tipo: 'pergunta' };
    if (pedido.includes('precisa ir lá no sábado')) return { tipo: 'marcacao' };
    // A lembrança: o modelo erra e diz marcação, mas não há o @ de ninguém; o código troca por "nenhum".
    if (pedido.includes('época da faculdade')) return { tipo: 'marcacao' };
    return { tipo: 'nenhum' };
  };
  const chamadasDoTipo = () => vistos.length;

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
    // O modelo de IA é o simulado: nenhum fornecedor é chamado. As rotas das tarefas têm nome fixo e ninguém apaga (V76).
    modelos = new ia.ModelosDeTeste(loadConfig());
    api.app.get(ModelosIa).modelo = (provider, model) => modelos.modelo(provider, model);
    const gateway = api.app.get(AiGateway);
    filaDosTipos = new TiposDosComentariosLoop(database, new TiposDosComentariosService(database, flags, gateway));
    filaDosPedidos = new PedidosDosComentariosLoop(database, new PedidosDosComentariosService(database, flags, gateway, api.app.get(ResultsService), api.app.get(ActionService)));
  }, 120_000);
  beforeEach(async () => {
    await resetIpRateLimits();
    meta.normalizar();
    tipoDe = padrao;
    vistos.length = 0;
    await ia.rotaCompartilhada(modelos, 'social_comentario_tipo', simulado);
    modelos.porChave.set('teste/compartilhado_social_comentario_tipo', simulado);
    await ia.rotaCompartilhada(modelos, 'social_comentario', simulado);
    modelos.porChave.set('teste/compartilhado_social_comentario', simulado);
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
  const vezesDoTipo = (e: EmpresaComCanais) =>
    ownerQuery<{ comment_id: string; status: string; result: string | null; reason: string | null; attempts: number; text_sha256: string; usage_id: string | null }>(
      `select comment_id, status, result, reason, attempts, text_sha256, usage_id from liame.comment_kind_check where tenant_id = $1 order by created_at, comment_id`,
      [e.tenantId],
    );
  const porComentario = async (e: EmpresaComCanais) => new Map((await vezesDoTipo(e)).map((v) => [`${v.comment_id}:${v.text_sha256}`, v]));
  const tipoGuardado = async (e: EmpresaComCanais, comentario: string) =>
    (await ownerQuery<{ kind: string | null; kind_source: string | null }>(`select kind, kind_source from liame.social_comment where tenant_id = $1 and comment_id = $2`, [e.tenantId, comentario]))[0]!;
  const vencer = (e: EmpresaComCanais) => ownerQuery(`update liame.comment_kind_check set next_attempt_at = now() - interval '1 second' where tenant_id = $1 and status = 'esperando'`, [e.tenantId]);

  it('o tipo que a IA decide vai para o comentário e abre a vez do pedido; o "nenhum" e a marcação sem @ ficam só na vez; nenhum @ chega ao modelo', async () => {
    const e = await empresa('Casa Brasa Tipo pela IA');
    const post = meta.publicadoForaDoLiame(e.instagram!.externo, { caption: 'Combo duplo na chapa', horas: 2, comments_count: 5 });
    const pergunta = meta.comentouNoInstagram(post, { texto: PERGUNTA, usuario: 'ana_paula' });
    const risada = meta.comentouNoInstagram(post, { texto: RISADA, usuario: 'rui_s' });
    const convite = meta.comentouNoInstagram(post, { texto: CONVITE, usuario: 'carla_m' });
    const lembranca = meta.comentouNoInstagram(post, { texto: LEMBRANCA, usuario: 'bia_lima' });
    // O de tipo claro (elogio pela regra) não ganha a vez do tipo: vai direto para a vez do pedido.
    const elogio = meta.comentouNoInstagram(post, { texto: 'Melhor smash da cidade, parabéns!', usuario: 'duda_r' });
    expect((await ler(e))[0]).toMatchObject({ status: 'ok', comentarios: 5, pedidos: 1, tipos: 4 });
    meta.normalizar();

    const feitos = await filaDosTipos.executarLote(10, { tenantIds: [e.tenantId] });
    expect(feitos.map((f) => f.feito.status)).toEqual(['pronta', 'pronta', 'pronta', 'pronta']);
    const vezes = new Map((await vezesDoTipo(e)).map((v) => [v.comment_id, v]));
    expect([pergunta, risada, convite, lembranca].map((id) => [vezes.get(id)!.status, vezes.get(id)!.result, vezes.get(id)!.reason])).toEqual([
      ['pronta', 'pergunta', null],
      ['pronta', 'nenhum', null],
      ['pronta', 'marcacao', null],
      // O modelo disse marcação, mas não há o @ de outra pessoa: o código troca por "nenhum", com o porquê.
      ['pronta', 'nenhum', 'marcacao_sem_perfil'],
    ]);
    // A vez guarda a marca do texto julgado, nunca o texto.
    expect(vezes.get(pergunta)!.text_sha256).toBe(marcaDoTexto(PERGUNTA));
    expect(vezes.get(pergunta)!.usage_id).not.toBeNull();
    // O comentário ganha o tipo, com a origem da IA; o "nenhum" segue sem tipo.
    expect(await tipoGuardado(e, pergunta)).toEqual({ kind: 'pergunta', kind_source: 'ia' });
    expect(await tipoGuardado(e, convite)).toEqual({ kind: 'marcacao', kind_source: 'ia' });
    expect(await tipoGuardado(e, risada)).toEqual({ kind: null, kind_source: null });
    expect(await tipoGuardado(e, lembranca)).toEqual({ kind: null, kind_source: null });
    expect(await tipoGuardado(e, elogio)).toEqual({ kind: 'elogio', kind_source: 'regra' });

    // Quatro chamadas, uma por comentário, sem o @ de ninguém: nem de quem comentou, nem de quem foi marcado.
    expect(chamadasDoTipo()).toBe(4);
    for (const v of vistos) for (const quem of ['ana_paula', 'rui_s', 'carla_m', 'bia_lima', 'duda_r', 'perfil_da_ana']) expect(v).not.toContain(quem);
    expect(vistos.some((v) => v.includes('@perfil olha esse lanche'))).toBe(true);

    // A vez do pedido abriu com o tipo, e a rotina dos pedidos monta o pedido em Aprovações, como para o tipo da regra.
    const pedidos = await filaDosPedidos.executarLote(10, { tenantIds: [e.tenantId] });
    expect(pedidos.map((p) => p.feito.status).sort()).toEqual(['pronta', 'pronta', 'pronta']);
    const daVez = await ownerQuery<{ comment_id: string; operation: string; action_id: string }>(
      `select comment_id, operation, action_id from liame.comment_suggestion where tenant_id = $1`,
      [e.tenantId],
    );
    expect(daVez.map((v) => v.comment_id).sort()).toEqual([pergunta, convite, elogio].sort());
    const params = async (comentario: string) =>
      (await ownerQuery<{ params: { texto: string }; status: string }>(`select params, status from liame.action_request where id = $1`, [daVez.find((v) => v.comment_id === comentario)!.action_id]))[0]!;
    expect(await params(pergunta)).toMatchObject({ status: 'aguardando_aprovacao', params: { texto: DA_PERGUNTA } });
    expect(RESPOSTAS_PRONTAS.marcacao).toContain((await params(convite)).params.texto);

    // A leitura seguinte não pergunta de novo: os que ganharam tipo saíram da regra da vez, e o "nenhum" tem a vez deste texto.
    expect((await ler(e, new Date(Date.now() + 20 * 60_000)))[0]).toMatchObject({ status: 'ok', tipos: 0 });
    meta.normalizar();
    expect(await filaDosTipos.executarLote(10, { tenantIds: [e.tenantId] })).toEqual([]);
    expect(chamadasDoTipo()).toBe(4);
    // O tipo da IA continua no comentário depois da leitura (o texto não mudou).
    expect(await tipoGuardado(e, pergunta)).toEqual({ kind: 'pergunta', kind_source: 'ia' });
  }, 120_000);

  it('o texto editado ganha uma vez nova; a IA desligada faz esperar sem contar tentativa; o formato errado conta e, na terceira, fecha; a função desligada não abre a vez', async () => {
    // Sem a função dos pedidos, a leitura não abre a vez do tipo de ninguém.
    const desligada = await empresa('Casa Brasa Tipo Desligado', { pedidos: false });
    const postDesligado = meta.publicadoForaDoLiame(desligada.instagram!.externo, { caption: 'Combo', horas: 2, comments_count: 1 });
    meta.comentouNoInstagram(postDesligado, { texto: RISADA, usuario: 'rui_s' });
    const lidaDesligada = (await ler(desligada))[0]!;
    expect(lidaDesligada).toMatchObject({ status: 'ok', comentarios: 1 });
    expect(lidaDesligada).not.toHaveProperty('tipos');
    expect(await vezesDoTipo(desligada)).toEqual([]);
    meta.normalizar();

    const e = await empresa('Casa Brasa Tipo Editado');
    const post = meta.publicadoForaDoLiame(e.instagram!.externo, { caption: 'Combo duplo na chapa', horas: 2, comments_count: 2 });
    const risada = meta.comentouNoInstagram(post, { texto: RISADA, usuario: 'rui_s' });
    const lembranca = meta.comentouNoInstagram(post, { texto: LEMBRANCA, usuario: 'bia_lima' });
    expect((await ler(e))[0]).toMatchObject({ status: 'ok', tipos: 2 });
    meta.normalizar();

    // A IA desligada para a empresa: as duas esperam, com o porquê, sem chamar o modelo nem contar tentativa.
    await ligarFlagDaEmpresa(api, 'ia', e.tenantId, false);
    expect((await filaDosTipos.executarLote(10, { tenantIds: [e.tenantId] })).map((f) => f.feito)).toEqual([
      { status: 'esperando', motivo: 'ia_desligada' },
      { status: 'esperando', motivo: 'ia_desligada' },
    ]);
    expect((await vezesDoTipo(e)).map((v) => [v.status, v.reason, v.attempts])).toEqual([
      ['esperando', 'ia_desligada', 0],
      ['esperando', 'ia_desligada', 0],
    ]);
    expect(chamadasDoTipo()).toBe(0);

    // Com a IA de volta: a risada sai "nenhum"; a lembrança volta fora do formato, conta a tentativa e, na terceira, fecha.
    // A resposta que não valida no schema não passa do gateway: conta como falha da rota (sem reserva, "IA fora do ar").
    await ligarFlagDaEmpresa(api, 'ia', e.tenantId, true);
    tipoDe = (pedido) => (pedido.includes('época da faculdade') ? { tipo: 'duvida' } : { tipo: 'nenhum' });
    for (let rodada = 1; rodada <= 3; rodada += 1) {
      await vencer(e);
      await filaDosTipos.executarLote(10, { tenantIds: [e.tenantId] });
    }
    const depois = new Map((await vezesDoTipo(e)).map((v) => [v.comment_id, v]));
    expect([depois.get(risada)!.status, depois.get(risada)!.result]).toEqual(['pronta', 'nenhum']);
    expect([depois.get(lembranca)!.status, depois.get(lembranca)!.reason, depois.get(lembranca)!.attempts]).toEqual(['falhou', 'ia_fora_do_ar', 3]);
    expect(await tipoGuardado(e, lembranca)).toEqual({ kind: null, kind_source: null });

    // Quem comentou edita a risada: o texto novo ganha uma vez nova (a do texto antigo fica como estava).
    meta.comentariosNoInstagram.get(post)!.find((c) => c.id === risada)!.text = 'Gostaria de saber se vocês entregam na Tijuca hoje';
    tipoDe = padrao;
    // A leitura e a fila com o mesmo relógio (a vez nova nasce marcada para o instante da leitura, V34).
    const maisTarde = new Date(Date.now() + 20 * 60_000);
    expect((await ler(e, maisTarde))[0]).toMatchObject({ status: 'ok', tipos: 1 });
    meta.normalizar();
    const novas = await porComentario(e);
    expect(novas.get(`${risada}:${marcaDoTexto(RISADA)}`)!.result).toBe('nenhum');
    expect(novas.get(`${risada}:${marcaDoTexto('Gostaria de saber se vocês entregam na Tijuca hoje')}`)!.status).toBe('esperando');
    expect((await filaDosTipos.executarLote(10, { tenantIds: [e.tenantId] }, maisTarde)).map((f) => f.feito)).toEqual([{ status: 'pronta', tipo: 'pergunta', pedidos: 1 }]);
    expect(await tipoGuardado(e, risada)).toEqual({ kind: 'pergunta', kind_source: 'ia' });
  }, 120_000);

  it('a vez que não serve mais acaba descartada, sem chamar o modelo: o texto mudou entre a leitura e a vez', async () => {
    const e = await empresa('Casa Brasa Tipo Mudou');
    const post = meta.publicadoForaDoLiame(e.instagram!.externo, { caption: 'Combo', horas: 2, comments_count: 1 });
    const comentario = meta.comentouNoInstagram(post, { texto: RISADA, usuario: 'rui_s' });
    expect((await ler(e))[0]).toMatchObject({ status: 'ok', tipos: 1 });
    meta.normalizar();
    // O texto muda no banco depois de a vez abrir (outra leitura, no meio): a vez deste texto não serve.
    await ownerQuery(`update liame.social_comment set message = 'kkkkkkkkkk' where tenant_id = $1 and comment_id = $2`, [e.tenantId, comentario]);
    expect((await filaDosTipos.executarLote(10, { tenantIds: [e.tenantId] })).map((f) => f.feito)).toEqual([{ status: 'descartada', motivo: 'texto_mudou' }]);
    expect(chamadasDoTipo()).toBe(0);
  }, 120_000);

  it('as regras da tabela (V119): a marca do texto, a situação, o tipo, o porquê, a pronta com o tipo, o fim e uma vez por texto', async () => {
    const e = await empresa('Casa Brasa Regras do Tipo', { pedidos: false });
    const post = meta.publicadoForaDoLiame(e.instagram!.externo, { caption: 'Combo', horas: 2, comments_count: 1 });
    const comentario = meta.comentouNoInstagram(post, { texto: RISADA, usuario: 'rui_s' });
    expect((await ler(e))[0]).toMatchObject({ status: 'ok', comentarios: 1 });
    meta.normalizar();
    const sha = marcaDoTexto(RISADA);
    const inserir = (colunas: Record<string, unknown>) => {
      const linha: Record<string, unknown> = { id: crypto.randomUUID(), tenant_id: e.tenantId, brand_id: e.brandId, connected_account_id: e.instagram!.id, comment_id: comentario, text_sha256: sha, status: 'esperando', ...colunas };
      const nomes = Object.keys(linha);
      return ownerQuery(`insert into liame.comment_kind_check (${nomes.join(', ')}) values (${nomes.map((_, i) => `$${i + 1}`).join(', ')})`, Object.values(linha)).then(
        () => 'passou',
        (err: { constraint?: string; code?: string }) => err.constraint ?? err.code ?? 'erro',
      );
    };
    const fim = new Date().toISOString();
    // O que não passa, pelo nome da restrição (o texto do erro muda com o idioma do Postgres; V119).
    expect(await inserir({ text_sha256: 'A'.repeat(64) })).toBe('comment_kind_check_text_sha256_check');
    expect(await inserir({ text_sha256: 'a'.repeat(63) })).toBe('comment_kind_check_text_sha256_check');
    expect(await inserir({ status: 'outra', finished_at: fim })).toBe('comment_kind_check_status_check');
    expect(await inserir({ status: 'pronta', result: 'duvida', finished_at: fim })).toBe('comment_kind_check_result_check');
    expect(await inserir({ reason: 'Com Espaço' })).toBe('comment_kind_check_reason_check');
    expect(await inserir({ attempts: -1 })).toBe('comment_kind_check_attempts_check');
    expect(await inserir({ status: 'pronta', finished_at: fim })).toBe('comment_kind_check_pronta');
    expect(await inserir({ result: 'nenhum' })).toBe('comment_kind_check_pronta');
    expect(await inserir({ status: 'descartada' })).toBe('comment_kind_check_fim');
    expect(await inserir({ finished_at: fim })).toBe('comment_kind_check_fim');
    // O que passa: a pronta com "nenhum"; e, para o mesmo texto, uma vez só (com o nulo no lugar do porquê).
    expect(await inserir({ status: 'pronta', result: 'nenhum', finished_at: fim })).toBe('passou');
    expect(await inserir({ status: 'descartada', reason: 'texto_mudou', finished_at: fim })).toBe('comment_kind_check_texto');
    expect(await inserir({ text_sha256: marcaDoTexto('outro texto'), status: 'pronta', result: 'pergunta', finished_at: fim })).toBe('passou');
  }, 120_000);
});
