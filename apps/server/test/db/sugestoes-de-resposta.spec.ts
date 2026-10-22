import { createDatabase, type Database } from '@liame/database';
import { MockLanguageModelV4 } from 'ai/test';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ActionService } from '../../src/actions/action.service.js';
import { BudgetService } from '../../src/actions/budget.service.js';
import { AiGateway } from '../../src/ai/gateway.js';
import { ModelosIa } from '../../src/ai/modelos.js';
import { currentStep, totpCode } from '../../src/auth/totp.js';
import { loadConfig } from '../../src/config.js';
import { DATABASE } from '../../src/database/database.module.js';
import { FlagService } from '../../src/flags/flag.service.js';
import { KillSwitchService } from '../../src/kill-switch/kill-switch.service.js';
import { ResultsService } from '../../src/results/results.service.js';
import { VaultService } from '../../src/vault/vault.service.js';
import { ActionExecutor } from '../../src/worker/action-executor.js';
import { ConexaoProcessor } from '../../src/worker/conexao-processor.js';
import { PerfilLoop } from '../../src/worker/perfil-loop.js';
import { SugestoesDeRespostaLoop } from '../../src/worker/sugestoes-de-resposta-loop.js';
import { SugestoesDeRespostaService } from '../../src/worker/sugestoes-de-resposta.service.js';
import { enableMfa, ownerQuery, PASSWORD, resetIpRateLimits, startApi, TERMOS, type TestApi, tokenFrom, uniqueEmail } from '../helpers/api.js';
import * as ia from '../helpers/ia.js';
import { type AvaliacaoNoGoogle, type EmpresaComLoja, empresaComLojaDoPerfil, GoogleComPerfil, nomeDeQuemAvaliou } from '../helpers/perfil-google-de-mentira.js';
import { APP_URL, hasDb } from './env.js';

// A6 · Z6, parte 2: as sugestões de resposta do Social media, da leitura do Google que traz a avaliação ao pedido em
// Aprovações, contra um Google local e com o modelo de IA simulado (nenhum fornecedor é chamado). A loja nasce pelo
// caminho do produto, e as avaliações entram no Liame pela leitura. O que se prova aqui:
//   - D-A6-26: a leitura abre a vez de cada avaliação nova sem resposta dos últimos 30 dias, uma vez só; duas
//     sugestões, e uma quando a avaliação é só a nota;
//   - D-A6-27: as que passam vão num pedido só, em nome do dono; nada sai sem a aprovação com o código do app, a de 1
//     ou 2 estrelas só com a do dono; o que vai ao Google é só o texto escolhido;
//   - D-A6-28: a conferência barra a sugestão que promete compensação, e o texto barrado não fica guardado;
//   - D-A6-29: o Social media não recebe o nome de quem avaliou;
//   - D-A6-30: sem uma das chaves, nada entra na fila, e a vez que já entrou espera, sem contar tentativa;
//   - a fila: cada vez é tratada uma vez (V35), toda vez deixa rastro (V106), e as regras da tabela valem (V119).

const DIA_MS = 86_400_000;
const MIN_MS = 60_000;
const BOAS = [
  { enfoque: 'Curta', texto: 'Que bom ler isso! Obrigado pela visita e pelo carinho com o nosso smash.' },
  { enfoque: 'Mais calorosa', texto: 'Ficamos muito felizes com a sua visita! Obrigado por contar aqui como foi, e esperamos você de novo.' },
];
const SO_A_NOTA = [{ enfoque: 'Agradece a nota', texto: 'Obrigado pela avaliação! Esperamos você de novo em breve.' }];
const DESCULPAS = [
  { enfoque: 'Pede desculpas', texto: 'Pedimos desculpas pela demora: não é o que queremos entregar. Fale com a gente pelos contatos do perfil para entendermos o que houve.' },
  { enfoque: 'Mais curta', texto: 'Sentimos muito pela experiência. Fale com a gente pelos contatos do perfil para entendermos o que houve.' },
];
const COM_CUPOM = [
  { enfoque: 'Com cupom', texto: 'Pedimos desculpas! Na próxima visita, use um cupom de desconto por nossa conta.' },
  { enfoque: 'Com sobremesa', texto: 'Sentimos muito. Da próxima vez, a sobremesa é de graça para você.' },
];
const ELOGIO = 'Melhor smash da região! O combo família veio caprichado e a entrega foi rápida.';
const RECLAMACAO = 'O lanche chegou frio e demorou demais.';

type Linha = {
  id: string;
  review_id: string;
  round: number;
  status: string;
  reason: string | null;
  barred_by: string[] | null;
  suggestions: number | null;
  action_id: string | null;
  usage_id: string | null;
  attempts: number;
  next_attempt_at: Date | null;
  finished_at: Date | null;
};
type Pedido = {
  id: string;
  tool: string;
  action: string;
  mode: string;
  status: string;
  status_reason: string | null;
  resource_id: string;
  params: { texto: string; sugestoes?: Array<{ enfoque: string; texto: string; rodada: number }> };
  actor_type: string;
  agent_key: string | null;
  requested_by: string;
  plan_hash: string;
};

