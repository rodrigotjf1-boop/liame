import type { LanguageModelUsage } from 'ai';

// Custo de uma chamada (ADR-006): nenhum SDK informa o valor em dinheiro, então ele sai da tabela de
// preços versionada (`ai_model_price`) × tokens, contando o cache. Tudo em micros de dólar e em
// BigInt: a soma do mês não pode acumular erro de ponto flutuante.

/** Os preços de uma faixa, por milhão de tokens, em micros de dólar (US$ 4 = 4000000n). */
export interface PrecoDaFaixa {
  input: bigint;
  output: bigint;
  cacheRead: bigint;
  cacheWrite5m: bigint;
  cacheWrite1h: bigint;
}

/**
 * O preço de um modelo. `acima`: a faixa do prompt longo (o Haiku 5.5, desde 29/10/2026): o pedido cujo prompt passa de
 * `tokens` paga os preços dela em tudo, a saída também. O prompt conta toda a entrada, inclusive a lida e a escrita no
 * cache, e cada pedido é cobrado por si (a página oficial de preços, "Long context pricing").
 */
export interface PrecoModelo extends PrecoDaFaixa {
  acima?: { tokens: number; preco: PrecoDaFaixa };
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

/** A linha de `liame.ai_model_price` como o gateway a lê (o bigint em texto; a faixa, vazia no modelo que não tem). */
export type LinhaDoPreco = {
  input: string;
  output: string;
  cache_read: string;
  cache_write_5m: string;
  cache_write_1h: string;
  acima_de: number | null;
  l_input: string | null;
  l_output: string | null;
  l_cache_read: string | null;
  l_cache_write_5m: string | null;
  l_cache_write_1h: string | null;
};

/** O preço da linha, com a faixa quando ela veio inteira (o banco já exige as seis colunas juntas: 0089). */
export function precoDaLinha(l: LinhaDoPreco): PrecoModelo {
  const base: PrecoModelo = { input: BigInt(l.input), output: BigInt(l.output), cacheRead: BigInt(l.cache_read), cacheWrite5m: BigInt(l.cache_write_5m), cacheWrite1h: BigInt(l.cache_write_1h) };
  if (l.acima_de === null || l.l_input === null || l.l_output === null || l.l_cache_read === null || l.l_cache_write_5m === null || l.l_cache_write_1h === null) return base;
  return {
    ...base,
    acima: {
      tokens: Number(l.acima_de),
      preco: { input: BigInt(l.l_input), output: BigInt(l.l_output), cacheRead: BigInt(l.l_cache_read), cacheWrite5m: BigInt(l.l_cache_write_5m), cacheWrite1h: BigInt(l.l_cache_write_1h) },
    },
  };
}

/** O tamanho do prompt do pedido, para a faixa: toda a entrada, a lida e a escrita no cache também. */
export const tamanhoDoPrompt = (tokens: Pick<TokensUsados, 'input' | 'cacheRead' | 'cacheWrite'>): number => tokens.input + tokens.cacheRead + tokens.cacheWrite;

/** Os preços que valem para o pedido: os da faixa do prompt longo, quando o prompt passa dela; senão, os de sempre. */
export function precoDoPedido(preco: PrecoModelo, tokens: Pick<TokensUsados, 'input' | 'cacheRead' | 'cacheWrite'>): PrecoDaFaixa {
  return preco.acima && tamanhoDoPrompt(tokens) > preco.acima.tokens ? preco.acima.preco : preco;
}

/** Custo em micros de dólar, arredondado para cima uma única vez (nunca cobra a menos). */
export function custoMicros(precoDoModelo: PrecoModelo, tokens: TokensUsados, opcoes: OpcoesDeCusto): bigint {
  const preco = precoDoPedido(precoDoModelo, tokens);
  const soma =
    BigInt(tokens.input) * preco.input +
    BigInt(tokens.cacheRead) * preco.cacheRead +
    BigInt(tokens.cacheWrite) * (opcoes.cache === '1h' ? preco.cacheWrite1h : preco.cacheWrite5m) +
    BigInt(tokens.output) * preco.output;
  const numerador = soma * (opcoes.geo === 'us' ? 11n : 10n);
  const denominador = MILHAO * 10n * (opcoes.lote ? 2n : 1n);
  return (numerador + denominador - 1n) / denominador;
}
