import type { ActionResponse } from '@liame/contracts';
import { ANTECEDENCIA_MINIMA_MIN, DIAS_DE_ANTECEDENCIA, instanteNoFuso, NO_CANAL, noFuso, quando, situacaoDoPost } from '@/components/agenda/textos';
import { type PedidoApresentado, recusaDe } from './textos';

// O pedido de post em Aprovações (mockups/prototipo-post.html, P19 aprovado em 21/10/2026; A6, Z5c, parte 4). O servidor
// manda o post do pedido (`post`: a foto, o recorte, a hora, cada canal com a conta, o texto e a situação, e o fuso da
// empresa); aqui isso vira o título ("Post de amanhã, às 19:00"), a frase do modo simples, a etiqueta da lista e o
// resultado depois da decisão. A hora é sempre a do fuso da empresa, como na Agenda.

type Acao = ActionResponse;
export type AcaoDePost = Acao & { post: NonNullable<Acao['post']> };
type Post = AcaoDePost['post'];

/**
 * O pedido é de publicar um post do Liame, ou a nova tentativa dele no canal que não saiu (A6, Z5d), e o post ainda está
 * no Liame?
 */
export function ehPedidoDePost(a: Acao): a is AcaoDePost {
  return (a.tool === 'post_publicar' || a.tool === 'post_tentar_de_novo') && Boolean(a.post);
}

/** A nova tentativa de um post no canal que não saiu (A6, Z5d; D-A6-54): pedida por uma pessoa, sem o código do app. */
export const ehNovaTentativa = (a: Pick<Acao, 'tool'>): boolean => a.tool === 'post_tentar_de_novo';

/** O canal da nova tentativa, pelo provedor do pedido (a conta do canal que não saiu). */
const CANAL_DO_PROVEDOR: Record<string, string> = { instagram: 'instagram', facebook_page: 'facebook' };

/** O começo do motivo do pedido trocado por um novo quando a hora do post mudou (A6, Z5d, parte 3; D-A6-55). */
const HORA_MUDADA = 'hora mudada para ';

/** O pedido aprovado que saiu de cena porque a hora do post mudou (o post seguiu num pedido novo, aprovado de novo). */
export const ehHoraMudada = (a: Pick<Acao, 'status' | 'status_reason'>): boolean => a.status === 'cancelada' && Boolean(a.status_reason?.startsWith(HORA_MUDADA));

/**
 * A hora nova do "Mudar a hora" (P19; D-A6-23 e D-A6-55), conferida antes de mandar: o código com 6 números, a hora das
 * 8h às 22h, daqui a pelo menos 15 minutos, até 60 dias e diferente da marcada. O servidor confere de novo. Nulo: pode
 * mandar; senão, a frase e o campo que recebe o foco.
 */
export function erroDaHoraNova(
  n: { dia: string; hora: string; codigo: string },
  post: { publish_at: string; timezone: string },
  agora: Date,
): { campo: 'dia' | 'hora' | 'codigo'; texto: string } | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(n.dia)) return { campo: 'dia', texto: 'Escolha o dia.' };
  if (!/^\d{2}:\d{2}$/.test(n.hora) || n.hora < '08:00' || n.hora > '22:00') return { campo: 'hora', texto: 'Escolha uma hora entre 8h e 22h.' };
  const instante = instanteNoFuso(n.dia, n.hora, post.timezone).getTime();
  if (instante < agora.getTime() + ANTECEDENCIA_MINIMA_MIN * 60_000) return { campo: 'hora', texto: `Escolha uma hora daqui a pelo menos ${ANTECEDENCIA_MINIMA_MIN} minutos.` };
  if (instante > agora.getTime() + DIAS_DE_ANTECEDENCIA * 86_400_000) return { campo: 'dia', texto: `O post pode ser marcado para até ${DIAS_DE_ANTECEDENCIA} dias.` };
  if (instante === new Date(post.publish_at).getTime()) return { campo: 'hora', texto: 'O post já está marcado para essa hora.' };
  if (!/^\d{6}$/.test(n.codigo)) return { campo: 'codigo', texto: 'Digite os 6 números do app.' };
  return null;
}

/** Os motivos prontos da recusa de um post (os do P19). */
export const MOTIVOS_DO_POST = ['Quero outro texto', 'Quero outra foto', 'Não é o momento'];

/** "hoje, às 19:00", "amanhã, às 08:30", "sexta, 30/10, às 19:00": a hora marcada, no fuso da empresa. */
export function quandoDoPost(post: Post, agora: Date): string {
  const hoje = noFuso(agora, post.timezone).dia;
  const { dia, hora } = noFuso(new Date(post.publish_at), post.timezone);
  return quando(dia, hora, hoje);
}

/** "no Instagram", "no Instagram e na Página do Facebook" (V121: o nome com a preposição dele). */
export function ondeSai(post: Pick<Post, 'channels'>): string {
  const n = post.channels.map((c) => NO_CANAL[c.channel] ?? c.channel);
  return n.length <= 1 ? (n[0] ?? '') : `${n.slice(0, -1).join(', ')} e ${n.at(-1)}`;
}

/** "Instagram · Página do Facebook": os canais, na linha da lista. */
export function canaisDaLista(post: Pick<Post, 'channels'>): string {
  return post.channels.map((c) => (c.channel === 'instagram' ? 'Instagram' : c.channel === 'facebook' ? 'Página do Facebook' : c.channel)).join(' · ');
}

