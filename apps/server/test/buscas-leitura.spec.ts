import { describe, expect, it } from 'vitest';
import { esperaDaFalhaDasBuscas, janelaDosDias, semanasParaLer, somarDias } from '../src/buscas/sincronizador-das-buscas.js';

// A6 · Z3 (parte c), sem rede e sem banco: o plano da leitura do Search Console. As datas são as do Search Console, no
// fuso do Pacífico (base §3.3): o "hoje" sai do instante, e não do relógio de quem roda o teste.

const MIN = 60_000;
const HORA = 60 * MIN;
const DIA = 24 * HORA;
/** Quarta-feira, 14/10/2026, 8h no Pacífico (15h UTC). */
const QUARTA = new Date('2026-10-14T15:00:00Z');

describe('o plano da leitura do Search Console', () => {
  it('as datas do calendário', () => {
    expect(somarDias('2026-10-13', -89)).toBe('2026-07-16');
    expect(somarDias('2026-02-28', 1)).toBe('2026-03-01');
    expect(somarDias('2026-12-31', 1)).toBe('2027-01-01');
  });

  it('os dias: 90 até ontem no Pacífico na primeira leitura; depois os últimos 10, ou desde o último lido se a leitura parou (até 90)', () => {
    expect(janelaDosDias({}, QUARTA)).toEqual({ inicio: '2026-07-16', fim: '2026-10-13' });
    // Sem o último dia lido, é como a primeira.
    expect(janelaDosDias({ primeira_em: '2026-10-01T00:00:00Z' }, QUARTA)).toEqual({ inicio: '2026-07-16', fim: '2026-10-13' });
    const lida = (lido_ate: string) => janelaDosDias({ primeira_em: '2026-07-01T00:00:00Z', lido_ate }, QUARTA);
    expect(lida('2026-10-12')).toEqual({ inicio: '2026-10-04', fim: '2026-10-13' });
    expect(lida('2026-09-01')).toEqual({ inicio: '2026-08-30', fim: '2026-10-13' });
    expect(lida('2026-01-01')).toEqual({ inicio: '2026-07-16', fim: '2026-10-13' });
    expect(lida('ontem')).toEqual({ inicio: '2026-07-16', fim: '2026-10-13' });
    // Às 22h de terça no Pacífico já é quarta em UTC: o "ontem" é o do Pacífico (segunda, 12/10).
    expect(janelaDosDias({}, new Date('2026-10-14T05:00:00Z')).fim).toBe('2026-10-12');
  });

  it('as semanas fechadas (de segunda a domingo, no Pacífico): 12 na primeira leitura; depois as 2 últimas, ou desde a última lida (até 12)', () => {
    const primeira = semanasParaLer({}, QUARTA);
    expect(primeira).toHaveLength(12);
    expect([primeira[0], primeira.at(-1)]).toEqual(['2026-07-20', '2026-10-05']);
    expect(primeira.every((s) => new Date(`${s}T00:00:00Z`).getUTCDay() === 1)).toBe(true);
    const lida = (lido_ate: string, agora = QUARTA) => semanasParaLer({ primeira_em: '2026-07-01T00:00:00Z', lido_ate }, agora);
    expect(lida('2026-10-05')).toEqual(['2026-09-28', '2026-10-05']);
    expect(lida('2026-08-03')).toHaveLength(11);
    expect(lida('2026-08-03')[0]).toBe('2026-07-27');
    expect(lida('2025-01-06')).toEqual(primeira);
    // No domingo, a semana ainda não fechou; na segunda seguinte, fechou.
    expect(semanasParaLer({}, new Date('2026-10-11T15:00:00Z')).at(-1)).toBe('2026-09-28');
    expect(semanasParaLer({}, new Date('2026-10-12T15:00:00Z')).at(-1)).toBe('2026-10-05');
    // No domingo à noite no Pacífico já é segunda em UTC, mas a semana segue aberta no Search Console.
    expect(semanasParaLer({}, new Date('2026-10-12T05:00:00Z')).at(-1)).toBe('2026-09-28');
  });

  it('a espera depois de uma falha: a permissão espera um dia; o limite, o que o Google pedir (15 minutos no mínimo, dobrando até 6 h); o resto, 30 minutos dobrando até 12 h; o defeito, 6 h no mínimo', () => {
    expect(esperaDaFalhaDasBuscas({ tipo: 'permissao', esperarMs: null }, 1)).toBe(DIA);
    expect(esperaDaFalhaDasBuscas({ tipo: 'limite', esperarMs: 15 * MIN }, 1)).toBe(15 * MIN);
    expect(esperaDaFalhaDasBuscas({ tipo: 'limite', esperarMs: 60_000 }, 3)).toBe(60 * MIN);
    expect(esperaDaFalhaDasBuscas({ tipo: 'limite', esperarMs: null }, 10)).toBe(6 * HORA);
    expect(esperaDaFalhaDasBuscas({ tipo: 'limite', esperarMs: 8 * HORA }, 1)).toBe(8 * HORA);
    expect(esperaDaFalhaDasBuscas({ tipo: 'transitorio', esperarMs: null }, 1)).toBe(30 * MIN);
    expect(esperaDaFalhaDasBuscas({ tipo: 'transitorio', esperarMs: null }, 6)).toBe(12 * HORA);
    expect(esperaDaFalhaDasBuscas({ tipo: 'definitivo', esperarMs: null }, 1)).toBe(6 * HORA);
    expect(esperaDaFalhaDasBuscas({ tipo: 'interno', esperarMs: null }, 1)).toBe(6 * HORA);
  });
});
