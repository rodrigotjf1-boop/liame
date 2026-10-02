import type { ClosedLoopResponse, CouponListResponse, TrackingCheckResponse, TrackingLinkListResponse } from '@liame/contracts';
import { describe, expect, it } from 'vitest';
import { decimal, dia, dinheiro, dinheiroDecimal, inteiro, porcento, razao, soOQueExiste } from '../src/ai/registro/formatos.js';
import { CAMPANHAS_MAXIMO, visaoDoCicloFechado } from '../src/ai/registro/visoes/ciclo-fechado.js';
import { visaoDosCupons } from '../src/ai/registro/visoes/cupons.js';
import { visaoDosLinks } from '../src/ai/registro/visoes/links.js';
import { visaoDaEntrega } from '../src/ai/registro/visoes/midia.js';
import { limparTexto } from '../src/ai/sanitizar.js';

const U = (n: number) => `0199a300-0000-7000-8000-${n.toString().padStart(12, '0')}`;
/** Nada do que vai ao modelo pode parecer telefone, CPF ou e-mail para a limpeza do gateway. */
const intacto = (v: unknown) => expect(limparTexto(JSON.stringify(v)).removidos).toBe(0);

describe('formatos para o modelo: o número já como a pessoa lê, sem ponto flutuante', () => {
  it('dinheiro a partir de micros: milhar, centavo arredondado, negativo e outra moeda', () => {
    expect(dinheiro('12060000000')).toBe('R$ 12.060,00');
    expect(dinheiro('960000000')).toBe('R$ 960,00');
    expect(dinheiro('1234567894999')).toBe('R$ 1.234.567,89');
    expect(dinheiro('1234567895000')).toBe('R$ 1.234.567,90');
    expect(dinheiro('0')).toBe('R$ 0,00');
    expect(dinheiro('4999')).toBe('R$ 0,00');
    expect(dinheiro('-4999')).toBe('R$ 0,00');
    expect(dinheiro('-25500000')).toBe('-R$ 25,50');
    expect(dinheiro('9007199254740993000000')).toBe('R$ 9.007.199.254.740.993,00');
    expect(dinheiro('1500000', 'USD')).toBe('USD 1,50');
    expect(dinheiro(null)).toBeNull();
  });

  it('contagem, decimal, razão, porcentagem e dia', () => {
    expect([inteiro(0), inteiro(999), inteiro(1000), inteiro(1234567), inteiro('12500'), inteiro(-1500)]).toEqual(['0', '999', '1.000', '1.234.567', '12.500', '-1.500']);
    expect([decimal('1234.5'), decimal('38'), decimal('0.25'), decimal('-1000.10'), decimal(null)]).toEqual(['1.234,5', '38', '0,25', '-1.000,10', null]);
    expect([dinheiroDecimal('1250.00'), dinheiroDecimal('1250.5'), dinheiroDecimal('0.07', 'BRL'), dinheiroDecimal('12', 'USD'), dinheiroDecimal(null)]).toEqual(['R$ 1.250,00', 'R$ 1.250,50', 'R$ 0,07', 'USD 12,00', null]);
    expect([razao('3.80'), razao(null), porcento('83.4'), porcento(null)]).toEqual(['3,80', null, '83,4%', null]);
    expect([dia('2026-09-01'), dia('2026-09-30T12:00:00Z'), dia(null)]).toEqual(['01/09/2026', '30/09/2026', null]);
    expect(soOQueExiste({ a: 1, b: null, c: undefined, d: [], e: false, f: 0, g: '' })).toEqual({ a: 1, e: false, f: 0, g: '' });
  });
});

