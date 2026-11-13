import type { ActionResponse, AttentionItem, BudgetMonthChange, BudgetMonthResponse, RegionRhythmDetailResponse } from '@liame/contracts';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { type AcaoDeAnuncio, avisoDoDesfazerNoRitmo, origemDoAnuncio } from '@/components/aprovacoes/anuncio-textos';
import {
  campanhaNoRitmo,
  diaEscrito,
  ehPedidoDoRitmo,
  fraseDoRitmo,
  idDoRitmo,
  linhasDoRitmoNaRegiao,
  motivoDoBloqueio,
  porqueDoDia,
  quandoEscrito,
  situacaoDoRitmo,
  tituloDoRitmo,
  trilhaDoRitmo,
  variacaoDoDia,
} from '@/components/aprovacoes/ritmo-textos';
import { apresentar } from '@/components/aprovacoes/textos';
import { ItemAviso } from '@/components/atencao/item-aviso';
import { acaoDoAviso, destinoDoRitmo } from '@/components/atencao/textos';
import { tituloDoPedido } from '@/components/pedir/textos';
import { mudancasDaVerba, ritmosDaVerba } from '@/components/verba/textos';

// Plano da região, R7, parte 1b-3b (protótipo aprovado pelo dono em 13/11/2026): as frases do ritmo da semana nas telas,
// sem React. Em Aprovações: o título, o porquê de cada dia, a situação do ritmo e de cada campanha, o caminho (o que o
// Liame fez em cada dia) e o motivo do que ficou bloqueado. Na Verba do mês: a mudança trocada pelo ritmo e os passos
// juntos, uma linha por semana.

const REAL = 1_000_000;
const nbsp = (s: string) => s.replaceAll('R$ ', `R$${String.fromCharCode(160)}`);
const ID = '0190d2b0-0000-7000-8000-0000000000a1';
const DIAS = ['2026-11-16', '2026-11-17', '2026-11-18', '2026-11-19', '2026-11-20', '2026-11-21', '2026-11-22'];
const PESOS = [0.905, 0.82, 0.885, 0.969, 1.061, 1.161, 1.2];
const porDia = (base: number) => PESOS.map((p) => Math.round(base * p * 100) * 10_000);
const pedidos = (share: number) => ({ kind: 'pedidos', share_pct: share, text: null, min: null, max: null, eve: null });

type Ritmo = RegionRhythmDetailResponse;
type Passo = Ritmo['campaigns'][number]['steps'][number];
const passo = (o: Partial<Passo>): Passo => ({ day: DIAS[0]!, kind: 'ritmo', status: 'feito', target_micros: 54_300_000, expected_micros: 60 * REAL, reason: null, action_id: null, at: '2026-11-16T03:05:00.000Z', ...o });
function ritmo(o: Partial<Ritmo> = {}): Ritmo {
  const campanhas: Ritmo['campaigns'] = [
    { resource: 'campanha:120210000000001', name: 'Combo sexta', base_micros: 60 * REAL, days_micros: porDia(60), week_micros: porDia(60).reduce((s, v) => s + v, 0), state: 'proposta', left_micros: 60 * REAL, steps: [] },
    { resource: 'campanha:120210000000002', name: 'Smash em dobro', base_micros: 40 * REAL, days_micros: porDia(40), week_micros: porDia(40).reduce((s, v) => s + v, 0), state: 'proposta', left_micros: 40 * REAL, steps: [] },
  ];
  return {
    id: ID,
    brand_id: '0190d2b0-0000-7000-8000-0000000000b1',
    unit: { id: '0190d2b0-0000-7000-8000-0000000000c1', name: 'Loja Centro' },
    status: 'pedido',
    week: { from: DIAS[0]!, to: DIAS[6]! },
    source: 'loja',
    today: '2026-11-15',
    action_id: '0190d2b0-0000-7000-8000-0000000000d1',
    requested_at: '2026-11-15T19:00:00.000Z',
    approved_at: null,
    approved_by: null,
    stopped_at: null,
    stopped_by: null,
    days: DIAS.map((day, i) => ({ day, weekday: (i + 1) % 7, weight: PESOS[i]!, total_micros: campanhas.reduce((s, c) => s + c.days_micros[i]!, 0), reasons: [pedidos([12, 8, 8, 7, 19, 22, 22][i]!)] })),
    campaigns: campanhas,
    out: [],
    base_micros: 100 * REAL,
    base_week_micros: 700 * REAL,
    week_micros: campanhas.reduce((s, c) => s + c.week_micros, 0),
    ceiling_micros: 150 * REAL,
    generated_at: '2026-11-15T19:05:00.000Z',
    ...o,
  };
}

