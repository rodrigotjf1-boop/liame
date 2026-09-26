import { createHash } from 'node:crypto';
import { type Database, withSystem } from '@liame/database';
import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import {
  type EvaluationContext,
  FlagNotFoundError,
  type JsonValue,
  OpenFeature,
  type Provider,
  type ResolutionDetails,
  TypeMismatchError,
} from '@openfeature/server-sdk';
import { sql } from 'drizzle-orm';
import { APP_CONFIG, type AppConfig } from '../config.js';
import { DATABASE } from '../database/database.module.js';
import { evaluateFlag, type FlagContext, type FlagDefinition, type FlagResult, type FlagRule, type FlagValue } from './evaluate.js';

/** Cache curto: mudança de flag vale em até 15 s em todas as réplicas (sem estado por requisição). */
const TTL_MS = 15_000;
const DOMAIN = 'liame';

interface Snapshot {
  flags: Map<string, FlagDefinition>;
  rules: FlagRule[];
  loadedAt: number;
  /** Muda quando qualquer flag ou regra muda: vira o ETag do OFREP. */
  version: string;
}

/**
 * Feature flags pelo padrão OpenFeature com provider próprio no Postgres (ADR-012). As flags são
 * configuração da distribuição, lidas no escopo de sistema; a empresa recebe só o valor avaliado.
 */
@Injectable()
export class FlagService implements OnModuleInit {
  private snapshot: Snapshot | null = null;
  private loading: Promise<Snapshot> | null = null;

  constructor(
    @Inject(DATABASE) private readonly database: Database | null,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async onModuleInit(): Promise<void> {
    await OpenFeature.setProviderAndWait(DOMAIN, new LiameFlagProvider(this));
  }

  /** Contexto a partir da sessão; o ambiente vem sempre da configuração do servidor. */
  context(ids: Omit<FlagContext, 'environment'>): FlagContext {
    return { environment: this.config.env, ...ids };
  }

  async isEnabled(key: string, ctx: FlagContext): Promise<boolean> {
    return OpenFeature.getClient(DOMAIN).getBooleanValue(key, false, toEvaluationContext(ctx));
  }

  async evaluate(key: string, ctx: FlagContext): Promise<FlagResult & { key: string }> {
    const snap = await this.load();
    const flag = snap.flags.get(key);
    if (!flag) throw new FlagNotFoundError(`flag "${key}" não existe`);
    return { key, ...evaluateFlag(flag, snap.rules, ctx) };
  }

  async evaluateAll(ctx: FlagContext): Promise<{ version: string; results: Array<FlagResult & { key: string }> }> {
    const snap = await this.load();
    return { version: snap.version, results: [...snap.flags.values()].map((f) => ({ key: f.key, ...evaluateFlag(f, snap.rules, ctx) })) };
  }

  /** Esquece o cache (depois de mudar uma flag neste processo, e nos testes). */
  invalidate(): void {
    this.snapshot = null;
  }

  private async load(): Promise<Snapshot> {
    if (this.snapshot && Date.now() - this.snapshot.loadedAt < TTL_MS) return this.snapshot;
    // Uma carga por vez: pedidos simultâneos esperam a mesma.
    this.loading ??= this.fetch().finally(() => {
      this.loading = null;
    });
    this.snapshot = await this.loading;
    return this.snapshot;
  }

  private async fetch(): Promise<Snapshot> {
    if (!this.database) return { flags: new Map(), rules: [], loadedAt: Date.now(), version: 'sem-banco' };
    return withSystem(this.database.db, async (tx) => {
      const flags = await tx.execute<FlagDefinition & { updated_at: Date | string }>(sql`
        select key, kind, default_value, is_write, updated_at from liame.feature_flag`);
      const rules = await tx.execute<FlagRule & { created_at: Date | string }>(sql`
        select flag_key, scope_type, scope_id, value, rollout_percent, starts_at, ends_at, created_at from liame.feature_flag_rule`);
      const stamp = [...flags.rows.map((f) => `${f.key}@${new Date(f.updated_at).getTime()}`), ...rules.rows.map((r) => `${r.flag_key}:${r.scope_type}:${r.scope_id}:${JSON.stringify(r.value)}:${r.rollout_percent}:${new Date(r.created_at).getTime()}`)]
        .sort()
        .join('|');
      return {
        flags: new Map(flags.rows.map((f) => [f.key, f])),
        rules: rules.rows,
        loadedAt: Date.now(),
        version: `"${createHash('sha256').update(stamp).digest('base64url').slice(0, 22)}"`,
      };
    });
  }
}

function toEvaluationContext(ctx: FlagContext): EvaluationContext {
  return {
    targetingKey: ctx.userId ?? ctx.tenantId ?? ctx.environment,
    environment: ctx.environment,
    ...(ctx.plan ? { plan: ctx.plan } : {}),
    ...(ctx.tenantId ? { tenantId: ctx.tenantId } : {}),
    ...(ctx.brandId ? { brandId: ctx.brandId } : {}),
    ...(ctx.accountId ? { accountId: ctx.accountId } : {}),
    ...(ctx.userId ? { userId: ctx.userId } : {}),
  };
}

function fromEvaluationContext(c: EvaluationContext): FlagContext {
  const str = (k: string) => (typeof c[k] === 'string' ? (c[k] as string) : null);
  return {
    environment: str('environment') ?? 'development',
    plan: str('plan'),
    tenantId: str('tenantId'),
    brandId: str('brandId'),
    accountId: str('accountId'),
    userId: str('userId'),
  };
}

/** Provider OpenFeature do Liame: lê do `FlagService` (Postgres + cache). */
class LiameFlagProvider implements Provider {
  readonly metadata = { name: 'liame-postgres' } as const;
  readonly runsOn = 'server' as const;

  constructor(private readonly flags: FlagService) {}

  private async resolve<T extends FlagValue>(key: string, kind: 'boolean' | 'string' | 'number', context: EvaluationContext): Promise<ResolutionDetails<T>> {
    const r = await this.flags.evaluate(key, fromEvaluationContext(context));
    if (typeof r.value !== kind) throw new TypeMismatchError(`flag "${key}" não é ${kind}`);
    return { value: r.value as T, reason: r.reason, variant: r.variant };
  }

  resolveBooleanEvaluation(key: string, _d: boolean, context: EvaluationContext): Promise<ResolutionDetails<boolean>> {
    return this.resolve(key, 'boolean', context);
  }
  resolveStringEvaluation(key: string, _d: string, context: EvaluationContext): Promise<ResolutionDetails<string>> {
    return this.resolve(key, 'string', context);
  }
  resolveNumberEvaluation(key: string, _d: number, context: EvaluationContext): Promise<ResolutionDetails<number>> {
    return this.resolve(key, 'number', context);
  }
  async resolveObjectEvaluation<T extends JsonValue>(key: string): Promise<ResolutionDetails<T>> {
    throw new TypeMismatchError(`flag "${key}": objetos não são usados no Liame`);
  }
}
