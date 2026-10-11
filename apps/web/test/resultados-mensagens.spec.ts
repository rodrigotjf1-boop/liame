import type { ClosedLoopResponse, OrderOrigin } from '@liame/contracts';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { montarGraficos, origemLiteDe } from '@/components/resultados/graficos';
import { confiancaDe, contarPedidos, daMensagem, detalheDoPedido, filtrarPedidos, origemDoPedido } from '@/components/resultados/pedidos';
import { ResultadosConteudo } from '@/components/resultados/resultados-conteudo';
import { linhaDasMensagens, montarTela, textoDe } from '@/components/resultados/textos';
import { ModoProvider } from '@/lib/modo';
import { base7, micros, sp, uuid } from './resultados-dados';

// As mensagens de WhatsApp em Resultados (mockups/prototipo-mensagens-resultados.html, A5 · P15, parte C, aprovado em
// 10/10/2026): a linha no cartão "De onde vieram os pedidos", a nota em "Pedidos sem origem" (Pro) e o pedido que veio
// pelo cupom de uma mensagem em "Pedido a pedido" e na gaveta. O pedido com cupom de mensagem e prova de anúncio fica
// com o anúncio (decisão do dono). Sem cupom de mensagem no período, a tela é a aprovada. Datas fixas (LIC-006).

type Mensagens = NonNullable<ClosedLoopResponse['totals']['messages']>;
const mensagens = (over: Partial<Mensagens> = {}): Mensagens => ({ orders: 12, revenue_micros: micros('540.00'), own_channel_orders: 12, with_ad_orders: 0, ...over });
/** A semana de exemplo, com 12 dos 46 pedidos sem origem vindos pelo cupom de uma mensagem (o servidor já os tirou da conta). */
function comMensagens(over: Partial<Mensagens> = {}): ClosedLoopResponse {
  const r = base7();
  const m = mensagens(over);
  return { ...r, totals: { ...r.totals, without_origin: { orders: 46 - m.own_channel_orders, revenue_micros: micros('2416.00'), share_pct: '33.7' }, messages: m } };
}
const tela = (r: ClosedLoopResponse, periodo: 'hoje' | '7' | '30' = '7') => montarTela(r, periodo, new Date(r.generated_at), 'Loja Centro');
const frase = (m: Mensagens, hoje = false) => sp(textoDe(linhaDasMensagens(m, hoje)));

describe('a linha das mensagens de WhatsApp', () => {
  it('quantos pedidos vieram pelo cupom e quanto deu no caixa, fora do retorno dos anúncios', () => {
    expect(frase(mensagens())).toBe('12 pedidos vieram pelo cupom das mensagens de WhatsApp: R$ 540,00 no caixa. Eles ficam fora do retorno dos anúncios: mensagem não é anúncio.');
    // Em negrito, só o que a pessoa lê primeiro.
    expect(linhaDasMensagens(mensagens(), false).filter((t) => t.b).map((t) => t.t)).toEqual(['12 pedidos vieram pelo cupom das mensagens de WhatsApp']);
    expect(frase(mensagens({ orders: 1, revenue_micros: micros('58.90'), own_channel_orders: 1 }))).toBe(
      '1 pedido veio pelo cupom das mensagens de WhatsApp: R$ 58,90 no caixa. Ele fica fora do retorno dos anúncios: mensagem não é anúncio.',
    );
  });

  it('o pedido com o cupom e com prova de anúncio fica com o anúncio, e a linha diz quantos são', () => {
    expect(frase(mensagens({ orders: 9, revenue_micros: micros('405.00'), own_channel_orders: 9, with_ad_orders: 3 }))).toBe(
      '9 pedidos vieram pelo cupom das mensagens de WhatsApp: R$ 405,00 no caixa. Eles ficam fora do retorno dos anúncios: mensagem não é anúncio. Outros 3 pedidos usaram o cupom e têm prova de anúncio: ficam com o anúncio.',
    );
    expect(frase(mensagens({ with_ad_orders: 1 }))).toContain(' Outro pedido usou o cupom e tem prova de anúncio: fica com o anúncio.');
  });

  it('mensagem enviada e nenhum pedido com o cupom; e quando todos os pedidos do cupom têm prova de anúncio', () => {
    const nenhum = { orders: 0, revenue_micros: '0', own_channel_orders: 0 };
    expect(frase(mensagens(nenhum))).toBe('Nenhum pedido com o cupom das mensagens de WhatsApp no período.');
    expect(frase(mensagens(nenhum), true)).toBe('Nenhum pedido com o cupom das mensagens de WhatsApp hoje, até agora.');
    // "Nenhum pedido com o cupom" seria falso aqui: eles existem, e ficam com o anúncio.
    expect(frase(mensagens({ ...nenhum, with_ad_orders: 2 }))).toBe('2 pedidos usaram o cupom das mensagens de WhatsApp no período e têm prova de anúncio: ficam com o anúncio.');
    expect(frase(mensagens({ ...nenhum, with_ad_orders: 1 }), true)).toBe('1 pedido usou o cupom das mensagens de WhatsApp hoje, até agora e tem prova de anúncio: fica com o anúncio.');
  });
});

