import { describe, expect, it } from 'vitest';
import {
  type AvisoDoRitmo,
  avisosDoRitmo,
  conferirGastoDoRitmo,
  FOLGA_DO_GASTO_DO_RITMO_PCT,
  type LeituraDoRitmo,
  type ObjetoNoRitmo,
  type PassoGuardado,
  permitidoNoDia,
  type RitmoComPassos,
  textoDoAvisoDoRitmo,
} from '../src/campanhas/ritmo-avisos.js';
import { reais } from '../src/results/atencao-ciclo.js';

// R7, parte 1b-3c (D-RG-63, D-RG-72, D-RG-73 e D-RG-75), sem rede e sem banco: a verba que valia em cada dia pelos passos
// feitos, a conferência do gasto do ritmo (7 dias contra a soma de cada dia, com a folga, até o último dia em que o
// ritmo conduziu a campanha) e os três avisos (a campanha que saiu do ritmo, a que ainda não voltou à verba de antes,
// pela verba que o Liame deixou e não pela que alguém pôs depois, e a que gastou mais do que o ritmo permite), com as
// frases.

const REAL = 1_000_000;
const nbsp = (s: string) => s.replaceAll('R$ ', `R$${String.fromCharCode(160)}`);
const SEMANA = { de: '2026-11-16', ate: '2026-11-22' };
const feito = (dia: string, de: number, para: number, tipo: PassoGuardado['tipo'] = 'ritmo'): PassoGuardado => ({ dia, tipo, situacao: 'feito', deMicros: de * REAL, paraMicros: para * REAL });
const passo = (dia: string, situacao: string, tipo: PassoGuardado['tipo'] = 'ritmo'): PassoGuardado => ({ dia, tipo, situacao, deMicros: 100 * REAL, paraMicros: 100 * REAL });
const objeto = (passos: PassoGuardado[], o: Partial<ObjetoNoRitmo> = {}): ObjetoNoRitmo => ({ recurso: 'campanha:111', nome: 'Smash em dobro', baseMicros: 100 * REAL, partidaMicros: 100 * REAL, passos, ...o });
const ritmo = (objetos: ObjetoNoRitmo[], o: Partial<RitmoComPassos> = {}): RitmoComPassos => ({ id: 'r1', acao: 'a1', situacao: 'aprovado', semana: SEMANA, objetos, ...o });
const gasto = (porDia: Record<string, number>) => new Map(Object.entries(porDia).map(([dia, v]) => [dia, BigInt(Math.round(v * REAL))]));
/** A leitura de hoje: o gasto por dia e a verba lida (`undefined`: sem leitura de hoje; `null`: sem verba diária própria). */
const leitura = (porDia: Record<string, number> = {}, verbaLida?: number | null): LeituraDoRitmo => ({
  gastoDe: () => gasto(porDia),
  verbaLidaDe: () => (verbaLida === undefined ? null : { micros: verbaLida === null ? null : verbaLida * REAL }),
});
const nada = leitura();
// A semana do ritmo: desce na segunda e na terça, sobe até o domingo.
const SEMANA_FEITA = [feito('2026-11-16', 100, 90), feito('2026-11-17', 90, 82), feito('2026-11-18', 82, 88), feito('2026-11-19', 88, 97), feito('2026-11-20', 97, 106), feito('2026-11-21', 106, 116), feito('2026-11-22', 116, 120)];
const VOLTA = [feito('2026-11-23', 120, 108, 'volta'), feito('2026-11-24', 108, 100, 'volta')];

