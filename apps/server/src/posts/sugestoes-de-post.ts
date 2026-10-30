import type { Tx } from '@liame/database';
import { sql } from 'drizzle-orm';
import { funcionarioAtivo } from '../ai/registro/ativacao.js';
import { SOCIAL } from '../ai/social/prompt.js';
import type { PostConferido } from '../ai/social/post.js';
import { ehCodigo } from '../avaliacoes/sugestoes.js';
import { FLAG_DOS_POSTS } from '../connectors/meta/publicacao.js';
import type { FlagService } from '../flags/flag.service.js';

// Os posts do Social media (A6, Z6, os posts, parte 2; `plano-a6.md` D-A6-58 a D-A6-60; protótipo P21; migration 0093).
// A rotina do worker abre a vez de cada dia da pauta aprovada que tem item, amanhã e depois de amanhã no fuso da empresa,
// com a função ligada (`post_suggestion`); depois pede ao Social media o post do dia, o código confere, e o que passa vira
// o post na Agenda e o pedido em Aprovações. Aqui ficam o caminho de cada dia e cada passo dele no banco, e as regras puras.
//
// Todo passo é uma gravação condicional: só acontece se a linha está esperando, e devolve se aconteceu. A rotina que roda
// duas vezes, ou que volta depois de cair no meio, não propõe em dobro nem desfaz o que já acabou. Quem chama já está na
// transação da empresa (a RLS isola a empresa). Nenhum texto fica aqui: o do post vai no post. Os horários são os do
// relógio de quem chama (V34).

/** A função dos posts do Social media (migration 0093): nasce desligada para todos; quem liga é a distribuição. */
export const FLAG_DOS_POSTS_SUGERIDOS = 'posts_sugeridos';
/** Os dias, contados de hoje no fuso da empresa, para os quais ele propõe o post (D-A6-60): amanhã e depois de amanhã. */
export const DIAS_A_FRENTE = [1, 2] as const;
/** A hora do post dele, no fuso da empresa: a mesma do "Novo post" (D-A6-60). */
export const HORA_DO_POST = '19:00';
/** O recorte do Instagram, quando a foto não cabe nele: o centro, como o Liame faz sem a pessoa mexer (D-A6-21). */
export const RECORTE_NO_CENTRO = 50;
/** Tentativas antes de desistir de um dia (a IA fora do ar, a resposta fora do formato, o post que não deu para criar). */
export const TENTATIVAS_DOS_POSTS = 3;
/** Com a função, a IA ou o Social media desligados, sem rede ou sem Fotos, ou no limite de IA: a vez volta depois disto. */
export const MINUTOS_DE_ESPERA_DO_POST = 60;

export const SITUACOES_DO_POST_SUGERIDO = ['esperando', 'pronta', 'barrada', 'descartada', 'falhou'] as const;
export type SituacaoDoPostSugerido = (typeof SITUACOES_DO_POST_SUGERIDO)[number];

const exigirCodigo = (c: string, oQue: string): void => {
  if (!ehCodigo(c)) throw new Error(`posts do Social media: ${oQue} fora do formato de código`);
};

/**
 * O que desliga os posts do Social media nesta marca agora, como código, na ordem em que as chaves são conferidas
 * (D-A6-60): a função, a IA, a publicação pelo Liame e o Social media na marca. Nulo quando tudo está ligado. Na
 * transação da empresa.
 */
export async function oQueDesligaOsPosts(tx: Tx, flags: FlagService, alvo: { tenantId: string; brandId: string }): Promise<string | null> {
  const contexto = flags.context({ tenantId: alvo.tenantId, brandId: alvo.brandId });
  const chaves: ReadonlyArray<readonly [string, string]> = [
    [FLAG_DOS_POSTS_SUGERIDOS, 'funcao_desligada'],
    ['ia', 'ia_desligada'],
    [FLAG_DOS_POSTS, 'posts_desligados'],
  ];
  for (const [flag, motivo] of chaves) if (!(await flags.isEnabled(flag, contexto))) return motivo;
  if (!(await funcionarioAtivo(tx, { tenantId: alvo.tenantId, brandId: alvo.brandId, agentKey: SOCIAL.key, ativoPorPadrao: SOCIAL.ativoPorPadrao }))) return 'funcionario_desligado';
  return null;
}

/** Os nomes dos itens da conferência que barraram algum texto do post, sem repetir: é o que `barred_by` guarda. */
export function itensQueBarraramOPost(post: PostConferido): string[] {
  return [...new Set(post.textos.flatMap((t) => t.conferencia.itens.filter((i) => i.situacao === 'barrou').map((i) => i.item)))];
}

/** Os tipos do que a conferência achou nos textos barrados (só para a auditoria; nunca o trecho nem o texto). */
export function achadosQueBarraramOPost(post: PostConferido): string[] {
  return [...new Set(post.textos.flatMap((t) => t.conferencia.itens.flatMap((i) => (i.situacao === 'barrou' ? i.achados.map((a) => a.tipo) : []))))];
}

/**
 * Abre a vez de um dia da pauta (a rotina já conferiu que a função está ligada para a marca e que o dia não tem post):
 * uma linha por marca e por dia (o índice único segura a segunda volta). Devolve se abriu.
 */
export async function abrirVezDoPost(tx: Tx, dia: { tenantId: string; brandId: string; planId: string; day: string }, agora: Date): Promise<boolean> {
  const instante = sql`${agora.toISOString()}::timestamptz`;
  const r = await tx.execute(sql`
    insert into liame.post_suggestion (id, tenant_id, brand_id, plan_id, day, status, next_attempt_at, created_at, updated_at)
    values (gen_random_uuid(), ${dia.tenantId}, ${dia.brandId}, ${dia.planId}, ${dia.day}::date, 'esperando', ${instante}, ${instante}, ${instante})
    on conflict (brand_id, day) do nothing
    returning id`);
  return r.rows.length === 1;
}

