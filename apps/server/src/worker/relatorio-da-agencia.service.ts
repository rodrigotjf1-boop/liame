import { type Database, type Tx, uuidv7, withSystem } from '@liame/database';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { type SQL, sql } from 'drizzle-orm';
import { mandarOsEmails, type MarcaNoEnvio, type PessoaQueRecebe } from '../agencia/emails-do-relatorio.js';
import { gravarEntrega } from '../agencia/relatorios.service.js';
import { activeTraceId, writeAudit } from '../audit/audit.js';
import { pessoaPode } from '../auth/pessoa-pode.js';
import { FLAG_COBRANCA } from '../cobranca/assinatura.js';
import { APP_CONFIG, type AppConfig } from '../config.js';
import { DATABASE } from '../database/database.module.js';
import { FlagService } from '../flags/flag.service.js';
import { Mailer, maskEmail } from '../mail/mailer.js';
import { type ConteudoDoRelatorio, mesCurto } from '../results/relatorio-mensal.js';
import { type JobScope, tenantFilter } from './outbox-publisher.js';

// O relatório da agência sem a agência por perto (A7, W7, parte 4b; D-A7-67; D-A7-83), numa rotina do worker (escopo de
// sistema): no dia 2, às 9h no fuso da loja, a agência que escolheu "sai sozinho" manda o relatório do mês a todos que
// podem receber, sem comentário; no dia 3, às 8h, o time da agência que revisa e ainda não mandou recebe um lembrete
// (uma hora antes de o e-mail do próprio Liame sair, D-A7-68). Os dois só até o dia 7 (depois, o relatório já não é
// notícia, D-A3-20), só com a função `parceiros` ligada na empresa e nunca com a marca suspensa (o relatório fica só com
// o Dono). Cada relatório e agência, uma vez: o envio pela versão 1 (única) e o lembrete pela linha dele.

const NIVEIS_QUE_RECEBEM = ['dono', 'administrador', 'so_relatorios'] as const;
const HORA_DO_ENVIO_SOZINHO = 9;
const HORA_DO_LEMBRETE = 8;
/** O relatório deixa de ser notícia depois do dia 7 do mês seguinte (o mesmo prazo do e-mail do Liame). */
const ULTIMO_DIA = 7;

type Candidato = {
  report_id: string;
  tenant_id: string;
  brand_id: string;
  link_id: string;
  agency_id: string;
  month_from: string;
  month_to: string;
  marca: string;
  empresa: string;
};

export type VezDaAgencia = { reportId: string; agencyId: string; status: 'mandado' | 'lembrado' | 'pulado' | 'falhou'; pessoas: number };

/** "A partir do dia N do mês seguinte, às H horas, no fuso da loja, até o fim do dia 7." */
function naJanela(ref: SQL, dia: number, hora: number): SQL {
  return sql`${ref} >= (((m.month_to + ${dia}::int) + make_interval(hours => ${hora}::int)) at time zone m.timezone)
    and ${ref} < ((m.month_to + ${ULTIMO_DIA + 1}::int)::timestamp at time zone m.timezone)`;
}

@Injectable()
export class RelatorioDaAgenciaRotina {
  private readonly logger = new Logger('relatorio-da-agencia');

