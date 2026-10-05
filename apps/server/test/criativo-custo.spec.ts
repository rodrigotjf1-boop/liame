import { describe, expect, it } from 'vitest';
import { restoDoTeto } from '../src/ai/uso.js';
import { estimativaDoPedido, respostaDoCusto } from '../src/criativo/custo.service.js';

// O custo das peças à vista (A4, X6; D-A4-32), nas funções puras: quanto resta do limite de uso de IA e qual limite
// aperta, de onde sai a estimativa de um pedido e como isso aparece no contrato. O caminho inteiro, com o banco, está
// em `test/db/pecas-custo.spec.ts`.

describe('quanto resta do limite de uso de IA', () => {
  it('é o menor entre o que resta do dia e o que resta do mês, e diz qual dos dois aperta', () => {
    // Sobra 0,50 no dia e 0,20 no mês: quem aperta é o mês.
    expect(restoDoTeto({ gastoDia: 1_500_000n, tetoDia: 2_000_000n, gastoMes: 19_800_000n, tetoMes: 20_000_000n })).toEqual({ resta: 200_000n, aperta: 'mes' });
    expect(restoDoTeto({ gastoDia: 1_500_000n, tetoDia: 2_000_000n, gastoMes: 3_000_000n, tetoMes: 20_000_000n })).toEqual({ resta: 500_000n, aperta: 'dia' });
    // Empate: o do dia (é o que volta primeiro).
    expect(restoDoTeto({ gastoDia: 0n, tetoDia: 2_000_000n, gastoMes: 18_000_000n, tetoMes: 20_000_000n })).toEqual({ resta: 2_000_000n, aperta: 'dia' });
  });

  it('nunca é negativo: a chamada que passou do teto não vira saldo devedor', () => {
    expect(restoDoTeto({ gastoDia: 2_300_000n, tetoDia: 2_000_000n, gastoMes: 5_000_000n, tetoMes: 20_000_000n })).toEqual({ resta: 0n, aperta: 'dia' });
    expect(restoDoTeto({ gastoDia: 100_000n, tetoDia: 2_000_000n, gastoMes: 20_400_000n, tetoMes: 20_000_000n })).toEqual({ resta: 0n, aperta: 'mes' });
  });
});

describe('a estimativa de um pedido de peças', () => {
  it('é a média do histórico da empresa a partir de três pedidos atendidos', () => {
    expect(estimativaDoPedido({ media: 10_400n, amostra: 3 }, 40_000n)).toEqual({ usdMicros: 10_400n, base: 'historico', amostra: 3 });
    expect(estimativaDoPedido({ media: 9_900n, amostra: 20 }, 40_000n)).toEqual({ usdMicros: 9_900n, base: 'historico', amostra: 20 });
    // O histórico vale mesmo sem rota ativa agora (quem diz se dá para pedir é outra regra).
    expect(estimativaDoPedido({ media: 9_900n, amostra: 5 }, null)).toEqual({ usdMicros: 9_900n, base: 'historico', amostra: 5 });
  });

  it('sem histórico que baste, é o teto de custo da rota (o máximo que um pedido deve custar); sem rota, não há estimativa', () => {
    expect(estimativaDoPedido({ media: null, amostra: 0 }, 40_000n)).toEqual({ usdMicros: 40_000n, base: 'teto_da_rota', amostra: 0 });
    expect(estimativaDoPedido({ media: 10_000n, amostra: 2 }, 40_000n)).toEqual({ usdMicros: 40_000n, base: 'teto_da_rota', amostra: 0 });
    expect(estimativaDoPedido({ media: null, amostra: 0 }, null)).toBeNull();
    expect(estimativaDoPedido({ media: 10_000n, amostra: 2 }, null)).toBeNull();
  });
});

describe('o custo no contrato', () => {
  const USO = { gastoDia: 1_250_000n, tetoDia: 2_000_000n, gastoMes: 6_000_000n, tetoMes: 20_000_000n, situacao: 'livre' as const, resta: 750_000n, aperta: 'dia' as const, inicioDoDia: '2026-10-05T03:00:00.000Z' };

  it('vai em micros de dólar, como texto, com a estimativa e se o pedido cabe', () => {
    expect(respostaDoCusto({ uso: USO, pecasHoje: 31_500n, estimativa: { usdMicros: 10_400n, base: 'historico', amostra: 7 }, cabe: true })).toEqual({
      band: 'livre',
      day: { spent_usd_micros: '1250000', ceiling_usd_micros: '2000000' },
      month: { spent_usd_micros: '6000000', ceiling_usd_micros: '20000000' },
      remaining_usd_micros: '750000',
      binding: 'dia',
      pieces_today_usd_micros: '31500',
      request_estimate: { usd_micros: '10400', basis: 'historico', sample: 7 },
      fits: true,
    });
  });

  it('sem rota de modelo, a estimativa vai nula', () => {
    expect(respostaDoCusto({ uso: { ...USO, situacao: 'bloqueado', resta: 0n }, pecasHoje: 0n, estimativa: null, cabe: false })).toMatchObject({ band: 'bloqueado', remaining_usd_micros: '0', request_estimate: null, fits: false });
  });
});
