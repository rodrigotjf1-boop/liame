import type { PostChannelResponse, PostResponse } from '@liame/contracts';
import type { NomeIcone } from '@/components/ui/icone';
import { inteiro, reaisDeMicros } from '@/lib/formato';
import { ddmm, NOME_DO_CANAL, noFuso, somaDias } from './textos';

// O que o post trouxe, na gaveta do post da Agenda (mockups/prototipo-post-trouxe.html, A6 · P33, aprovado pelo dono em
// 01/11/2026; D-A6-53): primeiro os pedidos que vieram pelo link do post (o resultado; a mesma conta de Resultados, P32),
// depois os números de cada rede, como apoio, com a hora da leitura e o motivo quando faltam. Os números de uma rede não
// se somam aos da outra. O pedido se liga ao post só pelo código do link. Funções puras: o "agora" e o fuso entram como
// parâmetro.

const plural = (n: number, um: string, varios: string) => `${inteiro(n)} ${n === 1 ? um : varios}`;
const HORA_MS = 3_600_000;
const DIA_MS = 24 * HORA_MS;
/** O Liame lê os números uma vez por dia, por 30 dias depois de o post sair (D-A6-51). */
const DIAS_DE_LEITURA = 30;
/** As redes cujos números o Liame lê (D-A6-50). */
const LIDOS = ['instagram', 'facebook'];

/** Os números de cada rede, na ordem do desenho. */
const ROTULOS: Record<string, [keyof NonNullable<PostChannelResponse['metrics']>, string][]> = {
  instagram: [
    ['views', 'Vezes visto'],
    ['reach', 'Contas alcançadas'],
    ['likes', 'Curtidas'],
    ['comments', 'Comentários'],
    ['saves', 'Salvos'],
    ['shares', 'Compartilhamentos'],
  ],
  facebook: [
    ['views', 'Vezes visto'],
    ['reach', 'Pessoas alcançadas'],
    ['clicks', 'Cliques no post'],
    ['reactions', 'Reações'],
  ],
};

/** "hoje, às 13:02", "ontem, às 20:32", "amanhã, às 13:02" ou "em 18/10, às 19:02", no fuso. */
export function quandoDaLeitura(instante: Date, fuso: string, hoje: string): string {
  const { dia, hora } = noFuso(instante, fuso);
  const qual = dia === hoje ? 'hoje' : dia === somaDias(hoje, -1) ? 'ontem' : dia === somaDias(hoje, 1) ? 'amanhã' : `em ${ddmm(dia)}`;
  return `${qual}, às ${hora}`;
}

export type FaltaNaRede = { icone: NomeIcone; texto: string; atencao: boolean };
export type RedeDoPost = {
  canal: string;
  nome: string;
  /** "lido hoje, às 13:02", "conferido ontem, às 20:32", "última leitura em 18/10, às 19:02"; nulo antes da primeira. */
  lido: string | null;
  numeros: { rotulo: string; valor: string }[];
  falta: FaltaNaRede | null;
};
export type PedidosDoPost =
  | { tipo: 'sem-link'; texto: string }
  | { tipo: 'zero'; sub: string }
  | { tipo: 'com'; n: string; caixa: string; sub: string };
export type OQueTrouxe = {
  titulo: string;
  pacote: boolean;
  pedidos: PedidosDoPost;
  /** As redes em que o post saiu e cujos números o Liame lê; vazio no pacote. */
  redes: RedeDoPost[];
  /** No pacote: os números da rede o Liame não lê (quem publica é a pessoa). */
  semLeitura: string | null;
  /** A permissão de ler ou a conta da rede falta: "Abrir Contas conectadas". */
  conectar: boolean;
  /** O que os números são, e até quando o Liame lê; nula no pacote. */
  nota: string | null;
};

const emFrase = (partes: string[]) => (partes.length > 1 ? `${partes.slice(0, -1).join(', ')} e ${partes.at(-1)}` : (partes[0] ?? ''));

