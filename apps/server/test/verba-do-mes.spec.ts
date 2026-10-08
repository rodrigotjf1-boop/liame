import type { PolicyDocument } from '@liame/contracts';
import { describe, expect, it } from 'vitest';
import { aoCentavo, cabeNoMes, type ContaDeAnuncio, contaDoMes, diasEntre, fraseDeNaoCaber, gastoDeCadaDia, linhaDaConta, mesDe, nomeDoMes } from '../src/actions/verba-do-mes.js';
import { type LoadedPolicy, PLATFORM_POLICY } from '../src/policy/engine.js';
import { comTetoDaVerba, regrasDaVerba, temOTetoDaVerba, tetoDaVerba } from '../src/policy/teto-da-verba.js';
import { reais } from '../src/results/atencao-ciclo.js';
import { menosDias } from '../src/results/fora-do-normal.js';

// A4 · X4 (D-A4-19): a conta da verba do mês, em funções puras. O teto do mês conta tudo o que as contas de anúncio
// gastam; o pedido que faz o gasto subir só passa se couber na previsão de fechamento. Aqui: o calendário do mês, a
// conta de cada conta de anúncio (lida hoje, atrasada, nunca lida), a soma por plataforma, o gasto de cada dia (o
// desenho "o mês, dia a dia"), o que pesa hoje, a
// conferência do pedido, a frase da recusa e o teto por campanha na política.

const REAL = 1_000_000n;
const nbsp = (s: string) => s.replaceAll('R$ ', `R$${String.fromCharCode(160)}`);
/** Dias seguidos com o mesmo gasto, de `de` a `ate`. */
function gastos(de: string, ate: string, porDia: bigint, outros: Array<[string, bigint]> = []): Map<string, bigint> {
  const m = new Map<string, bigint>();
  for (let d = de; d <= ate; d = menosDias(d, -1)) m.set(d, porDia);
  for (const [dia, v] of outros) m.set(dia, v);
  return m;
}
const conta = (over: Partial<ContaDeAnuncio> = {}): ContaDeAnuncio => ({ id: 'a1', provider: 'meta_ads', lidoAte: '2026-09-28', lidoEm: new Date('2026-09-29T09:12:00Z'), gastoPorDia: new Map(), ...over });

describe('o mês corrente', () => {
  it('do primeiro ao último dia, com os dias que faltam contando hoje', () => {
    // 29/09: faltam o dia 29 e o dia 30 (o gasto lido vai até ontem, 28).
    expect(mesDe('2026-09-29')).toEqual({ periodo: '2026-09', inicio: '2026-09-01', fim: '2026-09-30', hoje: '2026-09-29', ontem: '2026-09-28', diasQueFaltam: 2 });
    expect(mesDe('2026-10-05')).toMatchObject({ fim: '2026-10-31', diasQueFaltam: 27 });
    // No último dia falta ele mesmo; no primeiro, o mês inteiro, e ontem é do mês anterior.
    expect(mesDe('2026-12-31')).toMatchObject({ fim: '2026-12-31', diasQueFaltam: 1 });
    expect(mesDe('2027-01-01')).toMatchObject({ periodo: '2027-01', ontem: '2026-12-31', diasQueFaltam: 31 });
    // Fevereiro, com e sem dia 29.
    expect([mesDe('2028-02-10').fim, mesDe('2027-02-10').fim]).toEqual(['2028-02-29', '2027-02-28']);
    expect([diasEntre('2026-09-28', '2026-09-30'), diasEntre('2026-10-02', '2026-09-30')]).toEqual([2, -2]);
    expect([nomeDoMes('2026-09'), nomeDoMes('2027-03')]).toEqual(['setembro', 'março']);
  });

  it('o centavo: metade para cima', () => {
    expect([aoCentavo(12_344_999n), aoCentavo(12_345_000n), aoCentavo(0n)]).toEqual([12_340_000n, 12_350_000n, 0n]);
  });
});

