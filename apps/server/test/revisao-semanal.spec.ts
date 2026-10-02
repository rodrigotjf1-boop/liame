import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { type AttentionItem, type CampaignResult, type ClosedLoopResponse, type ExplanationResponse, type SourceFreshness, WeeklyReview } from '@liame/contracts';
import { describe, expect, it } from 'vitest';
import { type ConteudoDaRevisao, emailDaRevisao, linhaDaMudanca } from '../src/results/revisao-email.js';
import {
  campanhasDaSemana,
  comAtrasoMarcado,
  diaDaRevisao,
  diaIso,
  horaNoFuso,
  oQueMudou,
  precisaDeDecisao,
  proximaRevisao,
  semanaAnterior,
  semanaEmDia,
  semanaFechada,
  soNaPlataforma,
  temAsFontes,
  temMovimento,
  totaisDaSemana,
  variacaoPct,
} from '../src/results/revisao-semanal.js';

// A3 · I7, sem banco: as regras da revisão da semana. A semana fechada e quando sai a próxima; o que mudou
// sobre a semana anterior, em inteiros; o que precisa de decisão; e o texto do e-mail, com os mesmos números.

const U = (n: number) => `0199a700-0000-7000-8000-${n.toString().padStart(12, '0')}`;
const FUSO = 'America/Sao_Paulo';
const SEMANA = { from: '2026-09-21', to: '2026-09-27' };
const MARCA = U(1);
const reais = (v: number) => String(Math.round(v * 100) * 10_000);

type Camp = { n: number; nome: string; provider?: string; invest: number; pedidos: number; receita: number; roas: string | null; verdict?: string | null; margem?: number };
const campanha = (c: Camp): CampaignResult => ({
  campaign_id: U(100 + c.n),
  provider: c.provider ?? 'meta_ads',
  name: c.nome,
  status: 'ativa',
  platform: { spend_micros: reais(c.invest), value_micros: null, roas: null, window: '7d_click', conversions: null, conversations: null, cost_per_conversation_micros: null },
  confirmed: { orders: c.pedidos, revenue_micros: reais(c.receita), roas: c.roas, cost_per_order_micros: null, margin_known_micros: c.margem === undefined ? null : reais(c.margem), margin_coverage_pct: c.margem === undefined ? null : '100.0', verdict: c.verdict ?? null },
});
const fonte = (provider: string, lida: string | null, freshness = 'fresh'): SourceFreshness => ({
  connected_account_id: U(provider === 'regem' ? 9 : provider === 'meta_ads' ? 8 : 7),
  provider,
  name: provider === 'regem' ? 'Loja Centro' : 'CA - Hamburgueria',
  dataset: provider === 'regem' ? 'pedidos' : 'metricas',
  freshness,
  last_success_at: lida,
  status: 'ativa',
  timezone: FUSO,
});

function resultado(o: { semana?: { from: string; to: string }; invest: number; pedidos: number; receita: number; roas: string | null; verdict?: string | null; semOrigem?: number; campanhas?: Camp[]; soPlataforma?: number; fontes?: SourceFreshness[] }): ClosedLoopResponse {
  const semana = o.semana ?? SEMANA;
  const caixa = { orders: o.pedidos, revenue_micros: reais(o.receita), roas: o.roas, cost_per_order_micros: null, margin_known_micros: null, margin_coverage_pct: null, verdict: o.verdict ?? null };
  const informa = { spend_micros: reais(o.invest), value_micros: null, roas: null, window: '7d_click', conversions: null, conversations: null, cost_per_conversation_micros: null };
  return {
    period: { ...semana, timezone: FUSO, account_timezones: [FUSO] },
    model: { id: U(2), key: 'ultimo_toque', version: 1, window_days: 7, counts_views: false },
    currency: 'BRL',
    totals: {
      spend_micros: reais(o.invest),
      orders_confirmed: o.pedidos + (o.semOrigem ?? 0),
      revenue_micros: reais(o.receita),
      confirmed: caixa,
      without_origin: { orders: o.semOrigem ?? 0, revenue_micros: '0', share_pct: null },
      no_click_channels: [],
      cancelled: { orders: 0, revenue_micros: '0' },
    },
    platforms: [{ provider: 'meta_ads', platform: informa, confirmed: caixa, platform_only_orders: o.soPlataforma ?? 0 }],
    campaigns: (o.campanhas ?? []).map(campanha),
    sources: o.fontes ?? [fonte('meta_ads', '2026-09-28T08:02:00.000Z'), fonte('regem', '2026-09-28T08:05:00.000Z')],
    generated_at: '2026-09-28T08:10:00.000Z',
  };
}