function pedidosPeloLink(post: PostResponse, pacote: boolean, saiuHoje: string | null): PedidosDoPost {
  const p = post.link_orders ?? null;
  if (!post.link || !p) {
    return { tipo: 'sem-link', texto: `${pacote ? 'Este pacote saiu' : 'Este post saiu'} sem o link do cardápio: nenhum pedido pelo link.` };
  }
  const comAnuncio = p.with_ad_orders;
  const anuncio = comAnuncio
    ? ` ${comAnuncio === 1 ? 'Outro pedido veio' : `Outros ${plural(comAnuncio, 'pedido veio', 'pedidos vieram')}`} pelo link e ${comAnuncio === 1 ? 'tem' : 'têm'} prova de anúncio: ${comAnuncio === 1 ? 'fica' : 'ficam'} com o anúncio.`
    : '';
  if (!p.orders) {
    const sub = pacote
      ? 'O link está na bio. O pedido que chegar por ele aparece aqui.'
      : `${saiuHoje ? `O post saiu hoje, às ${saiuHoje}. ` : ''}O link está no fim do texto da Página. O pedido que chegar por ele aparece aqui e em Resultados.`;
    return { tipo: 'zero', sub: `${sub}${anuncio}` };
  }
  const um = p.orders === 1;
  const onde = pacote ? 'pelo link da bio deste pacote' : 'pelo link do post na Página do Facebook';
  return {
    tipo: 'com',
    n: plural(p.orders, 'pedido', 'pedidos'),
    caixa: reaisDeMicros(p.revenue_micros),
    sub: `${um ? 'Veio' : 'Vieram'} ${onde} e ${um ? 'foi confirmado' : 'foram confirmados'} no caixa; o cancelado sai da conta. ${um ? 'Fica' : 'Ficam'} fora do retorno dos anúncios: ${pacote ? 'pacote' : 'post'} não é anúncio.${anuncio}`,
  };
}

/** A rede do post publicado: os números lidos, a hora da leitura e, quando faltam, o porquê e o que acontece. */
export function redeDoPost(c: PostChannelResponse, agora: Date, fuso: string, hoje: string): RedeDoPost {
  const nome = NOME_DO_CANAL[c.channel] ?? c.channel;
  const saiu = c.published_at ? new Date(c.published_at) : null;
  const lidoEm = c.metrics_read_at ? new Date(c.metrics_read_at) : null;
  // Depois de 30 dias, o Liame não lê mais: ficam os números da última leitura (D-A6-51).
  const ultima = saiu !== null && agora.getTime() > saiu.getTime() + DIAS_DE_LEITURA * DIA_MS;
  const proxima = lidoEm && !ultima ? quandoDaLeitura(new Date(lidoEm.getTime() + DIA_MS), fuso, hoje) : null;
  const deNovo = proxima ? ` O Liame confere de novo ${proxima}.` : '';
  const numeros = c.metrics ? (ROTULOS[c.channel] ?? []).map(([k, rotulo]) => ({ rotulo, valor: c.metrics![k] === null ? '—' : inteiro(c.metrics![k]!) })) : [];
  const st = c.metrics_status;
  const verbo = st === 'sem_conta' || ultima ? 'última leitura' : c.metrics && st === 'lido' ? 'lido' : 'conferido';
  const lido = lidoEm ? `${verbo} ${quandoDaLeitura(lidoEm, fuso, hoje)}` : null;
  let falta: FaltaNaRede | null = null;
  if (!st || !lidoEm) {
    const primeira = saiu ? new Date(saiu.getTime() + HORA_MS) : null;
    falta = {
      icone: 'clock',
      texto: primeira && primeira > agora ? `A primeira leitura é ${quandoDaLeitura(primeira, fuso, hoje)}, uma hora depois de sair; os números aparecem aqui.` : 'A primeira leitura sai uma hora depois de o post sair; os números aparecem aqui.',
      atencao: false,
    };
  } else if (st === 'sem_dados' && c.channel === 'instagram') {
    falta = { icone: 'clock', texto: `O Instagram ainda não mandou os números: ele leva até 48 horas.${deNovo}`, atencao: false };
  } else if (st === 'sem_dados') {
    // A primeira leitura da Página, no dia em que o post saiu: ela atualiza os números uma vez por dia.
    const novo = saiu !== null && lidoEm.getTime() - saiu.getTime() < 26 * HORA_MS;
    falta = novo
      ? { icone: 'clock', texto: `A Página atualiza os números uma vez por dia: eles aparecem na próxima leitura${proxima ? `, ${proxima}` : ''}.`, atencao: false }
      : { icone: 'info', texto: `A Meta não mandou números deste post da Página. Página com menos de 100 curtidas não tem números de post.${deNovo}`, atencao: false };
  } else if (st === 'sem_permissao') {
    falta = {
      icone: 'alert-circle',
      texto:
        c.channel === 'instagram'
          ? 'A autorização da Meta não deixa ler os números do Instagram. Conecte de novo e aceite a leitura dos números.'
          : 'Quem conectou a Meta não tem, na Página, a permissão de ver os números. Conecte de novo com quem administra a Página.',
      atencao: true,
    };
  } else if (st === 'sem_conta') {
    falta = { icone: 'alert-circle', texto: `A conta ${c.channel === 'facebook' ? 'da Página do Facebook' : `do ${nome}`} saiu da marca: os números param na última leitura. Conecte de novo para voltar a ler.`, atencao: true };
  }
  return { canal: c.channel, nome, lido, numeros, falta };
}

