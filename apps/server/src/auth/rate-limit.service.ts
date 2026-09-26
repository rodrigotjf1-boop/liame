import { type Database, withSystem } from '@liame/database';
import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { DATABASE } from '../database/database.module.js';
import { AppProblem } from '../errors/problems.js';

/**
 * Limite de tentativas por janela fixa, guardado no Postgres (vale entre réplicas; sem Redis, ADR-005).
 * Uma requisição = um upsert. A Cloudflare faz o limite grosso por IP na borda.
 */
@Injectable()
export class RateLimitService {
  constructor(@Inject(DATABASE) private readonly database: Database | null) {}

  async consume(key: string, limit: number, windowSeconds: number): Promise<void> {
    if (!this.database) throw new Error('limite de tentativas sem banco');
    const hits = await withSystem(this.database.db, async (tx) => {
      const r = await tx.execute<{ hits: number; window_start: string }>(sql`
        insert into liame.rate_limit (key, window_start, hits)
        values (${key}, to_timestamp(floor(extract(epoch from now()) / ${windowSeconds}) * ${windowSeconds}), 1)
        on conflict (key, window_start) do update set hits = liame.rate_limit.hits + 1
        returning hits`);
      return Number(r.rows[0]?.hits ?? 0);
    });
    if (hits > limit) {
      throw new AppProblem(
        429,
        'muitas-tentativas',
        'Muitas tentativas',
        'Espere alguns minutos e tente de novo.',
        { 'retry-after': String(windowSeconds) },
      );
    }
  }
}