describe('o ritmo da semana em Aprovações (R7, parte 1b-3b)', () => {
  it('o pedido e o recurso: só o ritmo da semana abre o detalhe próprio', () => {
    expect([ehPedidoDoRitmo({ tool: 'ritmo_da_semana' }), ehPedidoDoRitmo({ tool: 'orcamento_do_ritmo' }), ehPedidoDoRitmo({ tool: 'orcamento_ajustar' })]).toEqual([true, false, false]);
    expect(idDoRitmo(`ritmo:${ID}`)).toBe(ID);
    expect([idDoRitmo('ritmo:123'), idDoRitmo(`campanha_nova:${ID}`), idDoRitmo('campanha:120210000000001')]).toEqual([null, null, null]);
    expect(tituloDoRitmo({ from: '2026-11-16', to: '2026-11-22' })).toBe('Ritmo da semana: 16/11 a 22/11');
    expect([diaEscrito('2026-11-16', 1), diaEscrito('2026-11-22', 0)]).toEqual(['Seg, 16/11', 'Dom, 22/11']);
    // A hora é a de Brasília: 19:00Z de domingo são 16:00.
    expect(quandoEscrito('2026-11-15T19:00:00.000Z')).toBe('15/11 às 16:00');
  });

  it('a linha da lista, o passo diário e o título pela ação', () => {
    const a = { tool: 'ritmo_da_semana', action: 'ritmo.aprovar', account_name: 'CA - Mister Burgers', requested_by: { id: ID, name: 'Rodrigo' }, params: {} } as unknown as ActionResponse;
    expect(apresentar(a)).toMatchObject({ titulo: 'Ritmo da semana em CA - Mister Burgers', impacto: 'sem verba nova' });
    expect(apresentar(a).desfazer).toContain('“Parar o ritmo”');
    // O passo de um dia aparece como a mudança de verba de sempre, com a origem dita.
    expect(origemDoAnuncio({ tool: 'orcamento_do_ritmo', undoes: null, recommendation: null, agent_key: 'trafego' } as never)).toBe('pelo ritmo da semana que uma pessoa aprovou');
    expect(origemDoAnuncio({ tool: 'orcamento_ajustar', undoes: null, recommendation: null, agent_key: null } as never)).toBeNull();
    const alvo = { kind: 'campanha', name: 'Combo sexta' };
    expect(tituloDoPedido('orcamento.ritmo_aumentar', alvo)).toBe('Aumentar a verba da campanha “Combo sexta”, pelo ritmo da semana');
    expect(tituloDoPedido('orcamento.ritmo_reduzir', alvo)).toBe('Reduzir a verba da campanha “Combo sexta”, pelo ritmo da semana');
    expect(tituloDoPedido('orcamento.aumentar', alvo)).toBe('Aumentar a verba da campanha “Combo sexta”');
  });

  it('o dia: quanto muda sobre a verba de hoje e o porquê (os pedidos, o setor, a chuva e a data)', () => {
    expect([variacaoDoDia(1.2), variacaoDoDia(0.82), variacaoDoDia(1.004), variacaoDoDia(0.996)]).toEqual([
      { texto: '+20%', tom: 'mais' },
      { texto: '−18%', tom: 'menos' },
      { texto: 'igual a hoje', tom: 'igual' },
      { texto: 'igual a hoje', tom: 'igual' },
    ]);
    expect([7, 12, 14, 17, 22].map((p) => porqueDoDia(pedidos(p)).texto)).toEqual([
      'Dia fraco: 7% dos pedidos da semana (a média de um dia é 14%)',
      'Abaixo da média: 12% dos pedidos da semana',
      'Na média: 14% dos pedidos da semana',
      'Acima da média: 17% dos pedidos da semana',
      'Dia forte: 22% dos pedidos da semana',
    ]);
    expect(porqueDoDia({ kind: 'chuva', share_pct: null, text: 'Pancadas de chuva à tarde', min: 19, max: 24, eve: null })).toEqual({ icone: 'cloud-rain', texto: 'Chuva prevista: pancadas de chuva à tarde, 19° a 24°' });
    expect(porqueDoDia({ kind: 'data', share_pct: null, text: 'Consciência Negra', min: null, max: null, eve: false })).toEqual({ icone: 'calendar', texto: 'Consciência Negra' });
    expect(porqueDoDia({ kind: 'data', share_pct: null, text: 'Consciência Negra', min: null, max: null, eve: true }).texto).toBe('Véspera: Consciência Negra');
    expect(porqueDoDia({ kind: 'setor', share_pct: null, text: null, min: null, max: null, eve: null }).texto).toContain('referência do setor');
  });

  it('a frase do pedido: onde desce, onde sobe e a soma das verbas da semana sem aumentar', () => {
    const f = fraseDoRitmo(ritmo());
    expect(f.dias).toBe('Nesta semana, a verba de cada dia segue os pedidos da loja: menos na segunda, na terça, na quarta e na quinta; mais na sexta, no sábado e no domingo.');
    expect(f.semana).toBe(nbsp('A soma das verbas da semana não aumenta: R$ 700,10 nos 7 dias (sem o ritmo, R$ 700,00), em 2 campanhas.').replace('700,10', (ritmo().week_micros / REAL).toFixed(2).replace('.', ',')));
    // Sem diferença que valha, a frase diz que fica igual; com a referência do setor, cita o setor.
    const igual = ritmo({ days: ritmo().days.map((d) => ({ ...d, weight: 1 })), source: 'setor' });
    expect(fraseDoRitmo(igual).dias).toBe('Nesta semana, a verba de cada dia fica igual à de hoje: a referência do setor não pede mudança.');
    expect(fraseDoRitmo(ritmo({ campaigns: [ritmo().campaigns[0]!] })).semana).toContain('em 1 campanha.');
  });

  it('a situação do ritmo e de cada campanha', () => {
    const s = (o: Partial<Ritmo>) => situacaoDoRitmo(ritmo(o)).rotulo;
    expect([s({}), s({ status: 'cancelado' }), s({ status: 'parado' }), s({ status: 'encerrado' })]).toEqual(['Espera a aprovação', 'Não aprovado', 'Parado', 'Encerrado']);
    expect([s({ status: 'aprovado', today: '2026-11-15' }), s({ status: 'aprovado', today: '2026-11-18' }), s({ status: 'aprovado', today: '2026-11-23' })]).toEqual(['Aprovado: começa na segunda', 'Rodando', 'Voltando à verba de antes']);
    const c = ritmo().campaigns[0]!;
    expect(campanhaNoRitmo(c)).toBeNull();
    expect(campanhaNoRitmo({ ...c, state: 'no_ritmo' })).toEqual({ rotulo: 'No ritmo', tom: 'concluido', nota: null });
    expect(campanhaNoRitmo({ ...c, state: 'voltou' })).toEqual({ rotulo: 'De volta à verba de antes', tom: 'neutro', nota: null });
    const fora = campanhaNoRitmo({ ...c, state: 'fora', steps: [passo({ day: '2026-11-18', status: 'fora' })] })!;
    expect([fora.rotulo, fora.tom]).toEqual(['Saiu do ritmo', 'perigo']);
    expect(fora.nota).toContain('Em 18/11, a verba dela na Meta não era a que o Liame tinha deixado');
    // Voltando: a verba em que ficou e a de antes; e a volta que o mês não deixa sair.
    expect(campanhaNoRitmo({ ...c, state: 'voltando', left_micros: 64_800_000, steps: [passo({ kind: 'volta', day: '2026-11-23', target_micros: 64_800_000 })] })!.nota).toBe(
      nbsp('Está em R$ 64,80 por dia; a de antes é R$ 60,00. A volta respeita o limite de 10% por mudança.'),
    );
    const presa = campanhaNoRitmo({
      ...c,
      state: 'voltando',
      left_micros: 54 * REAL,
      steps: [passo({ kind: 'volta', day: '2026-11-19', status: 'bloqueado', reason: 'orcamento-insuficiente: Não cabe na verba de novembro: o pedido acrescenta R$ 64,80 até o fim do mês, e sobram R$ 1,00.' })],
    })!;
    expect(presa.nota).toBe(nbsp('Está em R$ 54,00 por dia; a de antes é R$ 60,00. A volta de 19/11 não saiu: não cabe na verba de novembro: o pedido acrescenta R$ 64,80 até o fim do mês, e sobram R$ 1,00. O Liame tenta de novo todo dia.').replace('R$ 64,80 até', 'R$ 64,80 até').replace('sobram R$ 1,00', 'sobram R$ 1,00'));
  });

  it('o motivo do que ficou bloqueado, em palavras', () => {
    expect(motivoDoBloqueio('ritmo da semana: ritmo_parado')).toBe('o ritmo foi parado antes de o passo sair');
    expect(motivoDoBloqueio('ritmo da semana: fora_do_dia')).toBe('o pedido ficou na fila e o dia virou');
    expect(motivoDoBloqueio('ritmo-segurado: O ritmo da semana não muda esta verba agora (acima_do_teto_por_campanha).')).toBe('passaria do teto por campanha');
    expect(motivoDoBloqueio('o teto por campanha não deixa a verba subir')).toBe('o teto por campanha não deixa a verba subir');
    expect(motivoDoBloqueio('politica-negou: Esta ação fere uma regra da política da empresa ou da plataforma.')).toBe('esta ação fere uma regra da política da empresa ou da plataforma');
    expect(motivoDoBloqueio(null)).toBe('não coube nos limites de agora');
  });

  it('o caminho do ritmo: o pedido, a aprovação, cada dia, a campanha que saiu, a parada e a volta', () => {
    expect(trilhaDoRitmo(ritmo()).map((p) => [p.estado, p.titulo])).toEqual([
      ['ok', 'Pedido pelo Gestor de tráfego'],
      ['espera', 'Espera a sua aprovação, com o código do app'],
    ]);
    expect(trilhaDoRitmo(ritmo({ status: 'cancelado' })).at(-1)).toMatchObject({ estado: 'falha', sub: 'nada mudou nas campanhas' });
    // Rodando na quarta: segunda e terça feitas, hoje com uma campanha fora, os outros dias por vir.
    const feitos = (c: Ritmo['campaigns'][number], n: number): Passo[] => DIAS.slice(0, n).map((day, i) => passo({ day, target_micros: c.days_micros[i]! }));
    const [a, b] = ritmo().campaigns as [Ritmo['campaigns'][number], Ritmo['campaigns'][number]];
    const rodando = ritmo({
      status: 'aprovado',
      today: '2026-11-18',
      approved_at: '2026-11-15T21:42:00.000Z',
      approved_by: { id: ID, name: 'Rodrigo' },
      campaigns: [
        { ...a, state: 'no_ritmo', steps: feitos(a, 3) },
        { ...b, state: 'fora', steps: [...feitos(b, 2), passo({ day: '2026-11-18', status: 'fora', reason: 'a campanha não está como o Liame deixou' })] },
      ],
    });
    const trilha = trilhaDoRitmo(rodando);
    expect(trilha.map((p) => p.estado)).toEqual(['ok', 'ok', 'ok', 'ok', 'falha', 'depois', 'depois', 'depois', 'depois', 'depois']);
    expect(trilha[1]).toEqual({ estado: 'ok', titulo: 'Aprovado por Rodrigo, com o código do app', sub: '15/11 às 18:42' });
    expect(trilha[2]!.sub).toBe('2 campanhas na verba do dia');
    expect(trilha[4]).toMatchObject({ titulo: expect.stringContaining('Qua, 18/11 (hoje): verba do dia'), sub: '1 campanha na verba do dia · 1 saiu do ritmo' });
    expect(trilha.at(-1)!.titulo).toBe(nbsp('Depois de 22/11: a verba volta à de antes (R$ 100,00 por dia)'));
    // Sem passo ainda hoje: o dia espera.
    expect(trilhaDoRitmo(ritmo({ status: 'aprovado', today: '2026-11-16', approved_at: '2026-11-15T21:42:00.000Z' }))[2]).toMatchObject({ estado: 'espera', sub: 'o Liame põe a verba do dia em instantes' });
    // Parado na quarta, com uma campanha ainda voltando; e encerrado, com todas de volta.
    const parado = trilhaDoRitmo(
      ritmo({
        status: 'parado',
        today: '2026-11-18',
        approved_at: '2026-11-15T21:42:00.000Z',
        stopped_at: '2026-11-18T18:20:00.000Z',
        stopped_by: { id: ID, name: 'Rodrigo' },
        campaigns: [
          { ...a, state: 'voltando', left_micros: 54 * REAL, steps: feitos(a, 3) },
          { ...b, state: 'voltou', steps: feitos(b, 3) },
        ],
      }),
    );
    expect(parado.slice(-2)).toEqual([
      { estado: 'falha', titulo: 'Parado por Rodrigo', sub: '18/11 às 15:20' },
      { estado: 'espera', titulo: 'A verba está voltando à de antes: 1 campanha ainda não chegou', sub: 'em até 10% por dia' },
    ]);
    const encerrado = trilhaDoRitmo(ritmo({ status: 'encerrado', today: '2026-11-25', approved_at: '2026-11-15T21:42:00.000Z', campaigns: [{ ...a, state: 'voltou' }, { ...b, state: 'fora' }] }));
    expect(encerrado.at(-1)).toEqual({ estado: 'ok', titulo: nbsp('A verba voltou à de antes (R$ 100,00 por dia)'), sub: '1 campanha saiu do ritmo e ficou como estava na Meta' });
  });
});

