import { DIRECT_AUTO_REPLY_HOURLY_LIMIT, DIRECT_AUTO_REPLY_IN_A_ROW, DIRECT_AUTO_REPLY_KINDS, DIRECT_AUTO_REPLY_NOTICE } from '@liame/contracts';
import type { Tx } from '@liame/database';
import { sql } from 'drizzle-orm';
import { ACAO_DE_RESPONDER_NO_DIRECT_SOZINHO, FERRAMENTA_DO_DIRECT_AUTOMATICO, FLAG_DE_RESPONDER_NO_DIRECT } from '../actions/direct-plano.js';
import type { FlagService } from '../flags/flag.service.js';
import { PROVEDOR_PAGINA } from '../connectors/meta/publicacao.js';
import { DATASET_DO_DIRECT, FLAG_DO_DIRECT, FLAG_DO_MESSENGER, JANELA_DO_DIRECT_HORAS } from './direct.js';
import { sugestaoNoDirect, type TipoNoDirect, tipoNoDirect } from './tipo-no-direct.js';

// O atendimento automático do Direct (A6, Z12, parte 5a; P39 versão 2; D-A6-115 e D-A6-119; migration 0133). Com ele
// ligado numa marca (pelo Dono ou por um Administrador, com o código do app), o Liame responde sozinho, sem uma pessoa
// ver antes, as conversas dos tipos marcados: nesta parte, a resposta pronta (o elogio, a resposta ao story e a menção no
// story), sem IA. Toda resposta automática termina com o aviso e o caminho para uma pessoa (Termos 5.5 e 6.3). Sempre
// esperam uma pessoa: a reclamação, o golpe, a ofensa, a pergunta (até a parte 4b), quem pede uma pessoa e a terceira
// automática seguida na mesma conversa. Aqui ficam as regras e o portão, que o Action Service confere ao criar o pedido e
// o executor confere de novo antes de mandar: desligar segura na hora até o que já estava na fila.

/** A função do atendimento automático do Direct (migration 0133): nasce desligada. */
export const FLAG_DO_DIRECT_AUTOMATICO = 'direct_automatico';
export { ACAO_DE_RESPONDER_NO_DIRECT_SOZINHO, FERRAMENTA_DO_DIRECT_AUTOMATICO };

export const TIPOS_DO_DIRECT_AUTOMATICO = DIRECT_AUTO_REPLY_KINDS;
export const RESPOSTAS_AUTOMATICAS_DO_DIRECT_POR_HORA = DIRECT_AUTO_REPLY_HOURLY_LIMIT;
export const AUTOMATICAS_SEGUIDAS = DIRECT_AUTO_REPLY_IN_A_ROW;

/** As situações do pedido automático que contam como resposta dada (ou saindo): no teto da hora. */
const RESPOSTA_DADA = ['aprovada', 'executando', 'executada'] as const;

/** O texto da resposta automática: o da resposta, com o aviso no fim (posto pelo código, nunca pela IA). */
export function comAvisoDoDirect(texto: string): string {
  return `${texto.trimEnd()}${DIRECT_AUTO_REPLY_NOTICE}`;
}

/** A mensagem da marca que saiu pelo automático (pelo aviso no fim; a Meta pode mexer nos espaços). */
export function ehAutomatica(texto: string): boolean {
  return texto.trimEnd().endsWith(DIRECT_AUTO_REPLY_NOTICE.trim());
}

/** O tipo do automático para o tipo da conversa: `pronta` no elogio e na menção; nulo nos outros. */
export function tipoDoAutomatico(tipo: TipoNoDirect | null): (typeof TIPOS_DO_DIRECT_AUTOMATICO)[number] | null {
  return tipo === 'elogio' || tipo === 'mencao' ? 'pronta' : null;
}

/** Minúsculas e sem acento (as marcas de acento saem depois da decomposição). Sem expressão regular (V41). */
function normalizado(texto: string): string {
  let s = '';
  for (const ch of texto.normalize('NFD')) {
    const c = ch.codePointAt(0) ?? 0;
    if (c >= 0x300 && c <= 0x36f) continue;
    s += ch.toLowerCase();
  }
  return s;
}

