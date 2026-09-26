import type { Tx } from '@liame/database';
import { sql } from 'drizzle-orm';
import type { ResourceState } from './tools.js';

// Connectors (arquitetura §6): um por provedor, com a mesma interface. Na A1 só existe o sandbox
// (no próprio banco); Meta, Google e GA4 chegam na A2 e passam pelo mesmo Action Service.

export interface ResourceRef {
  tenantId: string;
  accountId: string;
  resourceId: string;
}

export interface ReadResult {
  state: ResourceState;
  version: number;
}

export type ApplyResult =
  | { ok: true; state: ResourceState; version: number }
  /** O recurso mudou desde o pedido: não sobrescreve (ADR-007, compensação). */
  | { ok: false; reason: 'estado-mudou'; current: ReadResult };

export interface Connector {
  readonly provider: string;
  /** Flag de escrita do provedor (ADR-012); nula = sem flag (sandbox). */
  readonly writeFlag: string | null;
  read(tx: Tx, ref: ResourceRef): Promise<ReadResult | null>;
  /** Aplica o estado desejado se a versão ainda for a esperada (concorrência otimista). */
  apply(tx: Tx, ref: ResourceRef, desired: ResourceState, expectedVersion: number, options?: { validateOnly?: boolean }): Promise<ApplyResult>;
}

export class SandboxConnector implements Connector {
  readonly provider = 'sandbox';
  readonly writeFlag = null;

  async read(tx: Tx, ref: ResourceRef): Promise<ReadResult | null> {
    const r = await tx.execute<{ state: ResourceState; version: number }>(sql`
      select state, version from liame.sandbox_resource
       where tenant_id = ${ref.tenantId} and account_id = ${ref.accountId} and resource_id = ${ref.resourceId}`);
    return r.rows[0] ?? null;
  }

  async apply(tx: Tx, ref: ResourceRef, desired: ResourceState, expectedVersion: number, options: { validateOnly?: boolean } = {}): Promise<ApplyResult> {
    const current = await this.read(tx, ref);
    if (!current || current.version !== expectedVersion) {
      return { ok: false, reason: 'estado-mudou', current: current ?? { state: {}, version: 0 } };
    }
    if (options.validateOnly) return { ok: true, state: desired, version: current.version };
    const r = await tx.execute<{ version: number }>(sql`
      update liame.sandbox_resource set state = ${JSON.stringify(desired)}::jsonb, version = version + 1, updated_at = now()
       where tenant_id = ${ref.tenantId} and account_id = ${ref.accountId} and resource_id = ${ref.resourceId} and version = ${expectedVersion}
       returning version`);
    const row = r.rows[0];
    if (!row) return { ok: false, reason: 'estado-mudou', current: (await this.read(tx, ref)) ?? { state: {}, version: 0 } };
    return { ok: true, state: desired, version: row.version };
  }
}

export const CONNECTORS: Record<string, Connector> = { sandbox: new SandboxConnector() };
