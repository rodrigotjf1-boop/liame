import { createHash } from 'node:crypto';
import { z } from 'zod';
import { JANELA_DO_DIRECT_HORAS } from '../direct/direct.js';

// A resposta numa conversa do Direct, pelo trilho de ações (A6, Z12, parte 2; P39, D-A6-109 e D-A6-111): o recurso, o
// estado que o pedido guarda, a versão e o plano. Funções puras; o conector (`direct-na-rede.ts`) lê e manda.
//
// O recurso é a conversa: `resource_id` = `direct:<id da conversa na Meta>`; `account_id` é a conta do Instagram ligada
// à marca. O estado não leva texto nem quem é a pessoa: a última mensagem dela (a janela de 24 horas conta a partir
// dela) e o resumo (SHA-256) das respostas da marca depois dela, para a execução não mandar duas vezes.

const PREFIXO = 'direct:';

/** A função de escrita da ferramenta (migration 0131), além da do conector (`social_write`). */
export const FLAG_DE_RESPONDER_NO_DIRECT = 'direct_responder';
/** A ação para a política (a regra v13: direta para a pessoa que pede, com o atendimento aberto). */
export const ACAO_DE_RESPONDER_NO_DIRECT = 'direct.responder';
/** A ferramenta da resposta automática no Direct (A6, Z12, parte 5a; D-A6-115). */
export const FERRAMENTA_DO_DIRECT_AUTOMATICO = 'direct_responder_auto';
/** A ação da resposta automática (a regra v14: direta quando quem pede é o funcionário de IA, pelo atendimento automático). */
export const ACAO_DE_RESPONDER_NO_DIRECT_SOZINHO = 'direct.responder_automatico';
/** O limite da Meta para o texto de uma mensagem: 1.000 bytes em UTF-8 (a letra com acento ocupa 2). */
export const BYTES_DA_RESPOSTA_NO_DIRECT = 1000;

/** O id da conversa no recurso: letras, dígitos e `_ = . : -`, de 1 a 200 (conferido letra a letra). */
function idDaConversa(v: string): string | null {
  if (v.length === 0 || v.length > 200) return null;
  for (const c of v) {
    const ok = (c >= '0' && c <= '9') || (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '_' || c === '=' || c === '.' || c === ':' || c === '-';
    if (!ok) return null;
  }
  return v;
}

/** `direct:<id>` → o id da conversa na Meta. */
export function conversaDoRecurso(resourceId: string): string | null {
  return resourceId.startsWith(PREFIXO) ? idDaConversa(resourceId.slice(PREFIXO.length)) : null;
}

/** O recurso de uma conversa, para quem monta o pedido. */
export const recursoDaConversa = (id: string): string => `${PREFIXO}${id}`;

export const ParametrosDaRespostaNoDirect = z.strictObject({
  texto: z.string().min(1).max(4000),
});

export const EstadoDaConversaNoDirect = z.strictObject({
  tipo: z.literal('direct'),
  id: z.string().min(1).max(200),
  existe: z.boolean(),
  /** A última mensagem da pessoa; nula sem mensagem dela. */
  ultima_da_pessoa: z.iso.datetime().nullable(),
  /** O resumo (SHA-256) de cada resposta da marca depois da última mensagem da pessoa. */
  respostas_resumo: z.array(z.string().length(64)).max(20),
  /** Só no estado desejado: o texto que sai. */
  resposta: z.strictObject({ texto: z.string() }).nullable().optional(),
});
export type EstadoDaConversaNoDirect = z.infer<typeof EstadoDaConversaNoDirect>;

/** O texto como a Meta e o Liame comparam: sem espaço nas pontas e com os espaços do meio juntos. */
const comparavel = (t: string): string => t.trim().split(/\s+/).join(' ');
export const resumoDaResposta = (t: string): string => createHash('sha256').update(comparavel(t), 'utf8').digest('hex');

/** A versão sai do estado: a conversa mudou (a pessoa escreveu de novo, a marca respondeu por fora) muda a versão. */
export function versaoDaConversaNoDirect(e: Pick<EstadoDaConversaNoDirect, 'existe' | 'ultima_da_pessoa' | 'respostas_resumo'>): number {
  const base = JSON.stringify([e.existe, e.ultima_da_pessoa, [...e.respostas_resumo].sort()]);
  return (Number.parseInt(createHash('sha256').update(base).digest('hex').slice(0, 12), 16) % 2_147_483_646) + 1;
}

/** O texto da resposta como sai: sem o caractere nulo, sem espaço nas pontas, até 1.000 bytes. Nulo quando não serve. */
export function textoDaRespostaNoDirect(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const limpo = v.split('\u0000').join('').trim();
  if (!limpo || Buffer.byteLength(limpo, 'utf8') > BYTES_DA_RESPOSTA_NO_DIRECT) return null;
  return limpo;
}

/** A janela da Meta ainda está aberta (24 horas depois da última mensagem da pessoa)? */
export function janelaAberta(ultimaDaPessoa: string | null, agora: Date): boolean {
  return ultimaDaPessoa !== null && new Date(ultimaDaPessoa).getTime() + JANELA_DO_DIRECT_HORAS * 3_600_000 > agora.getTime();
}

const SUMIU = 'Esta conversa não está mais no Liame.';
export const FORA_DA_JANELA =
  'A janela da Meta fechou: a marca só responde até 24 horas depois da última mensagem da pessoa. Quando ela escrever de novo, a conversa reabre.';

type Recusa = { ok: false; motivo: string };
export type PlanoDaRespostaNoDirect = Recusa | { ok: true; acao: string; texto: string; desejado: EstadoDaConversaNoDirect };

/** O plano da resposta: a conversa existe, a pessoa escreveu, a janela está aberta e o texto cabe. `agora`: o relógio. */
export function planoDaRespostaNoDirect(before: unknown, params: unknown, agora: Date = new Date()): PlanoDaRespostaNoDirect {
  const lido = EstadoDaConversaNoDirect.safeParse(before);
  if (!lido.success) return { ok: false, motivo: 'O pedido não é de uma conversa do Direct.' };
  const e = lido.data;
  if (!e.existe) return { ok: false, motivo: SUMIU };
  if (!e.ultima_da_pessoa) return { ok: false, motivo: 'A pessoa ainda não escreveu nesta conversa: o Instagram só deixa a marca responder depois.' };
  if (!janelaAberta(e.ultima_da_pessoa, agora)) return { ok: false, motivo: FORA_DA_JANELA };
  const pedido = ParametrosDaRespostaNoDirect.safeParse(params);
  const texto = pedido.success ? textoDaRespostaNoDirect(pedido.data.texto) : null;
  if (!texto) return { ok: false, motivo: 'A resposta precisa de um texto, com até 1.000 de espaço (a letra com acento conta 2).' };
  return { ok: true, acao: ACAO_DE_RESPONDER_NO_DIRECT, texto, desejado: { ...e, resposta: { texto } } };
}

/** A resposta já saiu (a tentativa anterior caiu depois de a Meta aceitar)? Pelo resumo do texto, depois da última da pessoa. */
export function respostaNoDirectJaSaiu(atual: EstadoDaConversaNoDirect, desejado: unknown): boolean {
  const quer = EstadoDaConversaNoDirect.safeParse(desejado);
  if (!quer.success || !quer.data.resposta || !atual.existe) return false;
  return atual.respostas_resumo.includes(resumoDaResposta(quer.data.resposta.texto));
}
