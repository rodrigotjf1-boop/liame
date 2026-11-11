import { resolve } from 'node:path';
import { type Database, runMigrations } from '@liame/database';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { BudgetService } from '../../src/actions/budget.service.js';
import { directNoInstagramConnector } from '../../src/actions/direct-na-rede.js';
import { currentStep, totpCode } from '../../src/auth/totp.js';
import { ClienteConector } from '../../src/connectors/cliente-http.js';
import { versaoRegistrada } from '../../src/connectors/tipos.js';
import { DATABASE } from '../../src/database/database.module.js';
import { FlagService } from '../../src/flags/flag.service.js';
import { KillSwitchService } from '../../src/kill-switch/kill-switch.service.js';
import { VaultService } from '../../src/vault/vault.service.js';
import { ActionExecutor } from '../../src/worker/action-executor.js';
import { ownerQuery, resetIpRateLimits, startApi, type TestApi } from '../helpers/api.js';
import { APP_DA_META, InstagramDeMentira, SEGREDO_DO_APP, TOKEN_DO_INSTAGRAM } from '../helpers/instagram-de-mentira.js';
import { ligarFlagDaEmpresa } from '../helpers/meta-de-mentira.js';
import { type EmpresaComCanais, empresaComCanais } from '../helpers/posts-semeados.js';
import { hasDb, OWNER_URL } from './env.js';

// A6 · Z12, parte 2: responder no Direct (migration 0131; P39, D-A6-109 e D-A6-111; a política v13), contra Postgres e
// a Meta local. O que se prova:
//   - sem o atendimento aberto, a resposta não sai (409); abrir pede o código do app e vale 8 horas; fechar volta a pedir;
//   - com ele aberto, o pedido nasce aprovado (sem Aprovações), o executor manda pela Meta com o IGSID e o texto, e a
//     conversa do Liame fica respondida, com a mensagem; o pedido direto pela rota das ações é recusado (422);
//   - a resposta que saiu sem a volta da Meta não sai duas vezes na tentativa seguinte;
//   - fora da janela de 24 horas, o plano recusa (422); com outro app dono da conversa, nada sai, com a frase certa.

const RESPOSTA = 'Oi! Entregamos na Penha, sim. O Combo duplo sai por R$ 39,90.';

