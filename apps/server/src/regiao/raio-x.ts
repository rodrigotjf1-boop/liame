import type { RegionNumber, RegionSourceStatus } from '@liame/contracts';
import { FONTE_CENSO_BAIRRO } from './censo.js';
import { LEITURAS_DO_MUNICIPIO } from './ibge.js';

// Sua região (plano da região, R2): as contas puras do retrato, sem banco e sem rede. Os números vêm das tabelas do
// sistema (migration 0137); aqui só se escolhe o mais novo, se calcula o que é conta (densidade, por 10 mil habitantes,
// a posição entre os bairros) e se diz a situação de cada fonte.

/** As fontes que o retrato de uma loja usa: os bairros do Censo (país inteiro) e as tabelas do município. */
export const FONTES_DO_RETRATO = [FONTE_CENSO_BAIRRO, ...LEITURAS_DO_MUNICIPIO.map((l) => l.fonte)] as const;

export type NumeroGuardado = {
  indicator: string;
  period: string;
  value: number | string;
  source: string;
};

export type LeituraGuardada = {
  source: string;
  geo_code: string;
  last_ok_at: Date | string | null;
  last_error: string | null;
  next_try_at: Date | string | null;
};

const iso = (v: Date | string | null): string | null => (v === null ? null : (v instanceof Date ? v : new Date(v)).toISOString());

/** O número mais novo de um indicador (o período maior), com a fonte. */
export function numeroMaisNovo(numeros: readonly NumeroGuardado[], indicador: string): RegionNumber | null {
  let melhor: NumeroGuardado | null = null;
  for (const n of numeros) if (n.indicator === indicador && (!melhor || n.period > melhor.period)) melhor = n;
  return melhor ? { value: Number(melhor.value), period: melhor.period, source: melhor.source } : null;
}

/** Pessoas por km², com uma casa; nulo sem pessoas ou sem área. */
export function densidade(pessoas: number | null, areaKm2: number | null): number | null {
  if (pessoas === null || areaKm2 === null || areaKm2 <= 0) return null;
  return Math.round((pessoas / areaKm2) * 10) / 10;
}

/** Quantos por 10 mil habitantes, com uma casa. */
export function por10Mil(quantos: number | null, populacao: number | null): number | null {
  if (quantos === null || populacao === null || populacao <= 0) return null;
  return Math.round((quantos / populacao) * 100_000) / 10;
}

/** Acima de quantos por cento dos bairros com renda (inteiro, para baixo). */
export function acimaDe(abaixo: number, total: number): number {
  if (total <= 0) return 0;
  return Math.floor((abaixo / total) * 100);
}

/**
 * A situação de uma fonte: `lendo` enquanto nunca deu certo nem falhou; `falhou` quando nunca deu certo e a última
 * tentativa falhou; `em_dia` quando já deu certo (o número guardado vale, mesmo que a renovação falhe depois).
 */
export function situacaoDaFonte(fonte: string, leitura: LeituraGuardada | undefined): RegionSourceStatus {
  if (!leitura) return { source: fonte, status: 'lendo', read_at: null, next_try_at: null };
  if (leitura.last_ok_at) return { source: fonte, status: 'em_dia', read_at: iso(leitura.last_ok_at), next_try_at: null };
  return { source: fonte, status: leitura.last_error ? 'falhou' : 'lendo', read_at: null, next_try_at: iso(leitura.next_try_at) };
}

/** A situação do retrato: `lendo` se alguma fonte ainda não foi lida, `parcial` se alguma falhou, senão `pronto`. */
export function situacaoDoRetrato(fontes: readonly RegionSourceStatus[]): 'lendo' | 'parcial' | 'pronto' {
  if (fontes.some((f) => f.status === 'lendo')) return 'lendo';
  if (fontes.some((f) => f.status === 'falhou')) return 'parcial';
  return 'pronto';
}
