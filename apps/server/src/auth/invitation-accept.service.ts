import type { InvitableRole, InvitationPreviewResponse, InvitationSignupRequest, MeResponse } from '@liame/contracts';
import { type Database, type Tx, uuidv7, withSystem } from '@liame/database';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { activeTraceId, writeAudit } from '../audit/audit.js';
import { APP_CONFIG, type AppConfig } from '../config.js';
import type { AuthContext } from '../context/request-context.js';
import { DATABASE } from '../database/database.module.js';
import { AppProblem } from '../errors/problems.js';
import { emitEvent } from '../events/outbox.js';
import { Mailer, type MailMessage } from '../mail/mailer.js';
import { ROLE_LABEL } from '../people/grant-rules.js';
import { AuthService, type RequestMeta } from './auth.service.js';
import { hashPassword } from './password.js';
import { RateLimitService } from './rate-limit.service.js';
import { SessionService } from './session.service.js';
import { hashToken } from './tokens.js';

type OpenInvitation = {
  id: string;
  tenant_id: string;
  email: string;
  role_key: InvitableRole;
  approve_limit_micros: string | null;
  dual_approval: boolean;
  billing_access: boolean;
  access_expires_at: Date | string | null;
  invited_by: string;
  organization_name: string;
  invited_by_name: string;
};

const accountExists = () => new AppProblem(409, 'conta-existente', 'Você já tem conta', 'Entre com a sua conta e aceite o convite.');
const invalidLink = () => new AppProblem(400, 'link-invalido', 'Link inválido ou vencido', 'Peça um convite novo a quem convidou você.');

/**
 * Aceite do convite (ADR-017). Acontece antes do contexto da empresa (a pessoa só tem o link), por isso
 * roda no escopo de sistema, com o link (hash) como única chave de busca.
 */
@Injectable()
export class InvitationAcceptService {
  private readonly logger = new Logger('convite');

  constructor(
    @Inject(DATABASE) private readonly database: Database | null,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly auth: AuthService,
    private readonly sessions: SessionService,
    private readonly rateLimit: RateLimitService,
    private readonly mailer: Mailer,
  ) {}

  private get db() {
    if (!this.database) throw new AppProblem(503, 'indisponivel', 'Serviço indisponível', 'Tente de novo em instantes.');
    return this.database.db;
  }

  /** O que o link mostra antes de aceitar: empresa, nível e o e-mail convidado. */
  async preview(token: string, meta: RequestMeta): Promise<InvitationPreviewResponse> {
    await this.rateLimit.consume(`convite:ip:${meta.ip ?? '-'}`, 30, 900);
    return withSystem(this.db, async (tx) => {
      const inv = await this.open(tx, token, false);
      const u = await tx.execute(sql`select 1 from liame.app_user where email = ${inv.email}`);
      return {
        organization_name: inv.organization_name,
        role: inv.role_key,
        email: inv.email,
        invited_by_name: inv.invited_by_name,
        account_exists: u.rows.length > 0,
      };
    });
  }

  /** Quem ainda não tem conta cria o login pelo convite: o link prova o e-mail, então a conta já nasce confirmada. */
  async signup(input: InvitationSignupRequest, meta: RequestMeta): Promise<{ token: string; me: MeResponse }> {
    await this.rateLimit.consume(`convite:ip:${meta.ip ?? '-'}`, 30, 900);
    this.auth.assertCurrentTerms(input.terms_version);
    await this.auth.rejectBreached(input.password);
    const passwordHash = await hashPassword(input.password);
    const outbox: MailMessage[] = [];
    const result = await withSystem(this.db, async (tx) => {
      const inv = await this.open(tx, input.token, true);
      const exists = await tx.execute(sql`select 1 from liame.app_user where email = ${inv.email}`);
      if (exists.rows[0]) throw accountExists();
      const userId = uuidv7();
      await tx.execute(sql`
        insert into liame.app_user (id, email, name, password_hash, email_verified_at, terms_version, terms_accepted_at)
        values (${userId}, ${inv.email}, ${input.name}, ${passwordHash}, now(), ${input.terms_version}, now())`);
      await this.join(tx, inv, userId, input.name, outbox);
      const token = await this.sessions.create(tx, { userId, tenantId: inv.tenant_id, ip: meta.ip, userAgent: meta.userAgent });
      const me = await this.auth.loadMe(tx, userId, inv.tenant_id, null);
      return { token, me };
    }).catch((err: unknown) => {
      // O mesmo e-mail criado ao mesmo tempo por outro caminho (cadastro ou outro convite).
      if ((err as { code?: string }).code === '23505') throw accountExists();
      throw err;
    });
    await this.deliver(outbox);
    return result;
  }

