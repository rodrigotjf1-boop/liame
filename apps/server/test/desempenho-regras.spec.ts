import { describe, expect, it } from 'vitest';
import { faixaDaLinha, faixasDoAlcance, metricaDoPeriodo } from '../src/connectors/alcance-do-periodo.js';
import { resultadoDaCampanha } from '../src/results/desempenho.service.js';

// As regras puras do P23: as faixas do alcance do período e o resultado que a plataforma conta.

describe('alcance do período', () => {
  it('as três faixas: o dia da leitura, e os 7 e 30 dias completos até a véspera (a virada do mês e do ano)', () => {
    expect(faixasDoAlcance('2026-10-16')).toEqual([
      { metrica: 'reach_dia', since: '2026-10-16', until: '2026-10-16' },
      { metrica: 'reach_7d', since: '2026-10-09', until: '2026-10-15' },
      { metrica: 'reach_30d', since: '2026-09-16', until: '2026-10-15' },
    ]);
    expect(faixasDoAlcance('2027-01-01').map((f) => [f.since, f.until])).toEqual([
      ['2027-01-01', '2027-01-01'],
      ['2026-12-25', '2026-12-31'],
      ['2026-12-02', '2026-12-31'],
    ]);
  });

  it('a linha da Meta é reconhecida pelo começo e pelo fim exatos; outra faixa não vira número', () => {
    const faixas = faixasDoAlcance('2026-10-16');
    expect(faixaDaLinha(faixas, '2026-10-09', '2026-10-15')?.metrica).toBe('reach_7d');
    expect(faixaDaLinha(faixas, '2026-10-09', '2026-10-16')).toBeNull();
    expect(faixaDaLinha(faixas, undefined, '2026-10-15')).toBeNull();
  });

  it('o período da tela escolhe a métrica: hoje, 7 e 30 dias; qualquer outro, nenhuma (nunca a soma de cada dia)', () => {
    expect(metricaDoPeriodo('2026-10-16', '2026-10-16', '2026-10-16')).toEqual({ metrica: 'reach_dia', dia: '2026-10-16' });
    expect(metricaDoPeriodo('2026-10-09', '2026-10-15', '2026-10-16')).toEqual({ metrica: 'reach_7d', dia: '2026-10-15' });
    expect(metricaDoPeriodo('2026-09-16', '2026-10-15', '2026-10-16')).toEqual({ metrica: 'reach_30d', dia: '2026-10-15' });
    // Um dia que não é hoje (o alcance gravado de um dia só é o do dia da leitura) e um período de 10 dias: nada.
    expect(metricaDoPeriodo('2026-10-14', '2026-10-14', '2026-10-16')).toBeNull();
    expect(metricaDoPeriodo('2026-10-06', '2026-10-15', '2026-10-16')).toBeNull();
  });
});

describe('o resultado da campanha', () => {
  const meta = (purchases: string | null, conversations: string | null, objective: string | null = null) => resultadoDaCampanha({ provider: 'meta_ads', objective, purchases, conversations, conversions: null });

  it('Meta: compras na de venda; conversas na de mensagem; sem nenhum dos dois no período, pelo objetivo', () => {
    expect(meta('7', '0')).toEqual({ kind: 'purchases', value: '7', window: '7d_click' });
    expect(meta('1', '148')).toEqual({ kind: 'conversations', value: '148', window: '7d_click' });
    expect(meta('0', '0', 'OUTCOME_ENGAGEMENT')).toEqual({ kind: 'conversations', value: '0', window: '7d_click' });
    expect(meta('0', '0', 'OUTCOME_SALES')).toEqual({ kind: 'purchases', value: '0', window: '7d_click' });
    expect(meta(null, null)).toBeNull();
  });

  it('Google: as conversões, com até duas casas (o modelo de atribuição divide a conversão)', () => {
    const google = (conversions: string | null) => resultadoDaCampanha({ provider: 'google_ads', objective: 'SEARCH', purchases: null, conversations: null, conversions });
    expect(google('3.5')).toEqual({ kind: 'conversions', value: '3.5', window: 'padrao' });
    expect(google('0.333333')).toEqual({ kind: 'conversions', value: '0.33', window: 'padrao' });
    expect(google(null)).toBeNull();
  });
});
