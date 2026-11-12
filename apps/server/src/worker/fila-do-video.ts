import { type Database, withSystem } from '@liame/database';
import { sql } from 'drizzle-orm';

// A fila do vídeo montado (A6 · Z15; D-A6-140): a tabela `video_montage` é a fila, uma só para todas as marcas, e o
// serviço de montagem faz um vídeo por vez. Contar quem está na frente atravessa as empresas, por isso fica aqui, no
// escopo do sistema (V53; a regra `liame-escopo-sistema` do Semgrep), e devolve só o número.

/** A chave de um pedido na fila: o id e o `created_at` exato (o texto do banco, com os microssegundos). */
export type ChaveDaFila = { id: string; chave: string };

/**
 * Quantos pedidos de todas as marcas estão na frente de cada um (na fila ou montando). A contagem é numa conexão do
 * sistema, que não enxerga o pedido que a transação da requisição acabou de gravar: por isso vai a chave de cada
 * pedido, e não o id para ela procurar (ERR-202, reincidência de 12/11/2026).
 */
export async function contarNaFrente(database: Database, pedidos: ChaveDaFila[]): Promise<Map<string, number>> {
  const saida = new Map<string, number>();
  if (!pedidos.length) return saida;
  const ids = `{${pedidos.map((p) => p.id).join(',')}}`;
  const chaves = `{${pedidos.map((p) => `"${p.chave}"`).join(',')}}`;
  const r = await withSystem(database.db, (tx) =>
    tx.execute<{ id: string; frente: number }>(sql`
      select p.id, (select count(*)::int from liame.video_montage o
                     where o.status in ('na_fila', 'montando') and (o.created_at, o.id) < (p.chave, p.id)) as frente
        from unnest(${ids}::uuid[], ${chaves}::timestamptz[]) as p (id, chave)`),
  );
  for (const l of r.rows) saida.set(l.id, Number(l.frente));
  return saida;
}
