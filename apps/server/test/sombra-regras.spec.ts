import { describe, expect, it } from 'vitest';
import { VARIACAO_MAXIMA_DA_VERBA_PCT } from '../src/policy/engine.js';
import {
  acaoHumana,
  arrependimento,
  type CampanhaNaJanela,
  concordancia,
  confianca,
  type DecisaoAvaliada,
  LIMIARES_SOMBRA,
  PORTOES,
  prontidao,
  recomendar,
  REGRAS_VERSAO,
} from '../src/sombra/regras.js';

// A3 · I5, sem banco: as regras da sombra, a leitura do que a pessoa fez e a conta do arrependimento.

const R = (reais: number) => BigInt(Math.round(reais * 100)) * 10_000n;
const campanha = (over: Partial<CampanhaNaJanela> = {}): CampanhaNaJanela => ({
  status: 'ativa',
  dailyBudgetMicros: R(30),
  spendMicros: R(200),
  orders: 5,
  revenueMicros: R(300),
  marginKnownMicros: R(60),
  marginCoveragePorMil: 1000,
  verdict: 'prejuizo',
  ...over,
});

describe('sombra: o que o Liame recomendaria (A3, I5)', () => {
  it('prejuízo forte (margem abaixo da metade do investimento) recomenda pausar', () => {
    expect(recomendar(campanha())).toEqual({ tool: 'campanha_pausar', rule: 'prejuizo_forte', ruleVersion: REGRAS_VERSAO, percent: null, confidencePorMil: 1000 });
    // Pausar não depende de a verba estar na campanha.
    expect(recomendar(campanha({ dailyBudgetMicros: null }))?.tool).toBe('campanha_pausar');
  });

  it('prejuízo moderado recomenda reduzir a verba em 10% (o limite por pedido), e só com a verba na campanha', () => {
    const moderado = campanha({ marginKnownMicros: R(150) });
    expect(recomendar(moderado)).toMatchObject({ tool: 'orcamento_reduzir', rule: 'prejuizo', percent: LIMIARES_SOMBRA.passoDaVerba });
    expect(recomendar({ ...moderado, dailyBudgetMicros: null })).toBeNull();
  });

  it('lucro folgado com a verba no limite recomenda aumentar 10%; lucro com verba sobrando, nada', () => {
    const lucro = campanha({ verdict: 'lucro', marginKnownMicros: R(320), spendMicros: R(200), dailyBudgetMicros: R(30) });
    expect(recomendar(lucro)).toMatchObject({ tool: 'orcamento_aumentar', rule: 'lucro_no_limite', percent: 10 });
    // O passo é o limite por pedido da política: a recomendação cabe no pedido que ela vira.
    expect(LIMIARES_SOMBRA.passoDaVerba).toBe(VARIACAO_MAXIMA_DA_VERBA_PCT);
    expect(REGRAS_VERSAO).toBe(2);
    // Gastou R$ 200 de R$ 420 possíveis: não está no limite.
    expect(recomendar({ ...lucro, dailyBudgetMicros: R(60) })).toBeNull();
    // Margem de 1,2 vez o investimento: lucro, mas não folgado.
    expect(recomendar({ ...lucro, marginKnownMicros: R(240) })).toBeNull();
    expect(recomendar({ ...lucro, dailyBudgetMicros: null })).toBeNull();
  });

  it('sem veredito, parada, empatando ou com pouco gasto: não recomenda', () => {
    expect(recomendar(campanha({ verdict: null }))).toBeNull();
    expect(recomendar(campanha({ marginKnownMicros: null }))).toBeNull();
    expect(recomendar(campanha({ status: 'pausada' }))).toBeNull();
    expect(recomendar(campanha({ verdict: 'empata', marginKnownMicros: R(200) }))).toBeNull();
    expect(recomendar(campanha({ spendMicros: R(49.99) }))).toBeNull();
    expect(recomendar(campanha({ spendMicros: R(50), marginKnownMicros: R(10) }))?.tool).toBe('campanha_pausar');
  });

  it('a confiança vai de 0,4 a 1 e cresce com o gasto observado e com a margem conhecida', () => {
    expect(confianca({ spendMicros: R(50), marginCoveragePorMil: 800 })).toBe(475);
    expect(confianca({ spendMicros: R(100), marginCoveragePorMil: 900 })).toBe(700);
    expect(confianca({ spendMicros: R(200), marginCoveragePorMil: 1000 })).toBe(1000);
    expect(confianca({ spendMicros: R(5000), marginCoveragePorMil: 1000 })).toBe(1000);
    expect(confianca({ spendMicros: 0n, marginCoveragePorMil: 0 })).toBe(400);
  });
});

