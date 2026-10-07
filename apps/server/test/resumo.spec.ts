import type { AttentionItem, ClosedLoopResponse } from '@liame/contracts';
import { describe, expect, it } from 'vitest';
import { avisosQuePrecisam, campanhasDoVeredito, dinheiroDoResumo, pedidosDoResumo, plataformasDoResumo, sobrou } from '../src/resumo/resumo.js';

// A3 · I13c: o Resumo. Os blocos saem dos mesmos resultados da tela Resultados: o que sobrou só com a margem
// conhecida em 80% da receita; as campanhas de cada lado do veredito; os pedidos; os avisos que pedem alguém.

const confirmado = (o: { orders?: number; revenue?: number; margin?: number | null; coverage?: string | null; verdict?: string | null } = {}) => ({
  orders: o.orders ?? 0,
  revenue_micros: String(o.revenue ?? 0),
  roas: null,
  cost_per_order_micros: null,
  margin_known_micros: o.margin === undefined ? null : o.margin === null ? null : String(o.margin),
  margin_coverage_pct: o.coverage === undefined ? null : o.coverage,
  verdict: o.verdict ?? null,
});
const plataforma = (spend: number) => ({ spend_micros: String(spend), value_micros: null, roas: null, window: '7d_click', conversions: null, conversations: null, cost_per_conversation_micros: null });
const campanha = (id: string, name: string, spend: number, verdict: string | null) => ({
  campaign_id: id,
  provider: 'meta_ads',
  name,
  status: 'ativa',
  platform: plataforma(spend),
  confirmed: confirmado({ verdict }),
});

function resultado(o: { spend: number; orders: number; revenue: number; margin: number | null; coverage: string | null; verdict: string | null; all?: number; semOrigem?: number }): ClosedLoopResponse {
  return {
    period: { from: '2026-09-26', to: '2026-10-02', timezone: 'America/Sao_Paulo', account_timezones: [] },
    model: { id: '0192f0c4-7e3a-7c2e-9d1a-1b2c3d4e5f60', key: 'ultimo_toque', version: 1, window_days: 7, counts_views: false },
    currency: 'BRL',
    totals: {
      spend_micros: String(o.spend),
      orders_confirmed: o.all ?? o.orders,
      revenue_micros: String(o.revenue),
      confirmed: confirmado({ orders: o.orders, revenue: o.revenue, margin: o.margin, coverage: o.coverage, verdict: o.verdict }),
      without_origin: { orders: o.semOrigem ?? 0, revenue_micros: '0', share_pct: null },
      no_click_channels: [],
      cancelled: { orders: 0, revenue_micros: '0' },
    },
    platforms: [
      { provider: 'meta_ads', platform: plataforma(o.spend), confirmed: confirmado({ orders: o.orders, revenue: o.revenue, margin: o.margin, coverage: o.coverage }), platform_only_orders: 0 },
    ],
    campaigns: [],
    sources: [],
    generated_at: '2026-10-03T12:00:00.000Z',
  };
}

const aviso = (kind: string, severity: string): AttentionItem => ({ kind, severity, title: kind, detail: '', action: '', connected_account_id: null, campaign_id: null, provider: null, brand_id: null });

