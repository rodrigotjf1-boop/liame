import { type Database, uuidv7, withSystem } from '@liame/database';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { ExplicarService } from '../ai/explicar/explicar.service.js';
import { respostaDaExplicacao } from '../ai/explicar/saida.js';
import { naTransacaoDaEmpresa } from '../ai/na-empresa.js';
import type { ContextoDaLeitura } from '../ai/registro/leituras.js';
import { APP_CONFIG, type AppConfig } from '../config.js';
import { currentTx } from '../context/request-context.js';
import { DATABASE } from '../database/database.module.js';
import { FlagService } from '../flags/flag.service.js';
import { Mailer, maskEmail } from '../mail/mailer.js';
import { proibidasDaMarca } from '../marca/marca.service.js';
import { MediaService } from '../media/media.service.js';
import { AtencaoCicloService } from '../results/atencao-ciclo.service.js';
import { diaNoFuso } from '../results/fora-do-normal.js';
import { type ConteudoDaRevisao, emailDaRevisao, NIVEIS_QUE_RECEBEM } from '../results/revisao-email.js';
import {
  campanhasDaSemana,
  comAtrasoMarcado,
  diaDaRevisao,
  DIAS_DE_VALIDADE,
  HORA_DE_GERAR,
  HORA_DO_EMAIL,
  HORA_LIMITE,
  horaNoFuso,
  maisDias,
  oQueMudou,
  precisaDeDecisao,
  REVISAO_VERSAO,
  semanaAnterior,
  semanaEmDia,
  semanaFechada,
  soNaPlataforma,
  temAsFontes,
  temMovimento,
  totaisDaSemana,
} from '../results/revisao-semanal.js';
import { ResultsService } from '../results/results.service.js';

// A revisão da semana de uma marca (A3, I7; protótipo P4). Fica na pasta do worker porque grava em escopo de
// sistema, e só os jobs do worker podem (regra `liame-escopo-sistema`). Na segunda-feira de manhã, no fuso
// da loja:
//   1. lê, como a empresa, os resultados da semana que fechou no domingo e os da semana anterior (os mesmos
//      números da tela Resultados) e os avisos ativos;
//   2. pede a leitura da semana ao Explicar, sem transação aberta: a LIA, quando está ligada e os dados
//      estão em dia; senão, o resumo do sistema, com o motivo;
//   3. guarda a revisão como foi gerada, uma por marca e semana;
//   4. mais tarde, envia por e-mail a quem tem nível para receber, se a empresa tem o envio ligado.
// Nada é executado em plataforma nenhuma.

/** Quantas vezes o envio a uma pessoa é tentado antes de desistir dela. */
const TENTATIVAS_POR_PESSOA = 3;
/** Com entrega que falhou, a revisão volta para a fila do envio depois disto. */
const NOVA_TENTATIVA = '30 minutes';

export type ResultadoDaRevisao = {
  status: 'gerada' | 'ja_tem' | 'cedo' | 'aguardando_leitura' | 'sem_fontes' | 'sem_movimento';
  fuso: string;
  /** A segunda-feira da semana olhada. */
  semana: string;
  /** Na revisão gerada: o id e quem escreveu a leitura. */
  id?: string;
  leitura?: 'lia' | 'sistema';
};

export type ResultadoDoEnvio = { status: 'enviado' | 'pendente' | 'desligado' | 'sem_destinatario' | 'falhou' | 'expirado'; enviados: number };

type LinhaDaRevisao = { tenant_id: string; brand_id: string; week_to: string; timezone: string; content: ConteudoDaRevisao; marca: string; empresa: string };
type Destinatario = { id: string; email: string; role_key: string; attempts: number };

@Injectable()
export class RevisaoSemanalService {
  private readonly logger = new Logger('revisao-semanal');

  constructor(
    @Inject(DATABASE) private readonly database: Database | null,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly results: ResultsService,
    private readonly media: MediaService,
    private readonly ciclo: AtencaoCicloService,
    private readonly explicar: ExplicarService,
    private readonly flags: FlagService,
    private readonly mailer: Mailer,
  ) {}

