import { describe, expect, it } from 'vitest';
import { decidirApagamento, situacaoDaMarca } from '../src/cobranca/fim-da-assinatura.js';

// A7 · W3, parte 4a (D-A7-106): a situação de cada marca para o apagamento e a decisão, quando uma chega ao dia, de tirar
// só ela, a empresa inteira ou esperar.

describe('o fim da assinatura: a situação de cada marca', () => {
  const hoje = '2026-12-10';

  it('viva vence tudo; sem assinatura paga, sem contrato; antes do dia ou com o meio de pagamento pendente, esperando', () => {
    expect(situacaoDaMarca({ viva: true, apagarEm: '2026-12-01', pendenteNoMeio: false }, hoje)).toBe('viva');
    expect(situacaoDaMarca({ viva: false, apagarEm: null, pendenteNoMeio: false }, hoje)).toBe('sem_contrato');
    expect(situacaoDaMarca({ viva: false, apagarEm: '2026-12-11', pendenteNoMeio: false }, hoje)).toBe('esperando');
    expect(situacaoDaMarca({ viva: false, apagarEm: '2026-12-10', pendenteNoMeio: true }, hoje)).toBe('esperando');
  });

  it('no dia, e depois dele, sem nada pendente: devida', () => {
    expect(situacaoDaMarca({ viva: false, apagarEm: '2026-12-10', pendenteNoMeio: false }, hoje)).toBe('devida');
    expect(situacaoDaMarca({ viva: false, apagarEm: '2026-11-30', pendenteNoMeio: false }, hoje)).toBe('devida');
  });
});

describe('o fim da assinatura: o que sai', () => {
  it('outra marca viva: só a marca; nenhuma viva e alguma esperando: espera; o resto: a empresa inteira', () => {
    expect(decidirApagamento(['viva'])).toBe('marca');
    expect(decidirApagamento(['esperando', 'viva'])).toBe('marca');
    expect(decidirApagamento(['esperando', 'sem_contrato'])).toBe('esperar');
    expect(decidirApagamento(['devida', 'sem_contrato'])).toBe('empresa');
    // A empresa de uma marca só sai inteira.
    expect(decidirApagamento([])).toBe('empresa');
  });
});
