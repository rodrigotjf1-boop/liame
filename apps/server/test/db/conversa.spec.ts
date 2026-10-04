import { randomBytes, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { type ConversationMessage, ConversationResponse, type ConversationStreamEvent, ConversationStreamEvent as EventoDoFluxo } from '@liame/contracts';
import { type Database, runMigrations, uuidv7 } from '@liame/database';
import { MockLanguageModelV4 } from 'ai/test';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { TAREFA_CONVERSA } from '../../src/ai/conversa/prompt.js';
import { ModelosIa } from '../../src/ai/modelos.js';
import { naTransacaoDaEmpresa } from '../../src/ai/na-empresa.js';
import { afterCommit } from '../../src/context/request-context.js';
import { APP_CONFIG, type AppConfig } from '../../src/config.js';
import { DATABASE } from '../../src/database/database.module.js';
import { FlagService } from '../../src/flags/flag.service.js';
import { Mailer } from '../../src/mail/mailer.js';
import { diaNoFuso, menosDias } from '../../src/results/fora-do-normal.js';
import { VaultService } from '../../src/vault/vault.service.js';
import { LifecyclePurgeService } from '../../src/worker/lifecycle-purge.service.js';
import { enableMfa, ownerQuery, PASSWORD, resetIpRateLimits, signupAndLogin, startApi, TERMOS, type TestApi, tokenFrom, uniqueEmail } from '../helpers/api.js';
import { ligarIa, ModelosDeTeste, modeloComPreco, rotaAtiva, uso } from '../helpers/ia.js';
import { hasDb, OWNER_URL } from './env.js';

// Conversa com a LIA (A3, I10): pela rota, com o modelo simulado. A resposta só aparece depois da conferência;
// o que se decide por regra não chama a IA; a conversa é só de quem a abriu; a demanda é registrada em nome da
// pessoa, com auditoria; "Parar" impede a rodada seguinte; o conteúdo sai em 30 dias e a demanda fica.

describe.skipIf(!hasDb)('Conversa com a LIA: fluxo, conferência, regras, demanda, limites e isolamento (A3, I10)', () => {
  const RODADA = `teste_${randomBytes(4).toString('hex')}`;
  const PERIODO = { from: '2026-09-18', to: '2026-10-01' };
  let api: TestApi;
  let database: Database;
  let config: AppConfig;
  let flags: FlagService;
  let modelos: ModelosDeTeste;
  let alvo: { provider: string; model: string };

  /** Cada teste escolhe o roteiro do modelo da rota da tarefa. */
  const responder = (mock: MockLanguageModelV4) => {
    modelos.porChave.set(`${alvo.provider}/${alvo.model}`, mock);
    return mock;
  };
  const rodada = (content: Array<{ type: 'text'; text: string } | { type: 'tool-call'; toolCallId: string; toolName: string; input: string }>) => ({
    content,
    finishReason: { unified: content.some((c) => c.type === 'tool-call') ? ('tool-calls' as const) : ('stop' as const), raw: undefined },
    usage: uso(1000, 500),
    warnings: [],
  });
  const pede = (toolName: string, input: unknown, toolCallId = `chamada-${randomBytes(3).toString('hex')}`) => rodada([{ type: 'tool-call', toolCallId, toolName, input: JSON.stringify(input) }]);
  const responde = (...blocos: Array<[string, string, string?]>) =>
    rodada([{ type: 'text', text: JSON.stringify({ blocos: blocos.map(([tipo, texto, risco]) => ({ tipo, texto, risco: risco ?? null })), reuniao: null }) }]);
  /** Resposta com a reunião de decisão (I10b). */
  const respondeComReuniao = (bloco: string, reuniao: Record<string, unknown>) =>
    rodada([{ type: 'text', text: JSON.stringify({ blocos: [{ tipo: 'paragrafo', texto: bloco, risco: null }], reuniao }) }]);
  const roteiro = (...passos: Array<ReturnType<typeof rodada>>) => new MockLanguageModelV4({ doGenerate: passos });

  type Dono = { cookie: string; tenantId: string; userId: string; brandId: string };

  /** Empresa com a conta da Meta lida há pouco e R$ 200,00 de gasto em 20/09/2026, com a IA ligada. */
  async function dono(opcoes: { ia?: boolean; lidaHaHoras?: number; nome?: string } = {}): Promise<Dono> {
    const s = await signupAndLogin(api, undefined, opcoes.nome ?? 'Hamburgueria da Conversa');
    await enableMfa(api, s.cookie);
    const tenantId = s.me.active_organization_id as string;
    const brandId = (await api.call('GET', '/v1/brands', { cookie: s.cookie })).body.items[0].id as string;
    const [conta, campanha, grupo, anuncio] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
    await ownerQuery(
      `insert into liame.connected_account (id, tenant_id, brand_id, provider, external_id, name, currency, timezone) values ($1, $2, $3, 'meta_ads', 'act_' || $4, 'Conta da Hamburgueria', 'BRL', 'America/Sao_Paulo')`,
      [conta, tenantId, brandId, Math.floor(Math.random() * 1e9).toString()],
    );
    await ownerQuery(
      `insert into liame.sync_state (connected_account_id, dataset, tenant_id, expected_every_minutes, last_success_at) values ($1, 'metricas', $2, 1440, now() - make_interval(hours => $3))`,
      [conta, tenantId, opcoes.lidaHaHoras ?? 1],
    );
    await ownerQuery(`insert into liame.campaign (id, tenant_id, connected_account_id, provider, external_id, name, status) values ($1, $2, $3, 'meta_ads', 'c1', 'Combo sexta', 'ativa')`, [campanha, tenantId, conta]);
    await ownerQuery(`insert into liame.ad_group (id, tenant_id, connected_account_id, campaign_id, provider, external_id, name, status) values ($1, $2, $3, $4, 'meta_ads', 'g1', 'Bairros', 'ativa')`, [grupo, tenantId, conta, campanha]);
    await ownerQuery(`insert into liame.ad (id, tenant_id, connected_account_id, ad_group_id, provider, external_id, name, status) values ($1, $2, $3, $4, 'meta_ads', 'a1', 'Combo', 'ativa')`, [anuncio, tenantId, conta, grupo]);
    await ownerQuery(
      `insert into liame.metric_latest (connected_account_id, level, external_entity_id, metric_date, metric_name, attribution_window, tenant_id, brand_id, provider, entity_id, metric_value, currency, observed_at, changed_at)
       values ($1, 'ad', 'a1', '2026-09-20', 'spend', '', $2, $3, 'meta_ads', $4, 200, 'BRL', now(), now())`,
      [conta, tenantId, brandId, anuncio],
    );
    if (opcoes.ia !== false) await ligarIa(flags, tenantId);
    return { cookie: s.cookie, tenantId, userId: s.me.user.id as string, brandId };
  }

  /** Outra pessoa na mesma empresa, com o nível dado (como em `roles.spec`). */
  async function membro(d: Dono, role: string): Promise<{ cookie: string }> {
    const email = uniqueEmail(role);
    const body: Record<string, unknown> = { email, role };
    if (['administrador', 'gestor', 'aprovador'].includes(role)) body.approve_limit_micros = 1_000_000;
    expect((await api.call('POST', '/v1/invitations', { cookie: d.cookie, body })).status).toBe(201);
    const s = await api.call('POST', '/v1/invitations/signup', { body: { token: tokenFrom(api.mailer, email), name: `Pessoa ${role}`, password: PASSWORD, terms_version: TERMOS } });
    if (!s.cookie) throw new Error(`convite não aceito: ${s.status} ${JSON.stringify(s.body)}`);
    await enableMfa(api, s.cookie);
    return { cookie: s.cookie };
  }

  /** Manda a mensagem e lê o fluxo inteiro (ou até `parar` dizer que basta, e então fecha a leitura). */
  async function conversar(
    cookie: string,
    body: Record<string, unknown>,
    opcoes: { parar?: (e: ConversationStreamEvent) => boolean } = {},
  ): Promise<{ status: number; eventos: ConversationStreamEvent[]; problema: any; tipo: string | null }> {
    const ctrl = new AbortController();
    const res = await fetch(`${api.base}/v1/conversations/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ message_id: uuidv7(), ...body }),
      signal: ctrl.signal,
    });
    const tipo = res.headers.get('content-type');
    if (res.status !== 200) return { status: res.status, eventos: [], problema: await res.json(), tipo };
    const eventos: ConversationStreamEvent[] = [];
    const leitor = res.body!.getReader();
    const dec = new TextDecoder();
    let resto = '';
    try {
      for (;;) {
        const { value, done } = await leitor.read();
        if (done) break;
        resto += dec.decode(value, { stream: true });
        for (let i = resto.indexOf('\n\n'); i >= 0; i = resto.indexOf('\n\n')) {
          const bloco = resto.slice(0, i);
          resto = resto.slice(i + 2);
          const linhas = bloco.split('\n');
          const data = linhas.filter((l) => l.startsWith('data: ')).map((l) => l.slice(6)).join('\n');
          if (!data) continue;
          const e = EventoDoFluxo.parse(JSON.parse(data));
          // A linha `event:` repete o tipo, para quem lê o fluxo pelo nome do evento.
          expect(linhas[0]).toBe(`event: ${e.type}`);
          eventos.push(e);
          if (opcoes.parar?.(e)) {
            ctrl.abort();
            return { status: 200, eventos, problema: null, tipo };
          }
        }
      }
    } catch (err) {
      if (!ctrl.signal.aborted) throw err;
    }
    return { status: 200, eventos, problema: null, tipo };
  }
  const mensagemFinal = (eventos: ConversationStreamEvent[]): ConversationMessage => {
    const m = eventos.find((e) => e.type === 'mensagem')?.message;
    if (!m) throw new Error(`o fluxo não trouxe a mensagem: ${JSON.stringify(eventos.map((e) => e.type))}`);
    return m;
  };
  const usosDaConversa = (tenantId: string) =>
    ownerQuery<{ workflow: string; task: string; prompt_version: string; outcome: string }>(
      `select workflow, task, prompt_version, outcome from liame.ai_usage where tenant_id = $1 and task = $2 order by occurred_at, id`,
      [tenantId, TAREFA_CONVERSA],
    );
  /** O que o modelo recebeu na chamada `n`, em texto (instruções, mensagens e resultados das ferramentas). */
  const enviado = (mock: MockLanguageModelV4, n: number) => JSON.stringify(mock.doGenerateCalls[n]!.prompt);

  beforeAll(async () => {
    await runMigrations({ connectionString: OWNER_URL, dir: resolve(process.cwd(), '../../packages/database/migrations') });
    api = await startApi();
    database = api.app.get(DATABASE);
    config = api.app.get(APP_CONFIG);
    flags = api.app.get(FlagService);
    modelos = new ModelosDeTeste(config);
    // A rota usa o gateway da aplicação: os modelos dele passam a ser os simulados deste arquivo.
    api.app.get(ModelosIa).modelo = (provider, model) => modelos.modelo(provider, model);
    // A rota é da tarefa de verdade (uma ativa por tarefa): este arquivo é o único que a usa, e a apaga no fim.
    await ownerQuery(`delete from liame.ai_model_route where task = $1 and created_by = 'testes'`, [TAREFA_CONVERSA]);
    alvo = await modeloComPreco(modelos, RODADA, roteiro(responde(['paragrafo', 'Oi.'])));
    await rotaAtiva(TAREFA_CONVERSA, alvo, { maxCost: 1_000_000 });
  });
  beforeEach(resetIpRateLimits);
  afterAll(async () => {
    await ownerQuery(`delete from liame.ai_model_route where task = $1 and created_by = 'testes'`, [TAREFA_CONVERSA]);
    await ownerQuery(`delete from liame.ai_model_price where model like $1`, [`${RODADA}%`]);
    await api?.close();
  });

  it('A3-5: a LIA lê pelos serviços das telas, o fluxo mostra o passo, e a resposta chega conferida, com a fonte de cada número', async () => {
    const d = await dono();
    const mock = responder(
      roteiro(
        pede('resultados_ciclo_fechado', { brand_id: d.brandId, ...PERIODO }, 'leitura-1'),
        responde(['paragrafo', 'De 18/09/2026 a 01/10/2026, o investimento na Meta foi de R$ 200,00.'], ['risco', 'o caixa ainda não confirmou pedido de campanha.', 'medio'], ['fazer', 'Confira o link com rastreio no anúncio.']),
      ),
    );
    const r = await conversar(d.cookie, { brand_id: d.brandId, text: 'Como foi a semana?' });
    expect(r.status).toBe(200);
    expect(r.tipo).toContain('text/event-stream');
    expect(r.eventos.map((e) => [e.type, e.step?.status ?? null])).toEqual([
      ['inicio', null],
      ['passo', 'lendo'],
      ['passo', 'ok'],
      ['mensagem', null],
      ['fim', null],
    ]);
    const [inicio, lendo] = r.eventos;
    expect(inicio!.message).toMatchObject({ role: 'pessoa', text: 'Como foi a semana?', removed_personal_data: 0 });
    expect(inicio!.conversation).toMatchObject({ brand_id: d.brandId, title: 'Como foi a semana?', lia_answers: 0, max_lia_answers: config.ai.conversationMaxAnswers });
    expect(lendo!.step).toEqual({ id: 'leitura-1', label: 'Lendo os resultados de 18/09 a 01/10', status: 'lendo' });

    const m = mensagemFinal(r.eventos);
    expect(m).toMatchObject({ role: 'lia', status: 'ok', read: ['Resultados de 18/09 a 01/10'], cards: [], economy: false, notice: null });
    expect(m.blocks.map((b) => [b.kind, b.risk])).toEqual([['paragrafo', null], ['risco', 'medio'], ['fazer', null]]);
    expect(m.numbers.find((n) => n.value === 'R$ 200,00')!.sources[0]).toMatch(/^Resultados de 18\/09 a 01\/10 · totais · investimento/);
    expect(m.numbers.map((n) => n.value)).toEqual(['18/09/2026', '01/10/2026', 'R$ 200,00']);
    expect(r.eventos.at(-1)!.conversation).toMatchObject({ lia_answers: 1 });

    // O modelo recebeu o prompt registrado, o contexto do pedido e só as ferramentas da pessoa (o dono tem todas).
    expect(mock.doGenerateCalls).toHaveLength(2);
    expect(mock.doGenerateCalls[0]!.tools?.map((t) => t.name)).toEqual(['fontes_frescor', 'atencao_avisos', 'resultados_ciclo_fechado', 'midia_entrega', 'cupons_campanha', 'links_rastreio', 'abrir_demanda', 'propor_cupom']);
    expect(enviado(mock, 0)).toContain('Você é a LIA, a assistente de inteligência artificial da Liame');
    expect(enviado(mock, 0)).toContain(`brand_id ${d.brandId}`);
    expect(enviado(mock, 1)).toContain('R$ 200,00');
    expect(await usosDaConversa(d.tenantId)).toEqual([
      { workflow: 'conversa.lia', task: 'conversa_lia', prompt_version: 'conversa.lia@2', outcome: 'ok' },
      { workflow: 'conversa.lia', task: 'conversa_lia', prompt_version: 'conversa.lia@2', outcome: 'ok' },
    ]);
    // O retorno da pessoa ("Fez sentido") vale para a resposta da conversa, como para o Explicar.
    const retorno = await api.call('POST', '/v1/ai/feedback', { cookie: d.cookie, body: { usage_id: m.usage_id, verdict: 'fez_sentido' } });
    expect(retorno.status).toBe(200);

    // A lista e a conversa guardada, como a tela as abre depois.
    const conversaId = inicio!.conversation!.id;
    const lista = await api.call('GET', `/v1/conversations?brand_id=${d.brandId}`, { cookie: d.cookie });
    expect(lista.status).toBe(200);
    expect(lista.body).toMatchObject({ lia: true, retention_days: 30, contact: { email: 'suporte@agencialiame.com' } });
    expect(lista.body.items.map((c: { id: string }) => c.id)).toEqual([conversaId]);
    const aberta = await api.call('GET', `/v1/conversations/${conversaId}`, { cookie: d.cookie });
    expect(ConversationResponse.parse(aberta.body).messages.map((x) => x.role)).toEqual(['pessoa', 'lia']);
    expect(aberta.body.messages[1]).toEqual(m);

    // A pergunta seguinte leva o histórico: a pergunta e a resposta anteriores voltam ao modelo.
    const segundo = responder(roteiro(responde(['paragrafo', 'Os R$ 200,00 foram todos na Combo sexta.'])));
    const r2 = await conversar(d.cookie, { brand_id: d.brandId, conversation_id: conversaId, text: 'E onde foi esse gasto?' });
    expect(mensagemFinal(r2.eventos)).toMatchObject({ role: 'lia', status: 'ok' });
    expect(enviado(segundo, 0)).toContain('Como foi a semana?');
    expect(enviado(segundo, 0)).toContain('o investimento na Meta foi de R$ 200,00');
  });

  it('A3-5: número fora do que ela leu derruba a resposta (aviso `recusada`); dado velho vira `dado_velho`, com a fonte', async () => {
    const d = await dono();
    responder(roteiro(pede('resultados_ciclo_fechado', { brand_id: d.brandId, ...PERIODO }), responde(['paragrafo', 'O investimento foi de R$ 250,00.'])));
    const r = await conversar(d.cookie, { brand_id: d.brandId, text: 'Quanto investi?' });
    expect(mensagemFinal(r.eventos)).toMatchObject({ role: 'sistema', notice: 'recusada', blocks: [], numbers: [], usage_id: null });
    // A resposta recusada não conta no limite da conversa; o custo dela está registrado.
    expect(r.eventos.at(-1)!.conversation).toMatchObject({ lia_answers: 0 });
    expect(await usosDaConversa(d.tenantId)).toHaveLength(2);
    // D-A3-15: a recusa fica contada para Sua equipe (a LIA, pelos números), sem o texto.
    expect(
      await ownerQuery<{ member: string; workflow: string; kind: string; rules: string[]; items: number }>(
      `select member, workflow, kind, rules, items from liame.ai_refusal where tenant_id = $1 order by kind`,
      [d.tenantId],
    ),
    ).toEqual([{ member: 'lia', workflow: 'conversa.lia', kind: 'numero_fora', rules: [], items: 1 }]);

    const velho = await dono({ lidaHaHoras: 96 });
    responder(roteiro(pede('resultados_ciclo_fechado', { brand_id: velho.brandId, ...PERIODO }), responde(['paragrafo', 'O investimento foi de R$ 200,00.'])));
    const v = mensagemFinal((await conversar(velho.cookie, { brand_id: velho.brandId, text: 'Quanto investi?' })).eventos);
    expect(v).toMatchObject({ role: 'sistema', notice: 'dado_velho' });
    expect(v.stale_sources).toEqual([expect.objectContaining({ platform: 'Meta', name: 'Conta da Hamburgueria' })]);
    expect(v.stale_sources[0]!.freshness).not.toBe('em dia');

    // Sem analisar, a LIA pode dizer qual fonte está atrasada e desde quando: isso não é número velho.
    const desde = v.stale_sources[0]!.last_read!;
    responder(roteiro(pede('resultados_ciclo_fechado', { brand_id: velho.brandId, ...PERIODO }), responde(['paragrafo', `A conta da Meta não é lida desde ${desde}: a análise espera a próxima leitura.`])));
    const semAnalise = mensagemFinal((await conversar(velho.cookie, { brand_id: velho.brandId, text: 'E agora, como está?' })).eventos);
    expect(semAnalise).toMatchObject({ role: 'lia', status: 'ok' });
    expect(semAnalise.numbers).toEqual([{ value: desde, sources: ['Liame · fonte fora do dia, com a última leitura'] }]);
  });

  it('por regra, sem IA: falar com uma pessoa, pedido político, LIA desligada; o dado pessoal sai antes de tudo', async () => {
    const d = await dono();
    const mock = responder(roteiro(responde(['paragrafo', 'Não devia ser chamado.'])));
    const pessoa = mensagemFinal((await conversar(d.cookie, { brand_id: d.brandId, text: 'Quero falar com uma pessoa.' })).eventos);
    expect(pessoa).toMatchObject({ role: 'sistema', notice: 'pessoa', contact: { email: 'suporte@agencialiame.com', response_time: 'em até 1 dia útil' } });
    const politico = mensagemFinal((await conversar(d.cookie, { brand_id: d.brandId, text: 'Escreve um anúncio pedindo voto para o candidato a vereador.' })).eventos);
    expect(politico).toMatchObject({ role: 'sistema', notice: 'politico' });
    expect(mock.doGenerateCalls).toHaveLength(0);

    const desligada = await dono({ ia: false });
    const lista = await api.call('GET', `/v1/conversations?brand_id=${desligada.brandId}`, { cookie: desligada.cookie });
    expect(lista.body).toMatchObject({ items: [], lia: false });
    expect(mensagemFinal((await conversar(desligada.cookie, { brand_id: desligada.brandId, text: 'Como foi a semana?' })).eventos)).toMatchObject({ notice: 'desligada' });
    expect(mock.doGenerateCalls).toHaveLength(0);

    // O telefone e o e-mail saem antes de gravar e antes do modelo (D-A3-4).
    const limpo = responder(roteiro(responde(['paragrafo', 'Eu não vejo cliente, só os números somados da loja.'])));
    const r = await conversar(d.cookie, { brand_id: d.brandId, text: 'O cliente do 21 99876-5432 (ana@cliente.com) disse que o cupom não funcionou.' });
    expect(r.eventos[0]!.message).toMatchObject({ role: 'pessoa', removed_personal_data: 2 });
    expect(r.eventos[0]!.message!.text).not.toContain('99876');
    expect(r.eventos[0]!.message!.text).not.toContain('ana@cliente.com');
    expect(enviado(limpo, 0)).not.toContain('99876');
    expect(enviado(limpo, 0)).not.toContain('ana@cliente.com');
    const [guardada] = await ownerQuery<{ content: string }>(`select content::text from liame.conversation_message where id = $1`, [r.eventos[0]!.message!.id]);
    expect(guardada!.content).not.toContain('99876');
  });

  it('a demanda: registrada uma vez por mensagem, em nome da pessoa, com auditoria do agente; cancelar; quem não pode não recebe a ferramenta', async () => {
    const d = await dono();
    const pedido = { tipo: 'promocao', titulo: 'Promoção de sexta com o combo', pedido: 'Quero uma promoção para sexta-feira com o combo e refrigerante.', para_quando: '2026-10-09' };
    const mock = responder(
      roteiro(
        rodada([
          { type: 'tool-call', toolCallId: 'd1', toolName: 'abrir_demanda', input: JSON.stringify(pedido) },
          { type: 'tool-call', toolCallId: 'd2', toolName: 'abrir_demanda', input: JSON.stringify(pedido) },
        ]),
        responde(['paragrafo', 'Registrei o seu pedido como demanda, para sexta-feira, 09/10/2026. O Estrategista devolve um plano em Aprovações.']),
      ),
    );
    const r = await conversar(d.cookie, { brand_id: d.brandId, text: 'Quero uma promoção para sexta-feira com o combo e refrigerante. Pode montar?' });
    expect(r.eventos.filter((e) => e.type === 'passo').map((e) => e.step!.label)).toContain('Registrando a demanda');
    const m = mensagemFinal(r.eventos);
    expect(m).toMatchObject({ role: 'lia', status: 'ok', read: [] });
    expect(m.cards).toHaveLength(1);
    const demanda = m.cards[0]!.demand!;
    expect(demanda).toMatchObject({ kind: 'promocao', title: 'Promoção de sexta com o combo', status: 'aberta', due_on: '2026-10-09', opened_by_agent: 'lia', assignee: { agent: 'estrategista', name: 'Estrategista' } });
    expect(demanda.requested_by?.id).toBe(d.userId);
    expect(r.eventos.at(-1)!.conversation).toMatchObject({ has_demand: true });
    // O modelo pediu duas vezes na mesma mensagem: uma demanda só (índice único).
    expect(await ownerQuery(`select id from liame.demand where tenant_id = $1`, [d.tenantId])).toHaveLength(1);
    expect(enviado(mock, 1)).toContain('Esta demanda já estava registrada para esta mensagem.');
    const [evento] = await ownerQuery<{ actor_type: string; actor_id: string | null; actor_label: string; agent: string; after: Record<string, unknown> }>(
      `select actor_type, actor_id, actor_label, agent, after from liame.audit_event where tenant_id = $1 and action = 'demanda.abrir'`,
      [d.tenantId],
    );
    expect(evento).toMatchObject({ actor_type: 'agent', actor_id: null, agent: 'lia', after: { kind: 'promocao', requested_by: d.userId } });
    expect(evento!.actor_label).toMatch(/^LIA, a pedido de /);

    const cancelar = await api.call('POST', `/v1/demands/${demanda.id}/cancel`, { cookie: d.cookie, body: {} });
    expect(cancelar.status).toBe(200);
    expect(cancelar.body).toMatchObject({ status: 'cancelada' });
    expect((await api.call('POST', `/v1/demands/${demanda.id}/cancel`, { cookie: d.cookie, body: {} })).body.code).toBe('demanda-nao-aberta');
    // Ao reabrir a conversa, o cartão mostra a situação de agora, não a da hora da resposta.
    const reaberta = await api.call('GET', `/v1/conversations/${r.eventos[0]!.conversation!.id}`, { cookie: d.cookie });
    expect(reaberta.body.messages[1].cards[0].demand).toMatchObject({ id: demanda.id, status: 'cancelada' });
    expect(reaberta.body.messages[1].cards[0].demand.cancelled_at).not.toBeNull();

    // Somente leitura conversa, mas não registra demanda nem propõe cupom: as ferramentas nem são oferecidas.
    const leitor = await membro(d, 'somente_leitura');
    const outro = responder(roteiro(responde(['paragrafo', 'Quem pode fazer esse pedido é o dono, o administrador ou o gestor.'])));
    await conversar(leitor.cookie, { brand_id: d.brandId, text: 'Monta uma promoção?' });
    expect(outro.doGenerateCalls[0]!.tools?.map((t) => t.name)).not.toContain('abrir_demanda');
    expect(outro.doGenerateCalls[0]!.tools?.map((t) => t.name)).not.toContain('propor_cupom');
    expect((await api.call('POST', `/v1/demands/${demanda.id}/cancel`, { cookie: leitor.cookie, body: {} })).status).toBe(403);
  });

  /** Loja com o Regem conectado (e "criar cupom de campanha" liberado), com a escrita no Regem ligada para a empresa (I10b). */
  async function comLojaQueCriaCupom(d: Dono, opcoes: { escrita?: boolean } = {}) {
    const unidade = randomUUID();
    await ownerQuery(`insert into liame.unit (id, tenant_id, brand_id, name) values ($1, $2, $3, 'Loja Centro')`, [unidade, d.tenantId, d.brandId]);
    await ownerQuery(
      `insert into liame.connected_account (id, tenant_id, brand_id, unit_id, provider, external_id, name, currency, timezone, provider_attributes)
       values (gen_random_uuid(), $1, $2, $3, 'regem', $4, 'Mister Burgers — Loja Centro', 'BRL', 'America/Sao_Paulo', '{"escopos":["pedidos.ler","cupons.ler","cupons.criar"]}'::jsonb)`,
      [d.tenantId, d.brandId, unidade, randomUUID()],
    );
    if (opcoes.escrita !== false) {
      await ownerQuery(
        `insert into liame.feature_flag_rule (id, flag_key, scope_type, scope_id, value, rollout_percent, created_by) values (gen_random_uuid(), 'regem_write', 'tenant', $1, 'true'::jsonb, null, 'testes')`,
        [d.tenantId],
      );
      flags.invalidate();
    }
  }

  it('I10b: a LIA propõe o cupom (o mesmo pedido da aba Cupons, em nome da pessoa, auditado como agente); a recusa da regra volta para ela', async () => {
    const d = await dono();
    await comLojaQueCriaCupom(d);
    const hoje = diaNoFuso(new Date(), 'America/Sao_Paulo');
    const proposta = { loja: 'loja centro', campanha: 'Combo Sexta', codigo: 'SEXTA10', tipo: 'percentual', percentual: 10, valido_de: hoje, valido_ate: menosDias(hoje, -7), exclusivo: true };
    const mock = responder(
      roteiro(
        pede('propor_cupom', { ...proposta, loja: 'Loja Norte' }, 'c1'),
        pede('propor_cupom', proposta, 'c2'),
        responde(['paragrafo', 'Montei a proposta do cupom SEXTA10 e mandei para Aprovações: o cupom só nasce no Regem quando uma pessoa com permissão aprovar.']),
      ),
    );
    const r = await conversar(d.cookie, { brand_id: d.brandId, text: 'Proponha um cupom exclusivo de 10% para a Combo sexta' });
    const m = mensagemFinal(r.eventos);
    expect(m).toMatchObject({ role: 'lia', status: 'ok' });
    expect(r.eventos.filter((e) => e.type === 'passo').map((e) => [e.step!.label, e.step!.status])).toEqual([
      ['Enviando a proposta para Aprovações', 'lendo'],
      ['Enviando a proposta para Aprovações', 'falhou'],
      ['Enviando a proposta para Aprovações', 'lendo'],
      ['Enviando a proposta para Aprovações', 'ok'],
    ]);
    // A primeira tentativa errou a loja: a LIA recebeu o motivo, com as lojas que existem.
    expect(enviado(mock, 1)).toContain('Não achei a loja');
    expect(enviado(mock, 1)).toContain('Loja Centro');
    expect(m.cards.map((k) => k.kind)).toEqual(['proposta_cupom']);
    const { request, store_name } = m.cards[0]!.coupon!;
    expect(store_name).toBe('Loja Centro');
    expect(request).toMatchObject({ code: 'SEXTA10', kind: 'percentual', percent: 10, status: 'aguardando_aprovacao', exclusive: true, campaign: { name: 'Combo sexta' }, requested_by: { id: d.userId } });
    // É o mesmo pedido da aba Cupons: aparece lá, esperando aprovação.
    const cupons = await api.call('GET', `/v1/coupons?brand_id=${d.brandId}`, { cookie: d.cookie });
    expect(cupons.body.requests.map((p: { action_id: string }) => p.action_id)).toEqual([request.action_id]);
    const [evento] = await ownerQuery<{ actor_type: string; agent: string; actor_label: string; resource_id: string; after: Record<string, unknown> }>(
      `select actor_type, agent, actor_label, resource_id, after from liame.audit_event where tenant_id = $1 and action = 'cupom.pedir_criacao'`,
      [d.tenantId],
    );
    expect(evento).toMatchObject({ actor_type: 'agent', agent: 'lia', resource_id: request.action_id, after: { requested_by: d.userId } });
    expect(evento!.actor_label).toMatch(/^LIA, a pedido de /);
    // Quem pediu desiste na aba Cupons: ao reabrir a conversa, o cartão mostra a proposta cancelada.
    expect((await api.call('POST', `/v1/coupons/regem/${request.action_id}/cancel`, { cookie: d.cookie })).status).toBe(204);
    const reaberta = await api.call('GET', `/v1/conversations/${r.eventos[0]!.conversation!.id}`, { cookie: d.cookie });
    expect(reaberta.body.messages[1].cards[0].coupon.request.status).toBe('cancelada');

    // Com a escrita no Regem desligada para a empresa, a proposta é recusada pela regra e a LIA recebe o motivo.
    const sem = await dono();
    await comLojaQueCriaCupom(sem, { escrita: false });
    const recusada = responder(roteiro(pede('propor_cupom', proposta), responde(['paragrafo', 'A criação de cupom pelo Liame não está liberada nesta empresa.'])));
    const r2 = mensagemFinal((await conversar(sem.cookie, { brand_id: sem.brandId, text: 'Proponha um cupom' })).eventos);
    expect(r2.cards).toEqual([]);
    expect(enviado(recusada, 1)).toContain('não está liberada');
    expect(await ownerQuery(`select id from liame.action_request where tenant_id = $1`, [sem.tenantId])).toEqual([]);
  });

  it('I10b: decisão grande vira a reunião de decisão (vozes, recomendação e risco, com os números conferidos)', async () => {
    const d = await dono();
    const reuniao = {
      pauta: 'Pausar a Combo sexta?',
      vozes: [
        { quem: 'analista', texto: 'De 18/09/2026 a 01/10/2026, a Combo sexta recebeu R$ 200,00 e o caixa ainda não confirmou pedido dela.' },
        { quem: 'estrategista', texto: 'Antes de pausar, vale conferir se o anúncio leva o link com rastreio.' },
        { quem: 'voz_contraria', texto: 'Sem o link com rastreio, o pedido pode ter vindo e ficado sem origem: a campanha pode estar melhor do que parece.' },
      ],
      recomendacao: 'Não pausar ainda: conferir o link do anúncio e olhar de novo na semana que vem.',
      risco: 'medio',
      risco_motivo: 'manter custa o que a campanha gasta; pausar sem conferir o link pode cortar uma campanha que vende.',
    };
    const leitura = () => pede('resultados_ciclo_fechado', { brand_id: d.brandId, ...PERIODO });
    responder(roteiro(leitura(), respondeComReuniao('Pausar campanha é decisão grande: levei a pergunta para a reunião de decisão.', reuniao)));
    const m = mensagemFinal((await conversar(d.cookie, { brand_id: d.brandId, text: 'Vale pausar a Combo sexta?' })).eventos);
    expect(m).toMatchObject({ role: 'lia', status: 'ok' });
    expect(m.cards.map((k) => k.kind)).toEqual(['reuniao']);
    const card = m.cards[0]!.meeting!;
    expect(card.voices.map((v) => [v.agent, v.name])).toEqual([['analista', 'Analista'], ['estrategista', 'Estrategista'], ['voz_contraria', 'Voz contrária']]);
    expect(card.risk).toBe('medio');
    expect(m.numbers.find((n) => n.value === 'R$ 200,00')!.sources[0]).toMatch(/^Resultados de 18\/09 a 01\/10 · campanha "Combo sexta"/);

    // A reunião também é conferida: número inventado numa voz derruba a resposta inteira.
    responder(roteiro(leitura(), respondeComReuniao('Levei a pergunta para a reunião.', { ...reuniao, recomendacao: 'Pausar economiza R$ 70,00 por semana.' })));
    expect(mensagemFinal((await conversar(d.cookie, { brand_id: d.brandId, text: 'E agora, pauso?' })).eventos)).toMatchObject({ role: 'sistema', notice: 'recusada' });
  });

  it('fora da rota, o que o serviço agenda para depois do commit roda depois do commit; desfeita a transação, não roda', async () => {
    const d = await dono({ ia: false });
    const rodou: string[] = [];
    await naTransacaoDaEmpresa(database, d, async () => {
      afterCommit(async () => {
        rodou.push('gravou');
      });
    });
    await expect(
      naTransacaoDaEmpresa(database, d, async () => {
        afterCommit(async () => {
          rodou.push('desfeita');
        });
        throw new Error('falhou');
      }),
    ).rejects.toThrow('falhou');
    // O efeito que falha só é registrado: não derruba quem chamou.
    await naTransacaoDaEmpresa(database, d, async () => {
      afterCommit(async () => {
        throw new Error('o e-mail caiu');
      });
    });
    expect(rodou).toEqual(['gravou']);
  });

  it('A3-9: conversa cheia, uma resposta por vez, mensagem repetida e o limite da pessoa', async () => {
    const d = await dono();
    responder(roteiro(responde(['paragrafo', 'Oi, eu sou a LIA.'])));
    const messageId = uuidv7();
    const primeira = await conversar(d.cookie, { brand_id: d.brandId, text: 'Oi', message_id: messageId });
    const conversaId = primeira.eventos[0]!.conversation!.id;
    // O mesmo envio de novo: nada grava, nada responde.
    const repetida = await conversar(d.cookie, { brand_id: d.brandId, conversation_id: conversaId, text: 'Oi', message_id: messageId });
    expect([repetida.status, repetida.problema.code]).toEqual([409, 'mensagem-repetida']);

    await ownerQuery(`update liame.conversation set busy_since = now() where id = $1`, [conversaId]);
    const ocupada = await conversar(d.cookie, { brand_id: d.brandId, conversation_id: conversaId, text: 'E agora?' });
    expect([ocupada.status, ocupada.problema.code]).toEqual([409, 'conversa-ocupada']);
    // A marca de uma resposta que caiu no meio vence sozinha.
    await ownerQuery(`update liame.conversation set busy_since = now() - interval '4 minutes' where id = $1`, [conversaId]);
    responder(roteiro(responde(['paragrafo', 'Sigo aqui.'])));
    expect((await conversar(d.cookie, { brand_id: d.brandId, conversation_id: conversaId, text: 'E agora?' })).status).toBe(200);

    await ownerQuery(`update liame.conversation set lia_answers = $2 where id = $1`, [conversaId, config.ai.conversationMaxAnswers]);
    const cheia = await conversar(d.cookie, { brand_id: d.brandId, conversation_id: conversaId, text: 'Mais uma?' });
    expect([cheia.status, cheia.problema.code]).toEqual([409, 'conversa-cheia']);

    // O limite de chamadas da pessoa (gateway): a conversa responde com o aviso e a hora em que a LIA volta.
    const p = await dono();
    for (let i = 0; i < config.ai.userHourlyCalls; i += 1) {
      await ownerQuery(
        `insert into liame.ai_usage (id, tenant_id, user_id, workflow, task, provider, model, served_by, cost_usd_micros, outcome) values (gen_random_uuid(), $1, $2, 'teste.semente', 'teste_semente', 'teste', 'semente', 'principal', 1, 'ok')`,
        [p.tenantId, p.userId],
      );
    }
    const limite = mensagemFinal((await conversar(p.cookie, { brand_id: p.brandId, text: 'Como foi a semana?' })).eventos);
    expect(limite).toMatchObject({ role: 'sistema', notice: 'limite_pessoa' });
    expect(Date.parse(limite.retry_at!)).toBeGreaterThan(Date.now());
  });

  it('V37: três mensagens ao mesmo tempo na mesma conversa: uma é respondida, as outras voltam 409 e não gravam nada', async () => {
    const d = await dono();
    responder(roteiro(responde(['paragrafo', 'Oi.'])));
    const conversaId = (await conversar(d.cookie, { brand_id: d.brandId, text: 'Oi' })).eventos[0]!.conversation!.id;
    let soltar: () => void = () => undefined;
    const segura = new Promise<void>((ok) => {
      soltar = ok;
    });
    responder(
      new MockLanguageModelV4({
        doGenerate: async () => {
          // A resposta só sai depois que as outras duas mensagens já foram recusadas.
          await segura;
          return responde(['paragrafo', 'Uma resposta só.']);
        },
      }),
    );
    const prontos: number[] = [];
    const garantia = setTimeout(soltar, 10_000);
    const envios = [1, 2, 3].map((i) =>
      conversar(d.cookie, { brand_id: d.brandId, conversation_id: conversaId, text: `Pergunta ${i}` }).then((r) => {
        prontos.push(r.status);
        if (prontos.filter((s) => s === 409).length === 2) soltar();
        return r;
      }),
    );
    const rs = await Promise.all(envios);
    clearTimeout(garantia);
    expect(rs.map((r) => r.status).sort()).toEqual([200, 409, 409]);
    expect(rs.filter((r) => r.status === 409).map((r) => r.problema.code)).toEqual(['conversa-ocupada', 'conversa-ocupada']);
    const msgs = await ownerQuery<{ role: string }>(`select role from liame.conversation_message where conversation_id = $1 order by created_at, id`, [conversaId]);
    expect(msgs.map((m) => m.role)).toEqual(['pessoa', 'lia', 'pessoa', 'lia']);
  });

  it('A3-4: a conversa é só de quem a abriu: outra pessoa da empresa e outra empresa não leem nem escrevem nela', async () => {
    const d = await dono();
    responder(roteiro(responde(['paragrafo', 'Oi.'])));
    const r = await conversar(d.cookie, { brand_id: d.brandId, text: 'Uma pergunta minha' });
    const conversaId = r.eventos[0]!.conversation!.id;

    const colega = await membro(d, 'administrador');
    expect((await api.call('GET', `/v1/conversations/${conversaId}`, { cookie: colega.cookie })).status).toBe(404);
    expect((await api.call('GET', `/v1/conversations?brand_id=${d.brandId}`, { cookie: colega.cookie })).body.items).toEqual([]);
    const escreve = await conversar(colega.cookie, { brand_id: d.brandId, conversation_id: conversaId, text: 'Entrando na conversa dela' });
    expect(escreve.status).toBe(404);

    const fora = await dono({ nome: 'Outra Empresa' });
    expect((await api.call('GET', `/v1/conversations/${conversaId}`, { cookie: fora.cookie })).status).toBe(404);
    // A marca de outra empresa não existe para quem pergunta.
    expect((await conversar(fora.cookie, { brand_id: d.brandId, text: 'Oi' })).status).toBe(404);
    // Somente pelo dono da conversa: no banco, a mensagem de outra pessoa nem aparece para a aplicação.
    expect(await ownerQuery(`select count(*)::int as n from liame.conversation_message where conversation_id = $1`, [conversaId])).toEqual([{ n: 2 }]);
  });

  it('Parar: nenhuma leitura nova roda depois, a resposta fica interrompida e a conversa é liberada', async () => {
    const d = await dono();
    let soltar: () => void = () => undefined;
    const segura = new Promise<void>((ok) => {
      soltar = ok;
    });
    let chamadas = 0;
    const mock = responder(
      new MockLanguageModelV4({
        doGenerate: async () => {
          chamadas += 1;
          if (chamadas === 1) return pede('fontes_frescor', { brand_id: d.brandId }, 'p1');
          // A segunda rodada só volta depois que a pessoa parou: e ela pede outra leitura, que não pode rodar.
          await segura;
          return pede('atencao_avisos', { brand_id: d.brandId }, 'p2');
        },
      }),
    );
    const r = await conversar(d.cookie, { brand_id: d.brandId, text: 'Como foi a semana?' }, { parar: (e) => e.type === 'passo' && e.step?.status === 'ok' });
    expect(r.eventos.map((e) => e.type)).toEqual(['inicio', 'passo', 'passo']);
    setTimeout(soltar, 150);
    const conversaId = r.eventos[0]!.conversation!.id;
    let lia: Array<{ status: string; content: { read: string[] } }> = [];
    for (let i = 0; i < 50 && !lia.length; i += 1) {
      await new Promise((ok) => setTimeout(ok, 100));
      lia = await ownerQuery(`select status, content from liame.conversation_message where conversation_id = $1 and role = 'lia'`, [conversaId]);
    }
    expect(lia).toEqual([{ status: 'parada', content: expect.objectContaining({ read: ['Frescor das fontes'], blocks: [] }) }]);
    expect(chamadas).toBeLessThanOrEqual(2);
    expect(mock.doGenerateCalls.length).toBeLessThanOrEqual(2);
    const [c] = await ownerQuery<{ busy_since: string | null; lia_answers: number }>(`select busy_since, lia_answers from liame.conversation where id = $1`, [conversaId]);
    expect(c).toEqual({ busy_since: null, lia_answers: 0 });
  });

  it('D-A3-4: conversa e mensagens saem em 30 dias; a demanda fica, sem a referência', async () => {
    const d = await dono();
    responder(roteiro(pede('abrir_demanda', { tipo: 'pauta', titulo: 'Pauta da semana', pedido: 'Monte a pauta da semana.' }), responde(['paragrafo', 'Registrei a demanda.'])));
    const velha = await conversar(d.cookie, { brand_id: d.brandId, text: 'Monte a pauta da semana.' });
    const velhaId = velha.eventos[0]!.conversation!.id;
    responder(roteiro(responde(['paragrafo', 'Oi.'])));
    const atual = await conversar(d.cookie, { brand_id: d.brandId, text: 'Oi' });
    const atualId = atual.eventos[0]!.conversation!.id;
    await ownerQuery(`update liame.conversation set last_message_at = now() - interval '31 days' where id = $1`, [velhaId]);
    // Na conversa que segue, a mensagem antiga sai e a nova fica.
    await ownerQuery(`update liame.conversation_message set created_at = now() - interval '31 days' where id = $1`, [atual.eventos[0]!.message!.id]);

    const purge = new LifecyclePurgeService(database, api.app.get(VaultService), api.app.get(Mailer));
    expect(await purge.purgeRetention({ tenantIds: [d.tenantId], userIds: [d.userId] })).toMatchObject({ conversa: 1, conversa_mensagem: 1 });
    expect(await ownerQuery(`select id from liame.conversation where tenant_id = $1 order by id`, [d.tenantId])).toEqual([{ id: atualId }]);
    expect(await ownerQuery(`select role from liame.conversation_message where conversation_id = $1`, [atualId])).toEqual([{ role: 'lia' }]);
    expect(await ownerQuery(`select title, conversation_id, origin_message_id from liame.demand where tenant_id = $1`, [d.tenantId])).toEqual([
      { title: 'Pauta da semana', conversation_id: null, origin_message_id: null },
    ]);
    expect((await api.call('GET', `/v1/conversations/${velhaId}`, { cookie: d.cookie })).status).toBe(404);
  });
});
