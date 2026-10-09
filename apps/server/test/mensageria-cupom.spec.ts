import { describe, expect, it } from 'vitest';
import { cupomDaRota } from '../src/mensageria/mensageria.service.js';

// A5 · Y5 (parte 6c): o cupom de uma mensagem como a tela Mensagens o recebe. O código é de quem vê as campanhas; os
// pedidos e a receita confirmados no caixa são do ciclo fechado, só para quem vê as vendas (ADR-013).

describe('o cupom da mensagem na rota de Mensagens', () => {
  it('para quem vê as vendas: os pedidos e a receita em centavos, sem ponto flutuante', () => {
    expect(cupomDaRota({ coupon_code: 'COMBO10', pedidos: 12, receita_micros: '1078800000' }, true)).toEqual({ code: 'COMBO10', orders: 12, revenue_cents: 107_880 });
    // O banco devolve a contagem como texto em algumas consultas, e a receita sempre: os dois viram número.
    expect(cupomDaRota({ coupon_code: 'COMBO10', pedidos: '3', receita_micros: '269700000' }, true)).toEqual({ code: 'COMBO10', orders: 3, revenue_cents: 26_970 });
    // Sem pedido com o cupom ainda: zero, e não nulo.
    expect(cupomDaRota({ coupon_code: 'COMBO10', pedidos: 0, receita_micros: '0' }, true)).toEqual({ code: 'COMBO10', orders: 0, revenue_cents: 0 });
    // Fração de centavo não vira centavo.
    expect(cupomDaRota({ coupon_code: 'X', pedidos: 1, receita_micros: '19999' }, true).revenue_cents).toBe(1);
  });

  it('para quem não vê as vendas: só o código', () => {
    expect(cupomDaRota({ coupon_code: 'COMBO10', pedidos: 12, receita_micros: '1078800000' }, false)).toEqual({ code: 'COMBO10', orders: null, revenue_cents: null });
  });
});
