import type { ClosedLoopResponse } from '@liame/contracts';
import { dia, dinheiro, inteiro, razao } from '../registro/formatos.js';
import { visaoDoCicloFechado } from '../registro/visoes/ciclo-fechado.js';

// O contexto da explicação dos resultados (A3, I4): tudo o que a IA pode citar, calculado e formatado
// pelo código. A comparação com o período anterior também sai daqui: a IA não faz conta (A3-5).

/** O período de mesmo tamanho imediatamente antes: de 18/09 a 01/10 (14 dias) → de 04/09 a 17/09. */
export function periodoAnterior(from: string, to: string): { from: string; to: string } {
  const DIA = 86_400_000;
  const inicio = Date.parse(`${from}T00:00:00Z`);
  const dias = (Date.parse(`${to}T00:00:00Z`) - inicio) / DIA + 1;
  const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  return { from: iso(inicio - dias * DIA), to: iso(inicio - DIA) };
}

/**
 * Variação em porcentagem, com uma casa e sinal: 960 sobre 784 → "+22,4%". Em inteiros (micros,
 * contagens ou centésimos), sem ponto flutuante. Nula quando não havia nada antes: de zero para
 * qualquer valor não é porcentagem.
 */
export function variacao(atual: bigint, anterior: bigint): string | null {
  if (anterior <= 0n) return null;
  const milesimos = (atual - anterior) * 1000n;
  const negativo = milesimos < 0n;
  const absoluto = negativo ? -milesimos : milesimos;
  const decimos = (absoluto + anterior / 2n) / anterior;
  const texto = `${decimos / 10n},${decimos % 10n}%`;
  return decimos === 0n ? texto : `${negativo ? '-' : '+'}${texto}`;
}

/** "3.80" → 380n (centésimos); nulo fica nulo. */
const centesimos = (r: string | null): bigint | null => (r === null ? null : BigInt(r.replace('.', '')));

export interface ContextoDaExplicacao {
  /** Os números do período, como a ferramenta `resultados_ciclo_fechado` os entrega. */
  resultado: ReturnType<typeof visaoDoCicloFechado>;
  /** O período de mesmo tamanho logo antes e a variação de cada número, calculada pelo código; nulo sem dado para comparar. */
  comparacao: {
    periodo_anterior: { de: string | null; ate: string | null };
    investimento: Comparado;
    pedidos_confirmados: Comparado;
    receita_confirmada: Comparado;
    pedidos_com_origem: Comparado;
    receita_com_origem: Comparado;
    roas_confirmado: Comparado;
  } | null;
  /** Fontes que não estão em dia: com alguma aqui, a explicação é a do código, não a da IA. */
  fontes_fora_do_dia: Array<{ plataforma: string | null; conta: string; frescor: string }>;
}

/** Os nomes que vieram dos dados da empresa (campanhas e contas): a IA pode citá-los, e são eles que dizem se o assunto é político. */
export function nomesDoContexto(c: ContextoDaExplicacao): string[] {
  return [...c.resultado.campanhas.map((x) => x.campanha), ...c.resultado.fontes.map((f) => f.conta)].filter((n): n is string => typeof n === 'string' && n.length > 0);
}

export interface Comparado {
  antes: string | null;
  agora: string | null;
  /** "+22,4%", "-34,2%", "0,0%"; nula quando não havia valor antes. */
  variacao: string | null;
}

export function contextoDosResultados(atual: ClosedLoopResponse, anterior: ClosedLoopResponse | null): ContextoDaExplicacao {
  const resultado = visaoDoCicloFechado(atual);
  const moeda = atual.currency;
  const emDinheiro = (agora: string, antes: string): Comparado => ({ antes: dinheiro(antes, moeda), agora: dinheiro(agora, moeda), variacao: variacao(BigInt(agora), BigInt(antes)) });
  const emContagem = (agora: number, antes: number): Comparado => ({ antes: inteiro(antes), agora: inteiro(agora), variacao: variacao(BigInt(agora), BigInt(antes)) });
  const [roasAgora, roasAntes] = [centesimos(atual.totals.confirmed.roas), centesimos(anterior?.totals.confirmed.roas ?? null)];
  // Sem pedido nem investimento no período anterior não há o que comparar.
  const temAnterior = anterior !== null && (BigInt(anterior.totals.spend_micros) > 0n || anterior.totals.orders_confirmed > 0);
  return {
    resultado,
    comparacao:
      temAnterior && anterior
        ? {
            periodo_anterior: { de: dia(anterior.period.from), ate: dia(anterior.period.to) },
            investimento: emDinheiro(atual.totals.spend_micros, anterior.totals.spend_micros),
            pedidos_confirmados: emContagem(atual.totals.orders_confirmed, anterior.totals.orders_confirmed),
            receita_confirmada: emDinheiro(atual.totals.revenue_micros, anterior.totals.revenue_micros),
            pedidos_com_origem: emContagem(atual.totals.confirmed.orders, anterior.totals.confirmed.orders),
            receita_com_origem: emDinheiro(atual.totals.confirmed.revenue_micros, anterior.totals.confirmed.revenue_micros),
            roas_confirmado: {
              antes: razao(anterior.totals.confirmed.roas),
              agora: razao(atual.totals.confirmed.roas),
              variacao: roasAgora !== null && roasAntes !== null ? variacao(roasAgora, roasAntes) : null,
            },
          }
        : null,
    fontes_fora_do_dia: resultado.fontes.filter((f) => f.frescor !== 'em dia').map((f) => ({ plataforma: f.plataforma ?? null, conta: f.conta ?? '', frescor: f.frescor ?? '' })),
  };
}
