import { z } from 'zod';
import { Email, Password, RoleKey } from './auth.js';

// Pessoas e acessos (ADR-017): o dono convida por e-mail quem administra por ele.
// Dinheiro em micros (1 real = 1.000.000), como no resto do modelo de dados.

/** Níveis que se convidam: o dono não se convida, a propriedade só se transfere. */
export const InvitableRole = RoleKey.exclude(['dono']);
export type InvitableRole = z.infer<typeof InvitableRole>;

/** Identificador na rota (`/v1/members/{id}`). */
export const ResourceId = z.uuid({ error: 'Identificador inválido' });

const Micros = z.int().min(0).max(Number.MAX_SAFE_INTEGER);
const FutureDate = z.iso.datetime({ offset: true }).refine((v) => Date.parse(v) > Date.now(), { error: 'Use uma data no futuro' });

export const MemberResponse = z.strictObject({
  id: z.uuid(),
  user_id: z.uuid(),
  name: z.string(),
  email: z.string(),
  role: RoleKey,
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
  role: InvitableRole,
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
});
export type InvitationSignupRequest = z.infer<typeof InvitationSignupRequest>;
