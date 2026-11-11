import type { RegionNumber, RegionOverviewResponse, RegionSourceStatus } from '@liame/contracts';

// Sua região (protótipo P40, aprovado em 11/11/2026; plano da região, R2, parte 2): os textos e as contas da tela, sem
// React. Todo número leva a fonte e o período (base §19.3); a renda do Censo é de 2022, sem correção (D-RG-20).

/** O catálogo das fontes como a tela escreve (o que é, a fonte, a consulta no Pro e de quanto em quanto renova). */
export const FONTES_DA_REGIAO: Record<string, { dado: string; fonte: string; recorte: string; consulta: string; renova: string }> = {
  ibge_censo_bairro: {
    dado: 'Pessoas, área, densidade e renda do bairro',
    fonte: 'IBGE · Censo 2022, agregados por bairro',
    recorte: 'bairro (todos os bairros do município)',
    consulta: 'arquivos do Censo por bairro: básico (v0001, AREA_KM2) e renda do responsável (V06004 média, V06006 mediana)',
    renova: 'fixo até o próximo Censo',
  },
  ibge_4714: { dado: 'População e densidade do município', fonte: 'IBGE · Censo 2022', recorte: 'município', consulta: 'tabela 4714 · variáveis 93 e 614', renova: 'fixo até o próximo Censo' },
  ibge_6579: { dado: 'População estimada', fonte: 'IBGE · Estimativas de População', recorte: 'município', consulta: 'tabela 6579 · variável 9324', renova: 'uma vez por ano' },
  ibge_10295: {
    dado: 'Renda por pessoa no município',
    fonte: 'IBGE · Censo 2022',
    recorte: 'município',
    consulta: 'tabela 10295 · variáveis 13534 (mediana) e 13431 (média)',
    renova: 'fixo até o próximo Censo',
  },
  ibge_9528: {
    dado: 'Restaurantes e similares',
    fonte: 'IBGE · Cadastro Central de Empresas',
    recorte: 'município',
    consulta: 'tabela 9528 · variável 706 · CNAE 56.11-2 (categoria 117551)',
    renova: 'uma vez por ano',
  },
};

const fmt = (v: number, casas = 0) => v.toLocaleString('pt-BR', { minimumFractionDigits: casas, maximumFractionDigits: casas });

/** Inteiro com ponto de milhar: "142.909". */
export function inteiro(v: number): string {
  return fmt(Math.round(v));
}

/** Com uma casa: "5.174,6". */
export function umaCasa(v: number): string {
  return fmt(v, Number.isInteger(v) ? 0 : 1);
}

/** Reais sem centavos quando é redondo: "R$ 5.500", "R$ 8.056,52". */
export function reais(v: number): string {
  return `R$ ${fmt(v, Number.isInteger(v) ? 0 : 2)}`;
}

/** A hora "15:00" de um instante, no fuso de quem vê. */
export function hora(iso: string): string {
  return new Date(iso).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
}

// Os nomes de bairro e de município vêm sem o artigo certo ("na Tijuca", "no Grajaú", "em São Paulo", "no Rio"): as
// frases os escrevem depois de "bairro" e "município", sem preposição colada no nome.

/** A densidade do bairro comparada à do município, em palavras. */
export function comparaDensidade(bairro: number, cidade: number, nomeDaCidade: string): string {
  if (cidade <= 0) return '';
  const r = bairro / cidade;
  const ref = `(${nomeDaCidade}: ${umaCasa(cidade)} por km²)`;
  if (r >= 1.2) return `${umaCasa(Math.round(r * 10) / 10)} vezes a densidade do município ${ref}`;
  if (r <= 0.8) return `menos denso que a média do município ${ref}`;
  return `parecido com a média do município ${ref}`;
}

/** A frase da renda do bairro com a posição dele entre os bairros do município. */
export function fraseDaRenda(r: RegionOverviewResponse): string | null {
  const b = r.district;
  if (!b || b.head_income_median === null) return null;
  const base = `é a renda mediana do responsável pelo domicílio no bairro ${b.name}.`;
  const p = b.income_rank;
  if (!p || !r.city) return base;
  return `${base} O bairro típico do município (${r.city.name}) tem ${reais(p.typical_median)}: este fica acima de ${p.above_pct}% dos ${inteiro(p.districts)} bairros.`;
}

/** A fonte curta de um número: "IBGE · Censo 2022", "IBGE · Cadastro Central de Empresas, 2024". */
export function fonteDoNumero(n: RegionNumber): string {
  const f = FONTES_DA_REGIAO[n.source];
  if (!f) return n.period;
  return f.fonte.includes(n.period) ? f.fonte : `${f.fonte}, ${n.period}`;
}

/** As fontes que falharam (nunca deram certo), com a hora da próxima tentativa. */
export function fontesQueFalharam(r: RegionOverviewResponse): RegionSourceStatus[] {
  return r.sources.filter((s) => s.status === 'falhou');
}

/** A linha do frescor no cabeçalho do cartão. */
export function frescor(r: RegionOverviewResponse): string {
  if (r.status === 'lendo') return 'Lendo agora';
  const lidas = r.sources.map((s) => s.read_at).filter((x): x is string => x !== null);
  const ultima = lidas.sort().at(-1);
  const quando = ultima ? `Lida em ${new Date(ultima).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' })}` : 'Lida';
  return r.status === 'parcial' ? `${quando} · uma fonte falhou` : quando;
}

/** A situação de uma fonte em palavras (a gaveta das fontes). */
export function situacaoEmPalavras(s: RegionSourceStatus): { texto: string; tipo: 'ok' | 'lendo' | 'falhou' } {
  if (s.status === 'em_dia') return { texto: 'Em dia', tipo: 'ok' };
  if (s.status === 'falhou') return { texto: s.next_try_at ? `Não respondeu · de novo às ${hora(s.next_try_at)}` : 'Não respondeu', tipo: 'falhou' };
  return { texto: 'Lendo', tipo: 'lendo' };
}