describe('o cartão "De onde vieram os pedidos" com mensagens', () => {
  it('a barra do modo simples não muda: quem veio pela mensagem segue na parte sem prova de anúncio', () => {
    const r = comMensagens();
    const o = origemLiteDe(r, tela(r).base)!;
    expect(o.titulo).toBe('De onde vieram os 412 pedidos');
    expect(o.barra.partes.map((p) => [p.classe, p.valor, p.peso])).toEqual([
      ['foco', '55', 55],
      ['c1', '311', 311],
      ['c2', '46', 46],
    ]);
    // É a mesma barra da semana sem mensagens.
    expect(o.barra).toEqual(origemLiteDe(base7(), tela(base7()).base)!.barra);
  });

  it('no Pro, os pedidos da mensagem saem de "Pedidos sem origem", com a nota dizendo quantos', () => {
    const origem = tela(comMensagens()).origem;
    if (origem.tipo !== 'ok') throw new Error('esperava o cartão com pedidos');
    expect(origem.semOrigem).toEqual({ porcentagem: '34%', frase: '34 de 101 pedidos do cardápio online e do WhatsApp não têm evidência de anúncio. Pedido sem evidência fica sem origem: o Liame não chuta.' });
    expect(origem.notaDasMensagens).toBe('Fora desta conta: 12 pedidos do cardápio e do WhatsApp que vieram pelo cupom de uma mensagem. A origem deles é a mensagem.');
    expect(sp(textoDe(origem.mensagens))).toContain('12 pedidos vieram pelo cupom das mensagens de WhatsApp: R$ 540,00 no caixa.');

    const um = tela(comMensagens({ orders: 1, revenue_micros: micros('58.90'), own_channel_orders: 1 })).origem;
    if (um.tipo !== 'ok') throw new Error('esperava o cartão com pedidos');
    expect(um.notaDasMensagens).toBe('Fora desta conta: 1 pedido do cardápio e do WhatsApp que veio pelo cupom de uma mensagem. A origem dele é a mensagem.');

    // Todos no balcão: a linha aparece, e nada saiu de "sem origem" (o pedido segue no canal dele).
    const balcao = tela(comMensagens({ own_channel_orders: 0 })).origem;
    if (balcao.tipo !== 'ok') throw new Error('esperava o cartão com pedidos');
    expect(balcao.notaDasMensagens).toBeNull();
    expect(balcao.mensagens).not.toBeNull();
  });

  it('sem cupom de mensagem no período, o cartão é o aprovado: sem linha e sem nota', () => {
    const origem = tela(base7()).origem;
    if (origem.tipo !== 'ok') throw new Error('esperava o cartão com pedidos');
    expect(origem.mensagens).toBeNull();
    expect(origem.notaDasMensagens).toBeNull();
  });
});