describe('o ritmo da semana na Verba do mês (R7, parte 1b-3b)', () => {
  it('os passos do ritmo juntos, uma linha por semana, com o caminho para Aprovações', () => {
    const acao = '0190d2b0-0000-7000-8000-0000000000d1';
    const linhas = ritmosDaVerba({
      rhythms: [
        { id: ID, status: 'aprovado', week: { from: '2026-11-16', to: '2026-11-22' }, action_id: acao, steps: 13, objects: 3 },
        { id: ID.replace('a1', 'a2'), status: 'parado', week: { from: '2026-11-09', to: '2026-11-15' }, action_id: null, steps: 1, objects: 1 },
      ],
    });
    expect(linhas).toEqual([
      { id: ID, titulo: 'Ritmo da semana de 16/11 a 22/11 (aprovado)', texto: '13 mudanças de verba em 3 campanhas, dentro do que foi aprovado para a semana.', href: `/aprovacoes?pedido=${acao}` },
      { id: ID.replace('a1', 'a2'), titulo: 'Ritmo da semana de 09/11 a 15/11 (parado)', texto: '1 mudança de verba em 1 campanha, dentro do que foi aprovado para a semana.', href: null },
    ]);
    // A resposta de antes do ritmo não traz o campo: nenhuma linha.
    expect(ritmosDaVerba({})).toEqual([]);
  });

  it('a mudança de uma pessoa trocada depois por um passo do ritmo diz que foi o ritmo', () => {
    const mudanca = (rhythm?: true): BudgetMonthChange => ({
      action_id: ID,
      executed_at: '2026-11-17T15:00:00.000Z',
      executed_on: '2026-11-17',
      tool: 'orcamento_ajustar',
      action: 'orcamento.aumentar',
      provider: 'meta_ads',
      account_id: ID,
      target: { kind: 'campanha', name: 'Combo sexta', campaign_name: null },
      from: { status: 'ativo', daily_micros: 60 * REAL },
      to: { status: 'ativo', daily_micros: 63 * REAL },
      requested_by: { id: ID, name: 'Rodrigo' },
      agent_key: null,
      undoes: null,
      check: null,
      superseded_by: { action_id: ID, executed_at: '2026-11-18T03:05:00.000Z', ...(rhythm ? { rhythm } : {}) },
    });
    const verba = (m: BudgetMonthChange): BudgetMonthResponse => ({
      period: '2026-11',
      timezone: 'America/Sao_Paulo',
      today: '2026-11-19',
      month_start: '2026-11-01',
      month_end: '2026-11-30',
      through: '2026-11-18',
      days_left: 12,
      currency: 'BRL',
      spend_micros: 1800 * REAL,
      daily_micros: 100 * REAL,
      forecast_micros: 3000 * REAL,
      forecast_days: 12,
      pending_daily_micros: 0,
      pending_micros: 0,
      limits: { month_micros: 5500 * REAL, campaign_daily_micros: 150 * REAL, set_by: { id: ID, name: 'Rodrigo' }, set_at: '2026-11-01T15:00:00.000Z' },
      remaining_micros: 2500 * REAL,
      platforms: [],
      rules: { change_percent_max: 10, rate_limit: { max: 3, window_minutes: 60 } },
      changes: [m],
      rhythms: [{ id: ID, status: 'aprovado', week: { from: '2026-11-16', to: '2026-11-22' }, action_id: null, steps: 1, objects: 1 }],
      overspend: [],
      largest_daily_micros: 60 * REAL,
      generated_at: '2026-11-19T17:40:00.000Z',
    });
    expect(mudancasDaVerba(verba(mudanca(true))).linhas[0]!.nota).toBe('O ritmo da semana mudou a verba depois, em 18/11: ele segue o que foi aprovado para a semana.');
    expect(mudancasDaVerba(verba(mudanca())).linhas[0]!.nota).toBe('O Liame mudou de novo em 18/11: vale o pedido mais recente.');
    expect(mudancasDaVerba(verba(mudanca(true))).ritmos).toHaveLength(1);
    // Sem mudança na lista, mas com o ritmo: o vazio não diz que o Liame não mudou nada.
    const soRitmo: BudgetMonthResponse = { ...verba(mudanca(true)), changes: [] };
    expect(mudancasDaVerba(soRitmo).vazio.titulo).toBe('Fora do ritmo da semana, o Liame não mudou nada em novembro');
  });
});

