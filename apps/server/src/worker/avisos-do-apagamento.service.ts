import { type Database, uuidv7, withSystem } from '@liame/database';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { NIVEL_DA_COBRANCA_LIBERADA } from '../auth/permissions.js';
import { FLAG_COBRANCA } from '../cobranca/assinatura.js';
import {
  type AvisoDoApagamento,
  apagamentoPeloAtraso,
  avisoDoApagamento,
  CAMINHO_DA_COBRANCA,
  emailDoAvisoDoApagamento,
  TENTATIVAS_DO_AVISO_DO_APAGAMENTO,
} from '../cobranca/aviso-do-apagamento.js';
import { decidirApagamento, situacaoDaMarca } from '../cobranca/fim-da-assinatura.js';
import { diaNoFuso, diasEntre } from '../cobranca/vida.js';
import { APP_CONFIG, type AppConfig } from '../config.js';
import { DATABASE } from '../database/database.module.js';
import { FlagService } from '../flags/flag.service.js';
import { Mailer, maskEmail } from '../mail/mailer.js';
import { APAGAR_EM, PENDENTE_NO_MEIO, VIVA } from './fim-da-assinatura.service.js';
import { type JobScope, tenantFilter } from './outbox-publisher.js';

/** A entrega reservada por uma volta que caiu no meio volta a ser tentada depois disto. */
const RETOMAR_DEPOIS = '15 minutes';

/** A marca com a última assinatura paga: a que terminou (com o dia gravado) ou a que segue em atraso. */
type Candidata = {
  tenant_id: string;
  brand_id: string;
  marca: string;
  timezone: string;
  subscription_id: string;
  status: string;
  purge_on: string | null;
  /** A mensalidade mais antiga em aberto e vencida (a assinatura em atraso). */
  vencimento: string | null;
};
type Outra = { viva: boolean; apagar_em: string | null; pendente: boolean };

export type AvisoDoApagamentoDaRotina = {
  assinatura: string;
  tenantId: string;
  brandId: string;
  /** O dia do apagamento de que o aviso fala, ou nulo (a assinatura em atraso sem a mensalidade vencida). */
  apagaEm: string | null;
  aviso: AvisoDoApagamento | null;
  enviados: number;
  falhas: number;
  resultado: 'avisada' | 'desligada' | 'sem_aviso' | 'esperar';
};

/**
 * O aviso do apagamento por e-mail (A7, W3, parte 4b; D-A7-106 e D-A7-107; Termos 11.2). Para cada marca cuja última
 * assinatura paga terminou com o dia do apagamento gravado (e sem assinatura viva), ou segue em atraso (o dia é o 60º de
 * atraso da mensalidade mais antiga em aberto, quando ela termina e os dados saem no mesmo dia), no calendário da empresa:
 * 7 dias antes e na véspera, o e-mail a quem paga (o Dono e o Administrador com a cobrança liberada), uma vez por
 * assinatura, dia, aviso e pessoa (`subscription_purge_notice`). O e-mail diz o que sai pela mesma regra do dia: só a
 * marca, quando outra segue viva; a empresa inteira, quando ela é a última. Quando a marca vai esperar outra (a empresa
 * sai inteira no dia da última), ela não manda: os avisos da última dizem o dia de verdade. A entrega é reservada antes do
 * envio, como no aviso do atraso. Passa por todas as marcas, em páginas (V106). Com a função `cobranca` desligada para a
 * marca, nada sai. O relógio vem de quem chama (V34).
 */
@Injectable()
export class AvisosDoApagamentoService {
  private readonly logger = new Logger('avisos-do-apagamento');

