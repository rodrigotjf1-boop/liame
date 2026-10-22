import type { MonthlyReportTeam } from '@liame/contracts';
import { describe, expect, it } from 'vitest';
import { custoDeIaNoMes, emailDoRelatorio, quandoFoiGerado, verbaEEquipe } from '../src/results/relatorio-email.js';
import type { ConteudoDoRelatorio, VerbaDoMesGuardada } from '../src/results/relatorio-mensal.js';

// A3 · I7, o e-mail do relatório do mês (P24; o texto aprovado pelo dono em 21/10/2026, D-A3-20), sem banco: o dia em
// que o relatório saiu com a preposição certa, o custo de IA em reais pela cotação guardada, a parte "A verba e a
// equipe" e o e-mail inteiro (o assunto, a ordem das partes e o HTML). O envio é provado em `db/relatorio-mensal.spec.ts`.

const FUSO = 'America/Sao_Paulo';
const U = (n: number) => `0199a300-0000-7000-8000-${n.toString().padStart(12, '0')}`;
const equipe = (gasto: string, cotacao: string | null): MonthlyReportTeam => ({
  members: [],
  ai: { spent_usd_micros: gasto, ceiling_usd_micros: '20000000' },
  usd_brl: cotacao ? { rate: cotacao, date: '2026-10-30', source: 'ptax' } : null,
});
const verba = (o: Partial<VerbaDoMesGuardada> = {}): VerbaDoMesGuardada => ({ currency: 'BRL', spend_micros: '350000000', limit_micros: '500000000', missing: [], changes: [], ...o });
const mudanca = { action_id: U(1), executed_on: '2026-09-11', action: 'orcamento.aumentar', provider: 'meta_ads', target: { kind: 'campanha', name: 'Combo sexta', campaign_name: null }, from: { status: 'ativa', daily_micros: '55000000' }, to: { status: 'ativa', daily_micros: '60000000' }, requested_by: U(2), approved_by: U(2), agent_key: null, check: 'confere' };

describe('e-mail do relatório do mês: as partes', () => {
  it('o dia em que o relatório saiu: "na" nos dias da semana, "no" no sábado e no domingo, no fuso da loja', () => {
    expect(quandoFoiGerado('2026-10-01T08:10:00.000Z', FUSO)).toBe('na quinta-feira, 01/10, às 05:10');
    expect(quandoFoiGerado('2026-11-01T08:10:00.000Z', FUSO)).toBe('no domingo, 01/11, às 05:10');
    expect(quandoFoiGerado('2027-05-01T08:10:00.000Z', FUSO)).toBe('no sábado, 01/05, às 05:10');
    // Antes das 3h em UTC ainda é a véspera em Brasília: o dia é o da loja.
    expect(quandoFoiGerado('2026-10-02T02:30:00.000Z', FUSO)).toBe('na quinta-feira, 01/10, às 23:30');
  });

  it('o custo de IA do mês em reais pela cotação guardada; sem cotação, em dólar', () => {
    expect(custoDeIaNoMes(equipe('1000000', '5.4321'))).toBe('R$ 5,43');
    expect(custoDeIaNoMes(equipe('61490000', '5.40'))).toBe('R$ 332,05');
    expect(custoDeIaNoMes(equipe('1000000', null))).toBe('US$ 1,00');
    expect(custoDeIaNoMes(equipe('0', '5.40'))).toBe('R$ 0,00');
  });

  it('a verba e a equipe: o gasto contra o teto, as mudanças, a plataforma atrasada e o custo de IA', () => {
    expect(verbaEEquipe(verba({ changes: [mudanca] }), equipe('1000000', '5.00'))).toEqual([
      'R$ 350,00 gastos de R$ 500,00 do teto do mês.',
      '1 mudança aprovada nas campanhas.',
      'Custo de IA no mês: R$ 5,00.',
    ]);
    expect(verbaEEquipe(verba({ limit_micros: null, changes: [mudanca, { ...mudanca, action_id: U(3) }] }), undefined)).toEqual([
      'R$ 350,00 gastos no mês; a empresa não tem teto do mês.',
      '2 mudanças aprovadas nas campanhas.',
    ]);
    expect(verbaEEquipe(verba({ missing: ['google_ads'] }), undefined)).toEqual([
      'R$ 350,00 gastos de R$ 500,00 do teto do mês.',
      'Nenhuma mudança nas campanhas pelo Liame.',
      'O gasto do Google Ads vale até a última leitura, que não chegou ao fim do mês.',
    ]);
    // A preposição vai com o nome de cada plataforma (V121): "da Meta", "do Google Ads".
    expect(verbaEEquipe(verba({ missing: ['meta_ads', 'google_ads'] }), undefined)[2]).toBe('O gasto da Meta e do Google Ads vale até a última leitura, que não chegou ao fim do mês.');
    // O relatório gerado antes da parte 2 não tem nenhuma das duas: a parte some do e-mail.
    expect(verbaEEquipe(undefined, undefined)).toEqual([]);
  });
});

