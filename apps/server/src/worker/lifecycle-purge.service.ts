import { type Database, type Tx, uuidv7, withSystem } from '@liame/database';
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { type SQL, sql } from 'drizzle-orm';
import { canonicalJson, sha256, writeAudit } from '../audit/audit.js';
import { DATABASE } from '../database/database.module.js';
import { prefixoDaEmpresa, prefixoDaMarca } from '../fotos/conferencia.js';
import { ARMAZEM_DE_IMAGENS, type ArmazemDeImagens, ArmazemFechado } from '../imagens/armazem.js';
import { Mailer, type MailMessage } from '../mail/mailer.js';
import { VaultService } from '../vault/vault.service.js';

/** Lote de apagamento: transações curtas, sem travar as tabelas quentes. */
const BATCH = 5_000;

/**
 * A execução de sincronização "rodando" há mais que isto parou no meio (o processo caiu ou foi implantado de novo):
 * nenhuma leitura dura tanto, e a mais longa (a carga inicial das vendas) leva minutos.
 */
export const EXECUCAO_INTERROMPIDA_HORAS = 6;
export const MOTIVO_EXECUCAO_INTERROMPIDA = 'interrompida: o processo parou antes do fim da leitura';

/** Escopo explícito para testes num banco compartilhado (LIC-083). */
export interface PurgeScope {
  tenantIds?: string[];
  userIds?: string[];
}

export interface PurgeCertificate {
  id: string;
  tenantId: string;
  organizationName: string;
  summary: Record<string, number>;
  hash: string;
}

const noHold = (alias: string) => sql.raw(`not exists (select 1 from liame.organization o where o.id = ${alias}.tenant_id and o.legal_hold_at is not null)`);

function inList(column: SQL, ids: string[] | undefined): SQL {
  if (!ids) return sql``;
  return ids.length ? sql`and ${column} in ${ids}` : sql`and false`;
}

/**
 * Expurgo (ADR-014): prazos por classe de dado, marcas arquivadas e fim de contrato com
 * crypto-shredding e certificado. Grava na auditoria o que apagou (classe e contagem, sem conteúdo).
 * `legal_hold` na empresa suspende tudo o que é dela.
 */
@Injectable()
export class LifecyclePurgeService {
  private readonly logger = new Logger('expurgo');

  /** As imagens das marcas e empresas expurgadas (ADR-021); sem ele, a marca ou a empresa com fotos não sai. */
  private readonly armazem: ArmazemDeImagens;

  constructor(
    @Inject(DATABASE) private readonly database: Database | null,
    private readonly vault: VaultService,
    private readonly mailer: Mailer,
    @Optional() @Inject(ARMAZEM_DE_IMAGENS) armazem?: ArmazemDeImagens,
  ) {
    this.armazem = armazem ?? new ArmazemFechado();
  }

  private get db() {
    if (!this.database) throw new Error('expurgo: sem banco');
    return this.database.db;
  }

  async runDaily(scope: PurgeScope = {}): Promise<{ retention: Record<string, number>; brands: number; tenants: PurgeCertificate[]; interrompidas: number }> {
    const interrompidas = await this.fecharExecucoesInterrompidas(scope);
    const retention = await this.purgeRetention(scope);
    const brands = await this.purgeArchivedBrands(scope);
    const tenants = await this.purgeTenants(scope);
    this.logger.log(`expurgo: ${JSON.stringify(retention)}; ${brands} marca(s); ${tenants.length} empresa(s); ${interrompidas} leitura(s) interrompida(s) fechada(s)`);
    return { retention, brands, tenants, interrompidas };
  }

  /**
   * A execução de sincronização que ficou "rodando" (o processo parou no meio) vira "falhou", com o motivo e a hora em
   * que foi fechada. Sem isso ela nunca sairia: o prazo de 90 dias das execuções deixa as "rodando" de fora. O relógio
   * vem de quem chama (V34): o limite e a hora gravada saem do mesmo instante.
   */
  async fecharExecucoesInterrompidas(scope: PurgeScope = {}, agora = new Date()): Promise<number> {
    const limite = new Date(agora.getTime() - EXECUCAO_INTERROMPIDA_HORAS * 3_600_000);
    const r = await withSystem(this.db, (tx) =>
      tx.execute<{ id: string }>(sql`
        update liame.sync_run
           set status = 'falhou', finished_at = ${agora.toISOString()}::timestamptz, error = coalesce(error, ${MOTIVO_EXECUCAO_INTERROMPIDA})
         where status = 'rodando' and started_at < ${limite.toISOString()}::timestamptz ${inList(sql`tenant_id`, scope.tenantIds)}
         returning id`),
    );
    return r.rows.length;
  }