describe.skipIf(!hasDb)('as sugestões de resposta do Social media (A6 · Z6, parte 2)', () => {
  let api: TestApi;
  let database: Database;
  let processador: ConexaoProcessor;
  let perfil: PerfilLoop;
  let executor: ActionExecutor;
  let servico: SugestoesDeRespostaService;
  let loop: SugestoesDeRespostaLoop;
  let flags: FlagService;
  let modelos: ia.ModelosDeTeste;
  let rota: { provider: string; model: string };
  const google = new GoogleComPerfil();

  /** O que o modelo simulado escreve, pelo pedido que recebeu (a mensagem e o contexto, como texto). */
  let responder: (pedido: string) => unknown = () => ({ sugestoes: BOAS });
  const simulado = new MockLanguageModelV4({
    doGenerate: async (opcoes) => ({
      content: [{ type: 'text' as const, text: JSON.stringify(responder(JSON.stringify(opcoes.prompt))) }],
      finishReason: { unified: 'stop' as const, raw: undefined },
      usage: ia.uso(1500, 200),
      warnings: [],
    }),
  });
  const padrao = (pedido: string) => ({ sugestoes: pedido.includes('não tem texto') ? SO_A_NOTA : pedido.includes(RECLAMACAO) ? DESCULPAS : BOAS });

  beforeAll(async () => {
    await google.subir();
    api = await startApi();
    await resetIpRateLimits();
    database = createDatabase({ connectionString: APP_URL, max: 8, applicationName: 'liame-test' });
    const vault = api.app.get(VaultService);
    flags = api.app.get(FlagService);
    processador = new ConexaoProcessor(database, loadConfig(), vault, flags);
    perfil = new PerfilLoop(database, loadConfig(), vault, flags);
    executor = new ActionExecutor(api.app.get(DATABASE), api.app.get(BudgetService), api.app.get(KillSwitchService), flags);
    // O modelo de IA é o simulado: nenhum fornecedor é chamado. A rota da tarefa tem nome fixo e ninguém apaga (V76).
    modelos = new ia.ModelosDeTeste(loadConfig());
    api.app.get(ModelosIa).modelo = (provider, model) => modelos.modelo(provider, model);
    rota = await ia.rotaCompartilhada(modelos, 'social_resposta', simulado);
    servico = new SugestoesDeRespostaService(database, flags, api.app.get(AiGateway), api.app.get(ResultsService), api.app.get(ActionService));
    loop = new SugestoesDeRespostaLoop(database, servico);
  }, 120_000);
  beforeEach(async () => {
    google.limpar();
    responder = padrao;
    modelos.porChave.set(`${rota.provider}/${rota.model}`, simulado);
    simulado.doGenerateCalls.length = 0;
    await resetIpRateLimits();
  });
  afterAll(async () => {
    await api?.close();
    await database?.close();
    await google.fechar();
  });

  // ---------------------------------------------------------------- ajudantes
  async function ligarFlag(tenantId: string, flag: string, valor: boolean): Promise<void> {
    await ownerQuery(`delete from liame.feature_flag_rule where flag_key = $1 and scope_type = 'tenant' and scope_id = $2`, [flag, tenantId]);
    if (valor) await ownerQuery(`insert into liame.feature_flag_rule (id, flag_key, scope_type, scope_id, value, created_by) values (gen_random_uuid(), $1, 'tenant', $2, 'true'::jsonb, 'testes')`, [flag, tenantId]);
    flags.invalidate();
  }
  const CHAVES = ['respostas_sugeridas', 'ia', 'perfil_google_write'];
  const avaliacao = (id: string, estrelas: AvaliacaoNoGoogle['starRating'], haDias: number, texto: string | null, extra: Partial<AvaliacaoNoGoogle> = {}): AvaliacaoNoGoogle => ({
    reviewId: id,
    starRating: estrelas,
    ...(texto === null ? {} : { comment: texto }),
    createTime: new Date(Date.now() - haDias * DIA_MS).toISOString(),
    updateTime: new Date(Date.now() - haDias * DIA_MS).toISOString(),
    ...extra,
  });
  const dossie = {
    identity: { summary: 'Hamburgueria de bairro com smash feito na chapa', audience: 'Quem mora ou trabalha no Centro', differentiator: 'Pão feito na casa todo dia', since: '2019' },
    voice: { traits: ['Direta'], rules: ['Frases curtas.'], do_example: 'Bateu a fome? O smash sai da chapa rapidinho.', dont_example: '' },
    products: { items: ['Smash Clássico R$ 29,90'] },
    offers: { items: [] },
    forbidden: { items: [] },
    competitors: { items: [] },
    region: { area: 'Centro e Lapa', pickup: true },
  };

  /**
   * A empresa com a loja do Perfil ligada pelo caminho do produto, Minha marca salva e, a pedido, as chaves das
   * sugestões ligadas ANTES da leitura; depois, a leitura do Google, que é quem abre a vez das avaliações.
   */
  async function empresa(nome: string, lista: AvaliacaoNoGoogle[], chaves = CHAVES): Promise<{ e: EmpresaComLoja; ids: Map<string, string>; agora: Date }> {
    const e = await empresaComLojaDoPerfil(api, google, processador, nome);
    const salvo = await api.call('PUT', '/v1/brand-dossier', { cookie: e.cookie, body: { brand_id: e.brandId, base_version: 0, content: dossie } });
    expect(salvo.status, JSON.stringify(salvo.body)).toBe(200);
    for (const flag of chaves) await ligarFlag(e.tenantId, flag, true);
    google.lista = lista;
    const agora = new Date();
    expect((await perfil.executarLote(10, { tenantIds: [e.tenantId] }, agora)).map((r) => r.status)).toEqual(['ok', 'ok']);
    const linhas = await ownerQuery<{ id: string; external_id: string }>(`select id, external_id from liame.profile_review where connected_account_id = $1`, [e.contaId]);
    google.vistos.length = 0;
    return { e, ids: new Map(linhas.map((l) => [l.external_id, l.id])), agora };
  }
  const vezes = (e: EmpresaComLoja) =>
    ownerQuery<Linha>(
      `select id, review_id, round, status, reason, barred_by, suggestions, action_id, usage_id, attempts, next_attempt_at, finished_at
         from liame.review_suggestion where tenant_id = $1 order by created_at, id`,
      [e.tenantId],
    );
  const vezDa = async (e: EmpresaComLoja, reviewId: string) => (await vezes(e)).find((v) => v.review_id === reviewId);
  const pedidos = (e: EmpresaComLoja) =>
    ownerQuery<Pedido>(
      `select id, tool, action, mode, status, status_reason, resource_id, params, actor_type, agent_key, requested_by, plan_hash
         from liame.action_request where tenant_id = $1 order by created_at, id`,
      [e.tenantId],
    );
  const trilha = (e: EmpresaComLoja, acao: string) => ownerQuery<{ resource_id: string; after: Record<string, unknown> }>(`select resource_id, "after" from liame.audit_event where tenant_id = $1 and action = $2 order by chain_seq`, [e.tenantId, acao]);
  const rodar = (e: EmpresaComLoja, agora = new Date()) => loop.executarLote(10, { tenantIds: [e.tenantId] }, agora);
  async function codigo(e: EmpresaComLoja): Promise<string> {
    await ownerQuery(`update liame.app_user set totp_last_step = null where id = $1`, [e.userId]);
    await ownerQuery(`delete from liame.rate_limit where key = $1`, [`segundo-fator:${e.userId}`]);
    return totpCode(e.segredoDoApp, currentStep());
  }

  // ---------------------------------------------------------------- os testes
  it('D-A6-26 e D-A6-27: a leitura abre a vez das avaliações novas sem resposta; ele escreve, o código confere, e o pedido vai para Aprovações em nome do dono', async () => {
    const { e, ids, agora } = await empresa('Mister Burgers Sugestões', [
      avaliacao('rev-elogio', 'FIVE', 2, ELOGIO),
      avaliacao('rev-nota', 'FOUR', 3, null),
      // De fora: a de mais de 30 dias e a que já tem resposta.
      avaliacao('rev-antiga', 'FIVE', 40, 'Muito bom, voltarei.'),
      avaliacao('rev-respondida', 'FIVE', 4, 'Gostei muito.', { reviewReply: { comment: 'Obrigado!', updateTime: new Date().toISOString() } }),
    ]);
    const abertas = await vezes(e);
    expect(abertas.map((v) => [v.review_id, v.round, v.status, v.attempts]).sort()).toEqual(
      [
        [ids.get('rev-elogio'), 1, 'esperando', 0],
        [ids.get('rev-nota'), 1, 'esperando', 0],
      ].sort(),
    );

    const feito = await rodar(e, agora);
    expect(feito.map((v) => v.feito.status).sort()).toEqual(['pronta', 'pronta']);
    expect(simulado.doGenerateCalls).toHaveLength(2);
    // O que ele recebeu: a nota, o texto entre as marcas e Minha marca; nunca o nome de quem avaliou (D-A6-29).
    const enviados = simulado.doGenerateCalls.map((c) => JSON.stringify(c.prompt));
    expect(enviados.some((p) => p.includes(ELOGIO) && p.includes('AVALIAÇÃO NO GOOGLE'))).toBe(true);
    expect(enviados.some((p) => p.includes('não tem texto'))).toBe(true);
    for (const p of enviados) {
      expect(p).toContain('Mister Burgers Sugestões');
      expect(p).not.toContain('Pessoa Número');
      expect(p).not.toContain(nomeDeQuemAvaliou('rev-elogio'));
    }

    // Um pedido por avaliação, do Social media em nome do dono, esperando a aprovação com o código do app.
    const lista = await pedidos(e);
    expect(lista).toHaveLength(2);
    const doElogio = lista.find((p) => p.resource_id === `avaliacao:${ids.get('rev-elogio')}`)!;
    const daNota = lista.find((p) => p.resource_id === `avaliacao:${ids.get('rev-nota')}`)!;
    for (const p of [doElogio, daNota]) {
      expect(p).toMatchObject({ tool: 'avaliacao_responder', action: 'avaliacao.responder', mode: 'APPROVAL', status: 'aguardando_aprovacao', actor_type: 'agent', agent_key: 'social', requested_by: e.userId });
    }
    // O texto que iria ao Google é o da primeira sugestão; as sugestões vão junto, com a rodada.
    expect(doElogio.params).toEqual({ texto: BOAS[0]!.texto, sugestoes: BOAS.map((s) => ({ ...s, rodada: 1 })) });
    expect(daNota.params).toEqual({ texto: SO_A_NOTA[0]!.texto, sugestoes: SO_A_NOTA.map((s) => ({ ...s, rodada: 1 })) });

    // A vez acabou pronta, ligada ao pedido, com o uso de IA; nenhum texto na linha.
    const prontas = await vezes(e);
    expect(prontas.find((v) => v.review_id === ids.get('rev-elogio'))).toMatchObject({ status: 'pronta', suggestions: 2, action_id: doElogio.id, barred_by: null, reason: null });
    expect(prontas.find((v) => v.review_id === ids.get('rev-nota'))).toMatchObject({ status: 'pronta', suggestions: 1, action_id: daNota.id });
    for (const v of prontas) {
      expect(v.usage_id).not.toBeNull();
      expect(v.finished_at).not.toBeNull();
      expect(v.next_attempt_at).toBeNull();
    }

    // Cada pedido leu a avaliação no Google na hora (o Action Service), e nada foi publicado.
    expect(google.respostasGravadas()).toEqual([]);
    // A trilha: o pedido em nome do funcionário, e a sugestão só com números e códigos.
    const pedidosNaTrilha = await trilha(e, 'acao.pedir');
    expect(pedidosNaTrilha.map((t) => t.after)).toEqual(expect.arrayContaining([expect.objectContaining({ tool: 'avaliacao_responder', agent_key: 'social', on_behalf_of: e.userId })]));
    const sugestoes = await trilha(e, 'avaliacao.sugerir');
    expect(sugestoes.map((t) => t.after.suggestions).sort()).toEqual([1, 2]);
    expect(JSON.stringify(sugestoes)).not.toContain('Que bom ler isso');
    expect(JSON.stringify(sugestoes)).not.toContain(ELOGIO);

    // A rotina que roda de novo não sugere em dobro, e a leitura seguinte não abre outra vez para elas.
    expect(await rodar(e, new Date(agora.getTime() + 2 * 60 * MIN_MS))).toEqual([]);
    await perfil.executarLote(10, { tenantIds: [e.tenantId] }, new Date(agora.getTime() + 61 * MIN_MS));
    expect(await vezes(e)).toHaveLength(2);
    expect(simulado.doGenerateCalls).toHaveLength(2);
  });

  it('D-A6-27: na avaliação de 1 estrela o funcionário pede, a política põe em ESCALATE, e o dono é avisado por e-mail', async () => {
    const { e, ids, agora } = await empresa('Mister Burgers Uma Estrela', [avaliacao('rev-ruim', 'ONE', 1, RECLAMACAO)]);
    const antes = api.mailer.sent.length;
    expect((await rodar(e, agora)).map((v) => v.feito.status)).toEqual(['pronta']);
    const [p] = await pedidos(e);
    expect(p).toMatchObject({ action: 'avaliacao.responder_nota_baixa', mode: 'ESCALATE', status: 'aguardando_aprovacao', status_reason: 'precisa do dono', agent_key: 'social', requested_by: e.userId });
    expect(p!.params.sugestoes?.map((s) => s.enfoque)).toEqual(DESCULPAS.map((s) => s.enfoque));
    expect(p!.resource_id).toBe(`avaliacao:${ids.get('rev-ruim')}`);
    // O pedido de um funcionário de IA sempre avisa o dono (só o dono decide a de 1 ou 2 estrelas; D-A6-4).
    const aviso = api.mailer.sent.slice(antes).find((m) => m.to === e.email);
    expect(aviso?.subject).toBe('Liame: uma resposta a avaliação espera a sua decisão');
    expect(aviso?.text).not.toContain(RECLAMACAO);
    expect(aviso?.text).not.toContain('Pedimos desculpas');
  });

  it('a pessoa escolhe a outra sugestão e aprova: o que vai ao Google é só o texto escolhido, e as sugestões ficam como ele escreveu', async () => {
    const { e, ids, agora } = await empresa('Mister Burgers Escolha', [avaliacao('rev-5', 'FIVE', 2, ELOGIO)]);
    await rodar(e, agora);
    const [p] = await pedidos(e);

    // Escolher a segunda = alterar o texto do pedido: o plano muda, e a aprovação do plano anterior deixa de valer.
    const escolha = await api.call('PATCH', `/v1/actions/${p!.id}`, { cookie: e.cookie, body: { params: { texto: BOAS[1]!.texto } } });
    expect(escolha.status, JSON.stringify(escolha.body)).toBe(200);
    const [escolhido] = await pedidos(e);
    expect(escolhido!.params).toEqual({ texto: BOAS[1]!.texto, sugestoes: BOAS.map((s) => ({ ...s, rodada: 1 })) });
    expect(escolhido!.plan_hash).not.toBe(p!.plan_hash);

    // As sugestões são do funcionário: mandar outras ao alterar é recusado; mandar as mesmas de volta, não.
    const trocadas = await api.call('PATCH', `/v1/actions/${p!.id}`, { cookie: e.cookie, body: { params: { texto: BOAS[1]!.texto, sugestoes: [{ enfoque: 'Minha', texto: 'Escrita por uma pessoa.', rodada: 1 }] } } });
    expect([trocadas.status, trocadas.body.errors?.[0]?.path]).toEqual([400, 'params.sugestoes']);
    const iguais = await api.call('PATCH', `/v1/actions/${p!.id}`, { cookie: e.cookie, body: { params: { texto: BOAS[1]!.texto, sugestoes: BOAS.map((s) => ({ rodada: 1, texto: s.texto, enfoque: s.enfoque })) } } });
    expect(iguais.status, JSON.stringify(iguais.body)).toBe(200);
    // E o pedido de uma pessoa não traz sugestões.
    const daPessoa = await api.call('POST', '/v1/actions', {
      cookie: e.cookie,
      body: { tool: 'avaliacao_responder', provider: 'google_business', account_id: e.contaId, resource_id: `avaliacao:${ids.get('rev-5')}`, params: { texto: 'Obrigado!', sugestoes: [{ enfoque: 'A', texto: 'B', rodada: 1 }] } },
    });
    expect([daPessoa.status, daPessoa.body.errors?.[0]?.path]).toEqual([400, 'params.sugestoes']);

    const [atual] = await pedidos(e);
    const aprovado = await api.call('POST', `/v1/actions/${p!.id}/approve`, { cookie: e.cookie, body: { plan_hash: atual!.plan_hash, code: await codigo(e) } });
    expect(aprovado.status, JSON.stringify(aprovado.body)).toBe(200);
    await executor.runCycle(20, { tenantIds: [e.tenantId] });
    // Uma resposta, com exatamente o texto escolhido; a primeira sugestão não foi ao Google.
    expect(google.respostasGravadas().map((v) => v.corpo)).toEqual([{ comment: BOAS[1]!.texto }]);
  });

  it('D-A6-28: a conferência barra as duas sugestões que prometem compensação; nada vai para Aprovações e o texto barrado não fica', async () => {
    responder = () => ({ sugestoes: COM_CUPOM });
    const { e, ids, agora } = await empresa('Mister Burgers Barrada', [avaliacao('rev-ruim', 'TWO', 1, RECLAMACAO)]);
    expect((await rodar(e, agora)).map((v) => v.feito)).toEqual([{ status: 'barrada', itens: ['regras_da_resposta'] }]);
    expect(await pedidos(e)).toEqual([]);
    expect(await vezDa(e, ids.get('rev-ruim')!)).toMatchObject({ status: 'barrada', reason: 'conferencia', barred_by: ['regras_da_resposta'], action_id: null, suggestions: null });
    const [barrada] = await trilha(e, 'avaliacao.barrar_sugestoes');
    expect(barrada!.after).toMatchObject({ barred_by: ['regras_da_resposta'], findings: ['compensacao'], agent_key: 'social' });
    const tudo = await ownerQuery<{ t: string }>(`select coalesce(string_agg(s::text, ' '), '') as t from liame.review_suggestion s where tenant_id = $1`, [e.tenantId]);
    expect(tudo[0]!.t).not.toContain('cupom');
    expect(JSON.stringify(barrada)).not.toContain('cupom de desconto');
  });

  it('D-A6-30: sem uma das chaves, a leitura não abre a vez; ligadas, a próxima leitura abre; desligada no meio, a vez espera sem contar tentativa', async () => {
    const { e, ids, agora } = await empresa('Mister Burgers Desligada', [avaliacao('rev-5', 'FIVE', 2, ELOGIO)], ['ia', 'perfil_google_write']);
    expect(await vezes(e)).toEqual([]);
    await ligarFlag(e.tenantId, 'respostas_sugeridas', true);
    // O Social media desligado na marca (a pausa de Sua equipe) também segura.
    await ownerQuery(`insert into liame.agent_pause (id, tenant_id, brand_id, agent_key, paused_by, reason) values (gen_random_uuid(), $1, $2, 'social', $3, 'teste da pausa')`, [
      e.tenantId,
      e.brandId,
      e.userId,
    ]);
    const depois = new Date(agora.getTime() + 61 * MIN_MS);
    await perfil.executarLote(10, { tenantIds: [e.tenantId] }, depois);
    expect(await vezes(e)).toEqual([]);
    await ownerQuery(`update liame.agent_pause set resumed_at = now(), resumed_by = $2 where tenant_id = $1 and agent_key = 'social' and resumed_at is null`, [e.tenantId, e.userId]);
    const maisDepois = new Date(agora.getTime() + 122 * MIN_MS);
    await perfil.executarLote(10, { tenantIds: [e.tenantId] }, maisDepois);
    expect((await vezes(e)).map((v) => [v.review_id, v.status])).toEqual([[ids.get('rev-5'), 'esperando']]);

    // A função desligada depois de a vez abrir: ela espera uma hora, sem contar tentativa, e o modelo não é chamado.
    await ligarFlag(e.tenantId, 'respostas_sugeridas', false);
    expect((await rodar(e, maisDepois)).map((v) => v.feito)).toEqual([{ status: 'esperando', motivo: 'funcao_desligada' }]);
    const esperando = (await vezes(e))[0]!;
    expect(esperando).toMatchObject({ status: 'esperando', reason: 'funcao_desligada', attempts: 0 });
    expect(new Date(esperando.next_attempt_at!).getTime()).toBe(maisDepois.getTime() + 60 * MIN_MS);
    // A IA desligada: o mesmo, com o porquê dela.
    await ligarFlag(e.tenantId, 'respostas_sugeridas', true);
    await ligarFlag(e.tenantId, 'ia', false);
    const naHora = new Date(maisDepois.getTime() + 61 * MIN_MS);
    expect((await rodar(e, naHora)).map((v) => v.feito)).toEqual([{ status: 'esperando', motivo: 'ia_desligada' }]);
    expect(simulado.doGenerateCalls).toHaveLength(0);
    // Tudo ligado de novo: na vez seguinte, ele escreve.
    await ligarFlag(e.tenantId, 'ia', true);
    expect((await rodar(e, new Date(naHora.getTime() + 61 * MIN_MS))).map((v) => v.feito.status)).toEqual(['pronta']);
  });

  it('a avaliação respondida antes da vez, a que ganhou um pedido de uma pessoa e a que passou dos 30 dias são descartadas sem chamar o modelo', async () => {
    const { e, ids, agora } = await empresa('Mister Burgers Descartes', [
      avaliacao('rev-respondida', 'FIVE', 2, ELOGIO),
      avaliacao('rev-pessoa', 'FOUR', 3, 'Bom atendimento no salão.'),
      avaliacao('rev-velha', 'FIVE', 25, 'Gostei do pão da casa.'),
    ]);
    expect(await vezes(e)).toHaveLength(3);
    // Respondida direto no Google: a leitura seguinte traz a resposta.
    await ownerQuery(`update liame.profile_review set reply_text = 'Obrigado!', reply_state = 'aprovada' where id = $1`, [ids.get('rev-respondida')]);
    // Uma pessoa pediu a resposta pela tela antes da vez.
    const daPessoa = await api.call('POST', '/v1/actions', {
      cookie: e.cookie,
      body: { tool: 'avaliacao_responder', provider: 'google_business', account_id: e.contaId, resource_id: `avaliacao:${ids.get('rev-pessoa')}`, params: { texto: 'Obrigado pela visita!' } },
    });
    expect(daPessoa.status, JSON.stringify(daPessoa.body)).toBe(201);
    // Seis dias depois, a de 25 dias passou dos 30.
    const seisDias = new Date(agora.getTime() + 6 * DIA_MS);
    const feito = await rodar(e, seisDias);
    expect(feito.map((v) => v.feito).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))).toEqual([
      { status: 'descartada', motivo: 'antiga' },
      { status: 'descartada', motivo: 'ja_tem_pedido' },
      { status: 'descartada', motivo: 'respondida' },
    ]);
    expect(simulado.doGenerateCalls).toHaveLength(0);
    expect((await pedidos(e)).map((p) => p.actor_type)).toEqual(['human']);
    for (const v of await vezes(e)) expect(v).toMatchObject({ status: 'descartada', next_attempt_at: null });
    expect((await trilha(e, 'avaliacao.descartar_sugestoes')).map((t) => t.after.reason).sort()).toEqual(['antiga', 'ja_tem_pedido', 'respondida']);
  });

  it('a IA fora do ar conta tentativa e volta em 15 e em 30 minutos; na terceira, a vez acaba como falhou', async () => {
    const { e, ids, agora } = await empresa('Mister Burgers IA Fora', [avaliacao('rev-5', 'FIVE', 2, ELOGIO)]);
    modelos.porChave.set(`${rota.provider}/${rota.model}`, ia.recusa(503));
    expect((await rodar(e, agora)).map((v) => v.feito)).toEqual([{ status: 'falhou', motivo: 'ia_fora_do_ar', deVez: false }]);
    let v = (await vezDa(e, ids.get('rev-5')!))!;
    expect([v.status, v.attempts, v.reason, new Date(v.next_attempt_at!).getTime()]).toEqual(['esperando', 1, 'ia_fora_do_ar', agora.getTime() + 15 * MIN_MS]);
    // Antes da hora, nada.
    expect(await rodar(e, new Date(agora.getTime() + 10 * MIN_MS))).toEqual([]);
    const segunda = new Date(agora.getTime() + 16 * MIN_MS);
    expect((await rodar(e, segunda)).map((x) => x.feito)).toEqual([{ status: 'falhou', motivo: 'ia_fora_do_ar', deVez: false }]);
    v = (await vezDa(e, ids.get('rev-5')!))!;
    expect([v.attempts, new Date(v.next_attempt_at!).getTime()]).toEqual([2, segunda.getTime() + 30 * MIN_MS]);
    expect((await rodar(e, new Date(segunda.getTime() + 31 * MIN_MS))).map((x) => x.feito)).toEqual([{ status: 'falhou', motivo: 'ia_fora_do_ar', deVez: true }]);
    expect(await vezDa(e, ids.get('rev-5')!)).toMatchObject({ status: 'falhou', reason: 'ia_fora_do_ar', attempts: 3, next_attempt_at: null });
    expect(await pedidos(e)).toEqual([]);
  });

  it('o Google fora do ar na hora do pedido conta tentativa (a sugestão não fica guardada); na volta, o pedido nasce', async () => {
    const { e, ids, agora } = await empresa('Mister Burgers Google Fora', [avaliacao('rev-5', 'FIVE', 2, ELOGIO)]);
    google.umaAvaliacao = 'fora';
    expect((await rodar(e, agora)).map((v) => v.feito)).toEqual([{ status: 'falhou', motivo: 'plataforma_indisponivel', deVez: false }]);
    expect(await pedidos(e)).toEqual([]);
    expect(await vezDa(e, ids.get('rev-5')!)).toMatchObject({ status: 'esperando', attempts: 1, action_id: null });
    google.umaAvaliacao = 'ok';
    expect((await rodar(e, new Date(agora.getTime() + 16 * MIN_MS))).map((v) => v.feito.status)).toEqual(['pronta']);
    expect(await pedidos(e)).toHaveLength(1);
    expect(simulado.doGenerateCalls).toHaveLength(2);
  });

  it('V35: duas voltas da rotina ao mesmo tempo tratam cada vez uma vez só, e cada avaliação tem um pedido', async () => {
    const lista = Array.from({ length: 6 }, (_, i) => avaliacao(`rev-${i}`, 'FIVE', 1 + i, `Muito bom o smash, nota ${5}.`));
    const { e, agora } = await empresa('Mister Burgers Concorrência', lista);
    expect(await vezes(e)).toHaveLength(6);
    const [a, b] = await Promise.all([loop.executarLote(4, { tenantIds: [e.tenantId] }, agora), loop.executarLote(4, { tenantIds: [e.tenantId] }, agora)]);
    // As duas voltas juntas reservaram as seis vezes, cada uma uma vez só (SKIP LOCKED na linha que a reserva altera).
    const tratadas = [...a!, ...b!].map((v) => v.id);
    expect(tratadas).toHaveLength(6);
    expect(new Set(tratadas).size).toBe(6);
    // A leitura do Google na hora do pedido pode responder "tente de novo": a cota do Perfil é uma só para o app, e os
    // outros arquivos de teste dividem o mesmo balde no banco (V76, ERR-168). A vez conta a tentativa e volta mais tarde,
    // como na produção: o relógio anda e a rotina passa de novo, até três vezes.
    const voltas = [...a!, ...b!];
    let quando = agora;
    for (let i = 0; i < 3 && (await vezes(e)).some((v) => v.status === 'esperando'); i++) {
      quando = new Date(quando.getTime() + 61 * MIN_MS);
      voltas.push(...(await rodar(e, quando)));
    }
    const fim = await vezes(e);
    const desfecho = JSON.stringify({ voltas: voltas.map((v) => v.feito), fim: fim.map((v) => [v.status, v.reason, v.attempts]) });
    expect(fim.map((v) => v.status), desfecho).toEqual(Array(6).fill('pronta'));
    // O que não foi "pronta" de primeira foi só a falha passageira do Google, nunca outra coisa.
    for (const v of voltas) if (v.feito.status !== 'pronta') expect(v.feito, desfecho).toMatchObject({ status: 'falhou', motivo: 'plataforma_indisponivel', deVez: false });
    const recursos = (await pedidos(e)).map((p) => p.resource_id);
    expect(new Set(recursos).size).toBe(6);
  });

  // ---------------------------------------------------------------- a retirada (parte 3a; P31)
  const retirar = (e: EmpresaComLoja, agora: Date) => loop.retirarLote(20, { tenantIds: [e.tenantId] }, agora);
  const ler = (e: EmpresaComLoja, agora: Date) => perfil.executarLote(10, { tenantIds: [e.tenantId] }, agora);
  const naApi = async (e: EmpresaComLoja, id: string) => (await api.call('GET', `/v1/actions/${id}`, { cookie: e.cookie })).body;

  it('P31: a avaliação editada depois das sugestões: o pedido sai de Aprovações, a vez volta a esperar, e as sugestões novas chegam num pedido novo', async () => {
    const { e, ids, agora } = await empresa('Mister Burgers Mudou', [avaliacao('rev-5', 'FIVE', 2, ELOGIO)]);
    await rodar(e, agora);
    const [primeiro] = await pedidos(e);
    // A API mostra as sugestões do pedido, e ainda nenhuma retirada.
    expect((await naApi(e, primeiro!.id)).review).toMatchObject({ suggestions: BOAS.map((s) => ({ focus: s.enfoque, text: s.texto, round: 1 })), withdrawn: null });

    // Quem avaliou editou: outra nota e outro texto, e o Google mudou a data da avaliação; a leitura seguinte traz.
    const depois = new Date(agora.getTime() + 61 * MIN_MS);
    google.lista = [avaliacao('rev-5', 'FOUR', 2, 'O combo veio caprichado, mas a batata chegou morna.', { updateTime: depois.toISOString() })];
    await ler(e, depois);
    expect((await retirar(e, new Date(depois.getTime() + MIN_MS))).map((v) => v.feito)).toEqual([{ status: 'de_novo', motivo: 'avaliacao_mudou', pedido: primeiro!.id }]);
    // O pedido saiu em nome do Social media, com o porquê em código; nada foi publicado.
    expect((await pedidos(e))[0]).toMatchObject({ id: primeiro!.id, status: 'cancelada', status_reason: 'retirada pelo funcionário: avaliacao_mudou' });
    expect((await naApi(e, primeiro!.id)).review).toMatchObject({ withdrawn: 'avaliacao_mudou', changed: true });
    const [retirada] = await trilha(e, 'acao.retirar');
    expect(retirada).toMatchObject({ resource_id: primeiro!.id, after: { status: 'cancelada', reason: 'avaliacao_mudou', agent_key: 'social' } });
    expect(await vezDa(e, ids.get('rev-5')!)).toMatchObject({ status: 'esperando', reason: 'avaliacao_mudou', action_id: null, suggestions: null, attempts: 0, finished_at: null });

    // Na vez seguinte, ele escreve para a avaliação como ela está agora, num pedido novo.
    expect((await rodar(e, new Date(depois.getTime() + 2 * MIN_MS))).map((v) => v.feito.status)).toEqual(['pronta']);
    const lista = await pedidos(e);
    expect(lista.map((p) => p.status)).toEqual(['cancelada', 'aguardando_aprovacao']);
    expect(lista[1]!.id).not.toBe(primeiro!.id);
    expect(JSON.stringify(simulado.doGenerateCalls.at(-1)!.prompt)).toContain('a batata chegou morna');
    expect(await vezDa(e, ids.get('rev-5')!)).toMatchObject({ status: 'pronta', action_id: lista[1]!.id });
    expect(google.respostasGravadas()).toEqual([]);
  });

  it('P31: a avaliação respondida direto no Google: o pedido sai de Aprovações, a vez acaba retirada, e duas voltas ao mesmo tempo retiram uma vez', async () => {
    const { e, ids, agora } = await empresa('Mister Burgers Respondida Fora', [avaliacao('rev-5', 'FIVE', 2, ELOGIO)]);
    await rodar(e, agora);
    const [p] = await pedidos(e);
    const depois = new Date(agora.getTime() + 61 * MIN_MS);
    google.lista = [avaliacao('rev-5', 'FIVE', 2, ELOGIO, { updateTime: depois.toISOString(), reviewReply: { comment: 'Valeu demais!', updateTime: depois.toISOString(), reviewReplyState: 'APPROVED' } })];
    await ler(e, depois);
    const naHora = new Date(depois.getTime() + MIN_MS);
    const [a, b] = await Promise.all([retirar(e, naHora), retirar(e, naHora)]);
    const feitos = [...a!, ...b!].map((v) => v.feito);
    expect(feitos.filter((f) => f.status === 'retirada')).toEqual([{ status: 'retirada', motivo: 'respondida_no_google', pedido: p!.id }]);
    expect(feitos.every((f) => f.status === 'retirada' || f.status === 'fora')).toBe(true);
    expect(await trilha(e, 'acao.retirar')).toHaveLength(1);
    expect((await pedidos(e))[0]).toMatchObject({ status: 'cancelada', status_reason: 'retirada pelo funcionário: respondida_no_google' });
    expect((await naApi(e, p!.id)).review.withdrawn).toBe('respondida_no_google');
    expect(await vezDa(e, ids.get('rev-5')!)).toMatchObject({ status: 'retirada', reason: 'respondida_no_google' });
    // A vez acabou: nada mais a olhar, e o Social media não escreve outra.
    expect(await retirar(e, new Date(naHora.getTime() + MIN_MS))).toEqual([]);
    expect(await rodar(e, new Date(naHora.getTime() + MIN_MS))).toEqual([]);
  });

  it('P31: nada mudou na leitura seguinte: o pedido fica, e a vez só volta a ser olhada depois de outra leitura', async () => {
    // A avaliação mudou há pouco no Google: a leitura seguinte a traz de novo, igual.
    const { e, agora } = await empresa('Mister Burgers Igual', [avaliacao('rev-5', 'FIVE', 2, ELOGIO, { updateTime: new Date(Date.now() - 10 * MIN_MS).toISOString() })]);
    await rodar(e, agora);
    const depois = new Date(agora.getTime() + 61 * MIN_MS);
    await ler(e, depois);
    expect((await retirar(e, new Date(depois.getTime() + MIN_MS))).map((v) => v.feito)).toEqual([{ status: 'igual' }]);
    expect(await retirar(e, new Date(depois.getTime() + 2 * MIN_MS))).toEqual([]);
    expect((await pedidos(e)).map((p) => p.status)).toEqual(['aguardando_aprovacao']);
    expect(await trilha(e, 'acao.retirar')).toEqual([]);
  });

  it('P31: o pedido já decidido e o de uma pessoa não são retirados, mesmo com a avaliação mudando', async () => {
    const { e, ids, agora } = await empresa('Mister Burgers Decidido', [avaliacao('rev-a', 'FIVE', 2, ELOGIO), avaliacao('rev-b', 'FOUR', 3, 'Bom atendimento no salão.')]);
    // A de rev-b fica com uma pessoa antes da vez; a de rev-a, o Social media sugere e a pessoa recusa.
    const daPessoa = await api.call('POST', '/v1/actions', {
      cookie: e.cookie,
      body: { tool: 'avaliacao_responder', provider: 'google_business', account_id: e.contaId, resource_id: `avaliacao:${ids.get('rev-b')}`, params: { texto: 'Obrigado pela visita!' } },
    });
    expect(daPessoa.status, JSON.stringify(daPessoa.body)).toBe(201);
    await rodar(e, agora);
    const doSocial = (await pedidos(e)).find((p) => p.agent_key === 'social')!;
    const recusa = await api.call('POST', `/v1/actions/${doSocial.id}/reject`, { cookie: e.cookie, body: { plan_hash: doSocial.plan_hash, reason: 'Nenhuma serve' } });
    expect(recusa.status, JSON.stringify(recusa.body)).toBe(200);
    // As duas avaliações mudam no Google.
    const depois = new Date(agora.getTime() + 61 * MIN_MS);
    google.lista = [
      avaliacao('rev-a', 'THREE', 2, 'Mudei de ideia: o lanche estava frio.', { updateTime: depois.toISOString() }),
      avaliacao('rev-b', 'TWO', 3, 'Mudei de ideia: demorou.', { updateTime: depois.toISOString() }),
    ];
    await ler(e, depois);
    expect(await retirar(e, new Date(depois.getTime() + MIN_MS))).toEqual([]);
    const lista = await pedidos(e);
    expect(lista.find((p) => p.id === doSocial.id)).toMatchObject({ status: 'cancelada', status_reason: expect.stringMatching(/^recusada por /) });
    expect(lista.find((p) => p.id === daPessoa.body.id)).toMatchObject({ status: 'aguardando_aprovacao', agent_key: null });
    expect((await naApi(e, doSocial.id)).review.withdrawn).toBeNull();
    expect((await naApi(e, daPessoa.body.id)).review).toMatchObject({ suggestions: null, withdrawn: null });
    expect(await trilha(e, 'acao.retirar')).toEqual([]);
  });

  // ---------------------------------------------------------------- o "Pedir outras" (parte 3b; P31; D-A6-27)
  const OUTRAS = [
    { enfoque: 'Destaca a entrega', texto: 'Obrigado pela avaliação! Entregar rápido e caprichado é o que a gente mais quer. Até a próxima.' },
    { enfoque: 'Bem curta', texto: 'Obrigado pelo carinho com o nosso smash! Até a próxima.' },
  ];
  /** Na segunda rodada (o contexto traz as que a pessoa já viu), o modelo escreve `outras`; na primeira, o de sempre. */
  const comOutras = (outras: unknown) => (pedido: string) => (pedido.includes('já viu') ? { sugestoes: outras } : padrao(pedido));
  const pedirOutras = (e: EmpresaComLoja, id: string, cookie = e.cookie) => api.call('POST', `/v1/actions/${id}/more-suggestions`, { cookie });

  it('P31: o "Pedir outras": ele escreve outras sem repetir as que a pessoa viu, no mesmo pedido e antes das primeiras; uma vez por avaliação', async () => {
    const { e, agora } = await empresa('Mister Burgers Outras', [avaliacao('rev-5', 'FIVE', 2, ELOGIO)]);
    await rodar(e, agora);
    const [p] = await pedidos(e);
    expect((await naApi(e, p!.id)).review.more_suggestions).toBe('pode_pedir');
    responder = comOutras(OUTRAS);

    const pedido = await pedirOutras(e, p!.id);
    expect(pedido.status, JSON.stringify(pedido.body)).toBe(200);
    expect(pedido.body.review.more_suggestions).toBe('escrevendo');
    // Uma vez por avaliação: a segunda vez é recusada, com o caminho que resolve.
    const deNovo = await pedirOutras(e, p!.id);
    expect([deNovo.status, deNovo.body.code]).toEqual([409, 'outras-ja-pedidas']);

    // A rotina escreve as outras, com as que a pessoa já viu no contexto.
    const depois = new Date(Date.now() + MIN_MS);
    expect((await rodar(e, depois)).map((v) => v.feito)).toEqual([{ status: 'pronta', pedido: p!.id, sugestoes: 2 }]);
    const enviado = JSON.stringify(simulado.doGenerateCalls.at(-1)!.prompt);
    expect(enviado).toContain('já viu');
    expect(enviado).toContain(BOAS[0]!.texto);
    // O pedido é o mesmo: as novas antes das primeiras, cada uma com a rodada; o texto passa a ser o da primeira nova, e o
    // plano é outro (a aprovação do anterior não vale mais).
    const [trocado] = await pedidos(e);
    expect(trocado).toMatchObject({ id: p!.id, status: 'aguardando_aprovacao', actor_type: 'agent', agent_key: 'social' });
    expect(trocado!.params).toEqual({ texto: OUTRAS[0]!.texto, sugestoes: [...OUTRAS.map((s) => ({ ...s, rodada: 2 })), ...BOAS.map((s) => ({ ...s, rodada: 1 }))] });
    expect(trocado!.plan_hash).not.toBe(p!.plan_hash);
    const review = (await naApi(e, p!.id)).review;
    expect([review.more_suggestions, review.suggestions.map((s: { round: number }) => s.round)]).toEqual(['feitas', [2, 2, 1, 1]]);
    expect((await vezes(e)).map((v) => [v.round, v.status, v.action_id, v.suggestions])).toEqual([
      [1, 'pronta', p!.id, 2],
      [2, 'pronta', null, 2],
    ]);
    const [troca] = await trilha(e, 'acao.trocar_sugestoes');
    expect(troca!.after).toMatchObject({ round: 2, suggestions: 2, kept_text: false, agent_key: 'social' });
    expect(JSON.stringify(troca)).not.toContain(OUTRAS[0]!.texto);
    expect(google.respostasGravadas()).toEqual([]);
  });

  it('P31: a versão que a pessoa ajustou continua escolhida quando as outras chegam', async () => {
    const { e, agora } = await empresa('Mister Burgers Ajustada', [avaliacao('rev-5', 'FIVE', 2, ELOGIO)]);
    await rodar(e, agora);
    const [p] = await pedidos(e);
    const minha = 'Obrigado pela visita! O combo família é o nosso xodó. Até a próxima.';
    expect((await api.call('PATCH', `/v1/actions/${p!.id}`, { cookie: e.cookie, body: { params: { texto: minha } } })).status).toBe(200);
    responder = comOutras(OUTRAS);
    expect((await pedirOutras(e, p!.id)).status).toBe(200);
    await rodar(e, new Date(Date.now() + MIN_MS));
    const [trocado] = await pedidos(e);
    expect(trocado!.params.texto).toBe(minha);
    expect(trocado!.params.sugestoes?.map((s) => s.rodada)).toEqual([2, 2, 1, 1]);
    expect((await trilha(e, 'acao.trocar_sugestoes'))[0]!.after).toMatchObject({ kept_text: true });
  });

  it('P31: só pede outras quem pode, no pedido do Social media que espera, com as sugestões ligadas; a de 1 estrela, só o dono', async () => {
    const { e, ids, agora } = await empresa('Mister Burgers Quem Pede', [avaliacao('rev-ruim', 'ONE', 1, RECLAMACAO), avaliacao('rev-b', 'FOUR', 3, 'Bom atendimento no salão.')]);
    // A de rev-b fica com uma pessoa antes da vez: o pedido dela não tem sugestões.
    const daPessoa = await api.call('POST', '/v1/actions', {
      cookie: e.cookie,
      body: { tool: 'avaliacao_responder', provider: 'google_business', account_id: e.contaId, resource_id: `avaliacao:${ids.get('rev-b')}`, params: { texto: 'Obrigado pela visita!' } },
    });
    expect(daPessoa.status, JSON.stringify(daPessoa.body)).toBe(201);
    await rodar(e, agora);
    const doSocial = (await pedidos(e)).find((p) => p.agent_key === 'social')!;
    expect((await naApi(e, daPessoa.body.id)).review.more_suggestions).toBeNull();
    const semSugestoes = await pedirOutras(e, daPessoa.body.id);
    expect([semSugestoes.status, semSugestoes.body.code]).toEqual([409, 'sem-sugestoes']);

    // Na de 1 estrela, quem não é o dono lê e não pede.
    const email = uniqueEmail('administrador');
    const convite = await api.call('POST', '/v1/invitations', { cookie: e.cookie, body: { email, role: 'administrador', approve_limit_micros: null } });
    expect(convite.status, JSON.stringify(convite.body)).toBe(201);
    const outro = await api.call('POST', '/v1/invitations/signup', { body: { token: tokenFrom(api.mailer, email), name: 'Pessoa Administradora', password: PASSWORD, terms_version: TERMOS } });
    await enableMfa(api, outro.cookie!);
    const naoDono = await pedirOutras(e, doSocial.id, outro.cookie!);
    expect([naoDono.status, naoDono.body.code]).toEqual([403, 'so-o-dono']);

    // Com as sugestões desligadas para a loja, não pede (e nada entra na fila).
    await ligarFlag(e.tenantId, 'respostas_sugeridas', false);
    const desligada = await pedirOutras(e, doSocial.id);
    expect([desligada.status, desligada.body.code]).toEqual([409, 'sugestoes-desligadas']);
    await ligarFlag(e.tenantId, 'respostas_sugeridas', true);

    // O pedido decidido não pede mais.
    const recusa = await api.call('POST', `/v1/actions/${doSocial.id}/reject`, { cookie: e.cookie, body: { plan_hash: doSocial.plan_hash, reason: 'Nenhuma serve' } });
    expect(recusa.status, JSON.stringify(recusa.body)).toBe(200);
    const decidido = await pedirOutras(e, doSocial.id);
    expect([decidido.status, decidido.body.code]).toEqual([409, 'acao-nao-aguarda']);
    expect((await naApi(e, doSocial.id)).review.more_suggestions).toBeNull();
    expect((await vezes(e)).filter((v) => v.round === 2)).toEqual([]);
  });

  it('P31: a segunda rodada que esperava acaba com o pedido retirado; o pedido novo não a mostra', async () => {
    const { e, ids, agora } = await empresa('Mister Burgers Outras Retiradas', [avaliacao('rev-5', 'FIVE', 2, ELOGIO)]);
    await rodar(e, agora);
    const [p] = await pedidos(e);
    expect((await pedirOutras(e, p!.id)).status).toBe(200);
    // Antes da vez da segunda rodada, quem avaliou edita a avaliação.
    const depois = new Date(agora.getTime() + 61 * MIN_MS);
    google.lista = [avaliacao('rev-5', 'FOUR', 2, 'O combo veio caprichado, mas a batata chegou morna.', { updateTime: depois.toISOString() })];
    await ler(e, depois);
    expect((await retirar(e, new Date(depois.getTime() + MIN_MS))).map((v) => v.feito.status)).toEqual(['de_novo']);
    expect((await vezes(e)).find((v) => v.round === 2)).toMatchObject({ status: 'descartada', reason: 'pedido_retirado' });
    // Na vez seguinte, só a primeira rodada (a da avaliação como está agora) é escrita, num pedido novo.
    expect((await rodar(e, new Date(depois.getTime() + 2 * MIN_MS))).map((v) => v.feito.status)).toEqual(['pronta']);
    const novo = (await pedidos(e)).find((x) => x.status === 'aguardando_aprovacao')!;
    expect(novo.id).not.toBe(p!.id);
    expect((await naApi(e, novo.id)).review.more_suggestions).toBeNull();
    expect((await naApi(e, p!.id)).review).toMatchObject({ withdrawn: 'avaliacao_mudou', more_suggestions: null });
    expect(await vezDa(e, ids.get('rev-5')!)).toMatchObject({ round: 1, status: 'pronta', action_id: novo.id });
  });

  it('P31: a sugestão nova que repete uma das que a pessoa já viu não entra; se as duas repetem, a vez tenta de novo', async () => {
    const { e, agora } = await empresa('Mister Burgers Repetidas', [avaliacao('rev-5', 'FIVE', 2, ELOGIO)]);
    await rodar(e, agora);
    const [p] = await pedidos(e);
    expect((await pedirOutras(e, p!.id)).status).toBe(200);
    // Ele repete as duas: nada entra no pedido, a recusa conta em Sua equipe, e a vez tenta de novo mais tarde.
    responder = comOutras(BOAS);
    const depois = new Date(Date.now() + MIN_MS);
    expect((await rodar(e, depois)).map((v) => v.feito)).toEqual([{ status: 'falhou', motivo: 'repetida', deVez: false }]);
    expect((await pedidos(e))[0]!.plan_hash).toBe(p!.plan_hash);
    expect((await naApi(e, p!.id)).review.more_suggestions).toBe('escrevendo');
    // Na tentativa seguinte, repete uma e escreve uma nova: só a nova entra.
    responder = comOutras([BOAS[0], OUTRAS[1]]);
    expect((await rodar(e, new Date(depois.getTime() + 16 * MIN_MS))).map((v) => v.feito)).toEqual([{ status: 'pronta', pedido: p!.id, sugestoes: 1 }]);
    const [trocado] = await pedidos(e);
    expect(trocado!.params.sugestoes).toEqual([{ ...OUTRAS[1]!, rodada: 2 }, ...BOAS.map((s) => ({ ...s, rodada: 1 }))]);
    expect(trocado!.params.texto).toBe(OUTRAS[1]!.texto);
  });

  it('V119: as regras da tabela', async () => {
    const { e, ids } = await empresa('Mister Burgers Regras', [avaliacao('rev-a', 'FIVE', 2, ELOGIO), avaliacao('rev-b', 'FOUR', 3, null)], []);
    const review = ids.get('rev-a')!;
    const base = { status: 'esperando', round: 1, reason: null as string | null, barred_by: null as string | null, suggestions: null as number | null, attempts: 0, finished: false };
    const inserir = (c: Partial<typeof base> & { review?: string }) => {
      const x = { ...base, ...c };
      return ownerQuery(
        `insert into liame.review_suggestion (id, tenant_id, brand_id, review_id, round, status, reason, barred_by, suggestions, attempts, finished_at)
         values (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7::text[], $8, $9, case when $10::boolean then now() end) returning id`,
        [e.tenantId, e.brandId, c.review ?? review, x.round, x.status, x.reason, x.barred_by, x.suggestions, x.attempts, x.finished],
      );
    };
    // O que passa: a que espera, sem fim; a pronta com a contagem; a barrada com o que barrou.
    const [espera] = await inserir({});
    expect(espera).toBeDefined();
    await expect(inserir({})).rejects.toMatchObject({ code: '23505', constraint: 'review_suggestion_rodada' });
    expect(await inserir({ round: 2, status: 'pronta', suggestions: 2, finished: true })).toHaveLength(1);
    expect(await inserir({ review: ids.get('rev-b'), status: 'barrada', reason: 'conferencia', barred_by: '{regras_da_resposta,numeros}', finished: true })).toHaveLength(1);
    // O que não passa, cada uma pela restrição dela.
    const outra = ids.get('rev-b')!;
    await expect(inserir({ review: outra, round: 3 })).rejects.toMatchObject({ code: '23514', constraint: 'review_suggestion_round_check' });
    // Cada caso viola uma regra só: o Postgres confere as restrições em ordem alfabética e diz a primeira que falhou.
    await expect(inserir({ review: outra, round: 2, status: 'lida', finished: true })).rejects.toMatchObject({ code: '23514', constraint: 'review_suggestion_status_check' });
    await expect(inserir({ review: outra, round: 2, reason: 'Funcao Desligada' })).rejects.toMatchObject({ code: '23514', constraint: 'review_suggestion_reason_check' });
    await expect(inserir({ review: outra, round: 2, status: 'barrada', barred_by: '{Regra}', finished: true })).rejects.toMatchObject({ code: '23514', constraint: 'review_suggestion_barred_by_check' });
    await expect(inserir({ review: outra, round: 2, status: 'pronta', suggestions: 3, finished: true })).rejects.toMatchObject({ code: '23514', constraint: 'review_suggestion_suggestions_check' });
    await expect(inserir({ review: outra, round: 2, attempts: -1 })).rejects.toMatchObject({ code: '23514', constraint: 'review_suggestion_attempts_check' });
    await expect(inserir({ review: outra, round: 2, status: 'pronta', finished: true })).rejects.toMatchObject({ code: '23514', constraint: 'review_suggestion_pronta' });
    await expect(inserir({ review: outra, round: 2, status: 'barrada', finished: true })).rejects.toMatchObject({ code: '23514', constraint: 'review_suggestion_barrada' });
    await expect(inserir({ review: outra, round: 2, barred_by: '{numeros}' })).rejects.toMatchObject({ code: '23514', constraint: 'review_suggestion_barrada' });
    await expect(inserir({ review: outra, round: 2, finished: true })).rejects.toMatchObject({ code: '23514', constraint: 'review_suggestion_fim' });
    await expect(inserir({ review: outra, round: 2, status: 'descartada', reason: 'antiga' })).rejects.toMatchObject({ code: '23514', constraint: 'review_suggestion_fim' });
  });
});
