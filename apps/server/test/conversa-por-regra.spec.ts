import type { AttentionItem, ClosedLoopResponse } from '@liame/contracts';
import { describe, expect, it } from 'vitest';
import { ITENS_POR_REGRA, LEITURA_DO_PEDIDO, reconhecerPedido, respostaPorRegra, type RespostaPorRegra } from '../src/ai/conversa/por-regra.js';
import { conferirResposta } from '../src/ai/conversa/resposta.js';
import { visaoDosAvisos } from '../src/ai/registro/leituras.visoes.js';
import { visaoDoCicloFechado } from '../src/ai/registro/visoes/ciclo-fechado.js';

// A conversa responde por regra o que o sistema já sabe (decisão do dono, 07/10/2026): o reconhecimento do pedido é de
// vocabulário fechado (uma palavra de fora manda para a IA) e a resposta sai da mesma leitura que a LIA faria, com
// todo número vindo da leitura ou declarado como calculado pelo código.

describe('conversa por regra: reconhecer o pedido', () => {
  it.each([
    ['Como foi a semana?', 'semana'],
    ['Oi, LIA! Como foi a semana?', 'semana'],
    ['Bom dia, como está o marketing?', 'semana'],
    ['Resumo da semana', 'semana'],
    ['me mostra os resultados', 'semana'],
    ['Quanto vendi?', 'semana'],
    ['Quanto investi?', 'semana'],
    ['Quanto gastei com anúncios nos últimos 7 dias?', 'semana'],
    ['Quanto sobrou?', 'semana'],
    ['Qual o ROAS?', 'semana'],
    ['Quantos pedidos vieram dos anúncios?', 'semana'],
    ['O marketing deu lucro?', 'semana'],
    ['Por que sobrou pouco?', 'semana'],
    ['Por que deu lucro?', 'semana'],
    ['Por que o marketing não se pagou?', 'semana'],
    ['Como estão as campanhas?', 'campanhas'],
    ['Qual campanha dá lucro?', 'campanhas'],
    ['Quais campanhas dão prejuízo?', 'campanhas'],
    ['Qual a melhor campanha?', 'campanhas'],
    ['Qual campanha vende mais?', 'campanhas'],
    ['O que precisa de mim?', 'avisos'],
    ['O que eu faço primeiro?', 'avisos'],
    ['Tem algum aviso?', 'avisos'],
    ['Tem algum problema?', 'avisos'],
    ['O que está errado?', 'avisos'],
    ['Tem alguma pendência hoje?', 'avisos'],
  ])('"%s" é um pedido conhecido (%s)', (texto, pedido) => {
    expect(reconhecerPedido(texto)).toBe(pedido);
  });

  it.each([
    // Cumprimento sozinho e o que continua a conversa de antes.
    'Oi',
    'E a campanha?',
    'E agora, como está?',
    'E onde foi esse gasto?',
    // Outro período, outro canal, o nome de uma campanha.
    'Como foi o mês?',
    'Como foi ontem?',
    'Como foi a semana passada?',
    'Quanto vendi no iFood?',
    'Quanto investi na Combo sexta?',
    // Decisão, conselho, análise e pedido de trabalho: é da IA.
    'Vale pausar a Combo sexta?',
    'Quanto devo investir?',
    'Como aumentar as vendas?',
    'O que eu faço para vender mais?',
    'Analise a semana para mim.',
    // O pedido que o botão "Pedir a análise da LIA" manda, depois de um resumo do sistema (web: `PEDIDO_DE_ANALISE`).
    'Analise esses números para mim.',
    'Por que tem pedido sem origem?',
    'Monte a pauta da semana.',
    'Quero uma promoção para sexta-feira com o combo. Pode montar?',
    'Proponha um cupom exclusivo de 10% para a Combo sexta',
    'Preciso de um relatório',
    // O que não é dos números.
    'Quero falar com uma pessoa.',
    'Desde quando a marca existe?',
    'Em quanto tempo o pedido chega?',
    'Quero falar sobre o trabalho do Analista de dados: o que ele fez este mês?',
    // Comprido demais para ser uma pergunta direta.
    'Quanto vendi e quanto gastei e quanto sobrou e qual o resultado do marketing e dos anúncios nos últimos 7 dias da semana',
  ])('"%s" vai para a IA', (texto) => {
    expect(reconhecerPedido(texto)).toBeNull();
  });

  it('cada pedido tem a leitura que o responde', () => {
    expect(LEITURA_DO_PEDIDO).toEqual({ semana: 'resultados_ciclo_fechado', campanhas: 'resultados_ciclo_fechado', avisos: 'atencao_avisos' });
  });
});

