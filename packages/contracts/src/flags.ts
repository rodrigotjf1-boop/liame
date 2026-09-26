import { z } from 'zod';

// OFREP (OpenFeature Remote Evaluation Protocol, base §14.2): o front recebe flags já avaliadas.
// O servidor usa a sessão (empresa e pessoa); do contexto enviado, só aceita a marca da empresa ativa.

export const OfrepRequest = z.object({
  context: z
    .object({
      targetingKey: z.string().min(1).max(200),
      brandId: z.uuid().optional(),
    })
    .loose(),
});
export type OfrepRequest = z.infer<typeof OfrepRequest>;

export const OfrepReason = z.enum(['STATIC', 'TARGETING_MATCH', 'SPLIT', 'DISABLED', 'UNKNOWN']);

export const OfrepSuccess = z.strictObject({
  key: z.string(),
  value: z.union([z.boolean(), z.string(), z.number()]),
  reason: OfrepReason,
  variant: z.string(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});
export type OfrepSuccess = z.infer<typeof OfrepSuccess>;

export const OfrepFailure = z.strictObject({
  key: z.string(),
  errorCode: z.enum(['PARSE_ERROR', 'TARGETING_KEY_MISSING', 'INVALID_CONTEXT', 'GENERAL', 'FLAG_NOT_FOUND']),
  errorDetails: z.string().optional(),
});
export type OfrepFailure = z.infer<typeof OfrepFailure>;

export const OfrepBulkResponse = z.strictObject({ flags: z.array(OfrepSuccess) });
export type OfrepBulkResponse = z.infer<typeof OfrepBulkResponse>;

/** Chave de flag na rota do OFREP. */
export const FlagKey = z.string().regex(/^[a-z][a-z0-9_]*$/, { error: 'Chave de flag inválida' });
