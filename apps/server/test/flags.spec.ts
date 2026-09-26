import { describe, expect, it } from 'vitest';
import { evaluateFlag, type FlagDefinition, type FlagRule, rolloutBucket } from '../src/flags/evaluate.js';

const flag: FlagDefinition = { key: 'meta_write', kind: 'boolean', default_value: false, is_write: true };
const rule = (scope_type: FlagRule['scope_type'], scope_id: string, value: boolean, extra: Partial<FlagRule> = {}): FlagRule => ({
  flag_key: 'meta_write',
  scope_type,
  scope_id,
  value,
  rollout_percent: null,
  starts_at: null,
  ends_at: null,
  ...extra,
});
const ctx = { environment: 'production', tenantId: 't1', brandId: 'b1', accountId: 'a1', userId: 'u1', plan: 'pro' };

describe('A1-12: avaliação de feature flag', () => {
  it('sem regra, vale o padrão (a de escrita nasce desligada)', () => {
    expect(evaluateFlag(flag, [], ctx)).toEqual({ value: false, reason: 'STATIC', variant: 'default' });
  });

  it('precedência: usuário > conta > empresa > marca > plano > ambiente', () => {
    const rules = [
      rule('environment', 'production', true),
      rule('plan', 'pro', false),
      rule('brand', 'b1', true),
      rule('tenant', 't1', false),
      rule('account', 'a1', true),
      rule('user', 'u1', false),
    ];
    const order: Array<[string, Partial<typeof ctx>]> = [
      ['user', {}],
      ['account', { userId: 'outro' }],
      ['tenant', { userId: 'outro', accountId: 'outra' }],
      ['brand', { userId: 'outro', accountId: 'outra', tenantId: 'outra' }],
      ['plan', { userId: 'outro', accountId: 'outra', tenantId: 'outra', brandId: 'outra' }],
      ['environment', { userId: 'outro', accountId: 'outra', tenantId: 'outra', brandId: 'outra', plan: 'outro' }],
    ];
    for (const [variant, change] of order) {
      expect(evaluateFlag(flag, rules, { ...ctx, ...change })).toMatchObject({ variant, reason: 'TARGETING_MATCH' });
    }
  });

  it('a regra de uma empresa não vale para outra', () => {
    const rules = [rule('tenant', 't1', true)];
    expect(evaluateFlag(flag, rules, ctx).value).toBe(true);
    expect(evaluateFlag(flag, rules, { ...ctx, tenantId: 't2' }).value).toBe(false);
  });

  it('janela de datas: antes e depois dela vale a regra seguinte', () => {
    const now = new Date('2026-09-26T12:00:00Z');
    const rules = [rule('tenant', 't1', true, { starts_at: '2026-09-27T00:00:00Z' }), rule('environment', 'production', false)];
    expect(evaluateFlag(flag, rules, ctx, now)).toMatchObject({ value: false, variant: 'environment' });
    const ended = [rule('tenant', 't1', true, { ends_at: '2026-09-26T11:00:00Z' })];
    expect(evaluateFlag(flag, ended, ctx, now).variant).toBe('default');
    const inside = [rule('tenant', 't1', true, { starts_at: '2026-09-26T00:00:00Z', ends_at: '2026-09-27T00:00:00Z' })];
    expect(evaluateFlag(flag, inside, ctx, now).value).toBe(true);
  });

  it('rollout: balde estável por empresa; 0% nunca, 100% sempre, e perto da proporção pedida', () => {
    const tenants = Array.from({ length: 2_000 }, (_, i) => `empresa-${i}`);
    const on = (percent: number) =>
      tenants.filter((t) => evaluateFlag(flag, [rule('environment', 'production', true, { rollout_percent: percent })], { ...ctx, tenantId: t, userId: null }).value).length;
    expect(on(0)).toBe(0);
    expect(on(100)).toBe(2_000);
    const twenty = on(20);
    expect(twenty).toBeGreaterThan(330);
    expect(twenty).toBeLessThan(470);
    expect(rolloutBucket('meta_write', { environment: 'production', tenantId: 'x' })).toBe(rolloutBucket('meta_write', { environment: 'production', tenantId: 'x' }));
    expect(evaluateFlag(flag, [rule('environment', 'production', true, { rollout_percent: 100 })], ctx).reason).toBe('TARGETING_MATCH');
  });

  it('valor de tipo errado na regra é ignorado', () => {
    const bad = [{ ...rule('tenant', 't1', true), value: 'sim' as unknown as boolean }];
    expect(evaluateFlag(flag, bad, ctx).variant).toBe('default');
  });
});
