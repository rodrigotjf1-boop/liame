import type { RegionOverviewResponse } from '@liame/contracts';
import { describe, expect, it } from 'vitest';
import { reconhecerPedido } from '../src/ai/conversa/por-regra.js';
import { respostaDaRegiao } from '../src/ai/conversa/regiao.js';
import { conferirResposta } from '../src/ai/conversa/resposta.js';
import { datasDaSemana, diaEmBrasilia, diasDepois, quintoDiaUtil, REFERENCIAS_DO_SETOR } from '../src/regiao/semana.js';
import { cidadeDoCptec, enderecoDaCidadeDoCptec, enderecoDaPrevisao, previsaoDaResposta } from '../src/regiao/tempo.js';

// Plano da região, R2, parte 5, sem banco e sem rede: a previsão do CPTEC pela BrasilAPI (a cidade pelo nome e a UF, os
// dias conferidos), as datas da semana que vem (o calendário do Liame e o prazo do salário, conta do sistema) e a LIA
// por regra para "como é a minha região?" (D-RG-18): o pedido reconhecido, a resposta montada e a conferência dela.

describe('a previsão do CPTEC, pela BrasilAPI', () => {
  it('a cidade pelo nome e pela UF (o mesmo nome em outra UF não serve); os endereços só com o código', () => {
    const corpo = [
      { nome: 'São João', id: 4849, estado: 'PE', regiao: 'Nordeste' },
      { nome: 'São João', id: 4850, estado: 'PR', regiao: 'Sul' },
      { nome: 'São João Batista', id: 4851, estado: 'MA', regiao: 'Nordeste' },
    ];
    expect(cidadeDoCptec(corpo, 'Sao Joao', 'PR')).toBe(4850);
    expect(cidadeDoCptec(corpo, 'São João', 'SP')).toBeNull();
    expect(cidadeDoCptec({ erro: 'x' }, 'São João', 'PR')).toBeNull();
    expect(enderecoDaCidadeDoCptec('Rio de Janeiro')).toBe('https://brasilapi.com.br/api/cptec/v1/cidade/Rio%20de%20Janeiro');
    expect(enderecoDaPrevisao(241)).toBe('https://brasilapi.com.br/api/cptec/v1/clima/previsao/241/6');
  });

  it('os dias da previsão: data de verdade, código só com letras, mínima não maior que a máxima', () => {
    const corpo = {
      cidade: 'Rio de Janeiro',
      clima: [
        { data: '2026-11-12', condicao: 'pn', condicao_desc: 'Parcialmente Nublado', min: 21, max: 29, indice_uv: 0 },
        { data: '2026-11-13', condicao: 'c', condicao_desc: 'Chuva', min: 20, max: 28 },
        { data: '2026-11-1x', condicao: 'c', condicao_desc: 'Chuva', min: 20, max: 28 },
        { data: '2026-11-15', condicao: 'C1', condicao_desc: 'Chuva', min: 20, max: 28 },
        { data: '2026-11-16', condicao: 'ps', condicao_desc: 'Sol', min: 30, max: 28 },
      ],
    };
    expect(previsaoDaResposta(corpo)).toEqual([
      { dia: '2026-11-12', condicao: 'pn', descricao: 'Parcialmente Nublado', min: 21, max: 29 },
      { dia: '2026-11-13', condicao: 'c', descricao: 'Chuva', min: 20, max: 28 },
    ]);
    expect(previsaoDaResposta({ clima: 'nada' })).toEqual([]);
  });
});

