import type { OrderOrigin, PostResult, PostTotals } from '@liame/contracts';
import { inteiro, reaisDeMicros } from '@/lib/formato';
import type { Frase, Trecho } from './textos';

// O que cada post trouxe, em Resultados (mockups/prototipo-posts-resultados.html, A6 · P32, aprovado pelo dono em
// 01/11/2026; D-A6-49). Cada post leva um link do cardápio só dele, e é pelo código desse link que o pedido se liga ao
// post: nenhum nome, nenhum telefone. Post não é anúncio: os pedidos dele ficam fora do retorno dos anúncios. O pedido
// com o link do post e prova de anúncio fica com o anúncio (D-A6-48). Funções puras: o fuso entra como parâmetro.

const plural = (n: number, um: string, varios: string) => `${inteiro(n)} ${n === 1 ? um : varios}`;
const negrito = (t: string): Trecho => ({ t, b: true });

const REDES: Record<string, string> = { facebook: 'Página do Facebook', instagram: 'Instagram', tiktok: 'TikTok', youtube: 'YouTube' };

/** A rede do link do post, em palavras ("Página do Facebook", "TikTok"); a que a tela não conhece vai como veio. */
export function redeDoPost(channel: string): string {
  return REDES[channel] ?? channel.replaceAll('_', ' ');
}

/**
 * "Post de sexta, 25/09, às 19:00" ou "Pacote de sábado, 26/09, às 12:00": quando o post saiu, no fuso da loja. É como
 * a Agenda chama o post, sem o texto dele.
 */
export function tituloDoPost(p: { kind: string; published_at: string }, fuso: string): string {
  const instante = new Date(p.published_at);
  const partes = new Intl.DateTimeFormat('pt-BR', { timeZone: fuso, weekday: 'long', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(instante);
  const v = (t: Intl.DateTimeFormatPartTypes) => partes.find((x) => x.type === t)?.value ?? '';
  // "sexta-feira" vira "sexta"; "sábado" e "domingo" ficam como estão.
  const dia = v('weekday').split('-')[0];
  return `${p.kind === 'pacote' ? 'Pacote' : 'Post'} de ${dia}, ${v('day')}/${v('month')}, às ${v('hour')}:${v('minute')}`;
}

/**
 * A linha dos posts no cartão "De onde vieram os pedidos": quantos pedidos vieram pelo link dos posts e quanto isso deu
 * no caixa; os que também têm prova de anúncio ficam com o anúncio, e a linha diz quantos são. Sem pedido, quantos posts
 * saíram com o link no período.
 */
export function linhaDosPosts(p: PostTotals, hoje: boolean): Frase {
  const comAnuncio = p.with_ad_orders;
  const um = comAnuncio === 1;
  if (p.orders === 0) {
    if (comAnuncio > 0) {
      return [
        negrito(`${plural(comAnuncio, 'pedido veio', 'pedidos vieram')} pelo link dos posts${hoje ? ' hoje' : ''}`),
        { t: ` e ${um ? 'tem' : 'têm'} prova de anúncio: ${um ? 'fica' : 'ficam'} com o anúncio.` },
      ];
    }
    if (hoje) return [{ t: 'Nenhum pedido pelo link dos posts hoje, até agora.' }];
    return [{ t: `${plural(p.published_posts, 'post saiu', 'posts saíram')} com o link no período; nenhum pedido por ele ainda.` }];
  }
  const deQuantos = p.posts.length === 1 ? 'de um post' : p.posts.length > 1 ? `de ${inteiro(p.posts.length)} posts` : 'dos posts';
  const frase: Frase = [
    negrito(`${plural(p.orders, 'pedido veio', 'pedidos vieram')} pelo link ${deQuantos}`),
    { t: `: ${reaisDeMicros(p.revenue_micros)} no caixa. ${p.orders === 1 ? 'Ele fica' : 'Eles ficam'} fora do retorno dos anúncios: post não é anúncio.` },
  ];
  if (comAnuncio > 0) {
    const outros = um ? 'Outro pedido veio' : `Outros ${plural(comAnuncio, 'pedido veio', 'pedidos vieram')}`;
    frase.push({ t: ` ${outros} pelo link e ${um ? 'tem' : 'têm'} prova de anúncio: ${um ? 'fica' : 'ficam'} com o anúncio.` });
  }
  return frase;
}

/** No Pro, em "Pedidos sem origem": os pedidos que saíram da conta por terem vindo pelo link de um post. */
export function notaDosPosts(p: PostTotals): string | null {
  if (!p.orders) return null;
  const um = p.orders === 1;
  return `Fora desta conta: ${plural(p.orders, 'pedido', 'pedidos')} do cardápio que ${um ? 'veio' : 'vieram'} pelo link de um post. A origem ${um ? 'dele' : 'deles'} é o post.`;
}

export type PostNaLista = { id: string; titulo: string; rede: string; valor: string };

/** No Pro, a lista dos posts que trouxeram pedido: "Post de sexta, 25/09, às 19:00" · Página do Facebook · "5 pedidos · R$ 210,00". */
export function postsQueTrouxeram(posts: PostResult[], fuso: string): PostNaLista[] {
  return posts.map((x) => ({
    id: x.post_id,
    titulo: tituloDoPost(x, fuso),
    rede: redeDoPost(x.channel),
    valor: `${plural(x.orders, 'pedido', 'pedidos')} · ${reaisDeMicros(x.revenue_micros)}`,
  }));
}

type PostDoPedido = NonNullable<OrderOrigin['post']>;

/**
 * O pedido veio pelo link de um post e o modelo não achou prova de anúncio: a origem dele é o post (D-A6-49). Com prova
 * de anúncio, o pedido fica com o anúncio (D-A6-48), e isto dá falso. O cupom de uma mensagem vem antes (a regra das
 * mensagens, no servidor e aqui).
 */
export function doPost(o: OrderOrigin): o is OrderOrigin & { post: PostDoPedido } {
  return !!o.post && o.attribution.status === 'sem_origem' && !o.attribution.counted && o.attribution.reason === 'link_do_post';
}

/** Onde o link do post estava: no fim do texto da Página ou na bio da rede do pacote. */
export function ondeEstavaOLink(p: Pick<PostDoPedido, 'kind' | 'channel'>): string {
  if (p.kind === 'pacote') return `na bio do ${redeDoPost(p.channel)}`;
  return p.channel === 'facebook' ? 'no fim do texto da Página' : `no post do ${redeDoPost(p.channel)}`;
}
