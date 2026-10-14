import type { ActionResponse } from '@liame/contracts';
import type { NomeIcone } from '@/components/ui/icone';
import { horaDe } from '@/lib/formato';
import { quemPediu } from './anuncio-textos';
import { type PedidoApresentado, recusaDe, type Risco, riscoDe } from './textos';

// A resposta a uma avaliação do Google em Aprovações (mockups/prototipo-avaliacoes.html, P17 aprovado em 09/10/2026; Z2
// da A6). O servidor manda, em `review`, a nota da hora do pedido, se só o dono decide, o texto da resposta e a
// avaliação como o Liame a guarda agora (o texto dela não fica no pedido). O nome de quem avaliou NÃO vem no pedido: a
// tela o lê à parte, do Google, na hora (`GET /v1/reviews/authors`), e ele pode faltar. Aqui isso vira o título, a
// frase do que acontece, a situação do pedido e o resultado. A resposta é pública e sai em nome da loja.

type Acao = ActionResponse;
export type AcaoDeResposta = Acao & { review: NonNullable<Acao['review']> };

/** O pedido é de responder a uma avaliação do Google, ou de apagar a resposta que o Liame publicou? */
export function ehPedidoDeResposta(a: Acao): a is AcaoDeResposta {
  return Boolean(a.review) && (a.tool === 'avaliacao_responder' || a.tool === 'avaliacao_apagar_resposta');
}

/** O pedido de apagar a resposta (a volta da resposta publicada). */
export const ehApagar = (a: Pick<Acao, 'tool'>): boolean => a.tool === 'avaliacao_apagar_resposta';

export const estrelasEscritas = (n: number): string => `${n} ${n === 1 ? 'estrela' : 'estrelas'}`;

/** As estrelas do pedido: as da hora em que foi feito; sem elas, as de agora. */
export function estrelasDoPedido(a: AcaoDeResposta): number | null {
  return a.review.stars ?? a.review.current?.stars ?? null;
}

/** "Responder à avaliação de Marina S."; sem o nome, "Responder a uma avaliação de 5 estrelas". */
export function tituloDaResposta(a: AcaoDeResposta, nome: string | null): string {
  if (nome) return ehApagar(a) ? `Apagar a resposta à avaliação de ${nome}` : `Responder à avaliação de ${nome}`;
  const n = estrelasDoPedido(a);
  const de = n ? ` de ${estrelasEscritas(n)}` : ' do Google';
  return ehApagar(a) ? `Apagar a resposta a uma avaliação${de}` : `Responder a uma avaliação${de}`;
}

/** "em nome da loja “Mister Burgers — Centro”": a preposição vai com "loja", e não com o nome dela (V121). */
export function emNomeDa(a: Pick<Acao, 'account_name'>): string {
  return a.account_name ? `em nome da loja “${a.account_name}”` : 'em nome da empresa';
}

/** O texto que vem do Google pode ter os espaços acertados por ele: para comparar, um espaço só entre as palavras. */
const comparavel = (s: string): string => s.normalize('NFC').split(/\s+/).filter(Boolean).join(' ');

/** Onde o pedido está. A situação da resposta no Google (conferindo, publicada, recusada) vem da avaliação de agora. */
export type SituacaoDaResposta =
  | 'pendente'
  | 'publicando'
  | 'conferindo'
  | 'publicada'
  | 'recusada-google'
  | 'trocada'
  | 'fora-do-perfil'
  | 'sem-avaliacao'
  | 'apagando'
  | 'apagada'
  | 'mudou'
  | 'recusada'
  | 'cancelada'
  | 'expirada'
  | 'falhou';

const VOLTA_EM_CURSO = ['aguardando_aprovacao', 'aprovada', 'executando'];