describe('o pedido que veio pelo cupom de uma mensagem, em "Pedido a pedido"', () => {
  const semOrigem: OrderOrigin = {
    order_id: uuid(201),
    external_id: '48356',
    channel: 'cardapio',
    channel_group: 'cardapio',
    status: 'confirmado',
    confirmed_at: '2026-09-29T00:30:00.000Z',
    revenue_micros: micros('58.90'),
    margin_micros: micros('24.10'),
    attribution: { status: 'sem_origem', evidence: null, confidence: null, provider: null, campaign: null, ad: null, touch_at: null, hours_before: null, window_days: 7, counted: false, reason: 'sem_evidencia' },
    message: null,
  };
  const mensagem = { name: 'Sobremesa por nossa conta', coupon_code: 'DOCE10', sent_at: '2026-09-26T14:00:00.000Z' };
  const daMsg: OrderOrigin = { ...semOrigem, message: mensagem };
  const noBalcao: OrderOrigin = { ...daMsg, order_id: uuid(202), external_id: '48357', channel: 'balcao', channel_group: 'presencial', attribution: { ...semOrigem.attribution, reason: 'canal_sem_clique' } };
  const comAnuncio: OrderOrigin = {
    ...daMsg,
    order_id: uuid(203),
    external_id: '48358',
    attribution: { ...semOrigem.attribution, status: 'atribuido', evidence: 'clique_campanha', confidence: 'alta', provider: 'meta_ads', campaign: { id: uuid(11), name: 'Combo sexta' }, touch_at: '2026-09-28T22:00:00.000Z', hours_before: 2.5, counted: true, reason: null },
  };
  const cancelado: OrderOrigin = { ...daMsg, order_id: uuid(204), external_id: '48359', status: 'cancelado', attribution: { ...semOrigem.attribution, reason: 'cancelado' } };
  const semCupom: OrderOrigin = { ...semOrigem, order_id: uuid(205), external_id: '48360' };
  const lista = [daMsg, noBalcao, comAnuncio, cancelado, semCupom];
  const ctx = { fuso: 'America/Sao_Paulo', loja: 'Loja Centro', modelo: base7().model };

  it('a origem é a mensagem só quando o modelo não achou prova de anúncio', () => {
    expect(lista.map((o) => daMensagem(o))).toEqual([true, true, false, true, false]);
  });

  it('filtros: o pedido da mensagem conta em "Com origem" e sai de "Sem origem"', () => {
    expect(contarPedidos(lista)).toEqual({ todos: 5, com: 3, sem: 1, cancelados: 1 });
    expect(filtrarPedidos(lista, 'com').map((o) => o.external_id)).toEqual(['48356', '48357', '48358']);
    expect(filtrarPedidos(lista, 'sem').map((o) => o.external_id)).toEqual(['48360']);
  });

  it('colunas da tabela: o nome da mensagem, "cupom da mensagem" e confiança alta', () => {
    expect(origemDoPedido(daMsg)).toEqual({ principal: 'Sobremesa por nossa conta', sub: 'Mensagem de WhatsApp · cupom da mensagem', forte: true });
    expect(origemDoPedido(noBalcao)).toEqual({ principal: 'Sobremesa por nossa conta', sub: 'Mensagem de WhatsApp · cupom da mensagem', forte: true });
    // Com prova de anúncio, a origem é a campanha.
    expect(origemDoPedido(comAnuncio)).toEqual({ principal: 'Combo sexta', sub: 'Meta Ads · clique com campanha', forte: true });
    expect(origemDoPedido(semCupom)).toEqual({ principal: 'Sem evidência de anúncio', sub: null, forte: false });
    expect([daMsg, noBalcao, comAnuncio, cancelado, semCupom].map((o) => confiancaDe(o).rotulo)).toEqual(['Alta', 'Alta', 'Alta', 'Cancelado · fora do ROAS', 'Sem origem']);
  });

  it('a gaveta: o resultado, a evidência, como o Liame sabe e a linha do tempo, como no protótipo', () => {
    const d = detalheDoPedido(daMsg, ctx);
    expect(d.resultado).toEqual({ tipo: 'mensagem', mensagem: 'Sobremesa por nossa conta', nota: 'conta em Mensagens, fora do retorno dos anúncios' });
    expect(d.confianca).toEqual({ rotulo: 'Alta', classe: 'concluido', ponto: true });
    expect(d.evidencia).toEqual({ texto: 'Cupom DOCE10, da mensagem “Sobremesa por nossa conta” · usado no próprio pedido · confiança alta', tom: 'normal' });
    expect(d.comoSabe).toEqual([
      'O cupom DOCE10 nasceu com a mensagem “Sobremesa por nossa conta”, enviada em 26/09, e é só dela.',
      'Quem recebeu a mensagem é com o RegemCast: o Liame não vê nome nem telefone, só o cupom no pedido.',
      'O pedido conta em Mensagens e fica fora do retorno dos anúncios: mensagem não é anúncio.',
    ]);
    expect(d.linhaDoTempo.map((x) => [x.quando, x.oque, x.usado])).toEqual([
      ['26/09, 11:00', 'Mensagem “Sobremesa por nossa conta” enviada pelo RegemCast', false],
      ['28/09, 21:30', 'Pedido confirmado no caixa, com o cupom DOCE10', true],
    ]);
    expect(sp(d.margem)).toBe('R$ 24,10 · todos os itens com custo');
  });

  it('com prova de anúncio, a gaveta é a do anúncio e diz que o pedido também usou o cupom', () => {
    const d = detalheDoPedido(comAnuncio, ctx);
    expect(d.resultado).toMatchObject({ tipo: 'campanha', campanha: 'Combo sexta' });
    expect(d.comoSabe.at(-1)).toBe('Este pedido também usou o cupom da mensagem “Sobremesa por nossa conta”. Como tem prova de anúncio, ele fica com o anúncio.');
    // O clique que traz a campanha e não o anúncio (o do Google é assim) diz "na campanha", e não "no campanha".
    expect(d.linhaDoTempo.map((x) => x.oque)).toEqual(['Clique na campanha Combo sexta', 'Pedido confirmado no caixa']);
    expect(d.evidencia.texto).toBe('Clique na campanha Combo sexta · 28/09, 19:00 · 3 horas antes do pedido · janela de 7 dias · confiança alta');
    // Sem cupom de mensagem, nada disso aparece.
    expect(detalheDoPedido(semCupom, ctx).comoSabe.join(' ')).not.toContain('mensagem');
    expect(detalheDoPedido(semCupom, ctx).resultado).toEqual({ tipo: 'sem', motivo: 'Sem evidência de anúncio' });
  });

  it('cancelado com o cupom de uma mensagem: fora da conta, como todo cancelado', () => {
    const d = detalheDoPedido(cancelado, ctx);
    expect(d.resultado).toEqual({ tipo: 'cancelado', campanha: null, plataforma: null });
    expect(d.evidencia.tom).toBe('cancelado');
    expect(d.linhaDoTempo.map((x) => x.oque)).toEqual(['Pedido confirmado no caixa']);
  });
});

