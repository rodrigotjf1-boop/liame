import { z } from 'zod';
import { localClock } from '../policy/engine.js';

// O post no trilho (A6, Z5b; `plano-a6.md` §3 Z5; D-A6-3, D-A6-6 a D-A6-8, D-A6-21 e D-A6-23; as decisões técnicas
// D-A6-32 a D-A6-37 estão em `decisoes-design.md`). Funções puras: o estado do post que o conector lê do banco, o plano da
// ferramenta `post_publicar` e a hora em que o pedido aprovado sai. Sem rede e sem banco.
//
// O post é um recurso do Liame (D-A6-32): `post:<id>`. O estado traz a foto (pelo resumo do arquivo), o recorte do
// Instagram, a hora e cada canal com o texto e a situação; é ele que vai para o pedido e entra no hash do plano. A
// aprovação vale para o conjunto (D-A6-7): mudar o texto, a foto ou os canais é um post novo.

export const PREFIXO_DO_POST = 'post:';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** O recurso do post no trilho, para quem monta o pedido. */
export const recursoDoPost = (id: string): string => `${PREFIXO_DO_POST}${id}`;

/** `post:<id>` → o id do post no Liame; nulo para o que não é um post. */
export function postDoRecurso(resourceId: string): string | null {
  if (!resourceId.startsWith(PREFIXO_DO_POST)) return null;
  const id = resourceId.slice(PREFIXO_DO_POST.length);
  return UUID.test(id) ? id.toLowerCase() : null;
}

/** Os canais onde o Liame publica nesta fase (D-A6-12: TikTok e YouTube só no pacote pronto; o Threads, depois). */
export const CANAIS_DO_POST = ['instagram', 'facebook'] as const;
export type CanalDoPost = (typeof CANAIS_DO_POST)[number];

/** O provedor da conta ligada de cada canal (A6 · Z5a): é também o provedor do pedido no trilho. */
export const PROVEDOR_DO_CANAL: Record<CanalDoPost, string> = { instagram: 'instagram', facebook: 'facebook_page' };

/** O nome do canal nas frases, com a preposição dele (V121): "no Instagram", "na Página do Facebook". */
const NO_CANAL: Record<CanalDoPost, string> = { instagram: 'no Instagram', facebook: 'na Página do Facebook' };
const DO_CANAL: Record<CanalDoPost, string> = { instagram: 'do Instagram', facebook: 'da Página do Facebook' };

/**
 * O limite do texto de cada canal: a legenda do Instagram, até 2.200 caracteres (base §2.2, 21/10/2026); a Página do
 * Facebook não escreve limite na referência da foto, e o Liame põe o dele (decisão técnica D-A6-34).
 */
export const LIMITE_DO_TEXTO: Record<CanalDoPost, number> = { instagram: 2200, facebook: 10000 };

/**
 * Os canais do pacote pronto (A6, Z8; D-A6-12 e D-A6-25; P22): o Liame monta o texto, a foto e a hora, e quem publica é a
 * pessoa. Cada rede vira um pacote (`social_post.kind = 'pacote'`), sem pedido em Aprovações e sem conta ligada.
 */
export const CANAIS_DO_PACOTE = ['tiktok', 'youtube'] as const;
export type CanalDoPacote = (typeof CANAIS_DO_PACOTE)[number];
export const ehCanalDoPacote = (c: string): c is CanalDoPacote => (CANAIS_DO_PACOTE as readonly string[]).includes(c);

/**
 * O limite do texto do pacote (decisão técnica D-A6-41): o TikTok, 2.200 caracteres (o que vale em toda conta; a Central do
 * TikTok não publica o número [NC]); o YouTube, os 5.000 da descrição (Central do YouTube, lida em 29/10/2026).
 */
export const LIMITE_DO_PACOTE: Record<CanalDoPacote, number> = { tiktok: 2200, youtube: 5000 };

/** A situação do pacote na Agenda: espera a pessoa (`pronto`), ela marcou "Publiquei", ou foi tirado da Agenda. */
export type SituacaoDoPacote = 'pacote_pronto' | 'pacote_publicado' | 'cancelado';

/** A situação do pacote pelos canais dele (um só, D-A6-40): pronto, publicado ou, tirado, cancelado. */
export function situacaoDoPacote(canais: readonly string[]): SituacaoDoPacote {
  if (canais.some((s) => s === 'pronto')) return 'pacote_pronto';
  if (canais.length > 0 && canais.every((s) => s === 'publicado')) return 'pacote_publicado';
  return 'cancelado';
}

