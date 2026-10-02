import { describe, expect, it } from 'vitest';
import { type ItemCiclo, ordenarCiclo } from '../src/results/atencao-ciclo.js';
import {
  avisoCustoPorPedido,
  avisoGastoDaCampanha,
  avisoVendasForaDoNormal,
  type CampanhaNaSerie,
  diaDaSemana,
  diaNoFuso,
  lidaHoje,
  type LojaNaSerie,
  medianaMicros,
  mesmoDiaDasSemanasAnteriores,
  type VendasDoDia,
} from '../src/results/fora-do-normal.js';

// A3 · I6, sem banco: o que saiu do normal, comparado com o mesmo dia da semana da própria série. Cada
// aviso leva a evidência, o valor envolvido e a hora da leitura.

const R = (reais: number) => BigInt(Math.round(reais * 100)) * 10_000n;
/** O formato de moeda do pt-BR separa "R$" do valor com espaço sem quebra. */
const nbsp = (s: string) => s.replace(/R\$ /g, 'R$ ');
const FUSO = 'America/Sao_Paulo';
/** Quinta-feira; as quatro quintas anteriores são 24/09, 17/09, 10/09 e 03/09. */
const ONTEM = '2026-10-01';
const QUINTAS = ['2026-09-24', '2026-09-17', '2026-09-10', '2026-09-03'];
const LIDO = '2026-10-02T12:55:00Z';

const vendas = (pedidos: number[], receita: number[], ontem?: [number, number]) => {
  const serie = new Map<string, VendasDoDia>(QUINTAS.map((d, i) => [d, { pedidos: pedidos[i]!, receitaMicros: R(receita[i]!) }]));
  if (ontem) serie.set(ONTEM, { pedidos: ontem[0], receitaMicros: R(ontem[1]) });
  return serie;
};
const loja = (porDia: Map<string, VendasDoDia>, over: Partial<LojaNaSerie> = {}): LojaNaSerie => ({ id: 'l1', nome: 'Loja Centro', fuso: FUSO, lidoEm: LIDO, desde: '2026-08-20', porDia, ...over });
const NORMAL = { pedidos: [20, 24, 26, 30], receita: [1000, 1200, 1300, 1500] };

describe('fora do normal: a série e o normal (A3, I6)', () => {
  it('compara com o mesmo dia das 4 semanas anteriores; dia sem linha conta zero, e antes do começo da série não conta', () => {
    const serie = new Map([['2026-09-24', 20n], ['2026-09-10', 30n]]);
    expect(mesmoDiaDasSemanasAnteriores(serie, ONTEM, '2026-09-01', 0n)).toEqual([20n, 0n, 30n, 0n]);
    expect(mesmoDiaDasSemanasAnteriores(serie, ONTEM, '2026-09-15', 0n)).toEqual([20n, 0n]);
    expect(mesmoDiaDasSemanasAnteriores(serie, ONTEM, null, 0n)).toEqual([]);
  });

  it('mediana em inteiros, dia da semana por extenso e leitura feita no dia de hoje do fuso', () => {
    expect(medianaMicros([30n, 10n, 20n])).toBe(20n);
    expect(medianaMicros([10n, 20n, 30n, 41n])).toBe(25n);
    expect(diaDaSemana(ONTEM)).toBe('quinta-feira');
    // 02:30 UTC de 02/10 ainda é 01/10 em Brasília.
    expect(diaNoFuso('2026-10-02T02:30:00Z', FUSO)).toBe('2026-10-01');
    const agora = new Date('2026-10-02T13:00:00Z');
    expect(lidaHoje('2026-10-02T03:05:00Z', agora, FUSO)).toBe(true);
    expect(lidaHoje('2026-10-02T02:55:00Z', agora, FUSO)).toBe(false);
    expect(lidaHoje(null, agora, FUSO)).toBe(false);
  });
});