describe('a conta de uma conta de anúncio', () => {
  const mes = mesDe('2026-09-29');

  it('lida hoje: o gasto do mês até ontem, o ritmo dos 7 dias inteiros e a previsão pelos dias que faltam', () => {
    // R$ 100 por dia de 01/09 a 21/09 e R$ 140 por dia de 22/09 a 28/09 (os 7 dias do ritmo).
    const c = conta({ gastoPorDia: gastos('2026-09-01', '2026-09-21', 100n * REAL, [...gastos('2026-09-22', '2026-09-28', 140n * REAL)]) });
    expect(linhaDaConta(c, mes)).toMatchObject({ gasto: 3_080n * REAL, ritmo: 140n * REAL, previsto: 3_360n * REAL, diasPrevistos: 2, lidoAte: '2026-09-28', atrasada: false });
  });

  it('só entra o que a leitura cobre: hoje fica de fora, agosto não soma no mês, e o dia antes da janela não entra no ritmo', () => {
    const c = conta({
      gastoPorDia: new Map([
        ['2026-08-31', 500n * REAL], // mês anterior: fora do gasto do mês e fora dos 7 dias
        ['2026-09-01', 70n * REAL], // primeiro dia do mês: entra no gasto
        ['2026-09-21', 700n * REAL], // a véspera da janela de 7 dias: no gasto, fora do ritmo
        ['2026-09-22', 7n * REAL], // primeiro dia da janela
        ['2026-09-28', 14n * REAL], // ontem: último dia da janela
        ['2026-09-29', 999n * REAL], // hoje: só tem dado amanhã
      ]),
    });
    expect(linhaDaConta(c, mes)).toMatchObject({ gasto: 791n * REAL, ritmo: 3n * REAL, previsto: 797n * REAL });
  });

  it('o ritmo e o gasto ficam em centavos inteiros: o que a tela mostra fecha a conta', () => {
    // R$ 100,00 em 7 dias: R$ 14,2857… por dia vira R$ 14,29. O gasto com fração de centavo (Google) vai ao centavo.
    const c = conta({ gastoPorDia: new Map([['2026-09-28', 100n * REAL + 4_999n]]) });
    const l = linhaDaConta(c, mes);
    expect([l.gasto, l.ritmo, l.previsto]).toEqual([100n * REAL, 14_290_000n, 128_580_000n]);
    expect(l.previsto).toBe(l.gasto + l.ritmo * BigInt(l.diasPrevistos));
  });

  it('atrasada (lida ontem): o gasto vale até anteontem, e o dia que falta entra pelo ritmo', () => {
    const c = conta({ lidoAte: '2026-09-27', gastoPorDia: gastos('2026-09-01', '2026-09-28', 100n * REAL) });
    // O dia 28 está na tabela (de uma leitura parcial), mas a leitura boa só cobre até o 27.
    expect(linhaDaConta(c, mes)).toMatchObject({ gasto: 2_700n * REAL, ritmo: 100n * REAL, previsto: 3_000n * REAL, diasPrevistos: 3, lidoAte: '2026-09-27', atrasada: true });
  });

  it('parada desde antes do mês: nada lido neste mês, e o mês inteiro é previsão pelo último ritmo', () => {
    const c = conta({ lidoAte: '2026-08-25', gastoPorDia: gastos('2026-08-01', '2026-08-25', 50n * REAL) });
    expect(linhaDaConta(c, mes)).toMatchObject({ gasto: 0n, ritmo: 50n * REAL, previsto: 1_500n * REAL, diasPrevistos: 30, atrasada: true });
  });

  it('nunca lida: zero de gasto e de ritmo, e a conta aparece como atrasada', () => {
    const c = conta({ lidoAte: null, lidoEm: null, gastoPorDia: gastos('2026-09-01', '2026-09-28', 100n * REAL) });
    expect(linhaDaConta(c, mes)).toMatchObject({ gasto: 0n, ritmo: 0n, previsto: 0n, diasPrevistos: 30, lidoAte: null, atrasada: true });
  });

  it('no primeiro dia do mês: nada gasto ainda, e a previsão é o ritmo do fim do mês anterior vezes o mês inteiro', () => {
    const c = conta({ lidoAte: '2026-09-30', gastoPorDia: gastos('2026-09-01', '2026-09-30', 100n * REAL) });
    expect(linhaDaConta(c, mesDe('2026-10-01'))).toMatchObject({ gasto: 0n, ritmo: 100n * REAL, previsto: 3_100n * REAL, diasPrevistos: 31, atrasada: false });
  });

  it('a leitura nunca vale além de ontem, mesmo que o relógio da conta diga outra coisa', () => {
    const c = conta({ lidoAte: '2026-09-29', gastoPorDia: gastos('2026-09-22', '2026-09-29', 10n * REAL) });
    expect(linhaDaConta(c, mes)).toMatchObject({ gasto: 70n * REAL, lidoAte: '2026-09-28', diasPrevistos: 2, atrasada: false });
  });
});

