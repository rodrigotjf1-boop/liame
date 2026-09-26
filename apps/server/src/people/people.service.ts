import type {
  CreateInvitationRequest,
  InvitableRole,
  InvitationResponse,
  MemberResponse,
  PeopleResponse,
  RoleKey,
  UpdateMemberRequest,
} from '@liame/contracts';
import { type Tx, uuidv7 } from '@liame/database';
import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { ROLE_RANK } from '../auth/permissions.js';
import { RateLimitService } from '../auth/rate-limit.service.js';
import { newToken } from '../auth/tokens.js';
import { APP_CONFIG, type AppConfig } from '../config.js';
import { afterCommit, auditDetail, type AuthContext, currentTx } from '../context/request-context.js';
import { AppProblem } from '../errors/problems.js';
import { emitEvent } from '../events/outbox.js';
import { Mailer } from '../mail/mailer.js';
import { APPROVER_ROLES, type CheckedGrant, checkGrant, type Grantor, ROLE_LABEL } from './grant-rules.js';

export const INVITATION_DAYS = 7;

type MemberRow = {
  id: string;
  user_id: string;
  name: string;
  email: string;
  role_key: RoleKey;
  approve_limit_micros: string | null;
  dual_approval: boolean;
  billing_access: boolean;
  expires_at: Date | string | null;
  invited_by_name: string | null;
  created_at: Date | string;
};

type InvitationRow = {
  id: string;
  email: string;
  role_key: InvitableRole;
  approve_limit_micros: string | null;
  dual_approval: boolean;
  billing_access: boolean;
  access_expires_at: Date | string | null;
  expires_at: Date | string;
  invited_by_name: string;
  created_at: Date | string;
};

const notFound = () => new AppProblem(404, 'nao-encontrado', 'Não encontramos', 'Pessoa ou convite não encontrado nesta empresa.');
const iso = (v: Date | string) => new Date(v).toISOString();
const isoOrNull = (v: Date | string | null) => (v === null ? null : iso(v));
const micros = (v: string | null) => (v === null ? null : Number(v));

/**
 * Pessoas e acessos da empresa ativa (ADR-017). Roda na transação da requisição: a RLS limita tudo à
 * empresa da sessão e cada consulta ainda filtra pelo tenant (defesa em camadas, ADR-003).
 */
