import { describe, expect, it } from 'vitest';
import { diasDoPeriodo, montarSerie, periodoAntes } from '../src/results/serie-diaria.js';

// A linha dos dias da tela de Resultados (`GET /v1/results/daily`), sem banco: os dias do período, o período de
// mesmo tamanho logo antes e a junção do gasto com as vendas, em inteiros (micros), sem ponto flutuante.

const R = (reais: number) => BigInt(Math.round(reais * 100)) * 10_000n;

describe('série por dia dos resultados', () => {
  it('lista os dias do período com as duas pontas, atravessando o mês e o ano', () => {
    expect(diasDoPeriodo('2026-09-29', '2026-10-02')).toEqual(['2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02']);
    expect(diasDoPeriodo('2026-12-31', '2027-01-01')).toEqual(['2026-12-31', '2027-01-01']);
    expect(diasDoPeriodo('2026-10-07', '2026-10-07')).toEqual(['2026-10-07']);
    // Fevereiro de ano bissexto, e a troca de horário de outros países não muda a conta (tudo em UTC).
    expect(diasDoPeriodo('2028-02-28', '2028-03-01')).toEqual(['2028-02-28', '2028-02-29', '2028-03-01']);
    expect(diasDoPeriodo('2026-10-08', '2026-10-07')).toEqual([]);
  });

  it('o período anterior tem o mesmo tamanho e termina na véspera', () => {
    expect(periodoAntes('2026-09-22', '2026-09-28')).toEqual({ from: '2026-09-15', to: '2026-09-21' });
    expect(periodoAntes('2026-10-07', '2026-10-07')).toEqual({ from: '2026-10-06', to: '2026-10-06' });
    expect(periodoAntes('2026-09-01', '2026-09-30')).toEqual({ from: '2026-08-02', to: '2026-08-31' });
  });

  it('um item por dia, com zero onde não houve nada, e o período anterior somado', () => {
    const r = montarSerie(
      { from: '2026-09-26', to: '2026-09-28' },
      [
        { dia: '2026-09-26', micros: R(100) },
        { dia: '2026-09-26', micros: R(40) },
        { dia: '2026-09-28', micros: R(50) },
        // Período anterior (23 a 25/09).
        { dia: '2026-09-23', micros: R(30) },
        { dia: '2026-09-25', micros: R(20.5) },
        // Fora dos dois períodos: ignorado.
        { dia: '2026-09-22', micros: R(999) },
        { dia: '2026-09-29', micros: R(999) },
      ],
      [
        { dia: '2026-09-26', pedidos: 2, receita: R(100) },
        { dia: '2026-09-27', pedidos: 1, receita: R(35.9) },
        { dia: '2026-09-24', pedidos: 3, receita: R(151.5) },
        { dia: '2026-09-22', pedidos: 9, receita: R(999) },
      ],
    );
    expect(r.days).toEqual([
      { date: '2026-09-26', spend_micros: R(140).toString(), orders: 2, revenue_micros: R(100).toString() },
      { date: '2026-09-27', spend_micros: '0', orders: 1, revenue_micros: R(35.9).toString() },
      { date: '2026-09-28', spend_micros: R(50).toString(), orders: 0, revenue_micros: '0' },
    ]);
    expect(r.anterior).toEqual({ from: '2026-09-23', to: '2026-09-25', spend: R(50.5), orders: 3, revenue: R(151.5) });
  });

  it('sem linha nenhuma, os dias vêm zerados e o período anterior também', () => {
    const r = montarSerie({ from: '2026-10-06', to: '2026-10-07' }, [], []);
    expect(r.days).toEqual([
      { date: '2026-10-06', spend_micros: '0', orders: 0, revenue_micros: '0' },
      { date: '2026-10-07', spend_micros: '0', orders: 0, revenue_micros: '0' },
    ]);
    expect(r.anterior).toEqual({ from: '2026-10-04', to: '2026-10-05', spend: 0n, orders: 0, revenue: 0n });
  });
});
