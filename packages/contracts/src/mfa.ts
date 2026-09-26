import { z } from 'zod';

// Segundo fator por app autenticador (ADR-013).

export const TotpSetupResponse = z.strictObject({
  /** Segredo em base32, para digitar no app se o QR não funcionar. */
  secret: z.string(),
  /** URI `otpauth://` que o app lê pelo QR. */
  otpauth_uri: z.string(),
});
export type TotpSetupResponse = z.infer<typeof TotpSetupResponse>;

export const TotpCodeRequest = z.strictObject({
  code: z.string().trim().regex(/^\d{6}$/, { error: 'O código tem 6 dígitos' }),
});
export type TotpCodeRequest = z.infer<typeof TotpCodeRequest>;

export const RecoveryCodesResponse = z.strictObject({
  /** Mostrados uma única vez. Cada um vale uma vez. */
  recovery_codes: z.array(z.string()).length(10),
});
export type RecoveryCodesResponse = z.infer<typeof RecoveryCodesResponse>;

/** Código do app (6 dígitos) ou código de recuperação (ex.: 7KQ2M-XH4RP). */
export const MfaVerifyRequest = z.strictObject({
  code: z.string().trim().min(6).max(20),
});
export type MfaVerifyRequest = z.infer<typeof MfaVerifyRequest>;