  /**
   * Gera a revisão da última semana fechada da marca, se ela ainda não existe e já é hora. O relógio
   * injetado vale para a operação inteira (V34).
   */
  async gerar(alvo: { tenantId: string; brandId: string }, agora = new Date()): Promise<ResultadoDaRevisao> {
    if (!this.database) throw new Error('revisão da semana: sem banco');
    const { tenantId, brandId } = alvo;
    const ctx: ContextoDaLeitura = { tenantId, userId: null, permissions: 'sistema', agora };

    // ---- 1. leitura, como a empresa
    const lido = await naTransacaoDaEmpresa(this.database, { tenantId, userId: null }, async () => {
      const fuso = await this.results.fusoDaMarca(brandId);
      const hoje = diaNoFuso(agora, fuso);
      const semana = semanaFechada(hoje);
      const base = { fuso, semana };
      const existe = await currentTx().execute(sql`select 1 from liame.weekly_review where brand_id = ${brandId} and week_from = ${semana.from}::date`);
      if (existe.rows.length) return { ...base, situacao: 'ja_tem' as const };
      // No dia da revisão, ela espera a hora de gerar e, até a hora limite, a leitura que traz o domingo inteiro.
      const ehODia = hoje === diaDaRevisao(semana);
      const hora = horaNoFuso(agora, fuso);
      if (ehODia && hora < HORA_DE_GERAR) return { ...base, situacao: 'cedo' as const };
      const atual = await this.results.closedLoop({ brand_id: brandId, ...semana }, agora);
      if (!temAsFontes(atual.sources)) return { ...base, situacao: 'sem_fontes' as const };
      const semanaAntes = await this.results.closedLoop({ brand_id: brandId, ...semanaAnterior(semana) }, agora);
      if (!temMovimento(atual, semanaAntes)) return { ...base, situacao: 'sem_movimento' as const };
      const emDia = semanaEmDia(atual.sources, semana, fuso);
      if (!emDia && ehODia && hora < HORA_LIMITE) return { ...base, situacao: 'aguardando_leitura' as const };
      // Sem nada na semana anterior não há com o que comparar.
      const anterior = temMovimento(semanaAntes, null) ? semanaAntes : null;
      const avisos = [...(await this.media.atencao(brandId, agora)).items, ...(await this.ciclo.atencao(brandId, agora)).items];
      const ativo = await this.explicar.analistaLigado(ctx, brandId);
      // O que a marca nunca diz (dossiê, I8): a leitura da LIA passa pela mesma conferência do Explicar.
      const daMarca = await proibidasDaMarca(brandId);
      return { ...base, situacao: 'gerar' as const, atual, anterior, emDia, avisos, ativo, daMarca };
    });
    if (lido.situacao !== 'gerar') return { status: lido.situacao, fuso: lido.fuso, semana: lido.semana.from };
    const { fuso, semana, atual, anterior } = lido;

    // ---- 2. a leitura da semana, sem transação aberta (é a chamada ao modelo, quando a LIA está ligada)
    const leitura = await this.explicar.daSemana(ctx, brandId, {
      atual: lido.emDia ? atual : comAtrasoMarcado(atual, semana, fuso),
      anterior,
      ativo: lido.ativo,
      daMarca: lido.daMarca,
    });

    // ---- 3. a revisão, como a tela e o e-mail vão mostrar
    const { improved, worsened } = oQueMudou(atual, anterior);
    const conteudo: ConteudoDaRevisao = {
      brand_id: brandId,
      week: semana,
      previous_week: semanaAnterior(semana),
      timezone: fuso,
      currency: atual.currency,
      generated_at: agora.toISOString(),
      totals: totaisDaSemana(atual, anterior),
      verdict: atual.totals.confirmed.verdict,
      campaigns: campanhasDaSemana(atual),
      platform_only: soNaPlataforma(atual),
      improved,
      worsened,
      decisions: precisaDeDecisao(atual, anterior, lido.avisos, brandId),
      reading: respostaDaExplicacao(leitura),
    };

    // ---- 4. gravação, em escopo de sistema: uma revisão por marca e semana
    const comEmail = await this.flags.isEnabled('revisao_email', this.flags.context({ tenantId, brandId }));
    const id = uuidv7();
    const instante = agora.toISOString();
    const gravada = await withSystem(this.database.db, (tx) =>
      tx.execute<{ id: string }>(sql`
        insert into liame.weekly_review
          (id, tenant_id, brand_id, week_from, week_to, timezone, generated_at, reading_source, reading_reason, usage_id, content, content_version, email_status, email_next_at)
        values (${id}, ${tenantId}, ${brandId}, ${semana.from}::date, ${semana.to}::date, ${fuso}, ${instante}::timestamptz,
                ${conteudo.reading.source}, ${conteudo.reading.reason}, ${conteudo.reading.usage_id}, ${JSON.stringify(conteudo)}::jsonb, ${REVISAO_VERSAO},
                ${comEmail ? 'pendente' : 'desligado'},
                ${comEmail ? sql`greatest(${instante}::timestamptz, ((${diaDaRevisao(semana)}::date + make_interval(hours => ${HORA_DO_EMAIL})) at time zone ${fuso}))` : sql`null`})
        on conflict (brand_id, week_from) do nothing
        returning id`),
    );
    // Outro worker gravou a mesma semana no meio do caminho: vale a dele.
    if (!gravada.rows.length) return { status: 'ja_tem', fuso, semana: semana.from };
    return { status: 'gerada', fuso, semana: semana.from, id, leitura: conteudo.reading.source === 'lia' ? 'lia' : 'sistema' };
  }

