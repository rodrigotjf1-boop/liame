import type { PostChannelResponse, PostListResponse, PostResponse } from '@liame/contracts';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { GavetaPacote } from '@/components/agenda/gaveta-pacote';
import { GavetaPost } from '@/components/agenda/gaveta-post';
import { oQueOPostTrouxe, quandoDaLeitura, redeDoPost } from '@/components/agenda/post-trouxe';
import { pedidosDoCartao, telaDaAgenda } from '@/components/agenda/textos';

// O que o post trouxe, na gaveta do post da Agenda (mockups/prototipo-post-trouxe.html, A6 · P33, aprovado em
// 01/11/2026; D-A6-53): os pedidos pelo link do post (a conta de Resultados, P32) e, como apoio, os números de cada rede,
// com a hora da leitura e o porquê quando faltam; o pacote publicado mostra os pedidos pelo link da bio; o cartão da
// Agenda diz quantos pedidos o post trouxe. Datas fixas no fuso de São Paulo (LIC-006).

const SP = 'America/Sao_Paulo';
const MARCA = '22222222-2222-4222-8222-222222222222';
const id = (n: number) => `33333333-3333-4333-8333-${String(n).padStart(12, '0')}`;
const sp = (dia: string, hora: string) => new Date(`${dia}T${hora}:00-03:00`).toISOString();
const AGORA = new Date(sp('2026-10-30', '14:00'));
const LINK = 'https://cardapio.exemplo.com.br/loja?utm_source=facebook&utm_medium=social&utm_campaign=post&lk=LKPOSTFB01';

function canal(c: string, parcial: Partial<PostChannelResponse> = {}): PostChannelResponse {
  return {
    channel: c,
    account_id: null,
    account_name: null,
    text: 'Sexta é dia de combo.',
    status: 'publicado',
    permalink: null,
    error: null,
    published_at: sp('2026-10-30', '12:00'),
    removed_at: null,
    metrics: null,
    metrics_status: null,
    metrics_read_at: null,
    retry_until: null,
    ...parcial,
  };
}
const IG_M = { views: 1284, reach: 912, likes: 86, comments: 7, shares: 5, saves: 12, clicks: null, reactions: null };
const FB_M = { views: 640, reach: 455, likes: null, comments: null, shares: null, saves: null, clicks: 38, reactions: 24 };
const lidoAs = sp('2026-10-30', '13:02');

function post(parcial: Partial<PostResponse> = {}, canais: PostChannelResponse[] = [canal('instagram'), canal('facebook')]): PostResponse {
  return {
    id: id(1),
    brand_id: MARCA,
    kind: 'post',
    photo_id: null,
    crop_pos: null,
    publish_at: sp('2026-10-30', '12:00'),
    action_id: id(500),
    status: 'publicado',
    created_at: sp('2026-10-29', '10:15'),
    channels: canais,
    removal: null,
    link: LINK,
    link_orders: { orders: 3, revenue_micros: '126500000', with_ad_orders: 0 },
    ...parcial,
  };
}
/** O espaço fixo do formato de moeda e de milhar vira espaço comum, para comparar. */
const sp2 = (s: string) => s.replace(/ /g, ' ');