describe('fora do normal: vendas da loja', () => {
  it('abaixo da metade do normal é atenção, com a evidência, o valor envolvido e a hora da leitura', () => {
    const aviso = avisoVendasForaDoNormal(loja(vendas(NORMAL.pedidos, NORMAL.receita, [10, 520])), ONTEM)!;
    expect(aviso).toMatchObject({ kind: 'vendas_fora_do_normal', severity: 'atencao', provider: 'regem', connected_account_id: 'l1', campaign_id: null });
    expect(aviso.title).toBe('As vendas de ontem na Loja Centro ficaram abaixo do normal');
    expect(aviso.detail).toBe(nbsp('10 pedidos e R$ 520,00 ontem (quinta-feira); no mesmo dia das últimas 4 semanas, o normal foi de 25 pedidos e R$ 1.250,00. São R$ 730,00 a menos. Pedidos lidos hoje, às 09:55.'));
  });

  it('abaixo de um quarto é crítico; dia sem pedido nenhum também', () => {
    expect(avisoVendasForaDoNormal(loja(vendas(NORMAL.pedidos, NORMAL.receita, [5, 260])), ONTEM)?.severity).toBe('critica');
    const semPedido = avisoVendasForaDoNormal(loja(vendas(NORMAL.pedidos, NORMAL.receita)), ONTEM)!;
    expect(semPedido.severity).toBe('critica');
    expect(semPedido.detail).toContain(nbsp('0 pedidos e R$ 0,00 ontem'));
  });

  it('só a receita abaixo da metade já avisa; acima do dobro é informação', () => {
    expect(avisoVendasForaDoNormal(loja(vendas(NORMAL.pedidos, NORMAL.receita, [14, 500])), ONTEM)?.severity).toBe('atencao');
    const acima = avisoVendasForaDoNormal(loja(vendas(NORMAL.pedidos, NORMAL.receita, [55, 2800])), ONTEM)!;
    expect(acima).toMatchObject({ severity: 'info', title: 'As vendas de ontem na Loja Centro ficaram acima do normal' });
    expect(acima.detail).toContain(nbsp('São R$ 1.550,00 a mais.'));
  });

  it('dentro da faixa, com pouca história ou com pouco volume: não avisa', () => {
    expect(avisoVendasForaDoNormal(loja(vendas(NORMAL.pedidos, NORMAL.receita, [20, 1000])), ONTEM)).toBeNull();
    expect(avisoVendasForaDoNormal(loja(vendas(NORMAL.pedidos, NORMAL.receita, [13, 630])), ONTEM)).toBeNull();
    // A série começou há duas semanas: não há "normal" ainda.
    expect(avisoVendasForaDoNormal(loja(vendas(NORMAL.pedidos, NORMAL.receita, [2, 80]), { desde: '2026-09-17' }), ONTEM)).toBeNull();
    expect(avisoVendasForaDoNormal(loja(vendas([4, 4, 3, 5], [200, 200, 150, 250], [0, 0])), ONTEM)).toBeNull();
    expect(avisoVendasForaDoNormal(loja(new Map(), { desde: null }), ONTEM)).toBeNull();
  });
});