describe('desenho do cartão com mensagens (o mesmo componente do navegador)', () => {
  const desenhar = (r: ClosedLoopResponse, modo: 'lite' | 'pro', podeVerMensagens: boolean) => {
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
            podeVerMensagens,
          }),
        }),
      ),
    );
  };
  const LINHA = '<b>12 pedidos vieram pelo cupom das mensagens de WhatsApp</b>: R$ 540,00 no caixa.';

  it('no modo simples, a linha fica embaixo da barra, uma vez só, com o atalho para Mensagens', () => {
    const html = desenhar(comMensagens(), 'lite', true);
    expect(html).not.toMatch(/NaN|undefined|\[object Object\]|Infinity|>null</);
    expect(html.match(/class="ms-linha"/g)).toHaveLength(1);
    expect(html).toContain(LINHA);
    expect(html).toContain('<a href="/mensagens">Ver em Mensagens</a>');
    expect(html).toContain('De onde vieram os 412 pedidos');
    // A nota do Pro já está no cartão, escondida até "Ver detalhes".
    expect(html).toContain('Fora desta conta: 12 pedidos do cardápio e do WhatsApp');
  });

  it('no Pro, a linha fica embaixo dos dois blocos, uma vez só', () => {
    const html = desenhar(comMensagens(), 'pro', true);
    expect(html.match(/class="ms-linha"/g)).toHaveLength(1);
    expect(html).toContain(LINHA);
    expect(html).toContain('34 de 101 pedidos do cardápio online e do WhatsApp não têm evidência de anúncio.');
    expect(html.indexOf('class="ms-linha"')).toBeGreaterThan(html.indexOf('Canais sem clique'));
  });

  it('quem não pode abrir Mensagens lê a linha, sem o atalho', () => {
    const html = desenhar(comMensagens(), 'lite', false);
    expect(html).toContain(LINHA);
    expect(html).not.toContain('href="/mensagens"');
  });

  it('sem cupom de mensagem no período, a tela é a aprovada', () => {
    for (const modo of ['lite', 'pro'] as const) {
      const html = desenhar(base7(), modo, true);
      expect(html).not.toContain('ms-linha');
      expect(html).not.toContain('cupom das mensagens');
      expect(html).not.toContain('Fora desta conta');
    }
  });
});