describe('a conferência do gasto do ritmo (R7, parte 1b-3c)', () => {
  it('a verba que valia em cada dia: a maior entre a do começo e a do fim do dia', () => {
    // Antes do primeiro passo, a verba que o Liame encontrou nele.
    expect(permitidoNoDia('2026-11-15', SEMANA_FEITA)).toBe(BigInt(100 * REAL));
    // No dia em que desce, ainda vale a de antes; no dia em que sobe, já vale a nova.
    expect(permitidoNoDia('2026-11-16', SEMANA_FEITA)).toBe(BigInt(100 * REAL));
    expect(permitidoNoDia('2026-11-17', SEMANA_FEITA)).toBe(BigInt(90 * REAL));
    expect(permitidoNoDia('2026-11-18', SEMANA_FEITA)).toBe(BigInt(88 * REAL));
    expect(permitidoNoDia('2026-11-22', SEMANA_FEITA)).toBe(BigInt(120 * REAL));
    // Depois do último passo, a verba em que o Liame deixou. O dia sem passo (bloqueado) segue com a do passo anterior.
    expect(permitidoNoDia('2026-11-25', SEMANA_FEITA)).toBe(BigInt(120 * REAL));
    expect(permitidoNoDia('2026-11-19', [feito('2026-11-16', 100, 90), feito('2026-11-20', 90, 99)])).toBe(BigInt(90 * REAL));
    expect(permitidoNoDia('2026-11-16', [])).toBeNull();
  });

  it('os 7 dias que terminam no dia dado contra a soma de cada dia, com a folga', () => {
    // De 16/11 a 22/11: 100 + 90 + 88 + 97 + 106 + 116 + 120 = 717.
    const dentro = conferirGastoDoRitmo(SEMANA_FEITA, '2026-11-22', gasto({ '2026-11-16': 130, '2026-11-17': 80, '2026-11-18': 90, '2026-11-19': 100, '2026-11-20': 110, '2026-11-21': 120, '2026-11-22': 115 }));
    expect(dentro).toEqual({ status: 'confere', janela: SEMANA, gasto: BigInt(745 * REAL), permitido: BigInt(717 * REAL) });
    // 745 passa da soma, mas cabe na folga (717 × 1,05 = 752,85); 752,86 já não cabe.
    expect(FOLGA_DO_GASTO_DO_RITMO_PCT).toBe(5);
    expect(conferirGastoDoRitmo(SEMANA_FEITA, '2026-11-22', gasto({ '2026-11-16': 752.85 }))?.status).toBe('confere');
    expect(conferirGastoDoRitmo(SEMANA_FEITA, '2026-11-22', gasto({ '2026-11-16': 752.86 }))?.status).toBe('acima');
    // O gasto de depois e o de antes da janela não entram.
    expect(conferirGastoDoRitmo(SEMANA_FEITA, '2026-11-22', gasto({ '2026-11-15': 900, '2026-11-23': 900 }))?.gasto).toBe(0n);
    // No meio da semana, os dias de antes do ritmo contam com a verba que o Liame encontrou: 100 × 5 + 100 + 90 = 690.
    expect(conferirGastoDoRitmo(SEMANA_FEITA.slice(0, 2), '2026-11-17', new Map())).toEqual({ status: 'confere', janela: { de: '2026-11-11', ate: '2026-11-17' }, gasto: 0n, permitido: BigInt(690 * REAL) });
    // Sem passo feito na janela, não há o que conferir.
    expect(conferirGastoDoRitmo(SEMANA_FEITA, '2026-11-30', gasto({ '2026-11-25': 999 }))).toBeNull();
    expect(conferirGastoDoRitmo([], '2026-11-22', gasto({ '2026-11-20': 999 }))).toBeNull();
  });
});

