import { describe, expect, it } from 'vitest';
import { demandaDaLoja, diasAntes, janelas, type LinhaDaDemanda, MINIMO_DE_PEDIDOS, ticket } from '../src/regiao/demanda.js';

// Plano da região, R3, parte 1 (a demanda da loja), sem banco: as janelas de 4 semanas, o tíquete médio em micros, o
// cliente novo × de volta, os pedidos por dia da semana e por hora, o pico e o corte de "poucos pedidos".

const linha = (o: Partial<LinhaDaDemanda> & Pick<LinhaDaDemanda, 'dow' | 'hora' | 'pedidos'>): LinhaDaDemanda => ({
  janela: 'atual',
  receita: String(o.pedidos * 50_000_000),
  novos: 0,
  de_volta: 0,
  ...o,
});

describe('a demanda da loja (R3, parte 1)', () => {
  it('as janelas: a atual são os 28 dias até ontem; a anterior, os 28 antes dela', () => {
    expect(janelas('2026-11-12')).toEqual({ de: '2026-10-15', ate: '2026-11-11', deAnterior: '2026-09-17', ateAnterior: '2026-10-14' });
    expect(diasAntes('2026-03-01', 1)).toBe('2026-02-28');
    expect(ticket(100_000_001n, 2)).toBe('50000000');
    expect(ticket(0n, 0)).toBeNull();
  });

  it('pronto: total, tíquete, a janela anterior, clientes, dia, hora e o pico', () => {
    const r = demandaDaLoja(
      [
        linha({ dow: 5, hora: 20, pedidos: 10, novos: 3, de_volta: 6 }),
        linha({ dow: 5, hora: 21, pedidos: 4, de_volta: 4 }),
        linha({ dow: 6, hora: 20, pedidos: 10, novos: 2, de_volta: 8, receita: '400000000' }),
        linha({ dow: 0, hora: 12, pedidos: 2 }),
        linha({ janela: 'anterior', dow: 5, hora: 20, pedidos: 8, receita: '360000000' }),
      ],
      '2026-11-12',
    );
    expect(r).toMatchObject({
      status: 'pronto',
      from: '2026-10-15',
      to: '2026-11-11',
      days: 28,
      minimum_orders: MINIMO_DE_PEDIDOS,
      orders: 26,
      // 10 × 50 + 4 × 50 + 400 + 2 × 50 = 1.200 reais em micros; 1.200 ÷ 26 = 46,153846…
      revenue_micros: '1200000000',
      ticket_micros: '46153846',
      previous: { orders: 8, revenue_micros: '360000000', ticket_micros: '45000000' },
      customers: { new: 5, returning: 18, unknown: 3 },
    });
    expect(r.by_weekday).toHaveLength(7);
    expect(r.by_weekday[5]).toEqual({ weekday: 5, orders: 14, revenue_micros: '700000000' });
    expect(r.by_weekday[1]).toEqual({ weekday: 1, orders: 0, revenue_micros: '0' });
    expect(r.by_hour).toHaveLength(24);
    expect(r.by_hour[20]).toEqual({ hour: 20, orders: 20 });
    // Empate entre sexta e sábado às 20h: fica o primeiro dia da semana (sexta, 5).
    expect(r.peak).toEqual({ weekday: 5, hour: 20, orders: 10 });
  });

  it('poucos pedidos: o total e o tíquete vão, o dia, a hora e o pico não; sem pedido nenhum, "sem_pedidos"', () => {
    const poucos = demandaDaLoja([linha({ dow: 5, hora: 20, pedidos: MINIMO_DE_PEDIDOS - 1 })], '2026-11-12');
    expect(poucos).toMatchObject({ status: 'poucos_pedidos', orders: MINIMO_DE_PEDIDOS - 1, ticket_micros: '50000000', by_weekday: [], by_hour: [], peak: null });
    const nenhum = demandaDaLoja([linha({ janela: 'anterior', dow: 5, hora: 20, pedidos: 3 })], '2026-11-12');
    expect(nenhum).toMatchObject({ status: 'sem_pedidos', orders: 0, ticket_micros: null, previous: { orders: 3 }, customers: { new: 0, returning: 0, unknown: 0 } });
  });
});