describe('a conta do mês', () => {
  const meta = conta({ id: 'm', gastoPorDia: gastos('2026-09-01', '2026-09-28', 120n * REAL) });
  const google = conta({ id: 'g', provider: 'google_ads', gastoPorDia: gastos('2026-09-01', '2026-09-28', 56n * REAL) });

  it('soma as plataformas, o que pesa hoje até o fim do mês e o que sobra do teto', () => {
    const c = contaDoMes({ hoje: '2026-09-29', contas: [google, meta], pesamPorDia: 6n * REAL, teto: 5_500n * REAL });
    // A Meta vem antes do Google, seja qual for a ordem de entrada.
    expect(c.plataformas.map((p) => [p.provider, p.contas, p.gasto, p.ritmo, p.previsto, p.diasPrevistos, p.atrasada])).toEqual([
      ['meta_ads', 1, 3_360n * REAL, 120n * REAL, 3_600n * REAL, 2, false],
      ['google_ads', 1, 1_568n * REAL, 56n * REAL, 1_680n * REAL, 2, false],
    ]);
    expect(c).toMatchObject({ gasto: 4_928n * REAL, ritmo: 176n * REAL, previsto: 5_280n * REAL, diasPrevistos: 2, pesamPorDia: 6n * REAL, pesam: 12n * REAL, sobra: 208n * REAL });
    // As parcelas fecham o total.
    expect(c.previsto).toBe(c.gasto + c.ritmo * 2n);
  });

  it('sem teto não há sobra; sem conta de anúncio, tudo é zero', () => {
    expect(contaDoMes({ hoje: '2026-09-29', contas: [meta], pesamPorDia: 0n, teto: null })).toMatchObject({ sobra: null, teto: null, pesam: 0n });
    expect(contaDoMes({ hoje: '2026-09-29', contas: [], pesamPorDia: 0n, teto: 100n * REAL })).toMatchObject({ plataformas: [], gasto: 0n, previsto: 0n, diasPrevistos: null, sobra: 100n * REAL });
  });

  it('duas contas da mesma plataforma lidas até dias diferentes: a plataforma soma as duas e diz a mais atrasada', () => {
    const atrasada = conta({ id: 'm2', lidoAte: '2026-09-27', lidoEm: new Date('2026-09-28T09:00:00Z'), gastoPorDia: gastos('2026-09-01', '2026-09-27', 10n * REAL) });
    const c = contaDoMes({ hoje: '2026-09-29', contas: [meta, atrasada, google], pesamPorDia: 0n, teto: null });
    expect(c.plataformas[0]).toMatchObject({ provider: 'meta_ads', contas: 2, gasto: 3_630n * REAL, ritmo: 130n * REAL, previsto: 3_900n * REAL, lidoAte: '2026-09-27', diasPrevistos: null, atrasada: true });
    expect(c.plataformas[0]!.lidoEm).toEqual(new Date('2026-09-28T09:00:00Z'));
    // Os dias previstos deixam de ser um número só: a tela não escreve "ritmo × N dias".
    expect([c.diasPrevistos, c.plataformas[1]!.diasPrevistos]).toEqual([null, 2]);
    // Com uma conta nunca lida, a plataforma não tem "lido até".
    const nunca = contaDoMes({ hoje: '2026-09-29', contas: [meta, conta({ id: 'm3', lidoAte: null, lidoEm: null })], pesamPorDia: 0n, teto: null });
    expect(nunca.plataformas[0]).toMatchObject({ lidoAte: null, lidoEm: null, atrasada: true });
  });
});