describe('fora do normal: gasto e custo por pedido da campanha', () => {
  const campanha = (gastos: number[], ontem: number | null, over: Partial<CampanhaNaSerie> = {}): CampanhaNaSerie => {
    const gastoPorDia = new Map<string, bigint>(QUINTAS.map((d, i) => [d, R(gastos[i]!)]));
    if (ontem !== null) gastoPorDia.set(ONTEM, R(ontem));
    return { id: 'c1', name: 'Combo sexta', provider: 'meta_ads', connectedAccountId: 'a1', fuso: FUSO, lidoEm: '2026-10-02T09:12:00Z', desde: '2026-08-20', gastoPorDia, ...over };
  };

  it('gasto de ontem acima do dobro do normal do mesmo dia da semana', () => {
    const aviso = avisoGastoDaCampanha(campanha([40, 50, 60, 50], 120), ONTEM)!;
    expect(aviso).toMatchObject({ kind: 'gasto_da_campanha_fora_do_normal', severity: 'atencao', campaign_id: 'c1', connected_account_id: 'a1', provider: 'meta_ads' });
    expect(aviso.title).toBe('A campanha "Combo sexta" gastou acima do normal ontem');
    expect(aviso.detail).toBe(nbsp('R$ 120,00 ontem (quinta-feira); no mesmo dia das últimas 4 semanas, o normal foi de R$ 50,00. São R$ 70,00 a mais (Meta, lida hoje às 06:12).'));
  });

  it('até o dobro não avisa; campanha que não roda nesse dia da semana ou com gasto pequeno, também não', () => {
    expect(avisoGastoDaCampanha(campanha([40, 50, 60, 50], 100), ONTEM)).toBeNull();
    // Programada para o fim de semana: nas quintas o normal é zero.
    expect(avisoGastoDaCampanha(campanha([0, 0, 0, 0], 80), ONTEM)).toBeNull();
    expect(avisoGastoDaCampanha(campanha([8, 8, 9, 7], 40), ONTEM)).toBeNull();
    expect(avisoGastoDaCampanha(campanha([40, 50, 60, 50], 120, { desde: '2026-09-20' }), ONTEM)).toBeNull();
  });

  const custo = (semana: [number, number], historia: [number, number]) =>
    avisoCustoPorPedido({ id: 'c1', name: 'Combo sexta', provider: 'meta_ads', connectedAccountId: 'a1', semana: { gastoMicros: R(semana[0]), pedidos: semana[1] }, historia: { gastoMicros: R(historia[0]), pedidos: historia[1] } });

  it('custo por pedido confirmado 50% acima do das 4 semanas anteriores', () => {
    const aviso = custo([300, 5], [800, 32])!;
    expect(aviso).toMatchObject({ kind: 'custo_por_pedido_fora_do_normal', severity: 'atencao', campaign_id: 'c1' });
    expect(aviso.detail).toBe(nbsp('R$ 60,00 por pedido confirmado nos últimos 7 dias (5 pedidos, R$ 300,00); nas 4 semanas anteriores era R$ 25,00. São R$ 175,00 a mais no período (Meta).'));
  });

  it('até 50% acima, sem pedido na semana, com pouca história ou com pouco gasto: não avisa', () => {
    expect(custo([187.5, 5], [800, 32])).toBeNull();
    expect(custo([300, 0], [800, 32])).toBeNull();
    expect(custo([300, 5], [100, 4])).toBeNull();
    expect(custo([19, 1], [800, 32])).toBeNull();
    expect(custo([300, 5], [0, 32])).toBeNull();
  });
});

describe('fora do normal: ordem na lista', () => {
  it('na mesma gravidade, as vendas fora do normal vêm logo depois da fonte parada; gasto e custo, junto do dinheiro', () => {
    const item = (kind: ItemCiclo['kind'], severity: ItemCiclo['severity'] = 'atencao'): ItemCiclo => ({ kind, severity, title: '', detail: '', action: '', connected_account_id: null, campaign_id: null, provider: null });
    const ordem = ordenarCiclo([item('cupom_sem_uso'), item('custo_por_pedido_fora_do_normal'), item('anuncio_sem_rastreio'), item('vendas_fora_do_normal'), item('gasto_da_campanha_fora_do_normal'), item('dado_atrasado'), item('vendas_fora_do_normal', 'critica')]);
    expect(ordem.map((i) => [i.kind, i.severity])).toEqual([
      ['vendas_fora_do_normal', 'critica'],
      ['dado_atrasado', 'atencao'],
      ['vendas_fora_do_normal', 'atencao'],
      ['anuncio_sem_rastreio', 'atencao'],
      ['gasto_da_campanha_fora_do_normal', 'atencao'],
      ['custo_por_pedido_fora_do_normal', 'atencao'],
      ['cupom_sem_uso', 'atencao'],
    ]);
  });
});
