// A verba na Meta (base de conhecimento §2.1): o orçamento vem e vai na menor unidade da moeda da conta (centavos no
// real; a própria unidade nas moedas sem casas decimais). No Liame, dinheiro é sempre em micros (1 unidade = 1.000.000).
// Funções puras, sem dependência: servem ao conector de leitura, ao de escrita e ao registro de ferramentas.

/** Moedas sem casas decimais: o "menor unidade" da Meta já é a unidade. */
export const SEM_DECIMAIS = new Set(['JPY', 'KRW', 'CLP', 'PYG', 'VND', 'ISK', 'HUF', 'TWD', 'COP', 'IDR', 'UGX']);

/** Orçamento da Meta vem na menor unidade da moeda (centavos no BRL) → micros (1 unidade = 1.000.000). */
export function orcamentoEmMicros(valor: string | undefined, moeda: string | null): number | null {
  if (valor === undefined || valor === null || valor === '') return null;
  const n = Number(valor);
  if (!Number.isFinite(n)) return null;
  return moeda && SEM_DECIMAIS.has(moeda) ? n * 1_000_000 : n * 10_000;
}

/** Micros → a menor unidade da moeda, como a Meta recebe a verba (centavos no real). Nulo se sobrar fração. */
export function emMenorUnidade(micros: number, moeda: string | null): number | null {
  if (!Number.isSafeInteger(micros) || micros <= 0) return null;
  const divisor = moeda && SEM_DECIMAIS.has(moeda) ? 1_000_000 : 10_000;
  return micros % divisor === 0 ? micros / divisor : null;
}