/** A semana do protótipo P4 (21/09 a 27/09) e a anterior. */
const atual = () =>
  resultado({
    invest: 1214.3,
    pedidos: 53,
    receita: 3471,
    roas: '2.86',
    verdict: 'empata',
    semOrigem: 44,
    soPlataforma: 4,
    campanhas: [
      { n: 1, nome: 'Combo sexta', invest: 404.1, pedidos: 26, receita: 1716, roas: '4.25', verdict: 'lucro' },
      { n: 2, nome: 'Busca perto', provider: 'google_ads', invest: 386.2, pedidos: 12, receita: 804, roas: '2.08', verdict: 'empata' },
      { n: 3, nome: 'Smash em dobro', invest: 274, pedidos: 9, receita: 612, roas: '2.23', verdict: 'empata' },
      { n: 4, nome: 'Delivery noite', invest: 150, pedidos: 2, receita: 114, roas: '0.76', verdict: 'prejuizo', margem: 27.36 },
      { n: 5, nome: 'Parada sem nada', invest: 0, pedidos: 0, receita: 0, roas: null },
    ],
  });
const anterior = () =>
  resultado({
    semana: semanaAnterior(SEMANA),
    invest: 1180,
    pedidos: 47,
    receita: 3068,
    roas: '2.60',
    semOrigem: 41,
    campanhas: [
      { n: 1, nome: 'Combo sexta', invest: 400, pedidos: 24, receita: 1608, roas: '4.02', verdict: 'lucro' },
      { n: 2, nome: 'Busca perto', provider: 'google_ads', invest: 380, pedidos: 12, receita: 802, roas: '2.11', verdict: 'empata' },
      { n: 3, nome: 'Smash em dobro', invest: 260, pedidos: 8, receita: 533, roas: '2.05', verdict: 'empata' },
      { n: 4, nome: 'Delivery noite', invest: 140, pedidos: 3, receita: 157, roas: '1.12', verdict: 'prejuizo' },
    ],
  });

