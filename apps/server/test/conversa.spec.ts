import { describe, expect, it } from 'vitest';
import type { ConversationMessage } from '@liame/contracts';
import { indiceDasOrigens, marcarResposta } from '../src/ai/conversa/fontes.js';
import { foraDoDia, nomesDaLeitura, rotuloDaLeitura, rotuloDoPasso } from '../src/ai/conversa/leituras.js';
import { LIA, PROMPT_CONVERSA_LIA } from '../src/ai/conversa/prompt.js';
import { conferirResposta, type PermitidosNaConversa, respostaComoTexto, type RespostaDaLia } from '../src/ai/conversa/resposta.js';
import { conferirRegistro, registroAtual } from '../src/ai/registro/definicoes.js';
import { A_SEMANA, contextoDoPedido, contextoPermitido, historicoParaOModelo, querFalarComPessoa } from '../src/conversa/conversa.service.js';

// Conversa com a LIA (A3, I10): o que o código decide sem modelo nenhum. A conferência da resposta (números,
// dado velho, Compliance, formato), a fonte de cada número, os passos que a tela mostra, o pedido de falar com
// uma pessoa, o histórico que volta ao modelo e o contexto do pedido.

const CICLO = {
  periodo: { de: '25/09/2026', ate: '01/10/2026', fuso_da_loja: 'America/Sao_Paulo' },
  totais: { investimento: 'R$ 1.250,00', com_origem_provada: { pedidos: '38', receita: 'R$ 3.605,00', roas: '2,88' } },
  campanhas: [
    { plataforma: 'Meta', campanha: 'Combo sexta', caixa_confirma: { pedidos: '12', receita: 'R$ 960,00' } },
    { plataforma: 'Meta', campanha: 'Delivery noite 2', caixa_confirma: { pedidos: '3', receita: 'R$ 120,00' } },
  ],
  fontes: [{ plataforma: 'Regem', conta: 'Loja Centro', frescor: 'em dia', ultima_leitura: '02/10/2026 14:05' }],
};
const CICLO_VELHO = { ...CICLO, totais: { investimento: 'R$ 777,00' }, fontes: [{ plataforma: 'Regem', conta: 'Loja Centro', frescor: 'parado', ultima_leitura: '01/10/2026 09:42' }] };

const resposta = (...blocos: Array<[RespostaDaLia['blocos'][number]['tipo'], string, ('baixo' | 'medio' | 'alto')?]>): RespostaDaLia => ({
  blocos: blocos.map(([tipo, texto, risco]) => ({ tipo, texto, risco: risco ?? null })),
});
const permitidos = (extra: Partial<PermitidosNaConversa> = {}): PermitidosNaConversa => ({
  emDia: [CICLO, 'Como foi a semana?', A_SEMANA],
  velhas: [],
  nomes: ['Combo sexta', 'Delivery noite 2', 'Loja Centro'],
  ...extra,
});

