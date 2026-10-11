import type { ActionProposal } from '@liame/contracts';
import { describe, expect, it } from 'vitest';
import {
  ACAO_DA_RESPOSTA,
  ACAO_DA_RESPOSTA_DE_NOTA_BAIXA,
  citaONome,
  type EstadoDaAvaliacao,
  estadoDaAvaliacao,
  planoDaResposta,
  primeiroNome,
  problemasDaResposta,
  respostaJaPublicada,
  versaoDaAvaliacao,
} from '../src/actions/avaliacao-plano.js';
import { CONNECTORS } from '../src/actions/connectors.js';
import { avaliacaoDoRecurso, perfilAvaliacaoConnector, recursoDaAvaliacao, recusaDoPerfil } from '../src/actions/perfil-avaliacao.js';
import { PlanoRecusado, TOOLS } from '../src/actions/tools.js';
import { ErroConector } from '../src/connectors/cliente-http.js';
import type { AvaliacaoLida } from '../src/connectors/google-business/perfil-google.js';
import { chooseMode, evaluatePolicy, type LoadedPolicy, PLATFORM_POLICY } from '../src/policy/engine.js';

// A6 · Z2 (parte b), sem rede e sem banco: a ferramenta `avaliacao_responder`. O estado que o pedido guarda (sem o
// texto da avaliação e sem o nome de quem avaliou), a versão que nota a avaliação que mudou (A6-4), a conferência do
// texto da resposta (A6-5), quem decide (A6-3: sempre uma pessoa; a de 1 ou 2 estrelas, só o dono) e a política v7.

const ID = '44444444-4444-4444-8444-444444444444';
const NO_GOOGLE = 'AbCdEf-123';
const TEXTO = 'Que bom ler isso! Obrigado pela visita, e até o próximo smash.';

const lida = (parcial: Partial<AvaliacaoLida> = {}): AvaliacaoLida => ({
  id: NO_GOOGLE,
  estrelas: 5,
  texto: 'Melhor smash da região! A entrega foi rápida.',
  criadaEm: '2026-10-10T20:14:00.000Z',
  atualizadaEm: '2026-10-10T20:14:00.000Z',
  resposta: null,
  ...parcial,
});
const estado = (parcial: Partial<AvaliacaoLida> = {}): EstadoDaAvaliacao => estadoDaAvaliacao({ id: ID, googleId: NO_GOOGLE }, lida(parcial));
const tool = TOOLS.avaliacao_responder!;
const recusa = (fn: () => unknown): string => {
  try {
    fn();
  } catch (err) {
    if (err instanceof PlanoRecusado) return err.message;
    throw err;
  }
  throw new Error('o plano não foi recusado');
};

