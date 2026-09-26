import { z } from 'zod';

/** Resposta do `GET /health`: o processo está de pé (sonda de vida, fora do prefixo `/v1`). */
export const HealthResponse = z.strictObject({
  status: z.literal('ok'),
  service: z.string(),
  version: z.string(),
});
export type HealthResponse = z.infer<typeof HealthResponse>;

const Check = z.strictObject({
  status: z.enum(['ok', 'falhou']),
  latency_ms: z.int().nonnegative().optional(),
});

/**
 * Resposta do `GET /health/ready`: o serviço consegue trabalhar (LIC-008). Toca o banco e a fila e
 * diz a versão do código e a última migration aplicada. 503 quando alguma dependência falha.
 */
export const ReadinessResponse = z.strictObject({
  status: z.enum(['ok', 'indisponivel']),
  service: z.string(),
  version: z.string(),
  migration: z.string().nullable(),
  checks: z.strictObject({ database: Check, queue: Check }),
});
export type ReadinessResponse = z.infer<typeof ReadinessResponse>;
