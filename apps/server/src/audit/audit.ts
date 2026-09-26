import { createHash } from 'node:crypto';
import { type Tx, uuidv7 } from '@liame/database';
import { trace } from '@opentelemetry/api';
import { sql } from 'drizzle-orm';

// Auditoria append-only com hash encadeado (security-model §7). Cada evento guarda o hash do anterior
// da mesma cadeia; mudar ou apagar um evento quebra todos os seguintes. A raiz do dia vai para fora do
// banco (âncora, ADR-011), então nem quem controla o banco reescreve a história sem ser notado.

export type ActorType = 'human' | 'agent' | 'integration' | 'system' | 'partner';
export type AuditOrigin = 'api' | 'worker' | 'mcp' | 'console';

export interface AuditInput {
  /** Empresa do evento; sem empresa, vai para a cadeia da pessoa (`actorId`). */
  tenantId: string | null;
  actorType: ActorType;
  actorId: string | null;
  actorLabel?: string | null;
  actorRole?: string | null;
  /** Código em português, como as permissões: `marca.criar`. */
  action: string;
  resourceType?: string | null;
  resourceId?: string | null;
  /** Só o necessário, sem segredo nem dado pessoal além do preciso (valores simples: texto, inteiro, booleano). */
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
  reason?: string | null;
  approvalId?: string | null;
  traceId?: string | null;
  origin: AuditOrigin;
  tool?: string | null;
  agent?: string | null;
  model?: string | null;
}

/** Linha como fica no banco: é dela que o hash é recalculado na verificação. */
export type AuditRecord = {
  id: string;
  chain_key: string;
  chain_seq: number;
  tenant_id: string | null;
  actor_type: ActorType;
  actor_id: string | null;
  actor_label: string | null;
  actor_role: string | null;
  action: string;
  resource_type: string | null;
  resource_id: string | null;
  before: unknown;
  after: unknown;
  reason: string | null;
  approval_id: string | null;
  trace_id: string | null;
  origin: AuditOrigin;
  tool: string | null;
  agent: string | null;
  model: string | null;
  occurred_at: string;
};

const SYSTEM_CHAIN = '00000000-0000-0000-0000-000000000000';

/** Trace da requisição atual, quando houver (liga a auditoria aos logs e spans). */
export function activeTraceId(): string | null {
  const id = trace.getActiveSpan()?.spanContext().traceId;
  return id && !/^0+$/.test(id) ? id : null;
}

export function chainKeyOf(tenantId: string | null, actorId: string | null): string {
  return tenantId ?? actorId ?? SYSTEM_CHAIN;
}

export function genesisHash(chainKey: string): string {
  return sha256(`liame:auditoria:inicio:${chainKey}`);
}

