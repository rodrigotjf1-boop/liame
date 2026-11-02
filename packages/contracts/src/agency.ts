import { z } from 'zod';
import { AgencyRole, Cnpj, Email } from './auth.js';
import { AgencyInvitableRole } from './people.js';

// A agência (A7, W6; ADR-017; D-A7-45 e D-A7-51): a organização do tipo agência, com o time dela. Os clientes, o pedido
// de vínculo e o time dentro de cada cliente vêm nas partes seguintes.

/** Quem já tem login abre a conta da agência em Sua conta (D-A7-45): o time, sem marca e sem assinatura. */
export const CreateAgencyRequest = z.strictObject({
  name: z.string().trim().min(1).max(200),
  cnpj: Cnpj.optional(),
});
export type CreateAgencyRequest = z.infer<typeof CreateAgencyRequest>;

/** Uma pessoa do time da agência. */
export const AgencyMemberResponse = z.strictObject({
  id: z.uuid(),
  user_id: z.uuid(),
  name: z.string(),
  email: z.string(),
  role: AgencyRole,
  invited_by_name: z.string().nullable(),
  created_at: z.string(),
  /** App autenticador ativo: sem ele, a pessoa não entra em nenhum cliente (D-A7-48). */
  mfa_enabled: z.boolean(),
  /** Último acesso à agência; nulo = ainda não entrou. */
  last_seen_at: z.string().nullable(),
});
export type AgencyMemberResponse = z.infer<typeof AgencyMemberResponse>;

/** Um convite em aberto para o time da agência. */
export const AgencyInvitationResponse = z.strictObject({
  id: z.uuid(),
  email: z.string(),
  role: AgencyInvitableRole,
  /** O link do convite vence nesta data (7 dias). */
  expires_at: z.string(),
  invited_by_name: z.string(),
  created_at: z.string(),
});
export type AgencyInvitationResponse = z.infer<typeof AgencyInvitationResponse>;

/** O time da agência: quem está nele e os convites em aberto. */
export const AgencyTeamResponse = z.strictObject({
  agency: z.strictObject({ id: z.uuid(), name: z.string(), cnpj: z.string().nullable() }),
  members: z.array(AgencyMemberResponse),
  invitations: z.array(AgencyInvitationResponse),
});
export type AgencyTeamResponse = z.infer<typeof AgencyTeamResponse>;

/** Convidar para a agência: o e-mail e o papel (Administrador ou Membro). */
export const CreateAgencyInvitationRequest = z.strictObject({
  email: Email,
  role: AgencyInvitableRole,
});
export type CreateAgencyInvitationRequest = z.infer<typeof CreateAgencyInvitationRequest>;

/** Mudar o papel de alguém do time (Administrador ↔ Membro). */
export const UpdateAgencyMemberRequest = z.strictObject({ role: AgencyInvitableRole });
export type UpdateAgencyMemberRequest = z.infer<typeof UpdateAgencyMemberRequest>;
