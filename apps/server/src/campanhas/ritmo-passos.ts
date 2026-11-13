import type { Tx } from '@liame/database';
import { sql } from 'drizzle-orm';
import { passoDoDia } from '../regiao/ritmo-da-semana.js';
import { diasDepois } from '../regiao/semana.js';
import { EstadoDoRitmo } from './ritmo-plano.js';

// Os passos do ritmo da semana (plano da região, R7, parte 1b-2; D-RG-62 e D-RG-63): o que o Liame deixou em cada
// campanha e o que o passo de hoje faz. Duas partes:
//   - `decidirPasso` (pura): com o ritmo, o dia e a verba que o Liame deixou, qual é o passo de hoje. Dentro da semana
//     do ritmo aprovado, a verba do dia; com o ritmo parado ou depois do fim da semana, a volta à verba de antes. Sempre
//     em direção ao alvo, no máximo 10% por mudança (subindo, nunca acima do alvo nem do teto por campanha);
//   - `controleDoRitmo` (banco): por objeto da Meta de uma marca, a verba de antes do ritmo e a que o Liame deixou no
//     último passo feito. É o que a montagem da semana seguinte usa como verba de hoje (a verba lida da campanha no
//     domingo já é a do ritmo em curso) e o que cada passo espera encontrar.

export interface PassoDecidido {
  tipo: 'ritmo' | 'volta';
  /** A verba do dia (ou a de antes, na volta). */
  alvoMicros: number;
  /** A verba que o passo deixa; igual à que o Liame deixou quando não há o que mudar. */
  valorMicros: number;
}

/**
 * O passo de hoje de uma campanha num ritmo; nulo quando ainda não é a semana dele. `tetoMicros`: o teto por campanha
 * de agora (pode ter mudado depois da aprovação: o passo que sobe para nele).
 */
export function decidirPasso(e: {
  situacao: 'aprovado' | 'parado';
  hoje: string;
  dias: readonly string[];
  campanha: { base_micros: number; dias_micros: readonly number[] };
  deixadaMicros: number;
  tetoMicros: number | null;
}): PassoDecidido | null {
  const [de, ate] = [e.dias[0]!, e.dias[e.dias.length - 1]!];
  if (e.situacao === 'aprovado' && e.hoje < de) return null;
  if (e.situacao === 'aprovado' && e.hoje <= ate) {
    const alvoMicros = e.campanha.dias_micros[e.dias.indexOf(e.hoje)];
    if (alvoMicros === undefined) return null;
    return { tipo: 'ritmo', alvoMicros, valorMicros: passoDoDia(e.deixadaMicros, alvoMicros, e.tetoMicros) };
  }
  // O ritmo parado, ou a semana que acabou: a verba volta à de antes, 10% por dia.
  if (e.situacao === 'parado' && e.hoje < de) return null;
  return { tipo: 'volta', alvoMicros: e.campanha.base_micros, valorMicros: passoDoDia(e.deixadaMicros, e.campanha.base_micros, e.tetoMicros) };
}

export interface ControleDoObjeto {
  /** O ritmo mais novo que tem o objeto. */
  ritmo: string;
  /** A verba de antes do ritmo (a que a pessoa deixou). */
  baseMicros: number;
  /** A verba que o Liame deixou no último passo feito (a de antes, se nenhum passo saiu). */
  deixadaMicros: number;
  /** A verba do último dia do ritmo no plano (o domingo). */
  ultimoDiaMicros: number;
}

export interface ControleDoRitmo {
  /** Os objetos que o Liame está conduzindo agora, pelo recurso (`campanha:<id>` ou `conjunto:<id>`). */
  objetos: Map<string, ControleDoObjeto>;
  /**
   * O ritmo aprovado que termina na véspera de `semanaDe` (a semana seguinte continua dele): o peso do último dia e o
   * dia em que termina. Nulo quando não há.
   */
  anterior: { ritmo: string; peso: number; ate: string } | null;
}

