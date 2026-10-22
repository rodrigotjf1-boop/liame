import type { Tx } from '@liame/database';
import { sql } from 'drizzle-orm';
import type { SugestaoDoPedido } from '../actions/avaliacao-plano.js';
import { recursoDaAvaliacao } from '../actions/perfil-avaliacao.js';
import { funcionarioAtivo } from '../ai/registro/ativacao.js';
import type { SugestaoConferida } from '../ai/social/resposta.js';
import { SOCIAL } from '../ai/social/prompt.js';
import type { FlagService } from '../flags/flag.service.js';
import type { ContaDoPerfil } from './perfil-store.js';

// As sugestões de resposta às avaliações do Google, pelo Social media (A6, Z6, parte 2; `plano-a6.md` D-A6-26 a
// D-A6-30; protótipo P31; migration 0079). A leitura do Google que traz a avaliação nova abre a vez dela na fila
// (`review_suggestion`), com a função ligada; a rotina do worker pede ao Social media uma ou duas sugestões, o código
// confere cada uma, e as que passam vão num pedido só em Aprovações. Aqui ficam o caminho de cada avaliação e cada
// passo dele no banco, e as regras puras.
//
// Todo passo é uma gravação condicional: só acontece se a linha está esperando, e devolve se aconteceu. A rotina que
// roda duas vezes, ou que volta depois de cair no meio, não sugere em dobro nem desfaz o que já acabou. Quem chama já
// está na transação da empresa (a RLS isola a empresa). Nenhum texto fica aqui: o das sugestões que passaram vai no
// pedido, e o que a conferência barrou não é guardado. Os horários são os do relógio de quem chama (V34).

/** A função das sugestões (migration 0079): nasce desligada para todos; quem liga é a distribuição, empresa por empresa. */
export const FLAG_DAS_SUGESTOES = 'respostas_sugeridas';
/** A resposta pelo Liame (migration 0069): sem ela, o pedido nem nasceria. */
export const FLAG_DA_RESPOSTA = 'perfil_google_write';
/** Só a avaliação feita nestes últimos dias ganha sugestão (D-A6-26); a que esperou a vez por mais tempo é descartada. */
export const DIAS_DAS_SUGESTOES = 30;
/** Tentativas antes de desistir de uma avaliação (a IA ou o Google fora do ar, a resposta fora do formato). */
export const TENTATIVAS_DAS_SUGESTOES = 3;
/** Com a função, a IA ou o Social media desligados agora, ou no limite de IA: a vez volta depois disto, sem contar tentativa. */
export const MINUTOS_DE_ESPERA = 60;
/** As situações do pedido de resposta em que ele ainda anda, ou em que a resposta já saiu pelo Liame. */
export const PEDIDO_QUE_CONTA = ['aguardando_aprovacao', 'aprovada', 'executando', 'executada'] as const;

const MINUTO_MS = 60_000;
const DIA_MS = 24 * 60 * MINUTO_MS;

export const SITUACOES_DA_SUGESTAO = ['esperando', 'pronta', 'barrada', 'descartada', 'falhou', 'retirada'] as const;
export type SituacaoDaSugestao = (typeof SITUACOES_DA_SUGESTAO)[number];

/** Quantos minutos até a próxima tentativa, pelas que já falharam: 15, 30, 60… */
export function minutosAteATentativa(tentativasAntes: number): number {
  return 15 * 2 ** Math.max(0, Math.min(6, Math.trunc(tentativasAntes)));
}

/** A avaliação passou dos 30 dias (a data é a da avaliação no Google)? */
export const avaliacaoAntiga = (feitaEm: Date, agora: Date): boolean => agora.getTime() - feitaEm.getTime() > DIAS_DAS_SUGESTOES * DIA_MS;

/**
 * O porquê de cada situação e o nome de cada item que a conferência barrou são códigos: de 2 a 40 letras minúsculas ou
 * sublinhado, o mesmo formato que o banco confere. Conferido letra a letra, sem expressão regular (V48).
 */
const LETRAS_DE_CODIGO = 'abcdefghijklmnopqrstuvwxyz_';
export const ehCodigo = (c: string): boolean => c.length >= 2 && c.length <= 40 && [...c].every((letra) => LETRAS_DE_CODIGO.includes(letra));
const exigirCodigo = (c: string, oQue: string): void => {
  if (!ehCodigo(c)) throw new Error(`sugestões de resposta: ${oQue} fora do formato de código`);
};

/** O motivo como a coluna guarda (`sem-rota` vira `sem_rota`). */
export const codigoDoMotivo = (motivo: string): string => motivo.toLowerCase().replace(/[^a-z_]/g, '_').slice(0, 40);

/** Os nomes dos itens da conferência que barraram alguma sugestão, sem repetir: é o que `barred_by` guarda. */
export function itensQueBarraram(sugestoes: readonly SugestaoConferida[]): string[] {
  return [...new Set(sugestoes.flatMap((s) => s.conferencia.itens.filter((i) => i.situacao === 'barrou').map((i) => i.item)))];
}

