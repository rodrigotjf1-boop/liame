import { type AdPieceResponse, type CreativeTestOptionsResponse, type CreativeTestResponse, creativeTestCouponLine, type NewCampaignOptionsResponse, type RegionTestResponse } from '@liame/contracts';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { GavetaTesteDeCriativo } from '../src/components/criativos/gaveta-teste-de-criativo';
import {
  type CamposDoTeste,
  centavosDe,
  conferirTeste,
  corpoDoTeste,
  efeitoDoTeste,
  erroDoPedidoDoTeste,
  linhaDoCupomNaPrevia,
  oQueImpedeAGaveta,
  validadeDosCupons,
} from '../src/components/criativos/teste-de-criativo-textos';
import { chanceEscrita, linhaDoTesteDeCriativo, linhaDoTesteDeRegiao, testesDaMarca } from '../src/components/resultados/testes';

// R8, as telas que faltavam do teste de criativo (D-RG-96 e D-RG-97; protótipo "Telas do teste"): a gaveta "Testar contra
// outra peça" em Criativos e "Testes" em Resultados. As regras puras e o desenho da gaveta.

const ID = 'a0000000-0000-4000-8000-000000000001';
const OUTRA = 'a0000000-0000-4000-8000-000000000002';
const LOJA = 'a0000000-0000-4000-8000-000000000003';
const NBSP = ' ';

const campos = (parcial: Partial<CamposDoTeste> = {}): CamposDoTeste => ({
  pecaB: OUTRA,
  midiaA: 'm1',
  midiaB: 'm2',
  cupomA: 'SEXTAFOTO',
  cupomB: 'SEXTAOUTRA',
  tipo: 'percentual',
  valor: '10',
  minimo: '',
  nome: 'Combo sexta: a foto ou a outra',
  loja: LOJA,
  quem: 'raio',
  raio: 3,
  bairros: [],
  verba: '40,00',
  ...parcial,
});
const conferir = (c: CamposDoTeste, teto: number | null = null) => conferirTeste(c, { pecaA: ID, tetoMicros: teto, variasLojas: false });

