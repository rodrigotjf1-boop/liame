import { z } from 'zod';
import { AgencyRole, CompanyRole, Email } from './auth.js';
import { FutureDate, Micros } from './people.js';

// O vínculo de parceiro (A7, W6, parte 2; ADR-017; D-A7-46 a D-A7-50): a agência pede pelo e-mail do Dono; o Dono
// aceita com o nível máximo, o limite e o código do app, recusa, muda e desfaz; a agência pode deixar o cliente.
// O time da agência dentro de cada empresa vem na parte 3.

/** O que a agência pede e o máximo que o Dono dá: nunca o Dono, nunca "só relatórios" (D-A7-47). */
export const PartnerRole = CompanyRole.extract(['administrador', 'gestor', 'aprovador', 'somente_leitura']);
export type PartnerRole = z.infer<typeof PartnerRole>;

const CodigoDoApp = z.string().trim().regex(/^\d{6}$/, { error: 'O código tem 6 dígitos' });

// ------------------------------------------------------------------ o lado da agência

/** Pedir acesso a um cliente: o e-mail do Dono, o que o time vai fazer e uma mensagem (D-A7-46). */
export const CreatePartnerRequestRequest = z.strictObject({
  owner_email: Email,
  requested_role: PartnerRole,
  /** Vai no e-mail ao Dono, só texto: sem link (o único link do e-mail é o do Liame). */
  message: z
    .string()
    .trim()
    .max(300, { error: 'Até 300 caracteres' })
    .refine((v) => !/(https?:\/\/|www\.)/i.test(v), { error: 'A mensagem não pode ter link' })
    .optional(),
});
export type CreatePartnerRequestRequest = z.infer<typeof CreatePartnerRequestRequest>;

/**
 * Um pedido da agência, como ela o vê: o e-mail que ela digitou, sem a empresa (a recusa não diz quem recusou).
 * `esperando` até 7 dias; `vencido` depois; `recusado` pelo Dono.
 */
export const AgencyRequestResponse = z.strictObject({
  id: z.uuid(),
  owner_email: z.string(),
  requested_role: PartnerRole,
  message: z.string().nullable(),
  status: z.enum(['esperando', 'recusado', 'vencido']),
  requested_by_name: z.string(),
  created_at: z.string(),
  expires_at: z.string(),
  decided_at: z.string().nullable(),
});
export type AgencyRequestResponse = z.infer<typeof AgencyRequestResponse>;

/**
 * Um ponto do que pede atenção num cliente da agência (A7, W7, parte 1; D-A7-52). `kind` é texto aberto (a lista cresce;
 * ERR-015): `suspensa` (todas as marcas vivas suspensas: só o Dono entra, e vem sozinho, com o nome do Dono e desde
 * quando), `marca_suspensa` (parte das marcas suspensas; o resto segue), `aprovacoes` (os pedidos esperando, para quem
 * aprova), `conta_desconectada` (as contas que perderam o acesso, para quem opera), `em_dia` (nada esperando) e
 * `fora_do_time` (quem pede não está no time desta empresa).
 */
export const AgencyClientAttention = z.strictObject({
  kind: z.string(),
  count: z.int().min(0).nullable(),
  since: z.string().nullable(),
  owner_name: z.string().nullable(),
});
export type AgencyClientAttention = z.infer<typeof AgencyClientAttention>;

/** Uma empresa que aceitou o vínculo: o que o Dono deu à agência e desde quando. */
export const AgencyClientResponse = z.strictObject({
  id: z.uuid(),
  organization: z.strictObject({ id: z.uuid(), name: z.string() }),
  max_role: PartnerRole,
  /** Limite por ação; nulo = sem limite (ou o nível não aprova). */
  approve_limit_micros: Micros.nullable(),
  /** Acima do limite, o Dono também aprova. */
  dual_approval: z.boolean(),
  ends_at: z.string().nullable(),
  since: z.string(),
  /** `ativo`; `vencido` quando a data de fim passou; `desfeito` por um dos lados. */
  status: z.enum(['ativo', 'vencido', 'desfeito']),
  ended_at: z.string().nullable(),
  /** Quem desfez: a empresa ou a própria agência. */
  ended_side: z.enum(['empresa', 'agencia']).nullable(),
  /** Quem do time está nesta empresa agora, com o nível (A7, W6, parte 5); vazio no vínculo que acabou. */
  team: z.array(z.strictObject({ user_id: z.uuid(), name: z.string(), role: PartnerRole })).optional(),
  /** O acesso de quem pede nesta empresa (A7, W7, parte 1); nulo quando a pessoa não está no time dela. */
  my_access: z.strictObject({ role: PartnerRole, approve_limit_micros: Micros.nullable() }).nullable().optional(),
  /** O que pede atenção nesta empresa, só o que o nível de quem pede nela deixa ver (D-A7-52); nunca a cobrança. */
  attention: z.array(AgencyClientAttention).optional(),
});
export type AgencyClientResponse = z.infer<typeof AgencyClientResponse>;

