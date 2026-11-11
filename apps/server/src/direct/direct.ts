// O Direct do Instagram (A6, Z12, parte 1; P39, aprovado em 11/11/2026; D-A6-106 a D-A6-115): o que a leitura entende
// das respostas da Meta, a situação de cada conversa (a janela de 24 horas, D-A6-111) e a comparação com o que a
// Central do Regem atende (D-A6-107). Funções puras; a rotina (`sincronizador-do-direct.ts`) e a tela usam estas.
// Fonte: a documentação oficial da Meta lida em 11/11/2026 (base de conhecimento §2.2): Conversations API
// (`GET /{page-id}/conversations?platform=instagram`, só as 20 mensagens mais novas com o texto) e Instagram Messaging.

/** A função da empresa (desligada; só leitura). */
export const FLAG_DO_DIRECT = 'direct';
/** A função do Messenger da Página, na mesma caixa (A6, Z14, parte 1; D-A6-120 e D-A6-121): desligada; só leitura. */
export const FLAG_DO_MESSENGER = 'messenger';
/** O canal da conversa: o Direct do Instagram ou o Messenger da Página. */
export type CanalDoDirect = 'instagram' | 'messenger';
/** O conjunto do `sync_state`. */
export const DATASET_DO_DIRECT = 'direct';
/** A cada minuto (D-A6-108: por consulta, enquanto o app do Liame estiver em desenvolvimento na Meta). */
export const INTERVALO_DO_DIRECT_MIN = 1;
/** As conversas mais recentes de cada leitura (a Meta não pagina por data). */
export const CONVERSAS_POR_LEITURA = 25;
/** Quantas conversas que mudaram são relidas por leitura (2 chamadas por segundo por conta, na Meta). */
export const RELIDAS_POR_LEITURA = 10;
/** A janela da Meta: 24 horas depois da última mensagem da pessoa. */
export const JANELA_DO_DIRECT_HORAS = 24;
/** "Janela fechando": as últimas 2 horas (o aviso de Atenção, D-A6-111). */
export const FECHANDO_HORAS = 2;
/** A conferência com o Regem vale por este tanto; depois, a leitura pergunta de novo. */
export const CONFERENCIA_DO_REGEM_MIN = 15;
/** O escopo da porta do Regem que diz quais canais a Central atende (D-A6-107). */
export const ESCOPO_DOS_CANAIS_DO_REGEM = 'atendimento.canais.ler';

/** Os campos de cada conversa da lista e das mensagens de uma conversa (a expansão da Graph API). */
export const CAMPOS_DAS_CONVERSAS = 'id,updated_time,participants';
export const CAMPOS_DAS_MENSAGENS = 'messages{id,created_time,from,to,message,attachments,story,is_unsupported}';
/** No Messenger não há story nem `is_unsupported` nas mensagens (A6, Z14): só os campos de lá. */
export const CAMPOS_DAS_MENSAGENS_DO_MESSENGER = 'messages{id,created_time,from,to,message,attachments}';

export type DirecaoDoDirect = 'entrada' | 'saida';
export type TipoDaMensagem = 'texto' | 'imagem' | 'video' | 'audio' | 'arquivo' | 'compartilhamento' | 'story_resposta' | 'story_mencao' | 'reel' | 'sem_suporte';

/** `display_name`: o nome que a Meta manda de quem escreve (no Messenger, o nome do Facebook; não há @). */
export type ConversaLida = { conversation_id: string; meta_updated_at: string; participant_id: string; username: string | null; display_name: string | null };
export type MensagemLida = { message_id: string; direction: DirecaoDoDirect; kind: TipoDaMensagem; body: string; sent_at: string };

/** Como a conta da marca aparece na Meta: o id da conta profissional e o @ (Instagram), ou o id da Página (Messenger). */
export type ContaDoDirect = { id: string; usuario: string | null };

