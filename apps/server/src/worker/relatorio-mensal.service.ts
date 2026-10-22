import type { MonthlyReportWeek } from '@liame/contracts';
import { type Database, uuidv7, withSystem } from '@liame/database';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { BudgetService } from '../actions/budget.service.js';
import { ExplicarService } from '../ai/explicar/explicar.service.js';
import { respostaDaExplicacao } from '../ai/explicar/saida.js';
import { naTransacaoDaEmpresa } from '../ai/na-empresa.js';
import { desligadoPelaEmpresa } from '../ai/registro/ativacao.js';
import type { ContextoDaLeitura } from '../ai/registro/leituras.js';
import { APP_CONFIG, type AppConfig } from '../config.js';
import { currentTx } from '../context/request-context.js';
import { DATABASE } from '../database/database.module.js';
import { EquipeService } from '../equipe/equipe.service.js';
import { RELATORIOS } from '../equipe/membros.js';
import { FlagService } from '../flags/flag.service.js';
import { Mailer, maskEmail } from '../mail/mailer.js';
import { proibidasDaMarca } from '../marca/marca.service.js';
import { MediaService } from '../media/media.service.js';
import { AtencaoCicloService } from '../results/atencao-ciclo.service.js';
import { diaNoFuso } from '../results/fora-do-normal.js';
import { emailDoRelatorio } from '../results/relatorio-email.js';
import {
  comAtrasoMarcadoNoMes,
  type ConteudoDoRelatorio,
  diaDoRelatorio,
  HORA_DE_GERAR,
  HORA_DO_EMAIL,
  HORA_LIMITE,
  mesAnterior,
  mesCurto,
  mesEmDia,
  mesFechado,
  noPrazo,
  paraOMesQueVem,
  RELATORIO_VERSAO,
  semanaComNumeros,
  semanaNoContexto,
  semanasDoMes,
} from '../results/relatorio-mensal.js';
import { NIVEIS_QUE_RECEBEM } from '../results/revisao-email.js';
import { campanhasDaSemana, horaNoFuso, oQueMudou, soNaPlataforma, temAsFontes, temMovimento, totaisDaSemana } from '../results/revisao-semanal.js';
import { ResultsService } from '../results/results.service.js';

// O relatório do mês de uma marca (A3, I7; protótipo P24, decisões D-A3-18 a D-A3-22). Fica na pasta do worker
// porque grava em escopo de sistema, e só os jobs do worker podem (regra `liame-escopo-sistema`). No dia 1º de
// manhã, no fuso da loja:
//   1. lê, como a empresa, os resultados do mês que fechou na véspera, os do mês anterior e os de cada semana do
//      mês (cortada no mês), com os mesmos números da tela Resultados, e os avisos ativos; e a verba e a equipe do
//      mês, como a Verba do mês e Sua equipe mostravam no fim dele (D-A3-22);
//   2. pede a leitura do mês ao Explicar, sem transação aberta: a LIA, quando está ligada e os dados estão em dia;
//      senão, o resumo do sistema, com o motivo;
//   3. guarda o relatório como foi gerado, um por marca e mês.
// O envio por e-mail (`enviar`) é um segundo laço, sobre os relatórios que esperam o envio: só com a `relatorio_email`
// ligada para a empresa e até o dia 7 do mês seguinte. Nada é executado em plataforma nenhuma.

/** Cada pessoa tem até tantas tentativas de envio; entre uma volta e outra do envio, esta espera. */
const TENTATIVAS_POR_PESSOA = 3;
const NOVA_TENTATIVA = '30 minutes';

export type ResultadoDoEnvio = { status: 'enviado' | 'pendente' | 'desligado' | 'sem_destinatario' | 'falhou' | 'expirado'; enviados: number };
type LinhaDoRelatorio = { tenant_id: string; brand_id: string; timezone: string; content: ConteudoDoRelatorio; marca: string; empresa: string };
type Destinatario = { id: string; email: string; role_key: string; attempts: number };

export type ResultadoDoRelatorio = {
  status: 'gerado' | 'ja_tem' | 'fora_do_prazo' | 'cedo' | 'aguardando_leitura' | 'sem_fontes' | 'sem_movimento' | 'desligado_pela_empresa';
  fuso: string;
  /** O dia 1º do mês olhado. */
  mes: string;
  /** No relatório gerado: o id e quem escreveu a leitura. */
  id?: string;
  leitura?: 'lia' | 'sistema';
};

@Injectable()
export class RelatorioMensalService {
  private readonly logger = new Logger('relatorio-mensal');

  constructor(
    @Inject(DATABASE) private readonly database: Database | null,
    private readonly results: ResultsService,
    private readonly media: MediaService,
    private readonly ciclo: AtencaoCicloService,
    private readonly explicar: ExplicarService,
    private readonly flags: FlagService,
    private readonly verba: BudgetService,
    private readonly equipe: EquipeService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly mailer: Mailer,
  ) {}

