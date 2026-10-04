// Sombra de verdade (A3, I5; `ai-architecture.md` §4.3). O Liame ainda não executa nada em anúncio (isso
// é a A4). Aqui ele registra o que TERIA recomendado, com a confiança e o retrato do estado; depois olha o
// que a pessoa fez na plataforma e, passada a janela, compara o resultado: "se tivesse sido autorizado,
// teria melhorado ou piorado?". Tudo por regra, sem modelo de IA, com os mesmos números da tela Resultados.
// Funções puras; dinheiro em micros com BigInt.
import { VARIACAO_MAXIMA_DA_VERBA_PCT } from '../policy/engine.js';

/**
 * Versão do conjunto de regras: muda junto com qualquer limiar abaixo, e fica gravada em cada decisão.
 * 2 (04/10/2026): o passo da verba passa de 20% para 10%, junto com o limite por pedido da política.
 */
export const REGRAS_VERSAO = 2;
/** Dias completos olhados para decidir e, depois, para comparar o resultado. */
export const JANELA_DIAS = 7;

export const LIMIARES_SOMBRA = {
  /** Gasto mínimo da campanha na janela para haver recomendação (R$ 50). */
  gastoMinimoMicros: 50_000_000n,
  /** Variação da verba recomendada, em porcento: o mesmo limite por pedido da política, para a recomendação caber no pedido. */
  passoDaVerba: VARIACAO_MAXIMA_DA_VERBA_PCT,
  /** "No limite da verba": gasto da janela em pelo menos 80% da verba diária × dias. */
  usoDaVerbaPorMil: 800n,
  /** Lucro folgado: margem conhecida de pelo menos 1,5 vez o investimento. */
  lucroFolgadoPorMil: 1500n,
  /** Prejuízo forte: margem conhecida abaixo da metade do investimento. */
  prejuizoFortePorMil: 500n,
  /** Mudança de verba que conta como ação da pessoa: 5% para cima ou para baixo. */
  mudancaDeVerbaPorMil: 50n,
} as const;

export type AcaoSombra = 'campanha_pausar' | 'orcamento_reduzir' | 'orcamento_aumentar';
export type RegraSombra = 'prejuizo_forte' | 'prejuizo' | 'lucro_no_limite';

/** A campanha na janela, como a tela Resultados a mostra. */
export interface CampanhaNaJanela {
  status: string;
  dailyBudgetMicros: bigint | null;
  spendMicros: bigint;
  orders: number;
  revenueMicros: bigint;
  /** Nula sem nenhum pedido com o custo conhecido. */
  marginKnownMicros: bigint | null;
  /** Parte da receita com margem conhecida, de 0 a 1000. */
  marginCoveragePorMil: number;
  verdict: 'lucro' | 'empata' | 'prejuizo' | null;
}

export interface Recomendacao {
  tool: AcaoSombra;
  rule: RegraSombra;
  ruleVersion: number;
  /** Só nas de verba: quanto mudar, em porcento. */
  percent: number | null;
  /** De 0 a 1000. */
  confidencePorMil: number;
}

/**
 * Confiança da recomendação, de 400 a 1000: cresce com o gasto observado (até 4 vezes o mínimo) e com a
 * parte da receita que tem margem conhecida (de 80% a 100%). É evidência, não probabilidade.
 */
export function confianca(c: Pick<CampanhaNaJanela, 'spendMicros' | 'marginCoveragePorMil'>): number {
  const teto = LIMIARES_SOMBRA.gastoMinimoMicros * 4n;
  const peloGasto = c.spendMicros >= teto ? 300 : Number((c.spendMicros * 300n) / teto);
  const cobertura = Math.min(1000, Math.max(800, c.marginCoveragePorMil));
  const pelaMargem = Math.round(((cobertura - 800) * 300) / 200);
  return 400 + peloGasto + pelaMargem;
}

/**
 * O que o Liame recomendaria para a campanha, ou nada. Só campanha ativa, com gasto mínimo e com veredito
 * (o veredito já exige margem conhecida em 80% da receita). Recomendação de verba só quando a verba diária
 * está na campanha: com a verba no conjunto de anúncios, não há o que mexer neste nível.
 */
