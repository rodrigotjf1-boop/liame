import { z } from 'zod';

/** Resposta do `GET /health`: sonda de infraestrutura, fora do prefixo `/v1`. */
export const HealthResponse = z.strictObject({
  status: z.literal('ok'),
  service: z.string(),
  version: z.string(),
});
export type HealthResponse = z.infer<typeof HealthResponse>;
