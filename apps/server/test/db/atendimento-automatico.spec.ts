import { resolve } from 'node:path';
import { type Database, runMigrations } from '@liame/database';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ActionService } from '../../src/actions/action.service.js';
import { BudgetService } from '../../src/actions/budget.service.js';
import { comentarioNaPaginaConnector, comentarioNoInstagramConnector, type DependenciasDoComentario } from '../../src/actions/comentario-na-rede.js';
import { AVISO_DE_RESPOSTA_AUTOMATICA } from '../../src/actions/comentario-plano.js';
import { AiGateway } from '../../src/ai/gateway.js';
import { RESPOSTAS_PRONTAS } from '../../src/ai/social/comentario.js';
import { currentStep, totpCode } from '../../src/auth/totp.js';
import { APP_CONFIG, type AppConfig } from '../../src/config.js';
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
import { codigoErrado, enableMfa, ownerQuery, PASSWORD, resetIpRateLimits, startApi, TERMOS, type TestApi, tokenFrom, uniqueEmail } from '../helpers/api.js';
import { InstagramDeMentira, SEGREDO_DO_APP, TOKEN_DO_INSTAGRAM } from '../helpers/instagram-de-mentira.js';
import { ligarFlagDaEmpresa } from '../helpers/meta-de-mentira.js';
import { type EmpresaComCanais, empresaComCanais } from '../helpers/posts-semeados.js';
import { hasDb, OWNER_URL } from './env.js';

// A6 · Z11, parte 2e-1: o atendimento automático dos comentários (migration 0129; P38 versão 2; D-A6-92 e D-A6-104),
// contra Postgres e a Meta local, sem modelo (o elogio e a marcação têm a resposta pronta). O que se prova:
//   - quem liga (o Dono ou um Administrador, com o código do app e a função liberada) e quem desliga (quem aprova, sem
//     código); ligado pede um tipo; a auditoria leva o antes e o depois;
//   - com ele ligado, o elogio sai sozinho, sem pedido em Aprovações, com o aviso de resposta automática; a marcação fora
//     dos tipos e a reclamação esperam uma pessoa; a segunda resposta à mesma pessoa no mesmo post vai para uma pessoa;
//   - desligar segura na hora a resposta que já estava na fila; uma pessoa não pede a resposta automática direto;
//   - as regras da tabela (V119).

