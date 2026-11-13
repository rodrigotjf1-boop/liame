import { describe, expect, it } from 'vitest';
import {
  chove,
  diaDaSemana,
  FAIXA_DO_RITMO,
  PASSO_DO_PESO,
  pesosDaSemana,
  problemasDaVerba,
  semanaQueVem,
  VERBA_MINIMA_NO_RITMO_MICROS,
  verbaDoRitmo,
} from '../src/regiao/ritmo-da-semana.js';

// R7 (D-RG-58 a D-RG-60), sem rede e sem banco: a semana que vem, o peso de cada dia (os pedidos da loja por dia da
// semana, a chuva e as datas) dentro dos limites, e a verba de cada campanha em centavos inteiros, sem passar dos 10%
// por mudança, do teto por campanha nem da verba que a semana gastaria sem o ritmo.

/** A semana do protótipo: 05/10 a 11/10/2026 (o 5º dia útil cai na quarta; 12/10 é feriado e Dia das Crianças). */
const SEMANA = semanaQueVem('2026-10-04').dias;
/** Os pedidos por dia da semana do exemplo (0 = domingo): 16%, 9%, 10%, 12%, 14%, 19% e 20%. */
const PEDIDOS = [160, 90, 100, 120, 140, 190, 200];
const soma = (l: readonly number[]) => l.reduce((s, v) => s + v, 0);

/**
 * Os limites do peso: a faixa, o passo de um dia para o outro (a partir de 1) e a semana em até 7, usando a verba
 * inteira (o ritmo muda o dia, não o total: a semana nunca fica muito abaixo de 7).
 */
function confereOsPesos(pesos: readonly number[]): void {
  let antes = 1;
  for (const p of pesos) {
    expect(p).toBeGreaterThanOrEqual(FAIXA_DO_RITMO.minimo - 1e-4);
    expect(p).toBeLessThanOrEqual(FAIXA_DO_RITMO.maximo + 1e-4);
    expect(Math.abs(p / antes - 1)).toBeLessThanOrEqual(PASSO_DO_PESO + 1e-3);
    antes = p;
  }
  expect(soma(pesos)).toBeLessThanOrEqual(7 + 1e-3);
  expect(soma(pesos)).toBeGreaterThan(6.99);
}

