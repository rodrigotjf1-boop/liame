import type { ClosedLoopResponse, OrderOrigin, PostTotals } from '@liame/contracts';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { GavetaOrigem } from '@/components/resultados/gaveta-origem';
import { montarGraficos, origemLiteDe } from '@/components/resultados/graficos';
import { confiancaDe, contarPedidos, detalheDoPedido, filtrarPedidos, origemDoPedido } from '@/components/resultados/pedidos';
import { doPost, linhaDosPosts, notaDosPosts, postsQueTrouxeram, redeDoPost, tituloDoPost } from '@/components/resultados/posts';
import { ResultadosConteudo } from '@/components/resultados/resultados-conteudo';
import { montarTela, textoDe } from '@/components/resultados/textos';
import { ModoProvider } from '@/lib/modo';
import { base7, micros, sp, uuid } from './resultados-dados';

// O que cada post trouxe, em Resultados (mockups/prototipo-posts-resultados.html, A6 · P32, aprovado em 01/11/2026;
// D-A6-49): a linha no cartão "De onde vieram os pedidos", a nota em "Pedidos sem origem" e a lista dos posts (Pro), e o
// pedido que veio pelo link de um post em "Pedido a pedido" e na gaveta. O pedido com o link do post e prova de anúncio
// fica com o anúncio (D-A6-48). Sem post com o link no período, a tela é a aprovada. Datas fixas (LIC-006).

const FUSO = 'America/Sao_Paulo';
const POST_A = uuid(301);
const POST_B = uuid(302);
const POST_C = uuid(303);
const totais = (over: Partial<PostTotals> = {}): PostTotals => ({
  orders: 8,
  revenue_micros: micros('312.40'),
  with_ad_orders: 0,
  published_posts: 6,
  posts: [
    { post_id: POST_A, kind: 'post', channel: 'facebook', published_at: '2026-09-25T22:00:00.000Z', orders: 5, revenue_micros: micros('210.00') },
    { post_id: POST_B, kind: 'pacote', channel: 'tiktok', published_at: '2026-09-26T15:00:00.000Z', orders: 2, revenue_micros: micros('74.40') },
    { post_id: POST_C, kind: 'post', channel: 'facebook', published_at: '2026-09-27T21:30:00.000Z', orders: 1, revenue_micros: micros('28.00') },
  ],
  ...over,
});
/** A semana de exemplo, com 8 dos 46 pedidos sem origem vindos pelo link de um post (o servidor já os tirou da conta). */
function comPosts(over: Partial<PostTotals> = {}): ClosedLoopResponse {
  const r = base7();
  const p = totais(over);
  return { ...r, totals: { ...r.totals, without_origin: { orders: 46 - p.orders, revenue_micros: micros('2416.00'), share_pct: '37.6' }, posts: p } };
}
const tela = (r: ClosedLoopResponse, periodo: 'hoje' | '7' | '30' = '7') => montarTela(r, periodo, new Date(r.generated_at), 'Loja Centro');
const frase = (p: PostTotals, hoje = false) => sp(textoDe(linhaDosPosts(p, hoje)));

