import type { BudgetMonthRhythmCheck } from '@liame/contracts';
import type { Tx } from '@liame/database';
import { sql } from 'drizzle-orm';
import { type AvisoDoRitmo, type AvisoDoRitmoDaMarca, TIPO_DO_AVISO_DO_RITMO } from './ritmo-avisos.js';
import { DIAS_DA_VOLTA } from './ritmo-passos.js';

// A conferência do ritmo gravada (plano da região, R7; D-RG-75, "antes de ligar além do piloto"): a rotina do worker
// (`worker/conferencia-do-ritmo.ts`) calcula os avisos de cada ritmo depois da leitura da manhã da conta e grava a linha
// do dia em `budget_rhythm_check`; a Atenção lê a gravada, a de hoje ou a de ontem. Aqui, a forma guardada (o dinheiro em
// bigint vira texto no jsonb) e a leitura.
//
// Cada aviso guarda o dia da conferência que o achou (`conferido_em`): quando a conta falha, a linha do dia fica com os
// avisos da conferência de antes, copiados como estão, e o dia deles vai junto. É ele que o aviso mostra ("Conferido em
// 13/11"), e não o dia da linha. Os avisos gravados antes deste campo ficam com o dia da linha.

const FUSO_PADRAO = 'America/Sao_Paulo';
const DIA = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Os avisos como ficam guardados no jsonb: os valores em dinheiro (bigint) como texto e o dia da conferência que os achou.
 * A marca é a da linha.
 */
export function avisosParaGuardar(avisos: readonly AvisoDoRitmoDaMarca[], conferidoEm: string): unknown[] {
  return avisos.map(({ conta, campanha, aviso }) => ({
    conta,
    campanha,
    aviso: aviso.tipo === 'gasto_acima' ? { ...aviso, gasto: aviso.gasto.toString(), permitido: aviso.permitido.toString() } : aviso,
    conferido_em: conferidoEm,
  }));
}

/**
 * Os avisos guardados de volta, com o dinheiro em bigint e o dia da conferência (o do aviso ou, no gravado antes dele, o
 * da linha); o que não tem a forma esperada fica de fora.
 */
export function avisosDoGuardado(marca: string, guardado: unknown, diaDaLinha: string | null = null): AvisoDoRitmoDaMarca[] {
  if (!Array.isArray(guardado)) return [];
  return guardado.flatMap((g): AvisoDoRitmoDaMarca[] => {
    if (!g || typeof g !== 'object') return [];
    const { conta, campanha, aviso, conferido_em } = g as { conta?: unknown; campanha?: unknown; aviso?: Record<string, unknown>; conferido_em?: unknown };
    if (typeof conta !== 'string' || !aviso || typeof aviso.tipo !== 'string' || typeof aviso.ritmo !== 'string') return [];
    let volta: Record<string, unknown> = aviso;
    if (aviso.tipo === 'gasto_acima') {
      if (!/^[0-9]+$/.test(String(aviso.gasto)) || !/^[0-9]+$/.test(String(aviso.permitido))) return [];
      volta = { ...aviso, gasto: BigInt(String(aviso.gasto)), permitido: BigInt(String(aviso.permitido)) };
    }
    const conferidoEm = typeof conferido_em === 'string' && DIA.test(conferido_em) ? conferido_em : diaDaLinha;
    return [{ marca, conta, campanha: typeof campanha === 'string' ? campanha : null, aviso: volta as unknown as AvisoDoRitmo, conferidoEm }];
  });
}

/**
 * Os avisos gravados dos ritmos das marcas: a conferência mais nova de cada ritmo que ainda pode avisar (aprovado, parado
 * ou encerrado, na semana corrente ou nos 35 dias da volta, no fuso da loja). Vale a mais nova de qualquer dia da janela:
 * a conta que não foi lida não cala o aviso de dinheiro (D-RG-94); ele fica até a próxima conferência dizer outra coisa.
 * Na ordem dos ritmos (a semana, quando nasceu), como o cálculo de antes. Sem conferência nenhuma, é uma consulta só.
 */
export async function avisosGravadosDoRitmo(tx: Tx, marcas: readonly string[], instante: string): Promise<AvisoDoRitmoDaMarca[]> {
  if (!marcas.length) return [];
  const r = await tx.execute<{ brand_id: string; warnings: unknown; checked_on: string }>(sql`
    select v.brand_id, v.warnings, v.checked_on::text as checked_on
      from (
        select distinct on (k.rhythm_id) k.brand_id, k.warnings, k.checked_on, b.week_start, b.created_at, b.id
          from liame.budget_rhythm_check k
          join liame.budget_rhythm b on b.id = k.rhythm_id
          join liame.unit u on u.id = b.unit_id and u.tenant_id = b.tenant_id
          cross join lateral (select (${instante}::timestamptz at time zone coalesce(u.timezone, ${FUSO_PADRAO}))::date as hoje) x
         where k.brand_id in ${marcas} and b.status in ('aprovado', 'parado', 'encerrado')
           and b.week_start <= x.hoje and b.week_end >= x.hoje - ${DIAS_DA_VOLTA}::int
         order by k.rhythm_id, k.checked_on desc
      ) v
     order by v.week_start, v.created_at, v.id`);
  return r.rows.flatMap((l) => avisosDoGuardado(l.brand_id, l.warnings, l.checked_on));
}

/**
 * A conferência mais nova de cada ritmo dado, para a Verba do mês (D-RG-75): o dia, se a conta terminou (com a falha, os
 * avisos são os da conferência de antes) e os avisos pelo tipo da Atenção. O ritmo sem conferência fica fora do mapa.
 * Uma consulta só, pelo índice único `(rhythm_id, checked_on)`.
 */
export async function conferenciasDosRitmos(tx: Tx, tenantId: string, ritmos: readonly string[]): Promise<Map<string, BudgetMonthRhythmCheck>> {
  const saida = new Map<string, BudgetMonthRhythmCheck>();
  if (!ritmos.length) return saida;
  const r = await tx.execute<{ rhythm_id: string; brand_id: string; checked_on: string; completa: boolean; warnings: unknown }>(sql`
    select distinct on (k.rhythm_id) k.rhythm_id, k.brand_id, k.checked_on::text as checked_on, k.error is null as completa, k.warnings
      from liame.budget_rhythm_check k
     where k.tenant_id = ${tenantId} and k.rhythm_id in ${ritmos}
     order by k.rhythm_id, k.checked_on desc`);
  for (const l of r.rows) {
    saida.set(l.rhythm_id, {
      on: l.checked_on,
      complete: l.completa,
      warnings: avisosDoGuardado(l.brand_id, l.warnings).flatMap((a) => {
        const kind = TIPO_DO_AVISO_DO_RITMO[a.aviso.tipo];
        return kind ? [kind] : [];
      }),
    });
  }
  return saida;
}
