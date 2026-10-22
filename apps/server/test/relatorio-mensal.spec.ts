import type { AttentionItem, ClosedLoopResponse, SourceFreshness } from '@liame/contracts';
import { describe, expect, it } from 'vitest';
import { contextoDosResultados } from '../src/ai/explicar/contexto.js';
import { marcarNumeros } from '../src/ai/explicar/fontes.js';
import { conferirExplicacao, type Explicacao } from '../src/ai/explicar/resposta.js';
import { explicacaoSemIa } from '../src/ai/explicar/sem-ia.js';
import {
  comAtrasoMarcadoNoMes,
  type ConteudoDoRelatorio,
  DECISOES_MAXIMO,
  diaDoRelatorio,
  mesAnterior,
  mesCurto,
  mesDe,
  mesEmDia,
  mesFechado,
  mesPedido,
  nomeDaSemana,
  nomeDoMes,
  noPrazo,
  paraOMesQueVem,
  paraQuemVe,
  pessoasDaVerba,
  proximoRelatorio,
  semanaComNumeros,
  semanaNoContexto,
  semanasDoMes,
} from '../src/results/relatorio-mensal.js';
import { diaIso } from '../src/results/revisao-semanal.js';

// A3 · I7, o relatório do mês (P24; D-A3-18 a D-A3-22), sem banco: qual é o mês fechado e quando ele sai, as semanas
// do mês cortadas no mês, o que fica para o mês seguinte e a leitura do mês (a do sistema e as fontes das semanas).

const U = (n: number) => `0199a300-0000-7000-8000-${n.toString().padStart(12, '0')}`;
const SETEMBRO = { from: '2026-09-01', to: '2026-09-30' };

type Campanha = { nome: string; gasto: string; pedidos: number; receita: string; roas: string | null; margem: string | null; veredito: string | null };
const COMBO: Campanha = { nome: 'Combo sexta', gasto: '1690400000', pedidos: 98, receita: '6468000000', roas: '3.83', margem: '2474010000', veredito: 'lucro' };
const NOITE: Campanha = { nome: 'Delivery noite', gasto: '744800000', pedidos: 9, receita: '513000000', roas: '0.69', margem: '123120000', veredito: 'prejuizo' };
const PARADA: Campanha = { nome: 'Sem gasto nem pedido', gasto: '0', pedidos: 0, receita: '0', roas: null, margem: null, veredito: null };

function resultado(extra: { from?: string; to?: string; campanhas?: Campanha[]; fontes?: SourceFreshness[] } = {}): ClosedLoopResponse {
  const caixa = { orders: 107, revenue_micros: '6981000000', roas: '2.86', cost_per_order_micros: '22758879', margin_known_micros: '2597130000', margin_coverage_pct: '90.0', verdict: 'lucro' };
  const informa = { spend_micros: '2435200000', value_micros: null, roas: null, window: '7d_click', conversions: null, conversations: null, cost_per_conversation_micros: null };
  return {
    period: { from: extra.from ?? SETEMBRO.from, to: extra.to ?? SETEMBRO.to, timezone: 'America/Sao_Paulo', account_timezones: ['America/Sao_Paulo'] },
    model: { id: U(1), key: 'ultimo_toque', version: 1, window_days: 7, counts_views: false },
    currency: 'BRL',
    totals: {
      spend_micros: '2435200000',
      orders_confirmed: 520,
      revenue_micros: '33800000000',
      confirmed: caixa,
      without_origin: { orders: 186, revenue_micros: '12090000000', share_pct: '63.5' },
      no_click_channels: [],
      cancelled: { orders: 0, revenue_micros: '0' },
    },
    platforms: [{ provider: 'meta_ads', platform: informa, confirmed: caixa, platform_only_orders: 0 }],
    campaigns: (extra.campanhas ?? [COMBO, NOITE]).map((c, i) => ({
      campaign_id: U(10 + i),
      provider: 'meta_ads',
      name: c.nome,
      status: 'ativa',
      platform: { ...informa, spend_micros: c.gasto },
      confirmed: { orders: c.pedidos, revenue_micros: c.receita, roas: c.roas, cost_per_order_micros: null, margin_known_micros: c.margem, margin_coverage_pct: null, verdict: c.veredito },
    })),
    sources: extra.fontes ?? [
      { connected_account_id: U(8), provider: 'meta_ads', name: 'CA - Mister', dataset: 'metricas', freshness: 'fresh', last_success_at: '2026-10-01T08:10:00.000Z', status: 'ativa', timezone: 'America/Sao_Paulo' },
      { connected_account_id: U(9), provider: 'regem', name: 'Loja Centro', dataset: 'pedidos', freshness: 'fresh', last_success_at: '2026-10-01T08:05:00.000Z', status: 'ativa', timezone: 'America/Sao_Paulo' },
    ],
    generated_at: '2026-10-01T08:15:00.000Z',
  };
}

