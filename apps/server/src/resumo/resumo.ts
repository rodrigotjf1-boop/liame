import type { AttentionItem, ClosedLoopResponse, ConfirmedResult, SummaryResponse } from '@liame/contracts';

// O Resumo (A3, I13c; protótipo P8): os blocos montados a partir dos mesmos resultados da tela Resultados (os últimos
// 7 dias completos e os 7 antes) e dos avisos da Atenção. Funções puras; dinheiro em micros com BigInt.

/** Cobertura mínima da margem conhecida para dizer quanto sobrou (a mesma do veredito de Resultados). */
export const COBERTURA_MINIMA_PCT = 80;
/** Campanhas de cada lado do veredito. */
export const CAMPANHAS_DO_VEREDITO = 3;
/** Avisos no bloco "Precisa de você". */
export const AVISOS_DO_RESUMO = 5;

/** O que sobrou depois de pagar os anúncios: margem conhecida − gasto; nulo sem margem ou com cobertura abaixo de 80%. */
export function sobrou(confirmado: Pick<ConfirmedResult, 'margin_known_micros' | 'margin_coverage_pct'>, gastoMicros: string): string | null {
  if (confirmado.margin_known_micros === null || confirmado.margin_coverage_pct === null) return null;
  if (Number(confirmado.margin_coverage_pct) < COBERTURA_MINIMA_PCT) return null;
  return (BigInt(confirmado.margin_known_micros) - BigInt(gastoMicros)).toString();
}

export function dinheiroDoResumo(atual: ClosedLoopResponse, anterior: ClosedLoopResponse | null): SummaryResponse['money'] {
  const [t, a] = [atual.totals, anterior?.totals ?? null];
  return {
    revenue_micros: { now: t.confirmed.revenue_micros, before: a?.confirmed.revenue_micros ?? null },
    spend_micros: { now: t.spend_micros, before: a?.spend_micros ?? null },
    left_micros: { now: sobrou(t.confirmed, t.spend_micros), before: a ? sobrou(a.confirmed, a.spend_micros) : null },
    margin_known_micros: t.confirmed.margin_known_micros,
    margin_coverage_pct: t.confirmed.margin_coverage_pct,
    // A receita com margem conhecida, para a tela separar o custo dos produtos do que não tem custo cadastrado.
    ...(t.confirmed.revenue_with_margin_micros !== undefined ? { revenue_with_margin_micros: t.confirmed.revenue_with_margin_micros } : {}),
    verdict: t.confirmed.verdict,
  };
}

/** As campanhas que deram lucro e as que deram prejuízo (pela regra de Resultados), as de maior gasto primeiro. */
export function campanhasDoVeredito(atual: ClosedLoopResponse): SummaryResponse['campaigns'] {
  const porGasto = [...atual.campaigns].sort((x, y) => {
    const d = BigInt(y.platform.spend_micros) - BigInt(x.platform.spend_micros);
    return d > 0n ? 1 : d < 0n ? -1 : x.name.localeCompare(y.name, 'pt-BR');
  });
  const lado = (verdict: string) =>
    porGasto
      .filter((c) => c.confirmed.verdict === verdict)
      .slice(0, CAMPANHAS_DO_VEREDITO)
      .map((c) => ({ campaign_id: c.campaign_id, name: c.name, provider: c.provider }));
  return { profit: lado('lucro'), loss: lado('prejuizo') };
}

export function pedidosDoResumo(atual: ClosedLoopResponse): SummaryResponse['orders'] {
  const t = atual.totals;
  const n = t.confirmed.orders;
  return {
    marketing: n,
    average_micros: n > 0 ? (BigInt(t.confirmed.revenue_micros) / BigInt(n)).toString() : null,
    all_channels: t.orders_confirmed,
    without_origin: t.without_origin.orders,
  };
}

/** Por plataforma de anúncio: os pedidos com origem nela, o que sobrou e o que ela gastou. */
export function plataformasDoResumo(atual: ClosedLoopResponse): SummaryResponse['platforms'] {
  return atual.platforms.map((p) => ({ provider: p.provider, orders: p.confirmed.orders, left_micros: sobrou(p.confirmed, p.platform.spend_micros), spend_micros: p.platform.spend_micros }));
}

const PESO: Record<string, number> = { critica: 0, atencao: 1 };

/**
 * "Precisa de você": os avisos críticos e de atenção (informação não pede ninguém), o mais grave primeiro; na mesma
 * gravidade, os de mídia antes (como a tela Atenção junta as duas listas). Conta os dois e devolve até 5.
 */
export function avisosQuePrecisam(midia: AttentionItem[], ciclo: AttentionItem[]): { critical: number; attention: number; items: AttentionItem[] } {
  const todos = [...midia, ...ciclo].filter((i) => i.severity in PESO);
  const ordenados = todos.map((item, i) => ({ item, i })).sort((a, b) => PESO[a.item.severity]! - PESO[b.item.severity]! || a.i - b.i);
  return {
    critical: todos.filter((i) => i.severity === 'critica').length,
    attention: todos.filter((i) => i.severity === 'atencao').length,
    items: ordenados.slice(0, AVISOS_DO_RESUMO).map((x) => x.item),
  };
}