describe('conferência da resposta da LIA (A3-5, I9, I8)', () => {
  it('número que está no que ela leu passa; número inventado derruba a resposta inteira', () => {
    const boa = resposta(['paragrafo', 'Nos 7 dias até 01/10/2026, o caixa confirmou 38 pedidos e R$ 3.605,00: o ROAS confirmado foi 2,88.'], ['item', 'A Combo sexta trouxe 12 pedidos.']);
    expect(conferirResposta(boa, permitidos())).toBeNull();
    const ruim = resposta(['paragrafo', 'O caixa confirmou 41 pedidos.']);
    expect(conferirResposta(ruim, permitidos())).toEqual({ recusa: 'numero_fora', detalhe: ['41'] });
  });

  it('número de nome de campanha não é invenção, e a conta feita pela IA é', () => {
    expect(conferirResposta(resposta(['paragrafo', 'A Delivery noite 2 teve 3 pedidos.']), permitidos())).toBeNull();
    // 38 − 12 = 26: a IA não calcula.
    expect(conferirResposta(resposta(['paragrafo', 'Sem a Combo sexta, sobram 26 pedidos.']), permitidos())).toEqual({ recusa: 'numero_fora', detalhe: ['26'] });
  });

  it('número de uma leitura com fonte fora do dia é `dado_velho`; inventado continua `numero_fora`', () => {
    const p = permitidos({ emDia: ['Como foi a semana?'], velhas: [CICLO_VELHO] });
    expect(conferirResposta(resposta(['paragrafo', 'O investimento foi de R$ 777,00.']), p)?.recusa).toBe('dado_velho');
    expect(conferirResposta(resposta(['paragrafo', 'O investimento foi de R$ 778,00.']), p)?.recusa).toBe('numero_fora');
    // Sem número, a resposta passa: a LIA pode dizer em palavras que a fonte está atrasada.
    expect(conferirResposta(resposta(['paragrafo', 'Os pedidos do Regem estão parados; a análise espera a próxima leitura.']), p)).toBeNull();
  });

  it('número que a pessoa escreveu pode voltar na resposta', () => {
    expect(conferirResposta(resposta(['paragrafo', 'Uma promoção de 15% na sexta-feira fica registrada como demanda.']), permitidos({ emDia: ['Quero uma promoção de 15% na sexta'] }))).toBeNull();
  });

  it('formato: risco só no bloco de risco, no máximo um; resposta vazia ou longa demais não aparece', () => {
    expect(conferirResposta(resposta(['risco', 'a semana empata.']), permitidos())?.recusa).toBe('formato');
    expect(conferirResposta({ blocos: [{ tipo: 'paragrafo', texto: 'Ok.', risco: 'alto' }] }, permitidos())?.recusa).toBe('formato');
    expect(conferirResposta(resposta(['risco', 'a.', 'alto'], ['risco', 'b.', 'baixo']), permitidos())?.recusa).toBe('formato');
    expect(conferirResposta(resposta(), permitidos())?.recusa).toBe('vazia');
    expect(conferirResposta(resposta(['paragrafo', ' ']), permitidos())?.recusa).toBe('vazia');
    expect(conferirResposta(resposta(...Array.from({ length: 9 }, () => ['item', 'Um ponto.'] as ['item', string])), permitidos())?.recusa).toBe('longa');
    expect(conferirResposta(resposta(['paragrafo', 'a'.repeat(701)]), permitidos())?.recusa).toBe('longa');
  });

  it('link, "a IA decidiu", política, promessa de resultado e o que a marca não diz derrubam a resposta', () => {
    expect(conferirResposta(resposta(['fazer', 'Veja em https://exemplo.com.']), permitidos())?.recusa).toBe('trecho_proibido');
    expect(conferirResposta(resposta(['paragrafo', 'A IA decidiu pausar.']), permitidos())?.recusa).toBe('trecho_proibido');
    expect(conferirResposta(resposta(['paragrafo', 'Vote em quem apoia o comércio local.']), permitidos())?.recusa).toBe('compliance');
    expect(conferirResposta(resposta(['paragrafo', 'Com o cupom, o lucro certo vem.']), permitidos())?.recusa).toBe('compliance');
    expect(conferirResposta(resposta(['paragrafo', 'O hambúrguer gourmet vende bem.']), permitidos({ daMarca: ['gourmet'] }))?.recusa).toBe('compliance');
  });

  it('o histórico volta ao modelo como texto, com o risco e o que fazer marcados', () => {
    expect(respostaComoTexto([
      { tipo: 'paragrafo', texto: 'A semana empatou.', risco: null },
      { tipo: 'item', texto: 'Combo sexta deu lucro.', risco: null },
      { tipo: 'risco', texto: 'a margem fica perto do investido.', risco: 'medio' },
      { tipo: 'fazer', texto: 'Cadastre o custo dos itens.', risco: null },
    ])).toBe('A semana empatou.\n- Combo sexta deu lucro.\nRisco medio: a margem fica perto do investido.\nO que fazer: Cadastre o custo dos itens.');
  });
});

