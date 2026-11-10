import type { Tx } from '@liame/database';
import { sql } from 'drizzle-orm';
import { recursoDoComentario } from '../actions/comentario-na-rede.js';
import { funcionarioAtivo } from '../ai/registro/ativacao.js';
import { SOCIAL } from '../ai/social/prompt.js';
import { ehCodigo } from '../avaliacoes/sugestoes.js';
import type { FlagService } from '../flags/flag.service.js';
import { FLAG_DOS_COMENTARIOS } from './comentarios.js';

// Os pedidos do Social media para os comentários (A6, Z11, parte 2d-2; D-A6-88, D-A6-89, D-A6-94 e D-A6-98; migration
// 0125). A leitura dos comentários abre a vez de cada comentário que pede uma ação da marca, com a função ligada; a rotina
// do worker monta o pedido em Aprovações: a resposta pronta ao elogio e à marcação (sem IA), as sugestões do Social media
// à pergunta e à reclamação (o que a conferência deixou passar) e ocultar o golpe e o ofensivo. Aqui ficam o caminho de
// cada comentário e cada passo dele no banco.
//
// Todo passo é uma gravação condicional: só acontece se a linha está esperando, e devolve se aconteceu. A rotina que
// roda duas vezes, ou que volta depois de cair no meio, não pede em dobro nem desfaz o que já acabou. Quem chama já está
// na transação da empresa (a RLS isola a empresa). Nenhum texto fica aqui: o das sugestões vai no pedido. Os horários são
// os do relógio de quem chama (V34).

/** A função dos pedidos para os comentários (migration 0125): nasce desligada; quem liga é a distribuição, empresa por empresa. */
export const FLAG_DOS_PEDIDOS = 'comentarios_sugeridos';
/** A resposta e o ocultar pelo Liame (migration 0124 e a dos posts): sem elas, o pedido nem nasceria. */
export const FLAG_DA_RESPOSTA_AO_COMENTARIO = 'comentarios_responder';
export const FLAG_DA_ESCRITA_NAS_REDES = 'social_write';
/** Só o comentário feito nestes últimos dias ganha pedido (os posts que a leitura traz são dos últimos 30 dias). */
export const DIAS_DOS_PEDIDOS = 30;
/** Tentativas antes de desistir de um comentário (a IA ou a Meta fora do ar, a resposta fora do formato). */
export const TENTATIVAS_DOS_PEDIDOS = 3;
/** Com uma chave desligada, sem a rota do modelo ou no limite de IA: a vez volta depois disto, sem contar tentativa. */
export const MINUTOS_DE_ESPERA_DOS_PEDIDOS = 60;
/** As situações do pedido em que ele ainda anda, ou em que a ação já saiu pelo Liame: com um assim, não se pede de novo. */
export const PEDIDO_EM_ANDAMENTO = ['aguardando_aprovacao', 'aprovada', 'executando', 'executada'] as const;

export type OperacaoDoPedido = 'responder' | 'ocultar';

/** O que a marca faz com cada tipo de comentário (D-A6-88 e D-A6-89); nulo para o tipo ainda não decidido. */
export function operacaoDoTipo(tipo: string | null): OperacaoDoPedido | null {
  if (tipo === 'elogio' || tipo === 'marcacao' || tipo === 'pergunta' || tipo === 'reclamacao') return 'responder';
  if (tipo === 'golpe' || tipo === 'ofensivo') return 'ocultar';
  return null;
}

/** As ferramentas de cada operação, no trilho de ações (Z11, parte 2). */
export const FERRAMENTA_DA_OPERACAO: Record<OperacaoDoPedido, string> = { responder: 'comentario_responder', ocultar: 'comentario_ocultar' };

const exigirCodigo = (c: string, oQue: string): void => {
  if (!ehCodigo(c)) throw new Error(`pedidos dos comentários: ${oQue} fora do formato de código`);
};