describe('o gasto de cada dia do mês', () => {
  const mes = mesDe('2026-09-29');

  it('do primeiro dia ao último lido, e a soma dos dias é o gasto do mês', () => {
    // Hoje (29/09) só tem dado amanhã, e agosto não é deste mês.
    const meta = conta({ id: 'm', gastoPorDia: gastos('2026-08-25', '2026-09-28', 120n * REAL, [['2026-09-29', 999n * REAL]]) });
    const google = conta({ id: 'g', provider: 'google_ads', gastoPorDia: gastos('2026-09-03', '2026-09-28', 56n * REAL) });
    const dias = gastoDeCadaDia([google, meta], mes);
    expect(dias).toHaveLength(28);
    expect([dias[0], dias[2], dias.at(-1)]).toEqual([
      { dia: '2026-09-01', gasto: 120n * REAL, faltam: [] },
      { dia: '2026-09-03', gasto: 176n * REAL, faltam: [] },
      { dia: '2026-09-28', gasto: 176n * REAL, faltam: [] },
    ]);
    const c = contaDoMes({ hoje: '2026-09-29', contas: [google, meta], pesamPorDia: 0n, teto: null });
    expect(c.dias).toEqual(dias);
    expect(c.dias.reduce((s, d) => s + d.gasto, 0n)).toBe(c.gasto);
  });

  it('a fração de centavo vai ao centavo no acumulado: nenhum dia fica negativo e a soma fecha com o total da tela', () => {
    // R$ 20,555555 por dia (o Google manda fração de centavo): 28 dias somam R$ 575,55554, que a tela mostra como R$ 575,56.
    const google = conta({ provider: 'google_ads', gastoPorDia: gastos('2026-09-01', '2026-09-28', 20_555_555n) });
    const dias = gastoDeCadaDia([google], mes);
    expect(dias.every((d) => d.gasto >= 0n && d.gasto % 10_000n === 0n)).toBe(true);
    expect(dias.reduce((s, d) => s + d.gasto, 0n)).toBe(linhaDaConta(google, mes).gasto);
    expect(linhaDaConta(google, mes).gasto).toBe(575_560_000n);
    // Cada dia mostra R$ 20,55 ou R$ 20,56, conforme o centavo que o acumulado ganhou.
    expect(new Set(dias.map((d) => d.gasto))).toEqual(new Set([20_550_000n, 20_560_000n]));
  });

  it('conta atrasada: entra até o último dia lido dela, e o dia que falta diz a plataforma', () => {
    const meta = conta({ id: 'm', lidoAte: '2026-09-27', gastoPorDia: gastos('2026-09-01', '2026-09-28', 100n * REAL) });
    const google = conta({ id: 'g', provider: 'google_ads', gastoPorDia: gastos('2026-09-01', '2026-09-28', 50n * REAL) });
    const dias = gastoDeCadaDia([google, meta], mes);
    expect(dias.slice(-2)).toEqual([
      { dia: '2026-09-27', gasto: 150n * REAL, faltam: [] },
      { dia: '2026-09-28', gasto: 50n * REAL, faltam: ['meta_ads'] },
    ]);
    expect(dias.reduce((s, d) => s + d.gasto, 0n)).toBe(contaDoMes({ hoje: '2026-09-29', contas: [google, meta], pesamPorDia: 0n, teto: null }).gasto);
    // Com as duas atrasadas, a lista para no último dia que alguma cobre.
    expect(gastoDeCadaDia([meta, { ...google, lidoAte: '2026-09-26' }], mes).at(-1)).toEqual({ dia: '2026-09-27', gasto: 100n * REAL, faltam: ['google_ads'] });
  });

  it('nunca lida ou parada desde antes do mês: falta em todos os dias; sozinha, não há dia para mostrar', () => {
    const meta = conta({ id: 'm', gastoPorDia: gastos('2026-09-01', '2026-09-28', 100n * REAL) });
    const nunca = conta({ id: 'g', provider: 'google_ads', lidoAte: null, lidoEm: null, gastoPorDia: gastos('2026-09-01', '2026-09-28', 50n * REAL) });
    const parada = conta({ id: 'g2', provider: 'google_ads', lidoAte: '2026-08-25', gastoPorDia: gastos('2026-08-01', '2026-08-25', 50n * REAL) });
    const dias = gastoDeCadaDia([nunca, meta, parada], mes);
    expect(dias).toHaveLength(28);
    expect(dias.every((d) => d.gasto === 100n * REAL && d.faltam.join() === 'google_ads')).toBe(true);
    expect([gastoDeCadaDia([nunca], mes), gastoDeCadaDia([parada], mes), gastoDeCadaDia([], mes)]).toEqual([[], [], []]);
  });

  it('no primeiro dia do mês ainda não há dia inteiro para mostrar; no dia 2, o dia 1', () => {
    const c = conta({ lidoAte: '2026-09-30', gastoPorDia: gastos('2026-09-01', '2026-09-30', 100n * REAL) });
    expect(gastoDeCadaDia([c], mesDe('2026-10-01'))).toEqual([]);
    const noDia2 = conta({ lidoAte: '2026-10-01', gastoPorDia: gastos('2026-09-25', '2026-10-01', 100n * REAL) });
    expect(gastoDeCadaDia([noDia2], mesDe('2026-10-02'))).toEqual([{ dia: '2026-10-01', gasto: 100n * REAL, faltam: [] }]);
  });
});