describe.skipIf(!hasDb)('o atendimento automático dos comentários (A6 · Z11, parte 2e-1)', () => {
  let api: TestApi;
  let database: Database;
  let leitura: ComentariosLoop;
  let fila: PedidosDosComentariosLoop;
  let executor: ActionExecutor;
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
    const servico = new PedidosDosComentariosService(database, flags, api.app.get(AiGateway), api.app.get(ResultsService), api.app.get(ActionService));
    fila = new PedidosDosComentariosLoop(database, servico);
  }, 120_000);
  beforeEach(async () => {
    await resetIpRateLimits();
    meta.normalizar();
  });
  afterAll(async () => {
    await meta.desligar();
    await api?.close();
  });

  async function empresa(nome: string, o: { automatico?: boolean } = {}): Promise<EmpresaComCanais> {
    const e = await empresaComCanais(api, nome, { token: TOKEN_DO_INSTAGRAM, instagram: true, pagina: false });
    for (const flag of ['comentarios', 'comentarios_responder', 'comentarios_sugeridos'] as const) await ligarFlagDaEmpresa(api, flag, e.tenantId, true);
    await ligarFlagDaEmpresa(api, 'comentarios_automatico', e.tenantId, o.automatico ?? true);
    return e;
  }
  /** Uma pessoa da empresa com outro papel (o aprovador desliga, mas não liga). */
  async function pessoa(e: EmpresaComCanais, role: string): Promise<{ cookie: string }> {
    const email = uniqueEmail(role);
    expect((await api.call('POST', '/v1/invitations', { cookie: e.cookie, body: { email, role, approve_limit_micros: 1_000_000 } })).status).toBe(201);
    const s = await api.call('POST', '/v1/invitations/signup', { body: { token: tokenFrom(api.mailer, email), name: role, password: PASSWORD, terms_version: TERMOS } });
    await enableMfa(api, s.cookie!);
    return { cookie: s.cookie! };
  }
  async function codigo(e: EmpresaComCanais): Promise<string> {
    await ownerQuery(`update liame.app_user set totp_last_step = null where id = $1`, [e.userId]);
    await ownerQuery(`delete from liame.rate_limit where key = $1`, [`segundo-fator:${e.userId}`]);
    return totpCode(e.secret, currentStep());
  }
  const ver = (e: EmpresaComCanais, cookie = e.cookie) => api.call('GET', `/v1/comments/auto-reply?brand_id=${e.brandId}`, { cookie });
  const mudar = (e: EmpresaComCanais, body: Record<string, unknown>, cookie = e.cookie) => api.call('PUT', '/v1/comments/auto-reply', { cookie, body: { brand_id: e.brandId, ...body } });
  const problema = (r: { status: number; body: unknown }) => [r.status, (r.body as { code?: string }).code];
  const ler = (e: EmpresaComCanais, agora = new Date()) => leitura.executarLote(10, { tenantIds: [e.tenantId] }, agora);
  const pedidosDe = (e: EmpresaComCanais) =>
    ownerQuery<{ id: string; tool: string; status: string; resource_id: string; params: { texto?: string }; mode: string }>(
      `select id, tool, status, resource_id, params, mode from liame.action_request where tenant_id = $1 order by created_at, id`,
      [e.tenantId],
    );
  const doComentario = (pedidos: Awaited<ReturnType<typeof pedidosDe>>, id: string) => pedidos.find((p) => p.resource_id === `comentario:${id}`);

  it('liga o Dono ou um Administrador, com o código e a função liberada; desliga quem aprova, sem código; ligado pede um tipo', async () => {
    const e = await empresa('Casa Brasa Automático Chave', { automatico: false });
    expect((await ver(e)).body).toMatchObject({ available: false, enabled: false, kinds: [], can_enable: true, can_disable: true, updated_by: null, last_hour: 0, hourly_limit: 30 });
    // Sem a função liberada para a empresa, não liga.
    expect(problema(await mudar(e, { enabled: true, kinds: ['elogio'], code: await codigo(e) }))).toEqual([409, 'funcao-desligada']);
    await ligarFlagDaEmpresa(api, 'comentarios_automatico', e.tenantId, true);
    // Ligado pede um tipo; ligar pede a confirmação, e o código errado não liga.
    expect(problema(await mudar(e, { enabled: true, kinds: [], code: await codigo(e) }))).toEqual([422, 'sem-tipo']);
    expect(problema(await mudar(e, { enabled: true, kinds: ['elogio'] }))).toEqual([400, 'confirme-que-e-voce']);
    expect(problema(await mudar(e, { enabled: true, kinds: ['elogio'], code: codigoErrado(e.secret) }))).toEqual([401, 'codigo-invalido']);
    expect((await ver(e)).body).toMatchObject({ enabled: false });
    // O aprovador não liga, mas desliga e tira um tipo sem código.
    const aprovador = await pessoa(e, 'aprovador');
    expect((await ver(e, aprovador.cookie)).body).toMatchObject({ can_enable: false, can_disable: true });
    expect(problema(await mudar(e, { enabled: true, kinds: ['elogio'] }, aprovador.cookie))).toEqual([403, 'so-dono-ou-administrador']);
    const ligado = await mudar(e, { enabled: true, kinds: ['marcacao', 'elogio'], code: await codigo(e) });
    expect(ligado.status, JSON.stringify(ligado.body)).toBe(200);
    expect(ligado.body).toMatchObject({ available: true, enabled: true, kinds: ['elogio', 'marcacao'], updated_by: { id: e.userId } });
    // Somar um tipo pede o código; tirar, não (o aprovador tira a marcação e depois desliga).
    expect((await mudar(e, { enabled: true, kinds: ['elogio'] }, aprovador.cookie)).status).toBe(200);
    expect(problema(await mudar(e, { enabled: true, kinds: ['elogio', 'marcacao'] }, aprovador.cookie))).toEqual([403, 'so-dono-ou-administrador']);
    const desligado = await mudar(e, { enabled: false, kinds: ['elogio'] }, aprovador.cookie);
    expect(desligado.status, JSON.stringify(desligado.body)).toBe(200);
    expect(desligado.body).toMatchObject({ enabled: false, kinds: ['elogio'] });
    // Cada mudança na auditoria, com o antes e o depois.
    const trilha = await ownerQuery<{ before: { enabled: boolean } | null; after: { enabled: boolean; kinds: string[]; confirmed: boolean } | null }>(
      `select before, after from liame.audit_event where tenant_id = $1 and resource_id = $2 and action = 'comentarios.atendimento_automatico' order by chain_seq`,
      [e.tenantId, e.brandId],
    );
    expect(trilha.map((t) => [t.before?.enabled, t.after?.enabled, t.after?.kinds, t.after?.confirmed])).toEqual([
      [false, true, ['elogio', 'marcacao'], true],
      [true, true, ['elogio'], false],
      [true, false, ['elogio'], false],
    ]);
  }, 120_000);

  it('ligado para o elogio: ele sai sozinho, com o aviso; a marcação fora dos tipos, a reclamação e a segunda resposta à mesma pessoa no post esperam uma pessoa', async () => {
    const e = await empresa('Casa Brasa Automático Rotina');
    expect((await mudar(e, { enabled: true, kinds: ['elogio'], code: await codigo(e) })).status).toBe(200);
    const post = meta.publicadoForaDoLiame(e.instagram!.externo, { caption: 'Combo duplo na chapa', horas: 2, comments_count: 4 });
    const elogio = meta.comentouNoInstagram(post, { texto: 'Melhor smash da cidade, parabéns!', usuario: 'bia_lima' });
    const deNovo = meta.comentouNoInstagram(post, { texto: 'Sério, que smash incrível!', usuario: 'bia_lima' });
    const marcacao = meta.comentouNoInstagram(post, { texto: '@joana_s bora?', usuario: 'carla_m' });
    const reclamacao = meta.comentouNoInstagram(post, { texto: 'Demorou demais e veio frio', usuario: 'rui_s' });
    await ler(e);
    meta.normalizar();
    await fila.executarLote(10, { tenantIds: [e.tenantId] });

    const pedidos = await pedidosDe(e);
    // Os dois elogios da mesma pessoa no mesmo post: um sai sozinho (o que a fila tratou primeiro), já aprovado, com a
    // resposta pronta e o aviso no fim; o outro vai para uma pessoa.
    const daBia = [doComentario(pedidos, elogio)!, doComentario(pedidos, deNovo)!];
    expect(daBia.map((p) => p.tool).sort()).toEqual(['comentario_responder', 'comentario_responder_auto']);
    const auto = daBia.find((p) => p.tool === 'comentario_responder_auto')!;
    const comPessoa = daBia.find((p) => p.tool === 'comentario_responder')!;
    expect(auto).toMatchObject({ status: 'aprovada', mode: 'AUTO' });
    expect(comPessoa).toMatchObject({ status: 'aguardando_aprovacao' });
    expect(auto.params.texto!.endsWith(AVISO_DE_RESPOSTA_AUTOMATICA)).toBe(true);
    expect(RESPOSTAS_PRONTAS.elogio).toContain(auto.params.texto!.slice(0, -AVISO_DE_RESPOSTA_AUTOMATICA.length));
    // A marcação (fora dos tipos) e a reclamação: com uma pessoa.
    expect(doComentario(pedidos, marcacao)).toMatchObject({ tool: 'comentario_responder', status: 'aguardando_aprovacao' });
    expect(doComentario(pedidos, reclamacao)).toBeUndefined();
    // As respostas da última hora contam a automática.
    expect((await ver(e)).body).toMatchObject({ last_hour: 1 });

    // O executor publica sozinho, sem aprovação; os pedidos de Aprovações continuam esperando.
    await executor.runCycle(20, { tenantIds: [e.tenantId] });
    const naRede = meta.comentariosNoInstagram.get(post)!;
    const idDe = (p: { resource_id: string }) => p.resource_id.slice('comentario:'.length);
    expect(naRede.find((c) => c.id === idDe(auto))!.respostas.map((r) => r.text)).toEqual([auto.params.texto]);
    expect(naRede.find((c) => c.id === idDe(comPessoa))!.respostas).toEqual([]);
    expect((await pedidosDe(e)).find((p) => p.id === auto.id)!.status).toBe('executada');
    expect(meta.defeitos).toEqual([]);
  }, 120_000);

  it('desligar segura a resposta que já estava na fila; uma pessoa não pede a resposta automática direto', async () => {
    const e = await empresa('Casa Brasa Automático Desliga');
    expect((await mudar(e, { enabled: true, kinds: ['elogio'], code: await codigo(e) })).status).toBe(200);
    const post = meta.publicadoForaDoLiame(e.instagram!.externo, { caption: 'Combo', horas: 2, comments_count: 1 });
    const elogio = meta.comentouNoInstagram(post, { texto: 'Que delícia esse smash!', usuario: 'duda' });
    await ler(e);
    meta.normalizar();
    await fila.executarLote(10, { tenantIds: [e.tenantId] });
    const auto = doComentario(await pedidosDe(e), elogio)!;
    expect(auto).toMatchObject({ tool: 'comentario_responder_auto', status: 'aprovada' });
    // Desligado antes de o executor passar: nada sai.
    expect((await mudar(e, { enabled: false, kinds: ['elogio'] })).status).toBe(200);
    await executor.runCycle(20, { tenantIds: [e.tenantId] });
    expect(meta.comentariosNoInstagram.get(post)!.find((c) => c.id === elogio)!.respostas).toEqual([]);
    expect((await pedidosDe(e)).find((p) => p.id === auto.id)!.status).toBe('falhou');
    const execucao = await ownerQuery<{ status: string; error: string | null }>(`select status, error from liame.action_execution where action_request_id = $1`, [auto.id]);
    expect(execucao).toEqual([{ status: 'bloqueada', error: 'atendimento automático: automatico_desligado' }]);

    // Uma pessoa pedindo a ferramenta da resposta automática pela rota de sempre: recusado, antes de qualquer leitura.
    const direto = await api.call('POST', '/v1/actions', {
      cookie: e.cookie,
      body: { tool: 'comentario_responder_auto', brand_id: e.brandId, provider: 'instagram', account_id: e.instagram!.id, resource_id: `comentario:${elogio}`, params: { texto: `Valeu!${AVISO_DE_RESPOSTA_AUTOMATICA}` } },
    });
    expect(problema(direto)).toEqual([422, 'acao-so-pelo-automatico']);
  }, 120_000);

  it('ao ligar (2e-1b): o elogio que esperava em Aprovações, das 24 horas antes, vira a resposta automática; o texto mudado e o antigo ficam com a pessoa', async () => {
    const e = await empresa('Casa Brasa Automático Ao Ligar');
    const post = meta.publicadoForaDoLiame(e.instagram!.externo, { caption: 'Combo', horas: 40, comments_count: 3 });
    const recente = meta.comentouNoInstagram(post, { texto: 'Melhor smash da cidade, parabéns!', usuario: 'ana', horas: 2 });
    const mudado = meta.comentouNoInstagram(post, { texto: 'Que delícia esse smash!', usuario: 'beto', horas: 3 });
    const antigo = meta.comentouNoInstagram(post, { texto: 'Sério, que smash incrível!', usuario: 'caio', horas: 30 });
    // Desligado: os três vão para Aprovações, como sempre.
    await ler(e);
    meta.normalizar();
    await fila.executarLote(10, { tenantIds: [e.tenantId] });
    const antes = await pedidosDe(e);
    for (const id of [recente, mudado, antigo]) expect(doComentario(antes, id), id).toMatchObject({ tool: 'comentario_responder', status: 'aguardando_aprovacao' });
    // Uma pessoa muda o texto de um deles: ele é dela.
    const doMudado = doComentario(antes, mudado)!;
    expect((await api.call('PATCH', `/v1/actions/${doMudado.id}`, { cookie: e.cookie, body: { params: { texto: 'Valeu demais! Volte sempre que bater a fome.' } } })).status).toBe(200);

    // Liga o atendimento automático para o elogio: a rotina converte o que serve, uma vez.
    expect((await mudar(e, { enabled: true, kinds: ['elogio'], code: await codigo(e) })).status).toBe(200);
    const conversoes = await fila.executarConversoes(10, { tenantIds: [e.tenantId] });
    expect(conversoes.map((c) => c.feito.status).sort()).toEqual(['com_a_pessoa', 'respondida']);
    const depois = await pedidosDe(e);
    const doRecente = depois.filter((p) => p.resource_id === `comentario:${recente}`);
    expect(doRecente.map((p) => [p.tool, p.status]).sort()).toEqual([
      ['comentario_responder', 'cancelada'],
      ['comentario_responder_auto', 'aprovada'],
    ]);
    // O de texto mudado e o de mais de 24 horas antes de ligar seguem esperando a pessoa; e não voltam à fila.
    expect(doComentario(depois, mudado)).toMatchObject({ tool: 'comentario_responder', status: 'aguardando_aprovacao' });
    expect(doComentario(depois, antigo)).toMatchObject({ tool: 'comentario_responder', status: 'aguardando_aprovacao' });
    expect(await fila.executarConversoes(10, { tenantIds: [e.tenantId] })).toEqual([]);
    // Em Aprovações, o pedido convertido diz por quê.
    const convertido = await api.call('GET', `/v1/actions/${doComentario(antes, recente)!.id}`, { cookie: e.cookie });
    expect((convertido.body as { comment: { withdrawn: string | null } }).comment.withdrawn).toBe('atendimento_automatico');
    // O executor publica a automática.
    await executor.runCycle(20, { tenantIds: [e.tenantId] });
    expect(meta.comentariosNoInstagram.get(post)!.find((c) => c.id === recente)!.respostas[0]!.text.endsWith(AVISO_DE_RESPOSTA_AUTOMATICA)).toBe(true);
    expect(meta.defeitos).toEqual([]);
  }, 120_000);

  it('a prévia antes de ligar (2e-4): os elogios e as marcações das últimas 24 horas sem resposta, os mais novos primeiro, com a resposta que sairia', async () => {
    const e = await empresa('Casa Brasa Automático Prévia', { automatico: false });
    const post = meta.publicadoForaDoLiame(e.instagram!.externo, { caption: 'Combo', horas: 40, comments_count: 4 });
    const elogio = meta.comentouNoInstagram(post, { texto: 'Melhor smash da cidade, parabéns!', usuario: 'ana', horas: 3 });
    const marcacao = meta.comentouNoInstagram(post, { texto: '@joana_s bora?', usuario: 'carla_m', horas: 1 });
    meta.comentouNoInstagram(post, { texto: 'Demorou demais e veio frio', usuario: 'rui_s', horas: 2 });
    meta.comentouNoInstagram(post, { texto: 'Que delícia esse smash!', usuario: 'caio', horas: 30 });
    await ler(e);
    const r = await api.call('GET', `/v1/comments/auto-reply/preview?brand_id=${e.brandId}`, { cookie: e.cookie });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const itens = (r.body as { items: Array<{ id: string; kind: string; author: string | null; reply: string }> }).items;
    // A reclamação e o elogio de mais de 24 horas ficam de fora; o mais novo primeiro.
    expect(itens.map((i) => [i.id, i.kind, i.author])).toEqual([
      [marcacao, 'marcacao', 'carla_m'],
      [elogio, 'elogio', 'ana'],
    ]);
    for (const i of itens) {
      expect(i.reply.endsWith(AVISO_DE_RESPOSTA_AUTOMATICA)).toBe(true);
      expect(RESPOSTAS_PRONTAS[i.kind as 'elogio' | 'marcacao']).toContain(i.reply.slice(0, -AVISO_DE_RESPOSTA_AUTOMATICA.length));
    }
    // Nada foi publicado nem pedido.
    expect(await pedidosDe(e)).toEqual([]);
  }, 120_000);

  it('as regras da tabela (V119): os tipos, ligado com um tipo, uma linha por marca e a empresa da marca', async () => {
    const e = await empresa('Casa Brasa Automático Regras');
    const inserir = (kinds: string, enabled = true) =>
      ownerQuery(`insert into liame.comment_auto_reply (brand_id, tenant_id, enabled, kinds) values ($1, $2, $3, $4::text[])`, [e.brandId, e.tenantId, enabled, kinds]);
    await expect(inserir('{reclamacao}')).rejects.toThrow(/comment_auto_reply_kinds_check|check/);
    await expect(inserir('{}', true)).rejects.toThrow(/comment_auto_reply_ligado/);
    await inserir('{elogio,pergunta}');
    await expect(inserir('{elogio}')).rejects.toThrow(/comment_auto_reply_pkey|duplicate/);
    // Desligado sem tipo vale (é como nasce).
    await ownerQuery(`update liame.comment_auto_reply set enabled = false, kinds = '{}' where brand_id = $1`, [e.brandId]);
    // A RLS: outra empresa não vê a linha.
    const outra = await empresa('Casa Brasa Automático Outra');
    const r = await api.call('GET', `/v1/comments/auto-reply?brand_id=${e.brandId}`, { cookie: outra.cookie });
    expect(r.status).toBe(404);
  }, 120_000);
});
