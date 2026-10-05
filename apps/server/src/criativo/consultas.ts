import type { AdPieceResponse } from '@liame/contracts';
import { type SQL, sql } from 'drizzle-orm';
import { currentTx } from '../context/request-context.js';
import { type LinhaDaDecisao, type LinhaDaPeca, type LinhaDaVersao, respostaDaPeca } from './apresentacao.js';

// As leituras das peças que as rotas dividem (A4, X6): as colunas de cada resposta, as peças com a versão atual e a
// peça com o histórico. Rodam na transação de quem chama, sob a RLS da empresa.

export const COLUNAS_DO_PEDIDO = sql`r.id, r.brand_id, r.kind, r.offer, r.dossier_version, r.destination, r.variations, r.instruction, r.reference_ad_id, r.reference_name,
  r.piece_id, r.status, r.reason, r.pieces, r.requested_by, u.name as requester, r.created_at, r.finished_at`;

/** A peça com a oferta e o destino do pedido de onde nasceu, se veio do Criativo e se ele a está refazendo agora. */
export const COLUNAS_DA_PECA = sql`p.id, p.brand_id, p.request_id, p.status, q.offer, q.destination,
  exists (select 1 from liame.ad_piece_version x where x.piece_id = p.id and x.author = 'criativo') as ai_generated,
  exists (select 1 from liame.ad_piece_request y where y.piece_id = p.id and y.status in ('pendente', 'gerando')) as redoing,
  p.decided_by, d.name as decider, p.decided_at, p.created_at, p.updated_at`;

/**
 * A versão, com o custo de IA dela: a parte dela na chamada que a escreveu (uma chamada escreve todas as peças do
 * pedido; o pedido guarda quantas ficaram). Na versão de uma pessoa não há chamada, e o custo vem nulo.
 */
export const COLUNAS_DA_VERSAO = sql`v.version, v.title, v.body, v.button, v.review, v.content_hash, v.author, v.created_by, c.name as creator, v.created_at,
  (select (u.cost_usd_micros / greatest(rq.pieces, 1))::text
     from liame.ai_usage u join liame.ad_piece_request rq on rq.id = v.request_id
    where u.id = v.usage_id) as cost_usd_micros`;

/**
 * As peças que atendem à condição (escrita sobre `p`, a peça), as mais novas primeiro, cada uma com a versão atual e a
 * conferência dela. Duas leituras, qualquer que seja a quantidade.
 */
export async function pecasComAVersaoAtual(condicao: SQL, limite: number): Promise<AdPieceResponse[]> {
  const tx = currentTx();
  const pecas = await tx.execute<LinhaDaPeca & { version: number }>(sql`
    select ${COLUNAS_DA_PECA}, p.version
      from liame.ad_piece p
      join liame.ad_piece_request q on q.id = p.request_id
      left join liame.app_user d on d.id = p.decided_by
     where ${condicao}
     order by p.created_at desc, p.id desc
     limit ${limite}`);
  if (!pecas.rows.length) return [];
  // A versão atual de cada peça (o Drizzle abre a lista em parâmetros: `in`, nunca `= any`, V16).
  const ids = pecas.rows.map((p) => p.id);
  const versoes = await tx.execute<LinhaDaVersao & { piece_id: string }>(sql`
    select v.piece_id, ${COLUNAS_DA_VERSAO}
      from liame.ad_piece_version v
      join liame.ad_piece p on p.id = v.piece_id and p.version = v.version
      left join liame.app_user c on c.id = v.created_by
     where v.piece_id in ${ids}`);
  const atual = new Map(versoes.rows.map((v) => [v.piece_id, v]));
  return pecas.rows.filter((p) => atual.has(p.id)).map((p) => respostaDaPeca(p, atual.get(p.id)!));
}

/** Uma peça com todas as versões e as decisões, das mais novas para as mais antigas; nula quando não existe nesta empresa. */
export async function pecaComHistorico(id: string): Promise<AdPieceResponse | null> {
  const tx = currentTx();
  const peca = (
    await tx.execute<LinhaDaPeca & { version: number }>(sql`
      select ${COLUNAS_DA_PECA}, p.version
        from liame.ad_piece p
        join liame.ad_piece_request q on q.id = p.request_id
        left join liame.app_user d on d.id = p.decided_by
       where p.id = ${id}`)
  ).rows[0];
  if (!peca) return null;
  const versoes = await tx.execute<LinhaDaVersao>(sql`
    select ${COLUNAS_DA_VERSAO} from liame.ad_piece_version v left join liame.app_user c on c.id = v.created_by
     where v.piece_id = ${id}
     order by v.version desc`);
  const atual = versoes.rows.find((v) => v.version === peca.version);
  if (!atual) throw new Error(`peça ${id}: sem a versão ${peca.version}`);
  const decisoes = await tx.execute<LinhaDaDecisao>(sql`
    select x.decision, x.version, x.reason, x.comment, x.decided_by, u.name as decider, x.created_at
      from liame.ad_piece_decision x left join liame.app_user u on u.id = x.decided_by
     where x.piece_id = ${id}
     order by x.created_at desc, x.id desc`);
  return respostaDaPeca(peca, atual, { versoes: versoes.rows, decisoes: decisoes.rows });
}
