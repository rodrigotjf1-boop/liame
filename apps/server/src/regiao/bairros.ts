import type { BairrosRegem } from '../connectors/regem/contrato-regem.js';

// Os pedidos da loja por bairro (plano da região, R3, parte 2; D-RG-8; D-RG-36 a D-RG-39): a resposta do Regem em linhas
// para gravar e a conta de "atacar e defender" (plano da região §4.2, jogada 2): a gente do bairro (o Censo) e os
// pedidos por mil moradores. Contas puras, sem banco: o serviço traz os pedidos e a gente de cada bairro.

/** Os bairros que a seção mostra. */
export const BAIRROS_NA_SECAO = 12;
/** Para comparar, pelo menos 3 bairros com gente conhecida. */
export const BAIRROS_PARA_COMPARAR = 3;
/** Defender: pedidos por mil moradores 1,5 vez a mediana ou mais; atacar: a metade da mediana ou menos (e gente acima da mediana). */
export const ACIMA_PARA_DEFENDER = 1.5;
export const ABAIXO_PARA_ATACAR = 0.5;

/** Uma linha para gravar, na ordem da resposta do Regem. */
export type LinhaDoBairro = {
  posicao: number;
  tipo: 'bairro' | 'outros' | 'sem_bairro' | 'retirada';
  bairro: string | null;
  cidade: string | null;
  uf: string | null;
  bairros: number | null;
  pedidos: number;
  receita: string | null;
};

const limpo = (s: string | null, max: number): string | null => {
  const t = s?.trim() ?? '';
  return t ? t.slice(0, max) : null;
};

/** A resposta do Regem em linhas: os bairros, depois "outros", "sem bairro" e "retirada e balcão". */
export function linhasDosBairros(r: BairrosRegem): LinhaDoBairro[] {
  const linhas: LinhaDoBairro[] = [];
  for (const b of r.bairros) {
    const bairro = limpo(b.bairro, 120);
    if (!bairro) continue;
    linhas.push({ posicao: linhas.length, tipo: 'bairro', bairro, cidade: limpo(b.cidade, 120), uf: limpo(b.uf, 2)?.toUpperCase() ?? null, bairros: null, pedidos: b.pedidos, receita: b.receita_micros.toString() });
  }
  const resto = (tipo: LinhaDoBairro['tipo'], pedidos: number, receita: bigint | null, bairros: number | null) =>
    linhas.push({ posicao: linhas.length, tipo, bairro: null, cidade: null, uf: null, bairros, pedidos, receita: receita === null ? null : receita.toString() });
  resto('outros', r.outros.pedidos, r.outros.receita_micros, r.outros.bairros);
  resto('sem_bairro', r.sem_bairro.pedidos, r.sem_bairro.receita_micros, null);
  resto('retirada', r.retirada_e_balcao.pedidos, null, null);
  return linhas;
}

/** Um bairro na comparação: os pedidos (nulo: abaixo do mínimo do Regem) e a gente do Censo (nula: não casou). */
export type BairroParaComparar = { nome: string; pedidos: number | null; populacao: number | null; naEntrega: boolean };
export type PapelDoBairro = 'atacar' | 'defender' | 'manter';
export type BairroComparado = BairroParaComparar & { porMil: number | null; papel: PapelDoBairro | null };

const mediana = (v: number[]): number | null => {
  if (!v.length) return null;
  const o = [...v].sort((a, b) => a - b);
  const m = Math.floor(o.length / 2);
  return o.length % 2 ? o[m]! : (o[m - 1]! + o[m]!) / 2;
};

/**
 * A conta de atacar e defender (D-RG-37): os pedidos por mil moradores de cada bairro com gente conhecida, comparados
 * com a mediana deles. Defender: 1,5 vez a mediana ou mais. Atacar: gente acima da mediana e pedidos na metade da
 * mediana ou menos (o bairro da área de entrega sem o mínimo de pedidos conta como pouco). O resto: manter. Com menos
 * de 3 bairros com gente conhecida, nenhum papel (não há com o que comparar). Ordem: defender, atacar, manter.
 */
export function compararBairros(lista: readonly BairroParaComparar[]): BairroComparado[] {
  const porMil = (b: BairroParaComparar) => (b.populacao && b.populacao > 0 ? ((b.pedidos ?? 0) * 1000) / b.populacao : null);
  const comGente = lista.filter((b) => b.populacao !== null && b.populacao > 0);
  const comparaveis = comGente.length >= BAIRROS_PARA_COMPARAR;
  const m = mediana(comGente.filter((b) => b.pedidos !== null).map((b) => porMil(b)!));
  const p = mediana(comGente.map((b) => b.populacao!));
  const papel = (b: BairroParaComparar): PapelDoBairro | null => {
    const v = porMil(b);
    if (!comparaveis || v === null || m === null || p === null) return null;
    if (b.pedidos !== null && v >= m * ACIMA_PARA_DEFENDER) return 'defender';
    if (b.populacao! >= p && (b.pedidos === null || v <= m * ABAIXO_PARA_ATACAR)) return 'atacar';
    return 'manter';
  };
  const ordem: Record<PapelDoBairro, number> = { defender: 0, atacar: 1, manter: 2 };
  return lista
    .map((b) => ({ ...b, porMil: porMil(b), papel: papel(b) }))
    .sort(
      (a, b) =>
        (a.papel ? ordem[a.papel] : 3) - (b.papel ? ordem[b.papel] : 3) ||
        (a.papel === 'atacar' ? (b.populacao ?? 0) - (a.populacao ?? 0) : (b.porMil ?? -1) - (a.porMil ?? -1)) ||
        (b.pedidos ?? 0) - (a.pedidos ?? 0) ||
        a.nome.localeCompare(b.nome, 'pt-BR'),
    );
}