  /**
   * Gera o relatório do último mês fechado da marca, se ele ainda não existe, já é hora e o prazo não passou. O
   * relógio injetado vale para a operação inteira (V34).
   */
  async gerar(alvo: { tenantId: string; brandId: string }, agora = new Date()): Promise<ResultadoDoRelatorio> {
    if (!this.database) throw new Error('relatório do mês: sem banco');
    const { tenantId, brandId } = alvo;
    const ctx: ContextoDaLeitura = { tenantId, userId: null, permissions: 'sistema', agora };

    // ---- 1. leitura, como a empresa
    const lido = await naTransacaoDaEmpresa(this.database, { tenantId, userId: null }, async () => {
      const fuso = await this.results.fusoDaMarca(brandId);
      const hoje = diaNoFuso(agora, fuso);
      const mes = mesFechado(hoje);
      const base = { fuso, mes };
      const existe = await currentTx().execute(sql`select 1 from liame.monthly_report where brand_id = ${brandId} and month_from = ${mes.from}::date`);
      if (existe.rows.length) return { ...base, situacao: 'ja_tem' as const };
      // Passou do dia 7: o mês que fechou já não é notícia, e o próximo relatório é o do mês que está correndo.
      if (!noPrazo(hoje, mes)) return { ...base, situacao: 'fora_do_prazo' as const };
      // A empresa desligou o Relatórios nesta marca (I13b): o relatório não é gerado enquanto ele estiver desligado.
      if (await desligadoPelaEmpresa(currentTx(), { tenantId, brandId, agentKey: RELATORIOS })) return { ...base, situacao: 'desligado_pela_empresa' as const };
      // No dia 1º, ele espera a hora de gerar e, até a hora limite, a leitura que traz o último dia do mês inteiro.
      const ehODia = hoje === diaDoRelatorio(mes);
      const hora = horaNoFuso(agora, fuso);
      if (ehODia && hora < HORA_DE_GERAR) return { ...base, situacao: 'cedo' as const };
      const atual = await this.results.closedLoop({ brand_id: brandId, ...mes }, agora);
      if (!temAsFontes(atual.sources)) return { ...base, situacao: 'sem_fontes' as const };
      const mesAntes = await this.results.closedLoop({ brand_id: brandId, ...mesAnterior(mes) }, agora);
      if (!temMovimento(atual, mesAntes)) return { ...base, situacao: 'sem_movimento' as const };
      const emDia = mesEmDia(atual.sources, mes, fuso);
      if (!emDia && ehODia && hora < HORA_LIMITE) return { ...base, situacao: 'aguardando_leitura' as const };
      // Sem nada no mês anterior não há com o que comparar.
      const anterior = temMovimento(mesAntes, null) ? mesAntes : null;
      // Cada semana do mês, cortada no mês, com os números dos dias dela; e se a revisão da semana inteira existe.
      const doMes = semanasDoMes(mes);
      const r = await currentTx().execute<{ week_from: string }>(sql`
        select week_from::text as week_from from liame.weekly_review
         where brand_id = ${brandId} and week_from between ${doMes[0]!.week.from}::date and ${doMes.at(-1)!.week.from}::date`);
      const comRevisao = new Set(r.rows.map((l) => l.week_from));
      const semanas: MonthlyReportWeek[] = [];
      for (const s of doMes) semanas.push(semanaComNumeros(s, await this.results.closedLoop({ brand_id: brandId, from: s.from, to: s.to }, agora), comRevisao.has(s.week.from)));
      const avisos = [...(await this.media.atencao(brandId, agora)).items, ...(await this.ciclo.atencao(brandId, agora)).items];
      const ativo = await this.explicar.analistaLigado(ctx, brandId);
      // O que a marca nunca diz (dossiê, I8): a leitura da LIA passa pela mesma conferência do Explicar.
      const daMarca = await proibidasDaMarca(brandId);
      // A verba (da empresa inteira, como a tela de origem) e o que a equipe fez no mês: guardadas com o relatório, e a
      // leitura da LIA não fala delas (D-A3-22).
      const verba = await this.verba.doMesFechado(tenantId, mes);
      const equipe = await this.equipe.doMesFechado(tenantId, brandId, mes);
      return { ...base, situacao: 'gerar' as const, atual, anterior, emDia, semanas, avisos, ativo, daMarca, verba, equipe };
    });
    if (lido.situacao !== 'gerar') return { status: lido.situacao, fuso: lido.fuso, mes: lido.mes.from };
    const { fuso, mes, atual, anterior, semanas } = lido;

    // ---- 2. a leitura do mês, sem transação aberta (é a chamada ao modelo, quando a LIA está ligada)
    const leitura = await this.explicar.doMes(ctx, brandId, {
      atual: lido.emDia ? atual : comAtrasoMarcadoNoMes(atual, mes, fuso),
      anterior,
      semanas: semanas.map((s) => semanaNoContexto(s, atual.currency)),
      mesAnterior: mesCurto(mesAnterior(mes)),
      ativo: lido.ativo,
      daMarca: lido.daMarca,
    });

    // ---- 3. o relatório, como a tela e o e-mail vão mostrar
    const { improved, worsened } = oQueMudou(atual, anterior);
    const conteudo: ConteudoDoRelatorio = {
      brand_id: brandId,
      month: mes,
      previous_month: mesAnterior(mes),
      timezone: fuso,
      currency: atual.currency,
      generated_at: agora.toISOString(),
      totals: totaisDaSemana(atual, anterior),
      verdict: atual.totals.confirmed.verdict,
      weeks: semanas,
      campaigns: campanhasDaSemana(atual),
      platform_only: soNaPlataforma(atual),
      improved,
      worsened,
      decisions: paraOMesQueVem(atual, lido.avisos, brandId, mes),
      budget: lido.verba,
      team: lido.equipe,
      reading: respostaDaExplicacao(leitura),
    };

    // ---- 4. gravação, em escopo de sistema: um relatório por marca e mês
    const comEmail = await this.flags.isEnabled('relatorio_email', this.flags.context({ tenantId, brandId }));
    const id = uuidv7();
    const instante = agora.toISOString();
    const gravado = await withSystem(this.database.db, (tx) =>
      tx.execute<{ id: string }>(sql`
        insert into liame.monthly_report
          (id, tenant_id, brand_id, month_from, month_to, timezone, generated_at, reading_source, reading_reason, usage_id, content, content_version, email_status, email_next_at)
        values (${id}, ${tenantId}, ${brandId}, ${mes.from}::date, ${mes.to}::date, ${fuso}, ${instante}::timestamptz,
                ${conteudo.reading.source}, ${conteudo.reading.reason}, ${conteudo.reading.usage_id}, ${JSON.stringify(conteudo)}::jsonb, ${RELATORIO_VERSAO},
                ${comEmail ? 'pendente' : 'desligado'},
                ${comEmail ? sql`greatest(${instante}::timestamptz, ((${diaDoRelatorio(mes)}::date + make_interval(hours => ${HORA_DO_EMAIL})) at time zone ${fuso}))` : sql`null`})
        on conflict (brand_id, month_from) do nothing
        returning id`),
    );
    // Outro worker gravou o mesmo mês no meio do caminho: vale o dele.
    if (!gravado.rows.length) return { status: 'ja_tem', fuso, mes: mes.from };
    return { status: 'gerado', fuso, mes: mes.from, id, leitura: conteudo.reading.source === 'lia' ? 'lia' : 'sistema' };
  }

