import { COMMENT_AUTO_REPLY_HOURLY_LIMIT, COMMENT_AUTO_REPLY_KINDS } from '@liame/contracts';
import type { Tx } from '@liame/database';
import { sql } from 'drizzle-orm';
import { recursoDoComentario } from '../actions/comentario-na-rede.js';
import { AVISO_DE_RESPOSTA_AUTOMATICA } from '../actions/comentario-plano.js';
import type { FlagService } from '../flags/flag.service.js';
import { oQueDesligaOsPedidos } from './pedidos.js';

// O atendimento automático dos comentários (A6, Z11, parte 2e-1; P38 versão 2; D-A6-92 e D-A6-104; migration 0129).
// Com ele ligado numa marca (pelo Dono ou por um Administrador, com o código do app), o Liame responde sozinho, sem
// pedido de aprovação, os comentários dos tipos marcados, com o aviso de resposta automática no fim. A reclamação, o que a
// conferência barrar, o golpe e a ofensa sempre esperam uma pessoa. Aqui ficam as regras e o portão, que o Action Service
// confere ao criar o pedido e o executor confere de novo ao executar: desligar (ou tirar um tipo) segura na hora até o
// que já estava na fila.

/** A função do atendimento automático (migration 0129): nasce desligada; sem ela, nada responde sozinho. */
export const FLAG_DO_AUTOMATICO = 'comentarios_automatico';

/**
 * Os tipos que o Liame responde sozinho, nesta parte: o elogio e a marcação de amigo (a resposta pronta, sem IA). A
 * pergunta entra quando o Social media disser se sabe responder com certeza (parte 2e-3); a tabela já a aceita.
 */
export const TIPOS_DO_AUTOMATICO = COMMENT_AUTO_REPLY_KINDS;
export type TipoDoAutomatico = (typeof TIPOS_DO_AUTOMATICO)[number];

/** No máximo tantas respostas sozinho por hora, por marca; o que passar espera a hora seguinte (D-A6-92). */
export const RESPOSTAS_AUTOMATICAS_POR_HORA = COMMENT_AUTO_REPLY_HOURLY_LIMIT;

/** A ferramenta da resposta automática, no trilho de ações. */
export const FERRAMENTA_DA_RESPOSTA_AUTOMATICA = 'comentario_responder_auto';

/** As situações do pedido automático que contam como resposta dada (ou saindo): no teto da hora e na pessoa do post. */
const RESPOSTA_DADA = ['aprovada', 'executando', 'executada'] as const;

export type AutomaticoDaMarca = { enabled: boolean; kinds: string[]; updatedAt: Date | null; updatedBy: string | null };

/** Como o atendimento automático está na marca (desligado, sem tipo, quando não há linha). Na transação da empresa. */
export async function automaticoDaMarca(tx: Tx, brandId: string): Promise<AutomaticoDaMarca> {
  const r = await tx.execute<{ enabled: boolean; kinds: string[]; updated_at: Date | string; updated_by: string | null }>(sql`
    select enabled, kinds, updated_at, updated_by from liame.comment_auto_reply where brand_id = ${brandId}`);
  const l = r.rows[0];
  if (!l) return { enabled: false, kinds: [], updatedAt: null, updatedBy: null };
  return { enabled: l.enabled, kinds: l.kinds, updatedAt: new Date(l.updated_at), updatedBy: l.updated_by };
}

export { AVISO_DE_RESPOSTA_AUTOMATICA };

/** O texto da resposta automática: o da resposta, com o aviso no fim (posto pelo código, nunca pela IA). */
export function comAviso(texto: string): string {
  return `${texto.trimEnd()}${AVISO_DE_RESPOSTA_AUTOMATICA}`;
}

/**
 * O portão (o mesmo na criação e na execução): a função ligada para a marca, os pedidos dos comentários ligados (a
 * leitura, a escrita, a resposta e o Social media), o atendimento automático ligado na marca e o tipo de AGORA do
 * comentário entre os marcados. Nulo quando vale; senão, o porquê em código.
 */
