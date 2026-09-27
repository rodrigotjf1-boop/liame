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

const Cnpj = z
  .string()
  .transform((v) => v.replace(/\D/g, ''))
  .pipe(z.string().regex(/^\d{14}$/, { error: 'CNPJ precisa ter 14 dígitos' }));

/** Versão dos Termos de Uso e da Política de Privacidade que a pessoa viu e aceitou ao criar o login. */
export const TermsVersion = z.string().trim().min(1).max(60);

export const SignupRequest = z.strictObject({
  name: z.string().trim().min(1).max(200),
  email: Email,
  password: Password,
  company: z.strictObject({
    name: z.string().trim().min(1).max(200),
    cnpj: Cnpj.optional(),
  }),
  terms_version: TermsVersion,
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

export const RoleKey = z.enum(['dono', 'administrador', 'gestor', 'aprovador', 'somente_leitura', 'so_relatorios']);
export type RoleKey = z.infer<typeof RoleKey>;

/** Situação do segundo fator na sessão (ADR-013). */
export const MfaStatus = z.enum(['not_configured', 'required', 'verified']);

export const MeResponse = z.strictObject({
  user: z.strictObject({ id: z.uuid(), name: z.string(), email: z.string() }),
  organizations: z.array(z.strictObject({ id: z.uuid(), name: z.string(), role: RoleKey })),
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
