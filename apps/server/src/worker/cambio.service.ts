import { type Database, withSystem } from '@liame/database';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { buscarPtax, type Cotacao, FONTE_PTAX } from '../cambio/ptax.js';
import { DATABASE } from '../database/database.module.js';
import { diaNoFuso, menosDias } from '../results/fora-do-normal.js';

// Câmbio de referência (A3, D-A3-14): rotina da distribuição que lê a PTAX de venda do Banco Central e guarda uma
// cotação por dia útil (`exchange_rate`, migration 0041). Pede os últimos dias de uma vez: fim de semana e feriado não
// têm boletim, e um dia perdido entra na leitura seguinte. A cotação de um dia não muda depois de publicada, então a
// que já está guardada fica como está. Grava em escopo de sistema: o dado é do produto, sem empresa.

/** Quantos dias para trás a rotina pede (cobre feriado prolongado e alguns dias de falha). */
const DIAS_PEDIDOS = 10;
const BRASILIA = 'America/Sao_Paulo';

export interface ResultadoDoCambio {
  /** Cotações que o Banco Central devolveu no período. */
  lidas: number;
  /** As que ainda não estavam guardadas. */
  novas: number;
  /** O dia da cotação mais recente guardada depois da rotina. */
  ultima: string | null;
}

@Injectable()
export class CambioService {
  private readonly logger = new Logger('cambio');

  constructor(@Inject(DATABASE) private readonly database: Database | null) {}

  /** A rotina. `buscar` troca a leitura do Banco Central nos testes; o relógio injetado vale para a operação inteira (V34). */
  async atualizar(agora: Date = new Date(), buscar: (de: string, ate: string) => Promise<Cotacao[]> = buscarPtax): Promise<ResultadoDoCambio> {
    if (!this.database) return { lidas: 0, novas: 0, ultima: null };
    const hoje = diaNoFuso(agora, BRASILIA);
    const cotacoes = await buscar(menosDias(hoje, DIAS_PEDIDOS), hoje);
    return withSystem(this.database.db, async (tx) => {
      let novas = 0;
      for (const c of cotacoes) {
        const r = await tx.execute(sql`
          insert into liame.exchange_rate (base, quote, rate_date, rate, source, published_at, fetched_at)
          values ('USD', 'BRL', ${c.dia}::date, ${c.taxa}::numeric, ${FONTE_PTAX}, ${c.publicadaEm}::timestamptz, ${agora.toISOString()}::timestamptz)
          on conflict (base, quote, rate_date) do nothing`);
        novas += r.rowCount ?? 0;
      }
      const ultima = (await tx.execute<{ dia: string | null }>(sql`select max(rate_date)::text as dia from liame.exchange_rate where base = 'USD' and quote = 'BRL'`)).rows[0]?.dia ?? null;
      if (novas) this.logger.log(`PTAX: ${novas} cotação(ões) nova(s); a mais recente é de ${ultima}`);
      return { lidas: cotacoes.length, novas, ultima };
    });
  }
}