describe('sombra: o que a pessoa fez na plataforma', () => {
  const antes = { status: 'ativa', dailyBudgetMicros: R(30) };

  it('pausar, arquivar ou remover conta como pausa; situação desconhecida não conta', () => {
    for (const status of ['pausada', 'arquivada', 'removida']) expect(acaoHumana(antes, { ...antes, status })).toBe('pausou');
    expect(acaoHumana(antes, null)).toBe('pausou');
    expect(acaoHumana(antes, { ...antes, status: 'desconhecida' })).toBe('nenhuma');
  });

  it('a verba só conta com mudança de 5% ou mais; sem a verba dos dois lados, não dá para dizer', () => {
    expect(acaoHumana(antes, { status: 'ativa', dailyBudgetMicros: R(28.5) })).toBe('reduziu_verba');
    expect(acaoHumana(antes, { status: 'ativa', dailyBudgetMicros: R(28.6) })).toBe('nenhuma');
    expect(acaoHumana(antes, { status: 'ativa', dailyBudgetMicros: R(31.5) })).toBe('aumentou_verba');
    expect(acaoHumana(antes, { status: 'ativa', dailyBudgetMicros: R(31.4) })).toBe('nenhuma');
    expect(acaoHumana(antes, { status: 'ativa', dailyBudgetMicros: null })).toBe('nenhuma');
    expect(acaoHumana({ status: 'ativa', dailyBudgetMicros: null }, { status: 'ativa', dailyBudgetMicros: R(10) })).toBe('nenhuma');
  });

  it('a concordância diz se a pessoa fez o mesmo, foi na mesma direção ou na contrária', () => {
    expect(concordancia('campanha_pausar', 'pausou')).toBe('igual');
    expect(concordancia('campanha_pausar', 'reduziu_verba')).toBe('mesma_direcao');
    expect(concordancia('campanha_pausar', 'aumentou_verba')).toBe('contraria');
    expect(concordancia('orcamento_reduzir', 'pausou')).toBe('mesma_direcao');
    expect(concordancia('orcamento_aumentar', 'aumentou_verba')).toBe('igual');
    expect(concordancia('orcamento_aumentar', 'pausou')).toBe('contraria');
    expect(concordancia('orcamento_reduzir', 'nenhuma')).toBe('nenhuma');
  });
});

