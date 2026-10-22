import type { ActionReviewSuggestion } from '@liame/contracts';
import {
  type AcaoDeResposta,
  emNomeDa,
  estrelasDoPedido,
  estrelasEscritas,
  type Pedaco,
  type ResultadoDaResposta,
  resultadoDaResposta,
  situacaoDaResposta,
  TAMANHO_DA_RESPOSTA,
} from './resposta-textos';
import { recusaDe } from './textos';

// As sugestões de resposta do Social media em Aprovações (mockups/prototipo-respostas-sugeridas.html, P31 aprovado em
// 21/10/2026; A6 · Z6, parte 3c). O pedido dele traz, em `review.suggestions`, as sugestões que passaram pela
// conferência (as da segunda rodada antes das da primeira), e o texto do pedido (`reply_text`) é o escolhido: escolher
// outra sugestão é alterar o texto do pedido (o plano é outro, e a aprovação vale para ele). O texto que não é nenhuma
// das sugestões é a versão ajustada por uma pessoa: a mesma regra do servidor (`trocarSugestoesPeloFuncionario`).

/** O pedido do Social media, que nasceu das sugestões (o de uma pessoa não traz `suggestions`). */
export function ehDoSocialMedia(a: AcaoDeResposta): boolean {
  return a.agent_key === 'social' && Boolean(a.review.suggestions?.length);
}

/** Uma opção da escolha, com o rótulo da tela: a versão ajustada ou uma sugestão. */
export type Opcao = { chave: string; rotulo: string; texto: string };

export type Escolha = {
  /** A versão ajustada (o texto do pedido não é nenhuma das sugestões), que vem primeiro. */
  ajustada: Opcao | null;
  /** As da rodada mais nova: as da avaliação nova ou, depois do "Pedir outras", as outras. */
  novas: Opcao[];
  /** As da primeira rodada, quando as outras já vieram. */
  daPrimeira: Opcao[];
  /** A chave da opção que é o texto do pedido agora. */
  escolhida: string | null;
  /** Quantas opções há, contando a versão ajustada. */
  total: number;
};

export const CHAVE_DA_AJUSTADA = 'ajustada';

/**
 * As opções na ordem da tela (P31): a versão ajustada, as sugestões novas e as da primeira rodada. As sugestões são
 * numeradas nessa ordem ("Sugestão 1 · Curta"); a ajustada não tem número.
 */
export function escolhaDoPedido(a: AcaoDeResposta): Escolha {
  const todas = a.review.suggestions ?? [];
  const segunda = todas.some((s) => s.round === 2);
  const texto = a.review.reply_text ?? '';
  let n = 0;
  const opcao = (s: ActionReviewSuggestion): Opcao => {
    n += 1;
    return { chave: `sugestao-${n}`, rotulo: `Sugestão ${n} · ${s.focus}`, texto: s.text };
  };
  const novas = todas.filter((s) => s.round === (segunda ? 2 : 1)).map(opcao);
  const daPrimeira = segunda ? todas.filter((s) => s.round === 1).map(opcao) : [];
  const ajustada = texto !== '' && !todas.some((s) => s.text === texto) ? { chave: CHAVE_DA_AJUSTADA, rotulo: 'A versão ajustada · escrita por uma pessoa', texto } : null;
  const escolhida = ajustada ? ajustada.chave : ([...novas, ...daPrimeira].find((o) => o.texto === texto)?.chave ?? null);
  return { ajustada, novas, daPrimeira, escolhida, total: novas.length + daPrimeira.length + (ajustada ? 1 : 0) };
}

/** "120 de 1.500 caracteres", contados como a pessoa os vê. */
export const contaDeCaracteres = (t: string): string => `${[...t].length.toLocaleString('pt-BR')} de ${TAMANHO_DA_RESPOSTA.toLocaleString('pt-BR')} caracteres`;

/**
 * Até quando a tela espera as outras sugestões com as primeiras guardadas. A rotina olha a fila de 15 em 15 segundos,
 * com o "Pedir outras" primeiro, e o modelo escreve em segundos; passado isso, uma tentativa falhou (a próxima vem em 15
 * minutos) ou a IA está no limite do dia (a vez volta em uma hora). A tela então volta às primeiras, para a pessoa
 * decidir com elas, e as outras entram quando chegarem.
 */