/**
 * O que desliga os pedidos desta conta agora, como código, na ordem em que as chaves são conferidas: a função, a
 * leitura, a escrita nas redes, a resposta aos comentários e o Social media na marca. A IA (`ia`) é conferida pelo
 * gateway, só na pergunta e na reclamação. Nulo quando tudo está ligado. Na transação da empresa.
 */
export async function oQueDesligaOsPedidos(tx: Tx, flags: FlagService, conta: { tenantId: string; brandId: string; connectedAccountId: string }): Promise<string | null> {
  const contexto = flags.context({ tenantId: conta.tenantId, brandId: conta.brandId, accountId: conta.connectedAccountId });
  const chaves: ReadonlyArray<readonly [string, string]> = [
    [FLAG_DOS_PEDIDOS, 'funcao_desligada'],
    [FLAG_DOS_COMENTARIOS, 'leitura_desligada'],
    [FLAG_DA_ESCRITA_NAS_REDES, 'escrita_desligada'],
    [FLAG_DA_RESPOSTA_AO_COMENTARIO, 'resposta_desligada'],
  ];
  for (const [flag, motivo] of chaves) if (!(await flags.isEnabled(flag, contexto))) return motivo;
  if (!(await funcionarioAtivo(tx, { tenantId: conta.tenantId, brandId: conta.brandId, agentKey: SOCIAL.key, ativoPorPadrao: SOCIAL.ativoPorPadrao }))) return 'funcionario_desligado';
  return null;
}

/**
 * Abre a vez, de uma vez só, de cada comentário desta conta que pede uma ação da marca: de primeiro nível, de outra
 * pessoa, com o tipo decidido, feito nos últimos 30 dias, que ainda não teve a vez dele e sem pedido de quem quer que
 * seja sobre ele. Para responder, o que está à vista e sem resposta da marca; para ocultar, o que está à vista. Quem chama
 * confere antes que os pedidos estão ligados para a conta. Devolve quantas entraram.
 */
export async function abrirVezDosPedidos(tx: Tx, conta: { tenantId: string; brandId: string; connectedAccountId: string }, agora: Date): Promise<number> {
  const instante = sql`${agora.toISOString()}::timestamptz`;
  const r = await tx.execute(sql`
    insert into liame.comment_suggestion (id, tenant_id, brand_id, connected_account_id, comment_id, round, status, operation, next_attempt_at, created_at, updated_at)
    select gen_random_uuid(), c.tenant_id, c.brand_id, c.connected_account_id, c.comment_id, 1, 'esperando',
           case when c.kind in ('golpe', 'ofensivo') then 'ocultar' else 'responder' end, ${instante}, ${instante}, ${instante}
      from liame.social_comment c
     where c.connected_account_id = ${conta.connectedAccountId} and c.tenant_id = ${conta.tenantId} and c.brand_id = ${conta.brandId}
       and c.parent_comment_id is null and not c.by_brand and not c.hidden
       and c.kind in ('elogio', 'marcacao', 'pergunta', 'reclamacao', 'golpe', 'ofensivo')
       and c.published_at >= ${instante} - make_interval(days => ${DIAS_DOS_PEDIDOS})
       and (c.kind in ('golpe', 'ofensivo')
            or not exists (select 1 from liame.social_comment r
                            where r.connected_account_id = c.connected_account_id and r.parent_comment_id = c.comment_id and r.by_brand))
       and not exists (select 1 from liame.comment_suggestion s where s.connected_account_id = c.connected_account_id and s.comment_id = c.comment_id)
       -- O recurso do pedido é "comentario:" seguido do id na rede (o prefixo vem de recursoDoComentario).
       and not exists (
         select 1 from liame.action_request q
          where q.tenant_id = c.tenant_id and q.account_id = c.connected_account_id::text
            and q.resource_id = ${recursoDoComentario('')} || c.comment_id
            and q.status in ${[...PEDIDO_EM_ANDAMENTO]})
    on conflict (connected_account_id, comment_id, round) do nothing
    returning id`);
  return r.rows.length;
}

export type DonoDaVez = { tenantId: string; id: string };

