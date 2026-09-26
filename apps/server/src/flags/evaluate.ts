import { createHash } from 'node:crypto';

// Avaliação de feature flag (ADR-012): função pura, sem banco. Precedência:
// usuário > conta > empresa > marca > plano > ambiente > padrão.

export type FlagValue = boolean | string | number;
export type ScopeType = 'environment' | 'plan' | 'brand' | 'tenant' | 'account' | 'user';

export type FlagDefinition = {
  key: string;
  kind: 'boolean' | 'string' | 'number';
  default_value: FlagValue;
  is_write: boolean;
};

export type FlagRule = {
  flag_key: string;
  scope_type: ScopeType;
  scope_id: string;
  value: FlagValue;
  rollout_percent: number | null;
  starts_at: Date | string | null;
  ends_at: Date | string | null;
};

export interface FlagContext {
  environment: string;
  plan?: string | null;
  tenantId?: string | null;
  brandId?: string | null;
  accountId?: string | null;
  userId?: string | null;
}

export interface FlagResult {
  value: FlagValue;
  /** Razões do OFREP/OpenFeature: STATIC (padrão), TARGETING_MATCH (regra), SPLIT (regra com rollout). */
  reason: 'STATIC' | 'TARGETING_MATCH' | 'SPLIT';
  /** Qual regra decidiu (`tenant`, `user`…) ou `default`. */
  variant: string;
}

const PRECEDENCE: ScopeType[] = ['user', 'account', 'tenant', 'brand', 'plan', 'environment'];

function scopeId(ctx: FlagContext, scope: ScopeType): string | null | undefined {
  switch (scope) {
    case 'user':
      return ctx.userId;
    case 'account':
      return ctx.accountId;
    case 'tenant':
      return ctx.tenantId;
    case 'brand':
      return ctx.brandId;
    case 'plan':
      return ctx.plan;
    case 'environment':
      return ctx.environment;
  }
}

/**
 * Balde estável de 0 a 99 para o rollout: a mesma empresa (ou pessoa, sem empresa) cai sempre no
 * mesmo balde daquela flag, e flags diferentes sorteiam baldes independentes.
 */
export function rolloutBucket(flagKey: string, ctx: FlagContext): number {
  const target = ctx.tenantId ?? ctx.userId ?? ctx.environment;
  return createHash('sha256').update(`${flagKey}:${target}`).digest().readUInt32BE(0) % 100;
}

export function evaluateFlag(flag: FlagDefinition, rules: FlagRule[], ctx: FlagContext, now = new Date()): FlagResult {
  for (const scope of PRECEDENCE) {
    const id = scopeId(ctx, scope);
    if (!id) continue;
    const rule = rules.find((r) => r.flag_key === flag.key && r.scope_type === scope && r.scope_id === id);
    if (!rule) continue;
    if (rule.starts_at && now < new Date(rule.starts_at)) continue;
    if (rule.ends_at && now >= new Date(rule.ends_at)) continue;
    if (typeof rule.value !== typeof flag.default_value) continue;
    if (rule.rollout_percent !== null && rule.rollout_percent < 100) {
      // Fora do rollout: segue para a regra de precedência menor (ou o padrão).
      if (rolloutBucket(flag.key, ctx) >= rule.rollout_percent) continue;
      return { value: rule.value, reason: 'SPLIT', variant: scope };
    }
    return { value: rule.value, reason: 'TARGETING_MATCH', variant: scope };
  }
  return { value: flag.default_value, reason: 'STATIC', variant: 'default' };
}