@Injectable()
export class PeopleService {
  constructor(
    private readonly rateLimit: RateLimitService,
    private readonly mailer: Mailer,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async list(auth: AuthContext): Promise<PeopleResponse> {
    const tx = currentTx();
    const tenantId = tenantOf(auth);
    const members = await tx.execute<MemberRow>(sql`
      select m.id, m.user_id, u.name, u.email, m.role_key, m.approve_limit_micros, m.dual_approval, m.billing_access,
             m.expires_at, i.name as invited_by_name, m.created_at
        from liame.membership m
        join liame.app_user u on u.id = m.user_id
        left join liame.app_user i on i.id = m.invited_by
       where m.tenant_id = ${tenantId} and m.revoked_at is null and (m.expires_at is null or m.expires_at > now())`);
    const invitations = await tx.execute<InvitationRow>(sql`
      select v.id, v.email, v.role_key, v.approve_limit_micros, v.dual_approval, v.billing_access, v.access_expires_at,
             v.expires_at, u.name as invited_by_name, v.created_at
        from liame.invitation v join liame.app_user u on u.id = v.invited_by
       where v.tenant_id = ${tenantId} and v.accepted_at is null and v.revoked_at is null and v.expires_at > now()
       order by v.created_at desc`);
    return {
      members: members.rows
        .map(toMember)
        .sort((a, b) => ROLE_RANK[b.role] - ROLE_RANK[a.role] || a.name.localeCompare(b.name, 'pt-BR')),
      invitations: invitations.rows.map(toInvitation),
    };
  }

  async invite(auth: AuthContext, input: CreateInvitationRequest): Promise<InvitationResponse> {
    const tx = currentTx();
    const tenantId = tenantOf(auth);
    await this.rateLimit.consume(`convites:empresa:${tenantId}`, 50, 86400);
    const by = await this.grantor(tx, auth);
    const grant = checkGrant(
      by,
      {
        role: input.role,
        approveLimitMicros: input.approve_limit_micros,
        dualApproval: input.dual_approval,
        billingAccess: input.billing_access,
      },
      null,
    );

    const member = await tx.execute(sql`
      select 1 from liame.membership m join liame.app_user u on u.id = m.user_id
       where m.tenant_id = ${tenantId} and u.email = ${input.email} and m.revoked_at is null
         and (m.expires_at is null or m.expires_at > now())`);
    if (member.rows[0]) throw new AppProblem(409, 'ja-tem-acesso', 'Já tem acesso', 'Este e-mail já tem acesso a esta empresa.');

    // Convidar de novo substitui o convite em aberto: o link antigo deixa de valer.
    await tx.execute(sql`
      update liame.invitation set revoked_at = now()
       where tenant_id = ${tenantId} and email = ${input.email} and accepted_at is null and revoked_at is null`);
    const { token, hash } = newToken();
    const id = uuidv7();
    const r = await tx.execute<InvitationRow>(sql`
      insert into liame.invitation (id, tenant_id, email, role_key, approve_limit_micros, dual_approval, billing_access,
                                    access_expires_at, token_hash, expires_at, invited_by)
      values (${id}, ${tenantId}, ${input.email}, ${grant.role}, ${grant.approveLimitMicros}, ${grant.dualApproval},
              ${grant.billingAccess}, ${input.access_expires_at ?? null}, ${hash},
              now() + make_interval(days => ${INVITATION_DAYS}), ${auth.userId})
      returning id, email, role_key, approve_limit_micros, dual_approval, billing_access, access_expires_at, expires_at,
                ${auth.name}::text as invited_by_name, created_at`);

    // Evento sem o e-mail: webhook sai para fora, e o convite ainda não é da pessoa.
    await emitEvent(tx, { tenantId, type: 'liame.invitation.created', subject: id, data: { invitation_id: id, role: grant.role } });
    auditDetail({ resourceId: id, after: grantDetail(grant) });
    const org = await this.organizationName(tx, tenantId);
    const link = `${this.config.appUrl}/convite?token=${token}`;
    afterCommit(() =>
      this.mailer.send({
        to: input.email,
        subject: `Liame: ${auth.name} convidou você para ${org}`,
        text:
          `${auth.name} convidou você para acessar ${org} no Liame como ${ROLE_LABEL[grant.role]}.\n\n` +
          `Para aceitar, abra o link em até ${INVITATION_DAYS} dias:\n\n${link}\n\n` +
          'O convite só vale para este e-mail. Se não esperava por ele, ignore esta mensagem.',
      }),
    );
    if (by.role !== 'dono') {
      await this.notifyOwners(tx, tenantId, `Liame: ${auth.name} convidou uma pessoa`, [
        `${auth.name} convidou ${input.email} para ${org} como ${ROLE_LABEL[grant.role]}.`,
        describeLimit(grant),
      ]);
    }
    return toInvitation(r.rows[0]!);
  }

  async revokeInvitation(auth: AuthContext, id: string): Promise<void> {
    const r = await currentTx().execute(sql`
      update liame.invitation set revoked_at = now()
       where id = ${id} and tenant_id = ${tenantOf(auth)} and accepted_at is null and revoked_at is null`);
    if (r.rowCount !== 1) throw notFound();
  }

  async updateMember(auth: AuthContext, id: string, patch: UpdateMemberRequest): Promise<MemberResponse> {
    const tx = currentTx();
    const tenantId = tenantOf(auth);
    const target = await this.target(tx, auth, id);
    const by = await this.grantor(tx, auth);
    const current: CheckedGrant = {
      role: target.role_key as InvitableRole,
      approveLimitMicros: micros(target.approve_limit_micros),
      dualApproval: target.dual_approval,
      billingAccess: target.billing_access,
    };
    const role = patch.role ?? current.role;
    // Quem passa a aprovar agora precisa de um limite informado; quem já aprovava mantém o dele.
    const keepLimit = APPROVER_ROLES.has(current.role) ? current.approveLimitMicros : undefined;
    const grant = checkGrant(
      by,
      {
        role,
        approveLimitMicros: patch.approve_limit_micros !== undefined ? patch.approve_limit_micros : keepLimit,
        dualApproval: patch.dual_approval ?? current.dualApproval,
        billingAccess: patch.billing_access ?? current.billingAccess,
      },
      current,
    );
    const expiresAt = patch.expires_at !== undefined ? patch.expires_at : isoOrNull(target.expires_at);
    await tx.execute(sql`
      update liame.membership
         set role_key = ${grant.role}, approve_limit_micros = ${grant.approveLimitMicros}, dual_approval = ${grant.dualApproval},
             billing_access = ${grant.billingAccess}, expires_at = ${expiresAt}
       where id = ${id} and tenant_id = ${tenantId}`);
    auditDetail({ before: grantDetail(current), after: grantDetail(grant) });
    await emitEvent(tx, {
      tenantId,
      type: 'liame.member.updated',
      subject: id,
      data: {
        member_id: id,
        user_id: target.user_id,
        role: grant.role,
        approve_limit_micros: grant.approveLimitMicros,
        dual_approval: grant.dualApproval,
        billing_access: grant.billingAccess,
      },
    });

    if (by.role !== 'dono') {
      const org = await this.organizationName(tx, tenantId);
      await this.notifyOwners(tx, tenantId, `Liame: ${auth.name} mudou o acesso de ${target.name}`, [
        `${auth.name} mudou o acesso de ${target.name} (${target.email}) em ${org}.`,
        `Nível: ${ROLE_LABEL[current.role]} → ${ROLE_LABEL[grant.role]}.`,
        describeLimit(grant),
      ]);
    }
    return toMember({
      ...target,
      role_key: grant.role,
      approve_limit_micros: grant.approveLimitMicros === null ? null : String(grant.approveLimitMicros),
      dual_approval: grant.dualApproval,
      billing_access: grant.billingAccess,
      expires_at: expiresAt,
    });
  }

  /**
   * Remove o acesso na hora (ADR-017): toda requisição confere o vínculo, então a próxima chamada da pessoa
   * nesta empresa já é recusada. As sessões dela continuam valendo para as outras empresas que tiver.
   */
  async removeMember(auth: AuthContext, id: string): Promise<void> {
    const tx = currentTx();
    const tenantId = tenantOf(auth);
    const target = await this.target(tx, auth, id);
    await tx.execute(sql`update liame.membership set revoked_at = now() where id = ${id} and tenant_id = ${tenantId} and revoked_at is null`);
    await emitEvent(tx, { tenantId, type: 'liame.member.removed', subject: id, data: { member_id: id, user_id: target.user_id } });
    auditDetail({ before: { user_id: target.user_id, role: target.role_key } });
    if (auth.roleKey !== 'dono') {
      const org = await this.organizationName(tx, tenantId);
      await this.notifyOwners(tx, tenantId, `Liame: ${auth.name} removeu o acesso de ${target.name}`, [
        `${auth.name} removeu o acesso de ${target.name} (${target.email}) a ${org}.`,
      ]);
    }
  }

  // ------------------------------------------------------------------ apoio

  /** A pessoa-alvo, com as travas comuns a mudar e a remover: nunca o dono, nunca a si mesma, nunca acima. */
  private async target(tx: Tx, auth: AuthContext, id: string): Promise<MemberRow> {
    const r = await tx.execute<MemberRow>(sql`
      select m.id, m.user_id, u.name, u.email, m.role_key, m.approve_limit_micros, m.dual_approval, m.billing_access,
             m.expires_at, i.name as invited_by_name, m.created_at
        from liame.membership m
        join liame.app_user u on u.id = m.user_id
        left join liame.app_user i on i.id = m.invited_by
       where m.id = ${id} and m.tenant_id = ${tenantOf(auth)} and m.revoked_at is null
       for update of m`);
    const target = r.rows[0];
    if (!target) throw notFound();
    if (target.role_key === 'dono') {
      throw new AppProblem(403, 'dono-intocavel', 'O dono não muda', 'Ninguém muda nem remove o acesso do dono. A propriedade só se transfere.');
    }
    if (target.user_id === auth.userId) {
      throw new AppProblem(403, 'proprio-acesso', 'Seu próprio acesso', 'Você não muda nem remove o seu próprio acesso.');
    }
    if (ROLE_RANK[target.role_key] > ROLE_RANK[auth.roleKey!]) {
      throw new AppProblem(403, 'nivel-acima-do-seu', 'Nível acima do seu', 'Você não mexe no acesso de quem tem nível acima do seu.');
    }
    return target;
  }

  private async grantor(tx: Tx, auth: AuthContext): Promise<Grantor> {
    const r = await tx.execute<{ role_key: RoleKey; approve_limit_micros: string | null }>(sql`
      select role_key, approve_limit_micros from liame.membership
       where tenant_id = ${tenantOf(auth)} and user_id = ${auth.userId} and revoked_at is null`);
    const row = r.rows[0];
    if (!row) throw new AppProblem(403, 'sem-empresa-ativa', 'Escolha uma empresa', 'Selecione uma empresa com acesso ativo.');
    return { role: row.role_key, approveLimitMicros: micros(row.approve_limit_micros) };
  }

  private async organizationName(tx: Tx, tenantId: string): Promise<string> {
    const r = await tx.execute<{ name: string }>(sql`select name from liame.organization where id = ${tenantId}`);
    return r.rows[0]?.name ?? 'sua empresa';
  }

  /** Aviso imediato ao dono (ADR-017), depois do commit. */
  private async notifyOwners(tx: Tx, tenantId: string, subject: string, lines: string[]): Promise<void> {
    const owners = await tx.execute<{ email: string }>(sql`
      select u.email from liame.membership m join liame.app_user u on u.id = m.user_id
       where m.tenant_id = ${tenantId} and m.role_key = 'dono' and m.revoked_at is null`);
    const text = `${lines.join('\n')}\n\nVeja quem tem acesso: ${this.config.appUrl}/pessoas\nSe você não reconhece esta mudança, remova o acesso e troque a senha.`;
    for (const { email } of owners.rows) afterCommit(() => this.mailer.send({ to: email, subject, text }));
  }
}

function tenantOf(auth: AuthContext): string {
  if (!auth.tenantId) throw new AppProblem(403, 'sem-empresa-ativa', 'Escolha uma empresa', 'Selecione uma empresa com acesso ativo.');
  return auth.tenantId;
}

/** O acesso concedido, para a auditoria (sem e-mail). */
function grantDetail(g: CheckedGrant): Record<string, unknown> {
  return { role: g.role, approve_limit_micros: g.approveLimitMicros, dual_approval: g.dualApproval, billing_access: g.billingAccess };
}

function describeLimit(grant: CheckedGrant): string {
  if (!APPROVER_ROLES.has(grant.role)) return 'Sem aprovação de gastos.';
  const limit =
    grant.approveLimitMicros === null
      ? 'sem limite'
      : (grant.approveLimitMicros / 1_000_000).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  return `Limite de aprovação por ação: ${limit}${grant.dualApproval ? '; acima disso, o dono também aprova' : ''}.`;
}

function toMember(r: MemberRow): MemberResponse {
  return {
    id: r.id,
    user_id: r.user_id,
    name: r.name,
    email: r.email,
    role: r.role_key,
    approve_limit_micros: micros(r.approve_limit_micros),
    dual_approval: r.dual_approval,
    billing_access: r.billing_access,
    expires_at: isoOrNull(r.expires_at),
    invited_by_name: r.invited_by_name,
    created_at: iso(r.created_at),
  };
}

function toInvitation(r: InvitationRow): InvitationResponse {
  return {
    id: r.id,
    email: r.email,
    role: r.role_key,
    approve_limit_micros: micros(r.approve_limit_micros),
    dual_approval: r.dual_approval,
    billing_access: r.billing_access,
    access_expires_at: isoOrNull(r.access_expires_at),
    expires_at: iso(r.expires_at),
    invited_by_name: r.invited_by_name,
    created_at: iso(r.created_at),
  };
}
