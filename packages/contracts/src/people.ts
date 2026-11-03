import { z } from 'zod';
import { CompanyRole, Email, OrganizationKind, Password, RoleKey, TermsVersion } from './auth.js';

// Pessoas e acessos (ADR-017): o dono convida por e-mail quem administra por ele.
// Dinheiro em micros (1 real = 1.000.000), como no resto do modelo de dados.

/**
 * Níveis que se convidam numa empresa: o dono não se convida, a propriedade só se transfere. Os papéis da agência ficam
 * de fora: só valem na agência, pelo convite do time dela (`agency.ts`).
 */
export const InvitableRole = CompanyRole.exclude(['dono']);
export type InvitableRole = z.infer<typeof InvitableRole>;

/** Papéis que se convidam no time da agência (D-A7-51): a dona não se convida, como o dono. */
export const AgencyInvitableRole = RoleKey.extract(['agencia_admin', 'agencia_membro']);
export type AgencyInvitableRole = z.infer<typeof AgencyInvitableRole>;

/** Identificador na rota (`/v1/members/{id}`). */
export const ResourceId = z.uuid({ error: 'Identificador inválido' });

export const Micros = z.int().min(0).max(Number.MAX_SAFE_INTEGER);
export const FutureDate = z.iso.datetime({ offset: true }).refine((v) => Date.parse(v) > Date.now(), { error: 'Use uma data no futuro' });

export const MemberResponse = z.strictObject({
  id: z.uuid(),
  user_id: z.uuid(),
  name: z.string(),
  email: z.string(),
  /** O nível na empresa: os papéis da agência nunca aparecem aqui. */
  role: CompanyRole,
  /** Limite de aprovação por ação; nulo = sem limite (só o dono concede). */
  approve_limit_micros: Micros.nullable(),
  /** Acima do limite, o dono também aprova. */
  dual_approval: z.boolean(),
  billing_access: z.boolean(),
  expires_at: z.string().nullable(),
  invited_by_name: z.string().nullable(),
  created_at: z.string(),
  /** App autenticador ativo (o segredo nunca sai; só o sim ou não). */
  mfa_enabled: z.boolean(),
  /** Último acesso nesta empresa; nulo = ainda não entrou. */
  last_seen_at: z.string().nullable(),
  /** A pessoa vem de uma agência (A7, W6, parte 3): o vínculo e o nome da agência ("da Agência Fogo", D-A7-48). */
  partner: z.strictObject({ link_id: z.uuid(), agency_name: z.string() }).nullable().optional(),
});
export type MemberResponse = z.infer<typeof MemberResponse>;

export const InvitationResponse = z.strictObject({
  id: z.uuid(),
  email: z.string(),
  role: InvitableRole,
  approve_limit_micros: Micros.nullable(),
  dual_approval: z.boolean(),
  billing_access: z.boolean(),
  access_expires_at: z.string().nullable(),
  /** O link do convite vence nesta data (7 dias). */
  expires_at: z.string(),
  invited_by_name: z.string(),
  created_at: z.string(),
});
export type InvitationResponse = z.infer<typeof InvitationResponse>;

export const PeopleResponse = z.strictObject({
  members: z.array(MemberResponse),
  invitations: z.array(InvitationResponse),
});
export type PeopleResponse = z.infer<typeof PeopleResponse>;

export const CreateInvitationRequest = z.strictObject({
  email: Email,
  role: InvitableRole,
  approve_limit_micros: Micros.nullable().optional(),
  dual_approval: z.boolean().default(true),
  billing_access: z.boolean().default(false),
  access_expires_at: FutureDate.nullable().optional(),
});
export type CreateInvitationRequest = z.infer<typeof CreateInvitationRequest>;

/** Troca parcial do acesso de alguém: só os campos enviados mudam. */
export const UpdateMemberRequest = z
  .strictObject({
    role: InvitableRole.optional(),
    approve_limit_micros: Micros.nullable().optional(),
    dual_approval: z.boolean().optional(),
    billing_access: z.boolean().optional(),
    expires_at: FutureDate.nullable().optional(),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), { error: 'Envie pelo menos um campo' });
export type UpdateMemberRequest = z.infer<typeof UpdateMemberRequest>;

/** O que o link do convite mostra antes de aceitar. */
export const InvitationPreviewResponse = z.strictObject({
  organization_name: z.string(),
  /** A empresa, ou a agência quando o convite é para o time dela (A7, W6). */
  organization_kind: OrganizationKind,
  /** O nível do convite: um da empresa ou, no time da agência, Administrador ou Membro da agência. */
  role: RoleKey.exclude(['dono', 'agencia_dona']),
  email: z.string(),
  invited_by_name: z.string(),
  /** O e-mail convidado já tem conta: a tela pede para entrar em vez de criar o login. */
  account_exists: z.boolean(),
});
export type InvitationPreviewResponse = z.infer<typeof InvitationPreviewResponse>;

/** Quem ainda não tem conta cria o login pelo próprio convite (o link prova o e-mail). */
export const InvitationSignupRequest = z.strictObject({
  token: z.string().min(20).max(200),
  name: z.string().trim().min(1).max(200),
  password: Password,
  terms_version: TermsVersion,
  /**
   * A versão que vem (A7, W14; D-A7-94): quem se cadastra entre o aviso e o dia aceita as duas, a de hoje e a que vem
   * (`next` de `GET /v1/legal/terms`). Sem ela, a pessoa vê o aviso depois de entrar.
   */
  next_terms_version: TermsVersion.optional(),
});
export type InvitationSignupRequest = z.infer<typeof InvitationSignupRequest>;