describe('o pedido cabe no mês?', () => {
  const base = { hoje: '2026-09-29', contas: [conta({ gastoPorDia: gastos('2026-09-01', '2026-09-28', 100n * REAL) })] };

  it('cabe até o último centavo do que sobra; um centavo a mais, não', () => {
    // Previsão de R$ 3.000,00; teto de R$ 3.012,00: sobram R$ 12,00, que são R$ 6,00 por dia nos 2 dias que faltam.
    const c = contaDoMes({ ...base, pesamPorDia: 0n, teto: 3_012n * REAL });
    expect(cabeNoMes(c, 6n * REAL)).toEqual({ cabe: true, acrescenta: 12n * REAL });
    expect(cabeNoMes(c, 6n * REAL + 10_000n)).toEqual({ cabe: false, acrescenta: 12n * REAL + 20_000n });
  });

  it('o que foi pedido ou feito hoje entra na conta antes do pedido novo', () => {
    const c = contaDoMes({ ...base, pesamPorDia: 4n * REAL, teto: 3_012n * REAL });
    expect(c.sobra).toBe(4n * REAL);
    expect([cabeNoMes(c, 2n * REAL).cabe, cabeNoMes(c, 3n * REAL).cabe]).toEqual([true, false]);
  });

  it('com o mês acima do teto, nem o que não acrescenta nada passa (retomar um anúncio sem verba própria)', () => {
    const c = contaDoMes({ ...base, pesamPorDia: 0n, teto: 2_900n * REAL });
    expect(c.sobra).toBe(-100n * REAL);
    expect(cabeNoMes(c, 0n)).toEqual({ cabe: false, acrescenta: 0n });
  });

  it('sem teto, a conta não nega: quem exige o teto é a regra dos limites da empresa', () => {
    expect(cabeNoMes(contaDoMes({ ...base, pesamPorDia: 0n, teto: null }), 500n * REAL).cabe).toBe(true);
  });

  it('a recusa diz os números que decidem: o que o pedido acrescenta, o que sobra, a previsão e o teto', () => {
    const c = contaDoMes({ ...base, pesamPorDia: 4n * REAL, teto: 3_012n * REAL });
    expect(fraseDeNaoCaber(c, 6n * REAL, reais, 'da empresa')).toBe(
      nbsp('Não cabe na verba de setembro: o pedido acrescenta R$ 6,00 até o fim do mês, e sobram R$ 4,00. No ritmo atual, setembro fecha em R$ 3.000,00, mais R$ 8,00 de aumentos pedidos ou feitos hoje, e o teto da empresa é de R$ 3.012,00.'),
    );
    // Sem nada pedido hoje, a frase não fala de aumentos; com o mês acima do teto, diz em quanto.
    const acima = contaDoMes({ ...base, pesamPorDia: 0n, teto: 2_900n * REAL });
    expect(fraseDeNaoCaber(acima, 0n, reais, 'da marca')).toBe(nbsp('Não cabe na verba de setembro: o mês já passa do teto em R$ 100,00. No ritmo atual, setembro fecha em R$ 3.000,00, e o teto da marca é de R$ 2.900,00.'));
  });
});