describe('resultados do ciclo fechado para o modelo', () => {
  const plataformaInforma = { spend_micros: '960000000', value_micros: '12060000000', roas: '12.56', window: '7d_click', conversions: '41', conversations: null, cost_per_conversation_micros: null };
  const caixa = { orders: 38, revenue_micros: '2496000000', roas: '2.60', cost_per_order_micros: '25263158', margin_known_micros: '1100000000', margin_coverage_pct: '83.4', verdict: 'lucro' };
  const campanha = (n: number, spend: string) => ({ campaign_id: U(n), provider: 'meta_ads', name: `Campanha ${n}`, status: 'ativa', platform: { ...plataformaInforma, spend_micros: spend }, confirmed: caixa });
  const resposta: ClosedLoopResponse = {
    period: { from: '2026-09-18', to: '2026-10-01', timezone: 'America/Sao_Paulo', account_timezones: ['America/Sao_Paulo'] },
    model: { id: U(1), key: 'ultimo_toque', version: 1, window_days: 7, counts_views: false },
    currency: 'BRL',
    totals: {
      spend_micros: '960000000',
      orders_confirmed: 1250,
      revenue_micros: '81250000000',
      confirmed: caixa,
      without_origin: { orders: 410, revenue_micros: '26650000000', share_pct: '61.2' },
      no_click_channels: [{ channel_group: 'marketplace', orders: 580, revenue_micros: '37700000000' }],
      cancelled: { orders: 3, revenue_micros: '195000000' },
    },
    platforms: [{ provider: 'meta_ads', platform: plataformaInforma, confirmed: caixa, platform_only_orders: 2 }],
    campaigns: [campanha(1, '100000000'), campanha(2, '860000000')],
    sources: [{ connected_account_id: U(9), provider: 'regem', name: 'Loja Centro', dataset: 'pedidos', freshness: 'fresh', last_success_at: '2026-10-02T04:39:19.000Z', status: 'ativa', timezone: 'America/Sao_Paulo' }],
    generated_at: '2026-10-02T05:00:00.000Z',
  };

  it('a plataforma e o caixa lado a lado, cada um com o seu número, e a maior campanha primeiro', () => {
    const v = visaoDoCicloFechado(resposta);
    expect(v.periodo).toEqual({ de: '18/09/2026', ate: '01/10/2026', fuso_da_loja: 'America/Sao_Paulo' });
    expect(v.atribuicao).toEqual({ modelo: 'ultimo_toque', janela_em_dias: 7, conta_visualizacao: false });
    expect(v.totais).toEqual({
      investimento: 'R$ 960,00',
      pedidos_confirmados: '1.250',
      receita_confirmada: 'R$ 81.250,00',
      com_origem_provada: { pedidos: '38', receita: 'R$ 2.496,00', roas: '2,60', custo_por_pedido: 'R$ 25,26', margem_conhecida: 'R$ 1.100,00', parte_da_receita_com_margem_conhecida: '83,4%', resultado: 'lucro' },
      sem_origem: { pedidos: '410', receita: 'R$ 26.650,00', parte_dos_pedidos_com_clique: '61,2%' },
      canais_sem_clique: [{ canal: 'marketplace', pedidos: '580', receita: 'R$ 37.700,00' }],
      cancelados_depois: { pedidos: '3', receita: 'R$ 195,00' },
    });
    expect(v.plataformas[0]).toMatchObject({
      plataforma: 'Meta',
      plataforma_informa: { investimento: 'R$ 960,00', valor_de_venda: 'R$ 12.060,00', roas: '12,56', janela: '7 dias depois do clique', conversoes: '41' },
      pedidos_provados_so_na_plataforma: '2',
    });
    expect(v.plataformas[0]!.plataforma_informa).not.toHaveProperty('conversas');
    expect(v.campanhas.map((c) => [c.campanha, c.plataforma_informa.investimento])).toEqual([['Campanha 2', 'R$ 860,00'], ['Campanha 1', 'R$ 100,00']]);
    expect(v.fontes).toEqual([{ plataforma: 'Regem', conta: 'Loja Centro', dados: 'pedidos', frescor: 'em dia', ultima_leitura: '02/10/2026 01:39', situacao: 'ativa' }]);
    expect(v).not.toHaveProperty('campanhas_fora_da_lista');
    intacto(v);
  });

  it('corta as campanhas além do limite e avisa quantas ficaram de fora; fuso diferente das contas aparece', () => {
    const muitas = { ...resposta, period: { ...resposta.period, account_timezones: ['America/Los_Angeles'] }, campaigns: Array.from({ length: CAMPANHAS_MAXIMO + 3 }, (_, i) => campanha(i + 1, `${(i + 1) * 1000000}`)) };
    const v = visaoDoCicloFechado(muitas);
    expect(v.campanhas).toHaveLength(CAMPANHAS_MAXIMO);
    expect(v.campanhas[0]!.campanha).toBe(`Campanha ${CAMPANHAS_MAXIMO + 3}`);
    expect(v).toMatchObject({ campanhas_fora_da_lista: 3, periodo: { fusos_das_contas_de_anuncio: ['America/Los_Angeles'] } });
  });
});