describe('os pedidos pelo link do post', () => {
  it('o post publicado com pedidos: quantos, o caixa e o porquê, fora do retorno dos anúncios', () => {
    const t = oQueOPostTrouxe(post(), AGORA, SP)!;
    expect(t.titulo).toBe('O que este post trouxe');
    expect(t.pedidos.tipo).toBe('com');
    if (t.pedidos.tipo !== 'com') return;
    expect(t.pedidos.n).toBe('3 pedidos');
    expect(sp2(t.pedidos.caixa)).toBe('R$ 126,50');
    expect(t.pedidos.sub).toBe(
      'Vieram pelo link do post na Página do Facebook e foram confirmados no caixa; o cancelado sai da conta. Ficam fora do retorno dos anúncios: post não é anúncio.',
    );
    const um = oQueOPostTrouxe(post({ link_orders: { orders: 1, revenue_micros: '46900000', with_ad_orders: 2 } }), AGORA, SP)!;
    expect(um.pedidos.tipo === 'com' && um.pedidos.sub).toContain('Veio pelo link do post na Página do Facebook e foi confirmado no caixa');
    expect(um.pedidos.tipo === 'com' && um.pedidos.sub).toContain(' Outros 2 pedidos vieram pelo link e têm prova de anúncio: ficam com o anúncio.');
  });

  it('nenhum pedido ainda; só no Instagram; e a Página que não saiu: por que não há pedido pelo link', () => {
    const zero = oQueOPostTrouxe(post({ link_orders: { orders: 0, revenue_micros: '0', with_ad_orders: 0 } }), AGORA, SP)!;
    expect(zero.pedidos).toEqual({ tipo: 'zero', sub: 'O post saiu hoje, às 12:00. O link está no fim do texto da Página. O pedido que chegar por ele aparece aqui e em Resultados.' });
    const soInstagram = oQueOPostTrouxe(post({ link: null, link_orders: null }, [canal('instagram')]), AGORA, SP)!;
    expect(soInstagram.pedidos).toEqual({
      tipo: 'sem-link',
      texto: 'No Instagram, a legenda não tem link que abre: o pedido deste post não vem pelo link. Os números da rede, abaixo, mostram a atenção que ele teve.',
    });
    const emParte = oQueOPostTrouxe(post({ status: 'em_parte' }, [canal('instagram'), canal('facebook', { status: 'falhou', published_at: null })]), AGORA, SP)!;
    expect(emParte.pedidos).toMatchObject({ tipo: 'sem-link', texto: expect.stringContaining('O link do post ia no fim do texto da Página, que não saiu') });
    // Só as redes em que o post saiu têm quadro.
    expect(emParte.redes.map((r) => r.canal)).toEqual(['instagram']);
  });

  it('o que ainda não saiu não ganha a seção; o pacote só depois do "Publiquei"', () => {
    for (const status of ['agendado', 'esperando_aprovacao', 'nao_saiu', 'cancelado']) expect(oQueOPostTrouxe(post({ status }), AGORA, SP)).toBeNull();
    const pacote = post({ kind: 'pacote', status: 'pacote_publicado', action_id: null }, [canal('tiktok')]);
    const t = oQueOPostTrouxe(pacote, AGORA, SP)!;
    expect(t.titulo).toBe('O que este pacote trouxe');
    expect(t.pedidos.tipo === 'com' && t.pedidos.sub).toContain('Vieram pelo link da bio deste pacote');
    expect(t.semLeitura).toBe('Os números do TikTok o Liame não lê: quem publica é você, e o Liame não tem acesso a essa rede.');
    expect(t.nota).toBeNull();
    expect(oQueOPostTrouxe({ ...pacote, status: 'pacote_pronto' }, AGORA, SP)).toBeNull();
  });
});

describe('os números de cada rede, como apoio', () => {
  const hoje = '2026-10-30';
  it('lidos: os números de cada rede, com os rótulos dela e a hora da leitura', () => {
    expect(quandoDaLeitura(new Date(lidoAs), SP, hoje)).toBe('hoje, às 13:02');
    expect(quandoDaLeitura(new Date(sp('2026-10-29', '20:32')), SP, hoje)).toBe('ontem, às 20:32');
    expect(quandoDaLeitura(new Date(sp('2026-10-18', '19:02')), SP, hoje)).toBe('em 18/10, às 19:02');
    const ig = redeDoPost(canal('instagram', { metrics: IG_M, metrics_status: 'lido', metrics_read_at: lidoAs }), AGORA, SP, hoje);
    expect(ig.lido).toBe('lido hoje, às 13:02');
    expect(ig.numeros.map((n) => `${n.rotulo}: ${sp2(n.valor)}`)).toEqual(['Vezes visto: 1.284', 'Contas alcançadas: 912', 'Curtidas: 86', 'Comentários: 7', 'Salvos: 12', 'Compartilhamentos: 5']);
    expect(ig.falta).toBeNull();
    const fb = redeDoPost(canal('facebook', { metrics: FB_M, metrics_status: 'lido', metrics_read_at: lidoAs }), AGORA, SP, hoje);
    expect(fb.numeros.map((n) => n.rotulo)).toEqual(['Vezes visto', 'Pessoas alcançadas', 'Cliques no post', 'Reações']);
  });

  it('quando falta número: a primeira leitura, o Instagram que leva 48 horas, a Página, a permissão e a conta', () => {
    const r = (c: string, p: Partial<PostChannelResponse>, agora = AGORA) => redeDoPost(canal(c, p), agora, SP, hoje);
    // Saiu às 13:30; às 14:00 a primeira leitura ainda não aconteceu.
    expect(r('instagram', { published_at: sp(hoje, '13:30') }).falta?.texto).toBe('A primeira leitura é hoje, às 14:30, uma hora depois de sair; os números aparecem aqui.');
    expect(r('instagram', { metrics_status: 'sem_dados', metrics_read_at: lidoAs }).falta?.texto).toBe('O Instagram ainda não mandou os números: ele leva até 48 horas. O Liame confere de novo amanhã, às 13:02.');
    expect(r('facebook', { metrics_status: 'sem_dados', metrics_read_at: lidoAs }).falta?.texto).toBe('A Página atualiza os números uma vez por dia: eles aparecem na próxima leitura, amanhã, às 13:02.');
    const depois = new Date(sp('2026-11-03', '14:00'));
    expect(r('facebook', { metrics_status: 'sem_dados', metrics_read_at: sp('2026-11-03', '13:02') }, depois).falta?.texto).toBe(
      'A Meta não mandou números deste post da Página. Página com menos de 100 curtidas não tem números de post. O Liame confere de novo em 04/11, às 13:02.',
    );
    expect(r('instagram', { metrics_status: 'sem_permissao', metrics_read_at: lidoAs }).falta).toMatchObject({ atencao: true, texto: expect.stringContaining('A autorização da Meta não deixa ler os números do Instagram') });
    const semConta = r('facebook', { metrics: FB_M, metrics_status: 'sem_conta', metrics_read_at: lidoAs });
    expect(semConta.lido).toBe('última leitura hoje, às 13:02');
    expect(semConta.numeros).toHaveLength(4);
    expect(semConta.falta?.texto).toBe('A conta da Página do Facebook saiu da marca: os números param na última leitura. Conecte de novo para voltar a ler.');
    expect(r('instagram', { metrics_status: 'sem_conta', metrics_read_at: lidoAs }).falta?.texto).toContain('A conta do Instagram saiu da marca');
  });

  it('depois de 30 dias: fica a última leitura, e a nota diz até quando o Liame leu', () => {
    const tarde = new Date(sp('2026-12-05', '10:00'));
    const lido = sp('2026-11-29', '13:02');
    const p = post({}, [canal('instagram', { metrics: IG_M, metrics_status: 'lido', metrics_read_at: lido }), canal('facebook', { metrics: FB_M, metrics_status: 'lido', metrics_read_at: lido })]);
    const t = oQueOPostTrouxe(p, tarde, SP)!;
    expect(t.redes[0]!.lido).toBe('última leitura em 29/11, às 13:02');
    expect(t.nota).toContain('O Liame leu uma vez por dia, por 30 dias, até 29/11: ficam os números da última leitura.');
    expect(oQueOPostTrouxe(p, AGORA, SP)!.nota).toContain('O Liame lê uma vez por dia, até 29/11, 30 dias depois de sair.');
  });
});