export function situacaoDaResposta(a: AcaoDeResposta): SituacaoDaResposta {
  if (a.status === 'aguardando_aprovacao') return 'pendente';
  if (recusaDe(a)) return 'recusada';
  if (a.status === 'cancelada') return 'cancelada';
  if (a.status === 'expirada') return 'expirada';
  if (a.status === 'falhou') return a.execution?.status === 'estado_mudou' ? 'mudou' : 'falhou';
  if (a.status !== 'executada') return ehApagar(a) ? 'apagando' : 'publicando';
  if (ehApagar(a)) return 'apagada';
  if (a.undone_by?.status === 'executada') return 'apagada';
  if (a.undone_by && VOLTA_EM_CURSO.includes(a.undone_by.status)) return 'apagando';
  const atual = a.review.current;
  if (!atual) return 'sem-avaliacao';
  if (!atual.reply) return 'fora-do-perfil';
  if (a.review.reply_text && comparavel(atual.reply.text) !== comparavel(a.review.reply_text)) return 'trocada';
  if (atual.reply.state === 'recusada') return 'recusada-google';
  if (atual.reply.state === 'pendente') return 'conferindo';
  return 'publicada';
}

/** A segunda linha do item decidido na lista. */
export function etiquetaDaResposta(a: AcaoDeResposta): string {
  const s = situacaoDaResposta(a);
  if (ehApagar(a)) return s === 'apagada' ? 'Resposta apagada' : s === 'apagando' ? 'Apagando' : 'Não apagada';
  const rotulo: Record<SituacaoDaResposta, string> = {
    pendente: 'Espera aprovação',
    publicando: 'Aprovada',
    conferindo: 'O Google está conferindo',
    publicada: 'Publicada',
    'recusada-google': 'Recusada pelo Google',
    trocada: 'Trocada no Google',
    'fora-do-perfil': 'Fora do perfil',
    'sem-avaliacao': 'Avaliação fora do Liame',
    apagando: 'Apagando',
    apagada: 'Resposta apagada',
    mudou: 'A avaliação mudou',
    recusada: 'Recusada',
    cancelada: 'Cancelada',
    expirada: 'Expirou',
    falhou: 'Não publicada',
  };
  return rotulo[s];
}

/** O risco na lista e nos chips: a de 1 ou 2 estrelas, que só o dono decide, é alto; as outras, o da ferramenta. */
export function riscoDaResposta(a: AcaoDeResposta): { classe: Risco; rotulo: string } {
  if (a.review.owner_only) return { classe: 'alto', rotulo: 'Só o dono aprova' };
  const r = riscoDe(a);
  return { classe: r, rotulo: r === 'alto' ? 'Risco alto' : r === 'medio' ? 'Risco médio' : 'Risco baixo' };
}

/** Os motivos prontos da recusa (P17). */
export const MOTIVOS_DA_RESPOSTA = ['Quero outro texto', 'Prefiro não responder', 'Vou responder por conta própria'];

/** A frase do modo Lite, em pedaços (o que vai em negrito). */
export type Pedaco = { t: string; b?: boolean };

/**
 * "Rodrigo escreveu uma resposta para a avaliação de 5 estrelas que Marina S. deixou. Ela é pública e sai em nome da
 * loja “Centro”. Se você aprovar, o Liame publica no Google." Quem lê e não pode aprovar não lê a última frase.
 */
export function fraseDaResposta(a: AcaoDeResposta, nome: string | null, opcoes: { euPedi: boolean; possoAprovar: boolean }): Pedaco[] {
  const quem = quemPediu(a);
  const n = estrelasDoPedido(a);
  const sujeito = quem.funcionario ? `${quem.nome} propõe` : opcoes.euPedi ? 'Você escreveu' : `${quem.nome} escreveu`;
  const qual: Pedaco[] = n
    ? [{ t: ` uma resposta para a avaliação de ` }, { t: estrelasEscritas(n), b: true }, { t: nome ? ` que ${nome} deixou.` : '.' }]
    : [{ t: ' uma resposta para uma avaliação do Google.' }];
  return [
    { t: sujeito },
    ...qual,
    { t: ' Ela é ' },
    { t: 'pública', b: true },
    { t: ` e sai ${emNomeDa(a)}.` },
    ...(opcoes.possoAprovar ? [{ t: ' Se você aprovar, o Liame publica no Google.' }] : []),
  ];
}