describe('sombra: arrependimento ("se tivesse sido autorizado, teria melhorado ou piorado?")', () => {
  const depois = (gasto: number, margem: number | null, over: { orders?: number; cobertura?: number } = {}) => ({
    spendMicros: R(gasto),
    orders: over.orders ?? 4,
    marginKnownMicros: margem === null ? null : R(margem),
    marginCoveragePorMil: over.cobertura ?? 1000,
  });

  it('a pessoa fez o mesmo: não há diferença', () => {
    expect(arrependimento('campanha_pausar', null, 'pausou', depois(0, null, { orders: 0 }))).toEqual({ regretMicros: 0n, label: 'igual' });
    expect(arrependimento('orcamento_reduzir', 20, 'reduziu_verba', null)).toEqual({ regretMicros: 0n, label: 'igual' });
  });

  it('pausa recomendada e campanha no ar: o resultado dela na janela é o que a pausa teria evitado (ou perdido)', () => {
    // Continuou no prejuízo: gastou 150, margem 40. Pausar teria poupado R$ 110.
    expect(arrependimento('campanha_pausar', null, 'nenhuma', depois(150, 40))).toEqual({ regretMicros: R(-110), label: 'teria_melhorado' });
    // Virou: gastou 150, margem 260. Pausar teria custado R$ 110.
    expect(arrependimento('campanha_pausar', null, 'nenhuma', depois(150, 260))).toEqual({ regretMicros: R(110), label: 'teria_piorado' });
    // Sem pedido nenhum, a margem é zero com certeza: o gasto inteiro teria sido poupado.
    expect(arrependimento('campanha_pausar', null, 'nenhuma', depois(90, null, { orders: 0 }))).toEqual({ regretMicros: R(-90), label: 'teria_melhorado' });
    // A pessoa reduziu a verba em vez de pausar: a campanha seguiu no ar, e o resultado dela é o que conta.
    expect(arrependimento('campanha_pausar', null, 'reduziu_verba', depois(100, 30)).label).toBe('teria_melhorado');
  });

  it('verba: a estimativa mexe no resultado na mesma proporção, e só vale com a pessoa sem mexer', () => {
    // Reduzir 20% de uma campanha que perdeu R$ 100 teria poupado R$ 20.
    expect(arrependimento('orcamento_reduzir', 20, 'nenhuma', depois(300, 200))).toEqual({ regretMicros: R(-20), label: 'teria_melhorado' });
    // Aumentar 20% de uma campanha que sobrou R$ 100 teria trazido mais R$ 20.
    expect(arrependimento('orcamento_aumentar', 20, 'nenhuma', depois(300, 400))).toEqual({ regretMicros: R(-20), label: 'teria_melhorado' });
    // Aumentar 20% de uma campanha que passou a perder teria piorado.
    expect(arrependimento('orcamento_aumentar', 20, 'nenhuma', depois(300, 200))).toEqual({ regretMicros: R(20), label: 'teria_piorado' });
    // A pessoa foi para outro lado: a campanha observada já não é a da recomendação.
    expect(arrependimento('orcamento_reduzir', 20, 'pausou', depois(40, 10)).label).toBe('sem_dado');
    expect(arrependimento('orcamento_aumentar', 20, 'reduziu_verba', depois(200, 300)).label).toBe('sem_dado');
    // Campanha que não gastou na janela não diz nada sobre a verba.
    expect(arrependimento('orcamento_aumentar', 20, 'nenhuma', depois(0, null, { orders: 0 })).label).toBe('sem_dado');
  });

  it('sem margem conhecida em 80% da receita, ou sem o resultado, não há o que comparar', () => {
    expect(arrependimento('campanha_pausar', null, 'nenhuma', depois(150, 40, { cobertura: 799 }))).toEqual({ regretMicros: null, label: 'sem_dado' });
    expect(arrependimento('campanha_pausar', null, 'nenhuma', depois(150, null))).toEqual({ regretMicros: null, label: 'sem_dado' });
    expect(arrependimento('campanha_pausar', null, 'nenhuma', null).label).toBe('sem_dado');
  });

  it('diferença abaixo de R$ 1 ou de 1% do gasto é ruído', () => {
    expect(arrependimento('campanha_pausar', null, 'nenhuma', depois(50, 50.9)).label).toBe('igual');
    expect(arrependimento('campanha_pausar', null, 'nenhuma', depois(1000, 1009)).label).toBe('igual');
    expect(arrependimento('campanha_pausar', null, 'nenhuma', depois(1000, 1011)).label).toBe('teria_piorado');
  });
});

describe('sombra: prontidão por conta e ferramenta', () => {
  const d = (over: Partial<DecisaoAvaliada> = {}): DecisaoAvaliada => ({ agreement: 'igual', label: 'teria_melhorado', regretMicros: R(-10), confidencePorMil: 900, ...over });

  it('só conta decisão comparável, e diz o que falta para propor a promoção', () => {
    const p = prontidao([d(), d({ agreement: 'nenhuma' }), d({ label: 'teria_piorado', regretMicros: R(4), agreement: 'contraria' }), d({ label: 'sem_dado', regretMicros: null })]);
    expect(p).toEqual({ sampleSize: 3, agreementPorMil: 333, worsePorMil: 333, regretSumMicros: R(-16), confidenceAvgPorMil: 900, missing: ['amostra', 'concordancia', 'piora'] });
  });

  it('com a amostra cheia e os portões atendidos, nada falta; arrependimento positivo ou confiança baixa barram', () => {
    const cheia = Array.from({ length: PORTOES.amostra }, () => d());
    expect(prontidao(cheia)).toMatchObject({ sampleSize: 30, agreementPorMil: 1000, worsePorMil: 0, missing: [] });
    expect(prontidao(cheia.map((x) => ({ ...x, confidencePorMil: 650 }))).missing).toEqual(['confianca']);
    expect(prontidao([...cheia.slice(1), d({ label: 'teria_piorado', regretMicros: R(900) })]).missing).toEqual(['arrependimento']);
  });

  it('sem decisão nenhuma, tudo falta e nenhum número é inventado', () => {
    expect(prontidao([])).toEqual({ sampleSize: 0, agreementPorMil: null, worsePorMil: null, regretSumMicros: 0n, confidenceAvgPorMil: null, missing: ['amostra', 'concordancia', 'piora', 'confianca'] });
  });
});
