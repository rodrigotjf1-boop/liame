import type { TermsChange } from '@liame/contracts';
import { type Database, uuidv7, withSystem } from '@liame/database';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { DIAS_DO_LEMBRETE, emailDaRetirada, emailDoAviso, emailDoLembrete } from '../auth/termos/emails.js';
import { FLAG_TERMOS } from '../auth/termos/termos.service.js';
import { diaEmBrasilia } from '../auth/termos/versoes.js';
import { APP_CONFIG, type AppConfig } from '../config.js';
import { DATABASE } from '../database/database.module.js';
import { FlagService } from '../flags/flag.service.js';
import { Mailer, maskEmail } from '../mail/mailer.js';

/** A entrega reservada por uma volta que caiu no meio volta a ser tentada depois disto. */
const RETOMAR_DEPOIS = '15 minutes';
/** Quantas vezes o envio a uma pessoa é tentado antes de desistir (a falha fica gravada, sem o endereço). */
const TENTATIVAS = 3;
/** A retirada só é avisada se for recente (uma volta parada por muito tempo não manda e-mail velho). */
const RETIRADA_ATE = '30 days';

type Entrega = 'aviso' | 'lembrete' | 'retirada';

type Versao = { version: string; notice_at: Date | string; effective_at: Date | string; withdrawn_at: Date | string | null; changes: TermsChange[] };
type Pessoa = { id: string; email: string; name: string; dono: boolean; tenants: string[] };

export type EntregaDaRotina = { versao: string; tipo: Entrega; enviados: number; falhas: number; desligadas: number };

/**
 * Os e-mails dos Termos novos (A7, W14, parte 14c; D-A7-90; D-A7-103). Para cada versão relevante avisada: o aviso, a
 * cada pessoa com acesso ativo e e-mail confirmado que ainda não aceitou; o lembrete, nos 7 dias antes do dia, a quem ainda
 * não aceitou; e, se a versão foi retirada antes do dia, a retirada, a quem tinha recebido o aviso. Uma vez por versão,
 * tipo e pessoa (`terms_notice`): a entrega é reservada antes do envio, a que caiu no meio volta depois de 15 minutos, e a
 * que falhou tenta de novo, até 3 vezes. Pessoas em páginas (V106). Só com a função `termos_novos` ligada para a pessoa
 * (ou para uma das empresas dela); sem nenhuma regra ligada, a rotina nem procura as pessoas.
 */
@Injectable()
export class AvisosDosTermosService {
  private readonly logger = new Logger('avisos-dos-termos');

