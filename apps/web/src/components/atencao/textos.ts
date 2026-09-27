import type { AttentionItem } from '@liame/contracts';

// Regras e frases de "Atenção de mídia" (mockups/prototipo-contas.html). A gravidade e o tipo chegam
// como texto (V23): valor que a tela ainda não conhece cai em "Informação" e não ganha botão.

export type Gravidade = 'critica' | 'atencao' | 'info';
export const GRAVIDADES: Gravidade[] = ['critica', 'atencao', 'info'];

const ROTULOS: Record<Gravidade, { aviso: string; filtro: string }> = {
  critica: { aviso: 'Crítico', filtro: 'Críticos' },
  atencao: { aviso: 'Atenção', filtro: 'Atenção' },
  info: { aviso: 'Informação', filtro: 'Informação' },
};

export function gravidadeDe(severity: string): Gravidade {
  return severity === 'critica' || severity === 'atencao' ? severity : 'info';
}

export function rotuloDaGravidade(g: Gravidade): string {
  return ROTULOS[g].aviso;
}

export function rotuloDoFiltro(g: Gravidade | 'todas'): string {
  return g === 'todas' ? 'Todos' : ROTULOS[g].filtro;
}

/** Quantos avisos há de cada gravidade (e no total), para os filtros. */
export function contagemPorGravidade(itens: Pick<AttentionItem, 'severity'>[]): Record<Gravidade | 'todas', number> {
  const c = { todas: itens.length, critica: 0, atencao: 0, info: 0 };
  for (const i of itens) c[gravidadeDe(i.severity)]++;
  return c;
}

/** Número do menu: o que pede alguém agora (crítico e atenção; informação não conta). */
export function contadorDoMenu(itens: Pick<AttentionItem, 'severity'>[]): number {
  const c = contagemPorGravidade(itens);
  return c.critica + c.atencao;
}

/** ", 5 avisos" para quem ouve o menu (o número em si é decorativo). */
export function avisosFalados(n: number): string {
  return n === 1 ? ', 1 aviso' : `, ${n} avisos`;
}

/**
 * "O que fazer: confira…": a frase da API começa com maiúscula; depois dos dois-pontos, minúscula, como
 * no protótipo. Sigla ou nome próprio no começo ("GA4", "Liame") fica como está.
 */
export function oQueFazer(acao: string): string {
  if (/^\p{Lu}\p{Ll}/u.test(acao) && !/^(Liame|Meta|Google)\b/.test(acao)) return acao[0]!.toLocaleLowerCase('pt-BR') + acao.slice(1);
  return acao;
}

/** O botão de cada aviso, como no protótipo: conta desconectada leva a Contas; autorização vencendo reconecta. */
export function acaoDoAviso(kind: string): 'abrir-contas' | 'reconectar' | null {
  if (kind === 'conta_desconectada') return 'abrir-contas';
  if (kind === 'reconectar_em_breve') return 'reconectar';
  return null;
}
