import { z } from 'zod';

// Kill switch (ADR-007, security-model §10): trava a execução em seis níveis. A empresa aciona os
// seus (empresa, marca, conta, ferramenta); global e provedor são da distribuição.

export const KillSwitchLevel = z.enum(['global', 'provider', 'tenant', 'brand', 'account', 'tool']);
export type KillSwitchLevel = z.infer<typeof KillSwitchLevel>;

const Slug = z.string().regex(/^[a-z0-9_]+$/).max(60);

export const KillSwitchResponse = z.strictObject({
  id: z.uuid(),
  level: KillSwitchLevel,
  provider: z.string().nullable(),
  brand_id: z.uuid().nullable(),
  account_id: z.string().nullable(),
  tool: z.string().nullable(),
  reason: z.string(),
  activated_at: z.string(),
  deactivated_at: z.string().nullable(),
  /**
   * A parada é da cobrança (A7, W3): as ações da marca param no 10º dia de atraso da mensalidade e voltam sozinhas
   * quando ela é paga; uma pessoa não a desliga (409 `parada-da-cobranca`).
   */
  by_billing: z.boolean().optional(),
});
export type KillSwitchResponse = z.infer<typeof KillSwitchResponse>;

export const KillSwitchListResponse = z.strictObject({ items: z.array(KillSwitchResponse) });
export type KillSwitchListResponse = z.infer<typeof KillSwitchListResponse>;

/** A empresa trava a si mesma, uma marca, uma conta de um provedor ou uma ferramenta. */
export const ActivateKillSwitchRequest = z.discriminatedUnion('level', [
  z.strictObject({ level: z.literal('tenant'), reason: z.string().trim().min(3).max(500) }),
  z.strictObject({ level: z.literal('brand'), brand_id: z.uuid(), reason: z.string().trim().min(3).max(500) }),
  z.strictObject({ level: z.literal('account'), provider: Slug, account_id: z.string().min(1).max(100), reason: z.string().trim().min(3).max(500) }),
  z.strictObject({ level: z.literal('tool'), tool: Slug, reason: z.string().trim().min(3).max(500) }),
]);
export type ActivateKillSwitchRequest = z.infer<typeof ActivateKillSwitchRequest>;
