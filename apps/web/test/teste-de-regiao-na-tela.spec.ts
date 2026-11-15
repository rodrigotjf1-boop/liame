import type { ActionResponse, RegionOverviewResponse, RegionTestResponse } from '@liame/contracts';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  andamentoDoTesteDeRegiao,
  bairrosDoTeste,
  conjuntosDoTesteDeRegiao,
  ehPedidoDoTesteDeRegiao,
  idDoTesteDeRegiao,
  resultadoDoTesteDeRegiao,
  situacaoDoTesteDeRegiao,
  tituloDoTesteDeRegiao,
  vereditoDoTesteDeRegiao,
} from '../src/components/aprovacoes/teste-de-regiao-textos';
import { apresentar } from '../src/components/aprovacoes/textos';
import { BairrosDosPedidos } from '../src/components/regiao/bairros-dos-pedidos';
import { DialogoTesteDeRegiao } from '../src/components/regiao/dialogo-teste-de-regiao';
import { linhaDoTesteDeRegiao } from '../src/components/resultados/testes';

// R8, o teste de região na tela (D-RG-81 e D-RG-82; protótipo dos testes aprovado em 13/11/2026): o pedido em Sua região
// ("Testar sem anúncio" no bairro dos pedidos) e o detalhe em Aprovações. Aprovar, por enquanto, só deixa o teste pronto.
// O resultado da medida (D-RG-102): a frase com a conta ou com o motivo, no detalhe e no cartão "Testes" de Resultados.

const ID = 'a0000000-0000-4000-8000-000000000001';

const TESTE: RegionTestResponse = {
  id: ID,
  brand_id: ID,
  unit_id: ID,
  name: 'Lapa sem anúncio por 14 dias',
  status: 'pedido',
  district: { code: '3304557017', name: 'Lapa', meta: true, radius_km: 1.2 },
  days: 14,
  weeks: {
    from: '2026-10-12',
    to: '2026-11-08',
    districts: [
      { name: 'Centro', orders: 292, target: false },
      { name: 'Lapa', orders: 122, target: true },
      { name: 'Glória', orders: 60, target: false },
    ],
  },
  ad_sets: [
    { campaign_id: '1', ad_set_id: '11', name: 'Raio de 3 km', status: 'a_tirar' },
    { campaign_id: '1', ad_set_id: '12', name: 'Raio de 5 km', status: 'a_tirar' },
    { campaign_id: '2', ad_set_id: '21', name: 'Promo', status: 'a_tirar' },
  ],
  action_id: ID,
  started_on: null,
  ended_on: null,
  error: null,
  reason: null,
  created_at: '2026-11-14T12:00:00.000Z',
};

describe('o teste de região em Aprovações', () => {
  it('o pedido, o id do teste, o título, os bairros por semana (o do teste primeiro) e de onde o bairro sai', () => {
    expect(ehPedidoDoTesteDeRegiao({ tool: 'teste_de_regiao' })).toBe(true);
    expect(ehPedidoDoTesteDeRegiao({ tool: 'teste_de_criativo_criar' })).toBe(false);
    expect(idDoTesteDeRegiao(`teste_de_regiao:${ID}`)).toBe(ID);
    expect(idDoTesteDeRegiao(`teste_de_criativo:${ID}`)).toBeNull();
    expect(tituloDoTesteDeRegiao(TESTE.name)).toBe('Teste de região: Lapa sem anúncio por 14 dias');
    expect(bairrosDoTeste(TESTE)).toEqual([
      { nome: 'Lapa', porSemana: '30,5', alvo: true },
      { nome: 'Centro', porSemana: '73', alvo: false },
      { nome: 'Glória', porSemana: '15', alvo: false },
    ]);
    expect(conjuntosDoTesteDeRegiao(TESTE)).toBe('3 conjuntos de 2 campanhas do Liame mostram anúncio em Lapa: é deles que o bairro sai no teste, por 14 dias. A verba de cada campanha fica como está.');
  });

  it('a situação e o andamento dizem o que aconteceu, sem prometer o passo que ainda não existe', () => {
    expect(situacaoDoTesteDeRegiao(TESTE)).toEqual({ rotulo: 'Espera a aprovação', tom: 'espera' });
    expect(andamentoDoTesteDeRegiao(TESTE)).toBeNull();
    expect(andamentoDoTesteDeRegiao({ ...TESTE, status: 'pronto' })).toBe('Aprovado: o teste está pronto. Tirar Lapa dos anúncios ainda não está ligado no Liame, e nada mudou na Meta.');
    expect(andamentoDoTesteDeRegiao({ ...TESTE, status: 'cancelado' })).toBe('O pedido foi recusado ou expirou em Aprovações: nada mudou na Meta.');
    const pedido = { tool: 'teste_de_regiao', account_name: null, requested_by: { name: 'Rodrigo' } } as unknown as ActionResponse;
    expect(apresentar(pedido).titulo).toBe('Teste de região: um bairro sem anúncio');
    expect(apresentar(pedido).depoisDeAprovar).toBe('O Liame deixa o teste pronto. Nada muda na Meta por enquanto.');
  });
});

