import { createHash } from 'node:crypto';
import type { Tx } from '@liame/database';
import { sql } from 'drizzle-orm';
import { recursoDoComentario } from '../actions/comentario-na-rede.js';
import type { TipoDaIa } from '../ai/social/comentario-tipo.js';
import { ehCodigo } from '../avaliacoes/sugestoes.js';
import { DIAS_DOS_PEDIDOS, type DonoDaVez, PEDIDO_EM_ANDAMENTO } from './pedidos.js';

// O tipo do comentário pela IA (A6, Z11, parte 2d-4c; D-A6-87 e D-A6-101; migration 0128). A regra do Liame decide o
// tipo do que é claro (`tipoPorRegra`); o comentário que ela deixa sem tipo não vira pedido. Com os pedidos do Social
// media ligados, a leitura dos comentários abre aqui a vez de cada um deles, e a rotina do worker pede o tipo ao modelo.
// O tipo que sai vai para o comentário (`kind_source = 'ia'`), e a vez do pedido abre na mesma transação; o "nenhum"
// fica só na vez. A vez é do comentário E do texto julgado (o SHA-256 dele): o mesmo texto não volta ao modelo, e o texto
// editado ganha uma vez nova.
//
// Todo passo é uma gravação condicional, como nos pedidos: só acontece se a linha está esperando, e devolve se
// aconteceu. Quem chama já está na transação da empresa. Nenhum texto fica aqui. Os horários são os do relógio de quem
// chama (V34).

/** Tentativas antes de desistir do tipo de um comentário (a IA fora do ar, a resposta fora do formato). */
export const TENTATIVAS_DO_TIPO = 3;

/** A marca do texto julgado: o SHA-256, em hexadecimal, do texto do comentário em UTF-8 (a mesma conta que o banco faz). */
export const marcaDoTexto = (texto: string): string => createHash('sha256').update(texto, 'utf8').digest('hex');

/** A mesma marca, no banco, a partir da coluna do texto do comentário. */
const marcaNoBanco = (coluna: ReturnType<typeof sql.raw>) => sql`encode(sha256(convert_to(${coluna}, 'UTF8')), 'hex')`;

const exigirCodigo = (c: string, oQue: string): void => {
  if (!ehCodigo(c)) throw new Error(`tipo dos comentários: ${oQue} fora do formato de código`);
};

/**
 * Abre a vez, de uma vez só, de cada comentário desta conta que a regra deixou sem tipo e que, com um tipo, pediria uma
 * ação da marca: de primeiro nível, de outra pessoa, à vista, sem resposta da marca, feito nos últimos 30 dias, com
 * texto, sem pedido de quem quer que seja sobre ele e ainda sem vez para este texto. Quem chama confere antes que os
 * pedidos estão ligados para a conta. Devolve quantas entraram.
 */
export async function abrirVezDosTipos(tx: Tx, conta: { tenantId: string; brandId: string; connectedAccountId: string }, agora: Date): Promise<number> {
  const instante = sql`${agora.toISOString()}::timestamptz`;
  const r = await tx.execute(sql`
    insert into liame.comment_kind_check (id, tenant_id, brand_id, connected_account_id, comment_id, text_sha256, status, next_attempt_at, created_at, updated_at)
    select gen_random_uuid(), c.tenant_id, c.brand_id, c.connected_account_id, c.comment_id, ${marcaNoBanco(sql.raw('c.message'))}, 'esperando', ${instante}, ${instante}, ${instante}
      from liame.social_comment c
     where c.connected_account_id = ${conta.connectedAccountId} and c.tenant_id = ${conta.tenantId} and c.brand_id = ${conta.brandId}
       and c.parent_comment_id is null and not c.by_brand and not c.hidden
       and c.kind is null and c.kind_source is null
       and length(btrim(c.message)) > 0
       and c.published_at >= ${instante} - make_interval(days => ${DIAS_DOS_PEDIDOS})
       and not exists (select 1 from liame.social_comment r
                        where r.connected_account_id = c.connected_account_id and r.parent_comment_id = c.comment_id and r.by_brand)
       and not exists (select 1 from liame.comment_kind_check k
                        where k.connected_account_id = c.connected_account_id and k.comment_id = c.comment_id
                          and k.text_sha256 = ${marcaNoBanco(sql.raw('c.message'))})
       -- O recurso do pedido é "comentario:" seguido do id na rede (o prefixo vem de recursoDoComentario).
       and not exists (
         select 1 from liame.action_request q
          where q.tenant_id = c.tenant_id and q.account_id = c.connected_account_id::text
            and q.resource_id = ${recursoDoComentario('')} || c.comment_id
            and q.status in ${[...PEDIDO_EM_ANDAMENTO]})
    on conflict (connected_account_id, comment_id, text_sha256) do nothing
    returning id`);
  return r.rows.length;
}

export type VezDoTipoGuardada = {
  id: string;
  brand_id: string;
  connected_account_id: string;
  comment_id: string;
  text_sha256: string;
  status: string;
  attempts: number;
};