describe('avaliacao_responder: o registro e o conector (A6 · Z2)', () => {
  it('a ferramenta: só no perfil do Google, sempre com uma pessoa, sem parâmetro que ela não conhece, e sem volta nesta entrega', () => {
    expect(tool).toMatchObject({ name: 'avaliacao_responder', version: 1, owner: 'social', risk: 'R2', providers: ['google_business'], compensation: 'apagar_a_resposta', alwaysApproval: true });
    expect(tool.undo).toBeUndefined();
    expect(tool.directByPerson).toBeUndefined();
    expect(tool.revalidateOnApproval).toBeUndefined();
    expect(tool.params.safeParse({ texto: TEXTO }).success).toBe(true);
    for (const ruim of [{}, { texto: '' }, { texto: TEXTO, outro: 1 }, { texto: 42 }, { texto: 'x'.repeat(6001) }]) expect(tool.params.safeParse(ruim).success, JSON.stringify(ruim).slice(0, 40)).toBe(false);
  });

  it('o conector de ação: a flag de escrita própria, sem verba de mídia, e o recurso é a avaliação guardada no Liame', () => {
    expect(CONNECTORS.google_business).toBe(perfilAvaliacaoConnector);
    expect(perfilAvaliacaoConnector).toMatchObject({ provider: 'google_business', writeFlag: 'perfil_google_write', requiresSpendLimits: false });
    expect(recursoDaAvaliacao(ID)).toBe(`avaliacao:${ID}`);
    expect(avaliacaoDoRecurso(`avaliacao:${ID.toUpperCase()}`)).toBe(ID);
    for (const ruim of ['', ID, `avaliacao:${NO_GOOGLE}`, 'avaliacao:', `mensagem:${ID}`, `avaliacao:${ID}/x`]) expect(avaliacaoDoRecurso(ruim), ruim).toBeNull();
  });

  it('a recusa do Google em palavras; o que é passageiro sobe para o executor adiar', () => {
    const erro = (tipo: ConstructorParameters<typeof ErroConector>[0], status: number | null = null) => new ErroConector(tipo, 'google_business', 'The caller does not have permission', status);
    expect(recusaDoPerfil(erro('autenticacao', 401))).toContain('Conecte o Google de novo em Contas conectadas');
    expect(recusaDoPerfil(erro('permissao', 403))).toContain('com a conta que cuida do perfil');
    expect(recusaDoPerfil(erro('definitivo', 404))).toContain('não está mais no Google');
    expect(recusaDoPerfil(erro('definitivo', 400))).toBe('O Google não aceitou a resposta. Nada foi publicado.');
    // A frase do Google (em inglês) não vai para a pessoa.
    for (const frase of [erro('permissao', 403), erro('definitivo', 400)].map(recusaDoPerfil)) expect(frase).not.toContain('caller');
    for (const passageiro of ['limite', 'transitorio', 'circuito_aberto'] as const) expect(recusaDoPerfil(erro(passageiro, 429))).toBeNull();
    expect(recusaDoPerfil(new Error('defeito nosso'))).toBeNull();
  });
});

describe('avaliacao_responder: o estado e a versão (A6-4)', () => {
  it('o estado não leva o texto da avaliação nem nada de quem avaliou: só o resumo criptográfico do texto', () => {
    const e = estado();
    expect(e).toEqual({
      tipo: 'avaliacao',
      id: ID,
      google_id: NO_GOOGLE,
      existe: true,
      estrelas: 5,
      feita_em: '2026-10-10T20:14:00.000Z',
      mudou_em: '2026-10-10T20:14:00.000Z',
      texto_resumo: expect.stringMatching(/^[0-9a-f]{64}$/),
      resposta: null,
    });
    expect(JSON.stringify(e)).not.toContain('smash');
    expect(estado({ texto: null }).texto_resumo).toBeNull();
    // A avaliação que o Google diz não existir mais.
    expect(estadoDaAvaliacao({ id: ID, googleId: NO_GOOGLE }, null)).toMatchObject({ existe: false, estrelas: null, texto_resumo: null, resposta: null });
    // A resposta é texto da própria empresa: vai no estado.
    expect(estado({ resposta: { texto: 'Obrigado!', atualizadaEm: null, situacao: 'recusada', violacao: 'CODIGO_DE_EXEMPLO' } }).resposta).toEqual({ situacao: 'recusada', texto: 'Obrigado!', violacao: 'CODIGO_DE_EXEMPLO' });
  });

  it('a versão muda quando a avaliação muda, some ou ganha resposta; fica igual quando nada mudou; nunca é zero', () => {
    const base = versaoDaAvaliacao(estado());
    expect(base).toBeGreaterThan(0);
    expect(Number.isInteger(base) && base <= 2_147_483_647).toBe(true);
    expect(versaoDaAvaliacao(estado())).toBe(base);
    const outras = [
      estado({ estrelas: 4 }),
      estado({ texto: 'Melhor smash da região! A entrega foi rápida. Editei.' }),
      estado({ texto: null }),
      estado({ atualizadaEm: '2026-10-11T08:00:00.000Z' }),
      estado({ resposta: { texto: 'Obrigado!', atualizadaEm: null, situacao: 'pendente', violacao: null } }),
      estado({ resposta: { texto: 'Obrigado!', atualizadaEm: null, situacao: 'aprovada', violacao: null } }),
      estadoDaAvaliacao({ id: ID, googleId: NO_GOOGLE }, null),
    ].map(versaoDaAvaliacao);
    for (const v of outras) expect(v).not.toBe(base);
    expect(new Set(outras).size).toBe(outras.length);
    // A data em que a RESPOSTA mudou não entra: o que conta é o texto e a situação dela.
    const comResposta = (atualizadaEm: string | null) => versaoDaAvaliacao(estado({ resposta: { texto: 'Obrigado!', atualizadaEm, situacao: 'aprovada', violacao: null } }));
    expect(comResposta('2026-10-11T12:00:00.000Z')).toBe(comResposta(null));
  });

  it('a resposta já está lá (a tentativa anterior caiu depois de o Google aceitar): não se manda de novo', () => {
    const plano = planoDaResposta(estado(), { texto: TEXTO });
    if (!plano.ok) throw new Error(plano.motivo);
    const comA = (texto: string, situacao: string) => estado({ resposta: { texto, atualizadaEm: null, situacao: situacao as 'pendente', violacao: null } });
    expect(respostaJaPublicada(comA(TEXTO, 'pendente'), plano.desejado)).toBe(true);
    expect(respostaJaPublicada(comA(TEXTO, 'aprovada'), plano.desejado)).toBe(true);
    expect(respostaJaPublicada(comA('Outro texto.', 'aprovada'), plano.desejado)).toBe(false);
    // A que o Google recusou não conta como publicada.
    expect(respostaJaPublicada(comA(TEXTO, 'recusada'), plano.desejado)).toBe(false);
    expect(respostaJaPublicada(estado(), plano.desejado)).toBe(false);
    expect(respostaJaPublicada(comA(TEXTO, 'pendente'), { tipo: 'mensagem' })).toBe(false);
  });
});

