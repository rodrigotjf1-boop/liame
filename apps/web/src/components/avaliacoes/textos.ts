import type { ReviewAuthorsResponse, ReviewItem, ReviewsResponse, ReviewStore } from '@liame/contracts';
import type { NomeIcone } from '@/components/ui/icone';
import { dia, diasAte, inteiro, quandoComHora } from '@/lib/formato';

// Textos e contas da tela "Avaliações" (mockups/prototipo-avaliacoes.html, P17 aprovado em 09/10/2026; Z1 da A6).
// A lista e o resumo vêm de `GET /v1/reviews` (o que o Liame guardou); o nome de quem avaliou vem de
// `GET /v1/reviews/authors`, lido do Google na hora, e pode faltar. Com a resposta pelo Liame ligada para a marca
// (`can_reply`, Z2), quem pode pedir ações ganha "Responder", que abre o rascunho em Aprovações; a resposta que já
// espera a aprovação ganha o selo ("Resposta espera você" para quem aprova) e o caminho até ela.

const umaCasa = new Intl.NumberFormat('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 });

/** A nota com uma casa: "4,6". */
export function nota(n: number): string {
  return umaCasa.format(n);
}

const plural = (n: number, um: string, varios: string) => `${inteiro(n)} ${n === 1 ? um : varios}`;

/** Há quanto tempo, em dias de calendário: "hoje", "ontem", "há 4 dias" e, passado um mês, a data ("23/09"). */
export function haQuanto(iso: string, agora: Date): string {
  const dias = -diasAte(iso, agora);
  if (dias <= 0) return 'hoje';
  if (dias === 1) return 'ontem';
  if (dias <= 30) return `há ${dias} dias`;
  return dia(iso, agora);
}

/** A frase da caixa "Sem resposta": "a mais antiga é de 4 dias atrás". */
function daMaisAntiga(iso: string, agora: Date): string {
  const dias = -diasAte(iso, agora);
  if (dias <= 0) return 'a mais antiga é de hoje';
  if (dias === 1) return 'a mais antiga é de ontem';
  if (dias <= 30) return `a mais antiga é de ${dias} dias atrás`;
  return `a mais antiga é de ${dia(iso, agora)}`;
}

export type Selo = { classe: 'aguardando' | 'espera' | 'concluido' | 'perigo' | 'info'; rotulo: string };

/**
 * A resposta que espera a aprovação, em Aprovações (P17): "espera você" só para quem aprova esta resposta; a de 1 ou 2
 * estrelas só o dono aprova (D-A6-4).
 */
export function seloDaRespostaQueEspera(quemAprova: 'voce' | 'dono' | 'outra_pessoa'): Selo {
  const rotulo = quemAprova === 'voce' ? 'Resposta espera você' : quemAprova === 'dono' ? 'Resposta espera o dono' : 'Resposta espera aprovação';
  return { classe: 'info', rotulo };
}

/** A situação da resposta da empresa, como o Google a tem. Resposta com situação que o Google não informa conta como respondida. */
export function situacaoDaResposta(reply: ReviewItem['reply']): Selo {
  if (!reply) return { classe: 'aguardando', rotulo: 'Sem resposta' };
  if (reply.state === 'recusada') return { classe: 'perigo', rotulo: 'O Google recusou a resposta' };
  if (reply.state === 'pendente') return { classe: 'espera', rotulo: 'O Google está conferindo' };
  return { classe: 'concluido', rotulo: 'Respondida' };
}

export interface Aviso {
  chave: string;
  tipo: 'perigo' | 'atencao';
  icone: NomeIcone;
  titulo: string;
  texto: string;
  /** O que resolve está em Contas conectadas. */
  contas: boolean;
}

export interface Caixa {
  id: string;
  rotulo: string;
  valor: string;
  sub: string;
}

export interface ItemDaLista {
  id: string;
  estrelas: number;
  /** "Marina S. · há 4 dias": quem avaliou (quando o Google informou agora), quando e, com mais de uma loja, em qual. */
  sob: string;
  /** Nulo quando a pessoa só deu a nota. */
  texto: string | null;
  selo: Selo;
  /** "Responder" (abre o rascunho em Aprovações) ou "Ver a resposta" (a que espera a aprovação); nulo sem ação. */
  acao: { tipo: 'responder' | 'ver'; href: string } | null;
}

/** A faixa das respostas que esperam a aprovação: o que diz e para onde leva. */
export interface Esperando {
  titulo: string;
  texto: string;
  botao: string;
  href: string;
}

export type TelaDasAvaliacoes =
  | { tipo: 'desligada' }
  | { tipo: 'sem_perfil' }
  | { tipo: 'sem_permissao' }
  | { tipo: 'esperando_google' }
  /** O servidor mandou uma situação que esta tela ainda não conhece. */
  | { tipo: 'outra' }
  /** Há loja ligada, e a primeira leitura das avaliações ainda não terminou. */
  | { tipo: 'primeira_leitura'; avisos: Aviso[] }
  /** O Google não tem avaliação nenhuma da empresa. */
  | { tipo: 'vazia'; lido: string | null; avisos: Aviso[] }
  | { tipo: 'lista'; lido: string | null; avisos: Aviso[]; caixas: Caixa[]; tudoRespondido: boolean; esperando: Esperando | null; itens: ItemDaLista[]; notas: string[] };

/** Os nomes lidos do Google: a resposta da rota, `falhou` (a rota não respondeu) ou nulo (ainda não chegou). */
export type Autores = ReviewAuthorsResponse | 'falhou' | null;

/** O que impede a leitura de uma loja, nas mesmas palavras do aviso da Atenção. */
function avisoDaLoja(l: ReviewStore): Aviso | null {
  const ultima = l.read_at ? ' O que está aqui é da última leitura.' : '';
  if (l.status === 'desconectada') {
    return { chave: `${l.id}:desconectada`, tipo: 'perigo', icone: 'plug', titulo: `${l.name} está desconectada`, texto: `O Google recusou a autorização desta loja. Conecte o Google de novo em Contas conectadas: as avaliações voltam a ser lidas.${ultima}`, contas: true };
  }
  if (l.status === 'sem_permissao') {
    return { chave: `${l.id}:sem_permissao`, tipo: 'atencao', icone: 'lock', titulo: `Sem permissão para ler ${l.name}`, texto: `Autorize o Google de novo em Contas conectadas, com a conta que cuida do perfil.${ultima}`, contas: true };
  }
  if (l.status === 'erro') {
    return { chave: `${l.id}:erro`, tipo: 'atencao', icone: 'alert', titulo: `A leitura de ${l.name} está falhando`, texto: `Nada a fazer por enquanto: o Liame tenta de novo sozinho.${ultima}`, contas: false };
  }
  return null;
}

/** "Lido do Google hoje, 14:10": a leitura mais antiga entre as lojas já lidas (com várias, a tela não promete mais do que tem). */
function lidoDoGoogle(lojas: ReviewStore[], agora: Date): string | null {
  const lidas = lojas.flatMap((l) => (l.read_at ? [l.read_at] : [])).sort();
  return lidas[0] ? `Lido do Google ${quandoComHora(lidas[0], agora)}` : null;
}

function notaDosNomes(autores: Autores): string {
  const naoGuarda = 'o Liame não guarda o nome nem a foto';
  if (autores === 'falhou' || (autores && autores.status === 'indisponivel')) {
    return `O Google não respondeu agora, e por isso o nome de quem avaliou não aparece. O nome é lido do Google na hora, só para esta tela: ${naoGuarda}.`;
  }
  if (autores && autores.status === 'parcial') {
    return `O Google não respondeu para todas as lojas, e parte das avaliações está sem o nome de quem avaliou. O nome é lido do Google na hora, só para esta tela: ${naoGuarda}.`;
  }
  return `O nome de quem avaliou é lido do Google na hora, só para esta tela: ${naoGuarda}. Avaliação sem nome: quem avaliou não se identificou, ou o Google não informou o nome agora.`;
}

/**
 * O que a tela mostra para a resposta do servidor. `autores` chega depois da lista, e a lista aparece sem esperar por
 * ele. `podePedir`: quem vê pode pedir ações (`campanhas.operar`); com a resposta pelo Liame ligada para a marca, é
 * quem ganha "Responder". `podeAprovar` (`acoes.aprovar`) e `souDono` decidem se a resposta que espera espera por quem vê.
 */
export function telaDasAvaliacoes(
  r: ReviewsResponse,
  agora: Date,
  autores: Autores = null,
  opcoes: { podePedir?: boolean; podeAprovar?: boolean; souDono?: boolean } = {},
): TelaDasAvaliacoes {
  if (r.state === 'desligada' || r.state === 'sem_perfil' || r.state === 'sem_permissao' || r.state === 'esperando_google') return { tipo: r.state };
  if (r.state !== 'pronta' || !r.summary) return { tipo: 'outra' };

  const avisos = r.stores.flatMap((l) => avisoDaLoja(l) ?? []);
  const lido = lidoDoGoogle(r.stores, agora);
  const s = r.summary;
  if (!r.reviews.length && !lido) return { tipo: 'primeira_leitura', avisos };
  if (!r.reviews.length && !s.review_count) return { tipo: 'vazia', lido, avisos };

  const caixas: Caixa[] = [
    {
      id: 'av-nota',
      rotulo: 'Nota no Google',
      valor: s.rating === null ? 'Sem nota ainda' : `${nota(s.rating)} de 5`,
      sub: s.review_count === null ? 'o Google ainda não informou o total de avaliações' : `${plural(s.review_count, 'avaliação', 'avaliações')} ao todo`,
    },
    {
      id: 'av-sem',
      rotulo: 'Sem resposta',
      valor: inteiro(s.unanswered),
      sub: s.unanswered && s.oldest_unanswered_at ? daMaisAntiga(s.oldest_unanswered_at, agora) : 'todas as avaliações dos últimos 12 meses têm resposta',
    },
    {
      id: 'av-recentes',
      rotulo: 'Nos últimos 30 dias',
      valor: s.last_30_days.count ? plural(s.last_30_days.count, 'avaliação', 'avaliações') : 'Nenhuma avaliação',
      sub: s.last_30_days.average === null ? 'ninguém avaliou neste período' : `nota média de ${nota(s.last_30_days.average)}`,
    },
  ];

  const nomes = new Map(autores && autores !== 'falhou' ? autores.items.map((a) => [a.review_id, a.name] as const) : []);
  const lojas = new Map(r.stores.map((l) => [l.id, l.name] as const));
  const variasLojas = r.stores.length > 1;
  // A resposta que espera a aprovação de cada avaliação, e quem pode escrever uma resposta pelo Liame.
  const pendentes = r.pending_replies ?? [];
  const esperandoDe = new Map(pendentes.map((p) => [p.review_id, p] as const));
  const responde = Boolean(r.can_reply) && Boolean(opcoes.podePedir);
  // A de 1 ou 2 estrelas só o dono aprova (D-A6-4); a tela não diz "a sua aprovação" a quem não aprova.
  const quemAprova = (p: { owner_only: boolean }) => (opcoes.podeAprovar && (!p.owner_only || opcoes.souDono) ? 'voce' : p.owner_only ? 'dono' : 'outra_pessoa');
  const acaoDe = (a: ReviewsResponse['reviews'][number]): ItemDaLista['acao'] => {
    const pedido = esperandoDe.get(a.id);
    if (pedido) return { tipo: 'ver', href: `/aprovacoes?pedido=${pedido.action_id}` };
    // A recusada pelo Google não aparece no perfil: ela pode ganhar outra resposta.
    if (responde && (!a.reply || a.reply.state === 'recusada')) return { tipo: 'responder', href: `/aprovacoes?responder=${a.id}&marca=${r.brand_id}` };
    return null;
  };
  const itens: ItemDaLista[] = r.reviews.map((a) => {
    const pedido = esperandoDe.get(a.id);
    return {
      id: a.id,
      estrelas: a.stars,
      sob: [nomes.get(a.id), haQuanto(a.reviewed_at, agora), variasLojas ? lojas.get(a.store_id) : undefined].filter(Boolean).join(' · '),
      texto: a.text && a.text.trim() ? a.text : null,
      selo: pedido ? seloDaRespostaQueEspera(quemAprova(pedido)) : situacaoDaResposta(a.reply),
      acao: acaoDe(a),
    };
  });
  let esperando: Esperando | null = null;
  if (pendentes.length === 1) {
    const p = pendentes[0]!;
    const avaliacao = r.reviews.find((a) => a.id === p.review_id);
    const nome = nomes.get(p.review_id);
    const quem = avaliacao ? (nome ? `${nome} deu ${plural(avaliacao.stars, 'estrela', 'estrelas')}` : `Uma avaliação de ${plural(avaliacao.stars, 'estrela', 'estrelas')}`) : null;
    const aprova = quemAprova(p);
    const [titulo, depois] =
      aprova === 'voce'
        ? ['1 resposta espera a sua aprovação', 'a resposta está pronta para você ler.']
        : aprova === 'dono'
          ? ['1 resposta espera a aprovação do dono', 'só o dono da empresa aprova a resposta.']
          : ['1 resposta espera aprovação', 'a resposta está pronta para ler.'];
    esperando = { titulo, texto: quem ? `${quem}; ${depois}` : `${depois.charAt(0).toUpperCase()}${depois.slice(1)}`, botao: 'Ver a resposta', href: `/aprovacoes?pedido=${p.action_id}` };
  } else if (pendentes.length > 1) {
    const todasSuas = pendentes.every((p) => quemAprova(p) === 'voce');
    esperando = {
      titulo: `${inteiro(pendentes.length)} respostas esperam ${todasSuas ? 'a sua aprovação' : 'aprovação'}`,
      texto: 'Estão em Aprovações, cada uma com a avaliação ao lado.',
      botao: 'Abrir Aprovações',
      href: '/aprovacoes',
    };
  }

  const notas = [
    `${notaDosNomes(autores)} O Liame não apaga avaliação; para denunciar uma avaliação indevida, o caminho é o próprio Google.`,
    'A lista e a contagem das sem resposta olham as avaliações feitas ou alteradas nos últimos 12 meses; a nota e o total são os do Google, de sempre. A resposta dada direto no perfil da empresa no Google aparece aqui em até um dia; se a avaliação tem mais de 45 dias, em até uma semana.',
  ];
  if (r.has_more) notas.push(`A lista mostra as ${inteiro(r.reviews.length)} primeiras nesta ordem. As outras continuam no perfil da empresa no Google.`);
  for (const l of r.stores) {
    if (l.waiting_until) notas.push(`O Google pediu para o Liame esperar: a próxima leitura de ${l.name} fica para depois de ${quandoComHora(l.waiting_until, agora)}.`);
  }

  return { tipo: 'lista', lido, avisos, caixas, tudoRespondido: s.unanswered === 0 && itens.length > 0 && !esperando, esperando, itens, notas };
}