/** A vez como está guardada, para a rotina retomar de onde parou. Nula se não é desta empresa. */
export async function lerVezDoTipo(tx: Tx, alvo: DonoDaVez): Promise<VezDoTipoGuardada | null> {
  const r = await tx.execute<VezDoTipoGuardada>(sql`
    select id, brand_id, connected_account_id, comment_id, text_sha256, status, attempts
      from liame.comment_kind_check
     where id = ${alvo.id} and tenant_id = ${alvo.tenantId}`);
  return r.rows[0] ?? null;
}

/** Não é a vez dele agora, e não por falha dele (uma chave desligada, sem rota, no limite): marca o porquê e quando olhar de novo. */
export async function esperarVezDoTipo(tx: Tx, alvo: DonoDaVez, motivo: string, ate: Date, agora: Date): Promise<boolean> {
  exigirCodigo(motivo, 'o motivo');
  const r = await tx.execute(sql`
    update liame.comment_kind_check
       set reason = ${motivo}, next_attempt_at = ${ate.toISOString()}::timestamptz, updated_at = ${agora.toISOString()}::timestamptz
     where id = ${alvo.id} and tenant_id = ${alvo.tenantId} and status = 'esperando'
    returning id`);
  return r.rows.length === 1;
}

/** Não deu agora (a IA fora do ar, a resposta fora do formato): conta a tentativa e marca quando tentar de novo. */
export async function adiarVezDoTipo(tx: Tx, alvo: DonoDaVez, motivo: string, ate: Date, agora: Date): Promise<boolean> {
  exigirCodigo(motivo, 'o motivo');
  const r = await tx.execute(sql`
    update liame.comment_kind_check
       set attempts = attempts + 1, reason = ${motivo}, next_attempt_at = ${ate.toISOString()}::timestamptz, updated_at = ${agora.toISOString()}::timestamptz
     where id = ${alvo.id} and tenant_id = ${alvo.tenantId} and status = 'esperando'
    returning id`);
  return r.rows.length === 1;
}

/** A vez acaba sem tipo: `descartada` (o texto mudou, já respondido, oculto, antigo, sumiu…) ou `falhou` (depois das tentativas). */
export async function encerrarVezDoTipo(
  tx: Tx,
  alvo: DonoDaVez,
  fim: 'descartada' | 'falhou',
  motivo: string,
  agora: Date,
  extra: { usageId?: string | null; contarTentativa?: boolean } = {},
): Promise<boolean> {
  exigirCodigo(motivo, 'o motivo');
  const quando = sql`${agora.toISOString()}::timestamptz`;
  const r = await tx.execute(sql`
    update liame.comment_kind_check
       set status = ${fim}, reason = ${motivo}, usage_id = coalesce(${extra.usageId ?? null}::uuid, usage_id),
           attempts = attempts + ${extra.contarTentativa ? 1 : 0}, next_attempt_at = null, finished_at = ${quando}, updated_at = ${quando}
     where id = ${alvo.id} and tenant_id = ${alvo.tenantId} and status = 'esperando'
    returning id`);
  return r.rows.length === 1;
}

/** O tipo saiu: a vez acaba pronta, com o tipo (ou "nenhum") e o porquê do código quando ele trocou o do modelo. */
export async function marcarTipo(tx: Tx, alvo: DonoDaVez, feito: { tipo: TipoDaIa; motivo: string | null; usageId: string | null }, agora: Date): Promise<boolean> {
  if (feito.motivo) exigirCodigo(feito.motivo, 'o motivo');
  const quando = sql`${agora.toISOString()}::timestamptz`;
  const r = await tx.execute(sql`
    update liame.comment_kind_check
       set status = 'pronta', result = ${feito.tipo}, reason = ${feito.motivo}, usage_id = ${feito.usageId},
           next_attempt_at = null, finished_at = ${quando}, updated_at = ${quando}
     where id = ${alvo.id} and tenant_id = ${alvo.tenantId} and status = 'esperando'
    returning id`);
  return r.rows.length === 1;
}

/**
 * O comentário ganha o tipo que a IA decidiu, só se ele ainda está sem tipo e com o MESMO texto que foi julgado (a regra
 * ou a leitura podem ter mudado no meio). Devolve se gravou.
 */
export async function gravarTipoNoComentario(
  tx: Tx,
  alvo: { tenantId: string; connectedAccountId: string; commentId: string; textSha256: string },
  tipo: Exclude<TipoDaIa, 'nenhum'>,
): Promise<boolean> {
  const r = await tx.execute(sql`
    update liame.social_comment c
       set kind = ${tipo}, kind_source = 'ia'
     where c.connected_account_id = ${alvo.connectedAccountId} and c.comment_id = ${alvo.commentId} and c.tenant_id = ${alvo.tenantId}
       and c.kind is null and c.kind_source is null
       and ${marcaNoBanco(sql.raw('c.message'))} = ${alvo.textSha256}
    returning c.comment_id`);
  return r.rows.length === 1;
}
