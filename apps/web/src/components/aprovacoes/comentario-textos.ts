import type { ActionResponse } from '@liame/contracts';
import type { NomeIcone } from '@/components/ui/icone';
import { horaDe } from '@/lib/formato';
import { quemPediu } from './anuncio-textos';
import type { Pedaco } from './resposta-textos';
import { type PedidoApresentado, recusaDe } from './textos';

// O pedido sobre um comentário do Instagram ou da Página em Aprovações (mockups/prototipo-comentarios.html, P38
// aprovado em 07/11/2026; A6, Z11, parte 3a): responder (a resposta pronta do elogio e da marcação, ou a sugestão do
// Social media), ocultar (o golpe e o ofensivo), apagar a resposta e mostrar de novo. O servidor manda, em `comment`, o
// comentário como o Liame o guarda agora (o texto, o @ ou o nome, o tipo, se está oculto, a resposta da marca), o post
// e o texto da resposta de que o pedido trata. O pedido não guarda o texto do comentário. Aqui isso vira o título, a
// frase do que acontece, a situação do pedido e o resultado. A resposta é pública e sai em nome da marca.

type Acao = ActionResponse;
export type AcaoDeComentario = Acao & { comment: NonNullable<Acao['comment']> };

/** A resposta automática (A6, Z11, parte 2e; D-A6-92): saiu sozinha, pelo atendimento automático da marca. */
const FERRAMENTA_DA_RESPOSTA_AUTOMATICA = 'comentario_responder_auto';
const FERRAMENTAS_DO_COMENTARIO = ['comentario_responder', FERRAMENTA_DA_RESPOSTA_AUTOMATICA, 'comentario_ocultar', 'comentario_apagar_resposta', 'comentario_mostrar'];

/** O pedido é sobre um comentário (responder, ocultar, apagar a resposta, mostrar)? */
export function ehPedidoDeComentario(a: Acao): a is AcaoDeComentario {
  return Boolean(a.comment) && FERRAMENTAS_DO_COMENTARIO.includes(a.tool);
}

/** A resposta que o atendimento automático publicou sozinho, sem pedido de aprovação (parte 2e). */
export function ehRespostaAutomatica(a: Acao): boolean {
  return a.tool === FERRAMENTA_DA_RESPOSTA_AUTOMATICA;
}

/** O que o pedido faz com o comentário. */
export type OperacaoDoComentario = 'responder' | 'ocultar' | 'apagar_resposta' | 'mostrar';
export function operacaoDo(a: AcaoDeComentario): OperacaoDoComentario {
  const o = a.comment.operation;
  return o === 'ocultar' || o === 'apagar_resposta' || o === 'mostrar' ? o : 'responder';
}

export const ROTULO_DO_CANAL: Record<string, string> = { instagram: 'Instagram', facebook: 'Facebook' };
/** Onde o comentário está, na frase: "no Instagram", "na Página do Facebook". */
export const ondeDo = (canal: string): string => (canal === 'facebook' ? 'na Página do Facebook' : 'no Instagram');
/** Os tipos do comentário (D-A6-87), como o P38 os escreve. */
export const ROTULO_DO_TIPO: Record<string, string> = {
  pergunta: 'Pergunta',
  reclamacao: 'Reclamação',
  elogio: 'Elogio',
  marcacao: 'Marcação de amigo',
  ofensivo: 'Ofensivo',
  golpe: 'Golpe',
};

/** A linha do item que espera na lista (P38): "Instagram · Pergunta"; sem o tipo, só o canal. */
export function canalETipoDaLista(a: AcaoDeComentario): string {
  const canal = ROTULO_DO_CANAL[a.comment.channel] ?? 'Comentário';
  const tipo = a.comment.current?.kind ? ROTULO_DO_TIPO[a.comment.current.kind] : null;
  return tipo ? `${canal} · ${tipo}` : canal;
}

/** Quem comentou, como a rede mostra: no Instagram, o @; na Página, o nome. Nulo quando a rede não mandou. */
export function autorDo(a: AcaoDeComentario): string | null {
  const autor = a.comment.current?.author?.trim();
  if (!autor) return null;
  return a.comment.channel === 'instagram' && !autor.startsWith('@') ? `@${autor}` : autor;
}

/** "Responder ao comentário de @duda.come.bem"; sem quem comentou, "Responder a um comentário no Instagram". */
export function tituloDoComentario(a: AcaoDeComentario): string {
  const autor = autorDo(a);
  const onde = ondeDo(a.comment.channel);
  switch (operacaoDo(a)) {
    case 'ocultar':
      return autor ? `Ocultar o comentário de ${autor}` : `Ocultar um comentário ${onde}`;
    case 'apagar_resposta':
      return autor ? `Apagar a resposta ao comentário de ${autor}` : `Apagar a resposta a um comentário ${onde}`;
    case 'mostrar':
      return autor ? `Mostrar de novo o comentário de ${autor}` : `Mostrar de novo um comentário ${onde}`;
    default:
      if (ehRespostaAutomatica(a)) return autor ? `Resposta automática ao comentário de ${autor}` : `Resposta automática a um comentário ${onde}`;
      return autor ? `Responder ao comentário de ${autor}` : `Responder a um comentário ${onde}`;
  }
}