describe('de onde vem cada número (P5: "De onde vêm os números")', () => {
  const lugares = indiceDasOrigens([
    { rotulo: 'Resultados de 25/09 a 01/10', valor: CICLO, comCaminho: true, ordem: 1 },
    { rotulo: 'Você, nesta conversa', valor: ['Quero uma promoção de 15% na sexta'], comCaminho: false, ordem: 2 },
  ]);
  const nomes = ['Combo sexta', 'Delivery noite 2'];

  it('o número da leitura leva o caminho em palavras, com o nome da campanha', () => {
    const { blocks, numbers } = marcarResposta(resposta(['item', 'A Combo sexta trouxe R$ 960,00 em 12 pedidos.']), lugares, nomes);
    expect(numbers).toEqual([
      { value: 'R$ 960,00', sources: ['Resultados de 25/09 a 01/10 · campanha "Combo sexta" · confirmado no caixa · receita'] },
      { value: '12', sources: ['Resultados de 25/09 a 01/10 · campanha "Combo sexta" · confirmado no caixa · pedidos'] },
    ]);
    expect(blocks).toEqual([
      {
        kind: 'item',
        risk: null,
        text: [
          { text: 'A Combo sexta trouxe ', number: null },
          { text: 'R$ 960,00', number: 0 },
          { text: ' em ', number: null },
          { text: '12', number: 1 },
          { text: ' pedidos.', number: null },
        ],
      },
    ]);
  });

  it('número dentro de nome de campanha fica como texto; o da pessoa leva "Você, nesta conversa"', () => {
    const { blocks, numbers } = marcarResposta(resposta(['paragrafo', 'A Delivery noite 2 entra na promoção de 15%.']), lugares, nomes);
    expect(numbers).toEqual([{ value: '15%', sources: ['Você, nesta conversa'] }]);
    expect(blocks[0]!.text.filter((t) => t.number !== null).map((t) => t.text)).toEqual(['15%']);
  });

  it('V58: com valores repetidos, a frase que cita uma campanha leva a fonte dela; a que não cita, a do total', () => {
    const repetido = {
      totais: { com_origem_provada: { pedidos: '12' } },
      campanhas: [
        { campanha: 'Combo sexta', caixa_confirma: { pedidos: '12' } },
        { campanha: 'Almoço executivo', caixa_confirma: { pedidos: '12' } },
      ],
    };
    const l = indiceDasOrigens([{ rotulo: 'Resultados', valor: repetido, comCaminho: true, ordem: 1 }]);
    const dela = ['Combo sexta', 'Almoço executivo'];
    expect(marcarResposta(resposta(['item', 'A Combo sexta trouxe 12 pedidos.']), l, dela).numbers).toEqual([
      { value: '12', sources: ['Resultados · campanha "Combo sexta" · confirmado no caixa · pedidos'] },
    ]);
    expect(marcarResposta(resposta(['paragrafo', 'No total, foram 12 pedidos.']), l, dela).numbers).toEqual([
      { value: '12', sources: ['Resultados · totais · com origem provada · pedidos'] },
    ]);
    // Na mesma resposta, os dois "12" são duas linhas: cada um com o sujeito da sua frase.
    expect(marcarResposta(resposta(['paragrafo', 'No total, foram 12 pedidos.'], ['item', 'O Almoço executivo também trouxe 12.']), l, dela).numbers.map((n) => n.sources[0])).toEqual([
      'Resultados · totais · com origem provada · pedidos',
      'Resultados · campanha "Almoço executivo" · confirmado no caixa · pedidos',
    ]);
  });

  it('o mesmo valor com a mesma fonte, escrito duas vezes, é uma linha só; o bloco de risco leva o nível', () => {
    const { blocks, numbers } = marcarResposta(resposta(['paragrafo', 'Foram 38 pedidos.'], ['risco', 'com 38 pedidos, a amostra é pequena.', 'medio']), lugares, nomes);
    expect(numbers).toHaveLength(1);
    expect(blocks.map((b) => [b.kind, b.risk])).toEqual([['paragrafo', null], ['risco', 'medio']]);
  });
});

describe('o que a tela mostra de cada leitura (P5)', () => {
  it('o passo e a lista "A LIA leu", com o período dos parâmetros', () => {
    expect(rotuloDoPasso('resultados_ciclo_fechado', { brand_id: 'x', from: '2026-09-25', to: '2026-10-01' })).toBe('Lendo os resultados de 25/09 a 01/10');
    expect(rotuloDaLeitura('resultados_ciclo_fechado', { from: '2026-09-25', to: '2026-10-01' })).toBe('Resultados de 25/09 a 01/10');
    expect(rotuloDoPasso('midia_entrega', { from: 'quebrado', to: '2026-10-01' })).toBe('Lendo a entrega dos anúncios');
    expect(rotuloDoPasso('fontes_frescor', {})).toBe('Conferindo se as fontes estão em dia');
    expect(rotuloDoPasso('abrir_demanda', {})).toBe('Registrando a demanda');
    expect(rotuloDaLeitura('abrir_demanda', {})).toBeNull();
    expect(rotuloDoPasso('outra_coisa', {})).toBe('Lendo os dados');
  });

  it('fontes fora do dia, pela própria leitura (resultados e cupons); nomes da empresa', () => {
    expect(foraDoDia('resultados_ciclo_fechado', CICLO)).toEqual([]);
    expect(foraDoDia('resultados_ciclo_fechado', CICLO_VELHO)).toEqual([{ platform: 'Regem', name: 'Loja Centro', freshness: 'parado', last_read: '01/10/2026 09:42' }]);
    expect(foraDoDia('cupons_campanha', { lojas: [{ loja: 'Loja Praia', leitura_dos_cupons: 'atrasado' }, { loja: 'Centro', leitura_dos_cupons: 'em dia' }] })).toEqual([
      { platform: 'Regem', name: 'Loja Praia', freshness: 'atrasado', last_read: null },
    ]);
    expect(foraDoDia('atencao_avisos', { avisos: [] })).toEqual([]);
    expect(nomesDaLeitura(CICLO).sort()).toEqual(['Combo sexta', 'Delivery noite 2', 'Loja Centro']);
  });
});

