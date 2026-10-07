import type { DailyResult } from '@liame/contracts';

// A linha dos dias da tela de Resultados (07/10/2026; `GET /v1/results/daily`): o gasto e as vendas dos anúncios
// dia a dia, e o período de mesmo tamanho logo antes, somado. Funções puras: as consultas ficam no serviço.

const DIA = 86_400_000;
const emMs = (dia: string) => Date.parse(`${dia}T00:00:00Z`);
const emDia = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** Os dias do período, em ordem, as duas pontas incluídas: de 27/09 a 29/09 → 27, 28 e 29. */
export function diasDoPeriodo(from: string, to: string): string[] {
  const dias: string[] = [];
  for (let ms = emMs(from); ms <= emMs(to); ms += DIA) dias.push(emDia(ms));
  return dias;
}

/** O período de mesmo tamanho imediatamente antes: de 22/09 a 28/09 (7 dias) → de 15/09 a 21/09. */
export function periodoAntes(from: string, to: string): { from: string; to: string } {
  const inicio = emMs(from);
  const dias = (emMs(to) - inicio) / DIA + 1;
  return { from: emDia(inicio - dias * DIA), to: emDia(inicio - DIA) };
}

/** O gasto de um dia (das contas de anúncio, no fuso de cada uma), em micros. */
export type GastoDoDia = { dia: string; micros: bigint };
/** Os pedidos confirmados com evidência de um dia (pelo faturamento, no fuso da loja). */
export type VendasDoDia = { dia: string; pedidos: number; receita: bigint };
/** O período anterior somado, ainda em números (quem responde formata e calcula o retorno). */
export type PeriodoSomado = { from: string; to: string; spend: bigint; orders: number; revenue: bigint };

/**
 * Junta o gasto e as vendas por dia: um item para cada dia do período (zero onde não houve nada) e a soma do
 * período anterior. As linhas podem trazer dias dos dois períodos; o que cair fora deles é ignorado.
 */
export function montarSerie(
  periodo: { from: string; to: string },
  gasto: GastoDoDia[],
  vendas: VendasDoDia[],
): { days: DailyResult[]; anterior: PeriodoSomado } {
  const antes = periodoAntes(periodo.from, periodo.to);
  const porDia = new Map<string, { spend: bigint; orders: number; revenue: bigint }>();
  const doDia = (dia: string) => {
    let d = porDia.get(dia);
    if (!d) porDia.set(dia, (d = { spend: 0n, orders: 0, revenue: 0n }));
    return d;
  };
  for (const g of gasto) doDia(g.dia).spend += g.micros;
  for (const v of vendas) {
    const d = doDia(v.dia);
    d.orders += v.pedidos;
    d.revenue += v.receita;
  }
  const days: DailyResult[] = diasDoPeriodo(periodo.from, periodo.to).map((date) => {
    const d = porDia.get(date);
    return { date, spend_micros: (d?.spend ?? 0n).toString(), orders: d?.orders ?? 0, revenue_micros: (d?.revenue ?? 0n).toString() };
  });
  const anterior: PeriodoSomado = { ...antes, spend: 0n, orders: 0, revenue: 0n };
  for (const dia of diasDoPeriodo(antes.from, antes.to)) {
    const d = porDia.get(dia);
    if (!d) continue;
    anterior.spend += d.spend;
    anterior.orders += d.orders;
    anterior.revenue += d.revenue;
  }
  return { days, anterior };
}