describe('o ritmo da semana (R7)', () => {
  it('a semana que vem: da próxima segunda ao domingo, de qualquer dia da semana', () => {
    expect(semanaQueVem('2026-10-04')).toMatchObject({ de: '2026-10-05', ate: '2026-10-11' }); // domingo
    expect(semanaQueVem('2026-10-05')).toMatchObject({ de: '2026-10-12', ate: '2026-10-18' }); // segunda: a seguinte
    expect(semanaQueVem('2026-10-07')).toMatchObject({ de: '2026-10-12', ate: '2026-10-18' }); // quarta
    expect(SEMANA).toHaveLength(7);
    expect(SEMANA.map(diaDaSemana)).toEqual([1, 2, 3, 4, 5, 6, 0]);
    // A virada do ano.
    expect(semanaQueVem('2026-12-30')).toMatchObject({ de: '2027-01-04', ate: '2027-01-10' });
  });

  it('a chuva: as condições do CPTEC com sol ou nuvem não contam; o resto conta', () => {
    expect(['cl', 'ps', 'pn', 'vn', 'e', 'n', 'nv'].map(chove)).toEqual([false, false, false, false, false, false, false]);
    expect(['c', 'pc', 'pt', 'cn', 't', 'ci'].map(chove)).toEqual([true, true, true, true, true, true]);
  });

  it('os pesos pelos pedidos da loja: menos nos dias fracos, mais nos fortes, dentro dos limites e somando 7', () => {
    const dias = pesosDaSemana({ dias: SEMANA, pedidosPorDiaDaSemana: PEDIDOS, previsao: [], datas: [] });
    const pesos = dias.map((d) => d.weight);
    confereOsPesos(pesos);
    expect(soma(pesos)).toBeGreaterThan(6.95); // usa a semana inteira: muda o dia, não o total
    const [seg, ter, , , sex, sab, dom] = pesos as [number, number, number, number, number, number, number];
    expect(seg).toBeLessThan(1);
    expect(ter).toBeLessThan(1);
    expect(sab).toBeGreaterThan(1.1);
    expect(sab).toBeGreaterThan(sex);
    expect(dom).toBeGreaterThan(1);
    expect(dias[0]!.reasons).toEqual([{ kind: 'pedidos', share_pct: 9 }]);
    expect(dias[5]!.reasons).toEqual([{ kind: 'pedidos', share_pct: 20 }]);
  });

  it('a chuva e as datas: o porquê entra no dia (a data do dia, a véspera do feriado; o prazo do salário só no dia)', () => {
    const dias = pesosDaSemana({
      dias: SEMANA,
      pedidosPorDiaDaSemana: PEDIDOS,
      previsao: [
        { day: '2026-10-08', condition: 'pt', description: 'Pancadas de chuva à tarde', min: 19, max: 24 },
        { day: '2026-10-09', condition: 'ps', description: 'Predomínio de sol', min: 20, max: 29 },
      ],
      datas: [
        { day: '2026-10-07', name: 'Prazo do salário de setembro (5º dia útil)', kind: 'salario' },
        { day: '2026-10-12', name: 'Nossa Senhora Aparecida', kind: 'feriado_nacional' },
        { day: '2026-10-12', name: 'Dia das Crianças', kind: 'varejo' },
      ],
    });
    confereOsPesos(dias.map((d) => d.weight));
    const porDia = Object.fromEntries(dias.map((d) => [d.day, d.reasons.map((r) => r.kind + ('eve' in r && r.eve ? ':vespera' : ''))]));
    expect(porDia['2026-10-06']).toEqual(['pedidos']); // a véspera do prazo do salário não conta
    expect(porDia['2026-10-07']).toEqual(['pedidos', 'data']);
    expect(porDia['2026-10-08']).toEqual(['pedidos', 'chuva']);
    expect(porDia['2026-10-09']).toEqual(['pedidos']); // sol
    expect(porDia['2026-10-11']).toEqual(['pedidos', 'data:vespera', 'data:vespera']);
    // O dia com chuva pesa mais do que pesaria sem ela.
    const semChuva = pesosDaSemana({ dias: SEMANA, pedidosPorDiaDaSemana: PEDIDOS, previsao: [], datas: [] });
    expect(dias[3]!.weight).toBeGreaterThanOrEqual(semChuva[3]!.weight);
  });

  it('sem pedidos que bastem: a referência do setor, mais peso de sexta a domingo', () => {
    for (const pedidos of [null, [0, 0, 0, 0, 0, 0, 0]]) {
      const dias = pesosDaSemana({ dias: SEMANA, pedidosPorDiaDaSemana: pedidos, previsao: [], datas: [] });
      confereOsPesos(dias.map((d) => d.weight));
      expect(dias.every((d) => d.reasons[0]!.kind === 'setor')).toBe(true);
      expect(dias[5]!.weight).toBeGreaterThan(dias[1]!.weight); // sábado × terça
    }
  });

  it('quase todos os pedidos num dia só: os outros dias sobem até a semana usar a verba inteira, e o dia forte fica acima de hoje', () => {
    // 22 dos 23 pedidos na terça (o caso do teste de banco da demanda).
    const dias = pesosDaSemana({ dias: SEMANA, pedidosPorDiaDaSemana: [0, 0, 22, 0, 1, 0, 0], previsao: [], datas: [] });
    const pesos = dias.map((d) => d.weight);
    confereOsPesos(pesos);
    expect(Math.max(...pesos)).toBe(pesos[1]); // a terça
    expect(pesos[1]).toBeGreaterThan(1);
    expect(dias[1]!.reasons).toEqual([{ kind: 'pedidos', share_pct: 96 }]);
  });

  it('a verba de cada campanha: centavos inteiros, até 10% por mudança, dentro da faixa e sem gastar mais na semana', () => {
    const pesos = pesosDaSemana({ dias: SEMANA, pedidosPorDiaDaSemana: PEDIDOS, previsao: [], datas: [] }).map((d) => d.weight);
    for (const base of [60_000_000, 40_000_000, 18_000_000, 10_000_000, 137_530_000]) {
      const v = verbaDoRitmo(base, pesos, null);
      expect(v.ok, String(base)).toBe(true);
      if (!v.ok) continue;
      expect(problemasDaVerba(base, v.dias, null)).toEqual([]);
      expect(soma(v.dias)).toBeLessThanOrEqual(base * 7);
      expect(soma(v.dias)).toBeGreaterThan(base * 7 * 0.98);
      expect(v.dias.every((d) => d % 10_000 === 0)).toBe(true);
    }
  });

  it('quem fica fora do ritmo: a verba pequena, a fração de centavo e a campanha já acima do teto; o teto segura o dia forte', () => {
    const pesos = pesosDaSemana({ dias: SEMANA, pedidosPorDiaDaSemana: PEDIDOS, previsao: [], datas: [] }).map((d) => d.weight);
    expect(verbaDoRitmo(VERBA_MINIMA_NO_RITMO_MICROS - 10_000, pesos, null)).toEqual({ ok: false, motivo: 'verba_pequena' });
    expect(verbaDoRitmo(60_000_001, pesos, null)).toEqual({ ok: false, motivo: 'fracao_de_centavo' });
    expect(verbaDoRitmo(60_000_000, pesos, 50_000_000)).toEqual({ ok: false, motivo: 'acima_do_teto' });
    const comTeto = verbaDoRitmo(60_000_000, pesos, 64_000_000);
    expect(comTeto.ok).toBe(true);
    if (comTeto.ok) {
      expect(Math.max(...comTeto.dias)).toBe(64_000_000);
      expect(problemasDaVerba(60_000_000, comTeto.dias, 64_000_000)).toEqual([]);
    }
  });

  it('a conferência pega o que passa dos limites', () => {
    expect(problemasDaVerba(60_000_000, [66_010_000, 60_000_000], null)).toContain('dia 1: muda mais de 10%');
    expect(problemasDaVerba(60_000_000, [66_000_000, 72_600_000], null)).toContain('dia 2: fora da faixa');
    expect(problemasDaVerba(60_000_000, [66_000_000, 66_000_000], null)).toContain('a semana gasta mais do que sem o ritmo');
    expect(problemasDaVerba(60_000_000, [60_000_000, 60_005_000], null)).toContain('dia 2: fração de centavo');
    expect(problemasDaVerba(60_000_000, [54_000_000, 59_400_000], 55_000_000)).toContain('dia 2: acima do teto por campanha');
    expect(problemasDaVerba(60_000_000, [54_000_000, 59_400_000, 65_340_000], null)).toEqual([]);
  });

  it('em muitas semanas diferentes, os pesos e a verba nunca saem dos limites', () => {
    // Uma sequência fixa (sem acaso de verdade): o teste dá o mesmo resultado sempre.
    let semente = 20261113;
    const proximo = () => {
      semente = (semente * 1103515245 + 12345) % 2147483648;
      return semente / 2147483648;
    };
    for (let i = 0; i < 400; i++) {
      const pedidos = Array.from({ length: 7 }, () => Math.floor(proximo() * 300));
      const previsao = SEMANA.filter(() => proximo() < 0.3).map((day) => ({ day, condition: 'pc', description: 'Pancadas de chuva', min: 18, max: 25 }));
      const datas = SEMANA.filter(() => proximo() < 0.2).map((day) => ({ day, name: 'Data', kind: 'varejo' }));
      const pesos = pesosDaSemana({ dias: SEMANA, pedidosPorDiaDaSemana: pedidos, previsao, datas }).map((d) => d.weight);
      confereOsPesos(pesos);
      const base = (1000 + Math.floor(proximo() * 30_000)) * 10_000; // de R$ 10,00 a R$ 310,00, em centavos inteiros
      const teto = proximo() < 0.3 ? Math.floor(base * (1 + proximo() * 0.3) / 10_000) * 10_000 : null;
      const v = verbaDoRitmo(base, pesos, teto);
      expect(v.ok, `${base} ${teto} ${pesos.join(' ')}`).toBe(true);
      if (v.ok) expect(problemasDaVerba(base, v.dias, teto)).toEqual([]);
    }
  });
});