const MAX_TEXTO = 4000;
const texto = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null);
const data = (v: unknown): string | null => {
  const t = texto(v);
  if (!t) return null;
  const d = new Date(t);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};
const lista = (v: unknown): unknown[] => {
  const d = (v as { data?: unknown } | null)?.data;
  return Array.isArray(d) ? d : [];
};
const daMarca = (p: { id?: unknown; username?: unknown }, conta: ContaDoDirect): boolean =>
  texto(p.id) === conta.id || (conta.usuario !== null && texto(p.username)?.toLowerCase() === conta.usuario.toLowerCase());

/**
 * As conversas da lista (`GET /{page-id}/conversations?platform=instagram&fields=id,updated_time,participants`): a pessoa
 * é o participante que não é a conta da marca. A conversa sem pessoa (só a marca) ou sem data fica de fora.
 */
export function conversasDoDirect(resposta: unknown, conta: ContaDoDirect): ConversaLida[] {
  const saida: ConversaLida[] = [];
  for (const item of lista(resposta)) {
    const c = item as { id?: unknown; updated_time?: unknown; participants?: unknown };
    const id = texto(c.id);
    const quando = data(c.updated_time);
    if (!id || id.length > 200 || !quando) continue;
    const pessoa = lista(c.participants).map((p) => p as { id?: unknown; username?: unknown; name?: unknown }).find((p) => texto(p.id) && !daMarca(p, conta));
    const participante = pessoa ? texto(pessoa.id) : null;
    if (!participante || participante.length > 100) continue;
    const usuario = texto(pessoa?.username);
    const nome = texto(pessoa?.name);
    saida.push({
      conversation_id: id,
      meta_updated_at: quando,
      participant_id: participante,
      username: usuario && usuario.length <= 100 ? usuario : null,
      display_name: nome ? nome.slice(0, 200) : null,
    });
  }
  return saida;
}

/** O tipo da mensagem pelo que a Meta manda: o story, o anexo e o que a API não mostra. */
export function tipoDaMensagem(m: { message?: unknown; attachments?: unknown; story?: unknown; is_unsupported?: unknown }): TipoDaMensagem {
  if (m.is_unsupported === true) return 'sem_suporte';
  const story = m.story as { mention?: unknown; reply_to?: unknown } | null | undefined;
  if (story && typeof story === 'object') {
    if (story.mention) return 'story_mencao';
    if (story.reply_to) return 'story_resposta';
  }
  const anexo = lista(m.attachments)[0] as Record<string, unknown> | undefined;
  if (anexo && typeof anexo === 'object') {
    const tipo = texto(anexo.type)?.toLowerCase();
    if (tipo === 'image' || anexo.image_data) return 'imagem';
    if (tipo === 'video' || anexo.video_data) return 'video';
    if (tipo === 'audio') return 'audio';
    if (tipo === 'file') return 'arquivo';
    if (tipo === 'share') return 'compartilhamento';
    if (tipo === 'ig_reel' || tipo === 'reel') return 'reel';
    if (tipo === 'story_mention') return 'story_mencao';
    // Anexo de um tipo que não conhecemos: guarda o texto, se houver, e marca como sem suporte.
    if (!texto(m.message)) return 'sem_suporte';
  }
  return 'texto';
}

/**
 * As mensagens de uma conversa (`GET /{conversation-id}?fields=messages{…}`): de quem é (a marca ou a pessoa), o tipo e
 * o texto, cortado em 4.000 caracteres. A mensagem sem id ou sem data fica de fora.
 */
