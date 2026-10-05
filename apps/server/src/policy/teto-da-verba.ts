import type { PolicyDocument, PolicyRule } from '@liame/contracts';
import { actionMatches, type LoadedPolicy } from './engine.js';

// O teto por campanha (A4, X4; `plano-a4.md` D-A4-13, D-A4-19 e D-A4-22): a maior verba diária que um aumento pode
// deixar numa campanha ou num conjunto. Na política, é uma regra `max_value` que casa com `orcamento.aumentar`; a tela
// Verba do mês escreve a dela na política da empresa, sem provedor (vale em toda plataforma em que o Liame muda verba).
// Funções puras.

const AUMENTAR = 'orcamento.aumentar';

type TetoPorValor = Extract<PolicyRule, { type: 'max_value' }>;

const noProvedor = (regra: { provider?: string | undefined }, provider: string): boolean => !regra.provider || regra.provider === provider;

/** A regra é um teto para aumentar verba neste provedor? */
const ehTeto = (r: PolicyRule, provider: string): r is TetoPorValor => r.type === 'max_value' && actionMatches(r.action, AUMENTAR) && noProvedor(r, provider);

/**
 * O teto por campanha que vale para aumentar verba no provedor: o menor entre os da empresa e os da marca. Nulo quando
 * nenhuma das duas definiu (a política da distribuição não conta: o limite é de quem paga).
 */
export function tetoDaVerba(policies: readonly LoadedPolicy[], provider: string): number | null {
  const tetos = policies.filter((p) => p.source !== 'platform').flatMap((p) => p.document.rules.filter((r) => ehTeto(r, provider)).map((r) => r.max_micros));
  return tetos.length ? Math.min(...tetos) : null;
}

/** A regra que a tela escreve: teto de verba sem provedor. As que alguém escreveu com provedor ficam como estão. */
const ehRegraDaTela = (r: PolicyRule): boolean => r.type === 'max_value' && r.provider === undefined && (r.action === 'orcamento.*' || r.action === AUMENTAR);

/** O documento já tem a regra da tela com este valor, e só ela? Salvar de novo não publica outra versão. */
export function temOTetoDaVerba(doc: PolicyDocument | null, maxMicros: number): boolean {
  const daTela = (doc?.rules ?? []).filter(ehRegraDaTela);
  return daTela.length === 1 && daTela[0]!.type === 'max_value' && daTela[0]!.action === 'orcamento.*' && daTela[0]!.max_micros === maxMicros;
}

/**
 * O documento da política da empresa com o teto por campanha trocado. As outras regras ficam como estão, na mesma
 * ordem; a regra nova vai no fim. O padrão `orcamento.*` não barra a redução: o motor só aplica o teto ao que faz o
 * gasto subir (D-A4-16).
 */
export function comTetoDaVerba(doc: PolicyDocument | null, maxMicros: number): PolicyDocument {
  const regras = (doc?.rules ?? []).filter((r) => !ehRegraDaTela(r));
  return { rules: [...regras, { type: 'max_value', action: 'orcamento.*', max_micros: maxMicros }] };
}

export interface RegrasDaVerba {
  /** Quanto um pedido pode mexer na verba diária, em %. */
  change_percent_max: number | null;
  /** Quantas mudanças de verba o mesmo objeto aceita por janela. */
  rate_limit: { max: number; window_minutes: number } | null;
}

/** As regras de verba que valem sempre no provedor (as da distribuição), para a tela citar com o número certo. */
export function regrasDaVerba(policies: readonly LoadedPolicy[], provider: string): RegrasDaVerba {
  const regras = policies.flatMap((p) => p.document.rules);
  const variacoes = regras.flatMap((r) => (r.type === 'max_change_percent' && actionMatches(r.action, AUMENTAR) && noProvedor(r, provider) && r.direction !== 'decrease' ? [r.max_percent] : []));
  const frequencias = regras.flatMap((r) => (r.type === 'rate_limit' && actionMatches(r.action, AUMENTAR) && noProvedor(r, provider) && r.per === 'resource' ? [{ max: r.max, window_minutes: r.window_minutes }] : []));
  // Com mais de uma, a tela cita a que aperta mais: menos mudanças por minuto de janela.
  frequencias.sort((a, b) => a.max / a.window_minutes - b.max / b.window_minutes);
  return { change_percent_max: variacoes.length ? Math.min(...variacoes) : null, rate_limit: frequencias[0] ?? null };
}