describe('avaliacao_responder: o plano e a conferência do texto (A6-3 e A6-5)', () => {
  it('3 a 5 estrelas: a ação comum; 1 ou 2: a de nota baixa, que só o dono decide', () => {
    const plano = tool.plan(estado(), { texto: `  ${TEXTO}  ` });
    expect(plano).toMatchObject({ action: ACAO_DA_RESPOSTA, budgetImpact: 'none', valueMicros: null, currentValueMicros: null, reserveMicros: 0, text: TEXTO });
    // O Google confere toda resposta antes de mostrar: ela nasce pendente, com o texto aparado.
    expect(plano.desiredState).toEqual({ ...estado(), resposta: { situacao: 'pendente', texto: TEXTO, violacao: null } });
    expect([5, 4, 3, 2, 1].map((n) => tool.plan(estado({ estrelas: n as 1 }), { texto: TEXTO }).action)).toEqual([ACAO_DA_RESPOSTA, ACAO_DA_RESPOSTA, ACAO_DA_RESPOSTA, ACAO_DA_RESPOSTA_DE_NOTA_BAIXA, ACAO_DA_RESPOSTA_DE_NOTA_BAIXA]);
    expect([5, 3, 2, 1].map((n) => tool.ownerOnly!(estado({ estrelas: n as 1 })))).toEqual([false, false, true, true]);
    expect(tool.ownerOnly!({ tipo: 'mensagem' })).toBe(false);
    // A resposta que o Google recusou pode ganhar outra.
    expect(tool.plan(estado({ resposta: { texto: 'Antiga.', atualizadaEm: null, situacao: 'recusada', violacao: null } }), { texto: TEXTO }).action).toBe(ACAO_DA_RESPOSTA);
  });

  it('o pedido que nem nasce: a avaliação sumiu, já tem resposta, ou o texto não serve', () => {
    expect(recusa(() => tool.plan({ tipo: 'mensagem' }, { texto: TEXTO }))).toContain('é para uma avaliação do perfil da empresa no Google');
    expect(recusa(() => tool.plan(estadoDaAvaliacao({ id: ID, googleId: NO_GOOGLE }, null), { texto: TEXTO }))).toContain('não está mais no Google');
    expect(recusa(() => tool.plan(estado({ resposta: { texto: 'Obrigado!', atualizadaEm: null, situacao: 'pendente', violacao: null } }), { texto: TEXTO }))).toContain('o Google está conferindo');
    expect(recusa(() => tool.plan(estado({ resposta: { texto: 'Obrigado!', atualizadaEm: null, situacao: 'aprovada', violacao: null } }), { texto: TEXTO }))).toContain('já tem resposta no Google');
    expect(recusa(() => tool.plan(estado({ resposta: { texto: 'Obrigado!', atualizadaEm: null, situacao: 'desconhecida', violacao: null } }), { texto: TEXTO }))).toContain('já tem resposta no Google');
    for (const texto of ['   ', 'x'.repeat(1501), '😀'.repeat(1100)]) expect(recusa(() => tool.plan(estado(), { texto })), `texto de ${texto.length}`).toContain('com até 1.500 caracteres');
    // No limite, passa inteiro.
    expect(tool.plan(estado(), { texto: 'x'.repeat(1500) }).text).toHaveLength(1500);
  });

  it('A6-5: o Compliance barra o que a regra da Liame barra em qualquer texto, o dado pessoal e a compensação prometida em público', () => {
    expect(problemasDaResposta(TEXTO)).toEqual([]);
    expect(problemasDaResposta('Vote em nós para vereador.')).toContain('conteúdo político ou eleitoral (regra da Liame)');
    expect(problemasDaResposta('Aqui o resultado garantido é a sua satisfação.')).toContain('promessa de resultado (regra da Liame)');
    expect(problemasDaResposta('Ligue para (21) 99999-0000 e resolvemos.')).toContain('dado pessoal no texto (e-mail, telefone ou documento)');
    for (const [texto, palavra] of [
      ['Na próxima visita você tem um desconto.', 'desconto'],
      ['Vamos mandar um BRINDE para você.', 'brinde'],
      ['Faremos o reembolso do pedido.', 'reembolso'],
      ['Vamos reembolsar o valor.', 'reembolsar'],
      ['A sobremesa fica de cortesia.', 'cortesia'],
    ] as const) {
      expect(problemasDaResposta(texto), texto).toEqual([`promessa de compensação em público (${palavra}): desconto, brinde e reembolso se combinam em particular`]);
    }
    // Palavra parecida não é compensação.
    expect(problemasDaResposta('Não vamos descontar a nossa falha em você: vamos melhorar a cortesia do atendimento? Não: a gentileza.')).toHaveLength(1);
    expect(problemasDaResposta('O garçom foi descontraído demais, e pedimos desculpas.')).toEqual([]);
    // O plano recusa com as palavras do problema, para a pessoa ajustar.
    expect(recusa(() => tool.plan(estado({ estrelas: 1 }), { texto: 'Pedimos desculpas. Faremos o reembolso.' }))).toBe(
      'O texto da resposta não passa assim. Ajuste e salve de novo: promessa de compensação em público (reembolso): desconto, brinde e reembolso se combinam em particular.',
    );
  });

  it('a resposta não cita o primeiro nome de quem avaliou; o nome é conferido e não fica em lugar nenhum', () => {
    expect([primeiroNome('Marina S.'), primeiroNome('  João  Pedro'), primeiroNome('Dr. Paulo R.'), primeiroNome('A. B.'), primeiroNome(''), primeiroNome(null)]).toEqual(['marina', 'joao', 'paulo', null, null, null]);
    expect(citaONome('Obrigado, Marina!', 'Marina S.')).toBe(true);
    expect(citaONome('obrigado MARINA', 'Marina S.')).toBe(true);
    expect(citaONome('Obrigado, João.', 'Joao Pedro')).toBe(true);
    // Palavra inteira: "Ana" não casa com "banana" nem com "semana".
    expect(citaONome('A banana da semana estava ótima.', 'Ana L.')).toBe(false);
    expect(citaONome('Obrigado, Ana.', 'Ana L.')).toBe(true);
    // O sobrenome não é conferido (é palavra comum de cardápio com frequência), e a anônima não tem nome.
    expect(citaONome('O leite condensado é da casa.', 'João Leite')).toBe(false);
    expect(citaONome('Obrigado pela visita!', null)).toBe(false);

    const comNome = recusa(() => tool.plan(estado(), { texto: 'Que bom, Marina! Volte sempre.' }, { quem: 'Marina S.' }));
    expect(comNome).toContain('o nome de quem avaliou: o Liame não guarda esse nome');
    // A recusa diz o problema sem repetir o nome.
    expect(comNome).not.toContain('Marina');
    const plano = tool.plan(estado(), { texto: TEXTO }, { quem: 'Marina S.' });
    expect(JSON.stringify(plano)).not.toContain('Marina');
    // Sem o contexto (a ferramenta chamada sem a leitura do nome), o resto da conferência vale igual.
    expect(tool.plan(estado(), { texto: 'Que bom, Marina! Volte sempre.' }).text).toBe('Que bom, Marina! Volte sempre.');
  });
});