/** A janela da hora do post (D-A6-8): das 8h às 22h, no fuso da empresa, em minutos do dia (22h00 ainda vale). */
export const JANELA_DO_POST = { de: 8 * 60, ate: 22 * 60 } as const;

/** Com quanta antecedência um post pode ser marcado (decisão técnica D-A6-34). */
export const DIAS_DE_ANTECEDENCIA = 60;

/** A situação de cada canal do post. */
export const SituacaoDoCanal = z.enum(['aguardando', 'publicando', 'publicado', 'falhou', 'cancelado', 'apagado']);
export type SituacaoDoCanal = z.infer<typeof SituacaoDoCanal>;

export const CanalNoEstado = z.object({
  canal: z.enum(CANAIS_DO_POST),
  /** A conta ligada do canal (a Página ou o Instagram); nula quando ela foi desligada da marca depois do pedido. */
  conta: z.string().nullable(),
  texto: z.string(),
  situacao: SituacaoDoCanal,
});
export type CanalNoEstado = z.infer<typeof CanalNoEstado>;

/** O post como o conector o lê do banco, na hora do pedido e na da execução. */
export const EstadoDoPost = z.object({
  post: z.string(),
  /** A foto das Fotos (pelo resumo do arquivo guardado); nula quando ela foi apagada depois do pedido. */
  foto: z.object({ id: z.string(), sha256: z.string() }).nullable(),
  /** A posição do recorte do Instagram (D-A6-21), de 0 a 100 ao longo do lado comprido; nula = a foto cabe inteira. */
  recorte: z.number().int().min(0).max(100).nullable(),
  /** A hora marcada, em UTC, e a mesma hora no fuso da empresa (`HH:MM`), que o plano confere com a janela. */
  hora: z.string(),
  hora_local: z.string(),
  canais: z.array(CanalNoEstado).min(1).max(CANAIS_DO_POST.length),
});
export type EstadoDoPost = z.infer<typeof EstadoDoPost>;

/** `HH:MM` dentro da janela das 8h às 22h. */
export function dentroDaJanela(horaLocal: string): boolean {
  if (horaLocal.length !== 5 || horaLocal[2] !== ':') return false;
  const h = Number(horaLocal.slice(0, 2));
  const m = Number(horaLocal.slice(3, 5));
  if (!Number.isInteger(h) || !Number.isInteger(m) || h > 23 || m > 59) return false;
  const minuto = h * 60 + m;
  return minuto >= JANELA_DO_POST.de && minuto <= JANELA_DO_POST.ate;
}