describe('a semana da revisão: de segunda a domingo, no dia da loja', () => {
  it('a última semana fechada: em qualquer dia, é a que acabou no último domingo', () => {
    expect(diaIso('2026-09-28')).toBe(1);
    expect(diaIso('2026-09-27')).toBe(7);
    // Segunda, quarta e sábado da mesma semana olham para a semana de 21 a 27.
    for (const hoje of ['2026-09-28', '2026-09-30', '2026-10-03']) expect(semanaFechada(hoje), hoje).toEqual(SEMANA);
    // No domingo a semana dele ainda não fechou: vale a anterior.
    expect(semanaFechada('2026-10-04')).toEqual(SEMANA);
    expect(semanaFechada('2026-10-05')).toEqual({ from: '2026-09-28', to: '2026-10-04' });
    expect(semanaAnterior(SEMANA)).toEqual({ from: '2026-09-14', to: '2026-09-20' });
    expect(diaDaRevisao(SEMANA)).toBe('2026-09-28');
    // Virada de mês e de ano.
    expect(semanaFechada('2027-01-01')).toEqual({ from: '2026-12-21', to: '2026-12-27' });
  });

  it('quando sai a próxima: hoje, se é segunda e a desta semana ainda não saiu; senão, na segunda que vem', () => {
    expect(proximaRevisao('2026-09-28', null)).toBe('2026-09-28');
    expect(proximaRevisao('2026-09-28', '2026-09-14')).toBe('2026-09-28');
    expect(proximaRevisao('2026-09-28', '2026-09-21')).toBe('2026-10-05');
    expect(proximaRevisao('2026-09-30', '2026-09-21')).toBe('2026-10-05');
    expect(proximaRevisao('2026-09-30', null)).toBe('2026-10-05');
    expect(proximaRevisao('2026-10-04', '2026-09-21')).toBe('2026-10-05');
  });

  it('a hora é a da loja', () => {
    // 08:10 UTC são 05:10 em Brasília e 04:10 em Manaus.
    const agora = new Date('2026-09-28T08:10:00Z');
    expect(horaNoFuso(agora, FUSO)).toBe(5);
    expect(horaNoFuso(agora, 'America/Manaus')).toBe(4);
    expect(horaNoFuso(new Date('2026-09-28T03:00:00Z'), FUSO)).toBe(0);
  });

  it('os números da semana estão completos quando a conta de anúncio foi lida depois do domingo', () => {
    const lidaNaSegunda = [fonte('meta_ads', '2026-09-28T08:02:00.000Z'), fonte('regem', '2026-09-28T08:05:00.000Z')];
    // Lida no domingo às 05:00: pelo prazo normal ainda está "em dia", mas o domingo dela não chegou inteiro.
    const lidaNoDomingo = [fonte('meta_ads', '2026-09-27T08:02:00.000Z'), fonte('regem', '2026-09-28T08:05:00.000Z')];
    expect(semanaEmDia(lidaNaSegunda, SEMANA, FUSO)).toBe(true);
    expect(semanaEmDia(lidaNoDomingo, SEMANA, FUSO)).toBe(false);
    // 02:30 UTC de segunda ainda é domingo em Brasília.
    expect(semanaEmDia([fonte('meta_ads', '2026-09-28T02:30:00.000Z'), fonte('regem', '2026-09-28T08:05:00.000Z')], SEMANA, FUSO)).toBe(false);
    expect(semanaEmDia([fonte('meta_ads', '2026-09-28T08:02:00.000Z'), fonte('regem', '2026-09-28T06:00:00.000Z', 'stale')], SEMANA, FUSO)).toBe(false);
    expect(semanaEmDia([fonte('meta_ads', null, 'unknown'), fonte('regem', '2026-09-28T08:05:00.000Z')], SEMANA, FUSO)).toBe(false);
    expect(semanaEmDia([], SEMANA, FUSO)).toBe(false);
    // Na revisão que sai sem esperar mais, a conta não lida depois do domingo vai marcada como atrasada.
    const marcado = comAtrasoMarcado(resultado({ invest: 1, pedidos: 1, receita: 1, roas: '1.00', fontes: lidaNoDomingo }), SEMANA, FUSO);
    expect(marcado.sources.map((s) => [s.provider, s.freshness])).toEqual([['meta_ads', 'delayed'], ['regem', 'fresh']]);
    expect(comAtrasoMarcado(resultado({ invest: 1, pedidos: 1, receita: 1, roas: '1.00', fontes: lidaNaSegunda }), SEMANA, FUSO).sources.every((s) => s.freshness === 'fresh')).toBe(true);
  });

  it('precisa das vendas e de uma conta de anúncio, e de movimento em alguma das duas semanas', () => {
    expect(temAsFontes([fonte('meta_ads', null), fonte('regem', null)])).toBe(true);
    expect(temAsFontes([fonte('meta_ads', null)])).toBe(false);
    expect(temAsFontes([fonte('regem', null)])).toBe(false);
    const nada = resultado({ invest: 0, pedidos: 0, receita: 0, roas: null });
    expect(temMovimento(nada, nada)).toBe(false);
    expect(temMovimento(nada, null)).toBe(false);
    expect(temMovimento(nada, anterior())).toBe(true);
    expect(temMovimento(resultado({ invest: 10, pedidos: 0, receita: 0, roas: '0.00' }), null)).toBe(true);
  });
});