  /** Prazos automáticos por classe (lifecycle/data-classes.ts). */
  async purgeRetention(scope: PurgeScope = {}): Promise<Record<string, number>> {
    const t = (column: string) => inList(sql.raw(column), scope.tenantIds);
    const u = (column: string) => inList(sql.raw(column), scope.userIds);
    const byTenant = new Map<string, Record<string, number>>();
    const global: Record<string, number> = {};
    const totals: Record<string, number> = {};

    const run = async (name: string, statement: SQL, tenantScoped: boolean) => {
      let total = 0;
      for (;;) {
        const r = await withSystem(this.db, (tx) => tx.execute<{ tenant_id: string | null }>(statement));
        for (const row of r.rows) {
          if (tenantScoped && row.tenant_id) {
            const counts = byTenant.get(row.tenant_id) ?? {};
            counts[name] = (counts[name] ?? 0) + 1;
            byTenant.set(row.tenant_id, counts);
          } else {
            global[name] = (global[name] ?? 0) + 1;
          }
        }
        total += r.rows.length;
        if (r.rows.length < BATCH) break;
      }
      totals[name] = total;
    };

    await run(
      'outbox',
      sql`delete from liame.outbox_event where id in (
            select id from liame.outbox_event e where published_at < now() - interval '30 days' and ${noHold('e')} ${t('e.tenant_id')} limit ${BATCH})
          returning tenant_id`,
      true,
    );
    await run(
      'inbox',
      sql`delete from liame.inbox_event where id in (
            select id from liame.inbox_event e where received_at < now() - interval '90 days' and ${noHold('e')} ${t('e.tenant_id')} limit ${BATCH})
          returning tenant_id`,
      true,
    );
    await run(
      'payload_bruto',
      sql`delete from liame.raw_payload where id in (
            select id from liame.raw_payload e where fetched_at < now() - interval '30 days' and ${noHold('e')} ${t('e.tenant_id')} limit ${BATCH})
          returning tenant_id`,
      true,
    );
    await run(
      'execucao_sync',
      sql`delete from liame.sync_run where id in (
            select id from liame.sync_run e where e.status <> 'rodando' and coalesce(e.finished_at, e.started_at) < now() - interval '90 days'
               and ${noHold('e')} ${t('e.tenant_id')} limit ${BATCH})
          returning tenant_id`,
      true,
    );
    await run(
      'comparacao_credencial',
      sql`delete from liame.credential_comparison where id in (
            select id from liame.credential_comparison e where e.compared_at < now() - interval '90 days' and ${noHold('e')} ${t('e.tenant_id')} limit ${BATCH})
          returning tenant_id`,
      true,
    );
    await run(
      'conexao_oauth',
      sql`delete from liame.oauth_connection where id in (
            select id from liame.oauth_connection e where e.status in ('expirada', 'erro', 'revogada') and e.updated_at < now() - interval '90 days'
               and ${noHold('e')} ${t('e.tenant_id')} limit ${BATCH})
          returning tenant_id`,
      true,
    );
    await run(
      'toque',
      sql`delete from liame.touchpoint where id in (
            select id from liame.touchpoint e where e.occurred_at < now() - interval '90 days' and ${noHold('e')} ${t('e.tenant_id')} limit ${BATCH})
          returning tenant_id`,
      true,
    );
    // A avaliação do Perfil no Google: 12 meses contados da última mudança dela lá (D-A6-5). O texto é de terceiro.
    await run(
      'avaliacao',
      sql`delete from liame.profile_review where id in (
            select id from liame.profile_review e where e.changed_at < now() - interval '365 days' and ${noHold('e')} ${t('e.tenant_id')} limit ${BATCH})
          returning tenant_id`,
      true,
    );
    // As buscas da semana do Search Console (A6, Z3): 12 meses contados do começo da semana. O texto é o que as
    // pessoas digitaram no Google. A chave é composta (site, semana, busca): a linha sai pela chave inteira.
    await run(
      'busca',
      sql`delete from liame.search_console_query_week q using (
            select e.connected_account_id, e.week_start, e.query from liame.search_console_query_week e
             where e.week_start < (now() - interval '365 days')::date and ${noHold('e')} ${t('e.tenant_id')} limit ${BATCH}) v
           where q.connected_account_id = v.connected_account_id and q.week_start = v.week_start and q.query = v.query
          returning q.tenant_id`,
      true,
    );
    await run(
      'execucao_atribuicao',
      sql`delete from liame.attribution_run where id in (
            select id from liame.attribution_run e where coalesce(e.finished_at, e.started_at) < now() - interval '90 days'
               and ${noHold('e')} ${t('e.tenant_id')} limit ${BATCH})
          returning tenant_id`,
      true,
    );
    await run(
      'conteudo_ia',
      sql`delete from liame.ai_exchange where usage_id in (
            select usage_id from liame.ai_exchange e where e.created_at < now() - interval '30 days' and ${noHold('e')} ${t('e.tenant_id')} limit ${BATCH})
          returning tenant_id`,
      true,
    );
    // Conversa com a LIA (D-A3-4): a conversa parada há 30 dias sai inteira; na que segue, saem as mensagens de
    // mais de 30 dias. A demanda que saiu dela fica (a referência vira nula).
    await run(
      'conversa',
      sql`delete from liame.conversation where id in (
            select id from liame.conversation e where e.last_message_at < now() - interval '30 days' and ${noHold('e')} ${t('e.tenant_id')} limit ${BATCH})
          returning tenant_id`,
      true,
    );
    await run(
      'conversa_mensagem',
      sql`delete from liame.conversation_message where id in (
            select id from liame.conversation_message e where e.created_at < now() - interval '30 days' and ${noHold('e')} ${t('e.tenant_id')} limit ${BATCH})
          returning tenant_id`,
      true,
    );
    await run(
      'idempotencia',
      sql`delete from liame.idempotency_key where ctid in (
            select ctid from liame.idempotency_key e where expires_at < now() ${t('e.tenant_id')} ${u('e.user_id')} limit ${BATCH})
          returning tenant_id`,
      true,
    );
    await run(
      'token',
      sql`delete from liame.user_token where id in (
            select id from liame.user_token e where expires_at < now() - interval '30 days' ${u('e.user_id')} limit ${BATCH})
          returning null::uuid as tenant_id`,
      false,
    );
    await run(
      'sessao',
      sql`delete from liame.session where id in (
            select id from liame.session e where coalesce(e.revoked_at, e.expires_at) < now() - interval '180 days' ${u('e.user_id')} limit ${BATCH})
          returning null::uuid as tenant_id`,
      false,
    );
    if (!scope.tenantIds && !scope.userIds) {
      await run(
        'limite',
        sql`delete from liame.rate_limit where ctid in (select ctid from liame.rate_limit where window_start < now() - interval '1 day' limit ${BATCH})
            returning null::uuid as tenant_id`,
        false,
      );
    }

    await withSystem(this.db, async (tx) => {
      for (const [tenantId, counts] of byTenant) await this.auditPurge(tx, tenantId, counts);
      if (Object.values(global).some((n) => n > 0)) await this.auditPurge(tx, null, global);
    });
    return totals;
  }

