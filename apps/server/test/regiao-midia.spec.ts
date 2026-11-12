import { describe, expect, it } from 'vitest';
import {
  cidadesValidas,
  contagem,
  decimal,
  deMicros,
  esperaDaFalhaDaMidia,
  horaDaMeta,
  horasValidas,
  idDoLugar,
  janelaDaMidia,
} from '../src/regiao/midia-paga.js';

// A mídia por região e por hora (plano da região, R4, parte 1), sem banco nem rede: a janela, a hora da Meta, o id do
// lugar do Google, os números como as plataformas mandam (texto, número, micros) e a limpeza das linhas.

describe('a mídia por região e por hora: as contas puras (R4, parte 1)', () => {
  it('a janela são as 4 semanas completas até ontem, a mesma da demanda da loja', () => {
    expect(janelaDaMidia('2026-11-12')).toEqual({ inicio: '2026-10-15', fim: '2026-11-11' });
    expect(janelaDaMidia('2027-01-01')).toEqual({ inicio: '2026-12-04', fim: '2026-12-31' });
  });

  it('a hora da faixa da Meta e o id do lugar do Google; o que vem fora do formato é nulo', () => {
    expect(horaDaMeta('00:00:00 - 00:59:59')).toBe(0);
    expect(horaDaMeta('23:00:00 - 23:59:59')).toBe(23);
    for (const fora of ['24:00:00 - 24:59:59', 'sem hora', '7:00', '', null, 13]) expect(horaDaMeta(fora)).toBeNull();
    expect(idDoLugar('geoTargetConstants/1001773')).toBe('1001773');
    expect(idDoLugar('1001773')).toBe('1001773');
    for (const fora of ["1' OR 1=1", 'geoTargetConstants/', 'geoTargetConstants/12a', '1'.repeat(21), undefined, 7]) expect(idDoLugar(fora)).toBeNull();
  });

  it('os números como as plataformas mandam: contagem em texto, decimal com 6 casas e micros sem ponto flutuante', () => {
    expect([contagem('800'), contagem(12.9), contagem('-1'), contagem('x'), contagem(undefined)]).toEqual([800, 12, 0, 0, 0]);
    expect([decimal('12.5'), decimal(0.1 + 0.2), decimal('-3'), decimal(undefined)]).toEqual(['12.5', '0.3', '0', '0']);
    expect([deMicros('7500000'), deMicros('1000000'), deMicros(1), deMicros('12345678901234567'), deMicros('1e6'), deMicros(undefined)]).toEqual([
      '7.5',
      '1',
      '0.000001',
      '12345678901.234567',
      '0',
      '0',
    ]);
  });

  it('as linhas da hora sem repetir e com dia e hora válidos; as da cidade somadas por dia e lugar', () => {
    const h = (dia: string, hora: number, cliques: number) => ({ dia, hora, impressoes: 1, cliques, gasto: '1', conversoes: null });
    expect(horasValidas([h('2026-11-10', 20, 1), h('2026-11-10', 20, 5), h('2026-11-10', 24, 1), h('10/11/2026', 3, 1)])).toEqual([h('2026-11-10', 20, 5)]);
    const c = (lugar: string, cliques: number, conversoes: string | null) => ({ dia: '2026-11-10', lugar, impressoes: 10, cliques, gasto: '0.5', conversoes });
    expect(cidadesValidas([c('1001773', 2, null), c('1001773', 3, '1.5'), c('x', 9, null)])).toEqual([{ dia: '2026-11-10', lugar: '1001773', impressoes: 20, cliques: 5, gasto: '1', conversoes: '1.5' }]);
    expect(cidadesValidas([c('1001773', 2, null), c('1001773', 3, null)])[0]!.conversoes).toBeNull();
  });

  it('a espera depois da falha, pelo tipo', () => {
    const HORA = 3_600_000;
    expect(esperaDaFalhaDaMidia('permissao', null)).toBe(24 * HORA);
    expect(esperaDaFalhaDaMidia('autenticacao', null)).toBe(24 * HORA);
    expect(esperaDaFalhaDaMidia('limite', 5 * HORA)).toBe(5 * HORA);
    expect(esperaDaFalhaDaMidia('limite', null)).toBe(HORA);
    expect(esperaDaFalhaDaMidia('definitivo', null)).toBe(6 * HORA);
    expect(esperaDaFalhaDaMidia('transitorio', null)).toBe(HORA);
  });
});