/** Onde o pedido está. A retirada pelo Social media diz o porquê (A6, Z11, parte 2d-5). */
export type SituacaoDoComentario =
  | 'pendente'
  | 'saindo'
  | 'feito'
  | 'recusado'
  | 'retirado'
  | 'cancelado'
  | 'expirado'
  | 'mudou'
  | 'falhou';

export function situacaoDoComentario(a: AcaoDeComentario): SituacaoDoComentario {
  if (a.status === 'aguardando_aprovacao') return 'pendente';
  if (recusaDe(a)) return 'recusado';
  if (a.status === 'cancelada') return a.comment.withdrawn ? 'retirado' : 'cancelado';
  if (a.status === 'expirada') return 'expirado';
  if (a.status === 'falhou') return a.execution?.status === 'estado_mudou' ? 'mudou' : 'falhou';
  if (a.status === 'executada') return 'feito';
  return 'saindo';
}

/** O que aconteceu na rede, quando o pedido saiu: "Respondido", "Oculto", "Resposta apagada", "À vista de novo". */
const FEITO: Record<OperacaoDoComentario, string> = { responder: 'Respondido', ocultar: 'Oculto', apagar_resposta: 'Resposta apagada', mostrar: 'À vista de novo' };
const SAINDO: Record<OperacaoDoComentario, string> = { responder: 'Saindo', ocultar: 'Ocultando', apagar_resposta: 'Apagando', mostrar: 'Mostrando' };

/** O porquê da retirada, na lista e no detalhe. */
const RETIRADA: Record<string, string> = {
  respondido_na_rede: 'Respondido na rede',
  oculto_na_rede: 'Oculto na rede',
  ja_oculto: 'Já estava oculto',
  comentario_mudou: 'O comentário mudou',
  comentario_sumiu: 'O comentário foi apagado',
  // Ao ligar o atendimento automático (parte 2e-1b), o pedido virou a resposta automática.
  atendimento_automatico: 'Respondido sozinho',
};

/** A segunda linha do item decidido na lista. */
export function etiquetaDoComentario(a: AcaoDeComentario): string {
  const s = situacaoDoComentario(a);
  const op = operacaoDo(a);
  const rotulo: Record<SituacaoDoComentario, string> = {
    pendente: 'Espera aprovação',
    saindo: SAINDO[op],
    feito: ehRespostaAutomatica(a) ? 'Respondido sozinho' : FEITO[op],
    recusado: 'Recusado',
    retirado: RETIRADA[a.comment.withdrawn ?? ''] ?? 'Retirado',
    cancelado: 'Cancelado',
    expirado: 'Expirou',
    mudou: 'O comentário mudou',
    falhou: 'Não saiu',
  };
  return rotulo[s];
}

/** Os motivos prontos da recusa (P38): os da resposta e os de ocultar. */
export const MOTIVOS_DO_COMENTARIO = ['Quero outro texto', 'Prefiro não responder', 'Vou responder no app'];
export const MOTIVOS_DE_OCULTAR = ['Não é golpe', 'Prefiro deixar à vista', 'Vou cuidar no app'];

/** O que a pessoa lê sobre o comentário a ocultar: o porquê do Social media pelo tipo, ou a escolha de uma pessoa. */
export function porQueOcultar(a: AcaoDeComentario): string {
  if (!quemPediu(a).funcionario) return 'Escolhido no lugar de responder.';
  const tipo = a.comment.current?.kind ?? null;
  if (tipo === 'golpe') return 'Tem cara de golpe: oferta de seguidores, dinheiro fácil, sorteio ou um link de fora da loja.';
  if (tipo === 'ofensivo') return 'É ofensivo: ataca alguém sem contar um problema com a loja.';
  return 'O Social media sugere ocultar este comentário.';
}

/** Quantas sugestões, por extenso, na frase (de duas a seis: três da reclamação e mais três do "Pedir outra"). */
const POR_EXTENSO: Record<number, string> = { 2: 'duas', 3: 'três', 4: 'quatro', 5: 'cinco', 6: 'seis' };

/** A palavra do tipo na frase: "a pergunta", "a reclamação", "o comentário". */
const doTipo = (tipo: string | null): string => (tipo === 'pergunta' ? 'a pergunta' : tipo === 'reclamacao' ? 'a reclamação' : 'o comentário');