describe('relatório do mês: o mês fechado, quando ele sai e o prazo', () => {
  it('o mês fechado é o anterior ao do dia, inclusive na virada do ano; o anterior a março tem o fevereiro certo', () => {
    expect(mesFechado('2026-10-22')).toEqual(SETEMBRO);
    expect(mesFechado('2026-10-01')).toEqual(SETEMBRO);
    expect(mesFechado('2027-01-01')).toEqual({ from: '2026-12-01', to: '2026-12-31' });
    expect(mesAnterior({ from: '2026-03-01', to: '2026-03-31' })).toEqual({ from: '2026-02-01', to: '2026-02-28' });
    expect(mesAnterior({ from: '2028-03-01', to: '2028-03-31' })).toEqual({ from: '2028-02-01', to: '2028-02-29' });
    expect(mesAnterior({ from: '2027-01-01', to: '2027-01-31' })).toEqual({ from: '2026-12-01', to: '2026-12-31' });
    expect(mesDe('2026-02-14')).toEqual({ from: '2026-02-01', to: '2026-02-28' });
    expect(mesPedido('2026-09')).toEqual(SETEMBRO);
    expect(diaDoRelatorio(SETEMBRO)).toBe('2026-10-01');
    expect([nomeDoMes(SETEMBRO), mesCurto(SETEMBRO), mesCurto({ from: '2026-03-01', to: '2026-03-31' })]).toEqual(['setembro de 2026', 'setembro', 'março']);
  });

  it('o prazo de gerar e de enviar vai do dia 1º ao dia 7 do mês seguinte (o primeiro relatório não sai de um mês velho)', () => {
    expect(['2026-09-30', '2026-10-01', '2026-10-07', '2026-10-08', '2026-10-22'].map((hoje) => noPrazo(hoje, SETEMBRO))).toEqual([false, true, true, false, false]);
  });

  it('o próximo relatório: no dia 1º, o de hoje, se ainda não saiu; senão, o dia 1º seguinte', () => {
    expect(proximoRelatorio('2026-11-01', null)).toBe('2026-11-01');
    expect(proximoRelatorio('2026-11-01', '2026-09-01')).toBe('2026-11-01');
    expect(proximoRelatorio('2026-11-01', '2026-10-01')).toBe('2026-12-01');
    expect(proximoRelatorio('2026-10-22', null)).toBe('2026-11-01');
    expect(proximoRelatorio('2026-12-15', '2026-11-01')).toBe('2027-01-01');
  });
});