/** Os tipos do que a conferência achou nas sugestões barradas (só para a auditoria; nunca o trecho nem o texto). */
export function achadosQueBarraram(sugestoes: readonly SugestaoConferida[]): string[] {
  return [...new Set(sugestoes.flatMap((s) => s.conferencia.itens.flatMap((i) => (i.situacao === 'barrou' ? i.achados.map((a) => a.tipo) : []))))];
}

/**
 * Os parâmetros do pedido de resposta (a ferramenta `avaliacao_responder`, v2): o texto que vai ao Google começa sendo
 * o da primeira sugestão desta rodada (a pessoa escolhe outra, ou ajusta, antes de aprovar), e as sugestões vão junto,
 * cada uma com a rodada dela; as da rodada anterior, quando houver, vêm depois.
 */
export function paramsDaResposta(
  sugestoes: readonly { enfoque: string; texto: string }[],
  rodada: 1 | 2,
  anteriores: readonly SugestaoDoPedido[] = [],
): { texto: string; sugestoes: SugestaoDoPedido[] } {
  const primeira = sugestoes[0];
  if (!primeira) throw new Error('sugestões de resposta: o pedido parte de pelo menos uma sugestão');
  return { texto: primeira.texto, sugestoes: [...sugestoes.map((s) => ({ enfoque: s.enfoque, texto: s.texto, rodada })), ...anteriores] };
}

/**
 * O que desliga as sugestões desta loja do Perfil agora, como código, na ordem em que as chaves são conferidas
 * (D-A6-30): a função, a IA, a resposta pelo Liame e o Social media na marca. Nulo quando tudo está ligado. Na
 * transação da empresa.
 */
export async function oQueDesligaAsSugestoes(tx: Tx, flags: FlagService, loja: ContaDoPerfil): Promise<string | null> {
  const contexto = flags.context({ tenantId: loja.tenantId, brandId: loja.brandId, accountId: loja.connectedAccountId });
  const chaves: ReadonlyArray<readonly [string, string]> = [
    [FLAG_DAS_SUGESTOES, 'funcao_desligada'],
    ['ia', 'ia_desligada'],
    [FLAG_DA_RESPOSTA, 'resposta_desligada'],
  ];
  for (const [flag, motivo] of chaves) if (!(await flags.isEnabled(flag, contexto))) return motivo;
  if (!(await funcionarioAtivo(tx, { tenantId: loja.tenantId, brandId: loja.brandId, agentKey: SOCIAL.key, ativoPorPadrao: SOCIAL.ativoPorPadrao }))) return 'funcionario_desligado';
  return null;
}

/**
 * Abre a vez, na fila das sugestões, de cada avaliação desta loja que está sem resposta, foi feita nos últimos 30 dias e
 * ainda não teve a vez dela (D-A6-26), de uma vez só. Fica de fora a avaliação que já teve um pedido de resposta, de
 * quem quer que seja: uma pessoa já cuidou dela. Quem chama confere antes que as sugestões estão ligadas para a loja.
 * Devolve quantas entraram.
 */
export async function abrirVezDasSugestoes(tx: Tx, loja: ContaDoPerfil, agora: Date): Promise<number> {
  const instante = sql`${agora.toISOString()}::timestamptz`;
  const r = await tx.execute(sql`
    insert into liame.review_suggestion (id, tenant_id, brand_id, review_id, round, status, next_attempt_at, created_at, updated_at)
    select gen_random_uuid(), r.tenant_id, r.brand_id, r.id, 1, 'esperando', ${instante}, ${instante}, ${instante}
      from liame.profile_review r
     where r.connected_account_id = ${loja.connectedAccountId} and r.tenant_id = ${loja.tenantId} and r.brand_id = ${loja.brandId}
       and r.reply_text is null
       and r.reviewed_at >= ${instante} - make_interval(days => ${DIAS_DAS_SUGESTOES})
       and not exists (select 1 from liame.review_suggestion s where s.review_id = r.id)
       -- O recurso do pedido de resposta é "avaliacao:" seguido do id da avaliação no Liame (o prefixo vem de recursoDaAvaliacao).
       and not exists (
         select 1 from liame.action_request q
          where q.tenant_id = r.tenant_id and q.tool = 'avaliacao_responder' and q.resource_id = ${recursoDaAvaliacao('')} || r.id::text)
    on conflict (review_id, round) do nothing
    returning id`);
  return r.rows.length;
}

export type DonoDaSugestao = { tenantId: string; id: string };

export type SugestaoGuardada = {
  id: string;
  brand_id: string;
  review_id: string;
  round: 1 | 2;
  status: SituacaoDaSugestao;
  reason: string | null;
  attempts: number;
  created_at: Date | string;
};

/** A vez como está guardada, para a rotina retomar de onde parou. Nula se não é desta empresa. */
export async function lerSugestao(tx: Tx, alvo: DonoDaSugestao): Promise<SugestaoGuardada | null> {
  const r = await tx.execute<SugestaoGuardada>(sql`
    select id, brand_id, review_id, round, status, reason, attempts, created_at
      from liame.review_suggestion
     where id = ${alvo.id} and tenant_id = ${alvo.tenantId}`);
  return r.rows[0] ?? null;
}