describe('o teto por campanha na política', () => {
  const politica = (source: LoadedPolicy['source'], rules: PolicyDocument['rules']): LoadedPolicy => ({ source, version: 1, document: { rules } });

  it('vale o menor entre os tetos da empresa e da marca que casam com aumentar verba no provedor', () => {
    const empresa = politica('tenant', [
      { type: 'max_value', action: 'orcamento.*', max_micros: 80_000_000 },
      { type: 'max_value', action: 'orcamento.*', provider: 'google_ads', max_micros: 10_000_000 },
      { type: 'max_value', action: 'cupom.criar', max_micros: 5_000_000 },
    ]);
    const marca = politica('brand', [{ type: 'max_value', action: 'orcamento.aumentar', provider: 'meta_ads', max_micros: 60_000_000 }]);
    expect(tetoDaVerba([PLATFORM_POLICY, empresa], 'meta_ads')).toBe(80_000_000);
    expect(tetoDaVerba([PLATFORM_POLICY, empresa, marca], 'meta_ads')).toBe(60_000_000);
    expect(tetoDaVerba([PLATFORM_POLICY, empresa], 'google_ads')).toBe(10_000_000);
    // Regra sem ação vale para toda ação; a de reduzir não é teto de aumento; a da distribuição não conta.
    expect(tetoDaVerba([politica('tenant', [{ type: 'max_value', max_micros: 70_000_000 }])], 'meta_ads')).toBe(70_000_000);
    expect(tetoDaVerba([politica('tenant', [{ type: 'max_value', action: 'orcamento.reduzir', max_micros: 70_000_000 }])], 'meta_ads')).toBeNull();
    expect(tetoDaVerba([politica('platform', [{ type: 'max_value', action: 'orcamento.*', max_micros: 70_000_000 }])], 'meta_ads')).toBeNull();
    expect(tetoDaVerba([PLATFORM_POLICY], 'meta_ads')).toBeNull();
  });

  it('a tela troca só a regra dela: as outras ficam, na mesma ordem, e a nova vai no fim', () => {
    const antes: PolicyDocument = {
      rules: [
        { type: 'max_value', action: 'orcamento.*', max_micros: 80_000_000 },
        { type: 'autonomy', action: 'cupom.criar', mode: 'APPROVAL' },
        { type: 'max_value', action: 'orcamento.*', provider: 'meta_ads', max_micros: 90_000_000 },
        { type: 'max_value', action: 'orcamento.aumentar', max_micros: 85_000_000 },
        { type: 'max_value', action: 'cupom.criar', max_micros: 5_000_000 },
      ],
    };
    expect(comTetoDaVerba(antes, 62_000_000)).toEqual({
      rules: [
        { type: 'autonomy', action: 'cupom.criar', mode: 'APPROVAL' },
        { type: 'max_value', action: 'orcamento.*', provider: 'meta_ads', max_micros: 90_000_000 },
        { type: 'max_value', action: 'cupom.criar', max_micros: 5_000_000 },
        { type: 'max_value', action: 'orcamento.*', max_micros: 62_000_000 },
      ],
    });
    // Sem política ainda: nasce só com a regra do teto.
    expect(comTetoDaVerba(null, 62_000_000)).toEqual({ rules: [{ type: 'max_value', action: 'orcamento.*', max_micros: 62_000_000 }] });
  });

  it('salvar o mesmo teto não é mudança', () => {
    const doc = comTetoDaVerba(null, 62_000_000);
    expect([temOTetoDaVerba(doc, 62_000_000), temOTetoDaVerba(doc, 63_000_000), temOTetoDaVerba(null, 62_000_000)]).toEqual([true, false, false]);
    // Duas regras da tela (escritas pela API) ou a forma antiga: publica de novo, para ficar uma só.
    expect(temOTetoDaVerba({ rules: [...doc.rules, { type: 'max_value', action: 'orcamento.aumentar', max_micros: 62_000_000 }] }, 62_000_000)).toBe(false);
    expect(temOTetoDaVerba({ rules: [{ type: 'max_value', action: 'orcamento.aumentar', max_micros: 62_000_000 }] }, 62_000_000)).toBe(false);
  });

  it('as regras da distribuição que a tela cita saem da política, não de um número escrito na tela', () => {
    expect(regrasDaVerba([PLATFORM_POLICY], 'meta_ads')).toEqual({ change_percent_max: 10, rate_limit: { max: 3, window_minutes: 60 } });
    // Num provedor sem essas regras, a tela não cita número nenhum.
    expect(regrasDaVerba([PLATFORM_POLICY], 'sandbox')).toEqual({ change_percent_max: null, rate_limit: null });
  });
});
