import type { ClosedLoopResponse } from '@liame/contracts';
import { describe, expect, it } from 'vitest';
import { contextoDosResultados, periodoAnterior, variacao } from '../src/ai/explicar/contexto.js';
import { conferirExplicacao, type Explicacao, LIMITES } from '../src/ai/explicar/resposta.js';
import { explicacaoSemIa } from '../src/ai/explicar/sem-ia.js';
import { limparTexto } from '../src/ai/sanitizar.js';
import { conferirNumeros, formaDoNumero, numerosDe } from '../src/ai/verificador-numeros.js';

const U = (n: number) => `0199a300-0000-7000-8000-${n.toString().padStart(12, '0')}`;

/** Resultado de um período, com o que muda de um cenário para o outro. */
function resultado(extra: { from?: string; to?: string; spend?: string; orders?: number; revenue?: string; roas?: string | null; verdict?: string | null; semOrigem?: number; campanhas?: boolean; frescor?: string } = {}): ClosedLoopResponse {
  const spend = extra.spend ?? '960000000';
  const orders = extra.orders ?? 38;
  const revenue = extra.revenue ?? '2496000000';
  const roas = extra.roas === undefined ? '2.60' : extra.roas;
  const caixa = { orders, revenue_micros: revenue, roas, cost_per_order_micros: orders ? '25263158' : null, margin_known_micros: '1100000000', margin_coverage_pct: '83.4', verdict: extra.verdict === undefined ? 'lucro' : extra.verdict };
  const informa = { spend_micros: spend, value_micros: '12060000000', roas: '12.56', window: '7d_click', conversions: '41', conversations: null, cost_per_conversation_micros: null };
  return {
    period: { from: extra.from ?? '2026-09-18', to: extra.to ?? '2026-10-01', timezone: 'America/Sao_Paulo', account_timezones: ['America/Sao_Paulo'] },
    model: { id: U(1), key: 'ultimo_toque', version: 1, window_days: 7, counts_views: false },
    currency: 'BRL',
    totals: {
      spend_micros: spend,
      orders_confirmed: 1250,
      revenue_micros: '81250000000',
      confirmed: caixa,
      without_origin: { orders: extra.semOrigem ?? 410, revenue_micros: '26650000000', share_pct: '61.2' },
      no_click_channels: [{ channel_group: 'marketplace', orders: 580, revenue_micros: '37700000000' }],
      cancelled: { orders: 3, revenue_micros: '195000000' },
    },
    platforms: extra.campanhas === false ? [] : [{ provider: 'meta_ads', platform: informa, confirmed: caixa, platform_only_orders: 2 }],
    campaigns: extra.campanhas === false ? [] : [{ campaign_id: U(2), provider: 'meta_ads', name: 'Tráfego | Cardápio', status: 'ativa', platform: informa, confirmed: caixa }],
    sources: [
      { connected_account_id: U(8), provider: 'meta_ads', name: 'CA - Pizzaria', dataset: 'metricas', freshness: extra.frescor ?? 'fresh', last_success_at: '2026-10-02T04:54:16.000Z', status: 'ativa', timezone: 'America/Sao_Paulo' },
      { connected_account_id: U(9), provider: 'regem', name: 'Loja Centro', dataset: 'pedidos', freshness: 'fresh', last_success_at: '2026-10-02T04:39:19.000Z', status: 'ativa', timezone: 'America/Sao_Paulo' },
    ],
    generated_at: '2026-10-02T05:00:00.000Z',
  };
}
const anterior = () => resultado({ from: '2026-09-04', to: '2026-09-17', spend: '784000000', orders: 58, revenue: '3793000000', roas: '4.84' });

