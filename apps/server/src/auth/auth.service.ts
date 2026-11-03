import type { AcceptedResponse, LoginRequest, MeResponse, OrganizationKind, PasskeyAssertion, ResetPasswordRequest, RoleKey, SignupRequest } from '@liame/contracts';
import { type Database, type Tx, uuidv7, withSystem } from '@liame/database';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { activeTraceId, writeAudit } from '../audit/audit.js';
import { APP_CONFIG, type AppConfig } from '../config.js';
import { auditDetail, type AuthContext, currentTx } from '../context/request-context.js';
import { DATABASE } from '../database/database.module.js';
import { AppProblem, ValidationProblem } from '../errors/problems.js';
import { Mailer, type MailMessage } from '../mail/mailer.js';
import { ROLE_LABEL } from '../people/grant-rules.js';
import { descreverAparelho, mascararIp } from './aparelho.js';
import { ChavesService } from './chaves/chaves.service.js';
import { TermosService } from './termos/termos.service.js';
import { burnPasswordTime, hashPassword, isBreachedPassword, verifyPassword } from './password.js';
import { MFA_REQUIRED, permissoesDoVinculo } from './permissions.js';
import { RateLimitService } from './rate-limit.service.js';
import { cairPorqueEntrou } from './recuperacao/recuperacao.service.js';
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
    private readonly chaves: ChavesService,
    private readonly termos: TermosService,
  ) {}

  private get db() {
    if (!this.database) throw new AppProblem(503, 'indisponivel', 'Serviço indisponível', 'Tente de novo em instantes.');
    return this.database.db;
  }

  // ------------------------------------------------------------------ cadastro

  async signup(input: SignupRequest, meta: RequestMeta): Promise<AcceptedResponse> {
    await this.rateLimit.consume(`cadastro:ip:${meta.ip ?? '-'}`, 10, 3600);
    const aceites = await this.conferirTermos(input.terms_version, input.next_terms_version);
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
        await tx.execute(sql`
          insert into liame.app_user (id, email, name, password_hash, terms_version, terms_accepted_at)
          values (${userId}, ${input.email}, ${input.name}, ${passwordHash}, ${input.terms_version}, now())`);
        // Os Termos novos (W14; D-A7-94): a versão declarada que vale e a que vem, quando a pessoa aceitou as duas.
        await this.termos.gravarAceites(tx, userId, aceites, 'cadastro');
        // "Sou agência ou consultor" (A7, W6; D-A7-45): a agência nasce com a dona, sem marca e sem assinatura.
        const agencia = input.kind === 'agencia';
        await tx.execute(sql`insert into liame.organization (id, name, cnpj, kind)
                             values (${tenantId}, ${input.company.name}, ${input.company.cnpj ?? null}, ${agencia ? 'agencia' : 'empresa'})`);
        await tx.execute(sql`insert into liame.membership (id, tenant_id, user_id, role_key, dual_approval, billing_access)
                             values (${uuidv7()}, ${tenantId}, ${userId}, ${agencia ? 'agencia_dona' : 'dono'}, false, ${!agencia})`);
        if (!agencia) await tx.execute(sql`insert into liame.brand (id, tenant_id, name) values (${uuidv7()}, ${tenantId}, ${input.company.name})`);
        await writeAudit(tx, {
          tenantId,
          actorType: 'human',
          actorId: userId,
          actorLabel: `${input.name}, ${ROLE_LABEL[agencia ? 'agencia_dona' : 'dono']}`,
          actorRole: agencia ? 'agencia_dona' : 'dono',
          action: agencia ? 'agencia.abrir' : 'conta.criar',
          resourceType: 'organization',
          resourceId: tenantId,
          after: { company: input.company.name, terms_version: input.terms_version, ...(agencia ? { kind: 'agencia' } : {}) },
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
      const tenantId = await this.primeiraEmpresa(tx, user.id);
      const aviso = await this.avisoDeAcessoNovo(tx, user.id, input.email, meta);
      if (aviso) outbox.push(aviso);
      const token = await this.sessions.create(tx, { userId: user.id, tenantId, ip: meta.ip, userAgent: meta.userAgent });
      await this.auditPerson(tx, user.id, 'sessao.abrir', onde(meta));
      return { kind: 'ok', token, userId: user.id, tenantId };
    });

    if (result.kind === 'falhou') {
      const failedUser = result.userId;
      await withSystem(this.db, (tx) => this.auditPerson(tx, failedUser, 'sessao.falhar', onde(meta)));
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

  /**
   * Entrar sem senha, com a chave de acesso (A7, W9, parte 9b; D-A7-55): a chave vale pela senha e pelo código do app (o
   * aparelho e o desbloqueio dele), e a sessão nasce verificada. As regras da entrada com senha valem iguais: o limite por
   * IP, a pessoa desativada, o e-mail por confirmar, o aviso de acesso novo e a auditoria da pessoa (com o método e a
   * chave). O pedido de recuperação em andamento cai, como ao provar o segundo fator.
   */
  async entrarComChave(body: PasskeyAssertion, meta: RequestMeta): Promise<{ token: string; me: MeResponse }> {
    await this.rateLimit.consume(`entrar:ip:${meta.ip ?? '-'}`, 30, 900);
    const outbox: MailMessage[] = [];
    const result = await withSystem(this.db, async (tx): Promise<LoginOutcome | { kind: 'desconhecida' }> => {
      const e = await this.chaves.conferirEntrada(tx, body, meta.userAgent);
      if (e.kind === 'desconhecida') return e;
      if (e.kind === 'recusada') return { kind: 'falhou', userId: e.userId };
      if (!e.emailVerificado) {
        outbox.push(await this.confirmationMail(tx, e.userId, e.email));
        return { kind: 'nao_confirmado' };
      }
      const tenantId = await this.primeiraEmpresa(tx, e.userId);
      const aviso = await this.avisoDeAcessoNovo(tx, e.userId, e.email, meta);
      if (aviso) outbox.push(aviso);
      const token = await this.sessions.create(tx, { userId: e.userId, tenantId, ip: meta.ip, userAgent: meta.userAgent, mfaMethod: 'chave' });
      const caiu = await cairPorqueEntrou(tx, e.userId);
      if (caiu) {
        outbox.push({
          to: e.email,
          subject: `Liame: pedido de recuperação cancelado (${caiu})`,
          text: `Você entrou com uma chave de acesso, e o pedido de recuperação ${caiu} foi cancelado sozinho. Nada mudou na sua conta. Se não foi você quem entrou, troque a senha agora.\n\n${this.config.appUrl}`,
        });
      }
      await this.auditPerson(tx, e.userId, 'sessao.abrir', { ...onde(meta), metodo: 'chave', chave: e.chave, ...(caiu ? { recuperacao_cancelada: caiu } : {}) });
      return { kind: 'ok', token, userId: e.userId, tenantId };
    });

    if (result.kind === 'desconhecida') {
      throw new AppProblem(401, 'chave-desconhecida', 'Esta chave não abre mais o Liame', 'Ela pode ter sido tirada da conta. Entre com o e-mail e a senha.');
    }
    if (result.kind === 'falhou') {
      const failedUser = result.userId;
      await withSystem(this.db, (tx) => this.auditPerson(tx, failedUser, 'sessao.falhar', { ...onde(meta), metodo: 'chave' }));
      throw new AppProblem(401, 'chave-recusada', 'A chave não foi aceita', 'O aparelho não confirmou a chave. Tente de novo ou entre com o e-mail e a senha.');
    }
    if (result.kind === 'nao_confirmado') {
      await this.deliver(outbox);
      throw new AppProblem(403, 'email-nao-confirmado', 'Confirme seu e-mail', 'Enviamos de novo o link de confirmação.');
    }
    await this.deliver(outbox);
    const { userId, tenantId } = result;
    const me = await withSystem(this.db, (tx) => this.loadMe(tx, userId, tenantId, new Date()), { userId });
    return { token: result.token, me };
  }

  /** A empresa que a sessão abre: o vínculo vivo mais antigo da pessoa. */
  private async primeiraEmpresa(tx: Tx, userId: string): Promise<string | null> {
    const m = await tx.execute<{ tenant_id: string }>(sql`
      select tenant_id from liame.membership
       where user_id = ${userId} and revoked_at is null and (expires_at is null or expires_at > now())
       order by created_at limit 1`);
    return m.rows[0]?.tenant_id ?? null;
  }

  /** Aviso de acesso novo (ADR-013): primeiro login deste navegador em 90 dias, numa conta que já tinha acessos. */
  private async avisoDeAcessoNovo(tx: Tx, userId: string, email: string, meta: RequestMeta): Promise<MailMessage | null> {
    const seen = await tx.execute<{ same: boolean; any: boolean }>(sql`
      select coalesce(bool_or(user_agent is not distinct from ${meta.userAgent}), false) as same, count(*) > 0 as any
        from liame.session where user_id = ${userId} and created_at > now() - interval '90 days'`);
    if (!seen.rows[0]?.any || seen.rows[0].same) return null;
    return {
      to: email,
      subject: 'Liame: novo acesso à sua conta',
      text: `Sua conta foi acessada de um navegador ou aparelho novo.\n\nSe foi você, não precisa fazer nada. Se não foi, troque a senha agora: ${this.config.appUrl}/esqueci-a-senha`,
    };
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
    const u = await tx.execute<{ id: string; name: string; email: string; mfa_configured: boolean; tem_app: boolean; tem_chave: boolean }>(sql`
      select id, name, email,
             exists (select 1 from liame.secret x
                      where x.owner_user_id = app_user.id and x.tenant_id is null and x.purpose = 'totp' and x.revoked_at is null) as tem_app,
             exists (select 1 from liame.passkey k where k.user_id = app_user.id) as tem_chave,
             -- O segundo fator: o app ou uma chave de acesso (A7, W9; D-A7-57).
             (exists (select 1 from liame.secret x
                       where x.owner_user_id = app_user.id and x.tenant_id is null and x.purpose = 'totp' and x.revoked_at is null)
              or exists (select 1 from liame.passkey k where k.user_id = app_user.id)) as mfa_configured
        from liame.app_user where id = ${userId}`);
    const orgs = await tx.execute<{ id: string; name: string; role: RoleKey; kind: OrganizationKind }>(sql`
      select o.id, o.name, m.role_key as role, o.kind
        from liame.membership m join liame.organization o on o.id = m.tenant_id
       where m.user_id = ${userId} and m.revoked_at is null and (m.expires_at is null or m.expires_at > now())
       order by o.name`);
    const user = u.rows[0];
    if (!user) throw new AppProblem(401, 'nao-autenticado', 'Entre de novo', 'A sessão acabou.');
    const pelaAgencia = await this.empresasPelaAgencia(userId);
    const activeRole = orgs.rows.find((o) => o.id === tenantId)?.role ?? null;
    const permissions =
      tenantId && activeRole ? [...permissoesDoVinculo(await this.permissionsOf(tx, tenantId, activeRole), pelaAgencia.has(tenantId))] : [];
    return {
      user: { id: user.id, name: user.name, email: user.email },
      organizations: orgs.rows.map((o) => ({ ...o, via_agency: pelaAgencia.get(o.id) ?? null })),
      active_organization_id: tenantId,
      mfa: !user.mfa_configured ? 'not_configured' : mfaVerifiedAt ? 'verified' : 'required',
      // Quem entra pela agência usa o app em qualquer nível (D-A7-48).
      mfa_enrollment_required: !user.mfa_configured && activeRole !== null && (MFA_REQUIRED.has(activeRole) || pelaAgencia.has(tenantId!)),
      mfa_methods: [...(user.tem_app ? (['totp'] as const) : []), ...(user.tem_chave ? (['chave'] as const) : [])],
      permissions,
    };
  }

  /**
   * As empresas em que a pessoa entra pela agência, com a agência de cada uma (A7, W6, parte 3). Só os vínculos da
   * própria pessoa; no escopo de sistema porque o vínculo da agência com uma empresa que não é a ativa não aparece na
   * RLS da requisição.
   */
  private async empresasPelaAgencia(userId: string): Promise<Map<string, { id: string; name: string }>> {
    const r = await withSystem(this.db, (tx) =>
      tx.execute<{ tenant_id: string; agency_id: string; agency_name: string }>(sql`
        select m.tenant_id, a.id as agency_id, a.name as agency_name
          from liame.membership m
          join liame.partner_link l on l.id = m.partner_link_id
          join liame.organization a on a.id = l.partner_org_id
         where m.user_id = ${userId} and m.revoked_at is null and (m.expires_at is null or m.expires_at > now())`),
    );
    return new Map(r.rows.map((x) => [x.tenant_id, { id: x.agency_id, name: x.agency_name }]));
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
  private async auditPerson(tx: Tx, userId: string, action: string, after?: Record<string, unknown>): Promise<void> {
    const r = await tx.execute<{ name: string }>(sql`select name from liame.app_user where id = ${userId}`);
    await writeAudit(tx, {
      tenantId: null,
      actorType: 'human',
      actorId: userId,
      actorLabel: r.rows[0]?.name ?? null,
      action,
      ...(after ? { after } : {}),
      traceId: activeTraceId(),
      origin: 'api',
    });
  }

  /**
   * A tela mostra os termos vigentes e devolve a versão; se mudaram no meio do caminho, a pessoa confere
   * a versão nova antes de aceitar (a conta grava o que ela viu). Com os Termos novos (W14; D-A7-94), também a versão
   * que vem, quando a tela a mostrou. Devolve as versões declaradas a gravar como aceitas.
   */
  conferirTermos(version: string, proxima?: string): Promise<string[]> {
    return this.termos.conferirNoCadastro(version, proxima);
  }

  /** Grava os aceites do cadastro ou do convite, na transação que cria a pessoa. */
  gravarAceitesDosTermos(tx: Tx, userId: string, versoes: readonly string[], via: 'cadastro' | 'convite'): Promise<void> {
    return this.termos.gravarAceites(tx, userId, versoes, via);
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

/** Onde aconteceu, para a "Atividade de segurança" da pessoa: aparelho e IP com o final escondido. */
function onde(meta: RequestMeta): Record<string, unknown> {
  return { aparelho: descreverAparelho(meta.userAgent), ip: mascararIp(meta.ip) };
}