export function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/** JSON com as chaves em ordem: a mesma informação dá sempre o mesmo texto, venha do app ou do banco. */
export function canonicalJson(value: unknown): string {
  if (value === undefined || value === null) return 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function hashRecord(prevHash: string, r: AuditRecord): string {
  const body = canonicalJson({
    id: r.id,
    chain_key: r.chain_key,
    chain_seq: Number(r.chain_seq),
    tenant_id: r.tenant_id,
    actor_type: r.actor_type,
    actor_id: r.actor_id,
    actor_label: r.actor_label,
    actor_role: r.actor_role,
    action: r.action,
    resource_type: r.resource_type,
    resource_id: r.resource_id,
    before: r.before ?? null,
    after: r.after ?? null,
    reason: r.reason,
    approval_id: r.approval_id,
    trace_id: r.trace_id,
    origin: r.origin,
    tool: r.tool,
    agent: r.agent,
    model: r.model,
    occurred_at: new Date(r.occurred_at).toISOString(),
  });
  return sha256(`${prevHash}\n${body}`);
}

/**
 * Grava um evento na transação de quem muda o dado: a mutação e a auditoria entram juntas ou não entram.
 * A cadeia é travada só durante esta transação e só para esta empresa (ou pessoa).
 */
export async function writeAudit(tx: Tx, input: AuditInput): Promise<string> {
  const chainKey = chainKeyOf(input.tenantId, input.actorId);
  await tx.execute(sql`
    insert into liame.audit_chain (chain_key, last_seq, last_hash) values (${chainKey}, 0, ${genesisHash(chainKey)})
    on conflict (chain_key) do nothing`);
  // O UPDATE trava a cadeia e só então lê o relógio do banco: dentro da cadeia, a ordem e o tempo andam juntos.
  const head = await tx.execute<{ seq: string; prev: string; now: Date | string }>(sql`
    update liame.audit_chain set last_seq = last_seq + 1, updated_at = now()
     where chain_key = ${chainKey}
     returning last_seq as seq, last_hash as prev, clock_timestamp() as now`);
  const row = head.rows[0]!;
  const record: AuditRecord = {
    id: uuidv7(),
    chain_key: chainKey,
    chain_seq: Number(row.seq),
    tenant_id: input.tenantId,
    actor_type: input.actorType,
    actor_id: input.actorId,
    actor_label: input.actorLabel ?? null,
    actor_role: input.actorRole ?? null,
    action: input.action,
    resource_type: input.resourceType ?? null,
    resource_id: input.resourceId ?? null,
    before: input.before ?? null,
    after: input.after ?? null,
    reason: input.reason ?? null,
    approval_id: input.approvalId ?? null,
    trace_id: input.traceId ?? null,
    origin: input.origin,
    tool: input.tool ?? null,
    agent: input.agent ?? null,
    model: input.model ?? null,
    // Milissegundos: o que o JavaScript guarda e devolve igual.
    occurred_at: new Date(new Date(row.now).getTime()).toISOString(),
  };
  const hash = hashRecord(row.prev, record);
  await tx.execute(sql`
    insert into liame.audit_event (id, chain_key, chain_seq, tenant_id, actor_type, actor_id, actor_label, actor_role, action,
                                   resource_type, resource_id, before, after, reason, approval_id, trace_id, origin, tool, agent,
                                   model, occurred_at, prev_hash, hash)
    values (${record.id}, ${chainKey}, ${record.chain_seq}, ${record.tenant_id}, ${record.actor_type}, ${record.actor_id},
            ${record.actor_label}, ${record.actor_role}, ${record.action}, ${record.resource_type}, ${record.resource_id},
            ${jsonOrNull(record.before)}::jsonb, ${jsonOrNull(record.after)}::jsonb, ${record.reason}, ${record.approval_id},
            ${record.trace_id}, ${record.origin}, ${record.tool}, ${record.agent}, ${record.model}, ${record.occurred_at},
            ${row.prev}, ${hash})`);
  await tx.execute(sql`update liame.audit_chain set last_hash = ${hash} where chain_key = ${chainKey}`);
  return record.id;
}

function jsonOrNull(v: unknown): string | null {
  return v === null || v === undefined ? null : JSON.stringify(v);
}

export interface ChainCheck {
  ok: boolean;
  events: number;
  headSeq: number;
  /** Primeiro evento que não confere (hash, ligação ou sequência). */
  brokenAtSeq: number | null;
  reason: string | null;
}

/**
 * Recalcula a cadeia inteira, em lotes, e confere com a cabeça guardada. Serve para a verificação
 * periódica e para a empresa conferir a própria auditoria.
 */
export async function verifyChain(tx: Tx, chainKey: string, batch = 1_000): Promise<ChainCheck> {
  let prev = genesisHash(chainKey);
  let expectedSeq = 1;
  let events = 0;
  for (;;) {
    const r = await tx.execute<AuditRecord & { prev_hash: string; hash: string }>(sql`
      select id, chain_key, chain_seq, tenant_id, actor_type, actor_id, actor_label, actor_role, action, resource_type,
             resource_id, before, after, reason, approval_id, trace_id, origin, tool, agent, model, occurred_at, prev_hash, hash
        from liame.audit_event where chain_key = ${chainKey} and chain_seq >= ${expectedSeq}
       order by chain_seq limit ${batch}`);
    for (const e of r.rows) {
      const seq = Number(e.chain_seq);
      const fail = (reason: string): ChainCheck => ({ ok: false, events, headSeq: expectedSeq - 1, brokenAtSeq: seq, reason });
      if (seq !== expectedSeq) return fail(`falta o evento ${expectedSeq}`);
      if (e.prev_hash !== prev) return fail('não liga com o anterior');
      if (hashRecord(prev, e) !== e.hash) return fail('conteúdo alterado');
      prev = e.hash;
      expectedSeq++;
      events++;
    }
    if (r.rows.length < batch) break;
  }
  const head = await tx.execute<{ last_seq: string; last_hash: string }>(sql`
    select last_seq, last_hash from liame.audit_chain where chain_key = ${chainKey}`);
  const h = head.rows[0];
  const headSeq = h ? Number(h.last_seq) : 0;
  if (h && (headSeq !== expectedSeq - 1 || h.last_hash !== prev)) {
    return { ok: false, events, headSeq, brokenAtSeq: expectedSeq, reason: 'eventos apagados no fim da cadeia' };
  }
  return { ok: true, events, headSeq, brokenAtSeq: null, reason: null };
}
