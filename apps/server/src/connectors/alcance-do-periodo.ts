// O alcance do período (P23, "Como os anúncios rodaram"): pessoas diferentes que viram os anúncios, lido da Meta como
// um número só para cada período que a tela mostra. O alcance de cada dia (`reach`, por anúncio) não se soma: a mesma
// pessoa vista em dois dias conta duas vezes. A Meta devolve "one result set for the whole period" quando a consulta
// vai sem `time_increment` (o padrão é `all_days`), e chama o alcance de estimado
// (developers.facebook.com/documentation/ads-commerce/marketing-api/reference/ad-account/insights, lido em 16/10/2026).
// Os dias vão escritos (since/until), nunca `last_7d`: a página não diz se ele inclui o dia de hoje.

const DIA_MS = 86_400_000;
const menosDias = (dia: string, n: number) => new Date(new Date(`${dia}T00:00:00Z`).getTime() - n * DIA_MS).toISOString().slice(0, 10);

/** As métricas do alcance do período, gravadas por campanha e pela conta, com `metric_date` = o último dia da faixa. */
export const METRICAS_DE_PERIODO = ['reach_dia', 'reach_7d', 'reach_30d'] as const;
export type MetricaDePeriodo = (typeof METRICAS_DE_PERIODO)[number];

export type FaixaDoAlcance = { metrica: MetricaDePeriodo; since: string; until: string };

/**
 * As três faixas a pedir numa leitura que termina em `fim` (o dia de hoje no fuso da conta): o próprio dia (até a hora
 * da leitura), os 7 dias completos até a véspera e os 30 dias completos até a véspera, como Resultados conta os
 * períodos.
 */
export function faixasDoAlcance(fim: string): FaixaDoAlcance[] {
  const vespera = menosDias(fim, 1);
  return [
    { metrica: 'reach_dia', since: fim, until: fim },
    { metrica: 'reach_7d', since: menosDias(fim, 7), until: vespera },
    { metrica: 'reach_30d', since: menosDias(fim, 30), until: vespera },
  ];
}

/** Qual faixa uma linha da Meta responde (pelo começo e pelo fim que ela devolve); nula se não é nenhuma. */
export function faixaDaLinha(faixas: FaixaDoAlcance[], dateStart: string | undefined, dateStop: string | undefined): FaixaDoAlcance | null {
  return faixas.find((f) => f.since === dateStart && f.until === dateStop) ?? null;
}

/**
 * Qual métrica do alcance vale para um período da tela (de `from` a `to`, inclusive) e o dia em que ela está gravada.
 * Só os três períodos de Resultados têm alcance: hoje (um dia, o de hoje), 7 e 30 dias. Qualquer outro, nulo: a tela
 * mostra "—", nunca a soma do alcance de cada dia.
 */
export function metricaDoPeriodo(from: string, to: string, hoje: string): { metrica: MetricaDePeriodo; dia: string } | null {
  const dias = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DIA_MS + 1;
  if (dias === 1 && to === hoje) return { metrica: 'reach_dia', dia: to };
  if (dias === 7) return { metrica: 'reach_7d', dia: to };
  if (dias === 30) return { metrica: 'reach_30d', dia: to };
  return null;
}
