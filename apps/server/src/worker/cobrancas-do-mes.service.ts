import { type Database, uuidv7, withSystem } from '@liame/database';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { NIVEL_DA_COBRANCA_LIBERADA } from '../auth/permissions.js';
import { FLAG_COBRANCA } from '../cobranca/assinatura.js';
import { CAMINHO_DA_COBRANCA, TENTATIVAS_DO_AVISO } from '../cobranca/aviso-de-atraso.js';
import { DIA_DA_COBRANCA_DO_MES, emailDaCobrancaDoMes } from '../cobranca/cobranca-do-mes.js';
import { MeioAsaas } from '../cobranca/meio-asaas.js';
import { DIAS_DA_FATURA_ANTES } from '../cobranca/vida.js';
import { APP_CONFIG, type AppConfig } from '../config.js';
import { DATABASE } from '../database/database.module.js';
import { FlagService } from '../flags/flag.service.js';
import { Mailer, maskEmail } from '../mail/mailer.js';
import { type JobScope, tenantFilter } from './outbox-publisher.js';

/** A entrega reservada por uma volta que caiu no meio volta a ser tentada depois disto (como nos avisos do atraso). */
const RETOMAR_DEPOIS = '15 minutes';

type DoMes = {
  id: string;
  tenant_id: string;
  brand_id: string;
  marca: string;
  plano: string;
  invoice_id: string;
  due_date: string;
  period_start: string;
  amount_cents: string;
  external_id: string;
};

export type CobrancaDaRotina = {
  assinatura: string;
  tenantId: string;
  enviados: number;
  falhas: number;
  resultado: 'avisada' | 'desligada' | 'ja_avisada' | 'sem_meio' | 'sem_codigo';
};

/**
 * A cobrança do mês por e-mail, com o PIX (A7; D-A7-17 e D-A7-44). Para cada assinatura em dia no PIX, a mensalidade do
 * período seguinte que já tem a cobrança no Asaas e vence em até 5 dias (no calendário da empresa): o e-mail a quem paga
 * (o Dono e o Administrador com a cobrança liberada), com o código do PIX para copiar e colar, uma vez por fatura e
 * pessoa (`billing_notice`, dia 0). O código é lido no Asaas só quando falta alguém receber; sem o Asaas, ou com ele fora
 * do ar, ninguém é reservado e a próxima volta tenta de novo. A primeira mensalidade fica de fora: ela é paga na tela, ao
 * assinar. A assinatura em atraso também: dela cuidam os avisos do atraso (D-A7-39). Passa por todas, em páginas (V106).
 */
@Injectable()
export class CobrancasDoMesService {
  private readonly logger = new Logger('cobranca-do-mes');

