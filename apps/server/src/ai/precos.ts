import type { LanguageModelUsage } from 'ai';

// Custo de uma chamada (ADR-006): nenhum SDK informa o valor em dinheiro, então ele sai da tabela de
// preços versionada (`ai_model_price`) × tokens, contando o cache. Tudo em micros de dólar e em
// BigInt: a soma do mês não pode acumular erro de ponto flutuante.

/** Preço por milhão de tokens, em micros de dólar (US$ 4 = 4000000n). */
export interface PrecoModelo {
  input: bigint;
  output: bigint;
  cacheRead: bigint;
  cacheWrite5m: bigint;
  cacheWrite1h: bigint;
}

export interface TokensUsados {
  /** Entrada cobrada pelo preço cheio (sem a parte lida ou escrita no cache). */
  input: number;
  cacheRead: number;
  cacheWrite: number;
  /** Saída total (o raciocínio já está dentro). */
  output: number;
  /** Parte da saída que foi raciocínio: só informação, não entra duas vezes na conta. */
  reasoning: number;
}

export interface OpcoesDeCusto {
  /** `us` custa 10% a mais em todos os tokens (data residency da Anthropic). */
  geo: 'us' | 'global';
  /** Lote (Batch API): metade do preço. */
  lote?: boolean;
  /** Prazo do cache escrito nesta chamada. */
  cache?: '5m' | '1h';
}

const MILHAO = 1_000_000n;

/** Lê o uso que o AI SDK devolve. Sem o detalhe do cache, a entrada cheia é o total menos o cache. */
export function tokensDe(usage: LanguageModelUsage): TokensUsados {
  const cacheRead = usage.inputTokenDetails?.cacheReadTokens ?? 0;
  const cacheWrite = usage.inputTokenDetails?.cacheWriteTokens ?? 0;
  const input = usage.inputTokenDetails?.noCacheTokens ?? Math.max(0, (usage.inputTokens ?? 0) - cacheRead - cacheWrite);
  return {
    input,
    cacheRead,
    cacheWrite,
    output: usage.outputTokens ?? 0,
    reasoning: usage.outputTokenDetails?.reasoningTokens ?? 0,
  };
}

/** Custo em micros de dólar, arredondado para cima uma única vez (nunca cobra a menos). */
export function custoMicros(preco: PrecoModelo, tokens: TokensUsados, opcoes: OpcoesDeCusto): bigint {
  const soma =
    BigInt(tokens.input) * preco.input +
    BigInt(tokens.cacheRead) * preco.cacheRead +
    BigInt(tokens.cacheWrite) * (opcoes.cache === '1h' ? preco.cacheWrite1h : preco.cacheWrite5m) +
    BigInt(tokens.output) * preco.output;
  const numerador = soma * (opcoes.geo === 'us' ? 11n : 10n);
  const denominador = MILHAO * 10n * (opcoes.lote ? 2n : 1n);
  return (numerador + denominador - 1n) / denominador;
}
