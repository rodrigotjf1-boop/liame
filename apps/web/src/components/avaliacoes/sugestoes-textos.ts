import type { ReviewSuggestionTurn, ReviewsResponse } from '@liame/contracts';
import type { NomeIcone } from '@/components/ui/icone';
import { horaDe, inteiro } from '@/lib/formato';
import type { Selo } from './textos';

// As sugestões de resposta do Social media na tela Avaliações (mockups/prototipo-respostas-sugeridas.html, P31 aprovado
// em 21/10/2026; A6 · Z6, parte 4b). O servidor manda em `suggestions` se elas estão ligadas na marca, ou por que não,
// e a vez de cada avaliação sem resposta (escrevendo, no limite de IA, barrada); a sugestão que passou é o pedido que
// espera em Aprovações, e `pending_replies` diz quantas sugestões ele traz. Aqui isso vira o selo e o porquê de cada
// avaliação e a faixa do topo. Quem lê e não decide não lê "esperando você" (V128).

/** Quem decide a resposta que espera: quem vê, o dono da empresa (a de 1 ou 2 estrelas) ou outra pessoa que aprova. */
export type QuemAprova = 'voce' | 'dono' | 'outra_pessoa';

/** O selo da avaliação cujas sugestões esperam em Aprovações: "2 sugestões esperam você", só para quem decide. */
export function seloDasSugestoes(n: number, quem: QuemAprova): Selo {
  const quantas = n === 1 ? '1 sugestão espera' : `${inteiro(n)} sugestões esperam`;
  return { classe: 'info', rotulo: `${quantas} ${quem === 'voce' ? 'você' : quem === 'dono' ? 'o dono' : 'aprovação'}` };
}

/** O que cada regra da conferência barrou, como fecho de "elas …" (plural) e "ela …" (a avaliação só com a nota). */
const REGRA_QUE_BARROU = new Map<string, readonly [string, string]>([
  ['regras_da_resposta', ['prometiam compensação, citavam um nome ou afirmavam o que a loja não confirmou', 'prometia compensação, citava um nome ou afirmava o que a loja não confirmou']],
  ['regras_da_liame', ['fugiam das regras da Liame para todo texto (como dado pessoal, link, bebida alcoólica, concorrente ou política)', 'fugia das regras da Liame para todo texto (como dado pessoal, link, bebida alcoólica, concorrente ou política)']],
  ['regras_da_marca', ['diziam o que Minha marca pede para nunca dizer', 'dizia o que Minha marca pede para nunca dizer']],
  ['numeros', ['traziam um número que não está na avaliação nem em Minha marca', 'trazia um número que não está na avaliação nem em Minha marca']],
]);

/**
 * A avaliação cuja sugestão ainda não chegou (P31): o selo e o porquê. Escrevendo, com a hora em que a rotina olha de
 * novo (a fila não promete "alguns minutos" depois de uma tentativa que falhou); no limite de IA, do dia ou do mês;
 * barrada, com as regras que barraram (o texto barrado não é guardado). `podeResponder`: quem vê escreve a resposta
 * pelo Liame, e o porquê termina no convite. Nulo num estado que a tela não conhece.
 */
export function situacaoDaVez(t: ReviewSuggestionTurn, o: { soANota: boolean; podeResponder: boolean; agora: Date }): { selo: Selo; motivo: string } | null {
  const [elas, ficam, prontas] = o.soANota ? ['ela', 'fica', 'A sugestão fica pronta'] : ['elas', 'ficam', 'As sugestões ficam prontas'];
  const desta = o.soANota ? 'a sugestão desta avaliação' : 'as sugestões desta avaliação';
  const escreva = o.podeResponder ? ' Responda escrevendo você mesmo.' : '';
  if (t.state === 'escrevendo') {
    const espera = t.next_at ? new Date(t.next_at).getTime() - o.agora.getTime() : 0;
    const quando = t.next_at && espera > 5 * 60_000 ? `depois das ${horaDe(t.next_at)}` : 'em alguns minutos';
    return { selo: { classe: 'espera', rotulo: 'O Social media está escrevendo' }, motivo: `${prontas} ${quando}${o.podeResponder ? '; quer responder antes? Escreva você mesmo.' : '.'}` };
  }
  if (t.state === 'limite_dia') return { selo: { classe: 'aguardando', rotulo: 'Sem sugestão hoje' }, motivo: `O limite de uso de IA de hoje foi atingido: ${desta} ${ficam} para amanhã.${escreva}` };
  if (t.state === 'limite_mes') return { selo: { classe: 'aguardando', rotulo: 'Sem sugestão este mês' }, motivo: `O limite de uso de IA do mês foi atingido: ${desta} ${ficam} para o mês que vem.${escreva}` };
  if (t.state === 'barrada') {
    const codigos = t.barred_by ?? [];
    if (codigos.includes('politica_da_empresa')) return { selo: { classe: 'aguardando', rotulo: 'Sem sugestão' }, motivo: `A política da empresa não deixa o Social media pedir esta resposta.${escreva}` };
    const regras = codigos.flatMap((c) => {
      const frase = REGRA_QUE_BARROU.get(c);
      return frase ? [frase[o.soANota ? 1 : 0]] : [];
    });
    return { selo: { classe: 'aguardando', rotulo: 'Sem sugestão' }, motivo: `O Compliance barrou ${desta}${regras.length ? `: ${elas} ${regras.join('; e ')}` : ''}.${escreva}` };
  }
  return null;
}