  /**
   * Envia o relatório por e-mail a quem ainda não recebeu: o dono, os administradores e quem só recebe relatórios, com
   * o e-mail confirmado (D-A3-20, os mesmos da revisão). Cada entrega fica gravada (enviada ou falhou, com o tipo do
   * erro e sem o endereço), e a mesma pessoa não recebe duas vezes. Passado o dia 7 do mês seguinte, o relatório já não
   * é notícia (`expirado`); com a `relatorio_email` desligada, o envio para (`desligado`).
   */
  async enviar(reportId: string, agora = new Date()): Promise<ResultadoDoEnvio> {
    if (!this.database) throw new Error('relatório do mês: sem banco');
    const db = this.database.db;
    const lido = await withSystem(db, async (tx) => {
      const r = await tx.execute<LinhaDoRelatorio>(sql`
        select m.tenant_id, m.brand_id, m.timezone, m.content, b.name as marca, o.name as empresa
          from liame.monthly_report m
          join liame.brand b on b.id = m.brand_id
          join liame.organization o on o.id = m.tenant_id
         where m.id = ${reportId} and m.email_status = 'pendente'`);
      const relatorio = r.rows[0];
      if (!relatorio) return null;
      const pessoas = await tx.execute<Destinatario>(sql`
        select u.id, u.email, mb.role_key, coalesce(d.attempts, 0)::int as attempts
          from liame.membership mb
          join liame.app_user u on u.id = mb.user_id
          left join liame.monthly_report_delivery d on d.report_id = ${reportId} and d.user_id = u.id
         where mb.tenant_id = ${relatorio.tenant_id} and mb.revoked_at is null and (mb.expires_at is null or mb.expires_at > ${agora.toISOString()}::timestamptz)
           and mb.role_key in (${sql.join(NIVEIS_QUE_RECEBEM.map((n) => sql`${n}`), sql`, `)})
           and u.disabled_at is null and u.email_verified_at is not null
           and (d.id is null or (d.status = 'falhou' and d.attempts < ${TENTATIVAS_POR_PESSOA}))
         order by u.id`);
      return { relatorio, pessoas: pessoas.rows };
    });
    // O relatório já não espera o envio (outro worker fechou, ou ele não existe): nada a fazer.
    if (!lido) return { status: 'enviado', enviados: 0 };
    const { relatorio, pessoas } = lido;
    const conteudo = relatorio.content;

    if (!noPrazo(diaNoFuso(agora, relatorio.timezone), conteudo.month)) return this.fecharEnvio(reportId, 'expirado', agora);
    if (!(await this.flags.isEnabled('relatorio_email', this.flags.context({ tenantId: relatorio.tenant_id, brandId: relatorio.brand_id })))) {
      return this.fecharEnvio(reportId, 'desligado', agora);
    }

    const link = `${this.config.appUrl}/resultados/relatorio?marca=${relatorio.brand_id}&mes=${conteudo.month.from.slice(0, 7)}`;
    // As duas imagens do e-mail (a marca e o rosto da LIA) moram no webapp do Liame, sem código de rastreio.
    const imagens = { logo: `${this.config.appUrl}/email/liame-logo.png`, lia: `${this.config.appUrl}/email/lia.png` };
    for (const p of pessoas) {
      const email = emailDoRelatorio(conteudo, { marca: relatorio.marca, empresa: relatorio.empresa, nivel: p.role_key, link, imagens });
      let falha: string | null = null;
      try {
        await this.mailer.send({ to: p.email, subject: email.subject, text: email.text, html: email.html });
      } catch (err) {
        // O motivo vai para o log com o endereço mascarado; na linha da entrega fica só o tipo do erro.
        falha = (err instanceof Error ? err.name : 'Erro').slice(0, 100) || 'Erro';
        this.logger.warn(`relatório ${reportId}: envio para ${maskEmail(p.email)} falhou (${err instanceof Error ? err.message : String(err)})`);
      }
      await withSystem(db, (tx) =>
        tx.execute(sql`
          insert into liame.monthly_report_delivery (id, tenant_id, report_id, user_id, role_key, status, attempts, error, sent_at)
          values (${uuidv7()}, ${relatorio.tenant_id}, ${reportId}, ${p.id}, ${p.role_key}, ${falha ? 'falhou' : 'enviado'}, 1, ${falha}, ${falha ? null : agora.toISOString()}::timestamptz)
          on conflict (report_id, user_id) do update
             set status = excluded.status, attempts = liame.monthly_report_delivery.attempts + 1, error = excluded.error, sent_at = excluded.sent_at,
                 role_key = excluded.role_key, updated_at = now()`),
      );
    }
    return this.fecharEnvio(reportId, null, agora);
  }

