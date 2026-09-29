import { describe, expect, it } from 'vitest';
import { centavosParaMicros } from '../src/orders/order-store.js';
import { normalizarTelefone } from '../src/orders/telefone.js';

// A2.5 · F1: o mesmo cliente precisa dar o mesmo texto vindo do Regem e do WhatsApp, senão o índice
// cego não liga a conversa ao pedido (integrations.md §6.3). Dinheiro sem ponto flutuante (A2.5-4).
describe('telefone em E.164', () => {
  it.each([
    ['(21) 99999-8888', '+5521999998888'],
    ['21999998888', '+5521999998888'],
    ['5521999998888', '+5521999998888'],
    ['+55 21 99999-8888', '+5521999998888'],
    ['0055 21 99999 8888', '+5521999998888'],
    ['021 99999-8888', '+5521999998888'],
    // wa_id do WhatsApp sem o nono dígito: é o mesmo celular.
    ['552199998888', '+5521999998888'],
    ['(21) 9999-8888', '+5521999998888'],
    // Fixo fica como está.
    ['(21) 3333-4444', '+552133334444'],
    ['552133334444', '+552133334444'],
    // DDD 55 (RS) não se confunde com o código do país.
    ['(55) 99999-8888', '+5555999998888'],
    ['+1 415 555 2671', '+14155552671'],
  ])('%s → %s', (bruto, esperado) => {
    expect(normalizarTelefone(bruto)).toBe(esperado);
  });

  it.each([[''], ['12345'], ['(00) 99999-8888'], ['(21) 1999-8888'], ['+55 21 1999-8888'], [null], [undefined], ['abc']])(
    'recusa o que não dá para ter certeza: %s',
    (bruto) => {
      expect(normalizarTelefone(bruto)).toBeNull();
    },
  );
});

describe('centavos → micros', () => {
  it('converte sem ponto flutuante', () => {
    expect(centavosParaMicros(1999)).toBe(19_990_000n);
    expect(centavosParaMicros(0)).toBe(0n);
    // 0,1 + 0,2 em ponto flutuante daria 0,30000000000000004; em centavos inteiros não há erro.
    expect(centavosParaMicros(10) + centavosParaMicros(20)).toBe(centavosParaMicros(30));
    expect(centavosParaMicros(900_000_000_000_000)).toBe(9_000_000_000_000_000_000n);
  });

  it.each([[-1], [1.5], [Number.NaN], [900_000_000_000_001]])('recusa %s', (v) => {
    expect(() => centavosParaMicros(v)).toThrow();
  });
});
