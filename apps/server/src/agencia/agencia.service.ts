import type {
  AgencyInvitableRole,
  AgencyInvitationResponse,
  AgencyMemberResponse,
  AgencyRole,
  AgencyTeamResponse,
  CreateAgencyInvitationRequest,
  UpdateAgencyMemberRequest,
} from '@liame/contracts';
import { type Tx, uuidv7 } from '@liame/database';
import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { AGENCY_RANK } from '../auth/permissions.js';
import { RateLimitService } from '../auth/rate-limit.service.js';
import { newToken } from '../auth/tokens.js';
import { APP_CONFIG, type AppConfig } from '../config.js';
import { afterCommit, auditDetail, type AuthContext, currentTx } from '../context/request-context.js';
import { AppProblem } from '../errors/problems.js';
import { Mailer } from '../mail/mailer.js';
import { INVITATION_DAYS } from '../people/people.service.js';
import { ROLE_LABEL } from '../people/grant-rules.js';

type MemberRow = {
  id: string;
  user_id: string;
  name: string;
  email: string;
  role_key: AgencyRole;
  invited_by_name: string | null;
  created_at: Date | string;
  mfa_enabled: boolean;
  last_seen_at: Date | string | null;
};

type InvitationRow = {
  id: string;
  email: string;
  role_key: AgencyInvitableRole;
  expires_at: Date | string;
  invited_by_name: string;
  created_at: Date | string;
};

const notFound = () => new AppProblem(404, 'nao-encontrado', 'Não encontramos', 'Pessoa ou convite não encontrado nesta agência.');
const iso = (v: Date | string) => new Date(v).toISOString();
const isoOrNull = (v: Date | string | null) => (v === null ? null : iso(v));

/**
 * O time da agência (A7, W6, parte 1; D-A7-51): quem está nele, o convite (Administrador ou Membro da agência), mudar o
 * papel e tirar do time. Roda na transação da requisição, com a agência como organização ativa: a RLS limita tudo a ela
 * e cada consulta ainda filtra pela agência (defesa em camadas, ADR-003). A dona não se convida, não muda e não sai;
 * ninguém mexe no próprio papel.
 */