  constructor(
    @Inject(DATABASE) private readonly database: Database | null,
    private readonly flags: FlagService,
    private readonly mailer: Mailer,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async executarLote(porPagina = 100, scope: JobScope = {}, agora = new Date()): Promise<AvisoDoApagamentoDaRotina[]> {
    if (!this.database) return [];
    const db = this.database.db;
    const instante = sql`${agora.toISOString()}::timestamptz`;
    const feitos: AvisoDoApagamentoDaRotina[] = [];
    let depoisDe: string | null = null;
    for (;;) {
      const cursor: string | null = depoisDe;
      const pagina: Candidata[] = await withSystem(db, async (tx): Promise<Candidata[]> =>
        (
          await tx.execute<Candidata>(sql`
            select b.tenant_id, b.id as brand_id, b.name as marca, o.timezone, u.id as subscription_id, u.status,
                   u.purge_on::text as purge_on,
                   (select min(i.due_date)::text from liame.billing_invoice i
                     where i.subscription_id = u.id and i.kind = 'mensalidade' and i.status = 'aberta'
                       and i.due_date < (${instante} at time zone o.timezone)::date) as vencimento
              from liame.brand b
              join liame.organization o on o.id = b.tenant_id
              cross join lateral (
                select s.id, s.status, s.purge_on from liame.subscription s
                 where s.brand_id = b.id and s.first_paid_at is not null
                 order by s.first_paid_at desc
                 limit 1) u
             where b.archived_at is null and o.status = 'ativa' and o.legal_hold_at is null ${tenantFilter(scope, sql`b.tenant_id`)}
               and ((u.status = 'encerrada' and u.purge_on is not null and u.purge_on > (${instante} at time zone o.timezone)::date
                     and not ${VIVA(sql`b.id`)})
                    or u.status in ('em_atraso', 'acoes_paradas', 'suspensa'))
               ${cursor ? sql`and b.id > ${cursor}::uuid` : sql``}
             order by b.id
             limit ${porPagina}`)
        ).rows,
      );
      for (const c of pagina) {
        try {
          feitos.push(await this.avisar(c, agora));
        } catch (err) {
          // Uma marca que falha não segura as outras; a próxima volta tenta de novo.
          this.logger.error(`aviso do apagamento da marca ${c.brand_id}: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
        }
      }
      if (pagina.length < porPagina) return feitos;
      depoisDe = pagina[pagina.length - 1]!.brand_id;
    }
  }

  private async avisar(c: Candidata, agora: Date): Promise<AvisoDoApagamentoDaRotina> {
    const terminou = c.status === 'encerrada';
    const apagaEm = terminou ? c.purge_on : c.vencimento ? apagamentoPeloAtraso(c.vencimento) : null;
    const base = { assinatura: c.subscription_id, tenantId: c.tenant_id, brandId: c.brand_id, apagaEm };
    if (!(await this.flags.isEnabled(FLAG_COBRANCA, this.flags.context({ tenantId: c.tenant_id, brandId: c.brand_id })))) {
      return { ...base, aviso: null, enviados: 0, falhas: 0, resultado: 'desligada' };
    }
    const aviso = apagaEm ? avisoDoApagamento(diasEntre(diaNoFuso(agora, c.timezone), apagaEm)) : null;
    if (!apagaEm || aviso === null) return { ...base, aviso: null, enviados: 0, falhas: 0, resultado: 'sem_aviso' };

    const db = this.database!.db;
    // O que sai, pela regra do dia (as outras marcas da empresa como estarão no dia do apagamento).
    const outras = await withSystem(db, async (tx) =>
      (
        await tx.execute<Outra>(sql`
          select ${VIVA(sql`b.id`)} as viva, ${APAGAR_EM(sql`b.id`)}::text as apagar_em, ${PENDENTE_NO_MEIO(sql`b.id`)} as pendente
            from liame.brand b
           where b.tenant_id = ${c.tenant_id} and b.archived_at is null and b.id <> ${c.brand_id}`)
      ).rows,
    );
    const decisao = decidirApagamento(outras.map((o) => situacaoDaMarca({ viva: o.viva, apagarEm: o.apagar_em, pendenteNoMeio: o.pendente }, apagaEm)));
    if (decisao === 'esperar') return { ...base, aviso, enviados: 0, falhas: 0, resultado: 'esperar' };

    const instante = sql`${agora.toISOString()}::timestamptz`;
    // Quem paga (D-A7-15): o Dono e o Administrador com a cobrança liberada, com o e-mail confirmado e o acesso vivo.
    const pessoas = await withSystem(db, async (tx) =>
      (
        await tx.execute<{ user_id: string; email: string }>(sql`
          select u.id as user_id, u.email
            from liame.membership mb join liame.app_user u on u.id = mb.user_id
           where mb.tenant_id = ${c.tenant_id} and mb.revoked_at is null and (mb.expires_at is null or mb.expires_at > ${instante})
             and (mb.role_key = 'dono' or (mb.role_key = ${NIVEL_DA_COBRANCA_LIBERADA} and mb.billing_access))
             and u.disabled_at is null and u.email_verified_at is not null
           order by u.id`)
      ).rows,
    );
    const email = emailDoAvisoDoApagamento({
      aviso,
      marca: c.marca,
      apagaEm,
      alcance: decisao,
      motivo: terminou ? 'terminou' : 'atraso',
      link: `${this.config.appUrl}${CAMINHO_DA_COBRANCA}?marca=${c.brand_id}`,
    });
    let enviados = 0;
    let falhas = 0;
    for (const p of pessoas) {
      // Reserva a entrega: a nova; a que falhou, até o limite; a reservada por uma volta que caiu no meio.
      const reservada = (
        await withSystem(db, (tx) =>
          tx.execute<{ id: string }>(sql`
            insert into liame.subscription_purge_notice (id, tenant_id, subscription_id, purge_on, day, user_id, status, attempts, claimed_at)
            values (${uuidv7()}, ${c.tenant_id}, ${c.subscription_id}, ${apagaEm}::date, ${aviso}, ${p.user_id}, 'enviando', 1, ${instante})
            on conflict (subscription_id, purge_on, day, user_id) do update
               set status = 'enviando', attempts = liame.subscription_purge_notice.attempts + 1, claimed_at = excluded.claimed_at, error = null, updated_at = now()
             where (liame.subscription_purge_notice.status = 'falhou' and liame.subscription_purge_notice.attempts < ${TENTATIVAS_DO_AVISO_DO_APAGAMENTO})
                or (liame.subscription_purge_notice.status = 'enviando' and liame.subscription_purge_notice.claimed_at < ${instante} - ${RETOMAR_DEPOIS}::interval
                    and liame.subscription_purge_notice.attempts < ${TENTATIVAS_DO_AVISO_DO_APAGAMENTO})
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
        this.logger.warn(`aviso do apagamento ${c.subscription_id} (${aviso} dia(s) antes): envio para ${maskEmail(p.email)} falhou (${err instanceof Error ? err.message : String(err)})`);
      }
      await withSystem(db, (tx) =>
        tx.execute(sql`
          update liame.subscription_purge_notice
             set status = ${falha ? 'falhou' : 'enviado'}, error = ${falha}, sent_at = ${falha ? null : agora.toISOString()}::timestamptz, updated_at = now()
           where id = ${reservada.id}`),
      );
      if (falha) falhas += 1;
      else enviados += 1;
    }
    return { ...base, aviso, enviados, falhas, resultado: 'avisada' };
  }
}
