import { type Database, uuidv7, withSystem } from '@liame/database';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { diaNoFuso } from '../cobranca/vida.js';
import { APP_CONFIG, type AppConfig } from '../config.js';
import { DATABASE } from '../database/database.module.js';
import { FlagService } from '../flags/flag.service.js';
import { Mailer, maskEmail } from '../mail/mailer.js';
import {
  emailDoResumo,
  type Grupo,
  grupoDaAcao,
  type PessoaDoResumo,
  semanaDoResumo,
  TENTATIVAS_DO_RESUMO,
} from '../people/resumo-das-pessoas.js';
import { type JobScope, tenantFilter } from './outbox-publisher.js';

/** A função que liga o resumo, por empresa (nasce desligada; migration 0097). */
export const FLAG_RESUMO_DAS_PESSOAS = 'resumo_das_pessoas';
/** A entrega reservada por uma volta que caiu no meio volta a ser tentada depois disto (como nos avisos da cobrança). */
const RETOMAR_DEPOIS = '15 minutes';
/** A empresa entra na volta só com alguma ação de pessoa nos últimos dias (a semana fechada cabe aqui inteira). */
const JANELA_DA_ATIVIDADE = '15 days';

type Empresa = { id: string; nome: string; fuso: string };
type Dono = { user_id: string; email: string; nome: string };

export type ResumoDaRotina = {
  tenantId: string;
  enviados: number;
  falhas: number;
  resultado: 'enviado' | 'desligada' | 'cedo' | 'ja_mandado' | 'sem_atividade' | 'sem_dono';
};

/**
 * O resumo da semana do que cada pessoa fez na conta, por e-mail ao Dono (ADR-017: "o dono recebe por semana o
 * resumo do que cada pessoa fez"; A7, W8; D-A7-53). A cada volta, passa em páginas pelas empresas com alguma ação de
 * pessoa nos últimos dias (V106). Na segunda-feira, a partir das 8h no fuso da empresa (ou depois, se a rotina não
 * rodou), conta na auditoria, por pessoa, o que cada uma além do Dono fez na semana que fechou no domingo, por grupo
 * (aprovações, verba, pessoas e acessos, contas conectadas, parada, cobrança, exportação, marcas e conta, e o resto);
 * sem o conteúdo de nenhuma ação. Quem perdeu o acesso na semana também aparece. Uma entrega por empresa, semana e
 * Dono (`people_digest`): reservada antes de enviar; a que falha tenta de novo até 3 vezes; a semana em que ninguém
 * além do Dono fez nada fica marcada, sem e-mail.
 */
@Injectable()
export class ResumoDasPessoasService {
  private readonly logger = new Logger('resumo-das-pessoas');