// ------------------------------------------------------------------ a resposta

const REAL = 1_000_000;
const confirmado = (o: { orders?: number; revenue?: number; margin?: number | null; coverage?: string | null; verdict?: string | null } = {}) => ({
  orders: o.orders ?? 0,
  revenue_micros: String((o.revenue ?? 0) * REAL),
  roas: null,
  cost_per_order_micros: null,
  margin_known_micros: o.margin === undefined || o.margin === null ? null : String(Math.round(o.margin * REAL)),
  margin_coverage_pct: o.coverage ?? null,
  verdict: o.verdict ?? null,
});
const informado = (spend: number) => ({ spend_micros: String(Math.round(spend * REAL)), value_micros: null, roas: null, window: '7d_click', conversions: null, conversations: null, cost_per_conversation_micros: null });
type Camp = { name: string; spend: number; orders?: number; revenue?: number; verdict?: string | null; provider?: string };
const campanha = (c: Camp, i: number) => ({
  campaign_id: `0192f0c4-7e3a-7c2e-9d1a-${String(i).padStart(12, '0')}`,
  provider: c.provider ?? 'meta_ads',
  name: c.name,
  status: 'ativa',
  platform: informado(c.spend),
  confirmed: confirmado({ orders: c.orders, revenue: c.revenue, margin: c.orders ? (c.revenue ?? 0) * 0.4 : null, coverage: c.orders ? '100.0' : null, verdict: c.verdict ?? null }),
});

function resultado(o: { spend: number; orders: number; revenue: number; margin?: number | null; coverage?: string | null; verdict?: string | null; todos?: number; semOrigem?: number; campanhas?: Camp[] }): ClosedLoopResponse {
  return {
    period: { from: '2026-09-30', to: '2026-10-06', timezone: 'America/Sao_Paulo', account_timezones: [] },
    model: { id: '0192f0c4-7e3a-7c2e-9d1a-1b2c3d4e5f60', key: 'ultimo_toque', version: 1, window_days: 7, counts_views: false },
    currency: 'BRL',
    totals: {
      spend_micros: String(Math.round(o.spend * REAL)),
      orders_confirmed: o.todos ?? o.orders,
      revenue_micros: String(o.revenue * REAL),
      confirmed: confirmado({ orders: o.orders, revenue: o.revenue, margin: o.margin, coverage: o.coverage, verdict: o.verdict }),
      without_origin: { orders: o.semOrigem ?? 0, revenue_micros: '0', share_pct: null },
      no_click_channels: [],
      cancelled: { orders: 0, revenue_micros: '0' },
    },
    platforms: [],
    campaigns: (o.campanhas ?? []).map(campanha),
    sources: [],
    generated_at: '2026-10-07T12:00:00.000Z',
  };
}

const textos = (r: RespostaPorRegra | null) => r!.resposta.blocos.map((b) => b.texto);
/** Todo número do texto está na leitura ou foi declarado como calculado (é o que a conversa confere antes de mostrar). */
function passa(r: RespostaPorRegra | null, leitura: unknown, nomes: string[] = []) {
  return conferirResposta(r!.resposta, { emDia: [leitura, r!.calculados.map((c) => c.valor)], velhas: [], nomes });
}

