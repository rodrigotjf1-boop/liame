import { describe, expect, it } from 'vitest';
import { conferirDesconto, cupomDoDesconto, type DescontoGuardado, LIMITES_DO_DESCONTO } from '../src/mensageria/desconto.js';

// A5 · Y6, parte 5: as regras puras do desconto padrão do cupom das mensagens (decisão do dono em 10/10/2026; protótipo
// P15, parte D). O que o Liame aceita no desconto, e o cupom de uma mensagem a partir dele: vale do dia do envio até
// tantos dias, contando o do envio.

const campos = (erros: { path: string; message: string }[]) => erros.map((e) => e.path);

describe('o desconto padrão do cupom das mensagens: o que o Liame aceita', () => {
  it('os limites do produto são os do protótipo', () => {
    expect(LIMITES_DO_DESCONTO).toEqual({ percentMax: 50, valueCentsMax: 10_000, minOrderCentsMax: 100_000, validDaysMax: 14 });
  });

  it('percentual: de 1% a 50%, com ou sem pedido mínimo', () => {
    expect(conferirDesconto({ kind: 'percentual', percent: 10, valid_days: 3 })).toEqual([]);
    expect(conferirDesconto({ kind: 'percentual', percent: 1, valid_days: 1 })).toEqual([]);
    expect(conferirDesconto({ kind: 'percentual', percent: 50, min_order_cents: 3000, valid_days: 14 })).toEqual([]);
    expect(conferirDesconto({ kind: 'percentual', percent: 51, valid_days: 3 })).toEqual([{ path: 'percent', message: 'O desconto passa de 50%: o Liame não aceita mais que isso no cupom das mensagens.' }]);
    expect(conferirDesconto({ kind: 'percentual', valid_days: 3 })).toEqual([{ path: 'percent', message: 'Informe o desconto, de 1% a 50%.' }]);
    // O valor em reais não cabe no cupom percentual.
    expect(campos(conferirDesconto({ kind: 'percentual', percent: 10, value_cents: 500, valid_days: 3 }))).toEqual(['value_cents']);
  });

  it('valor fixo: de R$ 1,00 a R$ 100,00, sempre com pedido mínimo maior que o desconto', () => {
    expect(conferirDesconto({ kind: 'valor', value_cents: 1000, min_order_cents: 5000, valid_days: 7 })).toEqual([]);
    expect(conferirDesconto({ kind: 'valor', value_cents: 100, min_order_cents: 101, valid_days: 7 })).toEqual([]);
    expect(conferirDesconto({ kind: 'valor', value_cents: 10_000, min_order_cents: 10_001, valid_days: 7 })).toEqual([]);
    expect(conferirDesconto({ kind: 'valor', value_cents: 1000, valid_days: 7 })).toEqual([{ path: 'min_order_cents', message: 'Com desconto de valor fixo, informe o pedido mínimo, maior que o desconto.' }]);
    // Igual ao desconto não serve: o cupom zeraria o pedido.
    expect(campos(conferirDesconto({ kind: 'valor', value_cents: 1000, min_order_cents: 1000, valid_days: 7 }))).toEqual(['min_order_cents']);
    expect(campos(conferirDesconto({ kind: 'valor', value_cents: 1000, min_order_cents: 800, valid_days: 7 }))).toEqual(['min_order_cents']);
    expect(conferirDesconto({ kind: 'valor', value_cents: 10_001, min_order_cents: 20_000, valid_days: 7 })[0]).toEqual({
      path: 'value_cents',
      message: 'O desconto passa de R$ 100,00: o Liame não aceita mais que isso no cupom das mensagens.',
    });
    expect(conferirDesconto({ kind: 'valor', value_cents: 99, min_order_cents: 5000, valid_days: 7 })).toEqual([{ path: 'value_cents', message: 'O desconto de valor fixo começa em R$ 1,00.' }]);
    expect(conferirDesconto({ kind: 'valor', min_order_cents: 5000, valid_days: 7 })).toEqual([{ path: 'value_cents', message: 'Informe o desconto, de R$ 1,00 a R$ 100,00.' }]);
    expect(campos(conferirDesconto({ kind: 'valor', value_cents: 1000, percent: 10, min_order_cents: 5000, valid_days: 7 }))).toEqual(['percent']);
  });

  it('entrega grátis: sem valor nenhum; o pedido mínimo é opcional', () => {
    expect(conferirDesconto({ kind: 'frete_gratis', valid_days: 2 })).toEqual([]);
    expect(conferirDesconto({ kind: 'frete_gratis', min_order_cents: 4000, valid_days: 2 })).toEqual([]);
    expect(campos(conferirDesconto({ kind: 'frete_gratis', percent: 10, value_cents: 500, valid_days: 2 }))).toEqual(['percent', 'value_cents']);
  });

  it('a validade vai de 1 a 14 dias, e o pedido mínimo até R$ 1.000,00', () => {
    expect(conferirDesconto({ kind: 'percentual', percent: 10, valid_days: 15 })).toEqual([{ path: 'valid_days', message: 'O cupom vale de 1 a 14 dias.' }]);
    expect(conferirDesconto({ kind: 'percentual', percent: 10, min_order_cents: 100_001, valid_days: 3 })).toEqual([{ path: 'min_order_cents', message: 'O pedido mínimo passa de R$ 1.000,00.' }]);
    // Vários campos errados: um erro por campo, para a tela marcar cada um.
    expect(campos(conferirDesconto({ kind: 'percentual', percent: 80, min_order_cents: 200_000, valid_days: 30 }))).toEqual(['percent', 'min_order_cents', 'valid_days']);
  });
});