  /**
   * Envia a revisão por e-mail a quem ainda não recebeu: o dono, os administradores e quem só recebe
   * relatórios. Cada entrega fica gravada (enviada ou falhou), e a mesma pessoa não recebe duas vezes.
   */
  async enviar(reviewId: string, agora = new Date()): Promise<ResultadoDoEnvio> {
    if (!this.database) throw new Error('revisão da semana: sem banco');
    const db = this.database.db;
    const lido = await withSystem(db, async (tx) => {
      const r = await tx.execute<LinhaDaRevisao>(sql`
        select w.tenant_id, w.brand_id, w.week_to::text as week_to, w.timezone, w.content, b.name as marca, o.name as empresa
          from liame.weekly_review w
          join liame.brand b on b.id = w.brand_id
          join liame.organization o on o.id = w.tenant_id
         where w.id = ${reviewId} and w.email_status = 'pendente'`);
      const revisao = r.rows[0];
      if (!revisao) return null;
      const pessoas = await tx.execute<Destinatario>(sql`
        select u.id, u.email, m.role_key, coalesce(d.attempts, 0)::int as attempts
          from liame.membership m
          join liame.app_user u on u.id = m.user_id
          left join liame.weekly_review_delivery d on d.review_id = ${reviewId} and d.user_id = u.id
         where m.tenant_id = ${revisao.tenant_id} and m.revoked_at is null and (m.expires_at is null or m.expires_at > ${agora.toISOString()}::timestamptz)
           and m.role_key in (${sql.join(NIVEIS_QUE_RECEBEM.map((n) => sql`${n}`), sql`, `)})
           and u.disabled_at is null and u.email_verified_at is not null
           and (d.id is null or (d.status = 'falhou' and d.attempts < ${TENTATIVAS_POR_PESSOA}))
         order by u.id`);
      return { revisao, pessoas: pessoas.rows };
    });
    // A revisão já não espera envio (outro worker fechou, ou ela não existe): nada a fazer.
    if (!lido) return { status: 'enviado', enviados: 0 };
    const { revisao, pessoas } = lido;

    // A semana seguinte acabou: a revisão já não é notícia.
    if (diaNoFuso(agora, revisao.timezone) > maisDias(revisao.week_to, DIAS_DE_VALIDADE)) return this.fecharEnvio(reviewId, 'expirado', agora);
    if (!(await this.flags.isEnabled('revisao_email', this.flags.context({ tenantId: revisao.tenant_id, brandId: revisao.brand_id })))) {
      return this.fecharEnvio(reviewId, 'desligado', agora);
    }

    const link = `${this.config.appUrl}/resultados/revisao?marca=${revisao.brand_id}&semana=${revisao.content.week.from}`;
    for (const p of pessoas) {
      const email = emailDaRevisao(revisao.content, { marca: revisao.marca, empresa: revisao.empresa, nivel: p.role_key, link });
      let falha: string | null = null;
      try {
        await this.mailer.send({ to: p.email, subject: email.subject, text: email.text });
      } catch (err) {
        // O motivo vai para o log com o endereço mascarado; na linha da entrega fica só o tipo do erro.
        falha = (err instanceof Error ? err.name : 'Erro').slice(0, 100) || 'Erro';
        this.logger.warn(`revisão ${reviewId}: envio para ${maskEmail(p.email)} falhou (${err instanceof Error ? err.message : String(err)})`);
      }
      await withSystem(db, (tx) =>
        tx.execute(sql`
          insert into liame.weekly_review_delivery (id, tenant_id, review_id, user_id, role_key, status, attempts, error, sent_at)
          values (${uuidv7()}, ${revisao.tenant_id}, ${reviewId}, ${p.id}, ${p.role_key}, ${falha ? 'falhou' : 'enviado'}, 1, ${falha}, ${falha ? null : agora.toISOString()}::timestamptz)
          on conflict (review_id, user_id) do update
             set status = excluded.status, attempts = liame.weekly_review_delivery.attempts + 1, error = excluded.error, sent_at = excluded.sent_at,
                 role_key = excluded.role_key, updated_at = now()`),
      );
    }
    return this.fecharEnvio(reviewId, null, agora);
  }

