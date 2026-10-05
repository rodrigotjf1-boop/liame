import { describe, expect, it } from 'vitest';
import { conferir, estaComoFicou, type LeituraDoDia, type MudancaParaConferir, situacaoDaLeitura, verbaDaLeitura } from '../src/actions/conferencia-do-gasto.js';
import { menosDias } from '../src/results/fora-do-normal.js';

// A4 · X4, parte 2 (D-A4-24; critério A4-8): a conferência do gasto de uma mudança, em funções puras. Execução (o que
// o Liame deixou) → informado (o que a plataforma mostra na leitura do dia) → gasto real. O gasto é conferido pela
// semana, com a verba de cada dia; quem mudou na plataforma depois não gera erro; o pausado não pode gastar.

const REAL = 1_000_000n;
const HOJE = '2026-09-29';
/** O mesmo gasto em cada um dos `n` dias antes de hoje, com exceções por dia. */
function gastos(n: number, porDia: bigint, outros: Record<string, bigint> = {}): Map<string, bigint> {
  const m = new Map<string, bigint>();
  for (let d = 1; d <= n; d++) m.set(menosDias(HOJE, d), porDia);
  for (const [dia, v] of Object.entries(outros)) m.set(dia, v);
  return m;
}
const leitura = (over: Partial<LeituraDoDia> = {}): LeituraDoDia => ({ hoje: HOJE, informado: { status: 'ativo', verbaDiaria: 60n * REAL }, gastoPorDia: new Map(), ...over });
/** A Combo sexta: a verba foi de R$ 55,00 para R$ 60,00 em 12/09. */
const aumento: MudancaParaConferir = { executadaEm: '2026-09-12', antes: { status: 'ativo', verbaDiaria: 55n * REAL }, depois: { status: 'ativo', verbaDiaria: 60n * REAL } };