describe('o cupom de uma mensagem, a partir do desconto padrão', () => {
  const LOJA = '0199a000-0000-7000-8000-00000000000a';
  const padrao: DescontoGuardado = { kind: 'percentual', percent: 10, value_cents: null, min_order_cents: null, valid_days: 2, coupon_account_id: LOJA };

  it('vale do dia do envio até tantos dias, contando o do envio', () => {
    // O exemplo do protótipo: sai no sábado, 10/10, e vale até domingo, 11/10.
    expect(cupomDoDesconto(padrao, '2026-10-10', 'DOMINGO10')).toEqual({ loja: LOJA, codigo: 'DOMINGO10', tipo: 'percentual', percentual: 10, pedido_minimo_centavos: 0, valido_de: '2026-10-10', valido_ate: '2026-10-11' });
    // Um dia só: vale no dia do envio.
    expect(cupomDoDesconto({ ...padrao, valid_days: 1 }, '2026-10-10', 'HOJE10')).toMatchObject({ valido_de: '2026-10-10', valido_ate: '2026-10-10' });
    // Cruza o mês e o ano, sem fuso no meio.
    expect(cupomDoDesconto({ ...padrao, valid_days: 14 }, '2026-10-25', 'FIM10').valido_ate).toBe('2026-11-07');
    expect(cupomDoDesconto({ ...padrao, valid_days: 3 }, '2026-12-31', 'ANO10').valido_ate).toBe('2027-01-02');
    expect(cupomDoDesconto({ ...padrao, valid_days: 2 }, '2028-02-28', 'BIS10').valido_ate).toBe('2028-02-29');
  });

  it('cada tipo leva só o campo dele, e o pedido mínimo quando há', () => {
    const valor = cupomDoDesconto({ ...padrao, kind: 'valor', percent: null, value_cents: 1000, min_order_cents: 5000 }, '2026-10-10', 'DEZ');
    expect(valor).toEqual({ loja: LOJA, codigo: 'DEZ', tipo: 'valor', valor_centavos: 1000, pedido_minimo_centavos: 5000, valido_de: '2026-10-10', valido_ate: '2026-10-11' });
    expect(valor).not.toHaveProperty('percentual');
    const entrega = cupomDoDesconto({ ...padrao, kind: 'frete_gratis', percent: null, min_order_cents: 4000 }, '2026-10-10', 'ENTREGA');
    expect(entrega).toEqual({ loja: LOJA, codigo: 'ENTREGA', tipo: 'frete_gratis', pedido_minimo_centavos: 4000, valido_de: '2026-10-10', valido_ate: '2026-10-11' });
  });
});