describe('a gaveta do teste de criativo (D-RG-96)', () => {
  it('confere como a rota: os cupons, os criativos iguais, o desconto, a verba par em centavos e o teto', () => {
    expect(conferir(campos())).toBeNull();
    expect(conferir(campos({ nome: ' ' }))?.campo).toBe('nome');
    expect(conferir(campos({ midiaB: null }))?.campo).toBe('midiaB');
    expect(conferir(campos({ cupomA: 'AB' }))).toEqual({ campo: 'cupomA', erro: 'O cupom do criativo A tem de 4 a 20 letras maiúsculas ou números, sem espaço.' });
    expect(conferir(campos({ cupomB: 'sextafoto' }))?.erro).toBe('Cada criativo tem o seu cupom: os dois códigos não podem ser iguais.');
    expect(conferir(campos({ pecaB: ID, midiaB: 'm1' }))?.erro).toBe('Os dois criativos são iguais: escolha outra peça ou outra foto para o segundo.');
    expect(conferir(campos({ valor: '101' }))?.campo).toBe('valor');
    expect(conferir(campos({ tipo: 'valor', valor: '5,00' }))).toBeNull();
    expect(conferir(campos({ quem: 'bairros', bairros: [] }))?.campo).toBe('bairros');
    expect(conferir(campos({ verba: '19,98' }))?.erro).toBe(`A verba do teste é de no mínimo R$${NBSP}20,00 por dia: R$${NBSP}10,00 para cada criativo.`);
    expect(conferir(campos({ verba: '40,01' }))?.erro).toBe('A metade da verba precisa fechar em centavos: use um valor par de centavos.');
    expect(conferir(campos(), 30_000_000)?.erro).toMatch(/passa do teto por campanha/);
    expect(centavosDe('1.234,56')).toBe(123_456);
    expect(centavosDe('40')).toBe(4_000);
    expect(Number.isNaN(centavosDe('40,123'))).toBe(true);
  });

  it('o corpo do pedido: raio ou bairros, a verba em micros e os códigos em maiúsculas', () => {
    expect(corpoDoTeste(campos({ cupomA: 'sexta foto' }), { brandId: ID, pecaA: ID, loja: LOJA })).toEqual({
      brand_id: ID,
      unit_id: LOJA,
      name: 'Combo sexta: a foto ou a outra',
      arms: [
        { piece_id: ID, media_id: 'm1', coupon_code: 'SEXTAFOTO' },
        { piece_id: OUTRA, media_id: 'm2', coupon_code: 'SEXTAOUTRA' },
      ],
      discount: { kind: 'percentual', percent: 10, min_order_cents: 0 },
      radius_km: 3,
      daily_budget_micros: 40_000_000,
    });
    const porBairros = corpoDoTeste(campos({ quem: 'bairros', bairros: ['3304557001'], tipo: 'valor', valor: '5,00', minimo: '30,00' }), { brandId: ID, pecaA: ID, loja: LOJA });
    expect(porBairros).toMatchObject({ districts: ['3304557001'], discount: { kind: 'valor', value_cents: 500, min_order_cents: 3000 } });
    expect(porBairros).not.toHaveProperty('radius_km');
  });

  it('a linha do cupom é a do servidor (a mesma fórmula do contrato); o efeito, a validade e as recusas no campo certo', () => {
    expect(linhaDoCupomNaPrevia('SEXTAFOTO', campos())).toBe('Cupom SEXTAFOTO: 10% de desconto.');
    expect(linhaDoCupomNaPrevia('SEXTAFOTO', campos({ tipo: 'valor', valor: '5,00', minimo: '30,00' }))).toBe(creativeTestCouponLine('SEXTAFOTO', { kind: 'valor', value_cents: 500, min_order_cents: 3000 }));
    expect(linhaDoCupomNaPrevia('', campos({ valor: '' }))).toBe('Cupom …: ….');
    expect(efeitoDoTeste('40,00')).toBe(`O teste custa R$${NBSP}40,00 por dia (R$${NBSP}20,00 para cada criativo), até R$${NBSP}1.120,00 se for até o fim (28 dias). Enquanto estiver pausado, não gasta.`);
    expect(validadeDosCupons('2026-11-14')).toBe('29/12');
    expect(erroDoPedidoDoTeste({ code: 'cupom-em-uso', title: 'Código de cupom em uso', detail: 'Já existe um cupom SEXTAOUTRA nesta loja.', errors: [{ path: 'arms.1.coupon_code', message: 'x' }] })).toEqual({ campo: 'cupomB', texto: 'Já existe um cupom SEXTAOUTRA nesta loja.' });
    expect(erroDoPedidoDoTeste({ code: 'acima-do-teto', title: 'Acima do teto por campanha' }).campo).toBe('verba');
    expect(erroDoPedidoDoTeste({ code: 'teste-em-andamento', title: 'Já existe um teste desta marca' }).campo).toBeNull();
  });

  it('o que impede antes de preencher: o teste vivo, a loja sem Regem, sem a permissão de cupom ou sem a escrita', () => {
    const op = (coupons: CreativeTestOptionsResponse['units'][number]['coupons'], live: CreativeTestOptionsResponse['live'] = null): CreativeTestOptionsResponse => ({ enabled: true, live, units: [{ unit_id: LOJA, coupons }] });
    const loja = { id: LOJA, name: 'Loja Centro' };
    expect(oQueImpedeAGaveta(op('pronto'), loja)).toBeNull();
    expect(oQueImpedeAGaveta(op('pronto', { id: ID, kind: 'regiao', name: 'Lapa sem anúncio', status: 'rodando' }), loja)?.titulo).toBe('A marca já tem um teste pedido ou rodando');
    expect(oQueImpedeAGaveta(op('sem_permissao'), loja)).toMatchObject({ titulo: 'A Loja Centro ainda não liberou criar cupom', contas: true });
    expect(oQueImpedeAGaveta(op('sem_regem'), loja)?.contas).toBe(true);
    expect(oQueImpedeAGaveta(op('escrita_desligada'), loja)?.contas).toBe(false);
  });

  it('a gaveta desenha os dois criativos, a linha do cupom de cada um e o aviso do que impede', () => {
    const peca = (id: string, title: string, body: string) => ({ id, status: 'aprovada', current: { version: 1, title, body } }) as unknown as AdPieceResponse;
    const loja = { id: LOJA, name: 'Loja Centro', address: 'Rua da Assembleia, 10', has_address: true, delivery_radius_km: null, menu_available: true, menu_block: null };
    const html = renderToStaticMarkup(
      createElement(GavetaTesteDeCriativo, {
        brandId: ID,
        peca: peca(ID, 'Sexta é dia de combo', 'Smash, batata e refri por R$ 34,90.'),
        outras: [peca(OUTRA, 'Combo sexta por R$ 34,90', 'Smash na chapa, batata e refri.')],
        midias: [],
        opcoes: { enabled: true, live: null, units: [{ unit_id: LOJA, coupons: 'sem_permissao' }] },
        campanhas: { units: [loja], campaign_cap_micros: null } as unknown as NewCampaignOptionsResponse,
        hoje: '2026-11-14',
        aoFechar: () => undefined,
        aoCriado: () => undefined,
      }),
    );
    expect(html).toContain('Testar contra outra peça');
    expect(html).toContain('Sexta é dia de combo');
    expect(html).toContain('Combo sexta por R$ 34,90');
    expect(html).toContain('A Loja Centro ainda não liberou criar cupom');
    expect(html).toContain('valendo até 29/12 (45 dias)');
    expect(html).toContain('A empresa ainda não definiu o teto por campanha.');
    expect(html).toContain('aria-disabled="true"');
  });
});

// ------------------------------------------------------------------ "Testes" em Resultados (D-RG-97)