/** O pedido em palavras, para a lista e os avisos da tela (o mesmo formato dos outros pedidos). */
export function respostaApresentada(a: AcaoDeResposta, nome: string | null): PedidoApresentado {
  const n = estrelasDoPedido(a);
  return {
    titulo: tituloDaResposta(a, nome),
    resumo: ehApagar(a) ? 'A resposta sai do perfil no Google.' : `Resposta pública a uma avaliação${n ? ` de ${estrelasEscritas(n)}` : ''}, ${emNomeDa(a)}.`,
    impacto: null,
    mudancas: [],
    desfazer: 'Depois de publicada, dá para apagar a resposta. Quem avaliou já terá sido avisado.',
    depoisDeAprovar: 'O Liame publica no Google em instantes, e o Google confere a resposta antes de mostrar.',
  };
}

export interface ResultadoDaResposta {
  tom: 'ok' | 'espera' | 'falha' | 'neutro';
  icone: NomeIcone;
  forte: string | null;
  texto: string;
}

/** Quem apagou a resposta e quando: o pedido de volta que a lista traz. */
export type Apagada = { quem: string; quando: string } | null;

function aprovadaPor(a: Acao): string {
  const aprovacao = [...a.approvals].reverse().find((x) => x.current_plan && x.sufficient) ?? a.approvals.at(-1) ?? null;
  return aprovacao ? `Aprovada por ${aprovacao.approver_name} às ${horaDe(aprovacao.created_at)}.` : 'Aprovada.';
}

/** O que aconteceu com o pedido decidido, no detalhe. `pro`: o código do motivo do Google aparece. */
export function resultadoDaResposta(a: AcaoDeResposta, apagada: Apagada, pro: boolean): ResultadoDaResposta {
  const s = situacaoDaResposta(a);
  const recusa = recusaDe(a);
  if (ehApagar(a)) {
    if (s === 'apagada') return { tom: 'neutro', icone: 'undo', forte: `Resposta apagada por ${a.requested_by.name} às ${horaDe(a.updated_at)}.`, texto: ' Ela não aparece mais no perfil. A avaliação volta para “sem resposta”.' };
    if (s === 'apagando') return { tom: 'espera', icone: 'clock', forte: 'A resposta está sendo apagada.', texto: ' O Liame apaga no Google em instantes.' };
    if (s === 'mudou') return { tom: 'falha', icone: 'alert', forte: 'A resposta não foi apagada.', texto: ' Ela mudou no Google depois do pedido, e o Liame não apaga o que não publicou.' };
    return { tom: 'falha', icone: 'alert', forte: 'A resposta não foi apagada.', texto: ` ${a.status_reason ?? 'O pedido não chegou ao Google.'}` };
  }
  switch (s) {
    case 'recusada':
      return { tom: 'falha', icone: 'x', forte: null, texto: recusa?.motivo ? `Recusada por ${recusa.quem}: “${recusa.motivo}”. Nada foi publicado.` : `Recusada por ${recusa?.quem ?? 'quem aprova'}. Nada foi publicado.` };
    case 'cancelada':
      return { tom: 'falha', icone: 'x', forte: null, texto: 'Cancelada por quem pediu. Nada foi publicado.' };
    case 'expirada':
      return { tom: 'falha', icone: 'x', forte: null, texto: 'Expirou sem aprovação: nada foi publicado.' };
    case 'publicando':
      return a.next_attempt_at
        ? { tom: 'espera', icone: 'clock', forte: aprovadaPor(a), texto: ` Ainda não foi publicada: ${a.status_reason ?? 'o Google pediu para esperar'}. O Liame tenta de novo às ${horaDe(a.next_attempt_at)}.` }
        : { tom: 'espera', icone: 'clock', forte: aprovadaPor(a), texto: ' O Liame publica no Google em instantes.' };
    case 'conferindo':
      return {
        tom: 'espera',
        icone: 'clock',
        forte: `${aprovadaPor(a)} O Google está conferindo a resposta.`,
        texto: ' Ele confere toda resposta antes de mostrar: costuma levar até 10 minutos e, às vezes, mais. O Liame lê de novo em alguns minutos: quando ela aparecer no perfil, a situação muda aqui; se o Google recusar, o aviso aparece em Atenção.',
      };
    case 'publicada':
      return { tom: 'ok', icone: 'check', forte: 'Publicada no Google.', texto: ` A resposta aparece embaixo da avaliação, ${emNomeDa(a)}. Quem avaliou foi avisado pelo Google.` };
    case 'recusada-google': {
      const codigo = a.review.current?.reply?.violation ?? null;
      const motivo = codigo ? `O que o Google informou: a resposta fere a política de conteúdo dele${pro ? ` (${codigo})` : ''}.` : 'O Google não informou o motivo.';
      return { tom: 'falha', icone: 'alert', forte: 'O Google recusou a resposta.', texto: ` Ela não aparece no perfil. ${motivo} O Liame não tenta de novo sozinho.` };
    }
    case 'trocada':
      return { tom: 'neutro', icone: 'info', forte: 'A resposta foi trocada direto no Google depois de publicada.', texto: ' A que está no perfil é outra, e o Liame não mexe nela.' };
    case 'fora-do-perfil':
      return { tom: 'neutro', icone: 'info', forte: 'A resposta não está mais no perfil.', texto: ' Ela foi apagada direto no Google.' };
    case 'sem-avaliacao':
      return { tom: 'neutro', icone: 'info', forte: 'O Liame não guarda mais esta avaliação.', texto: ' Ela tem mais de 12 meses, ou saiu do Google.' };
    case 'apagando':
      return { tom: 'espera', icone: 'clock', forte: 'A resposta está sendo apagada.', texto: ' O Liame apaga no Google em instantes.' };
    case 'apagada':
      return {
        tom: 'neutro',
        icone: 'undo',
        forte: apagada ? `Resposta apagada por ${apagada.quem} às ${horaDe(apagada.quando)}.` : 'Resposta apagada.',
        texto: ' Ela não aparece mais no perfil. A avaliação volta para “sem resposta”.',
      };
    case 'mudou':
      return { tom: 'falha', icone: 'alert', forte: 'A avaliação mudou depois deste pedido.', texto: ' Ela foi editada, apagada ou respondida por outro caminho. A resposta era para a avaliação de antes: não foi publicada.' };
    default:
      return { tom: 'falha', icone: 'alert', forte: null, texto: `${aprovadaPor(a)} Mas a resposta não foi publicada: ${a.status_reason ?? 'a execução falhou'}.`.replace('..', '.') };
  }
}

