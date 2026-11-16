import { describe, expect, it } from 'vitest';
import type { AvisoDoRitmoDaMarca } from '../src/campanhas/ritmo-avisos.js';
import { avisosDoGuardado, avisosParaGuardar } from '../src/campanhas/ritmo-conferido.js';

// A conferência do ritmo gravada (plano da região, R7; D-RG-75): os avisos guardados no jsonb da linha do dia voltam
// iguais, com o dinheiro em bigint; o que não tem a forma esperada fica de fora, sem derrubar a Atenção.

const MARCA = '0190d2b0-0000-7000-8000-000000000050';
const avisos: AvisoDoRitmoDaMarca[] = [
  {
    marca: MARCA,
    conta: 'conta-1',
    campanha: 'campanha-1',
    aviso: { ritmo: 'r1', acao: 'a1', recurso: 'campanha:111', nome: 'Gastou demais', tipo: 'gasto_acima', janela: { de: '2026-11-03', ate: '2026-11-09' }, gasto: 5_000_000_000n, permitido: 700_000_000n },
  },
  {
    marca: MARCA,
    conta: 'conta-1',
    campanha: null,
    aviso: { ritmo: 'r1', acao: null, recurso: 'campanha:222', nome: 'Não voltou', tipo: 'nao_voltou', semana: { de: '2026-11-03', ate: '2026-11-09' }, parado: false, deixadaMicros: 90_000_000, baseMicros: 100_000_000 },
  },
  { marca: MARCA, conta: 'conta-2', campanha: 'campanha-3', aviso: { ritmo: 'r2', acao: null, recurso: 'conjunto:333', nome: 'Mexida por fora', tipo: 'saiu', dia: '2026-11-15' } },
];

describe('a conferência do ritmo gravada (R7, D-RG-75)', () => {
  it('guarda sem bigint (o jsonb não tem bigint) e volta igual, com a marca da linha', () => {
    const guardado = avisosParaGuardar(avisos);
    // O que vai ao banco passa pelo JSON sem erro, e o dinheiro vira texto.
    const texto = JSON.stringify(guardado);
    expect(texto).toContain('"gasto":"5000000000"');
    expect(avisosDoGuardado(MARCA, JSON.parse(texto))).toEqual(avisos);
  });

  it('o que não tem a forma esperada fica de fora; o resto passa', () => {
    const bons = JSON.parse(JSON.stringify(avisosParaGuardar(avisos.slice(1)))) as unknown[];
    const ruins = [
      null,
      'texto',
      { conta: 'conta-1' },
      { conta: 1, aviso: { tipo: 'saiu', ritmo: 'r9' } },
      { conta: 'conta-1', aviso: { tipo: 'gasto_acima', ritmo: 'r9', gasto: 'muito', permitido: '1' } },
    ];
    expect(avisosDoGuardado(MARCA, [...ruins, ...bons])).toEqual(avisos.slice(1));
    expect(avisosDoGuardado(MARCA, { nao: 'é lista' })).toEqual([]);
  });
});