export type VezGuardada = {
  id: string;
  brand_id: string;
  connected_account_id: string;
  comment_id: string;
  round: 1 | 2;
  status: string;
  operation: OperacaoDoPedido;
  attempts: number;
};

/** A vez como está guardada, para a rotina retomar de onde parou. Nula se não é desta empresa. */
export async function lerVez(tx: Tx, alvo: DonoDaVez): Promise<VezGuardada | null> {
  const r = await tx.execute<VezGuardada>(sql`
    select id, brand_id, connected_account_id, comment_id, round, status, operation, attempts
      from liame.comment_suggestion
     where id = ${alvo.id} and tenant_id = ${alvo.tenantId}`);
  return r.rows[0] ?? null;
}

/** Não é a vez dele agora, e não por falha dele (uma chave desligada, sem rota, no limite): marca o porquê e quando olhar de novo. */
export async function esperarVez(tx: Tx, alvo: DonoDaVez, motivo: string, ate: Date, agora: Date): Promise<boolean> {
  exigirCodigo(motivo, 'o motivo');
  const r = await tx.execute(sql`
    update liame.comment_suggestion
       set reason = ${motivo}, next_attempt_at = ${ate.toISOString()}::timestamptz, updated_at = ${agora.toISOString()}::timestamptz
     where id = ${alvo.id} and tenant_id = ${alvo.tenantId} and status = 'esperando'
    returning id`);
  return r.rows.length === 1;
}

/** Não deu agora (a IA ou a Meta fora do ar, a resposta fora do formato): conta a tentativa e marca quando tentar de novo. */
export async function adiarVez(tx: Tx, alvo: DonoDaVez, motivo: string, ate: Date, agora: Date): Promise<boolean> {
  exigirCodigo(motivo, 'o motivo');
  const r = await tx.execute(sql`
    update liame.comment_suggestion
       set attempts = attempts + 1, reason = ${motivo}, next_attempt_at = ${ate.toISOString()}::timestamptz, updated_at = ${agora.toISOString()}::timestamptz
     where id = ${alvo.id} and tenant_id = ${alvo.tenantId} and status = 'esperando'
    returning id`);
  return r.rows.length === 1;
}

