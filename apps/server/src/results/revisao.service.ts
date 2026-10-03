import type { WeeklyReviewQuery, WeeklyReviewResponse } from '@liame/contracts';
import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { currentTx } from '../context/request-context.js';
import { AppProblem } from '../errors/problems.js';
import { diaNoFuso } from './fora-do-normal.js';
import type { ConteudoDaRevisao } from './revisao-email.js';
import { diaIso, proximaRevisao, REVISAO_VERSAO } from './revisao-semanal.js';
import { ResultsService } from './results.service.js';

type Linha = {
  id: string;
  content: ConteudoDaRevisao;
  content_version: number;
  email_status: string;
  email_sent_at: Date | string | null;
  email_recipients: number;
};

/**
 * A revisão da semana na tela (A3, I7; protótipo P4): lê o que o worker guardou na segunda-feira. A revisão
 * não é recalculada aqui: a tela e o e-mail mostram os mesmos números, os de quando ela foi gerada. Roda na
 * transação da rota, com a empresa na RLS.
 */
@Injectable()
export class RevisaoService {
  constructor(private readonly results: ResultsService) {}

  /** A revisão de uma semana da marca (pela segunda-feira dela) ou, sem a semana, a mais recente. */
  async daMarca(q: WeeklyReviewQuery, agora = new Date()): Promise<WeeklyReviewResponse> {
    if (q.week && diaIso(q.week) !== 1) {
      throw new AppProblem(422, 'semana-invalida', 'Semana inválida', 'A semana é pedida pela segunda-feira em que ela começa.');
    }
    // 404 se a marca não é desta empresa.
    const fuso = await this.results.fusoDaMarca(q.brand_id);
    const tx = currentTx();
    const r = await tx.execute<Linha>(sql`
      select id, content, content_version, email_status, email_sent_at, email_recipients
        from liame.weekly_review
       where brand_id = ${q.brand_id} ${q.week ? sql`and week_from = ${q.week}::date` : sql``}
       order by week_from desc
       limit 1`);
    const ultima = await tx.execute<{ week_from: string | null }>(sql`select max(week_from)::text as week_from from liame.weekly_review where brand_id = ${q.brand_id}`);
    const linha = r.rows[0];
    // Conteúdo de versão que este código não conhece não vai para a tela como se fosse o de agora.
    if (linha && linha.content_version !== REVISAO_VERSAO) throw new Error(`revisão da semana ${linha.id}: conteúdo na versão ${linha.content_version}, o código lê a ${REVISAO_VERSAO}`);
    return {
      review: linha
        ? {
            ...linha.content,
            id: linha.id,
            email: { status: linha.email_status, sent_at: linha.email_sent_at ? new Date(linha.email_sent_at).toISOString() : null, recipients: linha.email_recipients },
          }
        : null,
      next_review_on: proximaRevisao(diaNoFuso(agora, fuso), ultima.rows[0]?.week_from ?? null),
      timezone: fuso,
    };
  }
}
