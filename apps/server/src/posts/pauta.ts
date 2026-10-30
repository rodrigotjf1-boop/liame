import type { Tx } from '@liame/database';
import { sql } from 'drizzle-orm';
import { normalizar } from '../policy/texto.js';

// A pauta da semana nos dias (A6, Z5d, parte 5, D-A6-56; Z6, os posts, D-A6-60): o item de cada dia, do plano de pauta
// do Estrategista APROVADO mais novo da marca que cobre o dia, pela versão atual dele. A Agenda mostra; o Social media
// transforma em post. Uma regra só, aqui, para as duas lerem o mesmo item.

export type ItemDaPauta = { day: string; item: string; plan_id: string };

/** Os itens da pauta aprovada da marca de `de` a `ate` (os dois dias inclusive, `AAAA-MM-DD`), um por dia. Na transação de quem chama. */
export async function itensDaPauta(tx: Tx, tenantId: string, brandId: string, de: string, ate: string): Promise<ItemDaPauta[]> {
  const r = await tx.execute<ItemDaPauta>(sql`
    select distinct on (d.day) to_char(d.day, 'YYYY-MM-DD') as day, d.item, p.id as plan_id
      from liame.plan p
      join liame.plan_version v on v.plan_id = p.id and v.version = p.version and v.tenant_id = p.tenant_id
      cross join lateral jsonb_to_recordset(case when jsonb_typeof(v.content->'days') = 'array' then v.content->'days' else '[]'::jsonb end) as d(day date, item text)
     where p.tenant_id = ${tenantId} and p.brand_id = ${brandId} and p.kind = 'pauta' and p.status = 'aprovado'
       and d.day between ${de}::date and ${ate}::date and d.item is not null
     order by d.day, p.updated_at desc, p.id desc`);
  return r.rows;
}

/** O dia sem nada na pauta: o Estrategista escreve "nada novo" (o prompt dele pede assim). Não vira post. */
export function ehNadaNovo(item: string): boolean {
  let n = normalizar(item).trim();
  while (n.endsWith('.') || n.endsWith('!')) n = n.slice(0, -1).trim();
  return n === '' || n === 'nada novo';
}
