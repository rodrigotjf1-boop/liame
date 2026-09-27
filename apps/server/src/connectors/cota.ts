import { createHash } from 'node:crypto';
import type { Db } from '@liame/database';
import { sql } from 'drizzle-orm';

// Cota e disjuntor compartilhados entre os workers (arquitetura §6): as cotas das plataformas são do
// app e valem para todas as empresas juntas. Transações curtas e próprias (fora da transação da
// empresa), para uma conta não segurar a fila das outras. Chaves em hash: nada revela contas.

export function chaveDe(...partes: string[]): string {
  return createHash('sha256').update(partes.join('\u0000')).digest('hex');
}

export type Balde = { capacidade: number; porSegundo: number };

/**
 * Tira `custo` fichas do balde. Sem fichas suficientes, não tira nada e diz quanto esperar.
 * Uma instrução só: dois workers ao mesmo tempo nunca gastam a mesma ficha.
 */
export async function consumirFichas(db: Db, chave: string, balde: Balde, custo = 1): Promise<{ ok: boolean; esperarMs: number }> {
  const r = await db.execute<{ tokens: string }>(sql`
    insert into liame.quota_bucket (bucket_key, capacity, refill_per_second, tokens, refilled_at)
    values (${chave}, ${balde.capacidade}, ${balde.porSegundo}, ${balde.capacidade - custo}, now())
    on conflict (bucket_key) do update
       set tokens = least(excluded.capacity,
                          liame.quota_bucket.tokens + extract(epoch from (now() - liame.quota_bucket.refilled_at)) * liame.quota_bucket.refill_per_second)
                    - ${custo},
           refilled_at = now(),
           capacity = excluded.capacity,
           refill_per_second = excluded.refill_per_second
     where least(excluded.capacity,
                 liame.quota_bucket.tokens + extract(epoch from (now() - liame.quota_bucket.refilled_at)) * liame.quota_bucket.refill_per_second) >= ${custo}
    returning tokens::text`);
  if (r.rows[0]) return { ok: true, esperarMs: 0 };
  const atual = await db.execute<{ faltam: string }>(sql`
    select greatest(0, ${custo} - least(capacity, tokens + extract(epoch from (now() - refilled_at)) * refill_per_second))::text as faltam
      from liame.quota_bucket where bucket_key = ${chave}`);
  const faltam = Number(atual.rows[0]?.faltam ?? custo);
  return { ok: false, esperarMs: Math.ceil((faltam / balde.porSegundo) * 1000) };
}

const LIMITE_FALHAS = 5;
const ESPERA_BASE_MS = 60_000;
const ESPERA_MAX_MS = 30 * 60_000;

/** Aberto = não chamar até `ateMs`. */
export async function disjuntorAberto(db: Db, chave: string): Promise<{ aberto: boolean; ateMs: number }> {
  const r = await db.execute<{ ate: Date | string | null }>(sql`
    select open_until as ate from liame.circuit_state where circuit_key = ${chave} and open_until > now()`);
  const ate = r.rows[0]?.ate;
  return ate ? { aberto: true, ateMs: new Date(ate).getTime() } : { aberto: false, ateMs: 0 };
}

/**
 * Falha que vale para o disjuntor (fora do ar, tempo esgotado, 5xx). Na quinta seguida, abre por
 * 1 minuto; cada nova abertura dobra a espera, até 30 minutos.
 */
export async function registrarFalha(db: Db, chave: string, erro: string): Promise<void> {
  await db.execute(sql`
    insert into liame.circuit_state (circuit_key, failures, last_error, updated_at)
    values (${chave}, 1, ${erro.slice(0, 300)}, now())
    on conflict (circuit_key) do update
       set failures = liame.circuit_state.failures + 1,
           last_error = excluded.last_error,
           updated_at = now(),
           opened_times = liame.circuit_state.opened_times + (case when liame.circuit_state.failures + 1 >= ${LIMITE_FALHAS} then 1 else 0 end),
           open_until = case when liame.circuit_state.failures + 1 >= ${LIMITE_FALHAS}
                             then now() + make_interval(secs => least(${ESPERA_MAX_MS}, ${ESPERA_BASE_MS} * power(2, liame.circuit_state.opened_times)) / 1000.0)
                             else liame.circuit_state.open_until end`);
  await db.execute(sql`
    update liame.circuit_state set failures = 0 where circuit_key = ${chave} and failures >= ${LIMITE_FALHAS}`);
}

/** Sucesso fecha o disjuntor e zera as contagens. */
export async function registrarSucesso(db: Db, chave: string): Promise<void> {
  await db.execute(sql`
    update liame.circuit_state set failures = 0, opened_times = 0, open_until = null, updated_at = now()
     where circuit_key = ${chave} and (failures > 0 or open_until is not null or opened_times > 0)`);
}