export function recomendar(c: CampanhaNaJanela): Recomendacao | null {
  if (c.status !== 'ativa' || c.spendMicros < LIMIARES_SOMBRA.gastoMinimoMicros || c.verdict === null || c.marginKnownMicros === null) return null;
  const base = { ruleVersion: REGRAS_VERSAO, confidencePorMil: confianca(c) };
  if (c.verdict === 'prejuizo') {
    if (c.marginKnownMicros * 1000n < c.spendMicros * LIMIARES_SOMBRA.prejuizoFortePorMil) return { ...base, tool: 'campanha_pausar', rule: 'prejuizo_forte', percent: null };
    if (c.dailyBudgetMicros === null || c.dailyBudgetMicros <= 0n) return null;
    return { ...base, tool: 'orcamento_reduzir', rule: 'prejuizo', percent: LIMIARES_SOMBRA.passoDaVerba };
  }
  if (c.verdict === 'lucro' && c.dailyBudgetMicros !== null && c.dailyBudgetMicros > 0n) {
    const folgado = c.marginKnownMicros * 1000n >= c.spendMicros * LIMIARES_SOMBRA.lucroFolgadoPorMil;
    const noLimite = c.spendMicros * 1000n >= c.dailyBudgetMicros * BigInt(JANELA_DIAS) * LIMIARES_SOMBRA.usoDaVerbaPorMil;
    if (folgado && noLimite) return { ...base, tool: 'orcamento_aumentar', rule: 'lucro_no_limite', percent: LIMIARES_SOMBRA.passoDaVerba };
  }
  return null;
}

// ------------------------------------------------------------ o que a pessoa fez

export type AcaoHumana = 'pausou' | 'reduziu_verba' | 'aumentou_verba' | 'nenhuma';
export type Concordancia = 'igual' | 'mesma_direcao' | 'contraria' | 'nenhuma';

export interface EstadoDaCampanha {
  status: string;
  dailyBudgetMicros: bigint | null;
}

/**
 * A ação da pessoa na plataforma, vista pela leitura diária: compara a campanha de hoje com o retrato da
 * decisão. Campanha que sumiu, foi pausada ou arquivada conta como pausa; verba só conta com mudança de
 * 5% ou mais.
 */
export function acaoHumana(antes: EstadoDaCampanha, agora: EstadoDaCampanha | null): AcaoHumana {
  if (agora === null || (antes.status === 'ativa' && agora.status !== 'ativa' && agora.status !== 'desconhecida')) return 'pausou';
  const [a, b] = [antes.dailyBudgetMicros, agora.dailyBudgetMicros];
  if (a !== null && b !== null && a > 0n) {
    const diferenca = (b - a) * 1000n;
    if (diferenca <= -a * LIMIARES_SOMBRA.mudancaDeVerbaPorMil) return 'reduziu_verba';
    if (diferenca >= a * LIMIARES_SOMBRA.mudancaDeVerbaPorMil) return 'aumentou_verba';
  }
  return 'nenhuma';
}

const DIRECAO: Record<AcaoSombra | Exclude<AcaoHumana, 'nenhuma'>, -1 | 1> = {
  campanha_pausar: -1,
  orcamento_reduzir: -1,
  orcamento_aumentar: 1,
  pausou: -1,
  reduziu_verba: -1,
  aumentou_verba: 1,
};
const MESMA_ACAO: Record<AcaoSombra, AcaoHumana> = { campanha_pausar: 'pausou', orcamento_reduzir: 'reduziu_verba', orcamento_aumentar: 'aumentou_verba' };

/** A pessoa fez o mesmo que o Liame recomendaria, foi na mesma direção, na contrária, ou não mexeu. */
export function concordancia(recomendada: AcaoSombra, humana: AcaoHumana): Concordancia {
  if (humana === 'nenhuma') return 'nenhuma';
  if (MESMA_ACAO[recomendada] === humana) return 'igual';
  return DIRECAO[recomendada] === DIRECAO[humana] ? 'mesma_direcao' : 'contraria';
}

// ------------------------------------------------------------ arrependimento

export type RotuloDoArrependimento = 'teria_melhorado' | 'teria_piorado' | 'igual' | 'sem_dado';

/** A campanha nos dias depois da decisão. */
export interface ResultadoDepois {
  spendMicros: bigint;
  orders: number;
  marginKnownMicros: bigint | null;
  marginCoveragePorMil: number;
}

export interface Arrependimento {
  /**
   * Resultado de verdade (margem conhecida − investimento, com o que a pessoa fez) menos o resultado
   * estimado se a recomendação tivesse sido executada. Negativo: o Liame teria feito melhor. Nulo sem
   * dado para comparar.
   */
  regretMicros: bigint | null;
  label: RotuloDoArrependimento;
}