describe('Resumo (A3, I13c)', () => {
  it('o que sobrou: margem conhecida menos o gasto, só com a margem cobrindo 80% da receita', () => {
    expect(sobrou(confirmado({ margin: 80_000_000, coverage: '100.0' }), '100000000')).toBe('-20000000');
    expect(sobrou(confirmado({ margin: 380_000_000, coverage: '80.0' }), '200000000')).toBe('180000000');
    expect(sobrou(confirmado({ margin: 380_000_000, coverage: '79.9' }), '200000000')).toBeNull();
    expect(sobrou(confirmado({ margin: null, coverage: null }), '0')).toBeNull();
  });

  it('o dinheiro do marketing, com a semana anterior quando há', () => {
    const atual = resultado({ spend: 100_000_000, orders: 2, revenue: 120_000_000, margin: 80_000_000, coverage: '100.0', verdict: 'prejuizo' });
    const anterior = resultado({ spend: 80_000_000, orders: 1, revenue: 100_000_000, margin: 70_000_000, coverage: '100.0', verdict: 'empata' });
    expect(dinheiroDoResumo(atual, anterior)).toEqual({
      revenue_micros: { now: '120000000', before: '100000000' },
      spend_micros: { now: '100000000', before: '80000000' },
      left_micros: { now: '-20000000', before: '-10000000' },
      margin_known_micros: '80000000',
      margin_coverage_pct: '100.0',
      verdict: 'prejuizo',
    });
    expect(dinheiroDoResumo(atual, null)).toMatchObject({ revenue_micros: { before: null }, spend_micros: { before: null }, left_micros: { now: '-20000000', before: null } });
    // A receita com margem conhecida acompanha quando os resultados a trazem (é o que separa o custo dos produtos do que não tem custo).
    const comCusto = { ...atual, totals: { ...atual.totals, confirmed: { ...atual.totals.confirmed, revenue_with_margin_micros: '96000000' } } };
    expect(dinheiroDoResumo(comCusto, null).revenue_with_margin_micros).toBe('96000000');
    expect('revenue_with_margin_micros' in dinheiroDoResumo(atual, null)).toBe(false);
  });

  it('as campanhas de cada lado do veredito, as de maior gasto primeiro, até três', () => {
    const r = resultado({ spend: 0, orders: 0, revenue: 0, margin: null, coverage: null, verdict: null });
    const ids = (n: number) => `0192f0c4-7e3a-7c2e-9d1a-1b2c3d4e5f${String(n).padStart(2, '0')}`;
    r.campaigns = [
      campanha(ids(1), 'Combo sexta', 200, 'lucro'),
      campanha(ids(2), 'Smash em dobro', 300, 'prejuizo'),
      campanha(ids(3), 'Busca', 150, 'prejuizo'),
      campanha(ids(4), 'Delivery noite', 400, 'prejuizo'),
      campanha(ids(5), 'Almoço', 50, 'prejuizo'),
      campanha(ids(6), 'Sem veredito', 999, null),
      campanha(ids(7), 'Empate', 500, 'empata'),
    ];
    const v = campanhasDoVeredito(r);
    expect(v.profit.map((c) => c.name)).toEqual(['Combo sexta']);
    expect(v.loss.map((c) => c.name)).toEqual(['Delivery noite', 'Smash em dobro', 'Busca']);
    expect(v.loss[0]).toEqual({ campaign_id: ids(4), name: 'Delivery noite', provider: 'meta_ads' });
  });

  it('os pedidos e as plataformas', () => {
    const r = resultado({ spend: 100_000_000, orders: 3, revenue: 100_000_000, margin: 80_000_000, coverage: '100.0', verdict: 'prejuizo', all: 41, semOrigem: 6 });
    expect(pedidosDoResumo(r)).toEqual({ marketing: 3, average_micros: '33333333', all_channels: 41, without_origin: 6 });
    expect(pedidosDoResumo(resultado({ spend: 0, orders: 0, revenue: 0, margin: null, coverage: null, verdict: null })).average_micros).toBeNull();
    expect(plataformasDoResumo(r)).toEqual([{ provider: 'meta_ads', orders: 3, left_micros: '-20000000', spend_micros: '100000000' }]);
  });

  it('"Precisa de você": só crítico e atenção, o mais grave primeiro, mídia antes na mesma gravidade, até cinco', () => {
    const midia = [aviso('dado_atrasado', 'atencao'), aviso('versao_api', 'info'), aviso('conta_desconectada', 'critica')];
    const ciclo = [aviso('cupom_sem_uso', 'atencao'), aviso('plataforma_x_caixa', 'info'), aviso('campanha_sem_pedido', 'atencao'), aviso('vendas_fora_do_normal', 'critica'), aviso('sugestao_reduzir_verba', 'atencao')];
    const p = avisosQuePrecisam(midia, ciclo);
    expect([p.critical, p.attention]).toEqual([2, 4]);
    expect(p.items.map((i) => i.kind)).toEqual(['conta_desconectada', 'vendas_fora_do_normal', 'dado_atrasado', 'cupom_sem_uso', 'campanha_sem_pedido']);
    expect(avisosQuePrecisam([], [aviso('plataforma_x_caixa', 'info')])).toEqual({ critical: 0, attention: 0, items: [] });
  });
});