/**
 * Não é a vez dela agora, e não por falha dela (a função, a IA ou o Social media desligados, o limite de IA): marca o
 * porquê e quando olhar de novo, sem contar tentativa.
 */
export async function esperarSugestao(tx: Tx, alvo: DonoDaSugestao, motivo: string, ate: Date, agora: Date): Promise<boolean> {
  exigirCodigo(motivo, 'o motivo');
  const r = await tx.execute(sql`
    update liame.review_suggestion
       set reason = ${motivo}, next_attempt_at = ${ate.toISOString()}::timestamptz, updated_at = ${agora.toISOString()}::timestamptz
     where id = ${alvo.id} and tenant_id = ${alvo.tenantId} and status = 'esperando'
    returning id`);
  return r.rows.length === 1;
}

/** Não deu agora (a IA ou o Google fora do ar, a resposta fora do formato): conta a tentativa e marca quando tentar de novo. */
export async function adiarSugestao(tx: Tx, alvo: DonoDaSugestao, motivo: string, ate: Date, agora: Date): Promise<boolean> {
  exigirCodigo(motivo, 'o motivo');
  const r = await tx.execute(sql`
    update liame.review_suggestion
       set attempts = attempts + 1, reason = ${motivo}, next_attempt_at = ${ate.toISOString()}::timestamptz, updated_at = ${agora.toISOString()}::timestamptz
     where id = ${alvo.id} and tenant_id = ${alvo.tenantId} and status = 'esperando'
    returning id`);
  return r.rows.length === 1;
}

/**
 * A vez acaba sem pedido: `descartada` (a avaliação já tem resposta ou pedido, passou dos 30 dias, sumiu…) ou `falhou`
 * (a IA ou o Google não responderam, depois das tentativas). O porquê é um código.
 */
export async function encerrarSugestao(
  tx: Tx,
  alvo: DonoDaSugestao,
  fim: 'descartada' | 'falhou',
  motivo: string,
  agora: Date,
  extra: { usageId?: string | null; contarTentativa?: boolean } = {},
): Promise<boolean> {
  exigirCodigo(motivo, 'o motivo');
  const quando = sql`${agora.toISOString()}::timestamptz`;
  const r = await tx.execute(sql`
    update liame.review_suggestion
       set status = ${fim}, reason = ${motivo}, usage_id = coalesce(${extra.usageId ?? null}::uuid, usage_id),
           attempts = attempts + ${extra.contarTentativa ? 1 : 0}, next_attempt_at = null, finished_at = ${quando}, updated_at = ${quando}
     where id = ${alvo.id} and tenant_id = ${alvo.tenantId} and status = 'esperando'
    returning id`);
  return r.rows.length === 1;
}

/** A conferência não deixou passar nenhuma sugestão: a vez acaba barrada, com os nomes do que barrou (nunca o texto). */
export async function barrarSugestao(tx: Tx, alvo: DonoDaSugestao, oQueBarrou: readonly string[], usageId: string | null, agora: Date): Promise<boolean> {
  const itens = [...new Set(oQueBarrou)];
  if (itens.length < 1 || itens.length > 20) throw new Error('sugestões de resposta: a vez barrada diz o que barrou (de 1 a 20 itens)');
  for (const i of itens) exigirCodigo(i, 'o item que barrou');
  const quando = sql`${agora.toISOString()}::timestamptz`;
  const r = await tx.execute(sql`
    update liame.review_suggestion
       set status = 'barrada', reason = 'conferencia', barred_by = ${`{${itens.join(',')}}`}::text[], usage_id = ${usageId},
           next_attempt_at = null, finished_at = ${quando}, updated_at = ${quando}
     where id = ${alvo.id} and tenant_id = ${alvo.tenantId} and status = 'esperando'
    returning id`);
  return r.rows.length === 1;
}

/** O pedido com as sugestões que passaram está em Aprovações: a vez acaba, ligada a ele. */
export async function marcarPronta(tx: Tx, alvo: DonoDaSugestao, feito: { pedido: string; sugestoes: number; usageId: string | null }, agora: Date): Promise<boolean> {
  if (feito.sugestoes < 1 || feito.sugestoes > 2) throw new Error('sugestões de resposta: o pedido leva uma ou duas sugestões');
  const quando = sql`${agora.toISOString()}::timestamptz`;
  const r = await tx.execute(sql`
    update liame.review_suggestion
       set status = 'pronta', reason = null, action_id = ${feito.pedido}, suggestions = ${feito.sugestoes}, usage_id = ${feito.usageId},
           next_attempt_at = null, finished_at = ${quando}, updated_at = ${quando}
     where id = ${alvo.id} and tenant_id = ${alvo.tenantId} and status = 'esperando'
    returning id`);
  return r.rows.length === 1;
}