describe('a linha dos posts', () => {
  it('quantos pedidos vieram pelo link dos posts e quanto deu no caixa, fora do retorno dos anúncios', () => {
    expect(frase(totais())).toBe('8 pedidos vieram pelo link de 3 posts: R$ 312,40 no caixa. Eles ficam fora do retorno dos anúncios: post não é anúncio.');
    expect(linhaDosPosts(totais(), false).filter((t) => t.b).map((t) => t.t)).toEqual(['8 pedidos vieram pelo link de 3 posts']);
    expect(frase(totais({ orders: 1, revenue_micros: micros('28.00'), posts: totais().posts.slice(2) }))).toBe(
      '1 pedido veio pelo link de um post: R$ 28,00 no caixa. Ele fica fora do retorno dos anúncios: post não é anúncio.',
    );
  });

  it('o pedido com o link do post e prova de anúncio fica com o anúncio, e a linha diz quantos são', () => {
    expect(frase(totais({ with_ad_orders: 2 }))).toContain(' Outros 2 pedidos vieram pelo link e têm prova de anúncio: ficam com o anúncio.');
    expect(frase(totais({ with_ad_orders: 1 }))).toContain(' Outro pedido veio pelo link e tem prova de anúncio: fica com o anúncio.');
  });

  it('posts publicados e nenhum pedido pelo link; hoje; e quando todos têm prova de anúncio', () => {
    const nenhum = { orders: 0, revenue_micros: '0', posts: [] };
    expect(frase(totais({ ...nenhum, published_posts: 4 }))).toBe('4 posts saíram com o link no período; nenhum pedido por ele ainda.');
    expect(frase(totais({ ...nenhum, published_posts: 1 }))).toBe('1 post saiu com o link no período; nenhum pedido por ele ainda.');
    expect(frase(totais(nenhum), true)).toBe('Nenhum pedido pelo link dos posts hoje, até agora.');
    expect(frase(totais({ ...nenhum, with_ad_orders: 2 }))).toBe('2 pedidos vieram pelo link dos posts e têm prova de anúncio: ficam com o anúncio.');
  });

  it('os posts na lista do Pro: o título como a Agenda chama o post, a rede e os pedidos', () => {
    expect(tituloDoPost({ kind: 'post', published_at: '2026-09-25T22:00:00.000Z' }, FUSO)).toBe('Post de sexta, 25/09, às 19:00');
    expect(tituloDoPost({ kind: 'pacote', published_at: '2026-09-26T15:00:00.000Z' }, FUSO)).toBe('Pacote de sábado, 26/09, às 12:00');
    expect(tituloDoPost({ kind: 'post', published_at: '2026-09-27T21:30:00.000Z' }, FUSO)).toBe('Post de domingo, 27/09, às 18:30');
    expect(redeDoPost('facebook')).toBe('Página do Facebook');
    expect(redeDoPost('tiktok')).toBe('TikTok');
    expect(postsQueTrouxeram(totais().posts, FUSO).map((p) => [p.titulo, p.rede, sp(p.valor)])).toEqual([
      ['Post de sexta, 25/09, às 19:00', 'Página do Facebook', '5 pedidos · R$ 210,00'],
      ['Pacote de sábado, 26/09, às 12:00', 'TikTok', '2 pedidos · R$ 74,40'],
      ['Post de domingo, 27/09, às 18:30', 'Página do Facebook', '1 pedido · R$ 28,00'],
    ]);
    expect(notaDosPosts(totais())).toBe('Fora desta conta: 8 pedidos do cardápio que vieram pelo link de um post. A origem deles é o post.');
    expect(notaDosPosts(totais({ orders: 0 }))).toBeNull();
  });
});

describe('o cartão "De onde vieram os pedidos" com posts', () => {
  it('a barra do modo simples não muda: quem veio pelo post segue na parte sem prova de anúncio', () => {
    const r = comPosts();
    expect(origemLiteDe(r, tela(r).base)!.barra).toEqual(origemLiteDe(base7(), tela(base7()).base)!.barra);
  });

  it('no Pro, os pedidos do post saem de "Pedidos sem origem", com a nota, a linha e a lista dos posts', () => {
    const origem = tela(comPosts()).origem;
    if (origem.tipo !== 'ok') throw new Error('cartão sem pedidos');
    expect(sp(origem.semOrigem.frase)).toBe('38 de 101 pedidos do cardápio online e do WhatsApp não têm evidência de anúncio. Pedido sem evidência fica sem origem: o Liame não chuta.');
    expect(origem.notaDosPosts).toBe('Fora desta conta: 8 pedidos do cardápio que vieram pelo link de um post. A origem deles é o post.');
    expect(origem.postsQueTrouxeram).toHaveLength(3);
    const semPosts = tela(base7()).origem;
    if (semPosts.tipo !== 'ok') throw new Error('cartão sem pedidos');
    expect([semPosts.posts, semPosts.notaDosPosts, semPosts.postsQueTrouxeram]).toEqual([null, null, []]);
  });
});