describe('as datas da semana que vem', () => {
  const feriados = new Set(['2026-11-15', '2026-11-20', '2026-12-25', '2027-01-01']);
  it('o 5º dia útil conta o sábado e pula o domingo e o feriado nacional', () => {
    // Dezembro de 2026: terça 1, quarta 2, quinta 3, sexta 4, sábado 5.
    expect(quintoDiaUtil('2026-12', feriados)).toBe('2026-12-05');
    // Janeiro de 2027: o dia 1 é feriado e o 3 é domingo: 2, 4, 5, 6, 7.
    expect(quintoDiaUtil('2027-01', feriados)).toBe('2027-01-07');
    expect(diasDepois('2026-12-30', 3)).toBe('2027-01-02');
    expect(diaEmBrasilia(new Date('2026-11-13T02:30:00Z'))).toBe('2026-11-12');
  });

  it('os próximos 45 dias, até 6, com o prazo do salário na ordem; o prazo deste mês que já passou vira o do mês seguinte', () => {
    const guardadas = [
      { day: '2026-11-15', name: 'Proclamação da República', kind: 'feriado_nacional', source: 'Lei 662/1949' },
      { day: '2026-11-20', name: 'Dia Nacional de Zumbi e da Consciência Negra', kind: 'feriado_nacional', source: 'Lei 14.759/2023' },
      { day: '2026-11-27', name: 'Black Friday', kind: 'varejo', source: 'Data do varejo' },
      { day: '2026-11-30', name: 'Cyber Monday', kind: 'varejo', source: 'Data do varejo' },
      { day: '2026-12-24', name: 'Véspera de Natal', kind: 'varejo', source: 'Data do varejo' },
      { day: '2026-12-25', name: 'Natal', kind: 'feriado_nacional', source: 'Lei 662/1949' },
      { day: '2027-01-01', name: 'Confraternização Universal', kind: 'feriado_nacional', source: 'Lei 662/1949' },
    ];
    const datas = datasDaSemana(guardadas, '2026-11-12');
    expect(datas.map((d) => `${d.day} ${d.kind}`)).toEqual([
      '2026-11-15 feriado_nacional',
      '2026-11-20 feriado_nacional',
      '2026-11-27 varejo',
      '2026-11-30 varejo',
      '2026-12-05 salario',
      '2026-12-24 varejo',
    ]);
    expect(datas[4]).toMatchObject({ name: 'Prazo do salário de novembro (5º dia útil)', source: expect.stringContaining('CLT, art. 459') });
    // No dia 3 o prazo de novembro ainda vem, e o feriado que já passou no mês (Finados, 2/11) entra na conta: 3, 4, 5, 6
    // e sábado, 7/11. Sem o feriado na lista, seria sexta, 6/11 (por isso a leitura começa no primeiro dia do mês).
    const finados = { day: '2026-11-02', name: 'Finados', kind: 'feriado_nacional', source: 'Lei 662/1949' };
    expect(datasDaSemana([finados, ...guardadas], '2026-11-03')[0]).toMatchObject({ day: '2026-11-07', name: 'Prazo do salário de outubro (5º dia útil)' });
    expect(datasDaSemana([], '2026-11-03')[0]).toMatchObject({ day: '2026-11-06' });
    // Janeiro: o prazo é o do salário de dezembro.
    expect(datasDaSemana(guardadas, '2026-12-28').find((d) => d.kind === 'salario')).toMatchObject({ day: '2027-01-07', name: 'Prazo do salário de dezembro (5º dia útil)' });
  });

  it('a referência do setor vem rotulada com a fonte e a data em que foi conferida', () => {
    expect(REFERENCIAS_DO_SETOR.length).toBeGreaterThan(0);
    for (const r of REFERENCIAS_DO_SETOR) {
      expect(r.source.length).toBeGreaterThan(10);
      expect(r.as_of).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });
});

describe('a LIA por regra: "como é a minha região?" (D-RG-18)', () => {
  it.each(['Como é a minha região?', 'como e minha regiao', 'LIA, me fala da minha região', 'Bom dia! Como é o meu bairro?', 'Quem mora na região da loja?', 'Me mostra o raio-x da região'])(
    '"%s" é o pedido da região',
    (texto) => {
      expect(reconhecerPedido(texto)).toBe('regiao');
    },
  );
  it.each(['Como estão as vendas na minha região?', 'Quanto gastei de anúncio na região?', 'Qual o melhor bairro para anunciar?', 'E a região?'])('"%s" vai para a IA', (texto) => {
    expect(reconhecerPedido(texto)).toBeNull();
  });

  const retrato: RegionOverviewResponse = {
    brand_id: '0190d2b0-0000-7000-8000-000000000050',
    unit_id: '0190d2b0-0000-7000-8000-000000000001',
    availability: { status: 'disponivel' },
    status: 'pronto',
    district_status: 'achado',
    district: {
      code: '3304557030',
      name: 'Tijuca',
      population: 142909,
      area_km2: 9.9413,
      density: 14375.3,
      head_income_median: 5500,
      head_income_mean: 8056.52,
      head_income_median_today: 6601,
      head_income_mean_today: 9669,
      income_rank: { above_pct: 87, districts: 162, typical_median: 2000 },
    },
    ipca: { from: '2022-07', to: '2026-09', factor: 1.2002 },
    delivery_area: { matched: 2, total: 3, population: 167909 },
    city: {
      code: '3304557',
      name: 'Rio de Janeiro',
      state: 'RJ',
      population: { value: 6211223, period: '2022', source: 'ibge_4714' },
      density: { value: 5174.6, period: '2022', source: 'ibge_4714' },
      population_estimate: { value: 6731133, period: '2026', source: 'ibge_6579' },
      income_pc_median: null,
      income_pc_mean: null,
      restaurants: { value: 16242, period: '2024', source: 'ibge_9528' },
      restaurants_per_10k: 24.1,
      rm_code: '3301',
      income_pc_uf: null,
      income_pc_rm: null,
      work_income_capital: null,
      pix: null,
      food_away_inflation: { scope: 'rm', period: '2026-09', away: 4.31, meal: 2.66, snack: 7.75, brasil: { away: 5.79, meal: 5.01, snack: 7.59 } },
    },
    food_places: {
      period: '2026-10',
      since: '2025-10',
      city: { active: 31512, restaurant: 12840, snack: 9611, bar: 6020, home: 3041, opened_12m: 4210, closed_12m: 2533, per_10k: 46.8, district_coverage_pct: 71 },
      district: { active: 812, restaurant: 301, snack: 255, bar: 204, home: 52, opened_12m: 93, closed_12m: 61, per_km2: 81.7 },
      postal: null,
      delivery_area: null,
    },
    week_ahead: {
      weather: {
        read_at: '2026-11-12T09:10:00.000Z',
        days: [
          { day: '2026-11-12', condition: 'pn', description: 'Parcialmente Nublado', min: 21, max: 29 },
          { day: '2026-11-13', condition: 'c', description: 'Chuva', min: 20, max: 28 },
        ],
      },
      dates: [
        { day: '2026-11-15', name: 'Proclamação da República', kind: 'feriado_nacional', source: 'Lei 662/1949' },
        { day: '2026-11-20', name: 'Dia Nacional de Zumbi e da Consciência Negra', kind: 'feriado_nacional', source: 'Lei 14.759/2023' },
        { day: '2026-11-27', name: 'Black Friday', kind: 'varejo', source: 'Data do varejo' },
        { day: '2026-11-30', name: 'Cyber Monday', kind: 'varejo', source: 'Data do varejo' },
      ],
    },
    sector_references: [],
    store_demand_status: 'sem_regem',
    store_demand: null,
    sources: [],
    generated_at: '2026-11-12T15:00:00.000Z',
  };
  const loja = { nome: 'Mister Burgers Tijuca', bairro: 'Tijuca', municipio: 'Rio de Janeiro' };
  const conferir = (r: ReturnType<typeof respostaDaRegiao>) =>
    conferirResposta(r.resposta, { emDia: [r.valor, r.calculados.map((c) => c.valor)], velhas: [], nomes: ['Mister Burgers', loja.nome, loja.bairro, loja.municipio, ...retrato.week_ahead!.dates.map((d) => d.name)] });
  const texto = (r: ReturnType<typeof respostaDaRegiao>) => r.resposta.blocos.map((b) => b.texto);

  it('o retrato inteiro: gente, bolso, concorrência, preço de comer fora, a semana que vem e o que ainda não dá para saber; passa na conferência', () => {
    const r = respostaDaRegiao({ lojasNoMapa: 2, temRegem: true, loja, retrato });
    expect(r.tipo).toBe('regiao');
    expect(texto(r)).toEqual([
      'A marca tem 2 lojas no mapa; esta resposta é da loja Mister Burgers Tijuca. As outras estão em Sua região.',
      'Gente: a loja Mister Burgers Tijuca fica no bairro Tijuca, Rio de Janeiro: 142.909 pessoas em 9,94 km², 14.375 por km² (IBGE, Censo 2022).',
      'Bolso: a renda mediana do responsável pelo domicílio no bairro é R$ 6.601, a preços de set/2026, acima de 87% dos 162 bairros do município (IBGE, Censo 2022, corrigida pelo IPCA).',
      'Concorrência: 812 lugares de comida com CNPJ ativo no bairro e 31.512 no município, 46,8 para cada 10 mil pessoas (Receita Federal, CNPJ aberto, out/2026).',
      'Preço de comer fora, em 12 meses até set/2026: o lanche subiu 7,75% na região metropolitana (Brasil: 7,59%) e a refeição, 2,66% (Brasil: 5,01%) (IBGE, IPCA).',
      'Semana que vem: chuva prevista na sexta, 13/11 (CPTEC); Proclamação da República no domingo, 15/11; Dia Nacional de Zumbi e da Consciência Negra na sexta, 20/11; Black Friday na sexta, 27/11.',
      'Ainda não dá para saber: pedidos por hora e tíquete médio da loja (com os pedidos do Regem), pessoas no raio (com a conta de anúncios) e concorrentes no raio.',
    ]);
    expect(conferir(r)).toBeNull();
    // Nada do endereço da loja (D-RG-2): só o bairro, o município e os números.
    expect(JSON.stringify(r.valor)).not.toMatch(/Rua|Conde|20520/);
  });

  it('sem o CNPJ lido, a concorrência é a do IBGE; sem o IPCA, a renda é a de 2022; parcial avisa; sem o Regem diz "só com o Regem"', () => {
    const semNada: RegionOverviewResponse = { ...retrato, status: 'parcial', ipca: null, food_places: null, district: { ...retrato.district!, head_income_median_today: null }, week_ahead: { weather: null, dates: [] } };
    const r = respostaDaRegiao({ lojasNoMapa: 1, temRegem: false, loja, retrato: semNada });
    const t = texto(r);
    expect(t[0]).toMatch(/^Gente:/);
    expect(t).toContain('Bolso: a renda mediana do responsável pelo domicílio no bairro é R$ 5.500, acima de 87% dos 162 bairros do município (IBGE, Censo 2022, valor de 2022).');
    expect(t).toContain('Concorrência: o município tem 16.242 restaurantes e similares, 24,1 para cada 10 mil habitantes (IBGE, Cadastro Central de Empresas, 2024).');
    expect(t.some((x) => x.startsWith('Semana que vem'))).toBe(false);
    expect(t).toContain('Uma das fontes públicas não respondeu na última leitura; o número que faltou aparece em Sua região quando ela responder.');
    expect(t.at(-1)).toContain('(só com o Regem)');
    expect(conferir(r)).toBeNull();
  });

  it('sem loja no mapa, diz como pôr; com o retrato ainda lendo, pede para perguntar de novo', () => {
    const semLoja = respostaDaRegiao({ lojasNoMapa: 0, temRegem: false, loja: null, retrato: null });
    expect(semLoja.tipo).toBe('sem_loja');
    expect(texto(semLoja)[0]).toMatch(/^Sua região aparece quando a loja estiver no mapa/);
    expect(conferir(semLoja)).toBeNull();
    const lendo = respostaDaRegiao({ lojasNoMapa: 1, temRegem: false, loja, retrato: { ...retrato, status: 'lendo' } });
    expect(texto(lendo)).toEqual(['Sua região da loja Mister Burgers Tijuca ainda está sendo lida: o Liame consulta o IBGE pelos códigos do bairro e do município, e isso leva até 1 minuto. Pergunte de novo daqui a pouco.']);
    expect(conferir(lendo)).toBeNull();
  });
});