  /**
   * Fecha o envio pela situação das entregas: com alguma ainda por tentar, a revisão volta para a fila;
   * senão, `enviado` (chegou a alguém), `falhou` (a ninguém) ou `sem_destinatario` (não havia para quem).
   * `encerrar` para de tentar (a semana expirou, ou a empresa desligou o envio): se já chegou a alguém,
   * fica `enviado`; senão, o motivo do encerramento.
   */
  private async fecharEnvio(reviewId: string, encerrar: 'expirado' | 'desligado' | null, agora: Date): Promise<ResultadoDoEnvio> {
    const instante = agora.toISOString();
    return withSystem(this.database!.db, async (tx) => {
      const c = await tx.execute<{ enviados: number; por_tentar: number; falhas: number }>(sql`
        select count(*) filter (where status = 'enviado')::int as enviados,
               count(*) filter (where status = 'falhou' and attempts < ${TENTATIVAS_POR_PESSOA})::int as por_tentar,
               count(*) filter (where status = 'falhou')::int as falhas
          from liame.weekly_review_delivery where review_id = ${reviewId}`);
      const { enviados, por_tentar, falhas } = c.rows[0]!;
      const status: ResultadoDoEnvio['status'] =
        por_tentar > 0 && !encerrar ? 'pendente' : enviados > 0 ? 'enviado' : (encerrar ?? (falhas > 0 ? 'falhou' : 'sem_destinatario'));
      await tx.execute(sql`
        update liame.weekly_review
           set email_status = ${status},
               email_next_at = ${status === 'pendente' ? sql`${instante}::timestamptz + ${NOVA_TENTATIVA}::interval` : sql`null`},
               email_sent_at = ${enviados > 0 ? sql`coalesce(email_sent_at, ${instante}::timestamptz)` : sql`email_sent_at`},
               email_recipients = ${enviados},
               updated_at = now()
         where id = ${reviewId}`);
      return { status, enviados };
    });
  }
}
