// A demanda da loja (plano da região, R3, parte 1): os pedidos que o Liame já lê do Regem (`order_fact`), somados por
// dia da semana e hora, com o tíquete médio e o cliente novo × de volta. Contas puras, sem banco: o serviço traz as
// linhas já agrupadas. As regras são as de Resultados: conta o pedido confirmado; a receita é a líquida (a receita da
// definição única menos o estorno); a hora é a do pedido do cliente (`placed_at`, ou a confirmação quando ele não vem),
// no fuso da loja. Nada de pessoa: só contagens e somas da própria loja.

/** As 4 semanas completas até ontem: cada dia da semana entra 4 vezes. */
export const JANELA_DIAS = 28;
/** Abaixo disto na janela, o dia e a hora ainda não dizem nada (a seção diz "poucos pedidos"). */
export const MINIMO_DE_PEDIDOS = 20;

/** Uma linha agrupada: a janela (a atual ou a anterior), o dia da semana (0 = domingo), a hora e as somas. */
export type LinhaDaDemanda = {
  janela: 'atual' | 'anterior';
  dow: number;
  hora: number;
  pedidos: number;
  receita: string | number;
  novos: number;
  de_volta: number;
};

export interface DemandaDaLoja {
  status: 'pronto' | 'poucos_pedidos' | 'sem_pedidos';
  from: string;
  to: string;
  days: number;
  minimum_orders: number;
  orders: number;
  revenue_micros: string;
  ticket_micros: string | null;
  previous: { orders: number; revenue_micros: string; ticket_micros: string | null };
  customers: { new: number; returning: number; unknown: number };
  by_weekday: Array<{ weekday: number; orders: number; revenue_micros: string }>;
  by_hour: Array<{ hour: number; orders: number }>;
  /** A célula (dia da semana × hora) com mais pedidos na janela; nula com poucos pedidos. */
  peak: { weekday: number; hour: number; orders: number } | null;
}

/** O tíquete médio em micros (inteiro, arredondado para baixo); nulo sem pedido. */
export function ticket(receita: bigint, pedidos: number): string | null {
  return pedidos > 0 ? (receita / BigInt(pedidos)).toString() : null;
}

const grande = (v: string | number): bigint => BigInt(typeof v === 'number' ? Math.trunc(v) : (v.split('.')[0] ?? '0'));

/** O dia "AAAA-MM-DD" `n` dias antes. */
export function diasAntes(dia: string, n: number): string {
  const d = new Date(`${dia}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

/** As janelas a partir de hoje (no fuso da loja): a atual termina ontem; a anterior, no dia antes dela. */
export function janelas(hoje: string): { de: string; ate: string; deAnterior: string; ateAnterior: string } {
  const ate = diasAntes(hoje, 1);
  const de = diasAntes(hoje, JANELA_DIAS);
  return { de, ate, deAnterior: diasAntes(de, JANELA_DIAS), ateAnterior: diasAntes(de, 1) };
}

/** A demanda da loja a partir das linhas agrupadas da janela atual e da anterior. */
export function demandaDaLoja(linhas: readonly LinhaDaDemanda[], hoje: string): DemandaDaLoja {
  const j = janelas(hoje);
  const atual = linhas.filter((l) => l.janela === 'atual');
  const anterior = linhas.filter((l) => l.janela === 'anterior');
  const soma = (ls: readonly LinhaDaDemanda[]) => ls.reduce((t, l) => t + grande(l.receita), 0n);
  const conta = (ls: readonly LinhaDaDemanda[]) => ls.reduce((t, l) => t + l.pedidos, 0);
  const pedidos = conta(atual);
  const receita = soma(atual);
  const pedidosAntes = conta(anterior);
  const receitaAntes = soma(anterior);
  const novos = atual.reduce((t, l) => t + l.novos, 0);
  const deVolta = atual.reduce((t, l) => t + l.de_volta, 0);

  const porDia = Array.from({ length: 7 }, (_, weekday) => {
    const ls = atual.filter((l) => l.dow === weekday);
    return { weekday, orders: conta(ls), revenue_micros: soma(ls).toString() };
  });
  const porHora = Array.from({ length: 24 }, (_, hour) => ({ hour, orders: conta(atual.filter((l) => l.hora === hour)) }));

  const status = pedidos === 0 ? 'sem_pedidos' : pedidos < MINIMO_DE_PEDIDOS ? 'poucos_pedidos' : 'pronto';
  let pico: DemandaDaLoja['peak'] = null;
  if (status === 'pronto') {
    for (const l of atual) {
      const n = atual.filter((x) => x.dow === l.dow && x.hora === l.hora).reduce((t, x) => t + x.pedidos, 0);
      if (!pico || n > pico.orders || (n === pico.orders && (l.dow < pico.weekday || (l.dow === pico.weekday && l.hora < pico.hour)))) {
        pico = { weekday: l.dow, hour: l.hora, orders: n };
      }
    }
  }

  return {
    status,
    from: j.de,
    to: j.ate,
    days: JANELA_DIAS,
    minimum_orders: MINIMO_DE_PEDIDOS,
    orders: pedidos,
    revenue_micros: receita.toString(),
    ticket_micros: ticket(receita, pedidos),
    previous: { orders: pedidosAntes, revenue_micros: receitaAntes.toString(), ticket_micros: ticket(receitaAntes, pedidosAntes) },
    customers: { new: novos, returning: deVolta, unknown: pedidos - novos - deVolta },
    // Com poucos pedidos, o dia e a hora não vão (um pedido só não é horário de pico).
    by_weekday: status === 'pronto' ? porDia : [],
    by_hour: status === 'pronto' ? porHora : [],
    peak: pico,
  };
}