describe('a seção desenhada e o cartão da Agenda', () => {
  const base = { fuso: SP, hoje: '2026-10-30', foto: null, podeOperar: true, podeAprovar: true, podeVerContas: true, reserva: { current: null }, aoMudar: () => {}, aoFalharImagem: () => {}, aoFechar: () => {} };

  it('na gaveta do post: logo abaixo da situação, os pedidos, os quadros de cada rede e "Ver em Resultados" para quem pode', () => {
    const p = post({}, [canal('instagram', { metrics: IG_M, metrics_status: 'lido', metrics_read_at: lidoAs }), canal('facebook', { metrics_status: 'sem_permissao', metrics_read_at: lidoAs })]);
    const html = sp2(renderToStaticMarkup(createElement(GavetaPost, { ...base, post: p, podeVerResultados: true })));
    expect(html).toContain('O que este post trouxe');
    expect(html).toContain('<b class="ptr-n num">3 pedidos</b>');
    expect(html).toContain('<a class="ptr-atalho" href="/resultados">Ver em Resultados</a>');
    expect(html).toContain('Na rede, como apoio');
    expect(html).toContain('Contas alcançadas');
    expect(html).toContain('<a class="btn btn--sm" href="/contas">');
    // A seção vem antes da prévia (logo abaixo da situação).
    expect(html.indexOf('O que este post trouxe')).toBeLessThan(html.indexOf('Em cada canal'));
    expect(sp2(renderToStaticMarkup(createElement(GavetaPost, { ...base, post: p, podeVerResultados: false })))).not.toContain('href="/resultados"');
    expect(html).not.toMatch(/NaN|undefined|\[object Object\]/);
  });

  it('na gaveta do pacote publicado: os pedidos pelo link da bio, sem os números da rede', () => {
    const pacote = post({ kind: 'pacote', status: 'pacote_publicado', action_id: null }, [canal('tiktok')]);
    const html = sp2(
      renderToStaticMarkup(createElement(GavetaPacote, { ...base, post: pacote, aoTirar: () => {}, podeVerResultados: true })),
    );
    expect(html).toContain('O que este pacote trouxe');
    expect(html).toContain('Os números do TikTok o Liame não lê');
    expect(html).not.toContain('Ver em Resultados');
  });

  it('o cartão do post que já saiu diz quantos pedidos trouxe; o que não saiu, não', () => {
    expect(pedidosDoCartao(post())).toBe('3 pedidos');
    expect(pedidosDoCartao(post({ link_orders: { orders: 1, revenue_micros: '1', with_ad_orders: 0 } }))).toBe('1 pedido');
    expect(pedidosDoCartao(post({ link_orders: { orders: 0, revenue_micros: '0', with_ad_orders: 3 } }))).toBeNull();
    expect(pedidosDoCartao(post({ status: 'agendado' }))).toBeNull();
    const dados: PostListResponse = { enabled: true, timezone: SP, channels: [], items: [post()], post_link: { ok: true, reason: null }, pauta: [], dates: [] };
    const tela = telaDaAgenda(dados, '2026-10-26', '2026-10-30');
    if (tela.tipo !== 'semana') throw new Error('sem a semana');
    const item = tela.dias.flatMap((d) => d.posts)[0]!;
    expect(item.pedidos).toBe('3 pedidos');
    expect(item.rotulo).toBe('Post de hoje, às 12:00, Instagram e Página do Facebook: publicado, 3 pedidos pelo link');
  });
});