const TESTE: CreativeTestResponse = {
  id: ID,
  brand_id: ID,
  unit_id: LOJA,
  name: 'Combo sexta: o balcão ou a entrega?',
  status: 'terminado',
  active: false,
  arms: [
    { letter: 'A', piece_id: ID, piece_version: 1, media_id: ID, title: 'A', ad_text: 'x', coupon_code: 'SEXTAFOTO', coupon_status: 'criado', meta: { adset_id: '1', ad_id: '2' } },
    { letter: 'B', piece_id: OUTRA, piece_version: 1, media_id: ID, title: 'B', ad_text: 'y', coupon_code: 'SEXTAOUTRA', coupon_status: 'criado', meta: { adset_id: '3', ad_id: '4' } },
  ],
  discount: { kind: 'percentual', percent: 10, value_cents: null, min_order_cents: 0, valid_until: '2026-10-28' },
  radius_km: 3,
  districts: null,
  daily_budget_micros: 40_000_000,
  min_days: 7,
  max_days: 28,
  link: 'https://cardapio.exemplo.com.br/mister-centro',
  action_id: OUTRA,
  pending_action_id: null,
  started_on: '2026-09-14',
  ended_on: '2026-09-27',
  error: null,
  reason: null,
  result: {
    looks: [
      { day: 7, orders_a: 4, orders_b: 20, chance: 0.01 },
      { day: 14, orders_a: 9, orders_b: 45, chance: 0.0004 },
    ],
    verdict: 'venceu',
    winner: 'B',
    arms: [
      { letter: 'A', orders: 9, revenue_micros: 378_000_000, spend_micros: 280_000_000, link_clicks: 400 },
      { letter: 'B', orders: 45, revenue_micros: 1_890_000_000, spend_micros: 280_000_000, link_clicks: 350 },
    ],
  },
  loser_pause: null,
  meta: { account_id: 'act_1', campaign_id: '9' },
  created_at: '2026-09-13T12:00:00.000Z',
};

describe('"Testes" em Resultados (D-RG-97)', () => {
  it('o teste de criativo: a situação, o veredito em uma frase, as datas e os números que decidiram', () => {
    const l = linhaDoTesteDeCriativo(TESTE, '2026-11-14');
    expect(l).toMatchObject({ tipo: 'Teste de criativo', situacao: { rotulo: 'O criativo B venceu', tom: 'concluido' }, quando: '14/09 a 27/09 · 14 dias', pedido: OUTRA });
    expect(l.veredito).toBe('O criativo B venceu: 45 pedidos no caixa contra 9, com a mesma verba (menos de 0,1% de chance de ser acaso).');
    expect(l.numeros).toEqual([`Gasto R$${NBSP}560,00`, `Receita R$${NBSP}2.268,00`, `Custo por pedido R$${NBSP}10,37`, `Verba R$${NBSP}40,00/dia`]);
    const rodando = linhaDoTesteDeCriativo({ ...TESTE, status: 'rodando', ended_on: null, started_on: '2026-11-06', result: { ...TESTE.result!, verdict: 'ainda_nao', winner: null, looks: [{ day: 7, orders_a: 11, orders_b: 7, chance: 0.4 }], arms: [{ ...TESTE.result!.arms[0], orders: 11 }, { ...TESTE.result!.arms[1], orders: 7 }] } }, '2026-11-14');
    expect(rodando.quando).toBe('desde 06/11 · dia 9 de 28');
    expect(rodando.veredito).toBe('Ainda não dá para dizer: 11 pedidos do criativo A contra 7 do B na olhada do dia 7. A próxima olhada é a do dia 14.');
    expect(linhaDoTesteDeCriativo({ ...TESTE, status: 'pedido', started_on: null, ended_on: null, result: null }, '2026-11-14')).toMatchObject({ quando: 'pedido em 13/09', veredito: 'O teste ainda não começou.' });
    expect(chanceEscrita(0.024)).toBe('2,4%');
  });

  it('o teste de região e a lista com os dois tipos, do mais novo ao mais antigo', () => {
    const regiao = {
      id: OUTRA,
      brand_id: ID,
      unit_id: LOJA,
      name: 'Lapa sem anúncio por 14 dias',
      status: 'pedido',
      district: { code: '3304557001', name: 'Lapa', meta: true, radius_km: 1.2 },
      days: 14,
      weeks: { from: '2026-10-12', to: '2026-11-08', districts: [{ name: 'Lapa', orders: 64, target: true }] },
      ad_sets: [],
      action_id: null,
      started_on: null,
      ended_on: null,
      error: null,
      reason: null,
      created_at: '2026-11-14T12:00:00.000Z',
    } satisfies RegionTestResponse;
    const l = linhaDoTesteDeRegiao(regiao, '2026-11-14');
    expect(l).toMatchObject({ tipo: 'Teste de região', situacao: { rotulo: 'Espera a aprovação' }, numeros: ['Pedidos em Lapa nas 4 semanas de antes: 64'], pedido: null });
    expect(l.veredito).toBe('Lapa vai ficar 14 dias sem anúncio nas campanhas do Liame; o caixa diz quanto o anúncio traz ali.');
    expect(testesDaMarca([TESTE], [regiao], '2026-11-14').map((t) => t.nome)).toEqual(['Lapa sem anúncio por 14 dias', 'Combo sexta: o balcão ou a entrega?']);
  });
});
