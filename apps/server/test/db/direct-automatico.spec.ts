import { resolve } from 'node:path';
import { DIRECT_AUTO_REPLY_NOTICE } from '@liame/contracts';
import { type Database, runMigrations } from '@liame/database';
import { MockLanguageModelV4 } from 'ai/test';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ActionService } from '../../src/actions/action.service.js';
import { BudgetService } from '../../src/actions/budget.service.js';
import { type DependenciasDoDirect, directNoInstagramConnector, directNoMessengerConnector } from '../../src/actions/direct-na-rede.js';
import { AiGateway } from '../../src/ai/gateway.js';
import { ModelosIa } from '../../src/ai/modelos.js';
import { naTransacaoDaEmpresa } from '../../src/ai/na-empresa.js';
import { RESPOSTAS_PRONTAS } from '../../src/ai/social/comentario.js';
import { TAREFA_SOCIAL_DIRECT } from '../../src/ai/social/direct.js';
import { currentStep, totpCode } from '../../src/auth/totp.js';
import { APP_CONFIG, type AppConfig } from '../../src/config.js';
import { ClienteConector } from '../../src/connectors/cliente-http.js';
import { versaoRegistrada } from '../../src/connectors/tipos.js';
import { DATABASE } from '../../src/database/database.module.js';
import { comAvisoDoDirect } from '../../src/direct/automatico.js';
import { RESPOSTAS_DA_MENCAO } from '../../src/direct/tipo-no-direct.js';
import { FlagService } from '../../src/flags/flag.service.js';
import { KillSwitchService } from '../../src/kill-switch/kill-switch.service.js';
import { VaultService } from '../../src/vault/vault.service.js';
import { ActionExecutor } from '../../src/worker/action-executor.js';
import { DirectAutomaticoLoop } from '../../src/worker/direct-automatico.js';
import { ownerQuery, resetIpRateLimits, startApi, type TestApi } from '../helpers/api.js';
import { ligarIa, ModelosDeTeste, responde, rotaCompartilhada } from '../helpers/ia.js';
import { APP_DA_META, InstagramDeMentira, SEGREDO_DO_APP, TOKEN_DO_INSTAGRAM } from '../helpers/instagram-de-mentira.js';
import { ligarFlagDaEmpresa } from '../helpers/meta-de-mentira.js';
import { type EmpresaComCanais, empresaComCanais } from '../helpers/posts-semeados.js';
import { hasDb, OWNER_URL } from './env.js';

// A6 · Z12, parte 5a: o atendimento automático do Direct (migration 0133; P39 versão 2, D-A6-115 e D-A6-119; a política
// v14), contra Postgres e a Meta local. O que se prova:
//   - ligar pede o Dono ou um Administrador, a função, o Direct ligado e o código do app; ligado pede um tipo; desligar
//     é sem código, e a auditoria guarda o antes e o depois;
//   - ligado, a rotina responde sozinha o elogio e a menção no story, com a resposta pronta e o aviso no fim, pelo trilho
//     (o funcionário de IA, no modo automático) e o executor manda pela Meta; a pergunta, a reclamação e quem pede uma
//     pessoa ficam com a equipe; a mesma mensagem não é decidida duas vezes, e a seguinte da pessoa é;
//   - a terceira automática seguida na mesma conversa vai para a equipe;
//   - desligar depois do pedido segura o que estava na fila (o executor confere o portão de novo); sem a função, nada sai;
//   - a prévia mostra o que sairia, sem mandar nada;
//   - o Messenger da Página (A6, Z14, parte 2; D-A6-122): o mesmo automático; com o Messenger desligado na marca, a
//     conversa fica com a equipe; ligado, o elogio sai pela Página;
//   - a pergunta (parte 5c; D-A6-148), com o modelo simulado: com a certeza do Social media (o "sim", a conferência sem
//     aviso e nada tirado), sai sozinha com o texto dele e o aviso; sem certeza, com a conferência barrando ou falando de
//     brinde (sem chamar o modelo), fica com a equipe; tirar o tipo segura o que estava na fila; o pedido sem o aviso no
//     fim é recusado.

