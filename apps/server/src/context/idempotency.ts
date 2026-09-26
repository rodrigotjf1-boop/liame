import { createHash } from 'node:crypto';
import type { Tx } from '@liame/database';
import { sql } from 'drizzle-orm';
import { AppProblem } from '../errors/problems.js';

// Idempotency-Key (draft-ietf-httpapi-idempotency-key-header, ADR-004): a mesma chave com o mesmo
// pedido devolve a mesma resposta; com outro pedido, 422. A resposta é gravada na MESMA transação da
// mutação: ou as duas ficam, ou nenhuma. Pedido simultâneo com a mesma chave espera o primeiro
// terminar (índice único) e recebe a resposta dele.

export const IDEMPOTENCY_HEADER = 'idempotency-key';
export const REPLAYED_HEADER = 'Idempotent-Replayed';
const TTL_HOURS = 24;
const KEY_PATTERN = /^[\x21-\x7e]{1,255}$/;

export interface IdempotentRequest {
  key: string;
  method: string;
  path: string;
  hash: string;
}

export function readIdempotencyKey(headers: Record<string, string | string[] | undefined>): string | undefined {
  const raw = headers[IDEMPOTENCY_HEADER];
  if (raw === undefined) return undefined;
  const key = Array.isArray(raw) ? raw[0] : raw;
  if (!key || !KEY_PATTERN.test(key)) {
    throw new AppProblem(400, 'idempotency-key-invalida', 'Idempotency-Key inválida', 'Use de 1 a 255 caracteres visíveis, sem espaço.');
  }
  return key;
}

export function requestHash(method: string, path: string, body: unknown): string {
  return createHash('sha256').update(`${method}\n${path}\n${canonicalJson(body ?? null)}`).digest('hex');
}

/** JSON com as chaves em ordem: o mesmo corpo com as chaves em outra ordem é o mesmo pedido. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export type Claim = { replay: false } | { replay: true; status: number; body: unknown };

/**
 * Reserva a chave na transação da requisição. Se já existe (e não venceu), devolve a resposta gravada
 * ou recusa com 422 quando o pedido é outro.
 */
export async function claimIdempotencyKey(tx: Tx, ids: { userId: string; tenantId: string | null }, req: IdempotentRequest): Promise<Claim> {
  await tx.execute(sql`
    delete from liame.idempotency_key
     where user_id = ${ids.userId} and tenant_id is not distinct from ${ids.tenantId} and key = ${req.key} and expires_at <= now()`);
  const inserted = await tx.execute(sql`
    insert into liame.idempotency_key (user_id, tenant_id, key, method, path, request_hash, response_status, expires_at)
    values (${ids.userId}, ${ids.tenantId}, ${req.key}, ${req.method}, ${req.path}, ${req.hash}, 0,
            now() + make_interval(hours => ${TTL_HOURS}))
    on conflict do nothing`);
  if (inserted.rowCount === 1) return { replay: false };

  const r = await tx.execute<{ request_hash: string; response_status: number; response_body: unknown }>(sql`
    select request_hash, response_status, response_body from liame.idempotency_key
     where user_id = ${ids.userId} and tenant_id is not distinct from ${ids.tenantId} and key = ${req.key}`);
  const row = r.rows[0];
  if (!row || row.request_hash !== req.hash) {
    throw new AppProblem(
      422,
      'idempotency-key-reutilizada',
      'Chave já usada em outro pedido',
      'Esta Idempotency-Key já foi usada com outro método, caminho ou corpo. Gere uma chave nova para um pedido novo.',
    );
  }
  return { replay: true, status: row.response_status, body: row.response_body };
}

export async function storeIdempotentResponse(
  tx: Tx,
  ids: { userId: string; tenantId: string | null },
  key: string,
  status: number,
  body: unknown,
): Promise<void> {
  await tx.execute(sql`
    update liame.idempotency_key set response_status = ${status}, response_body = ${body === undefined ? null : JSON.stringify(body)}::jsonb
     where user_id = ${ids.userId} and tenant_id is not distinct from ${ids.tenantId} and key = ${key}`);
}