describe('o ritmo da semana em Sua região (R7, parte 1b-3b; D-RG-65)', () => {
  const ref = (status: string, de: string, ate: string, acao: string | null = ID) => ({ id: `0190d2b0-0000-7000-8000-0000000000${de.slice(8, 10)}`, status, week: { from: de, to: ate }, action_id: acao });

  it('sem ritmo nenhum, nada aparece', () => {
    expect(linhasDoRitmoNaRegiao({ running: null, proposed: null })).toEqual([]);
  });

  it('o que roda nesta semana e o que espera a aprovação, cada um com o caminho para Aprovações', () => {
    const linhas = linhasDoRitmoNaRegiao({ running: ref('aprovado', '2026-11-16', '2026-11-22'), proposed: ref('pedido', '2026-11-23', '2026-11-29') });
    expect(linhas.map((l) => `${l.titulo}. ${l.texto}`)).toEqual([
      'O ritmo desta semana está rodando. De 16/11 a 22/11: o Liame muda a verba no começo de cada dia, dentro do que foi aprovado.',
      'O ritmo da semana que vem espera a sua aprovação. De 23/11 a 29/11: o Gestor de tráfego montou a verba de cada dia pelos pedidos da loja, pela previsão do tempo e pelas datas.',
    ]);
    expect(linhas.map((l) => l.href)).toEqual([`/aprovacoes?pedido=${ID}`, `/aprovacoes?pedido=${ID}`]);
  });

  it('o parado, o aprovado para a semana que vem e o que não foi aprovado', () => {
    expect(linhasDoRitmoNaRegiao({ running: ref('parado', '2026-11-16', '2026-11-22', null), proposed: null })).toEqual([
      { chave: '0190d2b0-0000-7000-8000-000000000016', icone: 'pause', titulo: 'O ritmo desta semana foi parado', texto: 'De 16/11 a 22/11: a verba de cada campanha volta à de antes, até 10% por dia.', href: null },
    ]);
    expect(linhasDoRitmoNaRegiao({ running: null, proposed: ref('aprovado', '2026-11-23', '2026-11-29') })[0]!.titulo).toBe('O ritmo da semana que vem está aprovado');
    expect(linhasDoRitmoNaRegiao({ running: null, proposed: ref('cancelado', '2026-11-23', '2026-11-29') })[0]!.texto).toBe('De 23/11 a 29/11: a verba de cada campanha fica como está.');
    // A situação que a tela não conhece não vira frase inventada.
    expect(linhasDoRitmoNaRegiao({ running: null, proposed: ref('encerrado', '2026-11-23', '2026-11-29') })).toEqual([]);
  });
});