/** A avaliação ainda pode ganhar outra resposta pelo Liame (a recusada pelo Google, a que mudou, a que perdeu a resposta). */
export function podeEscreverOutra(a: AcaoDeResposta): boolean {
  if (ehApagar(a)) return false;
  const s = situacaoDaResposta(a);
  const atual = a.review.current;
  if (!atual) return false;
  if (s === 'recusada-google') return true;
  return (s === 'mudou' || s === 'fora-do-perfil' || s === 'apagada' || s === 'recusada' || s === 'cancelada' || s === 'expirada' || s === 'falhou') && !atual.reply;
}

/** A frase que barra o pedido: os 4xx da criação e da alteração do texto, nas palavras do servidor. */
export function erroDoTexto(p: { code: string; detail?: string; title: string }): string {
  if (p.code === 'acao-duplicada') return 'Já há uma resposta esperando a aprovação para esta avaliação. Abra a que existe, em vez de escrever outra.';
  if (p.code === 'escrita-desligada') return 'Responder pelo Liame ainda não está ligado para esta empresa.';
  return p.detail ?? p.title;
}

/** O texto que a pessoa digitou serve para salvar? (O limite fino é o do servidor: 1.500 caracteres.) */
export const TAMANHO_DA_RESPOSTA = 1500;
export function textoDaRespostaValido(texto: string): string | null {
  const t = texto.trim();
  if (!t) return 'Escreva a resposta antes de salvar.';
  if ([...t].length > TAMANHO_DA_RESPOSTA) return `A resposta passa de ${TAMANHO_DA_RESPOSTA.toLocaleString('pt-BR')} caracteres.`;
  return null;
}