describe('política da distribuição, versão 7: a resposta a uma avaliação (A6-3)', () => {
  const proposta = (action: string, extra: Partial<ActionProposal> = {}): ActionProposal => ({
    tool: 'avaliacao_responder',
    action,
    brand_id: null,
    provider: 'google_business',
    account_id: ID,
    risk_level: 'R2',
    budget_impact: 'none',
    value_micros: null,
    current_value_micros: null,
    categories: [],
    text: TEXTO,
    recent_count: 0,
    actor: 'human',
    ...extra,
  });

  it('sempre espera a aprovação de uma pessoa, peça quem pedir; a de nota baixa, só o dono', () => {
    expect(PLATFORM_POLICY.version).toBe(7);
    expect(chooseMode([PLATFORM_POLICY], proposta(ACAO_DA_RESPOSTA))).toEqual({ mode: 'APPROVAL', source: 'platform', version: 7 });
    expect(chooseMode([PLATFORM_POLICY], proposta(ACAO_DA_RESPOSTA, { actor: 'agent' })).mode).toBe('APPROVAL');
    expect(chooseMode([PLATFORM_POLICY], proposta(ACAO_DA_RESPOSTA_DE_NOTA_BAIXA))).toEqual({ mode: 'ESCALATE', source: 'platform', version: 7 });
    expect(chooseMode([PLATFORM_POLICY], proposta(ACAO_DA_RESPOSTA_DE_NOTA_BAIXA, { actor: 'agent' })).mode).toBe('ESCALATE');
  });

  it('a regra da empresa ou da marca que pede autonomia não tira o dono da resposta de nota baixa', () => {
    const daMarca: LoadedPolicy = { source: 'brand', version: 3, document: { rules: [{ type: 'autonomy', tool: 'avaliacao_responder', provider: 'google_business', mode: 'AUTO' }] } };
    expect(chooseMode([PLATFORM_POLICY, daMarca], proposta(ACAO_DA_RESPOSTA_DE_NOTA_BAIXA)).mode).toBe('ESCALATE');
    // Na resposta comum, a regra mais específica da marca vence a da distribuição; quem segura é a trava da ferramenta.
    expect(chooseMode([PLATFORM_POLICY, daMarca], proposta(ACAO_DA_RESPOSTA)).mode).toBe('AUTO');
    expect(tool.alwaysApproval).toBe(true);
  });

  it('as palavras que a empresa proíbe na política valem para o texto da resposta', () => {
    const daEmpresa: LoadedPolicy = { source: 'tenant', version: 1, document: { rules: [{ type: 'forbidden_words', words: ['gourmet'] }] } };
    const agora = { at: new Date('2026-10-11T15:00:00Z'), timezone: 'America/Sao_Paulo' };
    const negada = evaluatePolicy([PLATFORM_POLICY, daEmpresa], proposta(ACAO_DA_RESPOSTA, { text: 'O nosso hambúrguer GOURMET agradece.' }), agora);
    expect(negada).toMatchObject({ allowed: false, violations: [{ source: 'tenant', type: 'forbidden_words', message: 'Texto com termo proibido: gourmet.' }] });
    expect(evaluatePolicy([PLATFORM_POLICY, daEmpresa], proposta(ACAO_DA_RESPOSTA), agora)).toMatchObject({ allowed: true, mode: 'APPROVAL', versions: ['plataforma@7', 'empresa@1'] });
  });
});
