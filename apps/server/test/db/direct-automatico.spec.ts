import { resolve } from 'node:path';
import { DIRECT_AUTO_REPLY_NOTICE } from '@liame/contracts';
import { type Database, runMigrations } from '@liame/database';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ActionService } from '../../src/actions/action.service.js';
import { BudgetService } from '../../src/actions/budget.service.js';
import { directNoInstagramConnector } from '../../src/actions/direct-na-rede.js';
import { RESPOSTAS_PRONTAS } from '../../src/ai/social/comentario.js';
import { currentStep, totpCode } from '../../src/auth/totp.js';
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
//   - a prévia mostra o que sairia, sem mandar nada.

describe.skipIf(!hasDb)('o atendimento automático do Direct (A6 · Z12, parte 5a)', () => {
  let api: TestApi;
  let database: Database;
  let executor: ActionExecutor;
  let loop: DirectAutomaticoLoop;
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
    loop = new DirectAutomaticoLoop(database, flags, api.app.get(ActionService));
    directNoInstagramConnector.ligar({
      lerSegredo: (tx, id) => vault.readSecret(tx, id),
      cliente: (tempoLimiteMs) =>
        new ClienteConector(database.db, { enderecos: { meta_ads: [meta.base] }, tentativas: 1, balde: { capacidade: 10_000, porSegundo: 1_000 }, ...(tempoLimiteMs ? { tempoLimiteMs } : {}) }),
      graphUrl: meta.base,
      appSecret: SEGREDO_DO_APP,
      appId: APP_DA_META,
      versao: (capacidade) => versaoRegistrada(database.db, 'meta_ads', capacidade),
    });
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
});
