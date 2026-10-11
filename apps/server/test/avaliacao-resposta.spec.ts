import type { ActionProposal } from '@liame/contracts';
import { describe, expect, it } from 'vitest';
import {
  ACAO_DA_RESPOSTA,
  ACAO_DA_RESPOSTA_DE_NOTA_BAIXA,
  ACAO_DE_APAGAR_A_RESPOSTA,
  citaONome,
  type EstadoDaAvaliacao,
  estadoDaAvaliacao,
  planoDaResposta,
  primeiroNome,
  problemasDaResposta,
  respostaJaApagada,
  respostaJaPublicada,
  resumoDoTexto,
  textoComparavel,
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
// Parte c: a volta (`avaliacao_apagar_resposta`, direta para a pessoa e só como volta; política v8) e a versão que não
// muda com a conferência do Google nem com a data de mudança da avaliação.

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
  it('a ferramenta: só no perfil do Google, sempre com uma pessoa, sem parâmetro que ela não conhece, e a volta é apagar a resposta', () => {
    expect(tool).toMatchObject({ name: 'avaliacao_responder', version: 1, owner: 'social', risk: 'R2', providers: ['google_business'], compensation: 'apagar_a_resposta', alwaysApproval: true });
    expect(tool.undo!(estado())).toEqual({ tool: 'avaliacao_apagar_resposta', params: {} });
    expect(tool.onlyAsUndo).toBeUndefined();
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
    for (const frase of [erro('permissao', 403), erro('definitivo', 400)].map((e) => recusaDoPerfil(e))) expect(frase).not.toContain('caller');
    for (const passageiro of ['limite', 'transitorio', 'circuito_aberto'] as const) expect(recusaDoPerfil(erro(passageiro, 429))).toBeNull();
    expect(recusaDoPerfil(new Error('defeito nosso'))).toBeNull();
    // Ao apagar, a frase diz o que não aconteceu com a resposta; a avaliação que sumiu levou a resposta junto.
    expect(recusaDoPerfil(erro('autenticacao', 401), 'apagar')).toBe('O Google recusou a autorização desta loja. Conecte o Google de novo em Contas conectadas. A resposta continua no perfil.');
    expect(recusaDoPerfil(erro('definitivo', 400), 'apagar')).toBe('O Google não deixou apagar a resposta. A resposta continua no perfil.');
    expect(recusaDoPerfil(erro('definitivo', 404), 'apagar')).toBe('Esta avaliação não está mais no Google: quem escreveu apagou, ou o Google tirou.');
    for (const passageiro of ['limite', 'transitorio'] as const) expect(recusaDoPerfil(erro(passageiro, 503), 'apagar')).toBeNull();
  });

  it('apagar a resposta: só como a volta de uma resposta publicada, direto para a pessoa, e sem volta', () => {
    const apagar = TOOLS.avaliacao_apagar_resposta!;
    expect(apagar).toMatchObject({ name: 'avaliacao_apagar_resposta', version: 1, owner: 'social', risk: 'R1', providers: ['google_business'], compensation: 'sem_volta_pelo_liame', directByPerson: true, onlyAsUndo: true });
    expect(apagar.undo).toBeUndefined();
    expect(apagar.alwaysApproval).toBeUndefined();
    expect(apagar.ownerOnly).toBeUndefined();
    expect(apagar.params.safeParse({}).success).toBe(true);
    expect(apagar.params.safeParse({ texto: TEXTO }).success).toBe(false);
    // Só as duas ferramentas de avaliação existem neste provedor, e só a de apagar nasce como volta.
    expect(Object.values(TOOLS).filter((t) => t.providers.includes('google_business')).map((t) => t.name)).toEqual(['avaliacao_responder', 'avaliacao_apagar_resposta']);
    expect(Object.values(TOOLS).filter((t) => t.onlyAsUndo).map((t) => t.name)).toEqual(['avaliacao_apagar_resposta']);

    const publicada = estado({ resposta: { texto: TEXTO, atualizadaEm: null, situacao: 'aprovada', violacao: null } });
    const plano = apagar.plan(publicada, {});
    expect(plano).toMatchObject({ action: ACAO_DE_APAGAR_A_RESPOSTA, budgetImpact: 'none', valueMicros: null, currentValueMicros: null, reserveMicros: 0 });
    expect(plano.desiredState).toEqual({ ...publicada, resposta: null });
    // Apagar não publica texto: nada vai para as palavras proibidas da política.
    expect(plano.text).toBeUndefined();
    expect(recusa(() => apagar.plan(estado(), {}))).toBe('Esta avaliação não tem resposta no Google: não há o que apagar.');
    expect(recusa(() => apagar.plan(estadoDaAvaliacao({ id: ID, googleId: NO_GOOGLE }, null), {}))).toContain('A resposta saiu junto');
    expect(recusa(() => apagar.plan({ tipo: 'mensagem' }, {}))).toContain('é para uma avaliação do perfil da empresa no Google');

    // A resposta já saiu (a tentativa anterior caiu depois de o Google aceitar): não se manda de novo.
    expect(respostaJaApagada(estado(), plano.desiredState)).toBe(true);
    expect(respostaJaApagada(publicada, plano.desiredState)).toBe(false);
    expect(respostaJaApagada(estadoDaAvaliacao({ id: ID, googleId: NO_GOOGLE }, null), plano.desiredState)).toBe(false);
    // O pedido de publicar nunca é lido como "já apagada".
    const dePublicar = planoDaResposta(estado(), { texto: TEXTO });
    if (!dePublicar.ok) throw new Error(dePublicar.motivo);
    expect(respostaJaApagada(estado(), dePublicar.desejado)).toBe(false);
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
    const resposta = (texto: string, situacao: 'pendente' | 'aprovada' | 'recusada' | 'desconhecida', atualizadaEm: string | null = null) => estado({ resposta: { texto, atualizadaEm, situacao, violacao: null } });
    const outras = [
      estado({ estrelas: 4 }),
      estado({ texto: 'Melhor smash da região! A entrega foi rápida. Editei.' }),
      estado({ texto: null }),
      resposta('Obrigado!', 'pendente'),
      resposta('Obrigado mesmo!', 'pendente'),
      resposta('Obrigado!', 'recusada'),
      estadoDaAvaliacao({ id: ID, googleId: NO_GOOGLE }, null),
    ].map(versaoDaAvaliacao);
    for (const v of outras) expect(v).not.toBe(base);
    expect(new Set(outras).size).toBe(outras.length);
    // A data de mudança da AVALIAÇÃO não entra: a referência do Google não diz se responder mexe nela (pior caso: mexe).
    expect(versaoDaAvaliacao(estado({ atualizadaEm: '2026-10-11T08:00:00.000Z' }))).toBe(base);
    // A conferência do Google (de pendente a aprovada) e a data da resposta não mudam a versão: a resposta publicada
    // continua podendo ser apagada depois que ele a libera.
    const publicada = versaoDaAvaliacao(resposta('Obrigado!', 'pendente'));
    expect(versaoDaAvaliacao(resposta('Obrigado!', 'aprovada', '2026-10-11T12:00:00.000Z'))).toBe(publicada);
    expect(versaoDaAvaliacao(resposta('Obrigado!', 'desconhecida'))).toBe(publicada);
    // O Google devolvendo o texto com os espaços ou a forma das letras acertados ([NC]): é a mesma resposta.
    expect(versaoDaAvaliacao(resposta('  Obrigado!\n', 'aprovada'))).toBe(publicada);
    expect(textoComparavel('  Que  bom!\n\nVolte\tsempre. ')).toBe('Que bom! Volte sempre.');
    expect(textoComparavel('Café da manhã')).toBe('Café da manhã');
    expect(textoComparavel('')).toBe('');
    // O resumo do texto da avaliação sai do texto como o Liame o guarda: os dois lados se comparam.
    expect(resumoDoTexto('  Bom\u0000 demais  ')).toBe(resumoDoTexto('Bom demais'));
    expect(resumoDoTexto('Bom demais')).not.toBe(resumoDoTexto('Bom demais!'));
    expect([resumoDoTexto(null), resumoDoTexto('   ')]).toEqual([null, null]);
  });

  it('a resposta já está lá (a tentativa anterior caiu depois de o Google aceitar): não se manda de novo', () => {
    const plano = planoDaResposta(estado(), { texto: TEXTO });
    if (!plano.ok) throw new Error(plano.motivo);
    const comA = (texto: string, situacao: string) => estado({ resposta: { texto, atualizadaEm: null, situacao: situacao as 'pendente', violacao: null } });
    expect(respostaJaPublicada(comA(TEXTO, 'pendente'), plano.desejado)).toBe(true);
    expect(respostaJaPublicada(comA(TEXTO, 'aprovada'), plano.desejado)).toBe(true);
    // O Google devolvendo o mesmo texto com os espaços acertados: é a resposta que o Liame mandou.
    expect(respostaJaPublicada(comA(` ${TEXTO.replace(', ', ',  ')}\n`, 'aprovada'), plano.desejado)).toBe(true);
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

describe('política da distribuição, versões 7 e 8: a resposta a uma avaliação (A6-3) e apagar a resposta', () => {
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
    expect(PLATFORM_POLICY.version).toBe(8);
    expect(chooseMode([PLATFORM_POLICY], proposta(ACAO_DA_RESPOSTA))).toEqual({ mode: 'APPROVAL', source: 'platform', version: 8 });
    expect(chooseMode([PLATFORM_POLICY], proposta(ACAO_DA_RESPOSTA, { actor: 'agent' })).mode).toBe('APPROVAL');
    expect(chooseMode([PLATFORM_POLICY], proposta(ACAO_DA_RESPOSTA_DE_NOTA_BAIXA))).toEqual({ mode: 'ESCALATE', source: 'platform', version: 8 });
    expect(chooseMode([PLATFORM_POLICY], proposta(ACAO_DA_RESPOSTA_DE_NOTA_BAIXA, { actor: 'agent' })).mode).toBe('ESCALATE');
  });

  it('versão 8: apagar a resposta é direto para uma pessoa; o funcionário de IA segue esperando a aprovação', () => {
    const apagar = (extra: Partial<ActionProposal> = {}) => proposta(ACAO_DE_APAGAR_A_RESPOSTA, { tool: 'avaliacao_apagar_resposta', risk_level: 'R1', text: null, ...extra });
    expect(chooseMode([PLATFORM_POLICY], apagar())).toEqual({ mode: 'AUTO', source: 'platform', version: 8 });
    expect(chooseMode([PLATFORM_POLICY], apagar({ actor: 'agent' })).mode).toBe('APPROVAL');
    // A regra é só de apagar: responder continua esperando a aprovação, peça quem pedir.
    expect(chooseMode([PLATFORM_POLICY], proposta(ACAO_DA_RESPOSTA)).mode).toBe('APPROVAL');
    // A empresa que quer aprovar também o apagar publica a regra dela, e ela vence a da distribuição.
    const daEmpresa: LoadedPolicy = { source: 'tenant', version: 2, document: { rules: [{ type: 'autonomy', action: ACAO_DE_APAGAR_A_RESPOSTA, actor: 'human', mode: 'APPROVAL' }] } };
    expect(chooseMode([PLATFORM_POLICY, daEmpresa], apagar()).mode).toBe('APPROVAL');
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
    expect(evaluatePolicy([PLATFORM_POLICY, daEmpresa], proposta(ACAO_DA_RESPOSTA), agora)).toMatchObject({ allowed: true, mode: 'APPROVAL', versions: ['plataforma@8', 'empresa@1'] });
  });
});