export const ESPERA_DAS_OUTRAS_MS = 2 * 60_000;

/**
 * O "Pedir outras" na tela, pelo que o servidor diz (`review.more_suggestions`): dá para pedir, ele está escrevendo,
 * está demorando (passou da espera), as outras vieram ou não deu. Nulo quando não há o que mostrar, e também num código
 * que a tela ainda não conhece (a lista pode crescer).
 */
export type OutrasNaTela = 'pode_pedir' | 'escrevendo' | 'demorando' | 'feitas' | 'nao_deu' | null;

export function outrasNaTela(a: AcaoDeResposta, agora: Date): OutrasNaTela {
  const situacao = a.review.more_suggestions ?? null;
  if (situacao === 'escrevendo') {
    const desde = a.review.more_suggestions_asked_at ? new Date(a.review.more_suggestions_asked_at).getTime() : Number.NaN;
    return !Number.isNaN(desde) && agora.getTime() - desde >= ESPERA_DAS_OUTRAS_MS ? 'demorando' : 'escrevendo';
  }
  return situacao === 'pode_pedir' || situacao === 'feitas' || situacao === 'nao_deu' ? situacao : null;
}

/** Os motivos prontos da recusa (P31). */
export const MOTIVOS_DAS_SUGESTOES = ['Nenhuma serve', 'Prefiro não responder', 'Vou responder por conta própria'];

/**
 * A frase do modo Lite, em pedaços (P31): "O Social media escreveu duas sugestões de resposta para a avaliação de 5
 * estrelas que Marina S. deixou. Escolha a que preferir, ajuste se quiser e aprove: a resposta é pública e sai em nome
 * da loja “Centro”." Quem não escolhe nem aprova não lê o convite (V128); quem só aprova lê o que acontece se aprovar.
 */
export function fraseDasSugestoes(a: AcaoDeResposta, nome: string | null, o: { possoMexer: boolean; possoAprovar: boolean }): Pedaco[] {
  const umaSo = escolhaDoPedido(a).novas.length === 1;
  const n = estrelasDoPedido(a);
  const qual: Pedaco[] = n ? [{ t: 'a avaliação de ' }, { t: estrelasEscritas(n), b: true }, { t: nome ? ` que ${nome} deixou.` : '.' }] : [{ t: 'uma avaliação do Google.' }];
  const publica: Pedaco[] = [{ t: 'pública', b: true }, { t: ` e sai ${emNomeDa(a)}.` }];
  let fim: Pedaco[];
  if (o.possoMexer && o.possoAprovar) fim = [{ t: ` ${umaSo ? 'Leia' : 'Escolha a que preferir'}, ajuste se quiser e aprove: a resposta é ` }, ...publica];
  else if (o.possoMexer) fim = [{ t: ` ${umaSo ? 'Leia e ajuste se quiser' : 'Escolha a que preferir e ajuste se quiser'}: a resposta é ` }, ...publica];
  else fim = [{ t: ' A resposta é ' }, ...publica, ...(o.possoAprovar ? [{ t: ' Se você aprovar, o Liame publica no Google o texto escolhido.' }] : [])];
  return [{ t: `O Social media escreveu ${umaSo ? 'uma sugestão' : 'duas sugestões'} de resposta para ` }, ...qual, ...fim];
}

/**
 * O resultado do pedido do Social media decidido sem publicar (P31): recusado por uma pessoa, ou tirado de Aprovações
 * por ele (a avaliação mudou, ou foi respondida direto no Google). Nulo nos outros: esses têm o resultado da resposta
 * (P17), como o pedido de uma pessoa.
 */
export function resultadoDasSugestoes(a: AcaoDeResposta, agora: Date): ResultadoDaResposta | null {
  const s = situacaoDaResposta(a);
  if (s === 'retirada-mudou' || s === 'retirada-respondida') return resultadoDaResposta(a, null, false, agora);
  if (s === 'recusada') {
    const recusa = recusaDe(a);
    const quem = recusa?.quem ?? 'quem aprova';
    return {
      tom: 'falha',
      icone: 'x',
      forte: null,
      texto: `${recusa?.motivo ? `Recusada por ${quem}: “${recusa.motivo}”.` : `Recusada por ${quem}.`} Nada foi publicado. A avaliação segue sem resposta, e o Social media não escreve outras para ela.`,
    };
  }
  return null;
}