describe('relatório do mês: as semanas, cortadas no mês', () => {
  it('setembro de 2026 começa numa terça: a primeira e a última semanas ficam cortadas, com a semana inteira da revisão ao lado', () => {
    expect(semanasDoMes(SETEMBRO)).toEqual([
      { from: '2026-09-01', to: '2026-09-06', days: 6, week: { from: '2026-08-31', to: '2026-09-06' } },
      { from: '2026-09-07', to: '2026-09-13', days: 7, week: { from: '2026-09-07', to: '2026-09-13' } },
      { from: '2026-09-14', to: '2026-09-20', days: 7, week: { from: '2026-09-14', to: '2026-09-20' } },
      { from: '2026-09-21', to: '2026-09-27', days: 7, week: { from: '2026-09-21', to: '2026-09-27' } },
      { from: '2026-09-28', to: '2026-09-30', days: 3, week: { from: '2026-09-28', to: '2026-10-04' } },
    ]);
    // Fevereiro de 2027 começa numa segunda e tem 28 dias: quatro semanas inteiras, sem corte.
    expect(semanasDoMes({ from: '2027-02-01', to: '2027-02-28' }).map((s) => [s.from, s.to, s.days])).toEqual([
      ['2027-02-01', '2027-02-07', 7],
      ['2027-02-08', '2027-02-14', 7],
      ['2027-02-15', '2027-02-21', 7],
      ['2027-02-22', '2027-02-28', 7],
    ]);
  });

  it('em todo mês de 2026 a 2028, os dias das semanas somam o mês, sem buraco nem repetição, e cada semana inteira começa na segunda', () => {
    const falhas: string[] = [];
    for (let ano = 2026; ano <= 2028; ano++) {
      for (let m = 1; m <= 12; m++) {
        const mes = mesDe(`${ano}-${String(m).padStart(2, '0')}-01`);
        const semanas = semanasDoMes(mes);
        const dias = semanas.reduce((s, w) => s + w.days, 0);
        const tamanho = Number(mes.to.slice(8, 10));
        if (dias !== tamanho) falhas.push(`${mes.from}: ${dias} dias nas semanas, ${tamanho} no mês`);
        if (semanas[0]!.from !== mes.from || semanas.at(-1)!.to !== mes.to) falhas.push(`${mes.from}: as pontas`);
        if (semanas.some((w) => diaIso(w.week.from) !== 1)) falhas.push(`${mes.from}: semana que não começa na segunda`);
      }
    }
    expect(falhas).toEqual([]);
  });

  it('o nome pronto da semana leva o ano, e os números da semana já vêm escritos para a leitura', () => {
    expect(nomeDaSemana({ from: '2026-09-01', to: '2026-09-06' })).toBe('a semana de 01/09/2026 a 06/09/2026');
    const semana = semanaComNumeros(semanasDoMes(SETEMBRO)[0]!, resultado({ from: '2026-09-01', to: '2026-09-06' }), true);
    expect(semana).toMatchObject({ from: '2026-09-01', to: '2026-09-06', days: 6, has_review: true, spend_micros: '2435200000', orders: 107, revenue_micros: '6981000000', roas: '2.86', verdict: 'lucro' });
    expect(semanaNoContexto(semana, 'BRL')).toEqual({
      semana: 'a semana de 01/09/2026 a 06/09/2026',
      investimento: 'R$ 2.435,20',
      pedidos_com_origem: '107',
      receita_com_origem: 'R$ 6.981,00',
      roas_confirmado: '2,86',
    });
  });
});

describe('relatório do mês: as fontes em dia', () => {
  const meta = (lidaEm: string): SourceFreshness => ({ connected_account_id: U(8), provider: 'meta_ads', name: 'CA - Mister', dataset: 'metricas', freshness: 'fresh', last_success_at: lidaEm, status: 'ativa', timezone: 'America/Sao_Paulo' });
  const regem: SourceFreshness = { connected_account_id: U(9), provider: 'regem', name: 'Loja Centro', dataset: 'pedidos', freshness: 'fresh', last_success_at: '2026-10-01T08:05:00.000Z', status: 'ativa', timezone: 'America/Sao_Paulo' };

  it('o mês está em dia com a conta de anúncio lida depois do fim do mês; lida no último dia, ainda não, e sai marcada como atrasada', () => {
    const fuso = 'America/Sao_Paulo';
    // 05:10 de 01/10 em Brasília: já traz o 30/09 inteiro.
    expect(mesEmDia([meta('2026-10-01T08:10:00.000Z'), regem], SETEMBRO, fuso)).toBe(true);
    // 22:00 de 30/09 em Brasília (01:00 de 01/10 em UTC): o dia ainda não acabou na loja.
    expect(mesEmDia([meta('2026-10-01T01:00:00.000Z'), regem], SETEMBRO, fuso)).toBe(false);
    expect(mesEmDia([{ ...regem, freshness: 'delayed' }, meta('2026-10-01T08:10:00.000Z')], SETEMBRO, fuso)).toBe(false);
    expect(mesEmDia([], SETEMBRO, fuso)).toBe(false);
    const marcado = comAtrasoMarcadoNoMes(resultado({ fontes: [meta('2026-10-01T01:00:00.000Z'), regem] }), SETEMBRO, fuso);
    expect(marcado.sources.map((s) => [s.dataset, s.freshness])).toEqual([['metricas', 'delayed'], ['pedidos', 'fresh']]);
  });
});