describe.skipIf(!hasDb)('responder no Direct (A6 · Z12, parte 2)', () => {
  let api: TestApi;
  let database: Database;
  let executor: ActionExecutor;
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

  /** A empresa com o Direct ligado na marca e uma conversa da pessoa, como a rotina da leitura a deixaria. */
  async function empresa(nome: string, o: { minutos?: number } = {}): Promise<{ e: EmpresaComCanais; conversa: string }> {
    const e = await empresaComCanais(api, nome, { token: TOKEN_DO_INSTAGRAM, instagram: true, pagina: true });
    meta.paginas.set(e.pagina!.externo, ['MODERATE', 'MESSAGING']);
    for (const flag of ['direct', 'direct_responder'] as const) await ligarFlagDaEmpresa(api, flag, e.tenantId, true);
    await ownerQuery(`insert into liame.direct_setting (brand_id, tenant_id, enabled, sem_outro_programa) values ($1, $2, true, true)`, [e.brandId, e.tenantId]);
    const minutos = o.minutos ?? 5;
    const conversa = meta.escreveuNoDirect(e.pagina!.externo, { usuario: 'ana.paula_rj', texto: 'Oi! Vocês entregam na Penha?', minutos });
    const naMeta = meta.conversasDoDirect.find((c) => c.id === conversa)!;
    const quando = new Date(Date.now() - minutos * 60_000).toISOString();
    await ownerQuery(
      `insert into liame.direct_conversation (connected_account_id, tenant_id, brand_id, conversation_id, participant_id, username, last_message_at, last_inbound_at,
                                              last_direction, unread, meta_updated_at)
       values ($1, $2, $3, $4, $5, 'ana.paula_rj', $6, $6, 'entrada', true, $6)`,
      [e.instagram!.id, e.tenantId, e.brandId, conversa, naMeta.pessoa.id, quando],
    );
    await ownerQuery(
      `insert into liame.direct_message (connected_account_id, tenant_id, brand_id, conversation_id, message_id, direction, kind, body, sent_at)
       values ($1, $2, $3, $4, $5, 'entrada', 'texto', $6, $7)`,
      [e.instagram!.id, e.tenantId, e.brandId, conversa, naMeta.mensagens[0]!.id, naMeta.mensagens[0]!.texto, quando],
    );
    return { e, conversa };
  }
  async function codigo(e: EmpresaComCanais): Promise<string> {
    await ownerQuery(`update liame.app_user set totp_last_step = null where id = $1`, [e.userId]);
    await ownerQuery(`delete from liame.rate_limit where key = $1`, [`segundo-fator:${e.userId}`]);
    return totpCode(e.secret, currentStep());
  }
  const responder = (e: EmpresaComCanais, conversa: string, text = RESPOSTA) =>
    api.call('POST', `/v1/direct/conversations/${conversa}/reply`, { cookie: e.cookie, body: { brand_id: e.brandId, text } });
  const abrir = (e: EmpresaComCanais, body: Record<string, unknown>) => api.call('POST', '/v1/direct/attendance', { cookie: e.cookie, body });
  const ciclo = (e: EmpresaComCanais) => executor.runCycle(20, { tenantIds: [e.tenantId] });
  const vencer = (id: string) => ownerQuery(`update liame.action_request set next_attempt_at = now() - interval '1 second' where id = $1`, [id]);
  const pedido = async (id: string) => (await ownerQuery<{ status: string; status_reason: string | null; tool: string; mode: string }>(`select status, status_reason, tool, mode from liame.action_request where id = $1`, [id]))[0]!;
  const daMarca = (conversa: string) => meta.conversasDoDirect.find((c) => c.id === conversa)!.mensagens.filter((m) => m.daMarca).map((m) => m.texto);
  const problema = (r: { status: number; body: unknown }) => [r.status, (r.body as { code?: string }).code];

  it('sem o atendimento aberto não sai; abrir pede o código; com ele aberto, sai direto pelo trilho e a conversa fica respondida; o pedido pela rota das ações é recusado', async () => {
    const { e, conversa } = await empresa('Casa Brasa Direct Responde');
    expect(problema(await responder(e, conversa))).toEqual([409, 'atendimento-fechado']);
    expect(problema(await abrir(e, {}))).toEqual([400, 'confirme-que-e-voce']);
    const aberto = await abrir(e, { code: await codigo(e) });
    expect(aberto.status, JSON.stringify(aberto.body)).toBe(200);
    const ate = Date.parse((aberto.body as { until: string }).until);
    expect(ate - Date.now()).toBeGreaterThan(7.9 * 3_600_000);
    expect(aberto.body).toMatchObject({ open: true, can_reply: true });

    const r = await responder(e, conversa);
    expect(r.status, JSON.stringify(r.body)).toBe(202);
    const id = (r.body as { action_id: string }).action_id;
    expect(await pedido(id)).toMatchObject({ tool: 'direct_responder', status: 'aprovada', mode: 'AUTO' });
    // Pela rota das ações, a mesma resposta é recusada: só a rota da conversa confere o atendimento aberto.
    const direto = await api.call('POST', '/v1/actions', {
      cookie: e.cookie,
      body: { tool: 'direct_responder', brand_id: e.brandId, provider: 'instagram', account_id: e.instagram!.id, resource_id: `direct:${conversa}`, params: { texto: RESPOSTA } },
    });
    expect(problema(direto)).toEqual([422, 'acao-so-pela-rota']);

    await ciclo(e);
    expect(await pedido(id)).toMatchObject({ status: 'executada' });
    expect(daMarca(conversa)).toEqual([RESPOSTA]);
    const envio = meta.chamadas.find((c) => c.metodo === 'POST' && c.caminho.endsWith('/messages'))!;
    expect(envio.corpo).toMatchObject({ recipient: { id: meta.conversasDoDirect.find((c) => c.id === conversa)!.pessoa.id }, message: { text: RESPOSTA }, messaging_type: 'RESPONSE' });
    // A conversa do Liame mostra a resposta sem esperar a leitura.
    const tela = await api.call('GET', `/v1/direct/conversations/${conversa}?brand_id=${e.brandId}`, { cookie: e.cookie });
    expect(tela.body).toMatchObject({ conversation: { status: 'respondida', unread: false } });
    expect((tela.body as { messages: { direction: string; text: string }[] }).messages.map((m) => [m.direction, m.text])).toEqual([
      ['entrada', 'Oi! Vocês entregam na Penha?'],
      ['saida', RESPOSTA],
    ]);
    expect(meta.defeitos).toEqual([]);

    // Fechar o atendimento volta a pedir o código.
    const fechado = await api.call('DELETE', '/v1/direct/attendance', { cookie: e.cookie });
    expect(fechado.body).toMatchObject({ open: false, until: null });
    expect(problema(await responder(e, conversa, 'Mais alguma coisa?'))).toEqual([409, 'atendimento-fechado']);
  }, 120_000);

  it('a resposta que saiu sem a volta da Meta não sai duas vezes; fora da janela, o plano recusa; com outro app dono da conversa, nada sai', async () => {
    const { e, conversa } = await empresa('Casa Brasa Direct Repete');
    expect((await abrir(e, { code: await codigo(e) })).status).toBe(200);
    meta.perderARespostaDaMensagem = true;
    const id = ((await responder(e, conversa)).body as { action_id: string }).action_id;
    await ciclo(e);
    expect(await pedido(id)).toMatchObject({ status: 'aprovada' });
    await vencer(id);
    await ciclo(e);
    expect(await pedido(id)).toMatchObject({ status: 'executada' });
    expect(daMarca(conversa)).toEqual([RESPOSTA]);

    // Outro app é dono da conversa (o Conversation Routing): nada sai, com a frase certa.
    const nova = meta.escreveuNoDirect(e.pagina!.externo, { usuario: 'ana.paula_rj', texto: 'E no domingo?' });
    expect(nova).toBe(conversa);
    meta.donoDasConversas = '999999999';
    const outro = ((await responder(e, conversa, 'Abrimos sim!')).body as { action_id: string }).action_id;
    await ciclo(e);
    expect(await pedido(outro)).toMatchObject({ status: 'falhou' });
    expect((await pedido(outro)).status_reason).toContain('outro app');
    expect(daMarca(conversa)).toEqual([RESPOSTA]);

    // Fora da janela de 24 horas: o plano recusa na hora do pedido.
    const { e: e2, conversa: velha } = await empresa('Casa Brasa Direct Janela', { minutos: 25 * 60 });
    expect((await abrir(e2, { code: await codigo(e2) })).status).toBe(200);
    expect(problema(await responder(e2, velha))).toEqual([422, 'plano-recusado']);
  }, 120_000);
});
