import type { AcceptedResponse, LoginRequest, MeResponse, ResetPasswordRequest, RoleKey, SignupRequest } from '@liame/contracts';
import { type Database, type Tx, uuidv7, withSystem } from '@liame/database';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { activeTraceId, writeAudit } from '../audit/audit.js';
import { APP_CONFIG, type AppConfig } from '../config.js';
import { auditDetail, type AuthContext, currentTx } from '../context/request-context.js';
import { DATABASE } from '../database/database.module.js';
import { AppProblem, ValidationProblem } from '../errors/problems.js';
import { Mailer, type MailMessage } from '../mail/mailer.js';
import { burnPasswordTime, hashPassword, isBreachedPassword, verifyPassword } from './password.js';
import { MFA_REQUIRED } from './permissions.js';
import { RateLimitService } from './rate-limit.service.js';
import { SessionService } from './session.service.js';
import { hashToken, newToken } from './tokens.js';

export interface RequestMeta {
  ip: string | null;
  userAgent: string | null;
}

const ACCEPTED_SIGNUP: AcceptedResponse = {
  status: 'accepted',
  message: 'Se o e-mail puder ser usado, enviamos um link para confirmar o cadastro.',
};
const ACCEPTED_FORGOT: AcceptedResponse = {
  status: 'accepted',
  message: 'Se houver uma conta com este e-mail, enviamos um link para criar uma senha nova.',
};

type LoginOutcome =
  | { kind: 'falhou'; userId: string }
  | { kind: 'nao_confirmado' }
  | { kind: 'ok'; token: string; userId: string; tenantId: string | null };

const invalidCredentials = () =>
  new AppProblem(401, 'credenciais-invalidas', 'E-mail ou senha incorretos', 'Confira os dados e tente de novo.');

@Injectable()
export class AuthService {
  private readonly logger = new Logger('auth');

  constructor(
    @Inject(DATABASE) private readonly database: Database | null,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly sessions: SessionService,
    private readonly rateLimit: RateLimitService,
    private readonly mailer: Mailer,
  ) {}

  private get db() {
    if (!this.database) throw new AppProblem(503, 'indisponivel', 'Serviço indisponível', 'Tente de novo em instantes.');
    return this.database.db;
  }

  // ------------------------------------------------------------------ cadastro

  async signup(input: SignupRequest, meta: RequestMeta): Promise<AcceptedResponse> {
    await this.rateLimit.consume(`cadastro:ip:${meta.ip ?? '-'}`, 10, 3600);
    await this.rejectBreached(input.password);
    const passwordHash = await hashPassword(input.password);

    const outbox: MailMessage[] = [];
    try {
      await withSystem(this.db, async (tx) => {
        const existing = await tx.execute<{ id: string; email_verified_at: string | null }>(
          sql`select id, email_verified_at from liame.app_user where email = ${input.email}`,
        );
        const found = existing.rows[0];
        if (found) {
          // Não revela que a conta existe: a resposta é a mesma; só o e-mail muda.
          outbox.push(
            found.email_verified_at ? this.alreadyRegisteredMail(input.email) : await this.confirmationMail(tx, found.id, input.email),
          );
          return;
        }
        const userId = uuidv7();
        const tenantId = uuidv7();
        await tx.execute(sql`insert into liame.app_user (id, email, name, password_hash) values (${userId}, ${input.email}, ${input.name}, ${passwordHash})`);
        await tx.execute(sql`insert into liame.organization (id, name, cnpj) values (${tenantId}, ${input.company.name}, ${input.company.cnpj ?? null})`);
        await tx.execute(sql`insert into liame.membership (id, tenant_id, user_id, role_key, dual_approval, billing_access)
                             values (${uuidv7()}, ${tenantId}, ${userId}, 'dono', false, true)`);
        await tx.execute(sql`insert into liame.brand (id, tenant_id, name) values (${uuidv7()}, ${tenantId}, ${input.company.name})`);
        await writeAudit(tx, {
          tenantId,
          actorType: 'human',
          actorId: userId,
          actorLabel: `${input.name}, Dono`,
          actorRole: 'dono',
          action: 'conta.criar',
          resourceType: 'organization',
          resourceId: tenantId,
          after: { company: input.company.name },
          traceId: activeTraceId(),
          origin: 'api',
        });
        outbox.push(await this.confirmationMail(tx, userId, input.email));
      });
    } catch (err) {
      // Dois cadastros ao mesmo tempo com o mesmo e-mail: o segundo cai aqui, e a resposta continua a mesma.
      if ((err as { code?: string }).code !== '23505') throw err;
      this.logger.log('cadastro concorrente com e-mail já existente');
    }
    await this.deliver(outbox);
    return ACCEPTED_SIGNUP;
  }

