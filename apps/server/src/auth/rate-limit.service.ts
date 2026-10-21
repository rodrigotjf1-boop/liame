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

  /**
   * Quando a janela de `key` volta a aceitar: o começo da próxima janela, se esta já chegou ao limite; nulo se ainda
   * aceita. Só lê (para a tela dizer "dá para ler de novo às…" sem gastar a vez).
   */
  async proximaVez(key: string, limit: number, windowSeconds: number): Promise<Date | null> {
    if (!this.database) throw new Error('limite de tentativas sem banco');
    const r = await withSystem(this.database.db, (tx) =>
      tx.execute<{ hits: number; fim: Date | string }>(sql`
        select hits, window_start + make_interval(secs => ${windowSeconds}) as fim
          from liame.rate_limit
         where key = ${key} and window_start = to_timestamp(floor(extract(epoch from now()) / ${windowSeconds}) * ${windowSeconds})`),
    );
    const linha = r.rows[0];
    return linha && Number(linha.hits) >= limit ? new Date(linha.fim) : null;
  }

  /**
   * Quantas tentativas a janela atual de `key` já contou (as recusadas também: a conta passa do limite) e quando ela
   * termina. Só lê (para a tela mostrar quanto do limite do dia já foi usado).
   */
  async uso(key: string, windowSeconds: number): Promise<{ hits: number; fim: Date }> {
    if (!this.database) throw new Error('limite de tentativas sem banco');
    const r = await withSystem(this.database.db, (tx) =>
      tx.execute<{ hits: number | null; fim: Date | string }>(sql`
        select (select hits from liame.rate_limit where key = ${key} and window_start = j.inicio) as hits,
               j.inicio + make_interval(secs => ${windowSeconds}) as fim
          from (select to_timestamp(floor(extract(epoch from now()) / ${windowSeconds}) * ${windowSeconds}) as inicio) j`),
    );
    const linha = r.rows[0]!;
    return { hits: Number(linha.hits ?? 0), fim: new Date(linha.fim) };
  }
}