/** O que diz que a pessoa quer falar com alguém da equipe (o aviso promete esse caminho). */
const PEDE_UMA_PESSOA = [
  'atendente', 'falar com alguem', 'falar com uma pessoa', 'falar com voce', 'falar com voces', 'pessoa de verdade',
  'pessoa real', 'humano', 'humana', 'falar com o dono', 'falar com a dona', 'gerente', 'responsavel', 'nao e robo',
  'e robo', 'um robo', 'quero falar',
];

/** A pessoa pede para falar com alguém da equipe: a conversa vai para uma pessoa, sem resposta automática. */
export function pedeUmaPessoa(texto: string): boolean {
  const t = normalizado(texto);
  return PEDE_UMA_PESSOA.some((f) => t.includes(f));
}

/**
 * Quantas respostas automáticas seguidas a marca deu no fim da conversa: as mensagens da marca que saíram pelo
 * automático, da mais nova para trás, até a primeira da marca que uma pessoa mandou (as da pessoa não contam).
 */
export function automaticasSeguidas(mensagensDaMaisNova: readonly { direction: string; body: string }[]): number {
  let n = 0;
  for (const m of mensagensDaMaisNova) {
    if (m.direction !== 'saida') continue;
    if (!ehAutomatica(m.body)) break;
    n += 1;
  }
  return n;
}

export type AutomaticoDoDirect = { enabled: boolean; kinds: string[]; updatedAt: Date | null; updatedBy: string | null };

/** Como o atendimento automático do Direct está na marca (desligado, sem tipo, quando não há linha). */
export async function automaticoDoDirect(tx: Tx, brandId: string): Promise<AutomaticoDoDirect> {
  const r = await tx.execute<{ enabled: boolean; kinds: string[]; updated_at: Date | string; updated_by: string | null }>(sql`
    select enabled, kinds, updated_at, updated_by from liame.direct_auto_reply where brand_id = ${brandId}`);
  const l = r.rows[0];
  if (!l) return { enabled: false, kinds: [], updatedAt: null, updatedBy: null };
  return { enabled: l.enabled, kinds: l.kinds, updatedAt: new Date(l.updated_at), updatedBy: l.updated_by };
}

/** Quantas respostas automáticas do Direct a marca deu (ou está dando) na última hora. O relógio é o de quem chama (V34). */
export async function respostasAutomaticasDoDirectNaHora(tx: Tx, brandId: string, agora: Date): Promise<number> {
  const r = await tx.execute<{ n: string | number }>(sql`
    select count(*) as n from liame.action_request
     where brand_id = ${brandId} and tool = ${FERRAMENTA_DO_DIRECT_AUTOMATICO} and status in ${[...RESPOSTA_DADA]}
       and created_at > ${agora.toISOString()}::timestamptz - interval '1 hour'`);
  return Number(r.rows[0]?.n ?? 0);
}

/** Até quantas mensagens da conversa o portão olha (as mais novas): a vez da pessoa e as automáticas seguidas. */
const MENSAGENS_DO_PORTAO = 20;

export type AlvoDoDirect = { tenantId: string; brandId: string; connectedAccountId: string; conversationId: string };

/** O que o automático mandaria agora na conversa: o tipo, o texto com o aviso e a mensagem da pessoa que ele responde. */
export type RespostaDoAutomatico = { tipo: TipoNoDirect; texto: string; mensagem: string };

/**
 * O portão (o mesmo na criação e na execução): a função ligada, o Direct ligado na marca e o Regem sem atender a conta,
 * o atendimento automático ligado na marca, e a conversa de AGORA: esperando resposta, dentro da janela, o tipo do que a
 * pessoa mandou entre os marcados, sem pedir uma pessoa e sem duas automáticas seguidas no fim. Devolve o porquê (em
 * código) ou a resposta que sairia.
 */
