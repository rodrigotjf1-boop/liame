import type { ActionResponse, RegionOverviewResponse, RegionTestResponse } from '@liame/contracts';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { andamentoDoTesteDeRegiao, bairrosDoTeste, conjuntosDoTesteDeRegiao, ehPedidoDoTesteDeRegiao, idDoTesteDeRegiao, situacaoDoTesteDeRegiao, tituloDoTesteDeRegiao } from '../src/components/aprovacoes/teste-de-regiao-textos';
import { apresentar } from '../src/components/aprovacoes/textos';
import { BairrosDosPedidos } from '../src/components/regiao/bairros-dos-pedidos';
import { DialogoTesteDeRegiao } from '../src/components/regiao/dialogo-teste-de-regiao';

// R8, o teste de região na tela (D-RG-81 e D-RG-82; protótipo dos testes aprovado em 13/11/2026): o pedido em Sua região
// ("Testar sem anúncio" no bairro dos pedidos) e o detalhe em Aprovações. Aprovar, por enquanto, só deixa o teste pronto.

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