describe('conversa por regra: o dinheiro da semana', () => {
  const CAMPANHAS: Camp[] = [
    { name: 'Combo sexta', spend: 412.5, orders: 27, revenue: 1782, verdict: 'lucro' },
    { name: 'Busca hambúrguer perto', spend: 394.7, orders: 12, revenue: 804, verdict: 'prejuizo', provider: 'google_ads' },
    { name: 'Smash em dobro', spend: 279.8, orders: 9, revenue: 612, verdict: 'prejuizo' },
    { name: 'Delivery noite', spend: 153, orders: 0 },
  ];

  it('empatou: o que custou, o que voltou, quanto sobrou (calculado) e as campanhas de cada lado', () => {
    const leitura = visaoDoCicloFechado(resultado({ spend: 1240, orders: 55, revenue: 3605, margin: 1298.71, coverage: '82.9', verdict: 'empata', todos: 511, semOrigem: 46, campanhas: CAMPANHAS }));
    const r = respostaPorRegra('semana', leitura);
    expect(textos(r)).toEqual([
      'De 30/09/2026 a 06/10/2026, os anúncios custaram R$ 1.240,00 e trouxeram R$ 3.605,00 em 55 pedidos confirmados no caixa.',
      'O marketing se pagou, mas por pouco: a margem conhecida desses pedidos foi de R$ 1.298,71 e, depois de pagar os anúncios, sobraram R$ 58,71.',
      'Dá lucro: Combo sexta.',
      'Dá prejuízo: Busca hambúrguer perto e Smash em dobro.',
      'Somando todos os canais, a loja teve 511 pedidos confirmados no período; 46 deles, do cardápio e do WhatsApp, vieram sem prova de anúncio.',
    ]);
    expect(r!.calculados).toEqual([{ rotulo: 'Liame · margem conhecida − investimento · calculado pelo sistema', valor: 'R$ 58,71' }]);
    expect(r!.resposta.reuniao).toBeNull();
    expect(passa(r, leitura, CAMPANHAS.map((c) => c.name))).toBeNull();
    // Sem declarar o calculado, a conferência recusaria o número: ele não está na leitura.
    expect(conferirResposta(r!.resposta, { emDia: [leitura], velhas: [], nomes: [] })).toMatchObject({ recusa: 'numero_fora', detalhe: ['58,71'] });
  });

  it('lucro e prejuízo dizem o que sobrou e o que faltou', () => {
    const lucro = visaoDoCicloFechado(resultado({ spend: 1240, orders: 73, revenue: 4789, margin: 1996.9, coverage: '100.0', verdict: 'lucro' }));
    expect(textos(respostaPorRegra('semana', lucro))[1]).toBe('O marketing deu lucro: a margem conhecida desses pedidos foi de R$ 1.996,90 e, depois de pagar os anúncios, sobraram R$ 756,90.');
    const prejuizo = visaoDoCicloFechado(resultado({ spend: 1240, orders: 32, revenue: 2129, margin: 846.3, coverage: '100.0', verdict: 'prejuizo' }));
    const r = respostaPorRegra('semana', prejuizo);
    expect(textos(r)[1]).toBe('O marketing não se pagou: a margem conhecida desses pedidos foi de R$ 846,30, e faltaram R$ 393,70 para pagar os anúncios.');
    expect(passa(r, prejuizo)).toBeNull();
  });

  it('empate com a margem um pouco abaixo do gasto diz que faltou', () => {
    const leitura = visaoDoCicloFechado(resultado({ spend: 1000, orders: 10, revenue: 2500, margin: 950, coverage: '100.0', verdict: 'empata' }));
    expect(textos(respostaPorRegra('semana', leitura))[1]).toBe('O marketing se pagou, mas por pouco: a margem conhecida desses pedidos foi de R$ 950,00 e, depois de pagar os anúncios, faltaram R$ 50,00.');
  });

  it('margem incompleta: não diz se sobrou, e a porcentagem mínima entra como número do sistema', () => {
    const leitura = visaoDoCicloFechado(resultado({ spend: 1240, orders: 55, revenue: 3605, margin: 845.72, coverage: '57.8', verdict: null }));
    const r = respostaPorRegra('semana', leitura);
    expect(textos(r)[1]).toBe('Ainda não dá para dizer se sobrou: só 57,8% da receita tem o custo dos produtos cadastrado no Regem, e o Liame só diz se deu lucro a partir de 80%.');
    expect(r!.calculados).toEqual([{ rotulo: 'Liame · parte mínima da receita com custo cadastrado para dizer se deu lucro', valor: '80%' }]);
    expect(passa(r, leitura)).toBeNull();
    const semCusto = visaoDoCicloFechado(resultado({ spend: 1240, orders: 55, revenue: 3605, margin: null, coverage: null, verdict: null }));
    expect(textos(respostaPorRegra('semana', semCusto))[1]).toBe('Ainda não dá para dizer se sobrou: nenhuma dessas vendas tem o custo dos produtos cadastrado no Regem.');
  });

  it('sem pedido, sem gasto e pedido sem gasto: uma frase só, sem veredito', () => {
    const semPedido = visaoDoCicloFechado(resultado({ spend: 1240, orders: 0, revenue: 0, todos: 511, semOrigem: 99 }));
    expect(textos(respostaPorRegra('semana', semPedido))).toEqual([
      'De 30/09/2026 a 06/10/2026, os anúncios custaram R$ 1.240,00, e nenhum pedido confirmado no caixa veio com prova de anúncio.',
      'Somando todos os canais, a loja teve 511 pedidos confirmados no período; 99 deles, do cardápio e do WhatsApp, vieram sem prova de anúncio.',
    ]);
    const nada = visaoDoCicloFechado(resultado({ spend: 0, orders: 0, revenue: 0 }));
    expect(textos(respostaPorRegra('semana', nada))).toEqual(['De 30/09/2026 a 06/10/2026, não houve gasto com anúncios nem pedido com prova de anúncio.']);
    const semGasto = visaoDoCicloFechado(resultado({ spend: 0, orders: 1, revenue: 68, todos: 2, semOrigem: 1 }));
    const r = respostaPorRegra('semana', semGasto);
    expect(textos(r)).toEqual([
      'De 30/09/2026 a 06/10/2026, não houve gasto com anúncios. Mesmo assim, 1 pedido confirmado no caixa veio com prova de anúncio, somando R$ 68,00.',
      'Somando todos os canais, a loja teve 2 pedidos confirmados no período; 1 deles, do cardápio ou do WhatsApp, veio sem prova de anúncio.',
    ]);
    expect(passa(r, semGasto)).toBeNull();
  });

  it('leitura sem o período ou sem o investimento: a regra não responde (segue para a IA)', () => {
    expect(respostaPorRegra('semana', {})).toBeNull();
    expect(respostaPorRegra('semana', { periodo: { de: '30/09/2026', ate: '06/10/2026' }, totais: {} })).toBeNull();
    expect(respostaPorRegra('semana', 'erro')).toBeNull();
    expect(respostaPorRegra('campanhas', { campanhas: [] })).toBeNull();
    expect(respostaPorRegra('avisos', {})).toBeNull();
  });

  it('cada campanha, da que mais gastou para a que menos gastou, com o que sobra dito em palavras', () => {
    const leitura = visaoDoCicloFechado(resultado({ spend: 1240, orders: 48, revenue: 3198, campanhas: CAMPANHAS }));
    const r = respostaPorRegra('campanhas', leitura);
    expect(textos(r)).toEqual([
      'De 30/09/2026 a 06/10/2026, por campanha, da que mais gastou para a que menos gastou:',
      'Combo sexta (Meta): R$ 412,50 de anúncio e R$ 1.782,00 em 27 pedidos confirmados; deu lucro.',
      'Busca hambúrguer perto (Google Ads): R$ 394,70 de anúncio e R$ 804,00 em 12 pedidos confirmados; deu prejuízo.',
      'Smash em dobro (Meta): R$ 279,80 de anúncio e R$ 612,00 em 9 pedidos confirmados; deu prejuízo.',
      'Delivery noite (Meta): R$ 153,00 de anúncio, sem pedido confirmado no caixa.',
    ]);
    expect(r!.resposta.blocos.map((b) => b.tipo)).toEqual(['paragrafo', 'item', 'item', 'item', 'item']);
    expect(passa(r, leitura, CAMPANHAS.map((c) => c.name))).toBeNull();
    expect(textos(respostaPorRegra('campanhas', visaoDoCicloFechado(resultado({ spend: 0, orders: 0, revenue: 0 }))))).toEqual(['De 30/09/2026 a 06/10/2026, nenhuma campanha gastou nem teve pedido confirmado no caixa.']);
  });

  it('campanhas demais: lista as primeiras e diz quantas ficaram de fora (número do sistema)', () => {
    const muitas = Array.from({ length: ITENS_POR_REGRA.campanhas + 3 }, (_, i): Camp => ({ name: `Campanha ${String.fromCharCode(65 + i)}`, spend: 900 - i * 10 }));
    const leitura = visaoDoCicloFechado(resultado({ spend: 5000, orders: 0, revenue: 0, campanhas: muitas }));
    const r = respostaPorRegra('campanhas', leitura);
    expect(r!.resposta.blocos).toHaveLength(ITENS_POR_REGRA.campanhas + 2);
    expect(textos(r).at(-1)).toBe('Há mais 3 campanhas, com gasto menor; a lista inteira está em Resultados.');
    expect(r!.calculados).toEqual([{ rotulo: 'Liame · campanhas além das listadas · contadas pelo sistema', valor: '3' }]);
    expect(passa(r, leitura, muitas.map((c) => c.name))).toBeNull();
  });
});