describe('o que mudou sobre a semana anterior: a conta é do código, em inteiros', () => {
  it('a variação tem sinal e uma casa; de zero para qualquer valor não é porcentagem', () => {
    expect(variacaoPct(53n, 47n)).toBe('+12.8');
    expect(variacaoPct(47n, 53n)).toBe('-11.3');
    expect(variacaoPct(47n, 47n)).toBe('0.0');
    expect(variacaoPct(12n, 0n)).toBeNull();
    expect(variacaoPct(3_471_000_000n, 3_068_000_000n)).toBe('+13.1');
  });

  it('os quatro números do topo, cada um ao lado do da semana anterior', () => {
    expect(totaisDaSemana(atual(), anterior())).toEqual([
      { kind: 'investimento', campaign: null, unit: 'dinheiro', before: '1180000000', now: '1214300000', change_pct: '+2.9' },
      { kind: 'pedidos_de_anuncios', campaign: null, unit: 'contagem', before: '47', now: '53', change_pct: '+12.8' },
      { kind: 'receita_confirmada', campaign: null, unit: 'dinheiro', before: '3068000000', now: '3471000000', change_pct: '+13.1' },
      { kind: 'roas_confirmado', campaign: null, unit: 'razao', before: '2.60', now: '2.86', change_pct: '+10.0' },
    ]);
    // Sem semana anterior não há com o que comparar.
    expect(totaisDaSemana(atual(), null).map((m) => [m.kind, m.before, m.change_pct])).toEqual([
      ['investimento', null, null],
      ['pedidos_de_anuncios', null, null],
      ['receita_confirmada', null, null],
      ['roas_confirmado', null, null],
    ]);
  });

  it('melhorou e piorou: pedidos e receita que mexeram, o ROAS das campanhas que mudou 5% ou mais e os pedidos sem origem', () => {
    const { improved, worsened } = oQueMudou(atual(), anterior());
    expect(improved.map((m) => [m.kind, m.campaign?.name ?? null, m.before, m.now, m.change_pct])).toEqual([
      ['pedidos_de_anuncios', null, '47', '53', '+12.8'],
      ['receita_confirmada', null, '3068000000', '3471000000', '+13.1'],
      // Combo sexta (+5,7%) e Smash em dobro (+8,8%), a de maior investimento primeiro.
      ['roas_da_campanha', 'Combo sexta', '4.02', '4.25', '+5.7'],
      ['roas_da_campanha', 'Smash em dobro', '2.05', '2.23', '+8.8'],
    ]);
    expect(worsened.map((m) => [m.kind, m.campaign?.name ?? null, m.before, m.now, m.change_pct])).toEqual([
      ['roas_da_campanha', 'Delivery noite', '1.12', '0.76', '-32.1'],
      // Pedido sem origem a mais é venda que não dá para ligar a campanha nenhuma: subir é piorar.
      ['pedidos_sem_origem', null, '41', '44', '+7.3'],
    ]);
    // "Busca perto" foi de 2,11 para 2,08 (1,4%): não é mudança que valha uma linha.
    expect([...improved, ...worsened].some((m) => m.campaign?.name === 'Busca perto')).toBe(false);
    expect(improved[2]!.campaign).toEqual({ id: U(101), name: 'Combo sexta', provider: 'meta_ads' });
  });

  it('de zero para doze também é subir; sem semana anterior, as listas ficam vazias; no máximo três campanhas por lista', () => {
    const zerada = resultado({ semana: semanaAnterior(SEMANA), invest: 500, pedidos: 0, receita: 0, roas: '0.00', semOrigem: 5 });
    const subiu = oQueMudou(resultado({ invest: 500, pedidos: 12, receita: 800, roas: '1.60', semOrigem: 2 }), zerada);
    expect(subiu.improved.map((m) => [m.kind, m.before, m.now, m.change_pct])).toEqual([
      ['pedidos_de_anuncios', '0', '12', null],
      ['receita_confirmada', '0', '800000000', null],
      ['pedidos_sem_origem', '5', '2', '-60.0'],
    ]);
    expect(subiu.worsened).toEqual([]);
    expect(oQueMudou(atual(), null)).toEqual({ improved: [], worsened: [] });
    expect(oQueMudou(atual(), resultado({ semana: semanaAnterior(SEMANA), invest: 0, pedidos: 0, receita: 0, roas: null }))).toEqual({ improved: [], worsened: [] });

    const cinco = (roas: string) => [1, 2, 3, 4, 5].map((n) => ({ n, nome: `Campanha ${n}`, invest: 100 * n, pedidos: 5, receita: 300, roas }));
    const muitas = oQueMudou(resultado({ invest: 1500, pedidos: 25, receita: 1500, roas: '1.00', campanhas: cinco('3.00') }), resultado({ semana: semanaAnterior(SEMANA), invest: 1500, pedidos: 25, receita: 1500, roas: '1.00', campanhas: cinco('2.00') }));
    // As três de maior investimento.
    expect(muitas.improved.map((m) => m.campaign?.name)).toEqual(['Campanha 5', 'Campanha 4', 'Campanha 3']);
  });

  it('a tabela: as campanhas com investimento ou pedido, a de maior investimento primeiro; e o que só a plataforma prova', () => {
    const r = atual();
    expect(campanhasDaSemana(r).map((c) => [c.name, c.provider, c.spend_micros, c.orders, c.revenue_micros, c.roas, c.verdict])).toEqual([
      ['Combo sexta', 'meta_ads', '404100000', 26, '1716000000', '4.25', 'lucro'],
      ['Busca perto', 'google_ads', '386200000', 12, '804000000', '2.08', 'empata'],
      ['Smash em dobro', 'meta_ads', '274000000', 9, '612000000', '2.23', 'empata'],
      ['Delivery noite', 'meta_ads', '150000000', 2, '114000000', '0.76', 'prejuizo'],
    ]);
    // A receita "sem campanha" é a da plataforma menos a das campanhas dela: 3.471,00 − (1.716 + 612 + 114) = 1.029,00.
    expect(soNaPlataforma(r)).toEqual([{ provider: 'meta_ads', orders: 4, revenue_micros: '1029000000' }]);
    expect(soNaPlataforma(anterior())).toEqual([]);
  });
});