describe('"Testar sem anúncio" em Sua região', () => {
  const regiao = {
    order_districts_status: 'disponivel',
    order_districts: {
      from: '2026-10-12',
      to: '2026-11-08',
      minimum: 5,
      read_at: '2026-11-09T06:00:00.000Z',
      comparable: true,
      districts: [
        { name: 'Lapa', code: '3304557017', orders: 122, population: 10000, per_1000: 12.2, role: 'defender', in_delivery_area: true },
        { name: 'Bairro Sem Censo', code: null, orders: 40, population: null, per_1000: null, role: null, in_delivery_area: true },
        { name: 'Glória', code: '3304557018', orders: null, population: 9000, per_1000: 0, role: 'atacar', in_delivery_area: true },
      ],
      others: { districts: 0, orders: 0 },
      without_district: 0,
      pickup: 0,
      delivery_orders: 162,
    },
  } as unknown as RegionOverviewResponse;

  it('o botão só no bairro com o código do IBGE e com pedidos, e só quando a tela oferece o teste', () => {
    const com = renderToStaticMarkup(createElement(BairrosDosPedidos, { r: regiao, ids: 'x', mostraPro: false, testar: () => undefined }));
    expect(com.match(/Testar sem anúncio/g)).toHaveLength(1);
    expect(com).toContain('<span class="sr-only">: Lapa</span>');
    expect(renderToStaticMarkup(createElement(BairrosDosPedidos, { r: regiao, ids: 'x', mostraPro: false }))).not.toContain('Testar sem anúncio');
  });

  it('o diálogo diz o que o teste faz, o que o Liame confere e que aprovar só deixa o teste pronto', () => {
    const html = renderToStaticMarkup(createElement(DialogoTesteDeRegiao, { brandId: ID, unitId: ID, bairro: { code: '3304557017', name: 'Lapa' }, aoFechar: () => undefined }));
    expect(html).toContain('Testar Lapa sem anúncio');
    expect(html).toContain('Por 14 dias, <b>Lapa fica sem anúncio</b>');
    expect(html).toContain('aprovar só deixa o teste pronto');
    expect(html).toContain('Pedir o teste');
  });
});