describe('conversa por regra: o que pede alguém agora', () => {
  const aviso = (severity: string, title: string, detail: string): AttentionItem => ({ kind: 'teste', severity, title, detail, action: '', connected_account_id: null, campaign_id: null, provider: null, brand_id: null });
  const visao = (itens: AttentionItem[]) => visaoDosAvisos(itens, '2026-10-07T12:00:00.000Z', 'America/Sao_Paulo');

  it('os críticos e os de atenção, do mais grave para o menos grave; informação não pede ninguém', () => {
    const leitura = visao([
      aviso('info', 'Leitura feita', 'Tudo certo.'),
      aviso('atencao', 'O cupom SMASH10 não foi usado', 'A Smash em dobro gastou R$ 279,80 em 7 dias, e nenhum pedido veio com o cupom.'),
      aviso('critica', 'A Delivery noite parou de aparecer para as pessoas.', 'Nenhuma impressão ontem.'),
    ]);
    const r = respostaPorRegra('avisos', leitura);
    expect(textos(r)).toEqual([
      '2 avisos pedem você agora, do mais grave para o menos grave:',
      'Urgente: A Delivery noite parou de aparecer para as pessoas. Nenhuma impressão ontem.',
      'Atenção: O cupom SMASH10 não foi usado. A Smash em dobro gastou R$ 279,80 em 7 dias, e nenhum pedido veio com o cupom.',
    ]);
    expect(r!.calculados).toEqual([{ rotulo: 'Liame · avisos críticos e de atenção · contados pelo sistema', valor: '2' }]);
    expect(passa(r, leitura)).toBeNull();
  });

  it('um aviso só, nenhum aviso e aviso demais', () => {
    expect(textos(respostaPorRegra('avisos', visao([aviso('critica', 'A conta da Meta parou de ler', 'Reconecte a conta.')])))).toEqual(['Um aviso pede você agora:', 'Urgente: A conta da Meta parou de ler. Reconecte a conta.']);
    const nada = respostaPorRegra('avisos', visao([aviso('info', 'Leitura feita', 'Tudo certo.')]));
    expect(textos(nada)).toEqual(['Nada precisa de você agora: o sistema não tem aviso crítico nem de atenção para esta marca.']);
    expect(nada!.calculados).toEqual([]);
    const muitos = visao(Array.from({ length: ITENS_POR_REGRA.avisos + 2 }, (_, i) => aviso('atencao', `Aviso ${String.fromCharCode(65 + i)}`, 'x'.repeat(900))));
    const r = respostaPorRegra('avisos', muitos);
    expect(r!.resposta.blocos).toHaveLength(ITENS_POR_REGRA.avisos + 2);
    expect(textos(r).at(-1)).toBe('Os outros estão na Atenção.');
    // O detalhe comprido é cortado: cada bloco cabe no limite da resposta.
    expect(Math.max(...textos(r).map((t) => t.length))).toBeLessThanOrEqual(600);
    expect(passa(r, muitos)).toBeNull();
  });
});