/**
 * Por quantos dias depois do fim da semana o Liame ainda tenta devolver a verba de antes. A volta leva até 3 dias; a que
 * o limite do mês segura (a verba ficou abaixo da de antes e subir não cabe) é tentada todo dia, até o mês virar.
 */
export const DIAS_DA_VOLTA = 35;

/**
 * O que o Liame conduz numa marca em `hoje`: os objetos dos ritmos aprovados ou parados recentes que ainda não saíram do
 * ritmo (nenhum passo "fora") e que estão na semana do ritmo ou ainda não voltaram à verba de antes.
 */
export async function controleDoRitmo(tx: Tx, alvo: { tenantId: string; brandId: string; hoje: string; semanaDe?: string }): Promise<ControleDoRitmo> {
  const ritmos = (
    await tx.execute<{ id: string; status: 'aprovado' | 'parado'; week_start: string; week_end: string; plan: unknown }>(sql`
      select id, status, week_start::text as week_start, week_end::text as week_end, plan
        from liame.budget_rhythm
       where tenant_id = ${alvo.tenantId} and brand_id = ${alvo.brandId} and status in ('aprovado', 'parado')
         and week_end >= ${alvo.hoje}::date - ${DIAS_DA_VOLTA}::int and week_start <= ${alvo.hoje}::date
       order by week_start, created_at`)
  ).rows;
  const controle: ControleDoRitmo = { objetos: new Map(), anterior: null };
  if (!ritmos.length) return controle;
  const ids = sql.join(
    ritmos.map((r) => sql`${r.id}::uuid`),
    sql`, `,
  );
  const passos = (
    await tx.execute<{ rhythm_id: string; resource_id: string; status: string; target_micros: string }>(sql`
      select rhythm_id, resource_id, status, target_micros::text as target_micros
        from liame.budget_rhythm_step
       where tenant_id = ${alvo.tenantId} and rhythm_id in (${ids}) and status in ('feito', 'fora')
       order by day, created_at`)
  ).rows;
  const vespera = alvo.semanaDe ? diasDepois(alvo.semanaDe, -1) : null;
  // Do ritmo mais antigo ao mais novo: o mais novo vale.
  for (const r of ritmos) {
    const plano = EstadoDoRitmo.omit({ situacao: true }).safeParse(r.plan);
    if (!plano.success) continue;
    const doRitmo = passos.filter((p) => p.rhythm_id === r.id);
    for (const c of plano.data.campanhas) {
      const meus = doRitmo.filter((p) => p.resource_id === c.recurso);
      // Mexida por fora, a campanha saiu do ritmo e fica como a pessoa deixou: o Liame não a conduz mais.
      if (meus.some((p) => p.status === 'fora')) {
        controle.objetos.delete(c.recurso);
        continue;
      }
      const feito = meus.filter((p) => p.status === 'feito').at(-1);
      // Sem passo feito neste ritmo, vale o que o ritmo anterior deixou (a semana que continua de outra), ou a verba de antes.
      const deixadaMicros = feito ? Number(feito.target_micros) : (controle.objetos.get(c.recurso)?.deixadaMicros ?? c.base_micros);
      const naSemana = r.status === 'aprovado' && alvo.hoje <= r.week_end;
      if (!naSemana && deixadaMicros === c.base_micros) {
        // Já voltou à verba de antes: o que a pessoa fizer daqui em diante é dela.
        controle.objetos.delete(c.recurso);
        continue;
      }
      controle.objetos.set(c.recurso, { ritmo: r.id, baseMicros: c.base_micros, deixadaMicros, ultimoDiaMicros: c.dias_micros[6]! });
    }
    if (r.status === 'aprovado' && vespera !== null && r.week_end === vespera) {
      controle.anterior = { ritmo: r.id, peso: plano.data.dias[6]!.peso, ate: r.week_end };
    }
  }
  return controle;
}