describe('os avisos do ritmo (R7, parte 1b-3c)', () => {
  const tipos = (avisos: AvisoDoRitmo[]) => avisos.map((a) => a.tipo);

  it('no ritmo, andando e gastando dentro: nenhum aviso', () => {
    expect(avisosDoRitmo([ritmo([objeto(SEMANA_FEITA.slice(0, 3))])], '2026-11-18', nada)).toEqual([]);
    // O ritmo da semana que vem (já aprovado) ainda não tem o que avisar.
    expect(avisosDoRitmo([ritmo([objeto([])], { semana: { de: '2026-11-23', ate: '2026-11-29' } })], '2026-11-18', nada)).toEqual([]);
  });

  it('a campanha mexida por fora saiu do ritmo: o aviso vale até o fim da semana, e o gasto dela não é conferido', () => {
    const fora = objeto([feito('2026-11-16', 100, 90), passo('2026-11-17', 'fora')]);
    const muito = leitura({ '2026-11-16': 5000 });
    expect(avisosDoRitmo([ritmo([fora])], '2026-11-18', muito)).toEqual([{ ritmo: 'r1', acao: 'a1', recurso: 'campanha:111', nome: 'Smash em dobro', tipo: 'saiu', dia: '2026-11-17' }]);
    expect(avisosDoRitmo([ritmo([fora])], '2026-11-22', muito)).toHaveLength(1);
    expect(avisosDoRitmo([ritmo([fora])], '2026-11-23', muito)).toEqual([]);
  });

  it('a que ainda não voltou à verba de antes: o ritmo acabou ou foi parado e nenhum passo saiu ontem nem hoje', () => {
    const subiu = objeto(SEMANA_FEITA);
    // Segunda, 23/11: o passo de domingo foi ontem; a volta de hoje ainda pode sair.
    expect(tipos(avisosDoRitmo([ritmo([subiu])], '2026-11-23', nada))).toEqual([]);
    // Terça, 24/11, sem volta feita (bloqueada pelo mês, ou a função desligada): o aviso, com as duas verbas.
    const bloqueada = objeto([...SEMANA_FEITA, passo('2026-11-23', 'bloqueado', 'volta'), passo('2026-11-24', 'bloqueado', 'volta')]);
    expect(avisosDoRitmo([ritmo([bloqueada])], '2026-11-24', nada)).toEqual([
      { ritmo: 'r1', acao: 'a1', recurso: 'campanha:111', nome: 'Smash em dobro', tipo: 'nao_voltou', semana: SEMANA, parado: false, deixadaMicros: 120 * REAL, baseMicros: 100 * REAL },
    ]);
    expect(tipos(avisosDoRitmo([ritmo([subiu])], '2026-11-24', nada))).toEqual(['nao_voltou']);
    // O pedido de hoje ainda na fila e o passo que não precisou mudar nada também contam como a rotina andando; o
    // pedido de ontem que ficou parado, não.
    expect(tipos(avisosDoRitmo([ritmo([objeto([...SEMANA_FEITA, passo('2026-11-24', 'pedido', 'volta')])])], '2026-11-24', nada))).toEqual([]);
    expect(tipos(avisosDoRitmo([ritmo([objeto([...SEMANA_FEITA, passo('2026-11-23', 'igual', 'volta')])])], '2026-11-24', nada))).toEqual([]);
    expect(tipos(avisosDoRitmo([ritmo([objeto([...SEMANA_FEITA, passo('2026-11-23', 'pedido', 'volta')])])], '2026-11-24', nada))).toEqual(['nao_voltou']);
    // A volta andando (um passo ontem) não avisa; de volta à verba de antes, também não.
    expect(tipos(avisosDoRitmo([ritmo([objeto([...SEMANA_FEITA, VOLTA[0]!])])], '2026-11-24', nada))).toEqual([]);
    expect(tipos(avisosDoRitmo([ritmo([objeto([...SEMANA_FEITA, ...VOLTA])], { situacao: 'encerrado' })], '2026-11-27', nada))).toEqual([]);
    // Parado no meio da semana: o mesmo aviso, dizendo que foi parado. Depois dos 35 dias da volta, o Liame não tenta mais.
    const parado = ritmo([objeto(SEMANA_FEITA.slice(0, 2))], { situacao: 'parado' });
    expect(avisosDoRitmo([parado], '2026-11-20', nada)).toMatchObject([{ tipo: 'nao_voltou', parado: true, deixadaMicros: 82 * REAL }]);
    expect(tipos(avisosDoRitmo([parado], '2026-12-27', nada))).toEqual(['nao_voltou']);
    expect(tipos(avisosDoRitmo([parado], '2026-12-28', nada))).toEqual([]);
  });

  it('o aviso de "não voltou" é da verba que o Liame deixou: com outra verba na leitura de hoje, alguém já mexeu', () => {
    const subiu = ritmo([objeto(SEMANA_FEITA)]);
    // A leitura de hoje mostra a verba que o Liame deixou (R$ 120,00): o aviso vale.
    expect(tipos(avisosDoRitmo([subiu], '2026-11-25', leitura({}, 120)))).toEqual(['nao_voltou']);
    // A pessoa acertou à mão para a verba de antes, pôs outra, ou tirou a verba diária: a verba é dela, sem aviso.
    expect(tipos(avisosDoRitmo([subiu], '2026-11-25', leitura({}, 100)))).toEqual([]);
    expect(tipos(avisosDoRitmo([subiu], '2026-11-25', leitura({}, 135)))).toEqual([]);
    expect(tipos(avisosDoRitmo([subiu], '2026-11-25', leitura({}, null)))).toEqual([]);
    // Sem leitura de hoje, vale a do último passo.
    expect(tipos(avisosDoRitmo([subiu], '2026-11-25', leitura()))).toEqual(['nao_voltou']);
  });

  it('o gasto é conferido até o último dia em que o ritmo conduziu a campanha', () => {
    // Na semana do ritmo, até ontem: em 20/11, de 13/11 a 19/11 (100 × 3 + 100 + 90 + 88 + 97 = 675).
    const naSemana = avisosDoRitmo([ritmo([objeto(SEMANA_FEITA.slice(0, 4))])], '2026-11-20', leitura({ '2026-11-19': 800 }));
    expect(naSemana).toEqual([{ ritmo: 'r1', acao: 'a1', recurso: 'campanha:111', nome: 'Smash em dobro', tipo: 'gasto_acima', janela: { de: '2026-11-13', ate: '2026-11-19' }, gasto: BigInt(800 * REAL), permitido: BigInt(675 * REAL) }]);
    // Depois que a verba voltou (o último passo em 24/11), os dias seguintes não são do ritmo: a pessoa pode ter
    // aumentado a verba, e o gasto de 26/11 não conta. A janela fica de 18/11 a 24/11 (88 + 97 + 106 + 116 + 120 + 120 + 108 = 755).
    const voltou = ritmo([objeto([...SEMANA_FEITA, ...VOLTA])], { situacao: 'encerrado' });
    expect(avisosDoRitmo([voltou], '2026-11-28', leitura({ '2026-11-26': 5000 }))).toEqual([]);
    expect(avisosDoRitmo([voltou], '2026-11-28', leitura({ '2026-11-21': 500, '2026-11-22': 400 }))).toEqual([
      { ritmo: 'r1', acao: 'a1', recurso: 'campanha:111', nome: 'Smash em dobro', tipo: 'gasto_acima', janela: { de: '2026-11-18', ate: '2026-11-24' }, gasto: BigInt(900 * REAL), permitido: BigInt(755 * REAL) },
    ]);
    // Sete dias depois do último passo ainda aparece; no oitavo, a conferência já é a comum.
    expect(tipos(avisosDoRitmo([voltou], '2026-12-01', leitura({ '2026-11-21': 500, '2026-11-22': 400 })))).toEqual(['gasto_acima']);
    expect(tipos(avisosDoRitmo([voltou], '2026-12-02', leitura({ '2026-11-21': 500, '2026-11-22': 400 })))).toEqual([]);
    // A volta bloqueada: a conferência para no último passo feito (22/11), e o aviso de "não voltou" segue.
    const semVolta = ritmo([objeto(SEMANA_FEITA)]);
    expect(tipos(avisosDoRitmo([semVolta], '2026-11-26', leitura({ '2026-11-24': 5000 })))).toEqual(['nao_voltou']);
  });

  it('a semana que continua de outra: vale o ritmo mais novo, e o gasto junta os passos dos dois', () => {
    const primeira = ritmo([objeto(SEMANA_FEITA)]);
    const segunda = ritmo([objeto([feito('2026-11-23', 120, 108), feito('2026-11-24', 108, 98)], { partidaMicros: 120 * REAL })], { id: 'r2', acao: 'a2', semana: { de: '2026-11-23', ate: '2026-11-29' } });
    // Em 25/11 a campanha está no ritmo novo (nada de "não voltou" do antigo).
    expect(avisosDoRitmo([primeira, segunda], '2026-11-25', nada)).toEqual([]);
    // A janela de 18/11 a 24/11 usa os passos das duas semanas: 88 + 97 + 106 + 116 + 120 + 120 + 108 = 755.
    const acima = avisosDoRitmo([primeira, segunda], '2026-11-25', leitura({ '2026-11-20': 400, '2026-11-22': 400 }));
    expect(acima).toEqual([{ ritmo: 'r2', acao: 'a2', recurso: 'campanha:111', nome: 'Smash em dobro', tipo: 'gasto_acima', janela: { de: '2026-11-18', ate: '2026-11-24' }, gasto: BigInt(800 * REAL), permitido: BigInt(755 * REAL) }]);
  });

  it('as frases: o que houve, o motivo e o que fazer', () => {
    const base = { ritmo: 'r1', acao: 'a1', recurso: 'campanha:111', nome: 'Smash em dobro' };
    expect(textoDoAvisoDoRitmo({ ...base, tipo: 'saiu', dia: '2026-11-17' }, reais)).toEqual({
      kind: 'ritmo_campanha_saiu',
      severity: 'info',
      title: 'A campanha "Smash em dobro" saiu do ritmo da semana',
      detail: 'Em 17/11, a verba dela na Meta não era a que o Liame tinha deixado, ou ela não estava ativa: alguém mexeu por fora. O Liame não muda mais a verba dela nesta semana, e ela fica como está.',
      action: 'Confira na Meta se a verba dela está como você quer.',
    });
    const naoVoltou = textoDoAvisoDoRitmo({ ...base, recurso: 'conjunto:222', nome: 'Smash · Raio de 3 km', tipo: 'nao_voltou', semana: SEMANA, parado: true, deixadaMicros: 96_760_000, baseMicros: 118 * REAL }, reais);
    expect(naoVoltou.kind).toBe('ritmo_sem_volta');
    expect(naoVoltou.severity).toBe('atencao');
    expect(naoVoltou.title).toBe('O conjunto "Smash · Raio de 3 km" ainda não voltou à verba de antes do ritmo');
    expect(naoVoltou.detail).toBe(
      nbsp(
        'O ritmo da semana de 16/11 a 22/11 foi parado, e ele está com R$ 96,76 por dia; antes do ritmo eram R$ 118,00. A volta não saiu ontem nem hoje: não coube nos limites da empresa (a verba do mês, o teto por campanha ou a política), ou a função do ritmo foi desligada.',
      ),
    );
    expect(naoVoltou.action).toBe('Veja o ritmo em Aprovações. Para voltar já, peça a mudança da verba dele.');
    const acima = textoDoAvisoDoRitmo({ ...base, tipo: 'gasto_acima', janela: SEMANA, gasto: BigInt(880 * REAL), permitido: BigInt(717 * REAL) }, reais);
    expect(acima).toEqual({
      kind: 'ritmo_gasto_acima',
      severity: 'atencao',
      title: 'A campanha "Smash em dobro" gastou mais do que o ritmo da semana permite',
      detail: nbsp('De 16/11 a 22/11, ela gastou R$ 880,00. Com a verba de cada dia, esses dias iriam até R$ 717,00. A Meta pode passar da verba num dia e compensar em outro; o Liame avisa quando a soma dos 7 dias passa de 5%.'),
      action: 'Veja na Meta o gasto dela nesses dias. Se preferir, pare o ritmo em Aprovações.',
    });
  });
});