export async function oQueSeguraOAutomatico(
  tx: Tx,
  flags: FlagService,
  alvo: { tenantId: string; brandId: string; connectedAccountId: string; commentId: string },
): Promise<string | null> {
  const contexto = flags.context({ tenantId: alvo.tenantId, brandId: alvo.brandId, accountId: alvo.connectedAccountId });
  if (!(await flags.isEnabled(FLAG_DO_AUTOMATICO, contexto))) return 'automatico_desligado';
  const desligado = await oQueDesligaOsPedidos(tx, flags, alvo);
  if (desligado) return desligado;
  const marca = await automaticoDaMarca(tx, alvo.brandId);
  if (!marca.enabled) return 'automatico_desligado';
  const c = (
    await tx.execute<{ kind: string | null; hidden: boolean; by_brand: boolean }>(sql`
      select kind, hidden, by_brand from liame.social_comment
       where connected_account_id = ${alvo.connectedAccountId}::uuid and comment_id = ${alvo.commentId} and tenant_id = ${alvo.tenantId}`)
  ).rows[0];
  if (!c) return 'comentario_sumiu';
  // Nunca ao comentário da própria marca, nem ao oculto.
  if (c.by_brand || c.hidden) return 'fora_do_automatico';
  if (!c.kind || !(TIPOS_DO_AUTOMATICO as readonly string[]).includes(c.kind) || !marca.kinds.includes(c.kind)) return 'tipo_fora_do_automatico';
  return null;
}

/**
 * Quantas respostas automáticas a marca deu (ou está dando) na última hora, e quando a mais antiga delas sai da janela
 * (é quando o teto abre uma vaga). O relógio é o de quem chama (V34).
 */
export async function respostasAutomaticasNaHora(tx: Tx, brandId: string, agora: Date): Promise<{ n: number; vagaEm: Date | null }> {
  const r = await tx.execute<{ n: string | number; primeira: Date | string | null }>(sql`
    select count(*) as n, min(created_at) as primeira from liame.action_request
     where brand_id = ${brandId} and tool = ${FERRAMENTA_DA_RESPOSTA_AUTOMATICA} and status in ${[...RESPOSTA_DADA]}
       and created_at > ${agora.toISOString()}::timestamptz - interval '1 hour'`);
  const l = r.rows[0];
  const n = Number(l?.n ?? 0);
  return { n, vagaEm: l?.primeira ? new Date(new Date(l.primeira).getTime() + 60 * 60_000) : null };
}

/**
 * Uma resposta por pessoa em cada post (D-A6-92): a marca já respondeu sozinha (ou está respondendo) a outro comentário
 * da mesma pessoa no mesmo post. Sem o nome de quem comentou (a Página pode não mandar), não dá para saber: conta como já
 * respondida, e o comentário vai para uma pessoa.
 */
export async function jaRespondeuAPessoaNoPost(
  tx: Tx,
  alvo: { tenantId: string; connectedAccountId: string; commentId: string; postId: string; autor: string | null },
): Promise<boolean> {
  if (!alvo.autor) return true;
  const r = await tx.execute<{ tem: boolean }>(sql`
    select exists (
      select 1 from liame.social_comment c
        join liame.action_request q on q.tenant_id = c.tenant_id and q.account_id = c.connected_account_id::text
                                   and q.resource_id = ${recursoDoComentario('')} || c.comment_id
       where c.tenant_id = ${alvo.tenantId} and c.connected_account_id = ${alvo.connectedAccountId}::uuid and c.post_id = ${alvo.postId}
         and c.author_name = ${alvo.autor} and c.comment_id <> ${alvo.commentId}
         and q.tool = ${FERRAMENTA_DA_RESPOSTA_AUTOMATICA} and q.status in ${[...RESPOSTA_DADA]}) as tem`);
  return Boolean(r.rows[0]?.tem);
}