describe('e-mail do relatório do mês: o e-mail inteiro', () => {
  const total = (kind: string, unit: string, before: string | null, now: string, change_pct: string | null) => ({ kind, campaign: null, unit, before, now, change_pct });
  const trecho = (text: string) => [{ text, source: null }];
  const conteudo = (o: Partial<ConteudoDoRelatorio> = {}) =>
    ({
      brand_id: U(10),
      month: { from: '2026-09-01', to: '2026-09-30' },
      previous_month: { from: '2026-08-01', to: '2026-08-31' },
      timezone: FUSO,
      currency: 'BRL',
      generated_at: '2026-10-01T08:10:00.000Z',
      totals: [
        total('investimento', 'dinheiro', '340000000', '350000000', '+2.9'),
        total('pedidos_de_anuncios', 'contagem', '11', '12', '+9.1'),
        total('receita_confirmada', 'dinheiro', '950000000', '1120000000', '+17.9'),
        total('roas_confirmado', 'razao', '2.79', '3.20', '+14.7'),
      ],
      verdict: 'lucro',
      weeks: [],
      campaigns: [{ campaign_id: U(11), provider: 'meta_ads', name: 'Combo sexta', spend_micros: '200000000', orders: 10, revenue_micros: '1000000000', roas: '5.00', verdict: 'lucro', margin_known_micros: null }],
      platform_only: [],
      improved: [total('receita_confirmada', 'dinheiro', '950000000', '1120000000', '+17.9')],
      worsened: [],
      decisions: [],
      budget: verba({ changes: [mudanca] }),
      team: equipe('1000000', '5.00'),
      reading: {
        source: 'sistema',
        reason: 'desligada',
        usage_id: null,
        stale_sources: [],
        explanation: { what_happened: trecho('O mês deu lucro.'), reasons: [], risk: 'baixo', risk_reason: trecho('pela regra do sistema, o mês deu lucro.'), what_to_do: [] },
      },
      ...o,
    }) as unknown as ConteudoDoRelatorio;
  const quem = (marca: string) => ({ marca, empresa: 'Mister Burgers', nivel: 'dono', link: 'https://app.agencialiame.com/resultados/relatorio?marca=x&mes=2026-09', imagens: { logo: 'https://app/logo.png', lia: 'https://app/lia.png' } });

  it('o assunto com os pedidos e a receita do mês, a leitura antes das campanhas e a verba e a equipe numa parte só', () => {
    const e = emailDoRelatorio(conteudo(), quem('Mister Burgers'));
    expect(e.subject).toBe('Relatório de setembro da Mister Burgers: 12 pedidos e R$ 1.120,00 no caixa');
    const linhas = e.text.split('\n');
    expect(linhas[0]).toBe('Relatório de setembro da Mister Burgers');
    expect(linhas[1]).toBe('De 01/09/2026 a 30/09/2026, comparado com agosto. Gerado na quinta-feira, 01/10, às 05:10.');
    const ordem = ['OS NÚMEROS DO MÊS', 'LEITURA DO MÊS, PELO SISTEMA (SEM IA)', 'O QUE CADA CAMPANHA TROUXE NO CAIXA', 'A VERBA E A EQUIPE'].map((s) => linhas.indexOf(s));
    expect(ordem.every((i, k) => i > 0 && (k === 0 || i > ordem[k - 1]!))).toBe(true);
    expect(linhas).toContain('R$ 350,00 gastos de R$ 500,00 do teto do mês. 1 mudança aprovada nas campanhas. Custo de IA no mês: R$ 5,00.');
    // O que melhorou, o que piorou e "Para o mês que vem" ficam na tela, como no e-mail do protótipo.
    expect(linhas).not.toContain('O QUE MELHOROU');
    expect(e.html).toContain('Relatório<br>do mês');
    expect(e.html).toContain('Leitura do mês');
    expect(e.html).not.toContain('O que melhorou');
    expect(e.html.indexOf('Leitura do mês')).toBeLessThan(e.html.indexOf('O que cada campanha trouxe no caixa'));
    expect(e.html).toContain('Abrir o relatório no Liame');
  });

  it('sem mês anterior, o período não diz que houve comparação; um pedido só vai no singular; o nome da marca é escapado no HTML', () => {
    const primeiro = conteudo({ totals: [total('pedidos_de_anuncios', 'contagem', null, '1', null), total('receita_confirmada', 'dinheiro', null, '60000000', null)] } as Partial<ConteudoDoRelatorio>);
    const e = emailDoRelatorio(primeiro, quem('Bar <Zé> & Cia'));
    expect(e.subject).toBe('Relatório de setembro da Bar <Zé> & Cia: 1 pedido e R$ 60,00 no caixa');
    expect(e.text.split('\n')[1]).toBe('De 01/09/2026 a 30/09/2026. Gerado na quinta-feira, 01/10, às 05:10.');
    expect(e.html).toContain('Bar &lt;Zé&gt; &amp; Cia');
    expect(e.html).not.toContain('Bar <Zé>');
  });
});