/**
 * A frase do modo Lite, em pedaços (o que vai em negrito): "O Social media propõe uma resposta para a pergunta que
 * @ana.paula deixou no Instagram. Ela é pública e sai em nome da marca. Se você aprovar, o Liame responde no Instagram."
 * Quem lê e não pode aprovar não lê a última frase. Com mais de uma sugestão do Social media (a reclamação, ou depois
 * do "Pedir outra"; parte 3c), a frase diz quantas, e só quem pode escolher lê o convite (como nas avaliações, V128).
 */
export function fraseDoComentario(a: AcaoDeComentario, opcoes: { euPedi: boolean; possoAprovar: boolean; possoMexer?: boolean }): Pedaco[] {
  const quem = quemPediu(a);
  const autor = autorDo(a);
  const onde = ondeDo(a.comment.channel);
  const deQuem = autor ? ` que ${autor} deixou` : ' deixado';
  const sugestoes = a.comment.suggestions?.length ?? 0;
  if (operacaoDo(a) === 'responder' && quem.funcionario && sugestoes > 1) {
    return [
      { t: `${quem.nome} escreveu ${POR_EXTENSO[sugestoes] ?? String(sugestoes)} sugestões de resposta para ${doTipo(a.comment.current?.kind ?? null)}${deQuem} ${onde}.` },
      { t: opcoes.possoMexer ? ' Escolha a que preferir e ajuste se quiser: a resposta é ' : ' A resposta é ' },
      { t: 'pública', b: true },
      { t: ' e sai em nome da marca.' },
      ...(opcoes.possoAprovar ? [{ t: ` Se você aprovar, o Liame responde ${onde} com a escolhida.` }] : []),
    ];
  }
  if (operacaoDo(a) === 'ocultar') {
    const sujeito = quem.funcionario ? `${quem.nome} sugere` : opcoes.euPedi ? 'Você pediu para' : `${quem.nome} pediu para`;
    return [
      { t: `${sujeito} ocultar o comentário${deQuem} ${onde}.` },
      { t: ' Os outros deixam de ver o comentário; dá para mostrar de novo.' },
      ...(opcoes.possoAprovar ? [{ t: ` Se você aprovar, o Liame oculta o comentário ${onde}.` }] : []),
    ];
  }
  const sujeito = quem.funcionario ? `${quem.nome} propõe` : opcoes.euPedi ? 'Você escreveu' : `${quem.nome} escreveu`;
  return [
    { t: `${sujeito} uma resposta para ${doTipo(a.comment.current?.kind ?? null)}${deQuem} ${onde}. Ela é ` },
    { t: 'pública', b: true },
    { t: ' e sai em nome da marca.' },
    ...(opcoes.possoAprovar ? [{ t: ` Se você aprovar, o Liame responde ${onde}.` }] : []),
  ];
}

/** O pedido em palavras, para a lista e os avisos. */
export function comentarioApresentado(a: AcaoDeComentario): PedidoApresentado {
  const op = operacaoDo(a);
  const onde = ondeDo(a.comment.channel);
  return {
    titulo: tituloDoComentario(a),
    resumo: op === 'ocultar' ? `O comentário fica oculto ${onde}.` : op === 'responder' ? `Resposta pública a um comentário ${onde}, em nome da marca.` : `O pedido muda o comentário ${onde}.`,
    impacto: null,
    mudancas: [],
    desfazer: op === 'ocultar' ? 'Dá para mostrar o comentário de novo, também com o código do app.' : 'Depois de publicada, dá para apagar a resposta que o Liame publicou.',
    depoisDeAprovar: op === 'ocultar' ? `O Liame oculta o comentário ${onde} em instantes.` : `O Liame responde ${onde} em instantes.`,
  };
}

export interface ResultadoDoComentario {
  tom: 'ok' | 'espera' | 'falha' | 'neutro';
  icone: NomeIcone;
  forte: string | null;
  texto: string;
}

function aprovadoPor(a: Acao): string {
  const aprovacao = [...a.approvals].reverse().find((x) => x.current_plan && x.sufficient) ?? a.approvals.at(-1) ?? null;
  return aprovacao ? `Aprovado por ${aprovacao.approver_name} às ${horaDe(aprovacao.created_at)}.` : 'Aprovado.';
}

