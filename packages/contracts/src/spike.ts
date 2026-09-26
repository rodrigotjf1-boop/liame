import { z } from 'zod';

// Contratos do spike de compatibilidade (A0-3). Saem quando a A1 trouxer os contratos de produto.

/** Corpo do `POST /v1/spike/echo`. `strictObject` recusa campo extra (ADR-001). */
export const SpikeEchoRequest = z.strictObject({
  message: z.string().trim().min(1).max(280),
  tags: z.array(z.string().min(1).max(32)).max(5).default([]),
});
export type SpikeEchoRequest = z.infer<typeof SpikeEchoRequest>;

export const SpikeEchoResponse = z.strictObject({
  message: z.string(),
  tags: z.array(z.string()),
  length: z.int().nonnegative(),
});
export type SpikeEchoResponse = z.infer<typeof SpikeEchoResponse>;