describe('o pedido que veio pelo link de um post, em "Pedido a pedido"', () => {
  const base: OrderOrigin = {
    order_id: uuid(401),
    external_id: '48357',
    channel: 'cardapio',
    channel_group: 'cardapio',
    status: 'confirmado',
    confirmed_at: '2026-09-25T23:47:00.000Z',
    revenue_micros: micros('46.90'),
    margin_micros: micros('18.30'),
    attribution: { status: 'sem_origem', evidence: null, confidence: null, provider: null, campaign: null, ad: null, touch_at: null, hours_before: null, window_days: 7, counted: false, reason: 'link_do_post' },
    message: null,
    post: { id: POST_A, kind: 'post', channel: 'facebook', published_at: '2026-09-25T22:00:00.000Z', link_code: 'LKPOSTFB01', touch_at: '2026-09-25T22:12:00.000Z' },
  };
  const pacote: OrderOrigin = { ...base, order_id: uuid(402), external_id: '48358', post: { ...base.post!, id: POST_B, kind: 'pacote', channel: 'tiktok', published_at: '2026-09-26T15:00:00.000Z', link_code: 'LKPOSTTT02' } };
  const comAnuncio: OrderOrigin = {
    ...base,
    order_id: uuid(403),
    external_id: '48359',
    attribution: { ...base.attribution, status: 'atribuido', evidence: 'clique_campanha', confidence: 'alta', provider: 'meta_ads', campaign: { id: uuid(11), name: 'Combo sexta' }, touch_at: '2026-09-25T23:00:00.000Z', hours_before: 0.8, counted: true, reason: null },
  };
  const cancelado: OrderOrigin = { ...base, order_id: uuid(404), external_id: '48360', status: 'cancelado', attribution: { ...base.attribution, reason: 'cancelado' } };
  const semNada: OrderOrigin = { ...base, order_id: uuid(405), external_id: '48361', post: null, attribution: { ...base.attribution, reason: 'sem_evidencia' } };
  const lista = [base, pacote, comAnuncio, cancelado, semNada];
  const ctx = { fuso: FUSO, loja: 'Loja Centro', modelo: base7().model };

  it('a origem é o post só quando o modelo não achou prova de anúncio', () => {
    expect(lista.map((o) => doPost(o))).toEqual([true, true, false, false, false]);
  });

  it('filtros, colunas e confiança: o pedido do post conta em "Com origem", com o post e a rede', () => {
    expect(contarPedidos(lista)).toEqual({ todos: 5, com: 3, sem: 1, cancelados: 1 });
    expect(filtrarPedidos(lista, 'sem').map((o) => o.external_id)).toEqual(['48361']);
    expect(origemDoPedido(base, FUSO)).toEqual({ principal: 'Post de sexta, 25/09, às 19:00', sub: 'Página do Facebook · link do post', forte: true });
    expect(origemDoPedido(pacote, FUSO)).toEqual({ principal: 'Pacote de sábado, 26/09, às 12:00', sub: 'TikTok · link do post', forte: true });
    expect(origemDoPedido(comAnuncio, FUSO)).toEqual({ principal: 'Combo sexta', sub: 'Meta Ads · clique com campanha', forte: true });
    expect(lista.map((o) => confiancaDe(o).rotulo)).toEqual(['Alta', 'Alta', 'Alta', 'Cancelado · fora do ROAS', 'Sem origem']);
  });

  it('a gaveta: o post, a evidência com o código do link, como o Liame sabe e a linha do tempo, como no protótipo', () => {
    const d = detalheDoPedido(base, ctx);
    expect(d.resultado).toEqual({ tipo: 'post', post: 'Post de sexta, 25/09, às 19:00', rede: 'Página do Facebook', nota: 'conta nos posts, fora do retorno dos anúncios' });
    expect(d.evidencia).toEqual({ texto: 'Link do post, com o código LKPOSTFB01 só dele · acesso ao cardápio 2 horas antes do pedido · confiança alta', tom: 'normal' });
    expect(d.comoSabe).toEqual([
      'O link é só deste post: ele foi no fim do texto da Página, que saiu em 25/09, às 19:00, aprovado com o código do app.',
      'O cardápio do Regem guardou o código do link no acesso que virou o pedido. O id de clique da rede pode vir junto, mas o código diz que o clique foi no post, e não num anúncio.',
      'O pedido conta nos posts e fica fora do retorno dos anúncios: post não é anúncio.',
    ]);
    expect(d.linhaDoTempo.map((x) => [x.quando, x.oque, x.usado])).toEqual([
      ['25/09, 19:00', 'Post publicado na Página do Facebook', false],
      ['25/09, 19:12', 'Acesso ao cardápio pelo link do post', true],
      ['25/09, 20:47', 'Pedido confirmado no caixa', false],
    ]);
    expect(detalheDoPedido(pacote, ctx).comoSabe[0]).toBe('O link é só deste pacote: ele foi na bio do TikTok, no pacote que saiu em 26/09, às 12:00.');
    expect(detalheDoPedido(pacote, ctx).linhaDoTempo[0]!.oque).toBe('Pacote publicado no TikTok');
  });

  it('com prova de anúncio, a gaveta é a do anúncio e diz que o pedido também veio pelo link do post; cancelado, fora da conta', () => {
    const d = detalheDoPedido(comAnuncio, ctx);
    expect(d.resultado).toMatchObject({ tipo: 'campanha', campanha: 'Combo sexta' });
    expect(d.comoSabe.at(-1)).toBe('Este pedido também veio pelo link de um post (Post de sexta, 25/09, às 19:00). Como tem prova de anúncio, ele fica com o anúncio.');
    expect(detalheDoPedido(cancelado, ctx).resultado).toEqual({ tipo: 'cancelado', campanha: null, plataforma: null });
    expect(detalheDoPedido(cancelado, ctx).linhaDoTempo.map((x) => x.oque)).toEqual(['Pedido confirmado no caixa']);
  });

  it('a gaveta desenhada: o post e a rede, o atalho para a Agenda só para quem pode, e a nota sem dado pessoal', () => {
    const desenhar = (podeVerAgenda: boolean) =>
      sp(renderToStaticMarkup(createElement(GavetaOrigem, { pedido: base, fuso: FUSO, loja: 'Loja Centro', modelo: base7().model, reserva: { current: null }, aoFechar: () => {}, podeVerAgenda })));
    const html = desenhar(true);
    expect(html).toContain('<b>Post de sexta, 25/09, às 19:00</b>');
    expect(html).toContain('<span class="plat">Página do Facebook</span>');
    expect(html).toContain('<a href="/agenda">Ver o post na Agenda</a>');
    expect(html).toContain('O pedido se liga ao post só pelo código do link.');
    expect(desenhar(false)).not.toContain('href="/agenda"');
  });
});