describe('desfazer um passo do ritmo (R7, parte 1b-3b)', () => {
  const pedido = (tool: string, kind: 'campanha' | 'conjunto') => ({ tool, target: { kind, name: kind === 'campanha' ? 'Smash em dobro' : 'Raio de 3 km' } }) as unknown as AcaoDeAnuncio;

  it('a confirmação diz que a campanha (ou o conjunto) sai do ritmo; nos outros pedidos, nada', () => {
    expect(avisoDoDesfazerNoRitmo(pedido('orcamento_do_ritmo', 'campanha'))).toBe(
      'Este é um passo do ritmo da semana: desfazer devolve a verba de antes deste dia, e a campanha “Smash em dobro” sai do ritmo. O Liame não muda mais a verba dela nesta semana.',
    );
    expect(avisoDoDesfazerNoRitmo(pedido('orcamento_do_ritmo', 'conjunto'))).toBe(
      'Este é um passo do ritmo da semana: desfazer devolve a verba de antes deste dia, e o conjunto “Raio de 3 km” sai do ritmo. O Liame não muda mais a verba dele nesta semana.',
    );
    expect(avisoDoDesfazerNoRitmo(pedido('orcamento_ajustar', 'campanha'))).toBeNull();
    expect(avisoDoDesfazerNoRitmo(pedido('orcamento_aumentar', 'campanha'))).toBeNull();
  });
});