export type DonoDaVezDoPost = { tenantId: string; id: string };

export type VezDoPostGuardada = {
  id: string;
  brand_id: string;
  plan_id: string | null;
  day: string;
  status: SituacaoDoPostSugerido;
  reason: string | null;
  attempts: number;
};

/** A vez como está guardada, para a rotina retomar de onde parou; travada até o fim da transação. Nula se não é desta empresa. */
export async function lerVezDoPost(tx: Tx, alvo: DonoDaVezDoPost): Promise<VezDoPostGuardada | null> {
  const r = await tx.execute<VezDoPostGuardada>(sql`
    select id, brand_id, plan_id, to_char(day, 'YYYY-MM-DD') as day, status, reason, attempts
      from liame.post_suggestion
     where id = ${alvo.id} and tenant_id = ${alvo.tenantId}
     for update`);
  return r.rows[0] ?? null;
}

/** Não é a vez dele agora, e não por falha dele (desligado, sem rede, sem Fotos, o limite de IA): o porquê e quando olhar de novo. */
export async function esperarVezDoPost(tx: Tx, alvo: DonoDaVezDoPost, motivo: string, ate: Date, agora: Date): Promise<boolean> {
  exigirCodigo(motivo, 'o motivo');
  const r = await tx.execute(sql`
    update liame.post_suggestion
       set reason = ${motivo}, next_attempt_at = ${ate.toISOString()}::timestamptz, updated_at = ${agora.toISOString()}::timestamptz
     where id = ${alvo.id} and tenant_id = ${alvo.tenantId} and status = 'esperando'
    returning id`);
  return r.rows.length === 1;
}

/** Não deu agora (a IA fora do ar, a resposta fora do formato): conta a tentativa e marca quando tentar de novo. */
export async function adiarVezDoPost(tx: Tx, alvo: DonoDaVezDoPost, motivo: string, ate: Date, agora: Date): Promise<boolean> {
  exigirCodigo(motivo, 'o motivo');
  const r = await tx.execute(sql`
    update liame.post_suggestion
       set attempts = attempts + 1, reason = ${motivo}, next_attempt_at = ${ate.toISOString()}::timestamptz, updated_at = ${agora.toISOString()}::timestamptz
     where id = ${alvo.id} and tenant_id = ${alvo.tenantId} and status = 'esperando'
    returning id`);
  return r.rows.length === 1;
}

/**
 * A vez acaba sem post: `descartada` (o dia passou, ganhou post, a pauta mudou, nenhuma foto combina…) ou `falhou` (depois
 * das tentativas). O porquê é um código.
 */
export async function encerrarVezDoPost(
  tx: Tx,
  alvo: DonoDaVezDoPost,
  fim: 'descartada' | 'falhou',
  motivo: string,
  agora: Date,
  extra: { usageId?: string | null; contarTentativa?: boolean } = {},
): Promise<boolean> {
  exigirCodigo(motivo, 'o motivo');
  const quando = sql`${agora.toISOString()}::timestamptz`;
  const r = await tx.execute(sql`
    update liame.post_suggestion
       set status = ${fim}, reason = ${motivo}, usage_id = coalesce(${extra.usageId ?? null}::uuid, usage_id),
           attempts = attempts + ${extra.contarTentativa ? 1 : 0}, next_attempt_at = null, finished_at = ${quando}, updated_at = ${quando}
     where id = ${alvo.id} and tenant_id = ${alvo.tenantId} and status = 'esperando'
    returning id`);
  return r.rows.length === 1;
}

/** A conferência barrou o post: a vez acaba barrada, com os nomes do que barrou (nunca o texto). */
export async function barrarVezDoPost(tx: Tx, alvo: DonoDaVezDoPost, oQueBarrou: readonly string[], usageId: string | null, agora: Date): Promise<boolean> {
  const itens = [...new Set(oQueBarrou)];
  if (itens.length < 1 || itens.length > 20) throw new Error('posts do Social media: a vez barrada diz o que barrou (de 1 a 20 itens)');
  for (const i of itens) exigirCodigo(i, 'o item que barrou');
  const quando = sql`${agora.toISOString()}::timestamptz`;
  const r = await tx.execute(sql`
    update liame.post_suggestion
       set status = 'barrada', reason = 'conferencia', barred_by = ${`{${itens.join(',')}}`}::text[], usage_id = ${usageId},
           next_attempt_at = null, finished_at = ${quando}, updated_at = ${quando}
     where id = ${alvo.id} and tenant_id = ${alvo.tenantId} and status = 'esperando'
    returning id`);
  return r.rows.length === 1;
}

/** O post está na Agenda e o pedido, em Aprovações: a vez acaba pronta, ligada aos dois. */
export async function marcarVezPronta(tx: Tx, alvo: DonoDaVezDoPost, feito: { post: string; pedido: string; usageId: string | null }, agora: Date): Promise<boolean> {
  const quando = sql`${agora.toISOString()}::timestamptz`;
  const r = await tx.execute(sql`
    update liame.post_suggestion
       set status = 'pronta', reason = null, post_id = ${feito.post}, action_id = ${feito.pedido}, usage_id = ${feito.usageId},
           next_attempt_at = null, finished_at = ${quando}, updated_at = ${quando}
     where id = ${alvo.id} and tenant_id = ${alvo.tenantId} and status = 'esperando'
    returning id`);
  return r.rows.length === 1;
}