describe('cupons, links e entrega de mídia para o modelo', () => {
  it('cupons: regra em texto, usos e campanha; sem o nome de quem pediu ou recusou', () => {
    const cupom = (extra: Record<string, unknown>) => ({
      id: U(20), code: 'FRETFREE', origin: 'regem', platform: null, connected_account_id: U(9), kind: 'frete_gratis', percent: null, value_micros: null, min_order_micros: '0',
      max_discount_micros: null, valid_from: '2026-10-01T03:00:00.000Z', valid_until: '2026-11-01T03:00:00.000Z', active: true, expired: false, first_seen_at: '2026-10-02T01:09:00.000Z',
      uses_7d: 12, revenue_7d_micros: '840000000', link: null, ...extra,
    });
    const pedido = (status: string, status_reason: string | null) => ({
      action_id: U(30), code: 'PIZZA10', connected_account_id: U(9), kind: 'percentual', percent: 10, value_micros: null, min_order_micros: null, valid_from: '2026-10-01', valid_until: '2026-10-31',
      campaign: { id: U(40), name: 'Tráfego | Cardápio', provider: 'meta_ads', status: 'ativa' }, exclusive: true, status, status_reason,
      requested_by: { id: U(50), name: 'Juliana Prado' }, requested_at: '2026-10-02T01:05:00.000Z', expires_at: '2026-10-05T01:05:00.000Z',
    });
    const resposta = {
      stores: [{ connected_account_id: U(9), unit: { id: U(10), name: 'Loja Centro' }, store_name: 'Loja Centro (Regem)', timezone: 'America/Sao_Paulo', order_platform: 'anotaai', order_platform_url: null, order_platform_set_at: null, coupons_read_at: '2026-10-02T04:39:00.000Z', coupons_freshness: 'fresh', coupons_error: null, can_create: true }],
      items: [
        cupom({ link: { id: U(21), campaign: { id: U(40), name: 'Tráfego | Cardápio', provider: 'meta_ads', status: 'ativa' }, exclusive: true, starts_at: '2026-10-02T01:09:00.000Z', ends_at: null, campaign_spend_7d_micros: '320000000' } }),
        cupom({ code: 'DEZ', kind: 'percentual', percent: 10, min_order_micros: '50000000', max_discount_micros: '20000000', expired: true }),
        cupom({ code: 'CINCO', kind: 'valor', value_micros: '5000000', active: false, origin: 'externo', platform: 'anotaai', valid_until: null }),
      ],
      requests: [pedido('aguardando_aprovacao', null), pedido('recusada', 'recusada por Juliana Prado: desconto alto'), pedido('falhou', 'a loja não liberou a criação de cupom')],
      campaigns: [],
      detected_platform: null,
      create_in_regem: true,
      generated_at: '2026-10-02T05:00:00.000Z',
    } as CouponListResponse;
    const v = visaoDosCupons(resposta);
    expect(v.lojas).toEqual([{ loja: 'Loja Centro', plataforma_de_pedidos: 'anotaai', leitura_dos_cupons: 'em dia', ultima_leitura: '02/10/2026 01:39', liame_pode_criar_cupom_nesta_loja: true }]);
    expect(v.cupons[0]).toEqual({
      codigo: 'FRETFREE', origem: 'Regem', regra: 'frete grátis', situacao: 'ativo', valido_ate: '01/11/2026 00:00', usos_em_7_dias: '12', receita_em_7_dias: 'R$ 840,00',
      campanha: { nome: 'Tráfego | Cardápio', plataforma: 'Meta', situacao: 'ativa', exclusivo: true, gasto_em_7_dias: 'R$ 320,00' },
    });
    expect(v.cupons[1]).toMatchObject({ codigo: 'DEZ', regra: '10% de desconto', pedido_minimo: 'R$ 50,00', desconto_maximo: 'R$ 20,00', situacao: 'vencido' });
    expect(v.cupons[2]).toMatchObject({ codigo: 'CINCO', origem: 'anotaai', regra: 'R$ 5,00 de desconto', situacao: 'inativo' });
    expect(v.pedidos_de_criacao.map((p) => [p.situacao, p.motivo ?? null])).toEqual([['aguardando_aprovacao', null], ['recusada', null], ['falhou', 'a loja não liberou a criação de cupom']]);
    expect(JSON.stringify(v)).not.toContain('Juliana');
    expect(v).toMatchObject({ total_de_cupons: 3, criar_cupom_pelo_liame: 'ligado' });
    intacto(v);
  });

  it('links: a conferência do rastreio e os links, sem nenhum endereço', () => {
    const lista = {
      items: [
        { id: U(60), brand_id: U(2), unit: { id: U(10), name: 'Loja Centro' }, name: 'Bio do Instagram', code: 'a1b2c3', provider: 'meta_ads', campaign: { id: U(40), name: 'Tráfego | Cardápio', status: 'ativa' }, ad: null,
          destination_url: 'https://cardapio.exemplo.com/loja-centro', tracking_url: 'https://cardapio.exemplo.com/loja-centro?lk=a1b2c3', platform_params: { field: 'url_tags', value: 'lk=a1b2c3' }, orders_7d: 1240, created_at: '2026-09-30T12:00:00.000Z' },
      ],
    } as TrackingLinkListResponse;
    const conferencia = {
      summary: { active_ads: 12, with_tracking: 9, without_tracking: 2, not_verifiable: 1, not_applicable: 4 },
      items: [{ status: 'sem_rastreio', reason: 'sem_parametros', title: 'Anúncio sem rastreio', detail: 'O anúncio leva ao cardápio sem os parâmetros do link.', action: 'Cole os parâmetros do link no anúncio.', provider: 'meta_ads', connected_account_id: U(8),
        campaign: { id: U(40), name: 'Tráfego | Cardápio' }, ad: { id: U(61), name: 'Combo família', external_id: '120210000000000000' }, destination_url: null, first_seen_at: '2026-09-20T12:00:00.000Z', suggested_link_id: U(60) }],
      sources: [],
      generated_at: '2026-10-02T05:00:00.000Z',
    } as TrackingCheckResponse;
    const v = visaoDosLinks(lista, conferencia);
    expect(v).toEqual({
      rastreio_dos_anuncios: { anuncios_ativos: '12', com_rastreio: '9', sem_rastreio: '2', nao_verificados: '1', fora_da_conferencia: '4' },
      anuncios_para_arrumar: [{ situacao: 'sem_rastreio', motivo: 'sem_parametros', plataforma: 'Meta', campanha: 'Tráfego | Cardápio', anuncio: 'Combo família', detalhe: 'O anúncio leva ao cardápio sem os parâmetros do link.', o_que_fazer: 'Cole os parâmetros do link no anúncio.' }],
      total_de_links: 1,
      links: [{ nome: 'Bio do Instagram', loja: 'Loja Centro', plataforma: 'Meta', campanha: 'Tráfego | Cardápio', situacao_da_campanha: 'ativa', anuncio: 'todos os anúncios da campanha', pedidos_em_7_dias: '1.240' }],
    });
    expect(JSON.stringify(v)).not.toContain('https://');
    intacto(v);
  });

  it('entrega: investimento, impressões, cliques e as razões que o código calculou', () => {
    const v = visaoDaEntrega({
      from: '2026-09-18',
      to: '2026-10-01',
      campaigns: [
        { campaign_id: U(40), provider: 'meta_ads', name: 'Tráfego | Cardápio', status: 'ativa', currency: 'BRL', spend: '1250.00', impressions: '1234567', clicks: '12500', link_clicks: '9800', ctr_pct: '1.01', cpc: '0.10', cpm: '1.01' },
        { campaign_id: U(41), provider: 'google_ads', name: 'Pesquisa | Marca', status: 'pausada', currency: 'BRL', spend: null, impressions: '40', clicks: null, link_clicks: null, ctr_pct: null, cpc: null, cpm: null },
      ],
      days: [{ date: '2026-09-18', currency: 'BRL', spend: '89.50', impressions: '90000', clicks: '910' }],
    });
    expect(v).toEqual({
      periodo: { de: '18/09/2026', ate: '01/10/2026' },
      campanhas: [
        { plataforma: 'Meta', campanha: 'Tráfego | Cardápio', situacao: 'ativa', investimento: 'R$ 1.250,00', impressoes: '1.234.567', cliques: '12.500', cliques_no_link: '9.800', ctr: '1,01%', custo_por_clique: 'R$ 0,10', custo_por_mil_impressoes: 'R$ 1,01' },
        { plataforma: 'Google Ads', campanha: 'Pesquisa | Marca', situacao: 'pausada', impressoes: '40' },
      ],
      por_dia: [{ dia: '18/09/2026', investimento: 'R$ 89,50', impressoes: '90.000', cliques: '910' }],
    });
    intacto(v);
  });
});