describe('o que se decide por regra e o que volta ao modelo', () => {
  it('pedir para falar com uma pessoa não chama a IA', () => {
    for (const t of ['Quero falar com uma pessoa.', 'Posso conversar com um atendente?', 'como falo com o suporte', 'Preciso de contato com alguém da Liame']) expect(querFalarComPessoa(t)).toBe(true);
    for (const t of ['Quantas pessoas compraram?', 'Fale sobre a semana', 'A pessoa do balcão usou o cupom?']) expect(querFalarComPessoa(t)).toBe(false);
  });

  it('o histórico começa pela pessoa e não leva aviso do sistema nem resposta parada', () => {
    const m = (role: string, extra: Partial<ConversationMessage> = {}): ConversationMessage => ({
      id: '00000000-0000-7000-8000-000000000000', role, created_at: '', status: 'ok', text: null, removed_personal_data: null, blocks: [], numbers: [], read: [], cards: [],
      economy: false, usage_id: null, notice: null, contact: null, retry_at: null, budget_window: null, stale_sources: [], ...extra,
    });
    const lia = (texto: string, status = 'ok') => m('lia', { status, blocks: [{ kind: 'paragrafo', risk: null, text: [{ text: texto, number: null }] }] });
    expect(
      historicoParaOModelo([lia('Sobrou do começo.'), m('pessoa', { text: 'Como foi a semana?' }), lia('Empatou.'), m('pessoa', { text: 'Vote em mim' }), m('sistema', { notice: 'politico' }), m('pessoa', { text: 'E ontem?' }), lia('', 'parada')]),
    ).toEqual([
      { role: 'user', content: 'Como foi a semana?' },
      { role: 'assistant', content: 'Empatou.' },
      { role: 'user', content: 'Vote em mim' },
      { role: 'user', content: 'E ontem?' },
    ]);
  });

  it('o contexto diz o dia (com o da semana), a semana fechada, os próximos dias e o brand_id', () => {
    const c = contextoDoPedido({
      hoje: '2026-10-02',
      marca: { id: '0192f1d4-3c1a-7b2e-9a10-5f1e2d3c4b5a', nome: 'Mister Burgers', fuso: 'America/Sao_Paulo' },
      quem: { tenantId: 't', userId: 'u', name: 'Ana', roleKey: 'dono', permissions: new Set() },
      dossie: null,
    });
    expect(c).toContain('Hoje é sexta-feira, 02/10/2026');
    expect(c).toContain('de 25/09/2026 a 01/10/2026 (nas ferramentas, from=2026-09-25 e to=2026-10-01)');
    expect(c).toContain('sexta-feira 09/10/2026 (2026-10-09)');
    expect(c).toContain('brand_id 0192f1d4-3c1a-7b2e-9a10-5f1e2d3c4b5a');
    expect(c).toContain('Quem pergunta: Dono da empresa.');
    // Nome de pessoa da equipe não vai ao modelo (D-A3-4).
    expect(c).not.toContain('Ana');
    // O que vale como fonte de número além das leituras: as datas do calendário (não o brand_id nem as datas
    // ISO, que o modelo não deve escrever), a semana e o dossiê.
    const fixo = contextoPermitido({ hoje: '2026-10-02', marca: { id: 'x', nome: 'Mister Burgers', fuso: 'America/Sao_Paulo' }, dossie: 'MARCA: Mister Burgers\nDESDE: 2019' });
    expect(fixo.datas).toEqual(expect.arrayContaining(['25/09/2026', '01/10/2026', '02/10/2026', '16/10/2026']));
    expect(JSON.stringify(fixo)).not.toContain('2026-10');
    expect(fixo.dossie).toContain('2019');
  });
});

describe('a LIA no registro (I2)', () => {
  it('prompt e funcionário registrados, com as seis leituras e a demanda', () => {
    expect(conferirRegistro(registroAtual())).toEqual([]);
    expect(PROMPT_CONVERSA_LIA.task).toBe('conversa_lia');
    expect(LIA.ferramentas).toEqual(['fontes_frescor', 'atencao_avisos', 'resultados_ciclo_fechado', 'midia_entrega', 'cupons_campanha', 'links_rastreio', 'abrir_demanda']);
    // Ela se apresenta como assistente de IA e oferece falar com uma pessoa (D-A3-6).
    expect(PROMPT_CONVERSA_LIA.content).toContain('assistente de inteligência artificial');
    expect(PROMPT_CONVERSA_LIA.content).toContain('Falar com uma pessoa');
  });
});
