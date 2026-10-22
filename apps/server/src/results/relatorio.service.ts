import type { MonthlyReportQuery, MonthlyReportResponse } from '@liame/contracts';
import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { currentTx } from '../context/request-context.js';
import { diaNoFuso } from './fora-do-normal.js';
import { type ConteudoDoRelatorio, mesPedido, proximoRelatorio, RELATORIO_VERSAO } from './relatorio-mensal.js';
import { ResultsService } from './results.service.js';

type Linha = {
  id: string;
  content: ConteudoDoRelatorio;
  content_version: number;
  email_status: string;
  email_sent_at: Date | string | null;
  email_recipients: number;
};

/**
 * O relatório do mês na tela (A3, I7; protótipo P24): lê o que o worker guardou no dia 1º. O relatório não é
 * recalculado aqui: a tela e o e-mail mostram os mesmos números, os de quando ele foi gerado. Roda na transação da
 * rota, com a empresa na RLS. Como a revisão da semana (`revisao.service.ts`).
 */
@Injectable()
export class RelatorioService {
  constructor(private readonly results: ResultsService) {}

  /** O relatório de um mês da marca (`2026-09`) ou, sem o mês, o mais recente. */
  async daMarca(q: MonthlyReportQuery, agora = new Date()): Promise<MonthlyReportResponse> {
    // 404 se a marca não é desta empresa.
    const fuso = await this.results.fusoDaMarca(q.brand_id);
    const tx = currentTx();
    const mes = q.month ? mesPedido(q.month) : null;
    const r = await tx.execute<Linha>(sql`
      select id, content, content_version, email_status, email_sent_at, email_recipients
        from liame.monthly_report
       where brand_id = ${q.brand_id} ${mes ? sql`and month_from = ${mes.from}::date` : sql``}
       order by month_from desc
       limit 1`);
    const ultimo = await tx.execute<{ month_from: string | null }>(sql`select max(month_from)::text as month_from from liame.monthly_report where brand_id = ${q.brand_id}`);
    const linha = r.rows[0];
    // Conteúdo de versão que este código não conhece não vai para a tela como se fosse o de agora.
    if (linha && linha.content_version !== RELATORIO_VERSAO) throw new Error(`relatório do mês ${linha.id}: conteúdo na versão ${linha.content_version}, o código lê a ${RELATORIO_VERSAO}`);
    return {
      report: linha
        ? {
            ...linha.content,
            id: linha.id,
            email: { status: linha.email_status, sent_at: linha.email_sent_at ? new Date(linha.email_sent_at).toISOString() : null, recipients: linha.email_recipients },
          }
        : null,
      next_report_on: proximoRelatorio(diaNoFuso(agora, fuso), ultimo.rows[0]?.month_from ?? null),
      timezone: fuso,
    };
  }
}
