import { type SQL, sql } from 'drizzle-orm';

// A ordem de um lote reservado na fila (ERR-135). Os laços do worker reservam com
// `with devidas as materialized (select … order by … limit … for update skip locked) update … from devidas returning …`,
// e o Postgres NÃO garante que o `returning` volte na ordem da consulta que reservou: a mesma fila pode ser tratada
// numa ordem diferente a cada volta. Para a ordem valer, cada linha devolve a vez dela (`vezNaFila`), e o lote é
// ordenado aqui (`naOrdemDaFila`) antes de ser tratado.

/** A vez de uma linha na fila, como texto que se ordena: o instante em UTC, com os microssegundos. */
export function vezNaFila(instante: SQL): SQL {
  return sql`to_char((${instante}) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US')`;
}

/** O lote na ordem da fila: a vez mais antiga primeiro; na mesma vez, o id (como o `order by …, id` da reserva). */
export function naOrdemDaFila<T extends { id: string; vez: string }>(linhas: readonly T[]): T[] {
  const antes = (x: string, y: string) => (x < y ? -1 : x > y ? 1 : 0);
  return [...linhas].sort((a, b) => antes(a.vez, b.vez) || antes(a.id, b.id));
}
