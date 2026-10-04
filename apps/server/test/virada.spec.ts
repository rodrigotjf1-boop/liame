import { describe, expect, it } from 'vitest';
import { esperaDaVirada, faltaParaAMeiaNoite, FUSOS_DA_VIRADA, MARGEM_DA_VIRADA_MS } from './helpers/virada.js';

// A proteção dos testes contra a virada do dia (V89, ERR-092): o arquivo carregado logo antes da meia-noite espera ela
// passar. Aqui só a conta, com relógio fixo: o `setup.ts` é quem espera.

describe('a virada do dia nos testes (V89)', () => {
  it('quanto falta para a meia-noite, no fuso pedido', () => {
    // 23:59:00 em São Paulo são 02:59:00 em UTC.
    const quaseEmSp = new Date('2026-10-04T02:59:00.000Z');
    expect(faltaParaAMeiaNoite(quaseEmSp, 'America/Sao_Paulo')).toBe(60_000);
    expect(faltaParaAMeiaNoite(quaseEmSp, 'UTC')).toBe(21 * 3_600_000 + 60_000);
    // Os milissegundos contam; à meia-noite em ponto falta o dia inteiro.
    expect(faltaParaAMeiaNoite(new Date('2026-10-04T23:59:59.250Z'), 'UTC')).toBe(750);
    expect(faltaParaAMeiaNoite(new Date('2026-10-05T00:00:00.000Z'), 'UTC')).toBe(86_400_000);
  });

  it('longe da virada não espera; perto dela, espera a meia-noite e mais uma folga, em qualquer dos dois fusos', () => {
    expect([...FUSOS_DA_VIRADA]).toEqual(['America/Sao_Paulo', 'UTC']);
    expect(MARGEM_DA_VIRADA_MS).toBe(120_000);
    // Meio da tarde, e logo depois da virada (o caso em que a suíte desta sessão quebrou era ANTES dela).
    expect(esperaDaVirada(new Date('2026-10-03T18:00:00.000Z'))).toBe(0);
    expect(esperaDaVirada(new Date('2026-10-04T03:00:05.000Z'))).toBe(0);
    // A um minuto da meia-noite de São Paulo: espera o minuto e a folga.
    expect(esperaDaVirada(new Date('2026-10-04T02:59:00.000Z'))).toBe(62_000);
    // A trinta segundos da meia-noite de UTC (o relógio do banco no CI).
    expect(esperaDaVirada(new Date('2026-10-04T23:59:30.000Z'))).toBe(32_000);
    // A margem: a 120 segundos espera; a 121, não.
    expect(esperaDaVirada(new Date('2026-10-04T02:58:00.000Z'))).toBe(122_000);
    expect(esperaDaVirada(new Date('2026-10-04T02:57:59.000Z'))).toBe(0);
  });
});
