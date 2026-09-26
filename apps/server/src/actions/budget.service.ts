import type { BudgetPolicyRequest, BudgetResponse } from '@liame/contracts';
import { type Tx, uuidv7 } from '@liame/database';
import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { type AuthContext, auditDetail, currentTx } from '../context/request-context.js';
import { AppProblem } from '../errors/problems.js';

const brl = (micros: number) => (micros / 1_000_000).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

/** Mês corrente no fuso da empresa (`2026-09`): o envelope vira no fuso dela. */
export async function periodOf(tx: Tx, tenantId: string, at = new Date()): Promise<string> {
  const r = await tx.execute<{ timezone: string }>(sql`select timezone from liame.organization where id = ${tenantId}`);
  const tz = r.rows[0]?.timezone ?? 'America/Sao_Paulo';
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit' }).formatToParts(at);
  return `${parts.find((p) => p.type === 'year')!.value}-${parts.find((p) => p.type === 'month')!.value}`;
}

/**
 * Orçamento com reserva (ADR-007): `requested → reserved → executed`. A linha do envelope é travada
 * na transação que reserva, então duas ações ao mesmo tempo não passam juntas do teto.
 */
@Injectable()
export class BudgetService {
  /** Reserva no envelope da empresa e no da marca (quando houver); passou do teto, nega. */
  async reserve(tx: Tx, input: { tenantId: string; brandId: string | null; actionId: string; amountMicros: number }): Promise<void> {
    if (input.amountMicros <= 0) return;
    const period = await periodOf(tx, input.tenantId);
    // Trava na ordem empresa → marca (sempre a mesma: sem impasse entre transações).
    const envelopes = await tx.execute<{ brand_id: string | null; limit_micros: string }>(sql`
      select brand_id, limit_micros from liame.budget_policy
       where tenant_id = ${input.tenantId} and (brand_id is null or brand_id = ${input.brandId})
       order by brand_id nulls first
       for update`);
    for (const env of envelopes.rows) {
      const committed = await this.committed(tx, input.tenantId, period, env.brand_id);
      const limit = Number(env.limit_micros);
      if (committed + input.amountMicros > limit) {
        const scope = env.brand_id ? 'da marca' : 'da empresa';
        throw new AppProblem(
          422,
          'orcamento-insuficiente',
          'Orçamento do mês insuficiente',
          `A ação reserva ${brl(input.amountMicros)}, e o envelope ${scope} tem ${brl(Math.max(0, limit - committed))} livres de ${brl(limit)}.`,
        );
      }
    }
    await tx.execute(sql`
      insert into liame.budget_ledger_entry (id, tenant_id, brand_id, period, action_request_id, kind, amount_micros)
      values (${uuidv7()}, ${input.tenantId}, ${input.brandId}, ${period}, ${input.actionId}, 'reserva', ${input.amountMicros})`);
  }

  /** Devolve ao envelope o que a ação reservou e não executou (cancelada, expirada, falhou ou mudou). */
  async release(tx: Tx, tenantId: string, actionId: string): Promise<number> {
    const r = await tx.execute<{ brand_id: string | null; period: string; open: string }>(sql`
      select brand_id, period,
             sum(case kind when 'reserva' then amount_micros when 'liberacao' then -amount_micros else 0 end)::text as open
        from liame.budget_ledger_entry
       where tenant_id = ${tenantId} and action_request_id = ${actionId}
       group by brand_id, period`);
    let released = 0;
    for (const row of r.rows) {
      const open = Number(row.open);
      if (open <= 0) continue;
      await tx.execute(sql`
        insert into liame.budget_ledger_entry (id, tenant_id, brand_id, period, action_request_id, kind, amount_micros)
        values (${uuidv7()}, ${tenantId}, ${row.brand_id}, ${row.period}, ${actionId}, 'liberacao', ${open})`);
      released += open;
    }
    return released;
  }

