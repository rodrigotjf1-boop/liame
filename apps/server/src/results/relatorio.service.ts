import type { MonthlyReportQuery, MonthlyReportResponse } from '@liame/contracts';
import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { enderecoPublicoDoLogo } from '../agencia/logo-publico.controller.js';
import { APP_CONFIG, type AppConfig } from '../config.js';
import { type AuthContext, currentTx } from '../context/request-context.js';
import { diaNoFuso } from './fora-do-normal.js';
import { type ConteudoDoRelatorio, mesPedido, paraQuemVe, pessoasDaVerba, proximoRelatorio, VERSOES_DO_RELATORIO } from './relatorio-mensal.js';
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
  constructor(
    private readonly results: ResultsService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /**
   * O relatório de um mês da marca (`2026-09`) ou, sem o mês, o mais recente. A verba e a equipe só vão para quem vê as
   * telas de onde elas vêm (`paraQuemVe`), e o nome de quem pediu e aprovou cada mudança é lido agora.
   */
  async daMarca(auth: Pick<AuthContext, 'permissions'>, q: MonthlyReportQuery, agora = new Date()): Promise<MonthlyReportResponse> {
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
    if (linha && !VERSOES_DO_RELATORIO.has(linha.content_version)) throw new Error(`relatório do mês ${linha.id}: conteúdo na versão ${linha.content_version}, que o código não lê`);
    const ids = linha ? pessoasDaVerba(linha.content) : [];
    const nomes = ids.length
      ? new Map((await tx.execute<{ id: string; name: string }>(sql`select id, name from liame.app_user where id in ${ids}`)).rows.map((p) => [p.id, p.name]))
      : new Map<string, string>();
    // O que a agência mandou deste relatório (A7, W7, parte 4a; P29): o último envio, de qualquer agência da empresa.
    const daAgencia = linha
      ? (
          await tx.execute<{ agency_id: string; agency_name: string; with_logo: boolean; version: number; created_at: Date | string; sent_by_name: string | null; comment: string | null }>(sql`
            select s.agency_id, o.name as agency_name, s.with_logo, s.version, s.created_at, s.sent_by_name, s.comment
              from liame.agency_report_send s join liame.organization o on o.id = s.agency_id
             where s.report_id = ${linha.id}
             order by s.created_at desc, s.id desc
             limit 1`)
        ).rows[0]
      : undefined;
    return {
      ...(daAgencia
        ? {
            from_agency: {
              agency_name: daAgencia.agency_name,
              logo_url: daAgencia.with_logo ? enderecoPublicoDoLogo(this.config.apiUrl, daAgencia.agency_id) : null,
              version: daAgencia.version,
              sent_at: new Date(daAgencia.created_at).toISOString(),
              sent_by_name: daAgencia.sent_by_name,
              comment: daAgencia.comment,
            },
          }
        : {}),
      report: linha
        ? {
            ...paraQuemVe(linha.content, auth.permissions, nomes),
            id: linha.id,
            email: { status: linha.email_status, sent_at: linha.email_sent_at ? new Date(linha.email_sent_at).toISOString() : null, recipients: linha.email_recipients },
          }
        : null,
      next_report_on: proximoRelatorio(diaNoFuso(agora, fuso), ultimo.rows[0]?.month_from ?? null),
      timezone: fuso,
    };
  }
}
