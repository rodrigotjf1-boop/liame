import { z } from 'zod';

// Contratos de identidade e acesso (ADR-013, ADR-017). Campos em inglês e snake_case (contrato público);
// textos para a pessoa em pt-BR.

/**
 * Senha: 15 caracteres ou mais, sem regra de composição (NIST SP 800-63B-4: mínimo para senha usada
 * como fator único; frases são bem-vindas). Checada contra senhas vazadas no servidor.
 */
export const PASSWORD_MIN = 15;
export const Password = z
  .string()
  .min(PASSWORD_MIN, { error: `Use pelo menos ${PASSWORD_MIN} caracteres (uma frase serve)` })
  .max(200);

export const Email = z
  .string()
  .trim()
  .toLowerCase()
  .pipe(z.email({ error: 'E-mail inválido' }).max(254));

export const Cnpj = z
  .string()
  .transform((v) => v.replace(/\D/g, ''))
  .pipe(z.string().regex(/^\d{14}$/, { error: 'CNPJ precisa ter 14 dígitos' }));

/**
 * O tipo da organização (A7, W6; D-A7-45): a empresa (o cliente, com marcas e assinatura) ou a agência (o time que cuida
 * de empresas, sem marca e sem assinatura). Nasce com a organização e não muda.
 */
export const OrganizationKind = z.enum(['empresa', 'agencia']);
export type OrganizationKind = z.infer<typeof OrganizationKind>;

/** Versão dos Termos de Uso e da Política de Privacidade que a pessoa viu e aceitou ao criar o login. */
export const TermsVersion = z.string().trim().min(1).max(60);

export const SignupRequest = z.strictObject({
  name: z.string().trim().min(1).max(200),
  email: Email,
  password: Password,
  /** A empresa, ou a agência quando `kind` é `agencia`. */
  company: z.strictObject({
    name: z.string().trim().min(1).max(200),
    cnpj: Cnpj.optional(),
  }),
  terms_version: TermsVersion,
  /**
   * "Sou agência ou consultor" (D-A7-45): a conta nasce como agência, com o time e sem marca. Sem o campo, é uma
   * empresa, como sempre.
   */
  kind: OrganizationKind.optional(),
});
export type SignupRequest = z.infer<typeof SignupRequest>;

/** Resposta de pedido que manda e-mail: sempre a mesma, exista ou não a conta (não revela e-mails). */
export const AcceptedResponse = z.strictObject({
  status: z.literal('accepted'),
  message: z.string(),
});
export type AcceptedResponse = z.infer<typeof AcceptedResponse>;

/** Termos vigentes: a tela de cadastro mostra os links e devolve a versão no pedido. */
export const LegalTermsResponse = z.strictObject({
  version: z.string(),
  terms_url: z.url(),
  privacy_url: z.url(),
});
export type LegalTermsResponse = z.infer<typeof LegalTermsResponse>;

export const TokenRequest = z.strictObject({ token: z.string().min(20).max(200) });
export type TokenRequest = z.infer<typeof TokenRequest>;

export const LoginRequest = z.strictObject({ email: Email, password: z.string().min(1).max(200) });
export type LoginRequest = z.infer<typeof LoginRequest>;

export const ForgotPasswordRequest = z.strictObject({ email: Email });
export type ForgotPasswordRequest = z.infer<typeof ForgotPasswordRequest>;

export const ResetPasswordRequest = z.strictObject({ token: z.string().min(20).max(200), password: Password });
export type ResetPasswordRequest = z.infer<typeof ResetPasswordRequest>;

/**
 * O papel da pessoa numa organização: os seis níveis das empresas (ADR-017) e os três papéis da agência (A7, W6;
 * D-A7-51), que só valem numa agência (o banco confere, migration 0099).
 */
export const RoleKey = z.enum([
  'dono',
  'administrador',
  'gestor',
  'aprovador',
  'somente_leitura',
  'so_relatorios',
  'agencia_dona',
  'agencia_admin',
  'agencia_membro',
]);
export type RoleKey = z.infer<typeof RoleKey>;

/** Os papéis na agência (D-A7-51): a dona, o administrador e o membro. */
export const AgencyRole = RoleKey.extract(['agencia_dona', 'agencia_admin', 'agencia_membro']);
export type AgencyRole = z.infer<typeof AgencyRole>;

/** Os níveis numa empresa (ADR-017): os papéis da agência nunca aparecem nela. */
export const CompanyRole = RoleKey.exclude(['agencia_dona', 'agencia_admin', 'agencia_membro']);
export type CompanyRole = z.infer<typeof CompanyRole>;

/** Situação do segundo fator na sessão (ADR-013). */
export const MfaStatus = z.enum(['not_configured', 'required', 'verified']);

export const MeResponse = z.strictObject({
  user: z.strictObject({ id: z.uuid(), name: z.string(), email: z.string() }),
  /** As organizações da pessoa: as empresas e, se houver, a agência em que ela trabalha (`kind`). */
  organizations: z.array(
    z.strictObject({
      id: z.uuid(),
      name: z.string(),
      role: RoleKey,
      kind: OrganizationKind,
      /** A empresa em que a pessoa entra pela agência (A7, W6, parte 3): qual agência. */
      via_agency: z.strictObject({ id: z.uuid(), name: z.string() }).nullable().optional(),
    }),
  ),
  active_organization_id: z.uuid().nullable(),
  mfa: MfaStatus,
  /** O nível na empresa ativa exige o app autenticador e ele ainda não foi configurado. */
  mfa_enrollment_required: z.boolean(),
  /** Permissões na empresa ativa, para a tela esconder o que a pessoa não pode (quem decide é o servidor). */
  permissions: z.array(z.string()),
});
export type MeResponse = z.infer<typeof MeResponse>;

export const SwitchOrganizationRequest = z.strictObject({ organization_id: z.uuid() });
export type SwitchOrganizationRequest = z.infer<typeof SwitchOrganizationRequest>;