describe('o resultado do teste de região (a medida, D-RG-102)', () => {
  type Resultado = NonNullable<RegionTestResponse['result']>;
  const PROVOU: Resultado = {
    window: { from: '2026-11-01', to: '2026-11-14' },
    orders: { target_before: 480, others_before: 1712, target_during: 168, others_during: 880 },
    districts: ['Centro', 'Glória', 'Saúde'],
    effect: { expected_per_week: 123.36, actual_per_week: 84, brings_per_week: 39.36, range: { from: 24.04, to: 52.5 }, proven: true },
    reason: null,
    expected_per_week: null,
    regem_minimum: 5,
    measured_at: '2026-11-16T09:00:00.000Z',
  };
  const TERMINADO = { ...TESTE, status: 'terminado' as const, started_on: '2026-11-01', ended_on: '2026-11-14' };
  const comMotivo = (reason: string, mais: Partial<Resultado> = {}): Resultado => ({ ...PROVOU, effect: null, reason, ...mais });
  const frase = (result: Resultado | null) => resultadoDoTesteDeRegiao({ ...TERMINADO, result });

  it('com prova: o que o bairro fez, o que faria seguindo os outros e a faixa, com uma casa decimal', () => {
    expect(frase(PROVOU)).toBe('Sem anúncio, o bairro fez 84,0 pedidos por semana; seguindo os outros bairros, faria 123,4. O anúncio traz de 24,0 a 52,5 pedidos por semana ali.');
    expect(frase({ ...PROVOU, effect: { ...PROVOU.effect!, actual_per_week: 1234.56, expected_per_week: 1500 } })).toContain('o bairro fez 1.234,6 pedidos por semana; seguindo os outros bairros, faria 1.500,0.');
    expect(vereditoDoTesteDeRegiao({ ...TERMINADO, result: PROVOU })).toMatchObject({ titulo: 'O anúncio traz pedido no bairro', provou: true });
  });

  it('sem prova: a faixa começa em zero', () => {
    const naoProvou: Resultado = { ...PROVOU, effect: { expected_per_week: 30.84, actual_per_week: 21, brings_per_week: 9.84, range: { from: 0, to: 17.04 }, proven: false } };
    expect(frase(naoProvou)).toBe('Não deu para provar que o anúncio traz pedido no bairro: a faixa vai de 0 a 17,0 por semana.');
    expect(vereditoDoTesteDeRegiao({ ...TERMINADO, result: naoProvou })).toMatchObject({ titulo: 'Não deu para provar', provou: false });
  });

  it('cada motivo numa frase curta; o motivo que a tela ainda não conhece não quebra a frase', () => {
    expect(frase(comMotivo('incompleto'))).toBe('O teste parou antes dos 14 dias: com menos, o Liame não tira conclusão.');
    expect(frase(comMotivo('poucos_bairros', { districts: ['Centro', 'Glória'] }))).toBe('Nos dias do teste, sobraram 2 bairros para comparar; a conta pede pelo menos 3.');
    expect(frase(comMotivo('poucos_bairros', { districts: ['Centro'] }))).toBe('Nos dias do teste, sobrou 1 bairro para comparar; a conta pede pelo menos 3.');
    expect(frase(comMotivo('poucos_bairros', { districts: [] }))).toBe('Nos dias do teste, não sobrou nenhum bairro para comparar; a conta pede pelo menos 3.');
    expect(frase(comMotivo('abaixo_do_minimo', { expected_per_week: 120, orders: { ...PROVOU.orders, target_during: null } }))).toBe(
      'O bairro teve menos pedidos do que o mínimo que o Regem mostra por bairro (5 nos 14 dias); seguindo os outros bairros, faria 120,0 pedidos por semana.',
    );
    expect(frase(comMotivo('sem_conta'))).toBe('Faltou pedido de um dos lados, antes ou durante o teste: não há conta.');
    expect(frase(comMotivo('sem_leitura', { regem_minimum: null }))).toBe('O Liame não conseguiu ler os pedidos do Regem dos 14 dias: sem eles, não há conta.');
    expect(frase(comMotivo('motivo_novo'))).toBe('Não deu para fazer a conta deste teste.');
    expect(vereditoDoTesteDeRegiao({ ...TERMINADO, result: comMotivo('sem_leitura') })).toMatchObject({ titulo: 'Sem conta neste teste', provou: false });
  });

  it('o teste terminado ainda sem a medida diz quando o resultado sai; antes do fim, nenhuma frase', () => {
    expect(frase(null)).toBe('O resultado sai depois que a leitura dos pedidos do Regem cobrir os 14 dias.');
    expect(resultadoDoTesteDeRegiao({ ...TERMINADO, result: undefined })).toBe('O resultado sai depois que a leitura dos pedidos do Regem cobrir os 14 dias.');
    expect(vereditoDoTesteDeRegiao({ ...TERMINADO, result: null })).toEqual({ titulo: 'Ainda medindo', texto: 'O resultado sai depois que a leitura dos pedidos do Regem cobrir os 14 dias.', provou: false });
    expect(resultadoDoTesteDeRegiao({ ...TESTE, status: 'rodando', result: null })).toBeNull();
    expect(vereditoDoTesteDeRegiao(TESTE)).toBeNull();
  });

  it('no cartão "Testes" de Resultados: o resultado no lugar do aviso de que a faixa ainda não existe', () => {
    expect(linhaDoTesteDeRegiao({ ...TERMINADO, result: PROVOU }, '2026-11-16')).toMatchObject({
      situacao: { rotulo: 'Terminado' },
      quando: '01/11 a 14/11 · 14 dias',
      veredito: 'Sem anúncio, o bairro fez 84,0 pedidos por semana; seguindo os outros bairros, faria 123,4. O anúncio traz de 24,0 a 52,5 pedidos por semana ali.',
    });
    expect(linhaDoTesteDeRegiao({ ...TERMINADO, result: null }, '2026-11-15').veredito).toBe('O resultado sai depois que a leitura dos pedidos do Regem cobrir os 14 dias.');
    expect(linhaDoTesteDeRegiao({ ...TERMINADO, status: 'encerrado', ended_on: '2026-11-06', result: null }, '2026-11-15').veredito).toBe(
      'O teste foi encerrado antes do fim: com menos de 14 dias, o Liame não tira conclusão.',
    );
    expect(linhaDoTesteDeRegiao({ ...TERMINADO, result: PROVOU }, '2026-11-16').veredito).not.toContain('faixa aparece aqui');
  });
});
