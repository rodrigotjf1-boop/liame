import type { Tx } from '@liame/database';
import { sql } from 'drizzle-orm';
import { type Gasto, type SituacaoDoTeto, situacaoDoTeto } from './teto.js';

// O uso de IA da empresa para quem precisa saber, ANTES de pedir, se um pedido cabe no limite (A4, X6; D-A4-32). São
// os mesmos números que o AI Gateway confere em toda chamada (`gateway.ts`, `preparar`): o gasto do dia e do mês, no
// fuso da empresa, e o teto dela (`ai_budget`) ou, sem linha, o padrão do servidor. Aqui o relógio é o de quem chama
// (V34): no gateway é o do banco, e os dois andam juntos fora do teste.

/** O teto que vale para a empresa que não tem linha em `ai_budget`. */
export interface LimitesPadraoDeIa {
  dailyLimitUsdMicros: number;
  monthlyLimitUsdMicros: number;
}

export interface UsoDeIa extends Gasto {
  /** `livre`, `alerta`, `economico` ou `bloqueado`: o pior entre o dia e o mês. */
  situacao: SituacaoDoTeto;
  /** Quanto ainda cabe agora: o menor entre o que resta do dia e o que resta do mês; nunca negativo. */
  resta: bigint;
  /** Qual limite está mais perto de acabar. */
  aperta: 'dia' | 'mes';
  /** O começo do dia da empresa (no fuso dela), para somar o que é de hoje. */
  inicioDoDia: string;
}

const positivo = (n: bigint): bigint => (n > 0n ? n : 0n);

/** O quanto resta e qual limite aperta: função pura, para o teste e para quem já tem o gasto na mão. */
export function restoDoTeto(g: Gasto): { resta: bigint; aperta: 'dia' | 'mes' } {
  const doDia = positivo(g.tetoDia - g.gastoDia);
  const doMes = positivo(g.tetoMes - g.gastoMes);
  return doMes < doDia ? { resta: doMes, aperta: 'mes' } : { resta: doDia, aperta: 'dia' };
}

/** O gasto e o teto de IA da empresa agora (todas as marcas e todos os funcionários), na transação de quem chama. */
export async function usoDeIaDaEmpresa(tx: Tx, tenantId: string, padrao: LimitesPadraoDeIa, agora: Date): Promise<UsoDeIa> {
  const instante = agora.toISOString();
  const l = (
    await tx.execute<{ teto_dia: string; teto_mes: string; gasto_dia: string; gasto_mes: string; inicio_do_dia: Date | string }>(sql`
      select coalesce(b.daily_usd_micros, ${padrao.dailyLimitUsdMicros})::text as teto_dia,
             coalesce(b.monthly_usd_micros, ${padrao.monthlyLimitUsdMicros})::text as teto_mes,
             (select coalesce(sum(u.cost_usd_micros), 0)::text from liame.ai_usage u
               where u.tenant_id = o.id and u.occurred_at >= date_trunc('day', ${instante}::timestamptz at time zone o.timezone) at time zone o.timezone) as gasto_dia,
             (select coalesce(sum(u.cost_usd_micros), 0)::text from liame.ai_usage u
               where u.tenant_id = o.id and u.occurred_at >= date_trunc('month', ${instante}::timestamptz at time zone o.timezone) at time zone o.timezone) as gasto_mes,
             (date_trunc('day', ${instante}::timestamptz at time zone o.timezone) at time zone o.timezone) as inicio_do_dia
        from liame.organization o left join liame.ai_budget b on b.tenant_id = o.id
       where o.id = ${tenantId}`)
  ).rows[0];
  if (!l) throw new Error('uso de IA: empresa não encontrada no contexto');
  const gasto: Gasto = { gastoDia: BigInt(l.gasto_dia), gastoMes: BigInt(l.gasto_mes), tetoDia: BigInt(l.teto_dia), tetoMes: BigInt(l.teto_mes) };
  return { ...gasto, situacao: situacaoDoTeto(gasto), ...restoDoTeto(gasto), inicioDoDia: new Date(l.inicio_do_dia).toISOString() };
}