/**
 * A hora marcada já passou (o pedido esperou): aprovado agora, ele sai em seguida, ou às 8h, se for fora da janela das 8h
 * às 22h (D-A6-33, como o servidor faz).
 */
export function horaJaPassou(post: Pick<Post, 'publish_at'>, agora: Date): boolean {
  return new Date(post.publish_at).getTime() <= agora.getTime();
}

/** Quando o post sai, na frase depois de aprovar. */
function quandoSaiAprovado(post: Post, agora: Date): string {
  return horaJaPassou(post, agora) ? 'em seguida (entre 8h e 22h, no fuso da empresa)' : quandoDoPost(post, agora);
}

export function postApresentado(a: AcaoDePost, agora: Date): PedidoApresentado {
  const post = a.post;
  const quando = quandoDoPost(post, agora);
  if (ehNovaTentativa(a)) {
    const no = NO_CANAL[CANAL_DO_PROVEDOR[a.provider] ?? ''] ?? 'no canal que faltou';
    return {
      titulo: `De novo ${no}: post de ${quando}`,
      resumo: `A nova tentativa manda o mesmo post aprovado só ${no}, sem o código do app: o texto, a foto e o canal são os que a aprovação cobriu.`,
      impacto: null,
      mudancas: [],
      desfazer: 'Depois de publicado, o post se apaga na própria rede: o Liame ainda não apaga posts. Quem já viu, viu.',
      depoisDeAprovar: '',
    };
  }
  return {
    titulo: `Post de ${quando}`,
    resumo: `Você vai publicar um post ${ondeSai(post)}, ${quando}. Ele é público e sai em nome da empresa. Se você aprovar, o Liame publica na hora marcada.`,
    impacto: null,
    mudancas: [],
    desfazer: 'Depois de publicado, o post se apaga na própria rede: o Liame ainda não apaga posts. Quem já viu, viu.',
    depoisDeAprovar: `O post sai ${quandoSaiAprovado(post, agora)}.`,
  };
}

/** A segunda linha do pedido de post decidido, na lista: a situação do post (a mesma da Agenda). */
export function etiquetaDoPost(a: AcaoDePost): string {
  // O pedido trocado pela hora nova não diz a situação do post: ela é a do pedido novo.
  if (ehHoraMudada(a)) return 'Hora mudada';
  return situacaoDoPost(a.post.status).rotulo;
}

/** O que aconteceu com o post depois da decisão, no detalhe: o tom, o ícone e a frase. */
export type ResultadoDoPost = { tom: 'ok' | 'espera' | 'falha' | ''; icone: 'check' | 'clock' | 'alert' | 'x'; titulo: string; texto: string };

export function resultadoDoPost(a: AcaoDePost, agora: Date): ResultadoDoPost {
  const post = a.post;
  const recusa = recusaDe(a);
  const aprovacao = [...a.approvals].reverse().find((x) => x.current_plan && x.sufficient) ?? a.approvals.at(-1) ?? null;
  // A hora da aprovação também no fuso da empresa, como a do post.
  const quem = aprovacao ? `Aprovado por ${aprovacao.approver_name} às ${noFuso(new Date(aprovacao.created_at), post.timezone).hora}.` : 'Aprovado.';
  const quantos = post.channels.length > 1 ? `nos ${post.channels.length === 2 ? 'dois' : String(post.channels.length)} canais` : ondeSai(post);
  if (ehHoraMudada(a)) {
    return { tom: '', icone: 'clock', titulo: 'Hora mudada.', texto: 'Este pedido foi trocado por um novo, com a hora nova, aprovado de novo com o código do app. O post segue no pedido novo.' };
  }
  switch (post.status) {
    case 'recusado':
      return { tom: '', icone: 'x', titulo: 'Recusado.', texto: recusa?.motivo ? `Por ${recusa.quem}: “${recusa.motivo}”. Nada foi publicado.` : `Por ${recusa?.quem ?? 'quem aprova'}. Nada foi publicado.` };
    case 'agendado':
      return {
        tom: 'espera',
        icone: 'clock',
        titulo: `${quem} Sai ${quandoSaiAprovado(post, agora)}, ${quantos}.`,
        texto: 'Antes de publicar, o Liame consulta o limite de posts do dia do Instagram; no limite, o post espera, e o motivo aparece aqui.',
      };
    case 'publicando':
      return { tom: 'espera', icone: 'clock', titulo: 'Publicando…', texto: 'O Liame manda a foto e o texto para cada canal, uma vez só em cada um.' };
    case 'publicado':
      return { tom: 'ok', icone: 'check', titulo: 'Publicado.', texto: 'Saiu exatamente o texto e a foto aprovados. Veja abaixo em cada canal.' };
    case 'em_parte':
      return { tom: 'falha', icone: 'alert', titulo: 'Saiu em parte.', texto: 'Um canal não saiu; no outro, o post está no ar. Veja abaixo o motivo.' };
    case 'nao_saiu':
      return { tom: 'falha', icone: 'alert', titulo: 'Não saiu.', texto: 'Veja abaixo o motivo em cada canal.' };
    case 'cancelado':
      return { tom: '', icone: 'x', titulo: 'Cancelado antes de sair.', texto: 'Nada foi publicado.' };
    case 'expirado':
      return { tom: '', icone: 'x', titulo: 'Expirou sem aprovação.', texto: 'Ninguém aprovou no prazo, e nada foi publicado.' };
    default:
      return { tom: '', icone: 'clock', titulo: situacaoDoPost(post.status).rotulo, texto: '' };
  }
}