describe('relatório do mês: para o mês que vem', () => {
  const aviso = (severity: string, title: string): AttentionItem => ({
    kind: 'link_sem_rastreio',
    severity,
    title,
    detail: 'detalhe',
    action: 'o que fazer',
    connected_account_id: null,
    campaign_id: null,
    provider: null,
    brand_id: U(3),
  });

  it('a campanha que deu prejuízo no mês, com quanto faltou para a margem pagar o anúncio, e os avisos críticos e de atenção, os mais graves primeiro', () => {
    const itens = paraOMesQueVem(resultado({ campanhas: [COMBO, NOITE, PARADA] }), [aviso('info', 'só informação'), aviso('atencao', 'de atenção'), aviso('critica', 'crítico')], U(3), SETEMBRO);
    expect(itens.map((i) => [i.kind, i.severity, i.title])).toEqual([
      ['prejuizo_no_mes', 'atencao', 'Delivery noite deu prejuízo em setembro'],
      ['link_sem_rastreio', 'critica', 'crítico'],
      ['link_sem_rastreio', 'atencao', 'de atenção'],
    ]);
    // R$ 744,80 investidos e R$ 123,12 de margem: faltaram R$ 621,68.
    expect(itens[0]).toMatchObject({
      detail: 'Faltaram R$ 621,68 para a margem dos pedidos pagar o anúncio: R$ 513,00 de receita para R$ 744,80 investidos no mês.',
      action: 'Veja a campanha em Resultados e decida se ela continua como está.',
      campaign_id: U(11),
      provider: 'meta_ads',
      brand_id: U(3),
    });
  });

  it(`no máximo ${DECISOES_MAXIMO} itens; sem margem conhecida, o texto diz só os valores`, () => {
    const semMargem = { ...NOITE, margem: null };
    const itens = paraOMesQueVem(resultado({ campanhas: [semMargem] }), Array.from({ length: 8 }, (_, i) => aviso('atencao', `aviso ${i}`)), U(3), SETEMBRO);
    expect(itens).toHaveLength(DECISOES_MAXIMO);
    expect(itens[0]!.detail).toBe('R$ 513,00 de receita para R$ 744,80 investidos no mês.');
  });
});

describe('relatório do mês: a leitura', () => {
  it('a leitura do sistema fala do mês: "o mês", o mês anterior pelo nome e "neste mês"', () => {
    const anterior = resultado({ from: '2026-08-01', to: '2026-08-31' });
    const contexto = contextoDosResultados({ ...resultado(), totals: { ...resultado().totals, spend_micros: '2600000000' } }, anterior);
    const e = explicacaoSemIa(contexto, { mes: { anterior: 'agosto' } });
    expect(e.o_que_aconteceu).toContain('Em relação a agosto, o investimento subiu');
    expect(e.risco_motivo).toBe('pela regra do sistema, o mês deu lucro depois de pagar os anúncios.');
    // Sem campanha com investimento para comparar (e sem pedido sem origem, que daria outro motivo), o motivo fala do mês.
    const vazio = resultado({ campanhas: [] });
    vazio.totals.without_origin = { orders: 0, revenue_micros: '0', share_pct: '0.0' };
    const semCampanha = explicacaoSemIa(contextoDosResultados(vazio, null), { mes: { anterior: 'agosto' } });
    expect(semCampanha.motivos).toContain('Ainda não há campanha com investimento e pedido confirmado neste mês para comparar.');
  });

  it('de onde vêm os números das semanas: o número de uma semana tem a semana como fonte, e a data com o ano conta inteira', () => {
    const [, segunda] = semanasDoMes(SETEMBRO);
    const semana = semanaComNumeros(segunda!, { ...resultado(), totals: { ...resultado().totals, spend_micros: '1150800000', confirmed: { ...resultado().totals.confirmed, orders: 44, revenue_micros: '2790000000', roas: '2.42' } } }, true);
    const contexto = { ...contextoDosResultados(resultado(), null), semanas: [semanaNoContexto(semana, 'BRL')] };
    const e: Explicacao = {
      o_que_aconteceu: 'Na semana de 07/09/2026 a 13/09/2026 vieram 44 pedidos confirmados e R$ 2.790,00 no caixa.',
      motivos: ['O investimento da semana foi de R$ 1.150,80.'],
      risco: 'baixo',
      risco_motivo: 'o mês deu lucro.',
      o_que_fazer: ['Mantenha as campanhas.'],
    };
    const marcada = marcarNumeros(e, contexto);
    expect(marcada.numeros).toEqual([
      { valor: '07/09/2026', fontes: ['Liame · semana de 07/09/2026 a 13/09/2026, cortada no mês'] },
      { valor: '13/09/2026', fontes: ['Liame · semana de 07/09/2026 a 13/09/2026, cortada no mês'] },
      { valor: '44', fontes: ['Regem · pedidos confirmados com origem provada na semana de 07/09/2026 a 13/09/2026'] },
      { valor: 'R$ 2.790,00', fontes: ['Regem · receita confirmada com origem provada na semana de 07/09/2026 a 13/09/2026'] },
      { valor: 'R$ 1.150,80', fontes: ['Meta · investimento na semana de 07/09/2026 a 13/09/2026'] },
    ]);
    expect(conferirExplicacao(e, contexto)).toBeNull();
    // O dia e o mês sem o ano são números soltos: a semana de 21/09 a 27/09 escrita assim não passa na conferência.
    expect(conferirExplicacao({ ...e, o_que_aconteceu: 'Na semana de 21/09 a 27/09 vieram 44 pedidos.' }, contexto)).toMatchObject({ recusa: 'numero_fora' });
  });
});