  constructor(
    @Inject(DATABASE) private readonly database: Database | null,
    private readonly flags: FlagService,
    private readonly mailer: Mailer,
    private readonly meio: MeioAsaas,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async executarLote(porPagina = 100, scope: JobScope = {}, agora = new Date()): Promise<CobrancaDaRotina[]> {
    if (!this.database) return [];
    const db = this.database.db;
    const instante = sql`${agora.toISOString()}::timestamptz`;
    const feitos: CobrancaDaRotina[] = [];
    let depoisDe: string | null = null;
    for (;;) {
      const cursor: string | null = depoisDe;
      const pagina: DoMes[] = await withSystem(db, async (tx): Promise<DoMes[]> =>
        (
          await tx.execute<DoMes>(sql`
            select s.id, s.tenant_id, s.brand_id, b.name as marca, p.name as plano,
                   f.id as invoice_id, f.due_date::text as due_date, f.period_start::text as period_start,
                   f.amount_cents::text as amount_cents, f.external_id
              from liame.subscription s
              join liame.brand b on b.id = s.brand_id
              join liame.organization o on o.id = s.tenant_id
              cross join lateral (
                select i.id, i.due_date, i.period_start, i.amount_cents, i.external_id, i.plan_id from liame.billing_invoice i
                 where i.subscription_id = s.id and i.kind = 'mensalidade' and i.status = 'aberta'
                   and i.period_start is not null and i.external_id is not null
                   and i.due_date >= (${instante} at time zone o.timezone)::date
                   and i.due_date <= (${instante} at time zone o.timezone)::date + ${DIAS_DA_FATURA_ANTES}::int
                 order by i.due_date, i.created_at
                 limit 1) f
              join liame.billing_plan p on p.id = f.plan_id
             where s.status = 'ativa' and s.method = 'pix' and b.archived_at is null ${tenantFilter(scope, sql`s.tenant_id`)}
               ${cursor ? sql`and s.id > ${cursor}::uuid` : sql``}
             order by s.id
             limit ${porPagina}`)
        ).rows,
      );
      for (const c of pagina) {
        try {
          feitos.push(await this.avisar(c, agora));
        } catch (err) {
          // Uma assinatura que falha não segura as outras; a próxima volta tenta de novo.
          this.logger.error(`cobrança do mês da assinatura ${c.id}: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
        }
      }
      if (pagina.length < porPagina) return feitos;
      depoisDe = pagina[pagina.length - 1]!.id;
    }
  }

  private async avisar(c: DoMes, agora: Date): Promise<CobrancaDaRotina> {
    const base = { assinatura: c.id, tenantId: c.tenant_id, enviados: 0, falhas: 0 };
    if (!(await this.flags.isEnabled(FLAG_COBRANCA, this.flags.context({ tenantId: c.tenant_id, brandId: c.brand_id })))) {
      return { ...base, resultado: 'desligada' };
    }
    const db = this.database!.db;
    const instante = sql`${agora.toISOString()}::timestamptz`;
    // Quem paga (D-A7-15), com o e-mail confirmado e o acesso vivo; e quem ainda pode receber (sem a entrega feita nem
    // esgotada, nem reservada agora por outra volta).
    const pessoas = await withSystem(db, async (tx) =>
      (
        await tx.execute<{ user_id: string; email: string }>(sql`
          select u.id as user_id, u.email
            from liame.membership mb join liame.app_user u on u.id = mb.user_id
           where mb.tenant_id = ${c.tenant_id} and mb.revoked_at is null and (mb.expires_at is null or mb.expires_at > ${instante})
             and (mb.role_key = 'dono' or (mb.role_key = ${NIVEL_DA_COBRANCA_LIBERADA} and mb.billing_access))
             and u.disabled_at is null and u.email_verified_at is not null
             and not exists (
               select 1 from liame.billing_notice n
                where n.invoice_id = ${c.invoice_id} and n.day = ${DIA_DA_COBRANCA_DO_MES} and n.user_id = u.id
                  and (n.status = 'enviado' or n.attempts >= ${TENTATIVAS_DO_AVISO}
                       or (n.status = 'enviando' and n.claimed_at >= ${instante} - ${RETOMAR_DEPOIS}::interval)))
           order by u.id`)
      ).rows,
    );
    if (!pessoas.length) return { ...base, resultado: 'ja_avisada' };

    // O código do PIX, lido uma vez para a fatura. Sem o Asaas, ou com ele fora do ar, ninguém é reservado.
    const api = this.meio.api();
    if (!api) return { ...base, resultado: 'sem_meio' };
    let copiaECola: string;
    try {
      copiaECola = (await api.qrCodePix(c.external_id)).copiaECola;
    } catch (err) {
      this.logger.warn(`cobrança do mês ${c.id}: o Asaas não devolveu o código do PIX (${err instanceof Error ? err.message : String(err)}); tento na próxima volta`);
      return { ...base, resultado: 'sem_codigo' };
    }
    const email = emailDaCobrancaDoMes({
      marca: c.marca,
      plano: c.plano,
      periodoComeca: c.period_start,
      vencimento: c.due_date,
      valorCents: c.amount_cents,
      copiaECola,
      link: `${this.config.appUrl}${CAMINHO_DA_COBRANCA}?marca=${c.brand_id}`,
    });
    let enviados = 0;
    let falhas = 0;
    for (const p of pessoas) {
      // Reserva a entrega: a nova; a que falhou, até o limite; a reservada por uma volta que caiu no meio.
      const reservada = (
        await withSystem(db, (tx) =>
          tx.execute<{ id: string }>(sql`
            insert into liame.billing_notice (id, tenant_id, subscription_id, invoice_id, day, user_id, status, attempts, claimed_at)
            values (${uuidv7()}, ${c.tenant_id}, ${c.id}, ${c.invoice_id}, ${DIA_DA_COBRANCA_DO_MES}, ${p.user_id}, 'enviando', 1, ${instante})
            on conflict (invoice_id, day, user_id) do update
               set status = 'enviando', attempts = liame.billing_notice.attempts + 1, claimed_at = excluded.claimed_at, error = null, updated_at = now()
             where (liame.billing_notice.status = 'falhou' and liame.billing_notice.attempts < ${TENTATIVAS_DO_AVISO})
                or (liame.billing_notice.status = 'enviando' and liame.billing_notice.claimed_at < ${instante} - ${RETOMAR_DEPOIS}::interval
                    and liame.billing_notice.attempts < ${TENTATIVAS_DO_AVISO})
            returning id`),
        )
      ).rows[0];
      if (!reservada) continue;
      let falha: string | null = null;
      try {
        await this.mailer.send({ to: p.email, subject: email.subject, text: email.text });
      } catch (err) {
        // O motivo vai para o log com o endereço mascarado; na linha da entrega fica só o tipo do erro.
        falha = (err instanceof Error ? err.name : 'Erro').slice(0, 100) || 'Erro';
        this.logger.warn(`cobrança do mês ${c.id}: envio para ${maskEmail(p.email)} falhou (${err instanceof Error ? err.message : String(err)})`);
      }
      await withSystem(db, (tx) =>
        tx.execute(sql`
          update liame.billing_notice
             set status = ${falha ? 'falhou' : 'enviado'}, error = ${falha}, sent_at = ${falha ? null : agora.toISOString()}::timestamptz, updated_at = now()
           where id = ${reservada.id}`),
      );
      if (falha) falhas += 1;
      else enviados += 1;
    }
    return { ...base, enviados, falhas, resultado: 'avisada' };
  }
}