  async verifyEmail(token: string): Promise<AcceptedResponse> {
    await withSystem(this.db, async (tx) => {
      const userId = await this.consumeToken(tx, token, 'confirmar_email');
      await tx.execute(sql`update liame.app_user set email_verified_at = coalesce(email_verified_at, now()) where id = ${userId}`);
      await this.auditPerson(tx, userId, 'email.confirmar');
    });
    return { status: 'accepted', message: 'E-mail confirmado. Você já pode entrar.' };
  }

  // ------------------------------------------------------------------ entrar e sair

  async login(input: LoginRequest, meta: RequestMeta): Promise<{ token: string; me: MeResponse }> {
    await this.rateLimit.consume(`entrar:ip:${meta.ip ?? '-'}`, 30, 900);
    await this.rateLimit.consume(`entrar:email:${input.email}`, 10, 900);

    const outbox: MailMessage[] = [];
    const result = await withSystem(this.db, async (tx): Promise<LoginOutcome> => {
      const r = await tx.execute<{ id: string; password_hash: string; email_verified_at: string | null; disabled_at: string | null }>(
        sql`select id, password_hash, email_verified_at, disabled_at from liame.app_user where email = ${input.email}`,
      );
      const user = r.rows[0];
      if (!user) {
        await burnPasswordTime(input.password);
        throw invalidCredentials();
      }
      // A falha fica na auditoria da pessoa, fora desta transação; a resposta é a mesma do e-mail
      // inexistente (não revela quem tem conta).
      if (!(await verifyPassword(input.password, user.password_hash)) || user.disabled_at) {
        return { kind: 'falhou', userId: user.id };
      }
      if (!user.email_verified_at) {
        outbox.push(await this.confirmationMail(tx, user.id, input.email));
        return { kind: 'nao_confirmado' };
      }
      const m = await tx.execute<{ tenant_id: string }>(sql`
        select tenant_id from liame.membership
         where user_id = ${user.id} and revoked_at is null and (expires_at is null or expires_at > now())
         order by created_at limit 1`);
      const tenantId = m.rows[0]?.tenant_id ?? null;
      // Aviso de acesso novo (ADR-013): primeiro login deste navegador em 90 dias, numa conta que já tinha acessos.
      const seen = await tx.execute<{ same: boolean; any: boolean }>(sql`
        select coalesce(bool_or(user_agent is not distinct from ${meta.userAgent}), false) as same, count(*) > 0 as any
          from liame.session where user_id = ${user.id} and created_at > now() - interval '90 days'`);
      if (seen.rows[0]?.any && !seen.rows[0].same) {
        outbox.push({
          to: input.email,
          subject: 'Liame: novo acesso à sua conta',
          text: `Sua conta foi acessada de um navegador ou aparelho novo.\n\nSe foi você, não precisa fazer nada. Se não foi, troque a senha agora: ${this.config.appUrl}/esqueci-a-senha`,
        });
      }
      const token = await this.sessions.create(tx, { userId: user.id, tenantId, ip: meta.ip, userAgent: meta.userAgent });
      await this.auditPerson(tx, user.id, 'sessao.abrir');
      return { kind: 'ok', token, userId: user.id, tenantId };
    });

    if (result.kind === 'falhou') {
      const failedUser = result.userId;
      await withSystem(this.db, (tx) => this.auditPerson(tx, failedUser, 'sessao.falhar'));
      throw invalidCredentials();
    }
    if (result.kind === 'nao_confirmado') {
      await this.deliver(outbox);
      throw new AppProblem(403, 'email-nao-confirmado', 'Confirme seu e-mail', 'Enviamos de novo o link de confirmação.');
    }
    await this.deliver(outbox);
    const { userId, tenantId } = result;
    const me = await withSystem(this.db, (tx) => this.loadMe(tx, userId, tenantId, null), { userId });
    return { token: result.token, me };
  }

