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

export type AcaoDoAviso = 'abrir-contas' | 'reconectar' | 'abrir-links' | 'abrir-cupons' | 'abrir-resultados';

/**
 * O botão de cada aviso, como no protótipo: conta desconectada leva a Contas; autorização vencendo reconecta.
 * Os avisos do ciclo fechado (F9) levam à tela onde se resolve: Links e cupons ou Resultados.
 */
export function acaoDoAviso(kind: string): AcaoDoAviso | null {
  if (kind === 'conta_desconectada' || kind === 'vendas_nao_conectadas') return 'abrir-contas';
  if (kind === 'reconectar_em_breve') return 'reconectar';
  if (kind === 'anuncio_sem_rastreio' || kind === 'plataforma_nao_informada') return 'abrir-links';
  if (kind === 'campanha_sem_cupom' || kind === 'cupom_sem_uso') return 'abrir-cupons';
  if (kind === 'campanha_sem_pedido' || kind === 'margem_desconhecida' || kind === 'plataforma_x_caixa' || kind === 'vendas_nao_medidas') return 'abrir-resultados';
  // Fora do normal (A3, I6): vendas, gasto da campanha e custo por pedido se conferem em Resultados.
  if (kind === 'vendas_fora_do_normal' || kind === 'gasto_da_campanha_fora_do_normal' || kind === 'custo_por_pedido_fora_do_normal') return 'abrir-resultados';
  return null;
}

/** Para onde leva o botão de tela (os de Contas e de reconectar têm o próprio tratamento). */
export function destinoDoAviso(acao: AcaoDoAviso): { href: string; rotulo: string } | null {
  if (acao === 'abrir-links') return { href: '/links', rotulo: 'Abrir Links e cupons' };
  if (acao === 'abrir-cupons') return { href: '/links#cupons', rotulo: 'Abrir os cupons' };
  if (acao === 'abrir-resultados') return { href: '/resultados', rotulo: 'Abrir Resultados' };
  return null;
}

const PESO: Record<Gravidade, number> = { critica: 0, atencao: 1, info: 2 };

/**
 * Os avisos de mídia e os do ciclo fechado numa lista só: mais grave primeiro; na mesma gravidade, os de mídia
 * antes (cada API já manda os dela na ordem).
 */
export function juntarAvisos<T extends Pick<AttentionItem, 'severity'>>(midia: T[], ciclo: T[]): T[] {
  return [...midia, ...ciclo]
    .map((item, i) => ({ item, i }))
    .sort((a, b) => PESO[gravidadeDe(a.item.severity)] - PESO[gravidadeDe(b.item.severity)] || a.i - b.i)
    .map((x) => x.item);
}