export async function oQueSeguraODirectAutomatico(
  tx: Tx,
  flags: FlagService,
  alvo: AlvoDoDirect,
  agora: Date,
): Promise<{ segura: string } | { resposta: RespostaDoAutomatico }> {
  const contexto = flags.context({ tenantId: alvo.tenantId, brandId: alvo.brandId, accountId: alvo.connectedAccountId });
  for (const f of [FLAG_DO_DIRECT_AUTOMATICO, FLAG_DE_RESPONDER_NO_DIRECT]) {
    if (!(await flags.isEnabled(f, contexto))) return { segura: 'automatico_desligado' };
  }
  const ajuste = (
    await tx.execute<{ enabled: boolean; regem: string | null; usuario: string | null; messenger: boolean }>(sql`
      select coalesce(case when a.provider = ${PROVEDOR_PAGINA} then m.enabled else s.enabled end, false) as enabled,
             st.cursor->>'regem' as regem, a.provider_attributes->>'usuario' as usuario, coalesce(a.provider = ${PROVEDOR_PAGINA}, false) as messenger
        from (select 1) um
        left join liame.direct_setting s on s.brand_id = ${alvo.brandId}
        left join liame.messenger_setting m on m.brand_id = ${alvo.brandId}
        left join liame.sync_state st on st.connected_account_id = ${alvo.connectedAccountId}::uuid and st.dataset = ${DATASET_DO_DIRECT}
        left join liame.connected_account a on a.id = ${alvo.connectedAccountId}::uuid`)
  ).rows[0];
  // A função e o ajuste do canal da conta: o Direct (o Instagram) ou o Messenger (a Página, Z14, parte 2).
  if (!(await flags.isEnabled(ajuste?.messenger ? FLAG_DO_MESSENGER : FLAG_DO_DIRECT, contexto))) return { segura: 'automatico_desligado' };
  if (!ajuste?.enabled) return { segura: 'direct_desligado' };
  if (ajuste.regem === 'atende') return { segura: 'regem_atende' };
  const marca = await automaticoDoDirect(tx, alvo.brandId);
  if (!marca.enabled) return { segura: 'automatico_desligado' };

  const c = (
    await tx.execute<{ last_direction: string; last_inbound_at: Date | string | null; concluded_at: Date | string | null; channel: string }>(sql`
      select last_direction, last_inbound_at, concluded_at, channel from liame.direct_conversation
       where connected_account_id = ${alvo.connectedAccountId}::uuid and conversation_id = ${alvo.conversationId} and tenant_id = ${alvo.tenantId}`)
  ).rows[0];
  if (!c) return { segura: 'conversa_sumiu' };
  // A conversa é do canal da conta (o Messenger na Página; o Direct no Instagram).
  if ((c.channel === 'messenger') !== ajuste.messenger) return { segura: 'conversa_sumiu' };
  const ultima = c.last_inbound_at ? new Date(c.last_inbound_at) : null;
  if (c.last_direction !== 'entrada' || !ultima || (c.concluded_at && new Date(c.concluded_at) >= ultima)) return { segura: 'respondida' };
  if (ultima.getTime() + JANELA_DO_DIRECT_HORAS * 3_600_000 <= agora.getTime()) return { segura: 'fora_da_janela' };

  const mensagens = (
    await tx.execute<{ message_id: string; direction: string; kind: string; body: string; sent_at: Date | string }>(sql`
      select message_id, direction, kind, body, sent_at from liame.direct_message
       where connected_account_id = ${alvo.connectedAccountId}::uuid and conversation_id = ${alvo.conversationId}
       order by sent_at desc, message_id desc
       limit ${MENSAGENS_DO_PORTAO}`)
  ).rows;
  // O que a pessoa mandou desde a última resposta da marca (e depois de concluir), da mais velha para a mais nova.
  const pendentes: typeof mensagens = [];
  for (const m of mensagens) {
    if (m.direction === 'saida') break;
    if (c.concluded_at && new Date(m.sent_at) <= new Date(c.concluded_at)) break;
    pendentes.unshift(m);
  }
  const ultimaDaPessoa = pendentes.at(-1);
  if (!ultimaDaPessoa) return { segura: 'respondida' };
  // No Messenger não há @ da marca (a marcação não existe lá).
  const tipo = tipoNoDirect(pendentes, ajuste.messenger ? null : ajuste.usuario);
  const doAutomatico = tipoDoAutomatico(tipo);
  if (!tipo || !doAutomatico || !marca.kinds.includes(doAutomatico)) return { segura: 'tipo_fora_do_automatico' };
  if (pedeUmaPessoa(pendentes.map((p) => p.body).join(' '))) return { segura: 'pede_uma_pessoa' };
  if (automaticasSeguidas(mensagens) >= AUTOMATICAS_SEGUIDAS) return { segura: 'automaticas_seguidas' };
  const sugestao = sugestaoNoDirect(tipo, ultimaDaPessoa.message_id);
  if (sugestao?.kind !== 'pronta') return { segura: 'tipo_fora_do_automatico' };
  return { resposta: { tipo, texto: comAvisoDoDirect(sugestao.text), mensagem: ultimaDaPessoa.message_id } };
}