export function mensagensDaConversa(resposta: unknown, conta: ContaDoDirect): MensagemLida[] {
  const mensagens = (resposta as { messages?: unknown } | null)?.messages;
  const saida: MensagemLida[] = [];
  for (const item of lista(mensagens)) {
    const m = item as { id?: unknown; created_time?: unknown; from?: unknown; message?: unknown; attachments?: unknown; story?: unknown; is_unsupported?: unknown };
    const id = texto(m.id);
    const quando = data(m.created_time);
    if (!id || id.length > 300 || !quando) continue;
    const de = (m.from ?? {}) as { id?: unknown; username?: unknown };
    const kind = tipoDaMensagem(m);
    const corpo = typeof m.message === 'string' ? m.message.slice(0, MAX_TEXTO) : '';
    saida.push({ message_id: id, direction: daMarca(de, conta) ? 'saida' : 'entrada', kind, body: corpo, sent_at: quando });
  }
  return saida.sort((a, b) => (a.sent_at < b.sent_at ? -1 : a.sent_at > b.sent_at ? 1 : 0));
}

export type SituacaoDaConversa = 'espera' | 'respondida' | 'fora';

/**
 * A situação da conversa (D-A6-111): espera resposta enquanto a última mensagem é da pessoa e a janela de 24 horas não
 * fechou; fora da janela depois disso; respondida quando a última é da marca ou ela foi concluída sem resposta depois da
 * última mensagem da pessoa. `fechando` = faltam menos de 2 horas.
 */
export function situacaoDaConversa(
  c: { last_direction: DirecaoDoDirect; last_inbound_at: Date | string | null; concluded_at: Date | string | null },
  agora: Date,
): { situacao: SituacaoDaConversa; janelaAte: string | null; fechando: boolean } {
  const ultima = c.last_inbound_at ? new Date(c.last_inbound_at) : null;
  const janelaAte = ultima ? new Date(ultima.getTime() + JANELA_DO_DIRECT_HORAS * 3_600_000) : null;
  const concluida = c.concluded_at !== null && ultima !== null && new Date(c.concluded_at) >= ultima;
  if (c.last_direction === 'saida' || concluida || !janelaAte) return { situacao: 'respondida', janelaAte: janelaAte?.toISOString() ?? null, fechando: false };
  if (janelaAte <= agora) return { situacao: 'fora', janelaAte: janelaAte.toISOString(), fechando: false };
  return { situacao: 'espera', janelaAte: janelaAte.toISOString(), fechando: janelaAte.getTime() - agora.getTime() <= FECHANDO_HORAS * 3_600_000 };
}

/**
 * Quanto a conta espera depois de uma falha: mais curto que o dos posts (o Direct é lido a cada minuto e a pessoa espera
 * resposta). Sem permissão ou sem a autorização, uma hora (conectar de novo e ligar trazem a vez para agora); no limite
 * da Meta, o que ela pediu, ou 5 minutos; a recusa definitiva, uma hora; o resto, 5 minutos.
 */
export function esperaDaFalhaDoDirect(tipo: string, esperarMs: number | null): number {
  const MIN = 60_000;
  if (tipo === 'permissao' || tipo === 'autenticacao' || tipo === 'definitivo') return 60 * MIN;
  if (tipo === 'limite') return Math.max(esperarMs ?? 0, 5 * MIN);
  return 5 * MIN;
}

/** O que a porta do Regem diz que a Central atende (`GET /integracao/atendimento/canais`). */
export type CanaisDoRegem = { instagram: { ig_user_id: string; usuario: string | null }[]; messenger: { pagina_id: string }[] };

/**
 * A Central do Regem atende o Direct desta conta? Pelo id da conta profissional; se o id não bater (o login do Instagram e
 * o do Facebook podem dar ids diferentes, a conferir no teste), pelo @. No Messenger (A6, Z14; D-A6-121), pelo id da
 * Página.
 */
export function regemAtende(canais: CanaisDoRegem, conta: ContaDoDirect, canal: CanalDoDirect = 'instagram'): boolean {
  if (canal === 'messenger') return canais.messenger.some((m) => m.pagina_id === conta.id);
  return canais.instagram.some((c) => c.ig_user_id === conta.id || (conta.usuario !== null && c.usuario !== null && c.usuario.replace(/^@/, '').toLowerCase() === conta.usuario.replace(/^@/, '').toLowerCase()));
}
