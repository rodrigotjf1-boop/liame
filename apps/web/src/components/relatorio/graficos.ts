import type { MonthlyReport } from '@liame/contracts';
import type { SeloDoPeriodo } from '@/components/resultados/graficos';
import { diaMes } from '@/components/resultados/textos';
import { dica, largura, pedidosEscritos, seloDaCampanha } from '@/components/revisao/graficos';
import { razao } from '@/components/revisao/textos';
import { inteiro, reaisDeMicros } from '@/lib/formato';

// Os desenhos que só o "Relatório do mês" tem (mockups/prototipo-relatorio-mes.html, P24 aprovado em 21/10/2026). Os
// números do topo, as campanhas e o que mudou são os da revisão da semana (`revisao/graficos.ts`), com o período do mês
// (`periodoDoMes`). Aqui, "Semana a semana": a mesma lista das campanhas, com a semana no lugar do nome. Funções puras.

export type SemanaDoMes = {
  /** A segunda-feira da semana inteira (a chave da revisão). */
  id: string;
  /** "01/09 a 06/09": os dias da semana que estão dentro do mês. */
  nome: string;
  /** "6 dias · 12 pedidos" / "7 dias · sem pedido". */
  sub: string;
  /** A revisão da semana inteira, quando ela existe. */
  revisao: { href: string; rotulo: string } | null;
  investido: { valor: string; largura: number; dica: string };
  /** O que o caixa confirmou; largura zero quando não houve pedido (a barra não aparece). */
  caixa: { valor: string; largura: number; dica: string };
  selo: SeloDoPeriodo | null;
  rotulo: string;
};

const diasEscritos = (n: number) => `${inteiro(n)} ${n === 1 ? 'dia' : 'dias'}`;

/**
 * Cada semana do mês com o que foi investido e o que voltou no caixa, na mesma régua para todas as semanas (uma régua
 * só desta lista: a das campanhas é outra). O link leva à revisão da semana inteira da mesma marca.
 */
export function semanasDoMes(r: Pick<MonthlyReport, 'weeks' | 'brand_id'>): SemanaDoMes[] {
  const maior = r.weeks.reduce((m, w) => [BigInt(w.spend_micros), BigInt(w.revenue_micros)].reduce((a, v) => (v > a ? v : a), m), 0n);
  return r.weeks.map((w): SemanaDoMes => {
    const [gasto, receita] = [BigInt(w.spend_micros), BigInt(w.revenue_micros)];
    const [investido, noCaixa] = [reaisDeMicros(gasto), reaisDeMicros(receita)];
    const nome = `${diaMes(w.from)} a ${diaMes(w.to)}`;
    const inteira = `${diaMes(w.week.from)} a ${diaMes(w.week.to)}`;
    return {
      id: w.week.from,
      nome,
      sub: `${diasEscritos(w.days)} · ${w.orders === 0 ? 'sem pedido' : pedidosEscritos(w.orders)}`,
      revisao: w.has_review ? { href: `/resultados/revisao?marca=${r.brand_id}&semana=${w.week.from}`, rotulo: `Ver a revisão de ${inteira}` } : null,
      investido: { valor: investido, largura: largura(gasto, maior), dica: dica(investido, `investido de ${nome}`) },
      caixa: { valor: noCaixa, largura: largura(receita, maior), dica: dica(noCaixa, w.roas === null ? 'confirmado no caixa' : `confirmado no caixa · ROAS ${razao(w.roas)}`) },
      selo: seloDaCampanha(w),
      rotulo: w.orders === 0 ? `De ${nome}: ${investido} investidos e nenhum pedido confirmado no caixa.` : `De ${nome}: ${investido} investidos e ${noCaixa} no caixa, em ${pedidosEscritos(w.orders)}.`,
    };
  });
}