/** A vez acaba sem pedido: `descartada` (já respondido, oculto, antigo, sumiu…) ou `falhou` (depois das tentativas). */
export async function encerrarVez(
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
    update liame.comment_suggestion
       set status = ${fim}, reason = ${motivo}, usage_id = coalesce(${extra.usageId ?? null}::uuid, usage_id),
           attempts = attempts + ${extra.contarTentativa ? 1 : 0}, next_attempt_at = null, finished_at = ${quando}, updated_at = ${quando}
     where id = ${alvo.id} and tenant_id = ${alvo.tenantId} and status = 'esperando'
    returning id`);
  return r.rows.length === 1;
}

/** A conferência não deixou passar nenhuma sugestão: a vez acaba barrada, com os nomes do que barrou (nunca o texto). */
export async function barrarVez(tx: Tx, alvo: DonoDaVez, oQueBarrou: readonly string[], usageId: string | null, agora: Date): Promise<boolean> {
  const itens = [...new Set(oQueBarrou)];
  if (itens.length < 1 || itens.length > 20) throw new Error('pedidos dos comentários: a vez barrada diz o que barrou (de 1 a 20 itens)');
  for (const i of itens) exigirCodigo(i, 'o item que barrou');
  const quando = sql`${agora.toISOString()}::timestamptz`;
  const r = await tx.execute(sql`
    update liame.comment_suggestion
       set status = 'barrada', reason = 'conferencia', barred_by = ${`{${itens.join(',')}}`}::text[], usage_id = ${usageId},
           next_attempt_at = null, finished_at = ${quando}, updated_at = ${quando}
     where id = ${alvo.id} and tenant_id = ${alvo.tenantId} and status = 'esperando'
    returning id`);
  return r.rows.length === 1;
}

// ---- A retirada (A6, Z11, parte 2d-5; D-A6-102) --------------------------------------------------------------------
// O pedido do Social media que ainda espera a decisão sai de Aprovações quando o comentário deixa de ser o que o pedido
// leu: respondido direto na rede, ocultado, editado ou apagado. A vez acaba `retirada`, com o porquê; o comentário segue
// com o "Responder" de sempre. Aprovar um pedido assim já não faria nada (a execução confere a versão do comentário),
// mas ele ocuparia Aprovações à toa.

/** Os porquês da retirada, em código (vão no motivo do pedido, depois de `PREFIXO_RETIRADA`, e na vez). */
export const RETIRADAS_DO_COMENTARIO = ['comentario_sumiu', 'respondido_na_rede', 'oculto_na_rede', 'ja_oculto', 'comentario_mudou'] as const;
export type RetiradaDoComentario = (typeof RETIRADAS_DO_COMENTARIO)[number];

/**
 * Por que o pedido do Social media sobre um comentário não serve mais, ou nulo se ele ainda serve. `resumoDoPedido` é o
 * resumo do texto que o pedido leu na rede (`before_state.texto_resumo`); `resumoAgora`, o do texto que a leitura guardou
 * (os dois pelo mesmo `resumoDoComentario`, sobre o mesmo texto limpo). O comentário nulo é o que saiu do Liame.
 */
export function motivoDaRetirada(
  pedido: { ferramenta: string; resumoDoPedido: string | null },
  comentario: { oculto: boolean; respondido: boolean; resumoAgora: string | null } | null,
): RetiradaDoComentario | null {
  if (!comentario) return 'comentario_sumiu';
  if (pedido.ferramenta === FERRAMENTA_DA_OPERACAO.ocultar) return comentario.oculto ? 'ja_oculto' : null;
  if (comentario.respondido) return 'respondido_na_rede';
  if (comentario.oculto) return 'oculto_na_rede';
  if (pedido.resumoDoPedido !== null && comentario.resumoAgora !== pedido.resumoDoPedido) return 'comentario_mudou';
  return null;
}

/** O pedido saiu de Aprovações: a vez pronta acaba retirada, com o porquê. Devolve se aconteceu. */
export async function marcarVezRetirada(tx: Tx, alvo: DonoDaVez, motivo: RetiradaDoComentario, agora: Date): Promise<boolean> {
  exigirCodigo(motivo, 'o motivo');
  const r = await tx.execute(sql`
    update liame.comment_suggestion
       set status = 'retirada', reason = ${motivo}, updated_at = ${agora.toISOString()}::timestamptz
     where id = ${alvo.id} and tenant_id = ${alvo.tenantId} and status = 'pronta'
    returning id`);
  return r.rows.length === 1;
}

/** Nada mudou no comentário desde a última conferência: a vez fica marcada como olhada (até a próxima leitura). */
export async function marcarVezOlhada(tx: Tx, alvo: DonoDaVez, agora: Date): Promise<void> {
  await tx.execute(sql`
    update liame.comment_suggestion set updated_at = ${agora.toISOString()}::timestamptz
     where id = ${alvo.id} and tenant_id = ${alvo.tenantId} and status = 'pronta'`);
}

/** O pedido está em Aprovações: a vez acaba pronta, ligada a ele, com quantas sugestões foram (nulo no ocultar). */
export async function marcarVezPronta(tx: Tx, alvo: DonoDaVez, feito: { pedido: string; sugestoes: number | null; usageId: string | null }, agora: Date): Promise<boolean> {
  const quando = sql`${agora.toISOString()}::timestamptz`;
  const r = await tx.execute(sql`
    update liame.comment_suggestion
       set status = 'pronta', reason = null, action_id = ${feito.pedido}, suggestions = ${feito.sugestoes}, usage_id = ${feito.usageId},
           next_attempt_at = null, finished_at = ${quando}, updated_at = ${quando}
     where id = ${alvo.id} and tenant_id = ${alvo.tenantId} and status = 'esperando'
    returning id`);
  return r.rows.length === 1;
}