describe('verificador de números (A3-5): a IA só cita o que o código entregou', () => {
  it('a forma única de um número, do jeito que se escreve em português', () => {
    expect(['1.250,00', '1.250', '1250', '12,56', '83,4', '0,10', '09', '2.6', '12.56', '1.234.567', '0', '007', '3,80'].map(formaDoNumero)).toEqual([
      '1250', '1250', '1250', '12.56', '83.4', '0.1', '9', '2.6', '12.56', '1234567', '0', '7', '3.8',
    ]);
    // A data conta inteira (com a hora, quando vem junto): os dígitos dela não viram números soltos.
    expect(numerosDe('De 18/09/2026 a 01/10/2026 o investimento foi de R$ 960,00 (ROAS 2,60), +22,4%, lido em 02/10/2026 01:54.')).toEqual([
      'data:18/09/2026', 'data:01/10/2026', 'data:02/10/2026 01:54', '960', '2.6', '22.4',
    ]);
    expect(numerosDe('sem número nenhum')).toEqual([]);
  });

  it('o dia e o mês de uma data não autorizam número solto; a data vale inteira, com ou sem a hora', () => {
    const contexto = { periodo: { de: '18/09/2026', ate: '01/10/2026' }, ultima_leitura: '02/10/2026 01:54', pedidos: '38' };
    expect(conferirNumeros('Subiu 10% desde 18/09/2026, com 38 pedidos; lido em 02/10/2026.', contexto)).toEqual({ ok: false, fora: ['10'] });
    expect(conferirNumeros('De 18/09/2026 a 01/10/2026, lido em 02/10/2026 01:54.', contexto)).toEqual({ ok: true, fora: [] });
    expect(conferirNumeros('Desde 17/09/2026 e em 18/09.', contexto)).toEqual({ ok: false, fora: ['17/09/2026', '18', '09'] });
  });

  it('passa quando todo número está no contexto, em qualquer formato equivalente, e aponta os que não estão', () => {
    const contexto = { investimento: 'R$ 960,00', pedidos: '38', roas: '2,60', variacao: '+22,4%', periodo: { de: '18/09/2026' }, lista: [{ receita: 'R$ 2.496,00' }], janela_em_dias: 7 };
    expect(conferirNumeros('O investimento de R$ 960,00 trouxe 38 pedidos e R$ 2.496 de receita; ROAS de 2,6 desde 18/09/2026, em 7 dias.', contexto)).toEqual({ ok: true, fora: [] });
    expect(conferirNumeros(['Subiu 22,4%.', 'Sem números aqui.'], contexto)).toEqual({ ok: true, fora: [] });
    // Conta feita pela IA (2.496 ÷ 38), arredondamento e número de fora: nada disso está no contexto.
    expect(conferirNumeros('Cada pedido rendeu R$ 65,68, cerca de R$ 1 mil no total, 34% a menos.', contexto)).toEqual({ ok: false, fora: ['65,68', '1', '34'] });
    expect(conferirNumeros({ o_que_aconteceu: 'Foram 39 pedidos.', motivos: ['ROAS 2,60'] }, contexto)).toEqual({ ok: false, fora: ['39'] });
  });
});

