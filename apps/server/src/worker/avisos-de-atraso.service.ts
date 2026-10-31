import { type Database, uuidv7, withSystem } from '@liame/database';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { NIVEL_DA_COBRANCA_LIBERADA } from '../auth/permissions.js';
import { FLAG_COBRANCA } from '../cobranca/assinatura.js';
import { avisoDoDia, type DiaDoAviso, emailDoAviso, TENTATIVAS_DO_AVISO } from '../cobranca/aviso-de-atraso.js';
import { diaNoFuso, diasEntre } from '../cobranca/vida.js';
import { APP_CONFIG, type AppConfig } from '../config.js';
import { DATABASE } from '../database/database.module.js';
import { FlagService } from '../flags/flag.service.js';
import { Mailer, maskEmail } from '../mail/mailer.js';
import { type JobScope, tenantFilter } from './outbox-publisher.js';

/**
 * O endereço da tela "Plano e cobrança" no web (a W5 nasce nele; D-A7-39): o link do aviso leva a pessoa a pagar a
 * mensalidade da marca.
 */
export const CAMINHO_DA_COBRANCA = '/cobranca';

/** A entrega reservada por uma volta que caiu no meio volta a ser tentada depois disto. */
const RETOMAR_DEPOIS = '15 minutes';

type EmAtraso = {
  id: string;
  tenant_id: string;
  brand_id: string;
  marca: string;
  timezone: string;
  invoice_id: string;
  due_date: string;
  amount_cents: string;
};

export type AvisoDaRotina = {
  assinatura: string;
  tenantId: string;
  /** O dia do aviso que vale hoje, ou nulo (nenhum ainda, ou a função desligada). */
  aviso: DiaDoAviso | null;
  enviados: number;
  falhas: number;
  resultado: 'avisada' | 'desligada' | 'sem_aviso';
};

/**
 * O aviso do atraso por e-mail (A7, W3, parte 2; D-A7-15 e D-A7-39; Termos 10.4). Para cada assinatura em atraso (em
 * atraso, ações paradas ou suspensa), pela mensalidade mais antiga em aberto, no calendário da empresa: no 1º, no 7º, no
 * 10º e no 30º dia, o e-mail a quem paga (o Dono e o Administrador com a cobrança liberada), uma vez por fatura, dia e
 * pessoa (`billing_notice`). A entrega é reservada antes do envio (o índice único segura duas voltas juntas), e a
 * reservada por uma volta que caiu volta depois de 15 minutos; a que falhou tenta de novo, até 3 vezes. Passa por todas
 * as assinaturas em atraso, em páginas (V106). Com a função `cobranca` desligada para a empresa, nada sai.
 */
@Injectable()
export class AvisosDeAtrasoService {
  private readonly logger = new Logger('avisos-de-atraso');

  constructor(
    @Inject(DATABASE) private readonly database: Database | null,
    private readonly flags: FlagService,
    private readonly mailer: Mailer,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async executarLote(porPagina = 100, scope: JobScope = {}, agora = new Date()): Promise<AvisoDaRotina[]> {
    if (!this.database) return [];
    const db = this.database.db;
    const instante = sql`${agora.toISOString()}::timestamptz`;
    const feitos: AvisoDaRotina[] = [];
    let depoisDe: string | null = null;
    for (;;) {
      const cursor: string | null = depoisDe;
      const pagina: EmAtraso[] = await withSystem(db, async (tx): Promise<EmAtraso[]> =>
        (
          await tx.execute<EmAtraso>(sql`
            select s.id, s.tenant_id, s.brand_id, b.name as marca, o.timezone,
                   f.id as invoice_id, f.due_date::text as due_date, f.amount_cents::text as amount_cents
              from liame.subscription s
              join liame.brand b on b.id = s.brand_id
              join liame.organization o on o.id = s.tenant_id
              cross join lateral (
                select i.id, i.due_date, i.amount_cents from liame.billing_invoice i
                 where i.subscription_id = s.id and i.kind = 'mensalidade' and i.status = 'aberta'
                   and i.due_date < (${instante} at time zone o.timezone)::date
                 order by i.due_date, i.created_at
                 limit 1) f
             where s.status in ('em_atraso', 'acoes_paradas', 'suspensa') ${tenantFilter(scope, sql`s.tenant_id`)}
               ${cursor ? sql`and s.id > ${cursor}::uuid` : sql``}
             order by s.id
             limit ${porPagina}`)
        ).rows,
      );
      for (const a of pagina) {
        try {
          feitos.push(await this.avisar(a, agora));
        } catch (err) {
          // Uma assinatura que falha não segura as outras; a próxima volta tenta de novo.
          this.logger.error(`aviso de atraso da assinatura ${a.id}: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
        }
      }
      if (pagina.length < porPagina) return feitos;
      depoisDe = pagina[pagina.length - 1]!.id;
    }
  }

  private async avisar(a: EmAtraso, agora: Date): Promise<AvisoDaRotina> {
    const base = { assinatura: a.id, tenantId: a.tenant_id };
    if (!(await this.flags.isEnabled(FLAG_COBRANCA, this.flags.context({ tenantId: a.tenant_id, brandId: a.brand_id })))) {
      return { ...base, aviso: null, enviados: 0, falhas: 0, resultado: 'desligada' };
    }
    const aviso = avisoDoDia(diasEntre(a.due_date, diaNoFuso(agora, a.timezone)));
    if (aviso === null) return { ...base, aviso: null, enviados: 0, falhas: 0, resultado: 'sem_aviso' };

    const db = this.database!.db;
    const instante = sql`${agora.toISOString()}::timestamptz`;
    // Quem paga (D-A7-15): o Dono e o Administrador com a cobrança liberada, com o e-mail confirmado e o acesso vivo.
    const pessoas = await withSystem(db, async (tx) =>
      (
        await tx.execute<{ user_id: string; email: string }>(sql`
          select u.id as user_id, u.email
            from liame.membership mb join liame.app_user u on u.id = mb.user_id
           where mb.tenant_id = ${a.tenant_id} and mb.revoked_at is null and (mb.expires_at is null or mb.expires_at > ${instante})
             and (mb.role_key = 'dono' or (mb.role_key = ${NIVEL_DA_COBRANCA_LIBERADA} and mb.billing_access))
             and u.disabled_at is null and u.email_verified_at is not null
           order by u.id`)
      ).rows,
    );
    const email = emailDoAviso({ aviso, marca: a.marca, vencimento: a.due_date, valorCents: a.amount_cents, link: `${this.config.appUrl}${CAMINHO_DA_COBRANCA}?marca=${a.brand_id}` });
    let enviados = 0;
    let falhas = 0;
    for (const p of pessoas) {
      // Reserva a entrega: a nova; a que falhou, até o limite; a reservada por uma volta que caiu no meio.
      const reservada = (
        await withSystem(db, (tx) =>
          tx.execute<{ id: string }>(sql`
            insert into liame.billing_notice (id, tenant_id, subscription_id, invoice_id, day, user_id, status, attempts, claimed_at)
            values (${uuidv7()}, ${a.tenant_id}, ${a.id}, ${a.invoice_id}, ${aviso}, ${p.user_id}, 'enviando', 1, ${instante})
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
        this.logger.warn(`aviso de atraso ${a.id} (dia ${aviso}): envio para ${maskEmail(p.email)} falhou (${err instanceof Error ? err.message : String(err)})`);
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
    return { ...base, aviso, enviados, falhas, resultado: 'avisada' };
  }
}