describe('precisa de decisão: o Liame aponta, quem decide é a pessoa', () => {
  const aviso = (kind: string, severity: string): AttentionItem => ({ kind, severity, title: `Aviso ${kind}`, detail: 'Detalhe.', action: 'Faça.', connected_account_id: null, campaign_id: null, provider: null, brand_id: MARCA });

  it('a campanha em prejuízo nas duas semanas vem primeiro; depois os avisos críticos e de atenção; informação fica de fora', () => {
    const d = precisaDeDecisao(atual(), anterior(), [aviso('plataforma_x_caixa', 'info'), aviso('cupom_sem_uso', 'atencao'), aviso('conta_desconectada', 'critica')], MARCA);
    expect(d.map((i) => [i.kind, i.severity])).toEqual([
      ['prejuizo_seguido', 'atencao'],
      ['conta_desconectada', 'critica'],
      ['cupom_sem_uso', 'atencao'],
    ]);
    expect(d[0]).toEqual({
      kind: 'prejuizo_seguido',
      severity: 'atencao',
      title: 'Delivery noite deu prejuízo nas duas últimas semanas',
      // O prejuízo é pela margem: o texto diz quanto faltou para ela pagar o anúncio.
      detail: 'Faltaram R$ 122,64 para a margem dos pedidos pagar o anúncio: R$ 114,00 de receita para R$ 150,00 investidos na semana.',
      action: 'Veja a campanha em Resultados e decida se ela continua como está.',
      connected_account_id: null,
      campaign_id: U(104),
      provider: 'meta_ads',
      brand_id: MARCA,
    });
  });

  it('prejuízo só nesta semana ainda não é decisão; sem semana anterior, só os avisos; no máximo cinco', () => {
    const semPrejuizoAntes = resultado({ semana: semanaAnterior(SEMANA), invest: 1, pedidos: 1, receita: 1, roas: '1.00', campanhas: [{ n: 4, nome: 'Delivery noite', invest: 140, pedidos: 3, receita: 157, roas: '1.12', verdict: 'empata' }] });
    expect(precisaDeDecisao(atual(), semPrejuizoAntes, [], MARCA)).toEqual([]);
    expect(precisaDeDecisao(atual(), null, [aviso('cupom_sem_uso', 'atencao')], MARCA).map((i) => i.kind)).toEqual(['cupom_sem_uso']);
    const muitos = Array.from({ length: 8 }, (_, i) => aviso(`aviso_${i}`, 'atencao'));
    expect(precisaDeDecisao(atual(), anterior(), muitos, MARCA)).toHaveLength(5);
    // Sem a margem no resultado (não deveria acontecer com veredito), o texto fica só com a receita e o investimento.
    const semMargem = (r: ClosedLoopResponse): ClosedLoopResponse => ({ ...r, campaigns: r.campaigns.map((c) => ({ ...c, confirmed: { ...c.confirmed, margin_known_micros: null } })) });
    expect(precisaDeDecisao(semMargem(atual()), anterior(), [], MARCA)[0]!.detail).toBe('R$ 114,00 de receita para R$ 150,00 investidos na semana.');
  });
});