describe('contexto da explicação: a comparação com o período anterior é do código', () => {
  it('o período anterior tem o mesmo tamanho e termina na véspera', () => {
    expect(periodoAnterior('2026-09-18', '2026-10-01')).toEqual({ from: '2026-09-04', to: '2026-09-17' });
    expect(periodoAnterior('2026-10-01', '2026-10-01')).toEqual({ from: '2026-09-30', to: '2026-09-30' });
    expect(periodoAnterior('2026-03-01', '2026-03-31')).toEqual({ from: '2026-01-29', to: '2026-02-28' });
  });

  it('variação com uma casa e sinal, em inteiros; sem valor antes não há porcentagem', () => {
    expect([variacao(960n, 784n), variacao(2496n, 3793n), variacao(100n, 100n), variacao(1n, 3n), variacao(0n, 50n), variacao(2999n, 3000n)]).toEqual(['+22,4%', '-34,2%', '0,0%', '-66,7%', '-100,0%', '0,0%']);
    expect([variacao(50n, 0n), variacao(0n, 0n)]).toEqual([null, null]);
    expect(variacao(9007199254740993000n, 3002399751580331000n)).toBe('+200,0%');
  });

  it('monta a comparação campo a campo; sem período anterior com dado, não compara', () => {
    const c = contextoDosResultados(resultado(), anterior());
    expect(c.comparacao).toEqual({
      periodo_anterior: { de: '04/09/2026', ate: '17/09/2026' },
      investimento: { antes: 'R$ 784,00', agora: 'R$ 960,00', variacao: '+22,4%' },
      pedidos_confirmados: { antes: '1.250', agora: '1.250', variacao: '0,0%' },
      receita_confirmada: { antes: 'R$ 81.250,00', agora: 'R$ 81.250,00', variacao: '0,0%' },
      pedidos_com_origem: { antes: '58', agora: '38', variacao: '-34,5%' },
      receita_com_origem: { antes: 'R$ 3.793,00', agora: 'R$ 2.496,00', variacao: '-34,2%' },
      roas_confirmado: { antes: '4,84', agora: '2,60', variacao: '-46,3%' },
    });
    expect(c.fontes_fora_do_dia).toEqual([]);
    expect(contextoDosResultados(resultado(), null).comparacao).toBeNull();
    const vazio = resultado({ spend: '0', orders: 0 });
    vazio.totals.orders_confirmed = 0;
    expect(contextoDosResultados(resultado(), vazio).comparacao).toBeNull();
    // Fonte atrasada aparece para a explicação não sair com dado velho.
    expect(contextoDosResultados(resultado({ frescor: 'stale' }), null).fontes_fora_do_dia).toEqual([{ plataforma: 'Meta', conta: 'CA - Pizzaria', frescor: 'parado' }]);
    // Nada no contexto parece dado pessoal para a limpeza do gateway.
    expect(limparTexto(JSON.stringify(c)).removidos).toBe(0);
  });
});

describe('explicação sem IA (A3-6): o mesmo formato, por regra, sempre com número do contexto', () => {
  const cenarios: Array<[string, ReturnType<typeof contextoDosResultados>]> = [
    ['com comparação e lucro', contextoDosResultados(resultado(), anterior())],
    ['prejuízo', contextoDosResultados(resultado({ verdict: 'prejuizo' }), anterior())],
    ['sem período anterior', contextoDosResultados(resultado(), null)],
    ['sem investimento nem campanha', contextoDosResultados(resultado({ spend: '0', orders: 0, revenue: '0', roas: null, verdict: null, campanhas: false, semOrigem: 0 }), null)],
    ['fonte fora do dia', contextoDosResultados(resultado({ frescor: 'delayed', verdict: null }), anterior())],
  ];

  it.each(cenarios)('%s: passa na mesma conferência que a resposta da IA', (_nome, contexto) => {
    const e = explicacaoSemIa(contexto);
    expect(conferirExplicacao(e, contexto)).toBeNull();
    expect(e.motivos.length).toBeGreaterThanOrEqual(1);
    expect(e.o_que_fazer.length).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(e)).not.toContain('undefined');
    expect(JSON.stringify(e)).not.toContain('null');
  });

  it('diz o que os números dizem: investimento, pedidos, ROAS do caixa, a comparação e o risco', () => {
    const e = explicacaoSemIa(contextoDosResultados(resultado(), anterior()));
    expect(e.o_que_aconteceu).toBe(
      'De 18/09/2026 a 01/10/2026 o investimento em anúncios foi de R$ 960,00 e o caixa confirmou 38 pedido(s) com origem provada em campanha, com receita de R$ 2.496,00. ' +
        'O ROAS confirmado no caixa foi 2,60 (quanto voltou em vendas para cada real investido). ' +
        'Em relação ao período anterior, o investimento subiu 22,4% e a receita com origem provada caiu 34,2%.',
    );
    expect(e.motivos).toEqual([
      'A campanha com mais investimento foi "Tráfego | Cardápio" (R$ 960,00), com 38 pedido(s) confirmado(s) no caixa.',
      'A Meta informa ROAS de 12,56; o caixa confirma 2,60. Para decidir, vale o do caixa.',
      '410 pedido(s) dos canais com clique ficaram sem origem provada (61,2%): não dá para dizer de que campanha vieram.',
    ]);
    expect(e.risco).toBe('baixo');
    expect(explicacaoSemIa(contextoDosResultados(resultado({ verdict: 'prejuizo' }), anterior())).risco).toBe('alto');
    // Sem veredito do caixa, investimento subindo e receita caindo é risco alto; sem comparação, médio.
    expect(explicacaoSemIa(contextoDosResultados(resultado({ verdict: null }), anterior())).risco).toBe('alto');
    expect(explicacaoSemIa(contextoDosResultados(resultado({ verdict: null }), null)).risco).toBe('medio');
    expect(explicacaoSemIa(contextoDosResultados(resultado({ spend: '0', orders: 0, revenue: '0', roas: null, verdict: null, campanhas: false, semOrigem: 0 }), null))).toEqual({
      o_que_aconteceu: 'De 18/09/2026 a 01/10/2026 não houve investimento em anúncios lido pelo Liame.',
      motivos: ['Ainda não há campanha com investimento e pedido confirmado neste período para comparar.'],
      risco: 'medio',
      o_que_fazer: ['Acompanhe os avisos da Atenção: eles apontam o que precisa de você.'],
    });
  });
});