@Injectable()
export class AgencyService {
  constructor(
    private readonly rateLimit: RateLimitService,
    private readonly mailer: Mailer,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async team(auth: AuthContext): Promise<AgencyTeamResponse> {
    const tx = currentTx();
    const agencyId = await agencyOf(tx, auth);
    const org = await tx.execute<{ id: string; name: string; cnpj: string | null }>(
      sql`select id, name, cnpj from liame.organization where id = ${agencyId}`,
    );
    const members = await tx.execute<MemberRow>(sql`
      select m.id, m.user_id, u.name, u.email, m.role_key, i.name as invited_by_name, m.created_at,
             u.mfa_enabled_at is not null as mfa_enabled, m.last_seen_at
        from liame.membership m
        join liame.app_user u on u.id = m.user_id
        left join liame.app_user i on i.id = m.invited_by
       where m.tenant_id = ${agencyId} and m.revoked_at is null and (m.expires_at is null or m.expires_at > now())`);
    const invitations = await tx.execute<InvitationRow>(sql`
      select v.id, v.email, v.role_key, v.expires_at, u.name as invited_by_name, v.created_at
        from liame.invitation v join liame.app_user u on u.id = v.invited_by
       where v.tenant_id = ${agencyId} and v.accepted_at is null and v.revoked_at is null and v.expires_at > now()
       order by v.created_at desc`);
    return {
      agency: org.rows[0]!,
      members: members.rows
        .map(toMember)
        .sort((a, b) => AGENCY_RANK[b.role] - AGENCY_RANK[a.role] || a.name.localeCompare(b.name, 'pt-BR')),
      invitations: invitations.rows.map(toInvitation),
    };
  }

  async invite(auth: AuthContext, input: CreateAgencyInvitationRequest): Promise<AgencyInvitationResponse> {
    const tx = currentTx();
    const agencyId = await agencyOf(tx, auth);
    await this.rateLimit.consume(`convites:agencia:${agencyId}`, 50, 86400);
    const member = await tx.execute(sql`
      select 1 from liame.membership m join liame.app_user u on u.id = m.user_id
       where m.tenant_id = ${agencyId} and u.email = ${input.email} and m.revoked_at is null
         and (m.expires_at is null or m.expires_at > now())`);
    if (member.rows[0]) throw new AppProblem(409, 'ja-esta-no-time', 'Já está no time', 'Este e-mail já está no time da agência.');

    // Convidar de novo substitui o convite em aberto: o link antigo deixa de valer (como nas empresas).
    await tx.execute(sql`
      update liame.invitation set revoked_at = now()
       where tenant_id = ${agencyId} and email = ${input.email} and accepted_at is null and revoked_at is null`);
    const { token, hash } = newToken();
    const id = uuidv7();
    const r = await tx.execute<InvitationRow>(sql`
      insert into liame.invitation (id, tenant_id, email, role_key, token_hash, expires_at, invited_by)
      values (${id}, ${agencyId}, ${input.email}, ${input.role}, ${hash}, now() + make_interval(days => ${INVITATION_DAYS}), ${auth.userId})
      returning id, email, role_key, expires_at, ${auth.name}::text as invited_by_name, created_at`);
    auditDetail({ resourceId: id, after: { role: input.role } });
    const agency = await this.agencyName(tx, agencyId);
    const link = `${this.config.appUrl}/convite?token=${token}`;
    afterCommit(() =>
      this.mailer.send({
        to: input.email,
        subject: `Liame: ${auth.name} convidou você para o time de ${agency}`,
        text:
          `${auth.name} convidou você para o time de ${agency} no Liame como ${ROLE_LABEL[input.role]}.\n\n` +
          `Para aceitar, abra o link em até ${INVITATION_DAYS} dias:\n\n${link}\n\n` +
          'Você entra com o próprio login e o app autenticador, e só trabalha nos clientes em que a agência colocar você. ' +
          'O convite só vale para este e-mail. Se não esperava por ele, ignore esta mensagem.',
      }),
    );
    return toInvitation(r.rows[0]!);
  }

  async revokeInvitation(auth: AuthContext, id: string): Promise<void> {
    const tx = currentTx();
    const agencyId = await agencyOf(tx, auth);
    const r = await tx.execute(sql`
      update liame.invitation set revoked_at = now()
       where id = ${id} and tenant_id = ${agencyId} and accepted_at is null and revoked_at is null`);
    if (r.rowCount !== 1) throw notFound();
  }

  async updateMember(auth: AuthContext, id: string, patch: UpdateAgencyMemberRequest): Promise<AgencyMemberResponse> {
    const tx = currentTx();
    const agencyId = await agencyOf(tx, auth);
    const target = await this.target(tx, auth, agencyId, id);
    await tx.execute(sql`update liame.membership set role_key = ${patch.role} where id = ${id} and tenant_id = ${agencyId}`);
    auditDetail({ before: { user_id: target.user_id, role: target.role_key }, after: { user_id: target.user_id, role: patch.role } });
    return toMember({ ...target, role_key: patch.role });
  }

  /**
   * Tira a pessoa do time na hora: toda requisição confere o vínculo, então a próxima chamada dela na agência já é
   * recusada. As sessões dela continuam valendo para as outras organizações que tiver.
   */
  async removeMember(auth: AuthContext, id: string): Promise<void> {
    const tx = currentTx();
    const agencyId = await agencyOf(tx, auth);
    const target = await this.target(tx, auth, agencyId, id);
    await tx.execute(sql`update liame.membership set revoked_at = now() where id = ${id} and tenant_id = ${agencyId} and revoked_at is null`);
    auditDetail({ before: { user_id: target.user_id, role: target.role_key } });
  }

  // ------------------------------------------------------------------ apoio

  /** A pessoa-alvo, com as travas: nunca a dona, nunca a si mesma, nunca acima de quem pede. */
  private async target(tx: Tx, auth: AuthContext, agencyId: string, id: string): Promise<MemberRow> {
    const r = await tx.execute<MemberRow>(sql`
      select m.id, m.user_id, u.name, u.email, m.role_key, i.name as invited_by_name, m.created_at,
             u.mfa_enabled_at is not null as mfa_enabled, m.last_seen_at
        from liame.membership m
        join liame.app_user u on u.id = m.user_id
        left join liame.app_user i on i.id = m.invited_by
       where m.id = ${id} and m.tenant_id = ${agencyId} and m.revoked_at is null
       for update of m`);
    const target = r.rows[0];
    if (!target) throw notFound();
    if (target.role_key === 'agencia_dona') {
      throw new AppProblem(403, 'dona-intocavel', 'A dona não muda', 'Ninguém muda nem tira a dona da agência.');
    }
    if (target.user_id === auth.userId) {
      throw new AppProblem(403, 'proprio-acesso', 'Seu próprio acesso', 'Você não muda nem tira o seu próprio papel.');
    }
    if (AGENCY_RANK[target.role_key] > AGENCY_RANK[auth.roleKey as AgencyRole]) {
      throw new AppProblem(403, 'nivel-acima-do-seu', 'Papel acima do seu', 'Você não mexe em quem tem papel acima do seu.');
    }
    return target;
  }

  private async agencyName(tx: Tx, agencyId: string): Promise<string> {
    const r = await tx.execute<{ name: string }>(sql`select name from liame.organization where id = ${agencyId}`);
    return r.rows[0]?.name ?? 'a agência';
  }
}

/**
 * A agência ativa da sessão. As permissões `agencia.*` só existem nos papéis da agência, que só valem numa agência (o
 * banco confere); a conferência do tipo aqui é a segunda camada.
 */
async function agencyOf(tx: Tx, auth: AuthContext): Promise<string> {
  if (!auth.tenantId) throw new AppProblem(403, 'sem-empresa-ativa', 'Escolha uma organização', 'Selecione a agência para continuar.');
  const r = await tx.execute<{ kind: string }>(sql`select kind from liame.organization where id = ${auth.tenantId}`);
  if (r.rows[0]?.kind !== 'agencia') {
    throw new AppProblem(403, 'nao-e-agencia', 'Não é uma agência', 'Esta tela é da agência: troque para ela no seletor do alto do menu.');
  }
  return auth.tenantId;
}

function toMember(r: MemberRow): AgencyMemberResponse {
  return {
    id: r.id,
    user_id: r.user_id,
    name: r.name,
    email: r.email,
    role: r.role_key,
    invited_by_name: r.invited_by_name,
    created_at: iso(r.created_at),
    mfa_enabled: r.mfa_enabled,
    last_seen_at: isoOrNull(r.last_seen_at),
  };
}

function toInvitation(r: InvitationRow): AgencyInvitationResponse {
  return {
    id: r.id,
    email: r.email,
    role: r.role_key,
    expires_at: iso(r.expires_at),
    invited_by_name: r.invited_by_name,
    created_at: iso(r.created_at),
  };
}