describe('os avisos do ritmo na Atenção (R7, parte 1b-3c)', () => {
  const aviso = (o: Partial<AttentionItem>): AttentionItem => ({
    kind: 'ritmo_gasto_acima',
    severity: 'atencao',
    title: 'A campanha "Smash em dobro" gastou mais do que o ritmo da semana permite',
    detail: 'De 16/11 a 22/11, ela gastou R$ 880,00. Com a verba de cada dia, esses dias iriam até R$ 717,00.',
    action: 'Veja na Meta o gasto dela nesses dias. Se preferir, pare o ritmo em Aprovações.',
    connected_account_id: ID,
    campaign_id: null,
    provider: 'meta_ads',
    brand_id: ID,
    ...o,
  });
  const cartao = (item: AttentionItem) => renderToStaticMarkup(createElement(ItemAviso, { item, podeVerContas: true, podeConectar: true, podeVerVendas: false, aoReconectar: () => {} }));

  it('o botão leva ao ritmo em Aprovações, só para quem recebeu o pedido dele', () => {
    const comPedido = { id: ID, action_id: '0190d2b0-0000-7000-8000-0000000000b2' };
    for (const kind of ['ritmo_gasto_acima', 'ritmo_sem_volta', 'ritmo_campanha_saiu']) {
      expect(destinoDoRitmo(aviso({ kind, rhythm: comPedido }))).toEqual({ href: '/aprovacoes?pedido=0190d2b0-0000-7000-8000-0000000000b2', rotulo: 'Ver o ritmo em Aprovações', curto: 'Ver o ritmo' });
      // Os avisos do ritmo não têm outra tela onde se resolvem.
      expect(acaoDoAviso(kind)).toBeNull();
    }
    // Quem não vê os pedidos recebe o aviso sem o pedido: fica só o texto.
    expect(destinoDoRitmo(aviso({ rhythm: { id: ID, action_id: null } }))).toBeNull();
    expect(destinoDoRitmo(aviso({}))).toBeNull();
    // Outro aviso nunca leva ao ritmo, mesmo que venha com o campo.
    expect(destinoDoRitmo(aviso({ kind: 'gasto_acima_da_verba', rhythm: comPedido }))).toBeNull();
  });

  it('o cartão: a etiqueta da Meta, o que fazer e o botão do ritmo', () => {
    const html = cartao(aviso({ rhythm: { id: ID, action_id: '0190d2b0-0000-7000-8000-0000000000b2' } }));
    expect(html).toContain('gastou mais do que o ritmo da semana permite');
    expect(html).toContain('>Meta Ads<');
    expect(html).toContain('<b>O que fazer:</b> veja na Meta o gasto dela nesses dias.');
    expect(html).toContain('href="/aprovacoes?pedido=0190d2b0-0000-7000-8000-0000000000b2"');
    expect(html).toContain('Ver o ritmo em Aprovações');
    expect(cartao(aviso({ rhythm: { id: ID, action_id: null } }))).not.toContain('href=');
  });
});