  async logout(auth: AuthContext): Promise<void> {
    await this.sessions.revoke(auth.sessionId);
  }

  // ------------------------------------------------------------------ senha

  async forgotPassword(email: string, meta: RequestMeta): Promise<AcceptedResponse> {
    await this.rateLimit.consume(`esqueci:ip:${meta.ip ?? '-'}`, 10, 3600);
    await this.rateLimit.consume(`esqueci:email:${email}`, 5, 3600);
    const outbox: MailMessage[] = [];
    await withSystem(this.db, async (tx) => {
      const r = await tx.execute<{ id: string }>(
        sql`select id from liame.app_user where email = ${email} and disabled_at is null`,
      );
      const user = r.rows[0];
      if (!user) return;
      const { token, hash } = newToken();
      await tx.execute(sql`insert into liame.user_token (id, user_id, purpose, token_hash, expires_at)
                           values (${uuidv7()}, ${user.id}, 'redefinir_senha', ${hash}, now() + interval '1 hour')`);
      outbox.push({
        to: email,
        subject: 'Liame: criar uma senha nova',
        text: `Para criar uma senha nova, abra o link em até 1 hora:\n\n${this.config.appUrl}/redefinir-senha?token=${token}\n\nSe não foi você, ignore este e-mail: a senha atual continua valendo.`,
      });
    });
    await this.deliver(outbox);
    return ACCEPTED_FORGOT;
  }

  async resetPassword(input: ResetPasswordRequest): Promise<AcceptedResponse> {
    await this.rejectBreached(input.password);
    const passwordHash = await hashPassword(input.password);
    await withSystem(this.db, async (tx) => {
      const userId = await this.consumeToken(tx, input.token, 'redefinir_senha');
      await this.auditPerson(tx, userId, 'senha.redefinir');
      // Quem recebeu o link provou que o e-mail é seu.
      await tx.execute(sql`update liame.app_user set password_hash = ${passwordHash}, email_verified_at = coalesce(email_verified_at, now())
                           where id = ${userId}`);
      await this.sessions.revokeAllForUser(tx, userId);
      // Trocar a senha cancela um pedido de troca do segundo fator em espera (ADR-013).
      await tx.execute(sql`update liame.user_token set used_at = now()
                           where user_id = ${userId} and purpose = 'trocar_segundo_fator' and used_at is null`);
    });
    return { status: 'accepted', message: 'Senha nova criada. Entre com ela.' };
  }

  // ------------------------------------------------------------------ eu e empresa ativa

  /** Roda na transação da requisição (contexto da pessoa). */
  async me(auth: AuthContext): Promise<MeResponse> {
    return this.loadMe(currentTx(), auth.userId, auth.tenantId, auth.mfaVerifiedAt);
  }

  async switchOrganization(auth: AuthContext, organizationId: string): Promise<MeResponse> {
    const tx = currentTx();
    const m = await tx.execute<{ tenant_id: string }>(sql`
      select tenant_id from liame.membership
       where tenant_id = ${organizationId} and user_id = ${auth.userId} and revoked_at is null
         and (expires_at is null or expires_at > now())`);
    // Sem vínculo, a resposta é a mesma de empresa inexistente (arquitetura §14: nunca "é de outra empresa").
    if (!m.rows[0]) throw new AppProblem(404, 'nao-encontrado', 'Não encontramos', 'Empresa não encontrada.');
    await tx.execute(sql`update liame.session set active_tenant_id = ${organizationId} where id = ${auth.sessionId}`);
    auditDetail({ resourceId: organizationId, before: { organization_id: auth.tenantId }, after: { organization_id: organizationId } });
    return this.loadMe(tx, auth.userId, organizationId, auth.mfaVerifiedAt);
  }