describe('a conferência do gasto de uma mudança', () => {
  it('confere: a plataforma mostra o que o Liame deixou e a semana coube em 7 vezes a verba diária', () => {
    // 16 dias depois da mudança, a R$ 58,93 por dia em média; a semana somou R$ 412,51.
    const c = conferir(aumento, leitura({ gastoPorDia: gastos(17, 58_930_000n) }));
    expect(c).toEqual({ status: 'confere', janela: { de: '2026-09-22', ate: '2026-09-28' }, gasto: 412_510_000n, permitido: 420n * REAL, diasDepois: 16, gastoDepois: 942_880_000n });
  });

  it('D-A4-24: um dia acima da verba não é erro; a semana acima de 7 vezes a verba, sim', () => {
    // Um dia com 75% a mais e os outros abaixo: a semana fecha em R$ 420,00 cravados.
    const umDiaAlto = gastos(7, 52_500_000n, { '2026-09-26': 105n * REAL });
    expect(conferir(aumento, leitura({ gastoPorDia: umDiaAlto }))).toMatchObject({ status: 'confere', gasto: 420n * REAL, permitido: 420n * REAL });
    // A semana do protótipo: R$ 471,80 gastos, e a verba de R$ 60,00 por dia iria até R$ 420,00.
    const acima = gastos(7, 67_400_000n);
    expect(conferir(aumento, leitura({ gastoPorDia: acima }))).toMatchObject({ status: 'acima', gasto: 471_800_000n, permitido: 420n * REAL, janela: { de: '2026-09-22', ate: '2026-09-28' } });
    // Um centavo acima já é acima; a fração de centavo do gasto vai ao centavo antes de comparar.
    expect(conferir(aumento, leitura({ gastoPorDia: gastos(7, 60n * REAL, { '2026-09-28': 60_010_000n }) })).status).toBe('acima');
    expect(conferir(aumento, leitura({ gastoPorDia: gastos(7, 60n * REAL, { '2026-09-28': 60_004_999n }) })).status).toBe('confere');
  });

  it('a mudança no meio da semana: cada dia com a verba dele, e o dia da mudança com a maior das duas', () => {
    // Mudou em 25/09: 22, 23 e 24 valem R$ 55,00; 25 (o dia da mudança), 26, 27 e 28 valem R$ 60,00.
    const noMeio: MudancaParaConferir = { ...aumento, executadaEm: '2026-09-25' };
    const permitido = 3n * 55n * REAL + 4n * 60n * REAL;
    expect(conferir(noMeio, leitura({ gastoPorDia: gastos(7, 57n * REAL) }))).toMatchObject({ status: 'confere', gasto: 399n * REAL, permitido, diasDepois: 3, gastoDepois: 171n * REAL });
    expect(conferir(noMeio, leitura({ gastoPorDia: gastos(7, 58n * REAL) }))).toMatchObject({ status: 'acima', gasto: 406n * REAL, permitido });
    // Numa redução, o dia da mudança ainda vale a verba de antes (a maior).
    const reducao: MudancaParaConferir = { executadaEm: '2026-09-28', antes: { status: 'ativo', verbaDiaria: 44n * REAL }, depois: { status: 'ativo', verbaDiaria: 40n * REAL } };
    const r = conferir(reducao, leitura({ informado: { status: 'ativo', verbaDiaria: 40n * REAL }, gastoPorDia: gastos(7, 44n * REAL) }));
    expect(r).toMatchObject({ status: 'confere', gasto: 308n * REAL, permitido: 308n * REAL, diasDepois: 0, gastoDepois: 0n });
  });

  it('alguém mudou na plataforma depois: não é erro, e o gasto deixa de ser conferido por esta mudança', () => {
    const muitoGasto = gastos(7, 90n * REAL);
    // Outra verba, outra situação, ou o objeto saiu da lista da conta.
    expect(conferir(aumento, leitura({ informado: { status: 'ativo', verbaDiaria: 45n * REAL }, gastoPorDia: muitoGasto })).status).toBe('mudou');
    expect(conferir(aumento, leitura({ informado: { status: 'pausado', verbaDiaria: 60n * REAL }, gastoPorDia: muitoGasto })).status).toBe('mudou');
    expect(conferir(aumento, leitura({ informado: null, gastoPorDia: muitoGasto })).status).toBe('mudou');
    expect(conferir(aumento, leitura({ informado: { status: 'arquivado', verbaDiaria: 60n * REAL } })).status).toBe('mudou');
    // A verba sumiu do objeto (foi para outro nível): também é mudança.
    expect(conferir(aumento, leitura({ informado: { status: 'ativo', verbaDiaria: null } })).status).toBe('mudou');
  });

  it('pausado pelo Liame: nos dias inteiros depois da pausa, não pode gastar', () => {
    // O conjunto "Noite · quem já pediu" (R$ 12,00 por dia) pausado em 26/09.
    const pausa: MudancaParaConferir = { executadaEm: '2026-09-26', antes: { status: 'ativo', verbaDiaria: 12n * REAL }, depois: { status: 'pausado', verbaDiaria: 12n * REAL } };
    const pausado = { status: 'pausado', verbaDiaria: 12n * REAL };
    // Gastou até o dia da pausa e parou: a semana vale 5 dias de R$ 12,00 (22 a 26) e zero depois.
    const parou = gastos(7, 12n * REAL, { '2026-09-27': 0n, '2026-09-28': 0n });
    expect(conferir(pausa, leitura({ informado: pausado, gastoPorDia: parou }))).toEqual({
      status: 'confere',
      janela: { de: '2026-09-22', ate: '2026-09-28' },
      gasto: 60n * REAL,
      permitido: 60n * REAL,
      diasDepois: 2,
      gastoDepois: 0n,
    });
    // Seguiu gastando depois de pausado: acima.
    expect(conferir(pausa, leitura({ informado: pausado, gastoPorDia: gastos(7, 12n * REAL) }))).toMatchObject({ status: 'acima', gasto: 84n * REAL, permitido: 60n * REAL, gastoDepois: 24n * REAL });
  });

  it('sem verba própria: o anúncio pausado é conferido só nos dias depois da pausa; o que voltou a rodar não tem com o que comparar', () => {
    const anuncio = { status: 'pausado', verbaDiaria: null };
    const pausa: MudancaParaConferir = { executadaEm: '2026-09-25', antes: { status: 'ativo', verbaDiaria: null }, depois: { status: 'pausado', verbaDiaria: null } };
    // Antes da pausa e no dia dela, não se sabe quanto podia gastar: comparam-se os dias 26, 27 e 28, que valem zero.
    expect(conferir(pausa, leitura({ informado: anuncio, gastoPorDia: gastos(7, 20n * REAL, { '2026-09-26': 0n, '2026-09-27': 0n, '2026-09-28': 0n }) }))).toEqual({
      status: 'confere',
      janela: { de: '2026-09-26', ate: '2026-09-28' },
      gasto: 0n,
      permitido: 0n,
      diasDepois: 3,
      gastoDepois: 0n,
    });
    expect(conferir(pausa, leitura({ informado: anuncio, gastoPorDia: gastos(7, 20n * REAL) }))).toMatchObject({ status: 'acima', janela: { de: '2026-09-26', ate: '2026-09-28' }, gasto: 60n * REAL, permitido: 0n });
    // Pausado ontem: ainda não há um dia inteiro depois da pausa para conferir.
    const ontem = conferir({ ...pausa, executadaEm: '2026-09-28' }, leitura({ informado: anuncio, gastoPorDia: gastos(7, 20n * REAL) }));
    expect(ontem).toMatchObject({ status: 'confere', permitido: null, janela: { de: '2026-09-22', ate: '2026-09-28' }, gasto: 140n * REAL, diasDepois: 0 });
    // Retomado, sem verba própria: a verba que vale é a de outro nível. Mostra o gasto, não compara.
    const retomado: MudancaParaConferir = { executadaEm: '2026-09-20', antes: { status: 'pausado', verbaDiaria: null }, depois: { status: 'ativo', verbaDiaria: null } };
    expect(conferir(retomado, leitura({ informado: { status: 'ativo', verbaDiaria: null }, gastoPorDia: gastos(8, 500n * REAL) }))).toMatchObject({ status: 'confere', permitido: null, diasDepois: 8, gastoDepois: 4_000n * REAL });
  });

  it('retomado com verba própria: zero antes, a verba do dia da retomada em diante', () => {
    const retomada: MudancaParaConferir = { executadaEm: '2026-09-26', antes: { status: 'pausado', verbaDiaria: 30n * REAL }, depois: { status: 'ativo', verbaDiaria: 30n * REAL } };
    const informado = { status: 'ativo', verbaDiaria: 30n * REAL };
    // 26, 27 e 28 valem R$ 30,00 cada; antes disso, pausado, nada.
    const soDepois = new Map([['2026-09-26', 30n * REAL], ['2026-09-27', 35n * REAL], ['2026-09-28', 25n * REAL]]);
    expect(conferir(retomada, leitura({ informado, gastoPorDia: soDepois }))).toMatchObject({ status: 'confere', gasto: 90n * REAL, permitido: 90n * REAL, diasDepois: 2, gastoDepois: 60n * REAL });
    // Gastou num dia em que estava pausado (antes da retomada): a semana passa do permitido.
    expect(conferir(retomada, leitura({ informado, gastoPorDia: new Map([...soDepois, ['2026-09-24', 5n * REAL]]) })).status).toBe('acima');
  });

  it('a plataforma mostra o objeto como o Liame deixou?', () => {
    const depois = { status: 'ativo' as const, verbaDiaria: 60n * REAL };
    expect(estaComoFicou(depois, { status: 'ativo', verbaDiaria: 60n * REAL })).toBe(true);
    expect(estaComoFicou(depois, { status: 'ativo', verbaDiaria: 60n * REAL + 10_000n })).toBe(false);
    // Sem verba no objeto, a verba informada não entra na comparação.
    expect(estaComoFicou({ status: 'pausado', verbaDiaria: null }, { status: 'pausado', verbaDiaria: 99n * REAL })).toBe(true);
    expect(estaComoFicou({ status: 'pausado', verbaDiaria: null }, null)).toBe(false);
  });

  it('a leitura diária em palavras do pedido: a situação e a verba que mora no objeto', () => {
    expect(['ativa', 'pausada', 'arquivada', 'removida', 'desconhecida', 'outra'].map(situacaoDaLeitura)).toEqual(['ativo', 'pausado', 'arquivado', 'removido', 'desconhecido', 'desconhecido']);
    // A plataforma manda zero quando a verba fica em outro nível.
    expect([verbaDaLeitura('60000000'), verbaDaLeitura(0), verbaDaLeitura('0'), verbaDaLeitura(null), verbaDaLeitura(undefined)]).toEqual([60n * REAL, null, null, null, null]);
  });
});
