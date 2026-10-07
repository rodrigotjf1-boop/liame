import type { ClosedLoopResponse, ConfirmedResult, PlatformReport, SourceFreshness } from '@liame/contracts';

// Dados de exemplo da tela de Resultados (os números do protótipo P1), usados por `resultados.spec.ts` e por
// `resultados-graficos.spec.ts`. Datas fixas (LIC-006).

export const sp = (s: string) => s.replaceAll(' ', ' ');
/** "412.50" → micros em texto, exato. */
export const micros = (reais: string) => {
  const [i = '0', f = ''] = reais.split('.');
  return (BigInt(i) * 1_000_000n + BigInt((f + '000000').slice(0, 6))).toString();
};
/** 29/09/2026 14:20 em Brasília. */
export const AGORA = '2026-09-29T17:20:00.000Z';
export const uuid = (n: number) => `a0000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

export const confirmado = (over: Partial<ConfirmedResult> = {}): ConfirmedResult => ({
  orders: 0,
  revenue_micros: '0',
  roas: null,
  cost_per_order_micros: null,
  margin_known_micros: null,
  margin_coverage_pct: null,
  verdict: null,
  ...over,
});
export const plataforma = (over: Partial<PlatformReport> = {}): PlatformReport => ({
  spend_micros: '0',
  value_micros: null,
  roas: null,
  window: '7d_click',
  conversions: null,
  conversations: null,
  cost_per_conversation_micros: null,
  ...over,
});
export const fonte = (provider: string, over: Partial<SourceFreshness> = {}): SourceFreshness => ({
  connected_account_id: uuid(provider === 'meta_ads' ? 1 : provider === 'google_ads' ? 2 : 3),
  provider,
  name: provider === 'regem' ? 'Loja Centro' : provider === 'meta_ads' ? 'CA - Mister Burguer' : 'Mister Burgers Ads',
  dataset: provider === 'regem' ? 'pedidos' : 'metricas',
  freshness: 'fresh',
  last_success_at: provider === 'regem' ? '2026-09-29T17:05:00.000Z' : provider === 'meta_ads' ? '2026-09-29T09:12:00.000Z' : '2026-09-29T09:20:00.000Z',
  status: 'ativa',
  timezone: 'America/Sao_Paulo',
  ...over,
});

/** 7 dias completos, com a loja, a Meta e o Google em dia (números do protótipo, arredondados). */
export function base7(): ClosedLoopResponse {
  return {
    period: { from: '2026-09-22', to: '2026-09-28', timezone: 'America/Sao_Paulo', account_timezones: ['America/Sao_Paulo'] },
    model: { id: '0199a000-0000-7000-8000-000000000001', key: 'ultimo_toque', version: 1, window_days: 7, counts_views: false },
    currency: 'BRL',
    totals: {
      spend_micros: micros('1240.00'),
      orders_confirmed: 412,
      revenue_micros: micros('24851.00'),
      confirmed: confirmado({
        orders: 55,
        revenue_micros: micros('3605.00'),
        roas: '2.91',
        cost_per_order_micros: '22545454',
        margin_known_micros: micros('1298.71'),
        margin_coverage_pct: '85.0',
        verdict: 'empata',
      }),
      without_origin: { orders: 46, revenue_micros: micros('2956.00'), share_pct: '45.5' },
      no_click_channels: [
        { channel_group: 'marketplace', orders: 250, revenue_micros: micros('15000.00') },
        { channel_group: 'presencial', orders: 61, revenue_micros: micros('3290.00') },
      ],
      cancelled: { orders: 2, revenue_micros: micros('142.00') },
    },
    platforms: [
      {
        provider: 'google_ads',
        platform: plataforma({ spend_micros: micros('394.70'), value_micros: micros('1342.00'), roas: '3.40', window: 'padrao', conversions: '12' }),
        confirmed: confirmado({ orders: 12, revenue_micros: micros('804.00'), roas: '2.04', cost_per_order_micros: '32891666', margin_known_micros: micros('290.40'), margin_coverage_pct: '86.0', verdict: 'prejuizo' }),
        platform_only_orders: 0,
      },
      {
        provider: 'meta_ads',
        platform: plataforma({ spend_micros: micros('845.30'), value_micros: micros('3132.00'), roas: '3.71', conversions: '38', conversations: '141', cost_per_conversation_micros: '5995035' }),
        confirmed: confirmado({ orders: 43, revenue_micros: micros('2801.00'), roas: '3.31', cost_per_order_micros: '19658139', margin_known_micros: micros('1008.31'), margin_coverage_pct: '84.0', verdict: 'lucro' }),
        platform_only_orders: 4,
      },
    ],
    campaigns: [
      {
        campaign_id: uuid(11),
        provider: 'meta_ads',
        name: 'Combo sexta',
        status: 'ativa',
        platform: plataforma({ spend_micros: micros('412.50'), value_micros: micros('2520.00'), roas: '6.11', conversions: '24' }),
        confirmed: confirmado({ orders: 27, revenue_micros: micros('1782.00'), roas: '4.32', cost_per_order_micros: '15277777', margin_known_micros: micros('681.60'), margin_coverage_pct: '85.0', verdict: 'lucro' }),
      },
      {
        campaign_id: uuid(12),
        provider: 'google_ads',
        name: 'Busca “hambúrguer perto”',
        status: 'ativa',
        platform: plataforma({ spend_micros: micros('394.70'), value_micros: micros('1342.00'), roas: '3.40', window: 'padrao', conversions: '12' }),
        confirmed: confirmado({ orders: 12, revenue_micros: micros('804.00'), roas: '2.04', cost_per_order_micros: '32891666', margin_known_micros: micros('290.40'), margin_coverage_pct: '86.0', verdict: 'prejuizo' }),
      },
      {
        campaign_id: uuid(13),
        provider: 'meta_ads',
        name: 'Smash em dobro',
        status: 'ativa',
        platform: plataforma({ spend_micros: micros('279.80'), conversations: '141', cost_per_conversation_micros: '1984397' }),
        confirmed: confirmado({ orders: 9, revenue_micros: micros('612.00'), roas: '2.19', cost_per_order_micros: '31088888', margin_known_micros: micros('226.20'), margin_coverage_pct: '88.0', verdict: 'prejuizo' }),
      },
      {
        campaign_id: uuid(14),
        provider: 'meta_ads',
        name: 'Delivery noite',
        status: 'pausada',
        platform: plataforma({ spend_micros: micros('153.00'), value_micros: micros('612.00'), roas: '4.00' }),
        confirmed: confirmado({ orders: 3, revenue_micros: micros('171.00'), roas: '1.12', cost_per_order_micros: '51000000', margin_known_micros: micros('41.04'), margin_coverage_pct: '60.0', verdict: null }),
      },
    ],
    sources: [fonte('google_ads'), fonte('meta_ads'), fonte('regem')],
    generated_at: AGORA,
  };
}

/** O piloto hoje: Meta e Google conectados, sem o Regem (a API devolve o caixa zerado). */
export function piloto(): ClosedLoopResponse {
  const r = base7();
  const zero = confirmado({ roas: '0.00', margin_coverage_pct: null });
  r.sources = [fonte('google_ads'), fonte('meta_ads')];
  r.totals = {
    spend_micros: micros('718.70'),
    orders_confirmed: 0,
    revenue_micros: '0',
    confirmed: zero,
    without_origin: { orders: 0, revenue_micros: '0', share_pct: null },
    no_click_channels: [],
    cancelled: { orders: 0, revenue_micros: '0' },
  };
  r.platforms = [
    { provider: 'google_ads', platform: plataforma({ spend_micros: micros('62.77'), window: 'padrao', conversions: '0' }), confirmed: zero, platform_only_orders: 0 },
    { provider: 'meta_ads', platform: plataforma({ spend_micros: micros('655.93'), value_micros: micros('2010.00'), roas: '3.06', conversions: '31', conversations: '12', cost_per_conversation_micros: '54660833' }), confirmed: zero, platform_only_orders: 0 },
  ];
  r.campaigns = [
    { campaign_id: uuid(21), provider: 'meta_ads', name: 'VENDAS | COMPRAR | SEX A DOM', status: 'ativa', platform: plataforma({ spend_micros: micros('580.00'), value_micros: micros('1890.00'), roas: '3.26', conversions: '29' }), confirmed: zero },
    { campaign_id: uuid(22), provider: 'google_ads', name: 'Pesquisa teste', status: 'ativa', platform: plataforma({ spend_micros: micros('62.77'), window: 'padrao', conversions: '0' }), confirmed: zero },
  ];
  return r;
}

/** Hoje, até 14:20: o caixa já tem pedidos; a mídia só é lida amanhã. */
export function hoje(): ClosedLoopResponse {
  const r = base7();
  r.period = { ...r.period, from: '2026-09-29', to: '2026-09-29' };
  r.totals = {
    ...r.totals,
    spend_micros: micros('88.00'),
    orders_confirmed: 27,
    revenue_micros: micros('1609.00'),
    confirmed: confirmado({ orders: 4, revenue_micros: micros('267.80'), roas: '3.04', cost_per_order_micros: '22000000', margin_known_micros: micros('99.74'), margin_coverage_pct: '100.0', verdict: 'lucro' }),
    without_origin: { orders: 3, revenue_micros: micros('192.00'), share_pct: '42.9' },
    no_click_channels: [{ channel_group: 'marketplace', orders: 20, revenue_micros: micros('1149.20') }],
    cancelled: { orders: 0, revenue_micros: '0' },
  };
  return r;
}