  constructor(
    @Inject(DATABASE) private readonly database: Database | null,
    private readonly flags: FlagService,
    private readonly mailer: Mailer,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  // ------------------------------------------------------------------ o envio sozinho do dia 2

  async enviarSozinhosLote(limite = 20, scope: JobScope = {}, agora = new Date()): Promise<VezDaAgencia[]> {
    if (!this.database) return [];
    const db = this.database.db;
    const ref = sql`${agora.toISOString()}::timestamptz`;
    const candidatos = await withSystem(db, (tx) =>
      tx.execute<Candidato>(sql`
        select m.id as report_id, m.tenant_id, m.brand_id, l.id as link_id, l.partner_org_id as agency_id,
               m.month_from::text as month_from, m.month_to::text as month_to, b.name as marca, o.name as empresa
          from liame.monthly_report m
          join liame.brand b on b.id = m.brand_id and b.archived_at is null
          join liame.organization o on o.id = m.tenant_id
          join liame.partner_link l on l.client_org_id = m.tenant_id and l.status = 'ativo'
          join liame.agency_brand ab on ab.tenant_id = l.partner_org_id and ab.report_mode = 'sozinho'
         where ${naJanela(ref, 2, HORA_DO_ENVIO_SOZINHO)}
           and not exists (select 1 from liame.agency_report_send s where s.report_id = m.id and s.agency_id = l.partner_org_id)
           ${tenantFilter(scope, sql`m.tenant_id`)}
         order by m.generated_at, m.id, l.id
         limit ${limite}`),
    );
    const vezes: VezDaAgencia[] = [];
    for (const c of candidatos.rows) {
      try {
        vezes.push(await this.enviarSozinho(c, agora));
      } catch (err) {
        this.logger.error(`relatório ${c.report_id} da agência ${c.agency_id}: ${err instanceof Error ? err.message : String(err)}`);
        vezes.push({ reportId: c.report_id, agencyId: c.agency_id, status: 'falhou', pessoas: 0 });
      }
    }
    return vezes;
  }

  private async enviarSozinho(c: Candidato, agora: Date): Promise<VezDaAgencia> {
    const db = this.database!.db;
    const pulado: VezDaAgencia = { reportId: c.report_id, agencyId: c.agency_id, status: 'pulado', pessoas: 0 };
    if (!(await this.pode(c))) return pulado;
    const gravado = await withSystem(db, async (tx) => {
      const para = await quemPodeReceber(tx, c.tenant_id);
      const agencia = await marcaDaAgencia(tx, c.agency_id);
      const conteudo = await tx.execute<{ content: ConteudoDoRelatorio }>(sql`select content from liame.monthly_report where id = ${c.report_id}`);
      if (!para.length || !conteudo.rows[0]) return null;
      const id = uuidv7();
      // A versão 1 é única por relatório e agência: se a agência mandou pela tela no meio do caminho, nada sai.
      const r = await tx.execute(sql`
        insert into liame.agency_report_send
          (id, tenant_id, agency_id, partner_link_id, report_id, version, mode, recipients, with_logo)
        values (${id}, ${c.tenant_id}, ${c.agency_id}, ${c.link_id}, ${c.report_id}, 1, 'sozinho', ${para.length}, ${agencia.logo})
        on conflict (report_id, agency_id, version) do nothing
        returning id`);
      if (!r.rows.length) return null;
      await tx.execute(sql`
        insert into liame.agency_report_delivery (id, tenant_id, send_id, user_id, role_key)
        values ${sql.join(
          para.map((p) => sql`(${uuidv7()}, ${c.tenant_id}, ${id}, ${p.id}, ${p.role_key})`),
          sql`, `,
        )}`);
      await writeAudit(tx, {
        tenantId: c.agency_id,
        actorType: 'system',
        actorId: null,
        actorLabel: 'envio sozinho do dia 2',
        action: 'agencia.relatorio_sozinho',
        resourceType: 'agency_report_send',
        resourceId: id,
        after: { client_id: c.tenant_id, report_id: c.report_id, version: 1, recipients: para.length },
        traceId: activeTraceId(),
        origin: 'worker',
      });
      return { id, para, agencia, conteudo: conteudo.rows[0].content };
    });
    if (!gravado) return pulado;
    const falhas = await mandarOsEmails(
      { mailer: this.mailer, config: this.config, logger: this.logger },
      { id: gravado.id, versao: 1, comentario: null, assinatura: null, conteudo: gravado.conteudo, marca: c.marca, empresa: c.empresa, brandId: c.brand_id },
      gravado.agencia,
      gravado.para,
      (userId, falha) => withSystem(db, (tx) => gravarEntrega(tx, gravado.id, userId, falha, agora)),
    );
    this.logger.log(`relatório ${c.report_id}: a agência ${c.agency_id} mandou sozinha a ${gravado.para.length - falhas} pessoa(s)`);
    return { reportId: c.report_id, agencyId: c.agency_id, status: 'mandado', pessoas: gravado.para.length - falhas };
  }

  // ------------------------------------------------------------------ o lembrete do dia 3

  async lembretesLote(limite = 20, scope: JobScope = {}, agora = new Date()): Promise<VezDaAgencia[]> {
    if (!this.database) return [];
    const db = this.database.db;
    const ref = sql`${agora.toISOString()}::timestamptz`;
    const candidatos = await withSystem(db, (tx) =>
      tx.execute<Candidato>(sql`
        select m.id as report_id, m.tenant_id, m.brand_id, l.id as link_id, l.partner_org_id as agency_id,
               m.month_from::text as month_from, m.month_to::text as month_to, b.name as marca, o.name as empresa
          from liame.monthly_report m
          join liame.brand b on b.id = m.brand_id and b.archived_at is null
          join liame.organization o on o.id = m.tenant_id
          join liame.partner_link l on l.client_org_id = m.tenant_id and l.status = 'ativo'
          left join liame.agency_brand ab on ab.tenant_id = l.partner_org_id
         where coalesce(ab.report_mode, 'revisar') = 'revisar'
           and ${naJanela(ref, 3, HORA_DO_LEMBRETE)}
           and not exists (select 1 from liame.agency_report_send s where s.report_id = m.id and s.agency_id = l.partner_org_id)
           and not exists (select 1 from liame.agency_report_reminder r where r.report_id = m.id and r.agency_id = l.partner_org_id)
           ${tenantFilter(scope, sql`m.tenant_id`)}
         order by m.generated_at, m.id, l.id
         limit ${limite}`),
    );
    const vezes: VezDaAgencia[] = [];
    for (const c of candidatos.rows) {
      try {
        vezes.push(await this.lembrar(c));
      } catch (err) {
        this.logger.error(`lembrete do relatório ${c.report_id} à agência ${c.agency_id}: ${err instanceof Error ? err.message : String(err)}`);
        vezes.push({ reportId: c.report_id, agencyId: c.agency_id, status: 'falhou', pessoas: 0 });
      }
    }
    return vezes;
  }

  private async lembrar(c: Candidato): Promise<VezDaAgencia> {
    const db = this.database!.db;
    if (!(await this.pode(c))) return { reportId: c.report_id, agencyId: c.agency_id, status: 'pulado', pessoas: 0 };
    const reservado = await withSystem(db, async (tx) => {
      const id = uuidv7();
      const r = await tx.execute(sql`
        insert into liame.agency_report_reminder (id, tenant_id, agency_id, report_id)
        values (${id}, ${c.tenant_id}, ${c.agency_id}, ${c.report_id})
        on conflict (report_id, agency_id) do nothing
        returning id`);
      if (!r.rows.length) return null;
      // Quem do time da agência está no cliente com um nível que vê os resultados (quem pode mandar).
      const time = await tx.execute<{ id: string; email: string }>(sql`
        select u.id, u.email
          from liame.membership m join liame.app_user u on u.id = m.user_id
         where m.partner_link_id = ${c.link_id} and m.tenant_id = ${c.tenant_id}
           and m.revoked_at is null and (m.expires_at is null or m.expires_at > now())
           and u.disabled_at is null and u.email_verified_at is not null
         order by u.id`);
      const quem: Array<{ id: string; email: string }> = [];
      for (const p of time.rows) if (await pessoaPode(tx, { tenantId: c.tenant_id, userId: p.id, permissao: 'vendas.ver' })) quem.push(p);
      const agencia = await marcaDaAgencia(tx, c.agency_id);
      return { id, quem, agencia: agencia.name };
    });
    if (!reservado) return { reportId: c.report_id, agencyId: c.agency_id, status: 'pulado', pessoas: 0 };
    const mes = mesCurto({ from: c.month_from, to: c.month_to });
    // A frase do e-mail do Liame só quando ele está ligado para a empresa (`relatorio_email`, D-A3-20).
    const liameManda = await this.flags.isEnabled('relatorio_email', this.flags.context({ tenantId: c.tenant_id, brandId: c.brand_id }));
    const fim = liameManda
      ? 'O e-mail do próprio Liame com o relatório sai hoje, às 9h, para quem ainda não recebeu o da agência. Depois disso, você ainda pode mandar o da agência.'
      : 'Até o dia 7, o relatório ainda é do mês que passou.';
    let enviados = 0;
    for (const p of reservado.quem) {
      try {
        await this.mailer.send({
          to: p.email,
          subject: `Liame: o relatório de ${mes} da ${c.marca} espera você`,
          text:
            `O relatório de ${mes} da ${c.marca} (${c.empresa}) está pronto desde o dia 1º e ainda não foi mandado ao cliente.\n\n` +
            `Para revisar, escrever o seu comentário e mandar, abra Relatórios, na conta da ${reservado.agencia} no Liame:\n` +
            `${this.config.appUrl}/agencia/relatorios\n\n${fim}`,
        });
        enviados += 1;
      } catch (err) {
        this.logger.warn(`lembrete do relatório ${c.report_id}: envio para ${maskEmail(p.email)} falhou (${err instanceof Error ? err.message : String(err)})`);
      }
    }
    await withSystem(db, (tx) => tx.execute(sql`update liame.agency_report_reminder set recipients = ${enviados} where id = ${reservado.id}`));
    return { reportId: c.report_id, agencyId: c.agency_id, status: 'lembrado', pessoas: enviados };
  }

  // ------------------------------------------------------------------ as condições

  /** A função `parceiros` ligada na empresa e a marca do relatório sem a conta suspensa. */
  private async pode(c: Candidato): Promise<boolean> {
    if (!(await this.flags.isEnabled('parceiros', this.flags.context({ tenantId: c.tenant_id, brandId: c.brand_id })))) return false;
    const suspensa = await withSystem(this.database!.db, (tx) =>
      tx.execute(sql`select 1 from liame.subscription where brand_id = ${c.brand_id} and status = 'suspensa'`),
    );
    if (!suspensa.rows.length) return true;
    // Suspensa, mas a cobrança desligada na marca: a suspensão não trava ninguém (D-A7-40).
    return !(await this.flags.isEnabled(FLAG_COBRANCA, this.flags.context({ tenantId: c.tenant_id, brandId: c.brand_id })));
  }
}

/** Quem da empresa pode receber o relatório (D-A7-66), sem ninguém de agência. */
async function quemPodeReceber(tx: Tx, tenantId: string): Promise<PessoaQueRecebe[]> {
  const r = await tx.execute<PessoaQueRecebe>(sql`
    select u.id, u.name, u.email, m.role_key
      from liame.membership m join liame.app_user u on u.id = m.user_id
     where m.tenant_id = ${tenantId} and m.revoked_at is null and (m.expires_at is null or m.expires_at > now())
       and m.partner_link_id is null
       and m.role_key in (${sql.join(NIVEIS_QUE_RECEBEM.map((n) => sql`${n}`), sql`, `)})
       and u.disabled_at is null and u.email_verified_at is not null
     order by (m.role_key = 'dono') desc, u.name, u.id`);
  return r.rows;
}

async function marcaDaAgencia(tx: Tx, agencyId: string): Promise<MarcaNoEnvio> {
  const r = await tx.execute<Omit<MarcaNoEnvio, 'agencyId'>>(sql`
    select o.name, b.logo_id is not null as logo, b.logo_width, b.logo_height, b.reply_to_email as reply_to
      from liame.organization o left join liame.agency_brand b on b.tenant_id = o.id
     where o.id = ${agencyId}`);
  return { agencyId, ...r.rows[0]! };
}