/**
 * "Se tivesse sido autorizado, teria melhorado ou piorado?" A estimativa é linear e simples de propósito:
 * pausar zera o resultado da campanha na janela; mexer p% na verba mexe p% no resultado. Vale só quando a
 * pessoa não mexeu (ou, na pausa recomendada, quando ela manteve a campanha no ar): com a pessoa indo
 * para outro lado, a campanha que se observa já não é a da recomendação, e não há o que comparar.
 */
export function arrependimento(recomendada: AcaoSombra, percent: number | null, humana: AcaoHumana, depois: ResultadoDepois | null): Arrependimento {
  if (MESMA_ACAO[recomendada] === humana) return { regretMicros: 0n, label: 'igual' };
  const semDado: Arrependimento = { regretMicros: null, label: 'sem_dado' };
  if (depois === null) return semDado;
  // Sem pedido, a margem é zero com certeza; com pedido, só vale com 80% da receita com margem conhecida.
  const margem = depois.orders === 0 ? 0n : depois.marginCoveragePorMil >= 800 ? depois.marginKnownMicros : null;
  if (margem === null) return semDado;
  const sobra = margem - depois.spendMicros;
  let regret: bigint;
  if (recomendada === 'campanha_pausar') {
    if (humana === 'pausou') return { regretMicros: 0n, label: 'igual' };
    regret = sobra;
  } else {
    if (humana !== 'nenhuma' || percent === null || depois.spendMicros === 0n) return semDado;
    const parte = (sobra * BigInt(percent)) / 100n;
    regret = recomendada === 'orcamento_reduzir' ? parte : -parte;
  }
  // Diferença abaixo de R$ 1 ou de 1% do gasto é ruído.
  const folga = depois.spendMicros / 100n > 1_000_000n ? depois.spendMicros / 100n : 1_000_000n;
  return { regretMicros: regret, label: regret < -folga ? 'teria_melhorado' : regret > folga ? 'teria_piorado' : 'igual' };
}

// ------------------------------------------------------------ prontidão

/** Portões da promoção de modo (`ai-architecture.md` §4.2), como proposta a calibrar no piloto. */
export const PORTOES = { amostra: 30, concordanciaPorMil: 800, pioraPorMil: 100, confiancaPorMil: 700 } as const;

export interface DecisaoAvaliada {
  agreement: Concordancia;
  label: RotuloDoArrependimento;
  regretMicros: bigint | null;
  confidencePorMil: number;
}

export interface Prontidao {
  /** Decisões comparáveis: avaliadas e com dado para dizer se teria melhorado ou piorado. */
  sampleSize: number;
  agreementPorMil: number | null;
  /** Parte das comparáveis em que o Liame teria piorado. */
  worsePorMil: number | null;
  regretSumMicros: bigint;
  confidenceAvgPorMil: number | null;
  /** O que falta para propor a promoção; vazio = pronto para a proposta (quem aprova é uma pessoa). */
  missing: string[];
}

/** Sinais de prontidão de uma ferramenta numa conta, a partir das decisões já avaliadas. */
export function prontidao(decisoes: DecisaoAvaliada[]): Prontidao {
  const comparaveis = decisoes.filter((d) => d.label !== 'sem_dado' && d.regretMicros !== null);
  const n = comparaveis.length;
  const porMil = (parte: number) => (n ? Math.round((parte * 1000) / n) : null);
  const agreementPorMil = porMil(comparaveis.filter((d) => d.agreement === 'igual' || d.agreement === 'mesma_direcao').length);
  const worsePorMil = porMil(comparaveis.filter((d) => d.label === 'teria_piorado').length);
  const regretSumMicros = comparaveis.reduce((s, d) => s + (d.regretMicros ?? 0n), 0n);
  const confidenceAvgPorMil = n ? Math.round(comparaveis.reduce((s, d) => s + d.confidencePorMil, 0) / n) : null;
  const missing: string[] = [];
  if (n < PORTOES.amostra) missing.push('amostra');
  if (agreementPorMil === null || agreementPorMil < PORTOES.concordanciaPorMil) missing.push('concordancia');
  if (worsePorMil === null || worsePorMil > PORTOES.pioraPorMil) missing.push('piora');
  if (regretSumMicros > 0n) missing.push('arrependimento');
  if (confidenceAvgPorMil === null || confidenceAvgPorMil < PORTOES.confiancaPorMil) missing.push('confianca');
  return { sampleSize: n, agreementPorMil, worsePorMil, regretSumMicros, confidenceAvgPorMil, missing };
}