  /**
   * Marca arquivada há mais de 12 meses (ADR-014). As fotos dela saem do armazenamento antes (ADR-021, item 6): a marca
   * cujas fotos o armazenamento não apagou fica para o dia seguinte, com as linhas, e as outras seguem.
   */
  async purgeArchivedBrands(scope: PurgeScope = {}): Promise<number> {
    const comFotos = await withSystem(this.db, (tx) =>
      tx.execute<{ id: string; tenant_id: string }>(sql`
        select b.id, b.tenant_id from liame.brand b
         where archived_at is not null and purge_after <= now() and ${noHold('b')} ${inList(sql`b.tenant_id`, scope.tenantIds)}
           and exists (select 1 from liame.brand_photo p where p.brand_id = b.id)`),
    );
    const presas: string[] = [];
    for (const m of comFotos.rows) {
      try {
        await this.armazem.apagarPrefixo(prefixoDaMarca(m.tenant_id, m.id));
      } catch (err) {
        presas.push(m.id);
        this.logger.warn(`expurgo da marca ${m.id}: o armazenamento não apagou as fotos; fica para amanhã (${err instanceof Error ? err.message : String(err)})`);
      }
    }
    return withSystem(this.db, async (tx) => {
      const r = await tx.execute<{ tenant_id: string }>(sql`
        delete from liame.brand b
         where archived_at is not null and purge_after <= now() and ${noHold('b')} ${inList(sql`b.tenant_id`, scope.tenantIds)}
           ${presas.length ? sql`and b.id not in ${presas}` : sql``}
         returning tenant_id`);
      const counts = new Map<string, number>();
      for (const row of r.rows) counts.set(row.tenant_id, (counts.get(row.tenant_id) ?? 0) + 1);
      for (const [tenantId, n] of counts) await this.auditPurge(tx, tenantId, { marca_arquivada: n });
      return r.rows.length;
    });
  }