/** A faixa do topo das sugestões: o que diz e, quando há, o botão. */
export interface FaixaDasSugestoes {
  tipo: 'acao' | 'info';
  icone: NomeIcone;
  titulo: string;
  texto: string;
  botao: { rotulo: string; href: string; primario: boolean } | null;
}

/**
 * A faixa do topo (P31), uma só, nesta ordem: o Social media desligado nesta marca; as sugestões ainda não ligadas para
 * a empresa (a função ou a IA); o limite de uso de IA (o do mês antes do do dia); e as sugestões que esperam em
 * Aprovações. Nula sem nada disso, ou quando responder pelo Liame está desligado (aí nada é sugerido).
 */
export function faixaDasSugestoes(
  r: ReviewsResponse,
  o: { quemAprova: (p: { owner_only: boolean }) => QuemAprova; podeResponder: boolean; podeLigarOSocial: boolean; podeVerEquipe: boolean },
): FaixaDasSugestoes | null {
  const s = r.suggestions;
  if (!s) return null;
  const quemEscreve = o.podeResponder ? 'por você' : 'por uma pessoa';
  if (s.state === 'funcionario_desligado') {
    return {
      tipo: 'info',
      icone: 'pause',
      titulo: 'O Social media está desligado nesta marca',
      texto: `Ninguém sugere resposta agora: as respostas são escritas ${quemEscreve}, como antes. Quem desliga e liga o Social media é ${o.podeLigarOSocial ? 'você' : 'quem cuida da equipe'}, em Sua equipe.`,
      botao: o.podeVerEquipe ? { rotulo: 'Abrir Sua equipe', href: '/equipe', primario: false } : null,
    };
  }
  if (s.state === 'funcao_desligada' || s.state === 'ia_desligada') {
    return {
      tipo: 'info',
      icone: 'info',
      titulo: 'As sugestões de resposta ainda não estão ligadas para esta empresa',
      texto: `Quem liga é a Liame, a pedido do dono. Enquanto isso, a resposta é escrita ${quemEscreve}, como hoje, e nada custa.`,
      botao: null,
    };
  }
  if (s.state !== 'ligadas') return null;
  const limite = s.turns.find((t) => t.state === 'limite_mes') ?? s.turns.find((t) => t.state === 'limite_dia');
  if (limite) {
    const mes = limite.state === 'limite_mes';
    return {
      tipo: 'info',
      icone: 'clock',
      titulo: `O limite de uso de IA ${mes ? 'do mês' : 'de hoje'} foi atingido`,
      texto: `As sugestões das avaliações que chegaram depois disso ficam para ${mes ? 'o mês que vem' : 'amanhã'}.${o.podeResponder ? ' Responder escrevendo você continua, a qualquer hora.' : ''}`,
      botao: null,
    };
  }
  const doSocial = (r.pending_replies ?? []).filter((p) => p.suggestions);
  if (!doSocial.length) return null;
  const quem = doSocial.map((p) => o.quemAprova(p));
  const n = doSocial.length;
  const tem = n === 1 ? '1 avaliação tem sugestões' : `${inteiro(n)} avaliações têm sugestões`;
  const baixa = doSocial.some((p) => p.owner_only);
  const [para, texto] = quem.every((q) => q === 'voce')
    ? ['esperando você', `O Social media escreveu as sugestões; você escolhe, ajusta se quiser e aprova.${baixa ? ' A de 1 ou 2 estrelas só o dono aprova.' : ''}`]
    : quem.every((q) => q === 'dono')
      ? ['esperando o dono', 'O Social media escreveu as sugestões; a resposta a 1 ou 2 estrelas só o dono da empresa aprova.']
      : ['esperando aprovação', 'O Social media escreveu as sugestões; elas estão em Aprovações.'];
  return { tipo: 'acao', icone: 'sparkles', titulo: `${tem} de resposta ${para}`, texto, botao: { rotulo: 'Ver em Aprovações', href: `/aprovacoes?pedido=${doSocial[0]!.action_id}`, primario: true } };
}
