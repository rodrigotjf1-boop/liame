import type { Tx } from '@liame/database';
import { sql } from 'drizzle-orm';
import { FONTE_PTAX } from './ptax.js';

/** A cotação de referência que as telas usam para mostrar dólar em reais: a do dia útil mais recente que o worker leu. */
export interface CotacaoDeReferencia {
  /** Reais por dólar, em texto. */
  rate: string;
  /** O dia do boletim (`AAAA-MM-DD`). */
  date: string;
  source: string;
}

/** A PTAX de venda mais recente guardada, ou nula antes da primeira leitura (a tela mostra só o dólar). */
export async function ultimaCotacao(tx: Tx): Promise<CotacaoDeReferencia | null> {
  const r = await tx.execute<{ rate: string; date: string; source: string }>(sql`
    select trim(trailing '0' from rate::text) as rate, rate_date::text as date, source
      from liame.exchange_rate
     where base = 'USD' and quote = 'BRL' and source = ${FONTE_PTAX}
     order by rate_date desc
     limit 1`);
  const c = r.rows[0];
  if (!c) return null;
  // "5.2238" (sem os zeros do fim); "5." vira "5.0" para manter a forma de número com casa.
  return { rate: c.rate.endsWith('.') ? `${c.rate}0` : c.rate, date: c.date, source: c.source };
}