/** Minha marca do teste da pergunta (a mesma da sugestão a pedido, `direct-sugestao.spec.ts`). */
const DOSSIE = {
  identity: { summary: 'Hamburgueria de bairro com smash feito na chapa', audience: 'Quem mora ou trabalha no Centro', differentiator: 'Pão feito na casa todo dia', since: '2019' },
  voice: { traits: ['Direta'], rules: ['Frases curtas.'], do_example: 'Bateu a fome? O smash sai da chapa rapidinho.', dont_example: '' },
  products: { items: ['Smash Clássico R$ 29,90'] },
  offers: { items: ['Combo sexta: smash, batata e refri por R$ 34,90'] },
  forbidden: { items: [{ text: 'o melhor hambúrguer do Rio', why: 'não temos como provar' }] },
  region: { area: 'Centro e Lapa', pickup: true },
};
const DA_PERGUNTA = { enfoque: 'Responde com a oferta', texto: 'Oi! O Combo sexta sai por R$ 34,90, com smash, batata e refri.' };

describe.skipIf(!hasDb)('o atendimento automático do Direct (A6 · Z12, partes 5a e 5c)', () => {
  let api: TestApi;
  let database: Database;
  let executor: ActionExecutor;
  let loop: DirectAutomaticoLoop;
  let flagsDoTeste: FlagService;
  let modelos: ModelosDeTeste;
  let alvo: Awaited<ReturnType<typeof rotaCompartilhada>>;
  const meta = new InstagramDeMentira();

  beforeAll(async () => {
    await runMigrations({ connectionString: OWNER_URL, dir: resolve(process.cwd(), '../../packages/database/migrations') });
    api = await startApi();
    await resetIpRateLimits();
    await meta.ligar();
    database = api.app.get(DATABASE);
    const vault = api.app.get(VaultService);
    const flags = api.app.get(FlagService);
    executor = new ActionExecutor(database, api.app.get(BudgetService), api.app.get(KillSwitchService), flags);
    loop = new DirectAutomaticoLoop(database, flags, api.app.get(ActionService), api.app.get(AiGateway));
    flagsDoTeste = flags;
    // O modelo simulado da sugestão do Direct (parte 5c): a rota da tarefa aponta para um modelo de teste.
    const config: AppConfig = api.app.get(APP_CONFIG);
    modelos = new ModelosDeTeste(config);
    api.app.get(ModelosIa).modelo = (provider, model) => modelos.modelo(provider, model);
    alvo = await rotaCompartilhada(modelos, TAREFA_SOCIAL_DIRECT, new MockLanguageModelV4({ doGenerate: [] }));
    const doDirect: DependenciasDoDirect = {
      lerSegredo: (tx, id) => vault.readSecret(tx, id),
      cliente: (tempoLimiteMs) =>
        new ClienteConector(database.db, { enderecos: { meta_ads: [meta.base] }, tentativas: 1, balde: { capacidade: 10_000, porSegundo: 1_000 }, ...(tempoLimiteMs ? { tempoLimiteMs } : {}) }),
      graphUrl: meta.base,
      appSecret: SEGREDO_DO_APP,
      appId: APP_DA_META,
      versao: (capacidade) => versaoRegistrada(database.db, 'meta_ads', capacidade),
    };
    directNoInstagramConnector.ligar(doDirect);
    directNoMessengerConnector.ligar(doDirect);
  }, 120_000);
  beforeEach(async () => {
    await resetIpRateLimits();
    meta.normalizar();
  });
  afterAll(async () => {
    await meta.desligar();
    await api?.close();
  });

  /** A empresa com o Direct ligado na marca e as funções do automático (ou não). */
  async function empresa(nome: string, o: { automatico?: boolean } = {}): Promise<EmpresaComCanais> {
    const e = await empresaComCanais(api, nome, { token: TOKEN_DO_INSTAGRAM, instagram: true, pagina: true });
    meta.paginas.set(e.pagina!.externo, ['MODERATE', 'MESSAGING']);
    for (const flag of ['direct', 'direct_responder'] as const) await ligarFlagDaEmpresa(api, flag, e.tenantId, true);
    await ligarFlagDaEmpresa(api, 'direct_automatico', e.tenantId, o.automatico ?? true);
    await ownerQuery(`insert into liame.direct_setting (brand_id, tenant_id, enabled, sem_outro_programa) values ($1, $2, true, true)`, [e.brandId, e.tenantId]);
    return e;
  }
  /** A conversa como a leitura a deixaria: a Meta tem as mensagens, o Liame as guardou. */
  async function conversa(
    e: EmpresaComCanais,
    usuario: string,
    mensagens: { texto?: string; story?: 'mention' | 'reply_to'; daMarca?: boolean; minutos: number }[],
  ): Promise<{ id: string; ultima: string }> {
    let id = '';
    for (const m of mensagens) {
      if (m.daMarca) meta.marcaNoDirect(id, m.texto ?? '', m.minutos);
      else id = meta.escreveuNoDirect(e.pagina!.externo, { usuario, minutos: m.minutos, ...(m.texto !== undefined ? { texto: m.texto } : {}), ...(m.story ? { story: m.story } : {}) });
    }
    const naMeta = meta.conversasDoDirect.find((c) => c.id === id)!;
    const ultimaDaPessoa = [...naMeta.mensagens].reverse().find((m) => !m.daMarca)!;
    const ultima = naMeta.mensagens.at(-1)!;
    await ownerQuery(
      `insert into liame.direct_conversation (connected_account_id, tenant_id, brand_id, conversation_id, participant_id, username, last_message_at, last_inbound_at,
                                              last_direction, unread, meta_updated_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, true, $7)`,
      [e.instagram!.id, e.tenantId, e.brandId, id, naMeta.pessoa.id, usuario, ultima.created_time, ultimaDaPessoa.created_time, ultima.daMarca ? 'saida' : 'entrada'],
    );
    for (const m of naMeta.mensagens) {
      await ownerQuery(
        `insert into liame.direct_message (connected_account_id, tenant_id, brand_id, conversation_id, message_id, direction, kind, body, sent_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [e.instagram!.id, e.tenantId, e.brandId, id, m.id, m.daMarca ? 'saida' : 'entrada', m.story === 'mention' ? 'story_mencao' : m.story ? 'story_resposta' : 'texto', m.texto, m.created_time],
      );
    }
    return { id, ultima: ultimaDaPessoa.id };
  }
  /** A conversa do Messenger como a leitura a deixaria (Z14): a conta é a Página; sem @, com o nome. */
  async function conversaNoMessenger(e: EmpresaComCanais, nome: string, texto: string, minutos: number): Promise<string> {
    const id = meta.escreveuNoMessenger(e.pagina!.externo, { nome, texto, minutos });
    const naMeta = meta.conversasDoDirect.find((c) => c.id === id)!;
    const m = naMeta.mensagens[0]!;
    await ownerQuery(
      `insert into liame.direct_conversation (connected_account_id, tenant_id, brand_id, conversation_id, participant_id, display_name, channel,
                                              last_message_at, last_inbound_at, last_direction, unread, meta_updated_at)
       values ($1, $2, $3, $4, $5, $6, 'messenger', $7, $7, 'entrada', true, $7)`,
      [e.pagina!.id, e.tenantId, e.brandId, id, naMeta.pessoa.id, nome, m.created_time],
    );
    await ownerQuery(
      `insert into liame.direct_message (connected_account_id, tenant_id, brand_id, conversation_id, message_id, direction, kind, body, sent_at)
       values ($1, $2, $3, $4, $5, 'entrada', 'texto', $6, $7)`,
      [e.pagina!.id, e.tenantId, e.brandId, id, m.id, texto, m.created_time],
    );
    return id;
  }
  async function codigo(e: EmpresaComCanais): Promise<string> {
    await ownerQuery(`update liame.app_user set totp_last_step = null where id = $1`, [e.userId]);
    await ownerQuery(`delete from liame.rate_limit where key = $1`, [`segundo-fator:${e.userId}`]);
    return totpCode(e.secret, currentStep());
  }
  const mudar = (e: EmpresaComCanais, body: Record<string, unknown>) => api.call('PUT', '/v1/direct/auto-reply', { cookie: e.cookie, body: { brand_id: e.brandId, ...body } });
  const ver = (e: EmpresaComCanais) => api.call('GET', `/v1/direct/auto-reply?brand_id=${e.brandId}`, { cookie: e.cookie });
  const rodar = (e: EmpresaComCanais) => loop.executarLote(20, { tenantIds: [e.tenantId] });
  const ciclo = (e: EmpresaComCanais) => executor.runCycle(20, { tenantIds: [e.tenantId] });
  const pedidos = (e: EmpresaComCanais) =>
    ownerQuery<{ id: string; status: string; status_reason: string | null; mode: string; actor_type: string; resource_id: string }>(
      `select id, status, status_reason, mode, actor_type, resource_id from liame.action_request where tenant_id = $1 and tool = 'direct_responder_auto' order by created_at`,
      [e.tenantId],
    );
  const daMarca = (id: string) => meta.conversasDoDirect.find((c) => c.id === id)!.mensagens.filter((m) => m.daMarca).map((m) => m.texto);
  const problema = (r: { status: number; body: unknown }) => [r.status, (r.body as { code?: string }).code];
  const ligado = async (e: EmpresaComCanais) => {
    const r = await mudar(e, { enabled: true, kinds: ['pronta'], code: await codigo(e) });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
  };

  it('ligar pede o código e um tipo; ligado, responde o elogio e a menção com a resposta pronta e o aviso; a pergunta, a reclamação e quem pede uma pessoa ficam com a equipe', async () => {
    const e = await empresa('Casa Brasa Direct Automático');
    expect((await ver(e)).body).toMatchObject({ available: true, enabled: false, kinds: [], can_enable: true, can_disable: true, last_hour: 0, hourly_limit: 30 });
    expect(problema(await mudar(e, { enabled: true, kinds: ['pronta'] }))).toEqual([400, 'confirme-que-e-voce']);
    expect(problema(await mudar(e, { enabled: true, kinds: [], code: await codigo(e) }))).toEqual([422, 'sem-tipo']);

    const elogio = await conversa(e, 'carla.m', [{ texto: 'Que delícia esse smash!', minutos: 9 }]);
    const mencao = await conversa(e, 'bia.costa', [{ story: 'mention', minutos: 8 }]);
    const pergunta = await conversa(e, 'ana.paula_rj', [{ texto: 'Vocês entregam na Penha?', minutos: 7 }]);
    const reclamacao = await conversa(e, 'rui.s', [{ texto: 'Chegou frio e faltou a batata.', minutos: 6 }]);
    const pessoa = await conversa(e, 'lucas_fern', [{ texto: 'Amei! Mas quero falar com um atendente.', minutos: 5 }]);

    // A prévia, antes de ligar: o que sairia, sem mandar nada.
    const previa = (await api.call('GET', `/v1/direct/auto-reply/preview?brand_id=${e.brandId}`, { cookie: e.cookie })).body as { items: { conversation_id: string; kind: string; reply: string }[] };
    expect(previa.items.map((i) => [i.conversation_id, i.kind]).sort()).toEqual([[elogio.id, 'elogio'], [mencao.id, 'mencao']].sort());
    expect(previa.items.every((i) => i.reply.endsWith(DIRECT_AUTO_REPLY_NOTICE))).toBe(true);
    expect(meta.chamadas.filter((c) => c.metodo === 'POST' && c.caminho.endsWith('/messages'))).toEqual([]);

    // Desligado, a rotina não olha nada.
    expect(await rodar(e)).toEqual([]);
    await ligado(e);
    const [auditoria] = await ownerQuery<{ before: unknown; after: unknown }>(
      `select before, after from liame.audit_event where tenant_id = $1 and action = 'direct.atendimento_automatico' order by occurred_at desc limit 1`,
      [e.tenantId],
    );
    expect(auditoria).toMatchObject({ before: { enabled: false, kinds: [] }, after: { enabled: true, kinds: ['pronta'], confirmed: true } });

    const vezes = Object.fromEntries((await rodar(e)).map((v) => [v.conversa, v.status === 'com_a_pessoa' ? v.motivo : v.status]));
    expect(vezes).toEqual({
      [elogio.id]: 'respondida',
      [mencao.id]: 'respondida',
      [pergunta.id]: 'tipo_fora_do_automatico',
      [reclamacao.id]: 'tipo_fora_do_automatico',
      [pessoa.id]: 'pede_uma_pessoa',
    });
    // A mesma mensagem não é decidida de novo.
    expect(await rodar(e)).toEqual([]);
    const feitos = await pedidos(e);
    expect(feitos.map((p) => [p.resource_id, p.status, p.mode, p.actor_type]).sort()).toEqual(
      [
        [`direct:${elogio.id}`, 'aprovada', 'AUTO', 'agent'],
        [`direct:${mencao.id}`, 'aprovada', 'AUTO', 'agent'],
      ].sort(),
    );

    await ciclo(e);
    expect((await pedidos(e)).map((p) => p.status)).toEqual(['executada', 'executada']);
    const doElogio = daMarca(elogio.id);
    expect(doElogio).toHaveLength(1);
    expect(RESPOSTAS_PRONTAS.elogio.map((t) => comAvisoDoDirect(t))).toContain(doElogio[0]);
    expect(RESPOSTAS_DA_MENCAO.map((t) => comAvisoDoDirect(t))).toContain(daMarca(mencao.id)[0]);
    for (const id of [pergunta.id, reclamacao.id, pessoa.id]) expect(daMarca(id)).toEqual([]);
    expect((await ver(e)).body).toMatchObject({ enabled: true, kinds: ['pronta'], last_hour: 2 });
    expect(meta.defeitos).toEqual([]);
  }, 120_000);

  it('a terceira automática seguida vai para a equipe; desligar segura o que estava na fila; sem a função, nada sai', async () => {
    const e = await empresa('Casa Brasa Direct Seguidas');
    await ligado(e);
    // Duas respostas automáticas seguidas no fim da conversa, e um elogio novo: o terceiro fica com a equipe.
    const fa = await conversa(e, 'fa.da.casa', [
      { texto: 'Amei o combo!', minutos: 30 },
      { texto: comAvisoDoDirect('Obrigado pelo carinho! Esperamos você de novo.'), daMarca: true, minutos: 29 },
      { texto: 'Melhor smash da Penha!', minutos: 20 },
      { texto: comAvisoDoDirect('Que bom que você gostou! Volte sempre.'), daMarca: true, minutos: 19 },
      { texto: 'Top demais!', minutos: 5 },
    ]);
    expect(await rodar(e)).toEqual([{ conversa: fa.id, status: 'com_a_pessoa', motivo: 'automaticas_seguidas' }]);

    // Pedido feito, e o automático desligado antes do executor: o pedido não sai.
    const carla = await conversa(e, 'carla.m', [{ texto: 'Que delícia!', minutos: 3 }]);
    expect(await rodar(e)).toMatchObject([{ conversa: carla.id, status: 'respondida' }]);
    expect((await mudar(e, { enabled: false, kinds: ['pronta'] })).status).toBe(200);
    await ciclo(e);
    const [segurado] = await pedidos(e);
    expect(segurado).toMatchObject({ status: 'falhou' });
    const execucao = await ownerQuery<{ status: string; error: string | null }>(`select status, error from liame.action_execution where action_request_id = $1`, [segurado!.id]);
    expect(execucao).toEqual([{ status: 'bloqueada', error: 'atendimento automático: automatico_desligado' }]);
    expect(daMarca(carla.id)).toEqual([]);

    // Uma pessoa pedindo a ferramenta da resposta automática pela rota de sempre: recusado.
    const direto = await api.call('POST', '/v1/actions', {
      cookie: e.cookie,
      body: { tool: 'direct_responder_auto', brand_id: e.brandId, provider: 'instagram', account_id: e.instagram!.id, resource_id: `direct:${carla.id}`, params: { texto: comAvisoDoDirect('Valeu!') } },
    });
    expect(problema(direto)).toEqual([422, 'acao-so-pelo-automatico']);

    // Sem a função, ligar recusa, e a rotina não pede nada.
    const sem = await empresa('Casa Brasa Direct Sem Função', { automatico: false });
    expect(problema(await mudar(sem, { enabled: true, kinds: ['pronta'], code: await codigo(sem) }))).toEqual([409, 'funcao-desligada']);
    await ownerQuery(`insert into liame.direct_auto_reply (brand_id, tenant_id, enabled, kinds) values ($1, $2, true, '{pronta}')`, [sem.brandId, sem.tenantId]);
    const bia = await conversa(sem, 'bia.costa', [{ texto: 'Amei!', minutos: 2 }]);
    expect(await rodar(sem)).toEqual([{ conversa: bia.id, status: 'com_a_pessoa', motivo: 'automatico_desligado' }]);
    expect(await pedidos(sem)).toEqual([]);
    expect(meta.defeitos).toEqual([]);
  }, 120_000);
  it('Z14, parte 2 (D-A6-122): no Messenger, o mesmo automático: desligado na marca, a conversa fica com a equipe; ligado, o elogio sai pela Página com o aviso', async () => {
    const e = await empresa('Casa Brasa Messenger Automático');
    await ligado(e);
    const carla = await conversaNoMessenger(e, 'Carla Mendes', 'Que delícia esse smash!', 6);
    // Sem a função `messenger`, e depois sem o Messenger ligado na marca: fica com a equipe.
    expect(await rodar(e)).toMatchObject([{ conversa: carla, status: 'com_a_pessoa', motivo: 'automatico_desligado' }]);
    await ligarFlagDaEmpresa(api, 'messenger', e.tenantId, true);
    const bia = await conversaNoMessenger(e, 'Bia Costa', 'Amei o atendimento de vocês!', 5);
    expect(await rodar(e)).toMatchObject([{ conversa: bia, status: 'com_a_pessoa', motivo: 'direct_desligado' }]);

    // Ligado na marca: o elogio sai pela Página, com a resposta pronta e o aviso no fim.
    await ownerQuery(`insert into liame.messenger_setting (brand_id, tenant_id, enabled, sem_outro_programa) values ($1, $2, true, true)`, [e.brandId, e.tenantId]);
    const joana = await conversaNoMessenger(e, 'Joana Lima', 'Que delícia esse burger!', 4);
    expect(await rodar(e)).toMatchObject([{ conversa: joana, status: 'respondida' }]);
    const [doPedido] = await ownerQuery<{ provider: string; account_id: string }>(
      `select provider, account_id from liame.action_request where tenant_id = $1 and tool = 'direct_responder_auto'`,
      [e.tenantId],
    );
    expect(doPedido).toEqual({ provider: 'facebook_page', account_id: e.pagina!.id });
    await ciclo(e);
    expect((await pedidos(e)).map((p) => p.status)).toEqual(['executada']);
    const saiu = daMarca(joana);
    expect(saiu).toHaveLength(1);
    expect(RESPOSTAS_PRONTAS.elogio.map((t) => comAvisoDoDirect(t))).toContain(saiu[0]);
    expect(meta.chamadas.some((c) => c.metodo === 'POST' && c.caminho.endsWith(`${e.pagina!.externo}/messages`))).toBe(true);
    expect(daMarca(carla)).toEqual([]);
    expect(meta.defeitos).toEqual([]);
  }, 120_000);

  it('parte 5c (D-A6-148): a pergunta com a certeza do Social media sai sozinha; sem certeza, barrada ou com brinde, fica com a equipe; tirar o tipo segura a fila', async () => {
    const e = await empresa('Casa Brasa Direct Pergunta');
    await ligarIa(flagsDoTeste, e.tenantId);
    const salvo = await api.call('PUT', '/v1/brand-dossier', { cookie: e.cookie, body: { brand_id: e.brandId, base_version: 0, content: DOSSIE } });
    expect(salvo.status, JSON.stringify(salvo.body)).toBe(200);
    const responder = (r: Record<string, unknown>) => {
      const mock = responde(JSON.stringify(r));
      modelos.porChave.set(`${alvo.provider}/${alvo.model}`, mock);
      return mock;
    };
    const vez = async () => (await rodar(e)).map((v) => [v.conversa, v.status === 'com_a_pessoa' ? v.motivo : v.status]);

    // Só a resposta pronta marcada: a pergunta fica com a equipe, sem chamar o modelo.
    await ligado(e);
    let mock = responder({ sugestoes: [DA_PERGUNTA], respondida: 'sim', falta: '' });
    const antes = await conversa(e, 'joao.p', [{ texto: 'Quanto tá o combo de sexta?', minutos: 40 }]);
    expect(await vez()).toEqual([[antes.id, 'tipo_fora_do_automatico']]);
    expect(mock.doGenerateCalls).toHaveLength(0);

    // Somar a pergunta pede o código; com ela, a pergunta certa sai sozinha, com o texto do Social media e o aviso.
    expect(problema(await mudar(e, { enabled: true, kinds: ['pronta', 'pergunta'] }))).toEqual([400, 'confirme-que-e-voce']);
    const somou = await mudar(e, { enabled: true, kinds: ['pronta', 'pergunta'], code: await codigo(e) });
    expect(somou.status, JSON.stringify(somou.body)).toBe(200);
    expect(somou.body).toMatchObject({ enabled: true, kinds: ['pronta', 'pergunta'] });
    const certa = await conversa(e, 'ana.paula_rj', [{ texto: 'Quanto tá o combo de sexta?', minutos: 9 }]);
    expect(await vez()).toEqual([[certa.id, 'respondida']]);
    // O modelo recebeu a conversa sem o @ de quem escreveu, em nome do sistema (sem pessoa).
    expect(mock.doGenerateCalls).toHaveLength(1);
    expect(JSON.stringify(mock.doGenerateCalls[0]!.prompt)).toContain('Pessoa: Quanto tá o combo de sexta?');
    expect(JSON.stringify(mock.doGenerateCalls[0]!.prompt)).not.toContain('ana.paula_rj');
    const [uso] = await ownerQuery<{ task: string; user_id: string | null }>(`select task, user_id from liame.ai_usage where tenant_id = $1 order by occurred_at desc limit 1`, [e.tenantId]);
    expect(uso).toEqual({ task: 'social_direct', user_id: null });
    await ciclo(e);
    expect((await pedidos(e)).map((p) => [p.resource_id, p.status, p.mode, p.actor_type])).toEqual([[`direct:${certa.id}`, 'executada', 'AUTO', 'agent']]);
    expect(daMarca(certa.id)).toEqual([comAvisoDoDirect(DA_PERGUNTA.texto)]);

    // Sem certeza (o "nao", com o que faltou): fica com a equipe, sem pedido.
    responder({ sugestoes: [{ enfoque: 'Confirma com a loja', texto: 'Oi! Vou confirmar o horário do feriado com a loja e te respondo por aqui.' }], respondida: 'nao', falta: 'o horário do feriado' });
    const feriado = await conversa(e, 'rui.s', [{ texto: 'Abre no feriado?', minutos: 8 }]);
    expect(await vez()).toEqual([[feriado.id, 'sem_certeza']]);

    // O "sim" com um preço que Minha marca não tem: a conferência barra, e fica com a equipe.
    responder({ sugestoes: [{ enfoque: 'Responde com a oferta', texto: 'Oi! O Combo sexta sai por R$ 19,90.' }], respondida: 'sim', falta: '' });
    const barrada = await conversa(e, 'lia.m', [{ texto: 'E o combo de sexta, quanto é?', minutos: 7 }]);
    expect(await vez()).toEqual([[barrada.id, 'barrado']]);

    // Brinde (o caso do eval, D-A6-147): fica com a equipe sem chamar o modelo.
    mock = responder({ sugestoes: [DA_PERGUNTA], respondida: 'sim', falta: '' });
    const brinde = await conversa(e, 'bia.costa', [{ texto: 'Se eu levar dois combos na sexta vocês mandam uma batata de brinde?', minutos: 6 }]);
    expect(await vez()).toEqual([[brinde.id, 'compensacao_ou_saude']]);
    expect(mock.doGenerateCalls).toHaveLength(0);
    expect((await pedidos(e)).map((p) => p.resource_id)).toEqual([`direct:${certa.id}`]);
    for (const id of [antes.id, feriado.id, barrada.id, brinde.id]) expect(daMarca(id)).toEqual([]);

    // Pedido feito, e a pergunta tirada dos tipos antes do executor (sem código): o pedido não sai.
    const lucas = await conversa(e, 'lucas_fern', [{ texto: 'Vocês fazem retirada no balcão?', minutos: 4 }]);
    responder({ sugestoes: [{ enfoque: 'Responde com a retirada', texto: 'Oi! Fazemos retirada, sim.' }], respondida: 'sim', falta: '' });
    expect(await vez()).toEqual([[lucas.id, 'respondida']]);
    expect((await mudar(e, { enabled: true, kinds: ['pronta'] })).status).toBe(200);
    await ciclo(e);
    const segurado = (await pedidos(e)).find((p) => p.resource_id === `direct:${lucas.id}`)!;
    expect(segurado).toMatchObject({ status: 'falhou' });
    const execucao = await ownerQuery<{ status: string; error: string | null }>(`select status, error from liame.action_execution where action_request_id = $1`, [segurado.id]);
    expect(execucao).toEqual([{ status: 'bloqueada', error: 'atendimento automático: tipo_fora_do_automatico' }]);
    expect(daMarca(lucas.id)).toEqual([]);

    // O pedido da resposta automática sem o aviso no fim: recusado antes do portão.
    const semAviso = naTransacaoDaEmpresa(database, { tenantId: e.tenantId, userId: null }, () =>
      api.app.get(ActionService).responderSozinhoNoDirect(
        { tenantId: e.tenantId, agentKey: 'social', agentLabel: 'Social media', emNomeDe: e.userId },
        { tool: 'direct_responder_auto', brand_id: e.brandId, provider: 'instagram', account_id: e.instagram!.id, resource_id: `direct:${lucas.id}`, params: { texto: 'Oi! Fazemos retirada, sim.' } },
      ),
    );
    await expect(semAviso).rejects.toMatchObject({ code: 'sem-aviso-de-automatica' });
    expect(meta.defeitos).toEqual([]);
  }, 120_000);
});