/**
 * O que entra na gaveta: só o post que já saiu (publicado, ou em parte) e o pacote que a pessoa marcou como publicado;
 * nulo nos outros. O post só no Instagram, e o que saiu sem a Página, dizem por que não há pedido pelo link (o link vai
 * no fim do texto da Página; no Instagram, a legenda não tem link que abre, D-A6-22).
 */
export function oQueOPostTrouxe(post: PostResponse, agora: Date, fuso: string): OQueTrouxe | null {
  const hoje = noFuso(agora, fuso).dia;
  const pacote = post.kind === 'pacote';
  if (pacote) {
    if (post.status !== 'pacote_publicado') return null;
    const redes = post.channels.filter((c) => c.status === 'publicado').map((c) => `do ${NOME_DO_CANAL[c.channel] ?? c.channel}`);
    return {
      titulo: 'O que este pacote trouxe',
      pacote: true,
      pedidos: pedidosPeloLink(post, true, null),
      redes: [],
      semLeitura: `Os números ${emFrase(redes.length ? redes : ['da rede'])} o Liame não lê: quem publica é você, e o Liame não tem acesso a essa rede.`,
      conectar: false,
      nota: null,
    };
  }
  if (post.status !== 'publicado' && post.status !== 'em_parte') return null;
  const saiuNos = post.channels.filter((c) => c.status === 'publicado' && c.published_at);
  const pagina = post.channels.find((c) => c.channel === 'facebook');
  const paginaSaiu = pagina?.status === 'publicado';
  let pedidos: PedidosDoPost;
  if (!pagina) {
    pedidos = { tipo: 'sem-link', texto: 'No Instagram, a legenda não tem link que abre: o pedido deste post não vem pelo link. Os números da rede, abaixo, mostram a atenção que ele teve.' };
  } else if (!paginaSaiu) {
    pedidos = { tipo: 'sem-link', texto: 'O link do post ia no fim do texto da Página, que não saiu: nenhum pedido pelo link. Se a Página sair em “Tentar de novo”, o link vai junto.' };
  } else {
    const saiuPagina = pagina.published_at ? noFuso(new Date(pagina.published_at), fuso) : null;
    pedidos = pedidosPeloLink(post, false, saiuPagina && saiuPagina.dia === hoje ? saiuPagina.hora : null);
  }
  const redes = saiuNos.filter((c) => LIDOS.includes(c.channel)).map((c) => redeDoPost(c, agora, fuso, hoje));
  const primeiraSaida = saiuNos.map((c) => new Date(c.published_at!).getTime()).sort((a, b) => a - b)[0];
  const fim = primeiraSaida !== undefined ? noFuso(new Date(primeiraSaida + DIAS_DE_LEITURA * DIA_MS), fuso).dia : null;
  const acabou = primeiraSaida !== undefined && agora.getTime() > primeiraSaida + DIAS_DE_LEITURA * DIA_MS;
  return {
    titulo: 'O que este post trouxe',
    pacote: false,
    pedidos,
    redes,
    semLeitura: null,
    conectar: redes.some((r) => r.falta?.atencao),
    nota: fim
      ? `Os números são da rede e servem de apoio: mostram a atenção que o post teve; o resultado é o pedido. Não se somam entre as redes e não entram em Resultados nem no retorno dos anúncios. ${
          acabou ? `O Liame leu uma vez por dia, por 30 dias, até ${ddmm(fim)}: ficam os números da última leitura.` : `O Liame lê uma vez por dia, até ${ddmm(fim)}, 30 dias depois de sair.`
        }`
      : null,
  };
}
