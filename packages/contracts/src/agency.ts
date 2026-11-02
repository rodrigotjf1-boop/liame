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

// ------------------------------------------------------------------ a marca da agência (A7, W7, parte 3; D-A7-69, D-A7-81)

/** O logo da agência: PNG ou JPG, até 1 MB (SVG não, porque pode levar código; D-A7-69). */
export const AGENCY_LOGO_LIMITS = {
  /** O arquivo enviado: até 1 MB. */
  maxBytes: 1024 * 1024,
  /** O lado menor do arquivo enviado: 32 px ou mais. */
  minShortSide: 32,
  /** O lado maior do arquivo enviado: até 4.000 px. */
  maxLongSide: 4000,
  /** A cópia guardada cabe em 384 × 96 px (o logo aparece até 48 px de altura, em tela de alta densidade). */
  storedMaxWidth: 384,
  storedMaxHeight: 96,
} as const;

/** Como o relatório do mês sai (D-A7-67): a agência revisa e manda (com o lembrete do dia 3), ou sai sozinho no dia 2. */
export const AgencyReportMode = z.enum(['revisar', 'sozinho']);
export type AgencyReportMode = z.infer<typeof AgencyReportMode>;

/** A marca da agência como a agência a vê: o nome, o logo, o e-mail de resposta e como o relatório sai. */
export const AgencyBrandResponse = z.strictObject({
  name: z.string(),
  /** O logo regravado pelo servidor; o endereço vale poucos minutos. Nulo sem logo ou sem o armazenamento de imagens. */
  logo: z
    .strictObject({
      url: z.string().nullable(),
      width: z.int().min(1).max(AGENCY_LOGO_LIMITS.storedMaxWidth),
      height: z.int().min(1).max(AGENCY_LOGO_LIMITS.storedMaxHeight),
      updated_at: z.string(),
    })
    .nullable(),
  /** O e-mail que vale no "Responder" do relatório: só depois do link de confirmação. */
  reply_to: z.strictObject({ email: z.string(), confirmed_at: z.string() }).nullable(),
  /** O e-mail novo esperando o link de confirmação (vale 24 horas). */
  pending_reply_to: z.strictObject({ email: z.string(), expires_at: z.string() }).nullable(),
  report_mode: AgencyReportMode,
  /** O armazenamento de imagens está configurado (sem ele, o logo não é aceito). */
  logo_available: z.boolean(),
});
export type AgencyBrandResponse = z.infer<typeof AgencyBrandResponse>;

/**
 * Mudar a marca: o nome da agência, o e-mail de resposta (`null` tira; um e-mail novo manda o link de confirmação e só
 * vale depois dele) e como o relatório sai. O que não vem fica como está.
 */
export const UpdateAgencyBrandRequest = z
  .strictObject({
    name: z.string().trim().min(1, { error: 'Falta o nome da agência' }).max(60, { error: 'Até 60 caracteres' }).optional(),
    reply_to_email: Email.nullable().optional(),
    report_mode: AgencyReportMode.optional(),
  })
  .refine((v) => [v.name, v.reply_to_email, v.report_mode].some((x) => x !== undefined), { error: 'Envie pelo menos um campo' });
export type UpdateAgencyBrandRequest = z.infer<typeof UpdateAgencyBrandRequest>;

/** O e-mail de resposta confirmado pelo link: o nome da agência e o endereço que passou a valer. */
export const AgencyReplyToConfirmedResponse = z.strictObject({ agency_name: z.string(), email: z.string() });
export type AgencyReplyToConfirmedResponse = z.infer<typeof AgencyReplyToConfirmedResponse>;