/** O que aconteceu com o pedido decidido, no detalhe. */
export function resultadoDoComentario(a: AcaoDeComentario): ResultadoDoComentario {
  const s = situacaoDoComentario(a);
  const op = operacaoDo(a);
  const onde = ondeDo(a.comment.channel);
  const recusa = recusaDe(a);
  // A resposta automática (parte 2e): ninguém aprovou; ela sai pelo atendimento automático que a marca ligou.
  if (ehRespostaAutomatica(a)) {
    if (s === 'saindo') return { tom: 'espera', icone: 'clock', forte: 'Pelo atendimento automático da marca.', texto: ` A resposta está saindo ${onde}.` };
    if (s === 'feito') return { tom: 'ok', icone: 'check', forte: `Respondido sozinho ${onde}, pelo atendimento automático, em nome da marca.`, texto: a.comment.channel === 'instagram' ? ' O Instagram avisa quem comentou.' : '' };
    if (s === 'falhou' && a.status_reason?.startsWith('atendimento automático')) {
      return { tom: 'falha', icone: 'alert', forte: 'O atendimento automático segurou esta resposta.', texto: ' Ele foi desligado, ou o tipo saiu da lista, antes de ela sair: nada foi publicado.' };
    }
    if (s === 'falhou') return { tom: 'falha', icone: 'alert', forte: 'A resposta automática não saiu.', texto: ` ${a.status_reason ?? 'A execução falhou.'}` };
  }
  switch (s) {
    case 'recusado':
      return { tom: 'falha', icone: 'x', forte: null, texto: recusa?.motivo ? `Recusado por ${recusa.quem}: “${recusa.motivo}”. Nada foi feito.` : `Recusado por ${recusa?.quem ?? 'quem aprova'}. Nada foi feito.` };
    case 'retirado': {
      const porque: Record<string, string> = {
        respondido_na_rede: `O comentário já tem resposta da marca, dada direto ${onde}.`,
        oculto_na_rede: `O comentário foi ocultado direto ${onde}.`,
        ja_oculto: `O comentário já estava oculto ${onde}.`,
        comentario_mudou: 'Quem comentou editou o comentário depois da sugestão.',
        comentario_sumiu: `O comentário foi apagado ${onde}.`,
      };
      // Ao ligar o atendimento automático (parte 2e-1b): este pedido virou a resposta automática, que saiu sozinha.
      if (a.comment.withdrawn === 'atendimento_automatico') {
        return { tom: 'ok', icone: 'check', forte: 'Respondido sozinho pelo atendimento automático.', texto: ' Ele foi ligado com este pedido esperando, e a mesma resposta saiu sem aprovação, com o aviso de resposta automática.' };
      }
      return { tom: 'neutro', icone: 'info', forte: porque[a.comment.withdrawn ?? ''] ?? 'O comentário mudou depois da sugestão.', texto: ' O Social media tirou o pedido daqui, e nada foi feito pelo Liame.' };
    }
    case 'cancelado':
      return { tom: 'falha', icone: 'x', forte: null, texto: 'Cancelado por quem pediu. Nada foi feito.' };
    case 'expirado':
      return { tom: 'falha', icone: 'x', forte: null, texto: 'Expirou sem aprovação: nada foi feito.' };
    case 'saindo':
      return { tom: 'espera', icone: 'clock', forte: aprovadoPor(a), texto: op === 'ocultar' ? ` O Liame está ocultando o comentário ${onde}.` : ` A resposta está saindo ${onde}.` };
    case 'feito':
      return op === 'ocultar'
        ? { tom: 'ok', icone: 'eye-off', forte: `Oculto ${onde}.`, texto: ' Os outros não veem mais o comentário. Dá para mostrar de novo, também com o código do app.' }
        : op === 'responder'
          ? { tom: 'ok', icone: 'check', forte: `Respondido ${onde}, em nome da marca.`, texto: ` ${aprovadoPor(a)} ${a.comment.channel === 'instagram' ? 'O Instagram avisa quem comentou.' : ''}`.trimEnd() }
          : { tom: 'neutro', icone: 'undo', forte: op === 'mostrar' ? `O comentário está à vista de novo ${onde}.` : 'A resposta saiu do comentário.', texto: '' };
    case 'mudou':
      return { tom: 'falha', icone: 'alert', forte: 'O comentário mudou depois deste pedido.', texto: ' Ele foi editado, apagado, ocultado ou respondido por outro caminho. Nada foi feito: o pedido era para o comentário de antes.' };
    default:
      return { tom: 'falha', icone: 'alert', forte: null, texto: `${aprovadoPor(a)} Mas o pedido não saiu: ${a.status_reason ?? 'a execução falhou'}.`.replace('..', '.') };
  }
}

/** O texto que a pessoa digitou serve para salvar? (O limite é o do servidor: 1.000 caracteres.) */
export const TAMANHO_DA_RESPOSTA_AO_COMENTARIO = 1000;
export function textoDoComentarioValido(texto: string): string | null {
  const t = texto.trim();
  if (!t) return 'Escreva a resposta antes de salvar.';
  if ([...t].length > TAMANHO_DA_RESPOSTA_AO_COMENTARIO) return `A resposta passa de ${TAMANHO_DA_RESPOSTA_AO_COMENTARIO.toLocaleString('pt-BR')} caracteres.`;
  return null;
}