describe('desenho do cartão com posts (o mesmo componente do navegador)', () => {
  const desenhar = (r: ClosedLoopResponse, modo: 'lite' | 'pro', podeVerAgenda: boolean) => {
    const t = tela(r);
    return sp(
      renderToStaticMarkup(
        createElement(ModoProvider, {
          inicial: modo,
          children: createElement(ResultadosConteudo, {
            tela: t,
            graficos: montarGraficos(r, t.base, t.fontes, t.avisos, null),
            modelo: r.model,
            consulta: { brand_id: uuid(900), from: r.period.from, to: r.period.to },
            loja: 'Loja Centro',
            podeVerContas: true,
            reserva: { current: null },
            podeVerAgenda,
          }),
        }),
      ),
    );
  };
  const LINHA = '<b>8 pedidos vieram pelo link de 3 posts</b>: R$ 312,40 no caixa.';

  it('no modo simples, a linha fica embaixo da barra, uma vez só, com o atalho para a Agenda e sem a lista', () => {
    const html = desenhar(comPosts(), 'lite', true);
    expect(html).not.toMatch(/NaN|undefined|\[object Object\]|Infinity|>null</);
    expect(html.match(/ps-linha/g)).toHaveLength(1);
    expect(html).toContain(LINHA);
    expect(html).toContain('<a href="/agenda">Ver na Agenda</a>');
    expect(html).not.toContain('ps-posts');
  });

  it('no Pro, a linha e a lista dos posts ficam embaixo dos dois blocos', () => {
    const html = desenhar(comPosts(), 'pro', true);
    expect(html.match(/ps-linha/g)).toHaveLength(1);
    expect(html).toContain(LINHA);
    expect(html).toContain('<ul class="ps-posts" aria-label="Os posts que trouxeram pedido">');
    expect(html).toContain('Post de sexta, 25/09, às 19:00<small>Página do Facebook</small>');
    expect(html.indexOf('ps-linha')).toBeGreaterThan(html.indexOf('Canais sem clique'));
  });

  it('quem não pode abrir a Agenda lê a linha, sem o atalho; sem post no período, a tela é a aprovada', () => {
    expect(desenhar(comPosts(), 'lite', false)).not.toContain('href="/agenda"');
    for (const modo of ['lite', 'pro'] as const) {
      const html = desenhar(base7(), modo, true);
      expect(html).not.toContain('ps-linha');
      expect(html).not.toContain('link de um post');
    }
  });
});