  /** Quem já tem conta aceita logado com o e-mail convidado; a empresa do convite vira a ativa. */
  async accept(auth: AuthContext, token: string): Promise<MeResponse> {
    const outbox: MailMessage[] = [];
    const me = await withSystem(
      this.db,
      async (tx) => {
        const inv = await this.open(tx, token, true);
        if (inv.email !== auth.email) {
          throw new AppProblem(403, 'convite-de-outro-email', 'Convite para outro e-mail', 'Entre com a conta do e-mail que recebeu o convite.');
        }
        const member = await tx.execute(sql`
          select 1 from liame.membership where tenant_id = ${inv.tenant_id} and user_id = ${auth.userId} and revoked_at is null
             and (expires_at is null or expires_at > now())`);
        if (member.rows[0]) throw new AppProblem(409, 'ja-tem-acesso', 'Já tem acesso', 'Você já tem acesso a esta empresa.');
        await this.join(tx, inv, auth.userId, auth.name, outbox);
        await tx.execute(sql`update liame.session set active_tenant_id = ${inv.tenant_id} where id = ${auth.sessionId}`);
        return this.auth.loadMe(tx, auth.userId, inv.tenant_id, auth.mfaVerifiedAt);
      },
      { userId: auth.userId },
    );
    await this.deliver(outbox);
    return me;
  }

  // ------------------------------------------------------------------ apoio

  /** Convite em aberto pelo link. `lock` segura a linha: dois aceites ao mesmo tempo, só um vale. */
  private async open(tx: Tx, token: string, lock: boolean): Promise<OpenInvitation> {
    const r = await tx.execute<OpenInvitation>(sql`
      select v.id, v.tenant_id, v.email, v.role_key, v.approve_limit_micros, v.dual_approval, v.billing_access,
             v.access_expires_at, v.invited_by, o.name as organization_name, u.name as invited_by_name
        from liame.invitation v
        join liame.organization o on o.id = v.tenant_id
        join liame.app_user u on u.id = v.invited_by
       where v.token_hash = ${hashToken(token)} and v.accepted_at is null and v.revoked_at is null
         and v.expires_at > now() and o.status = 'ativa'
       ${lock ? sql`for update of v` : sql``}`);
    const inv = r.rows[0];
    if (!inv) throw invalidLink();
    return inv;
  }

  private async join(tx: Tx, inv: OpenInvitation, userId: string, name: string, outbox: MailMessage[]): Promise<void> {
    const memberId = uuidv7();
    await tx.execute(sql`
      insert into liame.membership (id, tenant_id, user_id, role_key, approve_limit_micros, dual_approval, billing_access,
                                    expires_at, invited_by)
      values (${memberId}, ${inv.tenant_id}, ${userId}, ${inv.role_key}, ${inv.approve_limit_micros}, ${inv.dual_approval},
              ${inv.billing_access}, ${inv.access_expires_at}, ${inv.invited_by})`);
    await tx.execute(sql`update liame.invitation set accepted_at = now(), accepted_by = ${userId} where id = ${inv.id}`);
    await writeAudit(tx, {
      tenantId: inv.tenant_id,
      actorType: 'human',
      actorId: userId,
      actorLabel: `${name}, ${ROLE_LABEL[inv.role_key]}`,
      actorRole: inv.role_key,
      action: 'convite.aceitar',
      resourceType: 'membership',
      resourceId: memberId,
      after: { role: inv.role_key, invitation_id: inv.id, invited_by: inv.invited_by },
      traceId: activeTraceId(),
      origin: 'api',
    });
    await emitEvent(tx, {
      tenantId: inv.tenant_id,
      type: 'liame.member.joined',
      subject: memberId,
      data: { member_id: memberId, user_id: userId, role: inv.role_key, invitation_id: inv.id },
    });
    // O dono recebe um aviso quando o convite é aceito (ADR-017).
    const owners = await tx.execute<{ email: string }>(sql`
      select u.email from liame.membership m join liame.app_user u on u.id = m.user_id
       where m.tenant_id = ${inv.tenant_id} and m.role_key = 'dono' and m.revoked_at is null`);
    for (const { email } of owners.rows) {
      outbox.push({
        to: email,
        subject: `Liame: ${name} aceitou o convite`,
        text:
          `${name} (${inv.email}) aceitou o convite de ${inv.invited_by_name} e agora tem acesso a ${inv.organization_name} ` +
          `como ${ROLE_LABEL[inv.role_key]}.\n\nVeja quem tem acesso: ${this.config.appUrl}/pessoas\n` +
          'Se você não reconhece esta pessoa, remova o acesso dela.',
      });
    }
  }

  /** Envia depois do commit; a falha de envio é registrada e não desfaz o aceite (LIC-001). */
  private async deliver(messages: MailMessage[]): Promise<void> {
    for (const message of messages) {
      try {
        await this.mailer.send(message);
      } catch (err) {
        this.logger.error(`falha ao enviar e-mail "${message.subject}": ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
}