  async loadMe(tx: Tx, userId: string, tenantId: string | null, mfaVerifiedAt: Date | null): Promise<MeResponse> {
    const u = await tx.execute<{ id: string; name: string; email: string; mfa_configured: boolean }>(sql`
      select id, name, email,
             exists (select 1 from liame.secret x
                      where x.owner_user_id = app_user.id and x.tenant_id is null and x.purpose = 'totp' and x.revoked_at is null) as mfa_configured
        from liame.app_user where id = ${userId}`);
    const orgs = await tx.execute<{ id: string; name: string; role: RoleKey }>(sql`
      select o.id, o.name, m.role_key as role
        from liame.membership m join liame.organization o on o.id = m.tenant_id
       where m.user_id = ${userId} and m.revoked_at is null and (m.expires_at is null or m.expires_at > now())
       order by o.name`);
    const user = u.rows[0];
    if (!user) throw new AppProblem(401, 'nao-autenticado', 'Entre de novo', 'A sessão acabou.');
    const activeRole = orgs.rows.find((o) => o.id === tenantId)?.role ?? null;
    const permissions = tenantId && activeRole ? await this.permissionsOf(tx, tenantId, activeRole) : [];
    return {
      user: { id: user.id, name: user.name, email: user.email },
      organizations: orgs.rows,
      active_organization_id: tenantId,
      mfa: !user.mfa_configured ? 'not_configured' : mfaVerifiedAt ? 'verified' : 'required',
      mfa_enrollment_required: !user.mfa_configured && activeRole !== null && MFA_REQUIRED.has(activeRole),
      permissions,
    };
  }

  /** Papel como dado (ADR-013): o conjunto da empresa para o papel, se houver; senão, o padrão do Liame. */
  private async permissionsOf(tx: Tx, tenantId: string, role: RoleKey): Promise<string[]> {
    const r = await tx.execute<{ permission: string }>(sql`
      select rp.permission from liame.role_permission rp
       where rp.role_key = ${role}
         and rp.tenant_id is not distinct from (select t.tenant_id from liame.role_permission t
                                                  where t.tenant_id = ${tenantId} and t.role_key = ${role} limit 1)
       order by rp.permission`);
    return r.rows.map((x) => x.permission);
  }

  // ------------------------------------------------------------------ apoio

  /** Evento na cadeia da própria pessoa (entrar, confirmar e-mail, senha nova). */
  private async auditPerson(tx: Tx, userId: string, action: string): Promise<void> {
    const r = await tx.execute<{ name: string }>(sql`select name from liame.app_user where id = ${userId}`);
    await writeAudit(tx, {
      tenantId: null,
      actorType: 'human',
      actorId: userId,
      actorLabel: r.rows[0]?.name ?? null,
      action,
      traceId: activeTraceId(),
      origin: 'api',
    });
  }

  async rejectBreached(password: string): Promise<void> {
    if (this.config.breachedPasswordCheck && (await isBreachedPassword(password))) {
      throw new ValidationProblem([
        { path: 'password', message: 'Essa senha já apareceu em vazamentos de outros sites. Escolha outra.' },
      ]);
    }
  }

  private async consumeToken(tx: Tx, token: string, purpose: 'confirmar_email' | 'redefinir_senha'): Promise<string> {
    const r = await tx.execute<{ user_id: string }>(sql`
      update liame.user_token set used_at = now()
       where token_hash = ${hashToken(token)} and purpose = ${purpose} and used_at is null and expires_at > now()
       returning user_id`);
    const userId = r.rows[0]?.user_id;
    if (!userId) throw new AppProblem(400, 'link-invalido', 'Link inválido ou vencido', 'Peça um link novo.');
    return userId;
  }

  private async confirmationMail(tx: Tx, userId: string, email: string): Promise<MailMessage> {
    const { token, hash } = newToken();
    await tx.execute(sql`insert into liame.user_token (id, user_id, purpose, token_hash, expires_at)
                         values (${uuidv7()}, ${userId}, 'confirmar_email', ${hash}, now() + interval '24 hours')`);
    return {
      to: email,
      subject: 'Liame: confirme seu e-mail',
      text: `Para confirmar seu e-mail e ativar a conta, abra o link em até 24 horas:\n\n${this.config.appUrl}/confirmar-email?token=${token}\n\nSe não foi você, ignore este e-mail.`,
    };
  }

  private alreadyRegisteredMail(email: string): MailMessage {
    return {
      to: email,
      subject: 'Liame: você já tem conta',
      text: `Alguém tentou criar uma conta com este e-mail, mas você já tem uma.\n\nPara entrar: ${this.config.appUrl}/entrar\nEsqueceu a senha? ${this.config.appUrl}/esqueci-a-senha\n\nSe não foi você, ignore este e-mail.`,
    };
  }

  /** Envia depois do commit. Falha de envio não desfaz o cadastro: registra o motivo (LIC-001, LIC-003). */
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