  /**
   * Fecha o envio pela situação das entregas: com alguma ainda por tentar, o relatório volta para a fila; senão,
   * `enviado` (chegou a alguém), `falhou` (a ninguém) ou `sem_destinatario` (não havia para quem). `encerrar` para de
   * tentar (o prazo acabou, ou a empresa desligou o envio): se já chegou a alguém, fica `enviado`; senão, o motivo.
   */
  private async fecharEnvio(reportId: string, encerrar: 'expirado' | 'desligado' | null, agora: Date): Promise<ResultadoDoEnvio> {
    const instante = agora.toISOString();
    return withSystem(this.database!.db, async (tx) => {
      const c = await tx.execute<{ enviados: number; por_tentar: number; falhas: number }>(sql`
        select count(*) filter (where status = 'enviado')::int as enviados,
               count(*) filter (where status = 'falhou' and attempts < ${TENTATIVAS_POR_PESSOA})::int as por_tentar,
               count(*) filter (where status = 'falhou')::int as falhas
          from liame.monthly_report_delivery where report_id = ${reportId}`);
      const { enviados, por_tentar, falhas } = c.rows[0]!;
      const status: ResultadoDoEnvio['status'] =
        por_tentar > 0 && !encerrar ? 'pendente' : enviados > 0 ? 'enviado' : (encerrar ?? (falhas > 0 ? 'falhou' : 'sem_destinatario'));
      await tx.execute(sql`
        update liame.monthly_report
           set email_status = ${status},
               email_next_at = ${status === 'pendente' ? sql`${instante}::timestamptz + ${NOVA_TENTATIVA}::interval` : sql`null`},
               email_sent_at = ${enviados > 0 ? sql`coalesce(email_sent_at, ${instante}::timestamptz)` : sql`email_sent_at`},
               email_recipients = ${enviados},
               updated_at = now()
         where id = ${reportId}`);
      return { status, enviados };
    });
  }
}