export const AgencyClientsResponse = z.strictObject({
  clients: z.array(AgencyClientResponse),
  requests: z.array(AgencyRequestResponse),
});
export type AgencyClientsResponse = z.infer<typeof AgencyClientsResponse>;

/** Uma pessoa do time da agência e, se estiver, o acesso dela neste cliente (A7, W6, parte 3; D-A7-48). */
export const AgencyClientTeamMember = z.strictObject({
  user_id: z.uuid(),
  name: z.string(),
  email: z.string(),
  agency_role: AgencyRole,
  /** Sem o app autenticador, a pessoa não entra em nenhum cliente (D-A7-48). */
  mfa_enabled: z.boolean(),
  in_client: z
    .strictObject({ member_id: z.uuid(), role: PartnerRole, approve_limit_micros: Micros.nullable(), dual_approval: z.boolean() })
    .nullable(),
});
export type AgencyClientTeamMember = z.infer<typeof AgencyClientTeamMember>;

/** Quem do time entra neste cliente, e até onde (o máximo é o que o Dono deu). */
export const AgencyClientTeamResponse = z.strictObject({
  client: AgencyClientResponse,
  team: z.array(AgencyClientTeamMember),
});
export type AgencyClientTeamResponse = z.infer<typeof AgencyClientTeamResponse>;

/**
 * Salvar quem entra no cliente (D-A7-48): a lista inteira de quem fica, com o nível e o limite de cada um, até o máximo
 * do Dono. Quem sai da lista perde o acesso a este cliente na hora. Sem o limite, quem aprova fica com o limite do Dono.
 */
export const SetAgencyClientTeamRequest = z.strictObject({
  members: z
    .array(
      z.strictObject({
        user_id: z.uuid(),
        role: PartnerRole,
        approve_limit_micros: Micros.nullable().optional(),
        dual_approval: z.boolean().optional(),
      }),
    )
    .max(200)
    .refine((ms) => new Set(ms.map((m) => m.user_id)).size === ms.length, { error: 'Cada pessoa aparece uma vez só' }),
});
export type SetAgencyClientTeamRequest = z.infer<typeof SetAgencyClientTeamRequest>;

// ------------------------------------------------------------------ o lado da empresa

const AgencyRef = z.strictObject({ id: z.uuid(), name: z.string(), cnpj: z.string().nullable() });

/** O pedido de uma agência ao Dono, em Pessoas e acessos. */
export const PartnerRequestResponse = z.strictObject({
  id: z.uuid(),
  agency: AgencyRef,
  requested_by_name: z.string(),
  requested_role: PartnerRole,
  message: z.string().nullable(),
  created_at: z.string(),
  expires_at: z.string(),
});
export type PartnerRequestResponse = z.infer<typeof PartnerRequestResponse>;

/** A agência com vínculo nesta empresa: o máximo que o Dono deu. */
export const PartnerResponse = z.strictObject({
  id: z.uuid(),
  agency: AgencyRef,
  max_role: PartnerRole,
  approve_limit_micros: Micros.nullable(),
  dual_approval: z.boolean(),
  ends_at: z.string().nullable(),
  since: z.string(),
  accepted_by_name: z.string().nullable(),
});
export type PartnerResponse = z.infer<typeof PartnerResponse>;

export const PartnersResponse = z.strictObject({
  /** A função `parceiros` desligada nesta empresa: nenhum pedido chega e nada se aceita. */
  enabled: z.boolean(),
  /** Os pedidos em aberto ao e-mail do Dono (só o Dono os vê). */
  requests: z.array(PartnerRequestResponse),
  partners: z.array(PartnerResponse),
});
export type PartnersResponse = z.infer<typeof PartnersResponse>;

/** Aceitar: o nível máximo, o limite, "acima disso, eu também aprovo" e a data de fim, com o código do app (D-A7-47). */
export const AcceptPartnerRequest = z.strictObject({
  max_role: PartnerRole,
  approve_limit_micros: Micros.nullable().optional(),
  dual_approval: z.boolean().default(true),
  ends_at: FutureDate.nullable().optional(),
  code: CodigoDoApp,
});
export type AcceptPartnerRequest = z.infer<typeof AcceptPartnerRequest>;

/** Mudar o que a agência pode: baixar vale sem o código; subir pede o código do app (D-A7-49). */
export const UpdatePartnerRequest = z
  .strictObject({
    max_role: PartnerRole.optional(),
    approve_limit_micros: Micros.nullable().optional(),
    dual_approval: z.boolean().optional(),
    ends_at: FutureDate.nullable().optional(),
    code: CodigoDoApp.optional(),
  })
  .refine((v) => [v.max_role, v.approve_limit_micros, v.dual_approval, v.ends_at].some((x) => x !== undefined), {
    error: 'Envie pelo menos um campo',
  });
export type UpdatePartnerRequest = z.infer<typeof UpdatePartnerRequest>;