describe('o e-mail da revisão: os mesmos números da tela, em texto', () => {
  const leitura = (source: 'lia' | 'sistema', reason: string | null, extra: Partial<ExplanationResponse> = {}): ExplanationResponse => ({
    source,
    reason,
    explanation: {
      what_happened: [{ text: 'Na semana, os anúncios trouxeram ', number: null }, { text: '53', number: 0 }, { text: ' pedidos confirmados no caixa.', number: null }],
      reasons: [[{ text: 'Combo sexta segue como a campanha que dá lucro.', number: null }]],
      risk: 'medio',
      risk_reason: [{ text: 'no total, a semana empata.', number: null }],
      what_to_do: [[{ text: 'Decida o que fazer com a Delivery noite.', number: null }]],
    },
    numbers: [{ value: '53', sources: ['Regem · pedidos confirmados com origem provada em campanha · 21/09/2026 a 27/09/2026'] }],
    period: { from: '21/09/2026', to: '27/09/2026' },
    compared_to: { from: '14/09/2026', to: '20/09/2026' },
    stale_sources: [],
    usage_id: source === 'lia' ? U(50) : null,
    retry_at: null,
    budget_window: null,
    generated_at: '2026-09-28T08:10:00.000Z',
    ...extra,
  });
  const conteudo = (reading: ExplanationResponse): ConteudoDaRevisao => {
    const [a, b] = [atual(), anterior()];
    return {
      brand_id: MARCA,
      week: SEMANA,
      previous_week: semanaAnterior(SEMANA),
      timezone: FUSO,
      currency: 'BRL',
      generated_at: '2026-09-28T08:10:00.000Z',
      totals: totaisDaSemana(a, b),
      verdict: 'empata',
      campaigns: campanhasDaSemana(a),
      platform_only: soNaPlataforma(a),
      ...oQueMudou(a, b),
      decisions: precisaDeDecisao(a, b, [], MARCA),
      reading,
    };
  };
  const quem = { marca: 'Mister Burgers', empresa: 'Mister Burgers Ltda', nivel: 'so_relatorios', link: 'https://app.agencialiame.com/resultados/revisao?marca=x&semana=2026-09-21' };

  it('assunto, os quatro números, a leitura da LIA com o aviso de IA, a tabela, o que mudou, a decisão e o porquê do e-mail', () => {
    const e = emailDaRevisao(conteudo(leitura('lia', null)), quem);
    expect(e.subject).toBe('Liame: revisão da semana da Mister Burgers (21/09 a 27/09)');
    const linhas = e.text.split('\n');
    expect(linhas.slice(0, 2)).toEqual(['Revisão da semana da Mister Burgers', 'De 21/09/2026 a 27/09/2026, comparada com 14/09/2026 a 20/09/2026.']);
    for (const linha of [
      'OS NÚMEROS DA SEMANA',
      'Investido em anúncios: R$ 1.214,30 (+2,9%; era R$ 1.180,00)',
      'Pedidos de anúncios: 53 (+12,8%; eram 47)',
      'Receita confirmada no caixa: R$ 3.471,00 (+13,1%; era R$ 3.068,00)',
      'ROAS confirmado no caixa: 2,86 (era 2,60)',
      'LEITURA DA SEMANA, PELA LIA (FEITO COM IA)',
      'Na semana, os anúncios trouxeram 53 pedidos confirmados no caixa.',
      '- Combo sexta segue como a campanha que dá lucro.',
      'Risco médio: no total, a semana empata.',
      '- Decida o que fazer com a Delivery noite.',
      'A LIA é uma assistente de IA: ela só escreve. Os números são do sistema, conferidos antes de aparecer, e a decisão é sua.',
      'O QUE CADA CAMPANHA TROUXE NO CAIXA',
      '- Combo sexta (Meta): R$ 404,10 investidos, 26 pedido(s), R$ 1.716,00 de receita, ROAS 4,25 · dá lucro',
      '- Busca perto (Google Ads): R$ 386,20 investidos, 12 pedido(s), R$ 804,00 de receita, ROAS 2,08 · empata',
      '- Delivery noite (Meta): R$ 150,00 investidos, 2 pedido(s), R$ 114,00 de receita, ROAS 0,76 · dá prejuízo',
      '- Meta, sem campanha identificada: 4 pedido(s), R$ 1.029,00 (conta no total)',
      'O QUE MELHOROU',
      '- Pedidos de anúncios: de 47 para 53 (+12,8%)',
      '- Receita confirmada no caixa: de R$ 3.068,00 para R$ 3.471,00 (+13,1%)',
      '- Combo sexta: ROAS no caixa de 4,02 para 4,25',
      'O QUE PIOROU',
      '- Delivery noite: ROAS no caixa de 1,12 para 0,76',
      '- Pedidos sem origem: de 41 para 44 (+7,3%)',
      'PRECISA DE DECISÃO',
      '- Delivery noite deu prejuízo nas duas últimas semanas. Faltaram R$ 122,64 para a margem dos pedidos pagar o anúncio: R$ 114,00 de receita para R$ 150,00 investidos na semana.',
      'O Liame aponta; quem decide é você. Nada muda nas campanhas por aqui.',
      'Ver a revisão completa: https://app.agencialiame.com/resultados/revisao?marca=x&semana=2026-09-21',
      'Você recebe este e-mail porque tem acesso à Mister Burgers Ltda no Liame como Só relatórios por e-mail. Para deixar de receber, escreva para suporte@agencialiame.com.',
      'Liame · um produto DMS Tecnologias',
    ]) {
      expect(linhas, linha).toContain(linha);
    }
    expect(e.text).not.toMatch(/undefined|null|NaN|\[object/);
  });

  it('sem a LIA, o e-mail diz que a leitura é do sistema; com dado velho, diz qual fonte e desde quando', () => {
    const doSistema = emailDaRevisao(conteudo(leitura('sistema', 'desligada')), { ...quem, nivel: 'dono' });
    expect(doSistema.text).toContain('LEITURA DA SEMANA, PELO SISTEMA (SEM IA)');
    expect(doSistema.text).not.toContain('assistente de IA');
    expect(doSistema.text).not.toContain('estava atrasada');
    expect(doSistema.text).toContain('no Liame como Dono.');
    const velho = emailDaRevisao(conteudo(leitura('sistema', 'dado_velho', { stale_sources: [{ platform: 'Meta', name: 'CA - Hamburgueria', freshness: 'atrasado', last_read: '27/09/2026 05:02' }] })), quem);
    expect(velho.text).toContain('Na hora de gerar, uma fonte estava atrasada (Meta · CA - Hamburgueria, última leitura em 27/09/2026 05:02). Os números valem até essa hora.');
  });

  it('semana sem comparação e sem listas: o e-mail fica só com o que há', () => {
    const a = atual();
    const c: ConteudoDaRevisao = { ...conteudo(leitura('sistema', 'desligada')), totals: totaisDaSemana(a, null), improved: [], worsened: [], decisions: [], campaigns: [], platform_only: [] };
    const e = emailDaRevisao(c, quem);
    const linhas = e.text.split('\n');
    expect(linhas).toContain('De 21/09/2026 a 27/09/2026.');
    expect(linhas).toContain('Pedidos de anúncios: 53');
    expect(linhas).toContain('ROAS confirmado no caixa: 2,86');
    expect(e.text).not.toContain('comparada com');
    for (const titulo of ['O QUE MELHOROU', 'O QUE PIOROU', 'PRECISA DE DECISÃO', 'O QUE CADA CAMPANHA TROUXE NO CAIXA']) expect(e.text, titulo).not.toContain(titulo);
    expect(linhaDaMudanca({ kind: 'pedidos_de_anuncios', campaign: null, unit: 'contagem', before: '0', now: '12', change_pct: null }, 'BRL')).toBe('Pedidos de anúncios: de 0 para 12');
  });

  it('a revisão guardada na versão 1 continua abrindo pelo contrato de agora', () => {
    // O conteúdo vai para o banco como foi gerado, e é lido meses depois. O arquivo é uma revisão da versão 1,
    // como ela está no banco. Se o contrato (ou o do Explicar, ou o dos avisos, que ele embute) ganhar um campo
    // obrigatório, este teste falha: é a hora de subir `REVISAO_VERSAO` e converter o conteúdo antigo na leitura.
    const arquivo = resolve(process.cwd(), 'test/fixtures/revisao-semanal/v1.json');
    const guardado = JSON.parse(readFileSync(arquivo, 'utf8')) as Record<string, unknown>;
    const lida = WeeklyReview.safeParse({ ...guardado, id: U(60), email: { status: 'enviado', sent_at: '2026-09-28T10:00:00.000Z', recipients: 3 } });
    expect(lida.success, JSON.stringify(lida.error?.issues)).toBe(true);
    // O que o código gera hoje tem os mesmos campos do arquivo: campo novo no gerador é mudança de formato, e
    // pede a mesma decisão (versão nova, com o arquivo dela ao lado deste).
    expect(Object.keys(conteudo(leitura('lia', null))).sort()).toEqual(Object.keys(guardado).sort());
  });
});