  constructor(
    @Inject(DATABASE) private readonly database: Database | null,
    private readonly flags: FlagService,
    private readonly mailer: Mailer,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async executarLote(porPagina = 100, scope: JobScope = {}, agora = new Date()): Promise<ResumoDaRotina[]> {
    if (!this.database) return [];
    const db = this.database.db;
    const instante = sql`${agora.toISOString()}::timestamptz`;
    const feitos: ResumoDaRotina[] = [];
    let depoisDe: string | null = null;
    for (;;) {
      const cursor: string | null = depoisDe;
      const pagina: Empresa[] = await withSystem(db, async (tx): Promise<Empresa[]> =>
        (
          await tx.execute<Empresa>(sql`
            select o.id, o.name as nome, o.timezone as fuso
              from liame.organization o
             where o.status <> 'encerrada' ${tenantFilter(scope, sql`o.id`)}
               and exists (
                 select 1 from liame.audit_event a
                  where a.tenant_id = o.id and a.actor_type in ('human', 'partner')
                    and a.occurred_at >= ${instante} - ${JANELA_DA_ATIVIDADE}::interval)
               ${cursor ? sql`and o.id > ${cursor}::uuid` : sql``}
             order by o.id
             limit ${porPagina}`)
        ).rows,
      );
      for (const e of pagina) {
        try {
          feitos.push(await this.resumir(e, agora));
        } catch (err) {
          // Uma empresa que falha não segura as outras; a próxima volta tenta de novo.
          this.logger.error(`resumo das pessoas da empresa ${e.id}: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
        }
      }
      if (pagina.length < porPagina) return feitos;
      depoisDe = pagina[pagina.length - 1]!.id;
    }
  }

  private async resumir(e: Empresa, agora: Date): Promise<ResumoDaRotina> {
    const base = { tenantId: e.id, enviados: 0, falhas: 0 };
    if (!(await this.flags.isEnabled(FLAG_RESUMO_DAS_PESSOAS, this.flags.context({ tenantId: e.id })))) return { ...base, resultado: 'desligada' };
    const semana = semanaDoResumo(agora, e.fuso);
    if (!semana.pronto) return { ...base, resultado: 'cedo' };
    const db = this.database!.db;
    const instante = sql`${agora.toISOString()}::timestamptz`;

    // O Dono, com o e-mail confirmado e a conta viva; e se ainda falta o resumo desta semana para ele.
    const donos = await withSystem(db, async (tx) =>
      (
        await tx.execute<Dono & { pendente: boolean }>(sql`
          select u.id as user_id, u.email, u.name as nome,
                 not exists (
                   select 1 from liame.people_digest d
                    where d.tenant_id = ${e.id} and d.week_start = ${semana.de}::date and d.user_id = u.id
                      and (d.status in ('enviado', 'sem_atividade') or d.attempts >= ${TENTATIVAS_DO_RESUMO}
                           or (d.status = 'enviando' and d.claimed_at >= ${instante} - ${RETOMAR_DEPOIS}::interval))) as pendente
            from liame.membership mb join liame.app_user u on u.id = mb.user_id
           where mb.tenant_id = ${e.id} and mb.role_key = 'dono' and mb.revoked_at is null
             and (mb.expires_at is null or mb.expires_at > ${instante})
             and u.disabled_at is null and u.email_verified_at is not null
           order by u.id`)
      ).rows,
    );
    if (!donos.length) return { ...base, resultado: 'sem_dono' };
    const pendentes = donos.filter((d) => d.pendente);
    if (!pendentes.length) return { ...base, resultado: 'ja_mandado' };

    const pessoas = await this.pessoasDaSemana(e, semana.de, semana.ate, donos.map((d) => d.user_id), agora);
    if (!pessoas.length) {
      // Ninguém além do Dono fez nada: a semana fica marcada, sem e-mail, para a rotina não contar de novo.
      await withSystem(db, async (tx) => {
        for (const d of pendentes) {
          await tx.execute(sql`
            insert into liame.people_digest (id, tenant_id, week_start, user_id, status, attempts, claimed_at)
            values (${uuidv7()}, ${e.id}, ${semana.de}::date, ${d.user_id}, 'sem_atividade', 1, ${instante})
            on conflict (tenant_id, week_start, user_id) do update
               set status = 'sem_atividade', error = null, updated_at = now()
             where liame.people_digest.status <> 'enviado'`);
        }
      });
      return { ...base, resultado: 'sem_atividade' };
    }

    let enviados = 0;
    let falhas = 0;
    for (const d of pendentes) {
      // Reserva a entrega: a nova; a que falhou, até o limite; a reservada por uma volta que caiu no meio.
      const reservada = (
        await withSystem(db, (tx) =>
          tx.execute<{ id: string }>(sql`
            insert into liame.people_digest (id, tenant_id, week_start, user_id, status, attempts, claimed_at)
            values (${uuidv7()}, ${e.id}, ${semana.de}::date, ${d.user_id}, 'enviando', 1, ${instante})
            on conflict (tenant_id, week_start, user_id) do update
               set status = 'enviando', attempts = liame.people_digest.attempts + 1, claimed_at = excluded.claimed_at, error = null, updated_at = now()
             where (liame.people_digest.status = 'falhou' and liame.people_digest.attempts < ${TENTATIVAS_DO_RESUMO})
                or (liame.people_digest.status = 'enviando' and liame.people_digest.claimed_at < ${instante} - ${RETOMAR_DEPOIS}::interval
                    and liame.people_digest.attempts < ${TENTATIVAS_DO_RESUMO})
            returning id`),
        )
      ).rows[0];
      if (!reservada) continue;
      const email = emailDoResumo({ dono: d.nome, empresa: e.nome, de: semana.de, ate: semana.ate, pessoas, link: `${this.config.appUrl}/pessoas` });
      let falha: string | null = null;
      try {
        await this.mailer.send({ to: d.email, subject: email.subject, text: email.text });
      } catch (err) {
        // O motivo vai para o log com o endereço mascarado; na linha da entrega fica só o tipo do erro.
        falha = (err instanceof Error ? err.name : 'Erro').slice(0, 100) || 'Erro';
        this.logger.warn(`resumo das pessoas da empresa ${e.id}: envio para ${maskEmail(d.email)} falhou (${err instanceof Error ? err.message : String(err)})`);
      }
      await withSystem(db, (tx) =>
        tx.execute(sql`
          update liame.people_digest
             set status = ${falha ? 'falhou' : 'enviado'}, error = ${falha}, sent_at = ${falha ? null : agora.toISOString()}::timestamptz, updated_at = now()
           where id = ${reservada.id}`),
      );
      if (falha) falhas += 1;
      else enviados += 1;
    }
    return { ...base, enviados, falhas, resultado: 'enviado' };
  }

  /** Quem além do Dono fez alguma coisa na empresa na semana, com as contagens por grupo; por nome. */
  private async pessoasDaSemana(e: Empresa, de: string, ate: string, donos: string[], agora: Date): Promise<PessoaDoResumo[]> {
    const db = this.database!.db;
    const linhas = await withSystem(db, async (tx) =>
      (
        await tx.execute<{ actor_id: string; action: string; n: number; papel: string | null; rotulo: string | null }>(sql`
          select a.actor_id, a.action, count(*)::int as n, max(a.actor_role) as papel, max(a.actor_label) as rotulo
            from liame.audit_event a
           where a.tenant_id = ${e.id} and a.actor_type in ('human', 'partner') and a.actor_id is not null
             and a.occurred_at >= (${de}::date)::timestamp at time zone ${e.fuso}
             and a.occurred_at < ((${ate}::date + 1)::timestamp at time zone ${e.fuso})
             and not (a.actor_id = any(${`{${donos.join(',')}}`}::uuid[]))
           group by a.actor_id, a.action`)
      ).rows,
    );
    const porPessoa = new Map<string, { contagem: Partial<Record<Grupo, number>>; papel: string | null; rotulo: string | null }>();
    for (const l of linhas) {
      const g = grupoDaAcao(l.action);
      if (!g) continue;
      const p = porPessoa.get(l.actor_id) ?? { contagem: {}, papel: l.papel, rotulo: l.rotulo };
      p.contagem[g] = (p.contagem[g] ?? 0) + l.n;
      porPessoa.set(l.actor_id, p);
    }
    if (!porPessoa.size) return [];
    const ids = [...porPessoa.keys()];
    const quem = await withSystem(db, async (tx) =>
      (
        await tx.execute<{ id: string; nome: string; role_key: string | null; saiu_em: string | null }>(sql`
          select u.id, u.name as nome, mb.role_key,
                 case when mb.revoked_at is not null then mb.revoked_at
                      when mb.expires_at is not null and mb.expires_at <= ${agora.toISOString()}::timestamptz then mb.expires_at end as saiu_em
            from liame.app_user u
            left join liame.membership mb on mb.user_id = u.id and mb.tenant_id = ${e.id}
           where u.id = any(${`{${ids.join(',')}}`}::uuid[])`)
      ).rows,
    );
    const porId = new Map(quem.map((q) => [q.id, q]));
    return ids
      .map((id): PessoaDoResumo => {
        const q = porId.get(id), p = porPessoa.get(id)!;
        // A pessoa que não existe mais aparece pelo nome que a auditoria guardou ("Ana, Administrador").
        const nome = q?.nome ?? p.rotulo?.split(',')[0]?.trim() ?? 'Uma pessoa que não está mais no Liame';
        const saiu = q?.saiu_em ? diaNoFuso(new Date(q.saiu_em), e.fuso) : null;
        return { nome, nivel: q?.role_key ?? p.papel, semAcessoDesde: saiu, contagem: p.contagem };
      })
      .sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR'));
  }
}