  constructor(
    @Inject(DATABASE) private readonly database: Database | null,
    private readonly flags: FlagService,
    private readonly mailer: Mailer,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /** `pessoas` limita a volta a essas pessoas (os testes, que dividem o banco com outros arquivos). */
  async executarLote(porPagina = 100, escopo: { pessoas?: readonly string[] } = {}, agora = new Date()): Promise<EntregaDaRotina[]> {
    if (!this.database) return [];
    const db = this.database.db;
    const instante = sql`${agora.toISOString()}::timestamptz`;
    const { versoes, algumaLigada } = await withSystem(db, async (tx) => {
      const ligada = await tx.execute<{ existe: boolean }>(sql`
        select exists (select 1 from liame.feature_flag_rule where flag_key = ${FLAG_TERMOS} and value = 'true'::jsonb) as existe`);
      const v = await tx.execute<Versao>(sql`
        select version, notice_at, effective_at, withdrawn_at, changes from liame.terms_version
         where kind = 'relevante' and notice_at <= ${instante}
           and ((withdrawn_at is null and effective_at > ${instante})
                or (withdrawn_at is not null and withdrawn_at > ${instante} - ${RETIRADA_ATE}::interval and withdrawn_at < effective_at))
         order by effective_at`);
      return { versoes: v.rows, algumaLigada: ligada.rows[0]?.existe === true };
    });
    // A função nasce desligada e sem regra: sem nenhuma regra ligada, ninguém recebe, e não vale procurar as pessoas.
    if (!algumaLigada || !versoes.length) return [];

    const feitos: EntregaDaRotina[] = [];
    for (const v of versoes) {
      const tipos: Entrega[] = v.withdrawn_at
        ? ['retirada']
        : new Date(v.effective_at).getTime() - DIAS_DO_LEMBRETE * 86_400_000 <= agora.getTime()
          ? ['aviso', 'lembrete']
          : ['aviso'];
      for (const tipo of tipos) {
        try {
          feitos.push(await this.entregar(v, tipo, porPagina, escopo, agora));
        } catch (err) {
          // Uma versão que falha não segura as outras; a próxima volta tenta de novo.
          this.logger.error(`${tipo} da versão ${v.version}: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
        }
      }
    }
    return feitos;
  }

  private async entregar(v: Versao, tipo: Entrega, porPagina: number, escopo: { pessoas?: readonly string[] }, agora: Date): Promise<EntregaDaRotina> {
    const db = this.database!.db;
    const instante = sql`${agora.toISOString()}::timestamptz`;
    const valeEm = diaEmBrasilia(v.effective_at);
    const hoje = diaEmBrasilia(agora);
    const diasQueFaltam = Math.max(1, Math.round((Date.parse(`${valeEm}T12:00:00Z`) - Date.parse(`${hoje}T12:00:00Z`)) / 86_400_000));
    const resultado: EntregaDaRotina = { versao: v.version, tipo, enviados: 0, falhas: 0, desligadas: 0 };
    const filtro = escopo.pessoas ? sql`and u.id in (${sql.join(escopo.pessoas.map((p) => sql`${p}::uuid`), sql`, `)})` : sql``;
    let depoisDe: string | null = null;
    for (;;) {
      const cursor: string | null = depoisDe;
      const pagina: Pessoa[] = await withSystem(db, async (tx): Promise<Pessoa[]> =>
        (
          await tx.execute<Pessoa>(sql`
            select u.id, u.email, u.name,
                   bool_or(m.role_key = 'dono') as dono,
                   array_agg(distinct m.tenant_id::text) as tenants
              from liame.app_user u
              join liame.membership m on m.user_id = u.id and m.revoked_at is null and (m.expires_at is null or m.expires_at > ${instante})
             where u.disabled_at is null and u.email_verified_at is not null ${filtro}
               ${cursor ? sql`and u.id > ${cursor}::uuid` : sql``}
               -- O aviso e o lembrete: quem ainda não aceitou. A retirada: quem recebeu o aviso.
               ${
                 tipo === 'retirada'
                   ? sql`and exists (select 1 from liame.terms_notice a where a.user_id = u.id and a.version = ${v.version} and a.kind = 'aviso' and a.status = 'enviado')`
                   : sql`and not exists (select 1 from liame.terms_acceptance a where a.user_id = u.id and a.version = ${v.version})`
               }
               -- Fora quem já recebeu, quem esgotou as tentativas e quem outra volta acabou de reservar.
               and not exists (select 1 from liame.terms_notice n
                                where n.user_id = u.id and n.version = ${v.version} and n.kind = ${tipo}
                                  and (n.status = 'enviado' or n.attempts >= ${TENTATIVAS}
                                       or (n.status = 'enviando' and n.claimed_at >= ${instante} - ${RETOMAR_DEPOIS}::interval)))
             group by u.id
             order by u.id
             limit ${porPagina}`)
        ).rows,
      );
      for (const p of pagina) {
        if (!(await this.ligadaPara(p))) {
          resultado.desligadas += 1;
          continue;
        }
        await this.mandar(v, tipo, p, { valeEm, avisoEm: diaEmBrasilia(v.notice_at), diasQueFaltam }, agora, resultado);
      }
      if (pagina.length < porPagina) return resultado;
      depoisDe = pagina[pagina.length - 1]!.id;
    }
  }

  /** A função para a pessoa, ou para uma das empresas dela (o piloto por empresa). */
  private async ligadaPara(p: Pessoa): Promise<boolean> {
    if (await this.flags.isEnabled(FLAG_TERMOS, this.flags.context({ userId: p.id }))) return true;
    for (const tenantId of p.tenants) {
      if (await this.flags.isEnabled(FLAG_TERMOS, this.flags.context({ userId: p.id, tenantId }))) return true;
    }
    return false;
  }

  private async mandar(
    v: Versao,
    tipo: Entrega,
    p: Pessoa,
    datas: { valeEm: string; avisoEm: string; diasQueFaltam: number },
    agora: Date,
    resultado: EntregaDaRotina,
  ): Promise<void> {
    const db = this.database!.db;
    const instante = sql`${agora.toISOString()}::timestamptz`;
    // Reserva a entrega: a nova; a que falhou, até o limite; a reservada por uma volta que caiu no meio.
    const reservada = (
      await withSystem(db, (tx) =>
        tx.execute<{ id: string }>(sql`
          insert into liame.terms_notice (id, version, kind, user_id, status, attempts, claimed_at)
          values (${uuidv7()}, ${v.version}, ${tipo}, ${p.id}, 'enviando', 1, ${instante})
          on conflict (version, kind, user_id) do update
             set status = 'enviando', attempts = liame.terms_notice.attempts + 1, claimed_at = excluded.claimed_at, error = null, updated_at = now()
           where (liame.terms_notice.status = 'falhou' and liame.terms_notice.attempts < ${TENTATIVAS})
              or (liame.terms_notice.status = 'enviando' and liame.terms_notice.claimed_at < ${instante} - ${RETOMAR_DEPOIS}::interval
                  and liame.terms_notice.attempts < ${TENTATIVAS})
          returning id`),
      )
    ).rows[0];
    if (!reservada) return;
    const dados = { nome: p.name.trim().split(/\s+/)[0] || p.name, dono: p.dono, mudancas: v.changes, link: this.config.appUrl, ...datas };
    const email = tipo === 'aviso' ? emailDoAviso(dados) : tipo === 'lembrete' ? emailDoLembrete(dados) : emailDaRetirada(dados);
    let falha: string | null = null;
    try {
      await this.mailer.send({ to: p.email, subject: email.subject, text: email.text });
    } catch (err) {
      // O motivo vai para o log com o endereço mascarado; na linha da entrega fica só o tipo do erro.
      falha = (err instanceof Error ? err.name : 'Erro').slice(0, 100) || 'Erro';
      this.logger.warn(`${tipo} da versão ${v.version}: envio para ${maskEmail(p.email)} falhou (${err instanceof Error ? err.message : String(err)})`);
    }
    await withSystem(db, (tx) =>
      tx.execute(sql`
        update liame.terms_notice
           set status = ${falha ? 'falhou' : 'enviado'}, error = ${falha}, sent_at = ${falha ? null : agora.toISOString()}::timestamptz, updated_at = now()
         where id = ${reservada.id}`),
    );
    if (falha) resultado.falhas += 1;
    else resultado.enviados += 1;
  }
}