/** A hora local de um instante, `HH:MM`, no fuso da empresa. */
export function horaLocal(instante: Date, fuso: string): string {
  const { minute } = localClock(instante, fuso);
  return `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;
}

export type PlanoDoPost = { ok: true; desejado: EstadoDoPost; texto: string } | { ok: false; motivo: string };

/**
 * O plano de publicar: só um post do Liame, com a foto e as contas ainda lá, com todos os canais esperando, cada texto
 * no limite da rede, e a hora dentro da janela. O estado desejado é o mesmo post, com cada canal publicado; o texto do
 * plano junta o texto dos canais, para as palavras que a empresa ou a marca proíbem valerem (o mesmo da resposta a uma
 * avaliação). Função pura.
 */
export function planoDoPost(before: unknown): PlanoDoPost {
  const lido = EstadoDoPost.safeParse(before);
  if (!lido.success) return { ok: false, motivo: 'Esta ferramenta é para um post do Liame.' };
  const e = lido.data;
  if (!e.foto) return { ok: false, motivo: FOTO_APAGADA };
  if (e.canais.some((c) => c.situacao !== 'aguardando')) return { ok: false, motivo: JA_SAIU };
  for (const c of e.canais) {
    if (!c.conta) return { ok: false, motivo: contaFora(c.canal) };
    if (c.texto.trim().length === 0) return { ok: false, motivo: `O texto ${NO_CANAL[c.canal]} está vazio.` };
    if (c.texto.length > LIMITE_DO_TEXTO[c.canal]) return { ok: false, motivo: `O texto ${NO_CANAL[c.canal]} passa de ${LIMITE_DO_TEXTO[c.canal].toLocaleString('pt-BR')} caracteres.` };
  }
  if (!dentroDaJanela(e.hora_local)) return { ok: false, motivo: 'O post sai entre 8h e 22h. Escolha outra hora.' };
  return {
    ok: true,
    desejado: { ...e, canais: e.canais.map((c) => ({ ...c, situacao: 'publicado' as const })) },
    texto: e.canais.map((c) => c.texto).join('\n\n'),
  };
}

const FOTO_APAGADA = 'A foto deste post foi apagada nas Fotos: o post não sai. Faça um post novo com outra foto.';
const JA_SAIU = 'Este post já saiu, ou não sai mais: não dá para publicar de novo.';
const contaFora = (canal: CanalDoPost): string =>
  `A conta ${DO_CANAL[canal]} deste post não está conectada à marca agora: o post não sai ${NO_CANAL[canal]}. Confira em Contas conectadas.`;

/**
 * Na hora de sair, o post aprovado ainda pode sair (A6-10)? A foto continua nas Fotos, e cada canal que ainda não saiu
 * (esperando, ou com a publicação começada numa tentativa anterior) tem a conta conectada à marca. O canal já publicado
 * não conta: a tentativa seguinte completa o resto. Nulo: pode sair. Função pura.
 */
export function recusaNaHoraDeSair(e: EstadoDoPost): string | null {
  const faltam = e.canais.filter((c) => c.situacao === 'aguardando' || c.situacao === 'publicando');
  if (faltam.length === 0) return JA_SAIU;
  if (!e.foto) return FOTO_APAGADA;
  for (const c of faltam) if (!c.conta) return contaFora(c.canal);
  return null;
}

/** A situação do post que a Agenda mostra (o contrato a lista em `PostResponse.status`). */
export type SituacaoDoPost =
  | 'esperando_aprovacao'
  | 'agendado'
  | 'publicando'
  | 'publicado'
  | 'em_parte'
  | 'nao_saiu'
  | 'cancelado'
  | 'recusado'
  | 'expirado';

/**
 * A situação do post, pelo pedido em Aprovações e pelos canais: o pedido que espera é "esperando a aprovação"; o aprovado
 * espera a hora ("agendado"); o que executa está "publicando"; o que terminou diz o que saiu (todos os canais, parte deles,
 * nenhum). Recusado e cancelado vêm do pedido (a recusa tem o prefixo dela no motivo).
 */
export function situacaoDoPost(pedido: { status: string; status_reason: string | null } | null, canais: readonly string[], prefixoDaRecusa: string): SituacaoDoPost {
  const publicados = canais.filter((s) => s === 'publicado').length;
  const deTodos = publicados > 0 && publicados === canais.length ? 'publicado' : publicados > 0 ? 'em_parte' : 'nao_saiu';
  if (!pedido) return 'esperando_aprovacao';
  switch (pedido.status) {
    case 'aguardando_aprovacao':
    case 'sombra':
      return 'esperando_aprovacao';
    case 'aprovada':
      return publicados > 0 ? 'publicando' : 'agendado';
    case 'executando':
      return 'publicando';
    case 'cancelada':
      return pedido.status_reason?.startsWith(prefixoDaRecusa) ? 'recusado' : publicados > 0 ? 'em_parte' : 'cancelado';
    case 'expirada':
      return 'expirado';
    default:
      // executada, falhou, bloqueada, estado_mudou: o que saiu é o que os canais dizem.
      return deTodos;
  }
}

/**
 * Quando o pedido aprovado sai (D-A6-8; decisão técnica D-A6-33): na hora marcada; aprovado depois dela, na hora da
 * aprovação; e nunca fora da janela das 8h às 22h no fuso da empresa (o que cairia fora espera as 8h do dia seguinte, ou
 * do mesmo dia, se for de madrugada). Sem hora válida, nulo (o pedido segue o caminho de sempre).
 */
export function quandoSai(horaMarcada: string, agora: Date, fuso: string): Date | null {
  const marcada = new Date(horaMarcada);
  if (Number.isNaN(marcada.getTime())) return null;
  const base = new Date(Math.max(marcada.getTime(), agora.getTime()));
  // O minuto cheio: a janela se confere por minuto, e "8h00" não pode virar "8h00 e 30 segundos".
  base.setUTCSeconds(0, 0);
  const { minute } = localClock(base, fuso);
  if (minute < JANELA_DO_POST.de) return new Date(base.getTime() + (JANELA_DO_POST.de - minute) * 60_000);
  if (minute > JANELA_DO_POST.ate) return new Date(base.getTime() + (24 * 60 - minute + JANELA_DO_POST.de) * 60_000);
  return base;
}