describe('relatório do mês: a verba e a equipe para quem vê as telas de origem (D-A3-22)', () => {
  const estado = (verba: string | null) => ({ status: 'ativa', daily_micros: verba });
  const mudanca = (id: number, quem: string, aprovou: string | null) => ({
    action_id: U(id),
    executed_on: '2026-09-11',
    action: 'orcamento.aumentar',
    provider: 'meta_ads',
    target: { kind: 'campanha', name: 'Combo sexta', campaign_name: null },
    from: estado('55000000'),
    to: estado('60000000'),
    requested_by: quem,
    approved_by: aprovou,
    agent_key: null,
    check: 'confere',
  });
  const equipe = { members: [{ key: 'analista', stats: [{ key: 'explicacoes', value: '3', unit: 'qtd' }] }], ai: { spent_usd_micros: '1000', ceiling_usd_micros: '20000000' }, usd_brl: null };
  // Só as partes que a função olha: o resto do relatório passa como está.
  const conteudo = (comAsDuas = true) =>
    ({
      brand_id: U(3),
      month: SETEMBRO,
      ...(comAsDuas
        ? { budget: { currency: 'BRL', spend_micros: '350000000', limit_micros: null, missing: [], changes: [mudanca(70, U(91), U(92)), mudanca(71, U(91), null)] }, team: equipe }
        : {}),
    }) as unknown as ConteudoDoRelatorio;

  it('a verba vai para quem tem campanhas.ver; a equipe, para quem tem campanhas.ver e vendas.ver; os nomes são os de agora', () => {
    expect(pessoasDaVerba(conteudo())).toEqual([U(91), U(92)]);
    expect(pessoasDaVerba(conteudo(false))).toEqual([]);
    const nomes = new Map([[U(91), 'Rodrigo']]);

    const tudo = paraQuemVe(conteudo(), new Set(['vendas.ver', 'campanhas.ver']), nomes);
    // Quem pediu é lido pelo nome; quem aprovou e não existe mais aparece como "Pessoa removida", como na Verba do mês.
    expect(tudo.budget!.changes.map((m) => [m.requested_by, m.approved_by])).toEqual([
      [{ id: U(91), name: 'Rodrigo' }, { id: U(92), name: 'Pessoa removida' }],
      [{ id: U(91), name: 'Rodrigo' }, null],
    ]);
    expect(tudo.budget).toMatchObject({ spend_micros: '350000000', limit_micros: null });
    expect(tudo.team).toEqual(equipe);

    // Só as vendas (a rota pede `vendas.ver`): nem a verba nem a equipe. Só as campanhas: a verba, sem a equipe.
    const soVendas = paraQuemVe(conteudo(), new Set(['vendas.ver']), nomes);
    expect(soVendas).not.toHaveProperty('budget');
    expect(soVendas).not.toHaveProperty('team');
    expect(soVendas).toMatchObject({ brand_id: U(3), month: SETEMBRO });
    const soCampanhas = paraQuemVe(conteudo(), new Set(['campanhas.ver']), nomes);
    expect(soCampanhas.budget).toBeDefined();
    expect(soCampanhas).not.toHaveProperty('team');

    // O relatório gerado antes da parte 2 não tem as duas e passa como está.
    const antigo = paraQuemVe(conteudo(false), new Set(['vendas.ver', 'campanhas.ver']), nomes);
    expect(antigo).not.toHaveProperty('budget');
    expect(antigo).not.toHaveProperty('team');
  });
});