  /** Empresas no fim da graça, sem `legal_hold`. */
  async purgeTenants(scope: PurgeScope = {}): Promise<PurgeCertificate[]> {
    const due = await withSystem(this.db, (tx) =>
      tx.execute<{ id: string }>(sql`
        select id from liame.organization
         where status = 'suspensa' and purge_after <= now() and legal_hold_at is null ${inList(sql`id`, scope.tenantIds)}`),
    );
    const out: PurgeCertificate[] = [];
    for (const { id } of due.rows) {
      try {
        out.push(await this.purgeTenant(id));
      } catch (err) {
        this.logger.error(`expurgo da empresa ${id} falhou: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return out;
  }

  /**
   * Expurgo da empresa inteira: destrói a chave dela no KMS (o que restar em backup fica ilegível),
   * apaga tudo o que é dela (cascata), guarda o certificado e o manda para o dono. A auditoria fica
   * (5 anos, revisar com o jurídico) e a cadeia termina com o evento do expurgo.
   */
  async purgeTenant(tenantId: string): Promise<PurgeCertificate> {
    const before = await withSystem(this.db, async (tx) => {
      const org = await tx.execute<{ name: string; cnpj: string | null; purge_reason: string | null; legal_hold_at: string | null }>(sql`
        select name, cnpj, purge_reason, legal_hold_at from liame.organization where id = ${tenantId} for update`);
      const o = org.rows[0];
      if (!o) throw new Error('empresa não existe');
      if (o.legal_hold_at) throw new Error('empresa com legal_hold');
      const owners = await tx.execute<{ email: string }>(sql`
        select u.email from liame.membership m join liame.app_user u on u.id = m.user_id
         where m.tenant_id = ${tenantId} and m.role_key = 'dono' and m.revoked_at is null`);
      const count = async (table: string) =>
        Number((await tx.execute<{ n: string }>(sql`select count(*)::text as n from ${sql.raw(`liame.${table}`)} where tenant_id = ${tenantId}`)).rows[0]?.n ?? 0);
      const summary: Record<string, number> = {};
      for (const table of ['brand', 'membership', 'invitation', 'policy', 'action_request', 'webhook_endpoint', 'budget_ledger_entry', 'secret', 'outbox_event']) {
        summary[table] = await count(table);
      }
      return { org: o, owners: owners.rows.map((x) => x.email), summary };
    });

    // Antes de tudo, as imagens da empresa (ADR-021, item 6): elas não são cifradas pela chave dela. Se o armazenamento
    // falhar, nada mais acontece hoje, e o expurgo tenta de novo amanhã.
    const temFotos = await withSystem(this.db, (tx) => tx.execute(sql`select 1 from liame.brand_photo where tenant_id = ${tenantId} limit 1`));
    if (temFotos.rows[0]) await this.armazem.apagarPrefixo(prefixoDaEmpresa(tenantId));

    // Primeiro a chave: se algo falhar depois, o dado pessoal já está ilegível (crypto-shredding).
    await this.vault.destroyTenantKey(tenantId);

    const purgedAt = new Date().toISOString();
    const certificate = await withSystem(this.db, async (tx) => {
      await tx.execute(sql`delete from liame.feature_flag_rule where scope_type = 'tenant' and scope_id = ${tenantId}`);
      await tx.execute(sql`delete from liame.organization where id = ${tenantId}`);
      const id = uuidv7();
      const hash = sha256(canonicalJson({ id, tenant_id: tenantId, name: before.org.name, cnpj: before.org.cnpj, purged_at: purgedAt, summary: before.summary }));
      await tx.execute(sql`
        insert into liame.purge_certificate (id, purged_tenant_id, organization_name, cnpj, reason, summary, certificate_hash, purged_at)
        values (${id}, ${tenantId}, ${before.org.name}, ${before.org.cnpj}, ${before.org.purge_reason ?? 'fim de contrato'},
                ${JSON.stringify(before.summary)}::jsonb, ${hash}, ${purgedAt})`);
      await writeAudit(tx, {
        tenantId,
        actorType: 'system',
        actorId: null,
        actorLabel: 'Liame (expurgo)',
        action: 'empresa.expurgar',
        resourceType: 'organization',
        resourceId: tenantId,
        after: { certificate_id: id, certificate_hash: hash, ...before.summary },
        origin: 'worker',
      });
      return { id, tenantId, organizationName: before.org.name, summary: before.summary, hash };
    });

    const text =
      `Os dados de ${before.org.name}${before.org.cnpj ? ` (CNPJ ${before.org.cnpj})` : ''} foram expurgados em ${purgedAt}.\n\n` +
      `A chave que protegia os dados pessoais foi destruída; cópias de segurança antigas ficam ilegíveis e expiram em até 35 dias.\n\n` +
      `Certificado ${certificate.id}\nHash ${certificate.hash}\nResumo: ${JSON.stringify(before.summary)}\n\n` +
      'A auditoria (quem fez o quê) é guardada pelo prazo legal, sem conteúdo de negócio.';
    await this.deliver(before.owners.map((to) => ({ to, subject: `Liame: certificado de expurgo de ${before.org.name}`, text })));
    return certificate;
  }

  /** Relatório mensal ao dono do que foi expurgado no mês anterior (ADR-014). */
  async monthlyReport(now = new Date(), scope: PurgeScope = {}): Promise<number> {
    const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)).toISOString();
    const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
    const reports = await withSystem(this.db, async (tx) => {
      const r = await tx.execute<{ tenant_id: string; after: Record<string, number> }>(sql`
        select tenant_id, after from liame.audit_event
         where action = 'dados.expurgar' and tenant_id is not null and occurred_at >= ${start} and occurred_at < ${end}
               ${inList(sql`tenant_id`, scope.tenantIds)}`);
      const totals = new Map<string, Record<string, number>>();
      for (const row of r.rows) {
        const t = totals.get(row.tenant_id) ?? {};
        for (const [k, v] of Object.entries(row.after ?? {})) t[k] = (t[k] ?? 0) + Number(v);
        totals.set(row.tenant_id, t);
      }
      const out: MailMessage[] = [];
      for (const [tenantId, counts] of totals) {
        const owners = await tx.execute<{ email: string; name: string }>(sql`
          select u.email, o.name from liame.membership m join liame.app_user u on u.id = m.user_id join liame.organization o on o.id = m.tenant_id
           where m.tenant_id = ${tenantId} and m.role_key = 'dono' and m.revoked_at is null`);
        for (const o of owners.rows) {
          out.push({
            to: o.email,
            subject: `Liame: o que foi expurgado de ${o.name} no último mês`,
            text: `Pelos prazos de guarda, estes registros foram apagados entre ${start.slice(0, 10)} e ${end.slice(0, 10)}:\n\n${Object.entries(counts)
              .map(([k, v]) => `- ${k}: ${v}`)
              .join('\n')}\n\nNenhum dado de negócio ativo é apagado sem você arquivar ou encerrar a conta.`,
          });
        }
      }
      return out;
    });
    await this.deliver(reports);
    return reports.length;
  }

  private async auditPurge(tx: Tx, tenantId: string | null, counts: Record<string, number>): Promise<void> {
    await writeAudit(tx, {
      tenantId,
      actorType: 'system',
      actorId: null,
      actorLabel: 'Liame (expurgo)',
      action: 'dados.expurgar',
      resourceType: 'retencao',
      after: counts,
      origin: 'worker',
    });
  }

  private async deliver(messages: MailMessage[]): Promise<void> {
    for (const m of messages) {
      try {
        await this.mailer.send(m);
      } catch (err) {
        this.logger.error(`falha ao enviar "${m.subject}": ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
}
