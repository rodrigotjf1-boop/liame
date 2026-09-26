import type { ActivateKillSwitchRequest, KillSwitchLevel, KillSwitchResponse } from '@liame/contracts';
import { type Tx, uuidv7 } from '@liame/database';
import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { type AuthContext, auditDetail, currentTx } from '../context/request-context.js';
import { AppProblem } from '../errors/problems.js';
import { emitEvent } from '../events/outbox.js';

/** O alvo de uma ação: o que o Action Service confere antes de executar (A1-10). */
export interface ActionTarget {
  tenantId: string;
  provider?: string | null;
  brandId?: string | null;
  accountId?: string | null;
  tool?: string | null;
}

export type ActiveSwitch = {
  id: string;
  level: KillSwitchLevel;
  reason: string;
};

type Row = {
  id: string;
  level: KillSwitchLevel;
  provider: string | null;
  brand_id: string | null;
  account_id: string | null;
  tool: string | null;
  reason: string;
  activated_at: Date | string;
  deactivated_at: Date | string | null;
};

// Ordem de checagem: do mais amplo ao mais estreito (a mensagem cita a trava mais ampla).
const ORDER: KillSwitchLevel[] = ['global', 'provider', 'tenant', 'brand', 'account', 'tool'];

/**
 * Travas de execução em seis níveis (ADR-007). Prevalecem sobre qualquer flag e sobre a autonomia.
 * A checagem roda na transação de quem vai executar e enxerga as travas da distribuição e as da empresa.
 */
@Injectable()
export class KillSwitchService {
  /** A trava ativa que pega este alvo (a mais ampla), ou nulo. */
  async check(tx: Tx, target: ActionTarget): Promise<ActiveSwitch | null> {
    const r = await tx.execute<ActiveSwitch>(sql`
      select id, level, reason from liame.kill_switch
       where deactivated_at is null and (
            level = 'global'
         or (level = 'provider' and provider = ${target.provider ?? null})
         or (level = 'tenant' and tenant_id = ${target.tenantId})
         or (level = 'brand' and tenant_id = ${target.tenantId} and brand_id = ${target.brandId ?? null})
         or (level = 'account' and tenant_id = ${target.tenantId} and provider = ${target.provider ?? null} and account_id = ${target.accountId ?? null})
         or (level = 'tool' and tenant_id = ${target.tenantId} and tool = ${target.tool ?? null}))`);
    return [...r.rows].sort((a, b) => ORDER.indexOf(a.level) - ORDER.indexOf(b.level))[0] ?? null;
  }

  /** Travas da empresa ativa (as da distribuição também aparecem, só para leitura). */
  async list(auth: AuthContext): Promise<KillSwitchResponse[]> {
    const r = await currentTx().execute<Row>(sql`
      select id, level, provider, brand_id, account_id, tool, reason, activated_at, deactivated_at from liame.kill_switch
       where (tenant_id = ${tenantOf(auth)} or tenant_id is null)
       order by deactivated_at nulls first, activated_at desc limit 200`);
    return r.rows.map(toResponse);
  }

  async activate(auth: AuthContext, input: ActivateKillSwitchRequest): Promise<KillSwitchResponse> {
    const tx = currentTx();
    const tenantId = tenantOf(auth);
    if (input.level === 'brand') {
      const b = await tx.execute(sql`select 1 from liame.brand where id = ${input.brand_id} and tenant_id = ${tenantId}`);
      if (!b.rows[0]) throw new AppProblem(404, 'nao-encontrado', 'Não encontramos', 'Marca não encontrada nesta empresa.');
    }
    const id = uuidv7();
    const r = await tx.execute<Row>(sql`
      insert into liame.kill_switch (id, level, tenant_id, provider, brand_id, account_id, tool, reason, activated_by)
      values (${id}, ${input.level}, ${tenantId},
              ${input.level === 'account' ? input.provider : null}, ${input.level === 'brand' ? input.brand_id : null},
              ${input.level === 'account' ? input.account_id : null}, ${input.level === 'tool' ? input.tool : null},
              ${input.reason}, ${auth.userId})
      returning id, level, provider, brand_id, account_id, tool, reason, activated_at, deactivated_at`);
    const row = r.rows[0]!;
    // O evento dispara, adiante, a pausa das entidades criadas pelos agentes no escopo (connectors, A2).
    await emitEvent(tx, { tenantId, type: 'liame.kill_switch.activated', subject: id, data: scopeOf(row) });
    auditDetail({ resourceId: id, after: { ...scopeOf(row), reason: input.reason } });
    return toResponse(row);
  }

  async deactivate(auth: AuthContext, id: string): Promise<void> {
    const tx = currentTx();
    const tenantId = tenantOf(auth);
    const r = await tx.execute<Row>(sql`
      update liame.kill_switch set deactivated_at = now(), deactivated_by = ${auth.userId}
       where id = ${id} and tenant_id = ${tenantId} and deactivated_at is null
       returning id, level, provider, brand_id, account_id, tool, reason, activated_at, deactivated_at`);
    const row = r.rows[0];
    if (!row) throw new AppProblem(404, 'nao-encontrado', 'Não encontramos', 'Trava ativa não encontrada nesta empresa.');
    await emitEvent(tx, { tenantId, type: 'liame.kill_switch.deactivated', subject: id, data: scopeOf(row) });
    auditDetail({ before: scopeOf(row) });
  }

  /** Trava da distribuição (global ou por provedor): console da DMS e testes, no escopo de sistema. */
  async activateSystem(tx: Tx, input: { level: 'global' | 'provider'; provider?: string; reason: string; by?: string | null }): Promise<string> {
    const id = uuidv7();
    await tx.execute(sql`
      insert into liame.kill_switch (id, level, provider, reason, activated_by)
      values (${id}, ${input.level}, ${input.level === 'provider' ? (input.provider ?? null) : null}, ${input.reason}, ${input.by ?? null})`);
    return id;
  }
}

function tenantOf(auth: AuthContext): string {
  if (!auth.tenantId) throw new AppProblem(403, 'sem-empresa-ativa', 'Escolha uma empresa', 'Selecione uma empresa com acesso ativo.');
  return auth.tenantId;
}

function scopeOf(r: Row): Record<string, unknown> {
  return { level: r.level, provider: r.provider, brand_id: r.brand_id, account_id: r.account_id, tool: r.tool };
}

function toResponse(r: Row): KillSwitchResponse {
  return {
    id: r.id,
    level: r.level,
    provider: r.provider,
    brand_id: r.brand_id,
    account_id: r.account_id,
    tool: r.tool,
    reason: r.reason,
    activated_at: new Date(r.activated_at).toISOString(),
    deactivated_at: r.deactivated_at === null ? null : new Date(r.deactivated_at).toISOString(),
  };
}
