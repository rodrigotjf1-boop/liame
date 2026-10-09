import { createHash, randomUUID } from 'node:crypto';
import { ownerQuery } from './api.js';

// Pedidos e peças do Criativo gravados direto no banco, para os testes que só leem o trabalho dele (Sua equipe): o
// worker e a IA não entram. O caminho de verdade (pedir, escrever, conferir, decidir) é provado em `db/pecas*.spec.ts`.

export type DonoDasPecas = { tenantId: string; brandId: string; userId: string };

const hash = (texto: string) => createHash('sha256').update(texto).digest('hex');
const agora = () => new Date().toISOString();

/**
 * Um pedido de peças. `peca`: o pedido de outra versão dessa peça (sem ela, é um lote de peças novas). Por padrão, um
 * pedido atendido agora mesmo.
 */
export async function pedidoDePecas(
  q: DonoDasPecas,
  o: { oferta?: string; variacoes?: number; status?: 'pendente' | 'gerando' | 'concluido' | 'recusado' | 'falhou'; motivo?: string | null; pecas?: number; peca?: string | null; criadoEm?: string; terminouEm?: string | null; uso?: string | null } = {},
): Promise<string> {
  const id = randomUUID();
  const status = o.status ?? 'concluido';
  const emAndamento = status === 'pendente' || status === 'gerando';
  await ownerQuery(
    `insert into liame.ad_piece_request (id, tenant_id, brand_id, offer, dossier_version, destination, variations, piece_id, status, reason, pieces, usage_id, requested_by, created_at, finished_at)
     values ($1, $2, $3, $4, 1, 'cardapio', $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
    [id, q.tenantId, q.brandId, o.oferta ?? 'Combo sexta: smash, batata e refri por R$ 34,90', o.variacoes ?? 3, o.peca ?? null, status, o.motivo ?? null, o.pecas ?? 0, o.uso ?? null, q.userId, o.criadoEm ?? agora(), emAndamento ? null : (o.terminouEm ?? agora())],
  );
  return id;
}

/** Uma peça nascida de um pedido, com a versão 1 escrita pelo Criativo e a conferência dela. */
export async function pecaEscrita(
  q: DonoDasPecas,
  pedido: string,
  o: { titulo: string; status?: 'decidir' | 'aprovada' | 'recusada'; conferencia?: 'passou' | 'aviso' | 'barrou'; criadaEm?: string },
): Promise<string> {
  const id = randomUUID();
  const [status, conferencia, em] = [o.status ?? 'decidir', o.conferencia ?? 'passou', o.criadaEm ?? agora()];
  await ownerQuery(
    `insert into liame.ad_piece (id, tenant_id, brand_id, request_id, status, version, review_status, decided_by, decided_at, created_at)
     values ($1, $2, $3, $4, $5, 1, $6, $7, $8, $9)`,
    [id, q.tenantId, q.brandId, pedido, status, conferencia, status === 'decidir' ? null : q.userId, status === 'decidir' ? null : em, em],
  );
  await versaoDaPeca(q, id, { versao: 1, titulo: o.titulo, conferencia, pedido, em });
  return id;
}

/** Uma versão de uma peça escrita pelo Criativo (a primeira, ou a de um pedido de outra versão). */
export async function versaoDaPeca(q: DonoDasPecas, peca: string, o: { versao: number; titulo: string; conferencia?: 'passou' | 'aviso' | 'barrou'; pedido?: string | null; em?: string }): Promise<void> {
  const conferencia = o.conferencia ?? 'passou';
  await ownerQuery(
    `insert into liame.ad_piece_version (id, tenant_id, piece_id, version, title, body, button, review, review_status, rules_version, content_hash, author, request_id, created_at)
     values ($1, $2, $3, $4, $5, 'Smash, batata e refri. Peça pelo cardápio.', 'pedir_agora', '{}'::jsonb, $6, '{}'::jsonb, $7, 'criativo', $8, $9)`,
    [randomUUID(), q.tenantId, peca, o.versao, o.titulo, conferencia, hash(`${peca}/${o.versao}/${o.titulo}`), o.pedido ?? null, o.em ?? agora()],
  );
  if (o.versao > 1) await ownerQuery(`update liame.ad_piece set version = $2, review_status = $3 where id = $1`, [peca, o.versao, conferencia]);
}

/** A decisão de uma pessoa sobre uma versão de uma peça. */
export async function decisaoDaPeca(q: DonoDasPecas, peca: string, o: { versao: number; titulo: string; decisao: 'aprovada' | 'recusada' | 'contestada'; motivo?: string | null; em?: string }): Promise<void> {
  await ownerQuery(
    `insert into liame.ad_piece_decision (id, tenant_id, piece_id, version, content_hash, decision, reason, decided_by, created_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [randomUUID(), q.tenantId, peca, o.versao, hash(`${peca}/${o.versao}/${o.titulo}`), o.decisao, o.motivo ?? null, q.userId, o.em ?? agora()],
  );
}