describe('conferência da resposta da IA: o que não serve para a tela', () => {
  const contexto = contextoDosResultados(resultado(), anterior());
  const boa: Explicacao = {
    o_que_aconteceu: 'O investimento subiu 22,4% (de R$ 784,00 para R$ 960,00) e a receita com origem provada caiu 34,2%.',
    motivos: ['A Meta informa ROAS de 12,56, mas o caixa confirma 2,60.', 'Só 38 pedidos têm origem provada; 410 ficaram sem origem.'],
    risco: 'alto',
    o_que_fazer: ['Revise a campanha "Tráfego | Cardápio" antes de aumentar a verba.'],
  };

  it('aceita a resposta que só usa números do contexto', () => {
    expect(conferirExplicacao(boa, contexto)).toBeNull();
  });

  it('recusa número inventado ou calculado, texto vazio, resposta longa e trecho proibido', () => {
    expect(conferirExplicacao({ ...boa, motivos: ['Cada pedido custou R$ 25,30 e a queda foi de 176 reais.'] }, contexto)).toEqual({ recusa: 'numero_fora', detalhe: ['25,30', '176'] });
    expect(conferirExplicacao({ ...boa, o_que_aconteceu: '   ' }, contexto)).toEqual({ recusa: 'vazia', detalhe: [] });
    expect(conferirExplicacao({ ...boa, motivos: [] }, contexto)).toEqual({ recusa: 'vazia', detalhe: [] });
    expect(conferirExplicacao({ ...boa, o_que_fazer: ['ok', ''] }, contexto)).toEqual({ recusa: 'vazia', detalhe: [] });
    expect(conferirExplicacao({ ...boa, o_que_aconteceu: 'a'.repeat(LIMITES.o_que_aconteceu + 1) }, contexto)).toEqual({ recusa: 'longa', detalhe: [] });
    expect(conferirExplicacao({ ...boa, motivos: Array.from({ length: LIMITES.motivos + 1 }, () => 'Motivo sem número.') }, contexto)).toEqual({ recusa: 'longa', detalhe: [] });
    expect(conferirExplicacao({ ...boa, o_que_fazer: ['Veja em https://exemplo.com como arrumar.'] }, contexto)).toEqual({ recusa: 'trecho_proibido', detalhe: ['https://'] });
    expect(conferirExplicacao({ ...boa, o_que_aconteceu: 'A IA decidiu pausar a campanha.' }, contexto)).toEqual({ recusa: 'trecho_proibido', detalhe: ['a ia decidiu'] });
  });
});