  /** Registra o executado (a reserva continua comprometida no mês). */
  async executed(tx: Tx, input: { tenantId: string; brandId: string | null; actionId: string; amountMicros: number }): Promise<void> {
    if (input.amountMicros <= 0) return;
    const period = await periodOf(tx, input.tenantId);
    await tx.execute(sql`
      insert into liame.budget_ledger_entry (id, tenant_id, brand_id, period, action_request_id, kind, amount_micros)
      values (${uuidv7()}, ${input.tenantId}, ${input.brandId}, ${period}, ${input.actionId}, 'execucao', ${input.amountMicros})`);
  }

  async summary(auth: AuthContext): Promise<BudgetResponse> {
    const tx = currentTx();
    const tenantId = tenantOf(auth);
    const period = await periodOf(tx, tenantId);
    const envelopes = await tx.execute<{ brand_id: string | null; limit_micros: string }>(sql`
      select brand_id, limit_micros from liame.budget_policy where tenant_id = ${tenantId} order by brand_id nulls first`);
    const out: BudgetResponse['envelopes'] = [];
    for (const env of envelopes.rows) {
      const committed = await this.committed(tx, tenantId, period, env.brand_id);
      const executed = await this.executedSum(tx, tenantId, period, env.brand_id);
      const limit = Number(env.limit_micros);
      out.push({ brand_id: env.brand_id, limit_micros: limit, committed_micros: committed, executed_micros: executed, available_micros: limit - committed });
    }
    return { period, envelopes: out };
  }

  async setPolicy(auth: AuthContext, input: BudgetPolicyRequest): Promise<void> {
    const tx = currentTx();
    const tenantId = tenantOf(auth);
    if (input.brand_id) {
      const b = await tx.execute(sql`select 1 from liame.brand where id = ${input.brand_id} and tenant_id = ${tenantId}`);
      if (!b.rows[0]) throw new AppProblem(404, 'nao-encontrado', 'Não encontramos', 'Marca não encontrada nesta empresa.');
    }
    const before = await tx.execute<{ limit_micros: string }>(sql`
      select limit_micros from liame.budget_policy where tenant_id = ${tenantId} and brand_id is not distinct from ${input.brand_id}`);
    await tx.execute(sql`
      insert into liame.budget_policy (id, tenant_id, brand_id, limit_micros, created_by)
      values (${uuidv7()}, ${tenantId}, ${input.brand_id}, ${input.limit_micros}, ${auth.userId})
      on conflict (tenant_id, brand_id) do update set limit_micros = excluded.limit_micros, updated_at = now()`);
    auditDetail({
      resourceId: input.brand_id ?? tenantId,
      before: before.rows[0] ? { limit_micros: Number(before.rows[0].limit_micros) } : null,
      after: { brand_id: input.brand_id, limit_micros: input.limit_micros },
    });
  }

  private async committed(tx: Tx, tenantId: string, period: string, brandId: string | null): Promise<number> {
    const r = await tx.execute<{ n: string }>(sql`
      select coalesce(sum(case kind when 'reserva' then amount_micros when 'liberacao' then -amount_micros else 0 end), 0)::text as n
        from liame.budget_ledger_entry
       where tenant_id = ${tenantId} and period = ${period} ${brandId ? sql`and brand_id = ${brandId}` : sql``}`);
    return Number(r.rows[0]?.n ?? 0);
  }

  private async executedSum(tx: Tx, tenantId: string, period: string, brandId: string | null): Promise<number> {
    const r = await tx.execute<{ n: string }>(sql`
      select coalesce(sum(amount_micros), 0)::text as n from liame.budget_ledger_entry
       where tenant_id = ${tenantId} and period = ${period} and kind = 'execucao' ${brandId ? sql`and brand_id = ${brandId}` : sql``}`);
    return Number(r.rows[0]?.n ?? 0);
  }
}

function tenantOf(auth: AuthContext): string {
  if (!auth.tenantId) throw new AppProblem(403, 'sem-empresa-ativa', 'Escolha uma empresa', 'Selecione uma empresa com acesso ativo.');
  return auth.tenantId;
}
