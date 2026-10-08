import type { ClosedLoopResponse, DailyResultsResponse, OrderOrigin } from '@liame/contracts';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { PedirNaLista } from '@/components/pedir/botao-pedir';
import { pedirPorCampanha } from '@/components/pedir/textos';
import { montarGraficos } from '@/components/resultados/graficos';
import { detalheDoPedido, contarPedidos, filtrarPedidos, numeroDoPedido, origemDoPedido, confiancaDe, tempoAntes, textoDoModelo } from '@/components/resultados/pedidos';
import { type ExplicarResultados, ResultadosConteudo } from '@/components/resultados/resultados-conteudo';
import {
  deslocamentoDoFuso,
  fontesDe,
  inicioDoDiaDaConta,
  intervaloDo,
  localDe,
  lojasDoRegem,
  montarTela,
  nadaConectado,
  parte,
  porcentagem,
  reaisPorReal,
  textoDe,
  utc,
  vereditoDe,
  vezes,
} from '@/components/resultados/textos';
import { itensVisiveis, NAVEGACAO, temModos, tituloDa } from '@/components/shell/navegacao';
import { inteiro, reaisDeMicros } from '@/lib/formato';
import { ModoProvider } from '@/lib/modo';
import { AGORA, base7, confirmado, fonte, hoje, micros, piloto, sp, uuid } from './resultados-dados';

// Tela de Resultados (P1 no Pro; os desenhos do modo simples têm o teste deles, `resultados-graficos.spec.ts`): dinheiro em micros sem ponto flutuante, período no fuso da loja, veredito e
// "margem incompleta", os estados da tela (sem Regem, hoje, sem mídia, sem pedido, fonte atrasada, fuso
// diferente) montados e desenhados como no navegador, e a permissão do menu. Datas fixas (LIC-006).

const tela = (r: ClosedLoopResponse, periodo: 'hoje' | '7' | '30' = '7', local: string | null = 'Loja Centro') => montarTela(r, periodo, new Date(r.generated_at), local);

describe('dinheiro e números sem ponto flutuante', () => {
  it('micros em reais: centavo mais próximo, milhar com ponto, espaço fixo do Intl', () => {
    expect(reaisDeMicros('1234567890')).toBe('R$ 1.234,57');
    expect(reaisDeMicros('5000')).toBe('R$ 0,01');
    expect(reaisDeMicros('4999')).toBe('R$ 0,00');
    expect(reaisDeMicros('0')).toBe('R$ 0,00');
    expect(reaisDeMicros('-1500000')).toBe('-R$ 1,50');
    expect(reaisDeMicros('-4000')).toBe('R$ 0,00');
    expect(reaisDeMicros(1_240_000_000n, 0)).toBe('R$ 1.240');
    expect(reaisDeMicros('1499999999', 0)).toBe('R$ 1.500');
    // Além de 2^53 (onde o ponto flutuante já erra o centavo): continua exato.
    expect(reaisDeMicros('123456789012345678901230000')).toBe('R$ 123.456.789.012.345.678.901,23');
    // Igual ao Intl nos valores comuns (a mesma grafia das outras telas).
    const intl = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
    for (const v of ['412500000', '99990000', '1000000000000']) expect(reaisDeMicros(v)).toBe(intl.format(Number(v) / 1_000_000));
  });

  it('ROAS, porcentagem e contagens como no protótipo', () => {
    expect(vezes('2.91')).toBe('2,9×');
    expect(vezes('2.95')).toBe('3,0×');
    expect(vezes('0.04')).toBe('0,0×');
    expect(vezes('12.35')).toBe('12,4×');
    expect(vezes(null)).toBe('—');
    expect(sp(reaisPorReal('2.53'))).toBe('R$ 2,53');
    expect(porcentagem('83.4')).toBe('83%');
    expect(porcentagem('83.5')).toBe('84%');
    expect(porcentagem('0.0')).toBe('0%');
    expect(porcentagem('100.0')).toBe('100%');
    expect(porcentagem(null)).toBe('—');
    expect(parte(9, 141)).toBe('6%');
    expect(parte(1, 2)).toBe('50%');
    expect(parte(1, 0)).toBe('—');
    expect(inteiro('1036')).toBe('1.036');
    expect(inteiro(412)).toBe('412');
  });
});

describe('período no fuso da loja', () => {
  it('"Hoje" é o dia de hoje; 7 e 30 dias são os últimos dias completos, sem hoje', () => {
    const agora = new Date('2026-09-29T17:20:00Z');
    expect(intervaloDo('hoje', 'America/Sao_Paulo', agora)).toEqual({ from: '2026-09-29', to: '2026-09-29' });
    expect(intervaloDo('7', 'America/Sao_Paulo', agora)).toEqual({ from: '2026-09-22', to: '2026-09-28' });
    expect(intervaloDo('30', 'America/Sao_Paulo', agora)).toEqual({ from: '2026-08-30', to: '2026-09-28' });
  });

  it('perto da meia-noite, o dia é o da loja, não o do UTC nem o da máquina', () => {
    const madrugadaUtc = new Date('2026-10-01T02:30:00Z'); // 30/09, 23:30 em Brasília
    expect(intervaloDo('hoje', 'America/Sao_Paulo', madrugadaUtc)).toEqual({ from: '2026-09-30', to: '2026-09-30' });
    expect(intervaloDo('hoje', 'UTC', madrugadaUtc)).toEqual({ from: '2026-10-01', to: '2026-10-01' });
    expect(intervaloDo('7', 'America/Sao_Paulo', madrugadaUtc)).toEqual({ from: '2026-09-23', to: '2026-09-29' });
  });

  it('fuso da conta diferente do da loja: deslocamento e onde começa o dia de gasto', () => {
    const d = new Date('2026-09-29T12:00:00Z');
    expect(deslocamentoDoFuso('America/Sao_Paulo', d)).toBe(-180);
    expect(deslocamentoDoFuso('America/Los_Angeles', d)).toBe(-420);
    expect(deslocamentoDoFuso('Asia/Kolkata', d)).toBe(330);
    expect(deslocamentoDoFuso('Fuso/Inventado', d)).toBeNull();
    expect(utc(-180)).toBe('UTC−3');
    expect(utc(330)).toBe('UTC+5:30');
    expect(utc(0)).toBe('UTC');
    expect(inicioDoDiaDaConta(-420, -180)).toBe('04:00');
    expect(inicioDoDiaDaConta(-180, -180)).toBe('00:00');
    expect(inicioDoDiaDaConta(60, -180)).toBe('20:00');
  });
});

describe('veredito e margem incompleta', () => {
  const gasto = micros('100.00');
  it('o veredito vem do servidor; a tela só o nomeia', () => {
    expect(vereditoDe(confirmado({ orders: 3, verdict: 'lucro' }), gasto, false)).toEqual({ rotulo: 'Dá lucro', classe: 'bom' });
    expect(vereditoDe(confirmado({ orders: 3, verdict: 'empata' }), gasto, false)).toEqual({ rotulo: 'Empata', classe: 'atencao' });
    expect(vereditoDe(confirmado({ orders: 3, verdict: 'prejuizo' }), gasto, false)).toEqual({ rotulo: 'Dá prejuízo', classe: 'ruim' });
  });

  it('sem veredito com pedido e gasto = margem incompleta (cobertura abaixo de 80%, ou sem custo nenhum no piloto)', () => {
    expect(vereditoDe(confirmado({ orders: 3, margin_coverage_pct: '62.0', margin_known_micros: micros('40.00') }), gasto, false)).toEqual({ rotulo: 'Margem incompleta', classe: 'incompleta' });
    expect(vereditoDe(confirmado({ orders: 3, margin_coverage_pct: '0.0' }), gasto, false)?.rotulo).toBe('Margem incompleta');
  });

  it('sem veredito nenhum: em "Hoje", sem pedido, sem gasto ou com um valor que a tela ainda não conhece', () => {
    expect(vereditoDe(confirmado({ orders: 3, verdict: 'lucro' }), gasto, true)).toBeNull();
    expect(vereditoDe(confirmado({ orders: 0 }), gasto, false)).toBeNull();
    expect(vereditoDe(confirmado({ orders: 3 }), '0', false)).toBeNull();
    expect(vereditoDe(confirmado({ orders: 3, verdict: 'novo_valor' }), gasto, false)).toBeNull();
  });
});

describe('estados da tela, montados da resposta da API', () => {
  it('7 dias em dia: ROAS confirmado, plataformas com a janela delas e cada campanha com o veredito', () => {
    const t = tela(base7());
    expect(t.avisos).toEqual([]);
    expect(t.contexto).toEqual({
      datas: '22/09 a 28/09',
      complemento: 'dias completos · Loja Centro · pedidos no fuso da loja (Brasília) · gasto no fuso de cada conta',
      curto: 'dias completos · Loja Centro',
      modelo: 'Modelo: último toque · v1 · 7 dias · sem visualização',
    });
    expect(t.roas.numero).toBe('2,9×');
    const meta = t.roas.plataformas.find((p) => p.provider === 'meta_ads')!;
    expect({ ...meta, investido: sp(meta.investido) }).toMatchObject({
      investido: 'R$ 845,30 investidos',
      janela: 'Plataforma · 7 dias após o clique',
      plataforma: { texto: '3,7×' },
      caixa: { texto: '3,3×' },
      rotuloCaixa: 'Confirmado no caixa · 7 dias',
      veredito: { rotulo: 'Dá lucro', classe: 'bom' },
    });
    expect(t.roas.plataformas.find((p) => p.provider === 'google_ads')!.janela).toBe('Plataforma · janela de cada conversão');
    expect(t.roas.mensagens.map((m) => ({ ...m, porConversa: sp(m.porConversa), porPedido: sp(m.porPedido) }))).toEqual([
      { id: uuid(13), campanha: 'Smash em dobro', porConversa: 'R$ 1,98', porPedido: 'R$ 31,09', taxa: '6% das conversas viraram pedido (9 de 141)' },
    ]);

    expect(t.ciclo.kpis.map((k) => [k.rotulo, sp(k.valor), sp(k.sub)])).toEqual([
      ['Investimento', 'R$ 1.240,00', 'Google Ads R$ 394,70 · Meta Ads R$ 845,30'],
      ['Conversas por anúncio', '141', 'informado pela Meta'],
      ['Pedidos confirmados', '55', 'com evidência de confiança alta ou média'],
      ['Receita confirmada', 'R$ 3.605,00', 'pela definição de faturamento do Regem'],
      ['Margem conhecida', 'R$ 1.298,71', 'em 85% da receita'],
      ['Custo por pedido', 'R$ 22,55', 'investimento ÷ pedidos confirmados'],
      ['Pedidos sem origem', '46%', '46 de 101 do cardápio e do WhatsApp'],
      ['Vendas da loja (todos os canais)', 'R$ 24.851,00', '412 pedidos confirmados no período'],
    ]);

    // Clique só da plataforma: conta no total dela, fora das campanhas (ADR-020 item 4).
    expect(t.campanhas.soPlataforma.map((s) => ({ ...s, receita: sp(s.receita), frase: sp(textoDe(s.frase)) }))).toEqual([
      {
        provider: 'meta_ads',
        titulo: 'Meta · sem campanha identificada',
        pedidos: '4',
        receita: 'R$ 236,00',
        nota: 'conta no total da Meta',
        frase: 'Mais 4 pedidos vieram da Meta sem dizer a campanha (R$ 236,00): contam no total da Meta, fora das campanhas.',
      },
    ]);
    const smash = t.campanhas.linhas.find((l) => l.nome === 'Smash em dobro')!;
    expect(smash.celulas.roasPlataforma).toEqual({ texto: 'não informa', sub: 'campanha de mensagem' });
    expect(smash.halteres).toEqual({ plataforma: null, caixa: 2.19 });
    const noite = t.campanhas.linhas.find((l) => l.nome === 'Delivery noite')!;
    expect({ ...noite.celulas.margem, texto: sp(noite.celulas.margem.texto) }).toEqual({ texto: 'R$ 41,04', sub: '60% com custo', subAtencao: true });
    expect(t.campanhas.total.roasPlataforma).toEqual({ texto: '—', sub: 'janelas diferentes' });
    expect(t.campanhas.total.roasCaixa).toEqual({ texto: '2,9×', forte: true });

    expect(t.origem.tipo).toBe('ok');
    if (t.origem.tipo !== 'ok') return;
    expect(t.origem.canais.map((c) => [c.grupo, c.pedidos, sp(c.receita)])).toEqual([
      ['Marketplaces', '250', 'R$ 15.000,00'],
      ['Balcão e presencial', '61', 'R$ 3.290,00'],
    ]);
    expect(sp(t.origem.loja)).toBe('Loja inteira no período, todos os canais: 412 pedidos · R$ 24.851,00 (definição de faturamento do Regem).');
    expect(t.fontes.map((f) => [f.nome, f.quando, f.fuso])).toEqual([
      ['Google Ads', 'hoje, 06:20', 'fuso da conta: Brasília'],
      ['Meta Ads', 'hoje, 06:12', 'fuso da conta: Brasília'],
      ['Regem', 'hoje, 14:05', 'fuso da loja: Brasília'],
    ]);
  });

  it('o piloto hoje (só mídia, sem o Regem): o que a plataforma informa, e o caixa pedindo o Regem', () => {
    const r = piloto();
    const t = tela(r, '7', localDe(r, null, 'Mister Burgers'));
    expect(t.base).toMatchObject({ semRegem: true, semMidia: false, semPedido: false });
    // Conectar o Regem é assunto da faixa única do topo (`resultados-graficos.spec.ts`); aqui não sobra faixa do Pro.
    expect(t.avisos).toEqual([]);
    expect(t.contexto.complemento).toBe('dias completos · Mister Burgers · pedidos no fuso da loja (Brasília) · gasto no fuso de cada conta');
    expect(t.roas.numero).toBe('—');
    expect(textoDe(t.roas.frase)).toBe('Falta conectar o Regem para saber quanto os anúncios venderam de verdade no caixa.');
    expect(t.roas.plataformas.find((p) => p.provider === 'meta_ads')).toMatchObject({ plataforma: { texto: '3,1×' }, caixa: { texto: 'conecte o Regem' }, veredito: null });
    expect(t.ciclo.kpis.filter((k) => k.sub === 'precisa do Regem').map((k) => k.rotulo)).toEqual([
      'Pedidos confirmados',
      'Receita confirmada',
      'Margem conhecida',
      'Custo por pedido',
      'Pedidos sem origem',
      'Vendas da loja (todos os canais)',
    ]);
    const vendas = t.campanhas.linhas[0]!;
    expect(vendas.celulas.roasPlataforma).toEqual({ texto: '3,3×', sub: '7 dias após o clique' });
    expect(vendas.celulas.roasCaixa.texto).toBe('—');
    expect(vendas.halteres).toBeNull();
    expect(t.origem).toEqual({ tipo: 'sem-regem' });
    expect(t.fontes.at(-1)).toMatchObject({ provider: 'regem', situacao: 'nao_conectada', quando: 'Não conectado' });
  });

  it('"Hoje": o caixa aparece, e o investimento, o ROAS e o custo por pedido saem amanhã', () => {
    const t = tela(hoje(), 'hoje');
    expect(t.contexto.datas).toBe('29/09, até 14:20');
    expect(t.contexto.complemento).not.toContain('dias completos');
    expect(t.avisos.map((a) => a.id)).toEqual(['hoje']);
    expect(t.avisos[0]!.texto).toBe(
      'O Google Ads e a Meta são lidos uma vez por dia (última leitura hoje, 06:20). Até lá, “Hoje” mostra os pedidos e a receita do caixa; o ROAS e o custo por pedido de hoje saem amanhã.',
    );
    expect(t.roas.numero).toBe('—');
    expect(sp(textoDe(t.roas.frase))).toBe('Hoje, até agora, 4 pedidos vieram de anúncios (R$ 267,80). Quanto voltou para cada R$ 1 sai amanhã, com o gasto do dia.');
    expect(t.roas.plataformas.every((p) => p.plataforma.texto === 'sai amanhã' && p.caixa.texto === 'sai amanhã' && p.veredito === null)).toBe(true);
    const kpi = (rotulo: string) => t.ciclo.kpis.find((k) => k.rotulo === rotulo)!;
    expect([kpi('Investimento').valor, kpi('Custo por pedido').valor, kpi('Conversas por anúncio').valor]).toEqual(['Sai amanhã', 'Sai amanhã', 'Sai amanhã']);
    expect(kpi('Investimento').vazio).toBe(true);
    expect(t.campanhas.linhas[0]!.celulas.investimento).toEqual({ texto: '—', sub: 'sai amanhã' });
  });

  it('margem incompleta: sem custo nenhum (token do piloto sem custos.ler) e com cobertura de 62%', () => {
    const semCusto = base7();
    semCusto.totals.confirmed = { ...semCusto.totals.confirmed, margin_known_micros: null, margin_coverage_pct: '0.0', verdict: null };
    let t = tela(semCusto);
    expect(t.avisos.map((a) => [a.id, a.titulo])).toEqual([['margem', 'Nenhuma venda dos anúncios tem custo conhecido no Regem']]);
    expect(t.ciclo.kpis.find((k) => k.rotulo === 'Margem conhecida')).toMatchObject({ valor: '—', sub: 'em 0% da receita · abaixo de 80%', atencao: true });

    const parcial = base7();
    parcial.totals.confirmed = { ...parcial.totals.confirmed, margin_known_micros: micros('410.00'), margin_coverage_pct: '62.0', verdict: null };
    t = tela(parcial);
    expect(t.avisos[0]!.titulo).toBe('Só 62% da receita tem custo cadastrado no Regem');
  });

  it('fonte atrasada: o número do Pro aparece com o selo da hora (a faixa é a do topo)', () => {
    const r = base7();
    r.sources = [fonte('google_ads'), fonte('meta_ads'), fonte('regem', { freshness: 'delayed', last_success_at: '2026-09-29T12:42:00.000Z' })];
    const t = tela(r);
    const regem = t.fontes.find((f) => f.provider === 'regem')!;
    expect(regem).toMatchObject({ situacao: 'atraso', quando: 'Dados desatualizados · última sincronização 09:42', selo: 'Caixa até 09:42' });
    expect(t.roas.selos).toEqual(['Caixa até 09:42']);
    expect(t.roas.numero).toBe('2,9×');
    expect(t.avisos).toEqual([]);

    const parada = base7();
    parada.sources = [fonte('google_ads'), fonte('meta_ads', { status: 'desconectada', freshness: 'stale', last_success_at: '2026-09-27T09:12:00.000Z' }), fonte('regem')];
    const p = tela(parada);
    expect(p.fontes.find((f) => f.provider === 'meta_ads')).toMatchObject({ situacao: 'problema', quando: 'Desconectada · última leitura 27/09, 06:12', selo: 'Gasto até 27/09, 06:12' });
  });

  it('fuso da conta diferente do da loja: faixa com o horário do dia de gasto', () => {
    const r = base7();
    r.sources = [fonte('google_ads'), fonte('meta_ads', { timezone: 'America/Los_Angeles' }), fonte('regem')];
    const t = tela(r);
    expect(t.contexto.complemento).toContain('pedidos no fuso da loja (Brasília) · gasto da Meta no fuso da conta (Los Angeles)');
    expect(t.avisos[0]).toMatchObject({
      titulo: 'A conta da Meta usa outro fuso: Los Angeles (UTC−7)',
      texto:
        'A loja usa o de Brasília (UTC−3). Os pedidos seguem o fuso da loja e o gasto segue o da conta, porque é assim que a plataforma fecha o dia: cada dia de gasto da Meta vai das 04:00 às 03:59 no horário da loja. Em 7 ou 30 dias a diferença é pequena; em “Hoje”, pesa.',
    });
  });

  it('sem mídia, sem pedido, sem pedido com prova e nada conectado', () => {
    const semMidia = base7();
    semMidia.sources = [fonte('regem')];
    semMidia.platforms = [];
    semMidia.campaigns = [];
    semMidia.totals = { ...semMidia.totals, spend_micros: '0', confirmed: confirmado() };
    let t = tela(semMidia);
    expect(t.avisos).toEqual([]);
    expect(textoDe(t.roas.frase)).toBe('Conecte a Meta ou o Google para saber quanto cada R$ 1 em anúncio trouxe de volta.');
    expect(t.campanhas.vazio).toBe('Conecte a Meta ou o Google para ver o resultado de cada campanha.');

    const vazio = hoje();
    vazio.totals = { ...vazio.totals, orders_confirmed: 0, revenue_micros: '0', confirmed: confirmado({ roas: '0.00' }), without_origin: { orders: 0, revenue_micros: '0', share_pct: null }, no_click_channels: [] };
    t = tela(vazio, 'hoje');
    expect(t.base.semPedido).toBe(true);
    expect(textoDe(t.roas.frase)).toBe('Nenhum pedido confirmado hoje, até agora. Quando entrar pedido, ele aparece aqui com a origem.');
    expect(t.origem).toEqual({
      tipo: 'sem-pedido',
      titulo: 'Nenhum pedido confirmado hoje, até agora',
      texto: 'O Regem está em dia (última leitura hoje, 14:05). Quando entrar pedido, ele aparece aqui com a origem.',
    });

    const semProva = base7();
    semProva.totals.confirmed = confirmado({ roas: '0.00' });
    t = tela(semProva);
    expect(t.roas.numero).toBe('0,0×');
    expect(textoDe(t.roas.frase)).toBe('Nenhum pedido com prova de anúncio no período. Os pedidos sem origem e os dos canais sem clique aparecem abaixo, separados.');

    expect(nadaConectado({ sources: [] })).toBe(true);
    expect(nadaConectado({ sources: [fonte('meta_ads')] })).toBe(false);
  });

  it('marca e loja: lojas do Regem da marca e o nome na linha de contexto', () => {
    const conta = (unit: string | null, nome: string, over: Record<string, unknown> = {}) => ({ provider: 'regem', unit_id: unit, name: nome, disconnected_at: null, ...over });
    const lojas = lojasDoRegem([
      { accounts: [conta(uuid(2), 'Loja Zona Sul'), conta(uuid(1), 'Loja Centro'), { ...conta(null, 'Meta'), provider: 'meta_ads' }] },
      { accounts: [conta(uuid(1), 'Loja Centro'), conta(uuid(3), 'Loja antiga', { disconnected_at: '2026-09-01T00:00:00Z' })] },
    ] as never);
    expect(lojas).toEqual([
      { id: uuid(1), nome: 'Loja Centro' },
      { id: uuid(2), nome: 'Loja Zona Sul' },
    ]);
    expect(localDe(base7(), null, 'Mister Burgers')).toBe('Loja Centro');
    expect(localDe(base7(), lojas[1]!, 'Mister Burgers')).toBe('Loja Zona Sul');
    expect(localDe({ sources: [fonte('regem'), fonte('regem')] }, null, 'Mister Burgers')).toBe('2 lojas');
    expect(localDe(piloto(), null, 'Mister Burgers')).toBe('Mister Burgers');
  });

  it('fontes: sem leitura ainda e duas contas da mesma plataforma', () => {
    const f = fontesDe({ sources: [fonte('meta_ads', { last_success_at: null, freshness: 'unknown' }), fonte('meta_ads', { name: 'CA 2' }), fonte('regem')] }, 'America/Sao_Paulo', new Date(AGORA));
    expect(f.map((x) => [x.conta, x.situacao, x.quando])).toEqual([
      ['CA - Mister Burguer', 'sem_leitura', 'Ainda sem leitura'],
      ['CA 2', 'ok', 'hoje, 06:12'],
      [null, 'ok', 'hoje, 14:05'],
    ]);
  });

  it('duas contas atrasadas na mesma hora: um selo só no ROAS', () => {
    const r = base7();
    const atrasada = { freshness: 'stale', last_success_at: '2026-09-27T09:12:00.000Z' };
    r.sources = [fonte('meta_ads', atrasada), fonte('meta_ads', { ...atrasada, connected_account_id: uuid(9), name: 'CA 2' }), fonte('regem')];
    const t = tela(r);
    expect(t.roas.selos).toEqual(['Gasto até 27/09, 06:12']);
  });
});

describe('pedido a pedido e a origem de cada pedido', () => {
  const base: OrderOrigin = {
    order_id: uuid(101),
    external_id: '48352',
    channel: 'cardapio',
    channel_group: 'cardapio',
    status: 'confirmado',
    confirmed_at: '2026-09-29T00:03:00.000Z',
    revenue_micros: micros('74.90'),
    margin_micros: micros('31.20'),
    attribution: {
      status: 'atribuido',
      evidence: 'clique_campanha',
      confidence: 'alta',
      provider: 'meta_ads',
      campaign: { id: uuid(11), name: 'Combo sexta' },
      ad: { id: uuid(31), name: 'Combo sexta · vídeo 15s' },
      touch_at: '2026-09-26T23:41:00.000Z',
      hours_before: 48.4,
      window_days: 7,
      counted: true,
      reason: null,
    },
  };
  const pedido = (over: Partial<OrderOrigin>, a: Partial<OrderOrigin['attribution']> = {}): OrderOrigin => ({ ...base, ...over, attribution: { ...base.attribution, ...a } });
  const ctx = { fuso: 'America/Sao_Paulo', loja: 'Loja Centro', modelo: base7().model };

  const conversa = pedido(
    { order_id: uuid(102), external_id: '48344', channel: 'whatsapp_bot', channel_group: 'whatsapp', confirmed_at: '2026-09-28T23:31:00.000Z', margin_micros: null },
    { evidence: 'conversa_anuncio', confidence: 'media', campaign: { id: uuid(15), name: 'Peça pelo WhatsApp' }, ad: { id: uuid(32), name: 'Peça pelo WhatsApp · foto' }, touch_at: '2026-09-28T22:58:00.000Z' },
  );
  const cupom = pedido({ order_id: uuid(103), external_id: '48349', channel: 'balcao', channel_group: 'presencial' }, { evidence: 'cupom', ad: null, touch_at: '2026-09-29T00:03:00.000Z' });
  const soPlataforma = pedido(
    { order_id: uuid(104), external_id: '48327', confirmed_at: '2026-09-28T22:30:00.000Z' },
    { status: 'plataforma', evidence: 'clique_plataforma', campaign: null, ad: null, touch_at: '2026-09-27T00:15:00.000Z' },
  );
  const semEvidencia = pedido({ order_id: uuid(105), external_id: '48299' }, { status: 'sem_origem', evidence: null, confidence: null, provider: null, campaign: null, ad: null, touch_at: null, counted: false, reason: 'sem_evidencia' });
  const ifood = pedido(
    { order_id: uuid(106), external_id: 'IFD-8841-2231-XYZ-00991', channel: 'ifood', channel_group: 'marketplace' },
    { status: 'sem_origem', evidence: null, confidence: null, provider: null, campaign: null, ad: null, touch_at: null, counted: false, reason: 'canal_sem_clique' },
  );
  const cancelado = pedido({ order_id: uuid(107), external_id: '48190', status: 'cancelado' }, { counted: false, reason: 'cancelado' });
  const lista = [base, conversa, cupom, soPlataforma, semEvidencia, ifood, cancelado];

  it('filtros e contagens (com origem, sem origem, cancelados)', () => {
    expect(contarPedidos(lista)).toEqual({ todos: 7, com: 4, sem: 2, cancelados: 1 });
    expect(filtrarPedidos(lista, 'sem').map((o) => o.external_id)).toEqual(['48299', 'IFD-8841-2231-XYZ-00991']);
    expect(filtrarPedidos(lista, 'cancelados').map((o) => o.external_id)).toEqual(['48190']);
  });

  it('colunas da tabela: número, origem e confiança', () => {
    expect(numeroDoPedido('48352')).toEqual({ completo: 'Nº 48352', curto: 'Nº 48352' });
    expect(numeroDoPedido('IFD-8841-2231-XYZ-00991')).toEqual({ completo: 'IFD-8841-2231-XYZ-00991', curto: 'IFD-8841-2231-…' });
    expect(origemDoPedido(base)).toEqual({ principal: 'Combo sexta', sub: 'Meta Ads · clique com campanha', forte: true });
    expect(origemDoPedido(soPlataforma)).toEqual({ principal: 'Meta Ads', sub: 'sem campanha identificada', forte: true });
    expect(origemDoPedido(ifood)).toEqual({ principal: 'Canal sem clique', sub: null, forte: false });
    expect([base, conversa, soPlataforma, semEvidencia, cancelado].map((o) => confiancaDe(o).rotulo)).toEqual(['Alta', 'Média', 'Só a plataforma', 'Sem origem', 'Cancelado · fora do ROAS']);
    expect(tempoAntes('2026-09-28T22:58:00Z', '2026-09-28T23:31:00Z')).toBe('33 minutos');
    expect(tempoAntes('2026-09-28T20:00:00Z', '2026-09-28T21:00:00Z')).toBe('1 hora');
  });

  it('a gaveta com a evidência, como no protótipo', () => {
    const d = detalheDoPedido(base, ctx);
    expect(d.titulo).toBe('Pedido nº 48352');
    expect(d.dados.map((x) => [x.rotulo, sp(x.valor)])).toEqual([
      ['Confirmado em', '28/09, 21:03'],
      ['Canal', 'Cardápio online'],
      ['Valor (definição de faturamento do Regem)', 'R$ 74,90'],
      ['Loja', 'Loja Centro'],
    ]);
    expect(d.evidencia).toEqual({ texto: 'Clique no anúncio “Combo sexta · vídeo 15s” · 26/09, 20:41 · 2 dias antes do pedido · janela de 7 dias · confiança alta', tom: 'normal' });
    expect(d.linhaDoTempo.map((x) => [x.quando, x.oque, x.usado])).toEqual([
      ['26/09, 20:41', 'Clique no anúncio “Combo sexta · vídeo 15s”', true],
      ['28/09, 21:03', 'Pedido confirmado no caixa', false],
    ]);
    expect(sp(d.margem)).toBe('R$ 31,20 · todos os itens com custo');
    expect(d.modelo).toBe(textoDoModelo(ctx.modelo));
    expect(d.modelo).toBe(
      'Modelo último toque · versão 1 · janela de 7 dias do toque até a confirmação do pedido · sem visualização · ordem das evidências: cupom exclusivo, clique com campanha, conversa por anúncio, clique só da plataforma, conversa só da plataforma',
    );

    expect(detalheDoPedido(conversa, ctx).evidencia.texto).toBe(
      'Conversa aberta pelo anúncio “Peça pelo WhatsApp · foto” · 28/09, 19:58 · 33 minutos antes do pedido · mesmo cliente · janela de 7 dias · confiança média',
    );
    expect(detalheDoPedido(conversa, ctx).margem).toBe('Desconhecida: algum item do pedido está sem custo no Regem');
    expect(detalheDoPedido(cupom, ctx).evidencia.texto).toBe('Cupom exclusivo da campanha Combo sexta · usado no próprio pedido · confiança alta');
    expect(detalheDoPedido(soPlataforma, ctx).evidencia.texto).toBe('Clique vindo da Meta, sem o id da campanha · 26/09, 21:15 · 2 dias antes do pedido · janela de 7 dias · só a plataforma');
    expect(detalheDoPedido(semEvidencia, ctx).evidencia).toEqual({ texto: 'Nenhum clique, conversa por anúncio ou cupom exclusivo nos 7 dias antes do pedido', tom: 'sem' });
    expect(detalheDoPedido(ifood, ctx).evidencia.texto).toBe('Pedido de marketplace (iFood) · sem clique nem cupom exclusivo');
    const c = detalheDoPedido(cancelado, ctx);
    expect(c.resultado).toEqual({ tipo: 'cancelado', campanha: 'Combo sexta', plataforma: 'Meta Ads' });
    expect(c.margem).toBe('Fora da conta: pedido cancelado');
    expect(c.dados.find((x) => x.rotulo.startsWith('Valor'))?.riscado).toBe(true);
  });
});

describe('desenho da tela (o mesmo componente do navegador)', () => {
  const desenhar = (
    r: ClosedLoopResponse,
    periodo: 'hoje' | '7' | '30',
    modo: 'lite' | 'pro',
    local: string | null = 'Loja Centro',
    explicar: ExplicarResultados | null = null,
    pedir: PedirNaLista | null = null,
    serie: DailyResultsResponse | null = null,
  ) => {
    const t = tela(r, periodo, local);
    return renderToStaticMarkup(
      createElement(ModoProvider, {
        inicial: modo,
        children: createElement(ResultadosConteudo, {
          tela: t,
          graficos: montarGraficos(r, t.base, t.fontes, t.avisos, serie),
          modelo: r.model,
          consulta: r.sources.some((s) => s.provider === 'regem') ? { brand_id: uuid(900), from: r.period.from, to: r.period.to } : null,
          loja: local,
          podeVerContas: true,
          reserva: { current: null },
          explicar,
          pedir,
        }),
      }),
    );
  };
  const semLixo = (html: string) => {
    expect(html).not.toMatch(/NaN|undefined|\[object Object\]|Infinity/);
    expect(html).not.toMatch(/>null</);
  };

  it('o pedido de mudança na lista de campanhas (P9): o botão só onde o servidor diz, o pedido que espera e a nota', () => {
    // Onde dá para pedir vem de `GET /v1/actions/targets`: duas das três campanhas da Meta, e nenhuma do Google.
    const alvos = (podePedir: boolean, comEspera = true): PedirNaLista => ({
      porCampanha: pedirPorCampanha({
        campaigns: [
          { campaign_id: uuid(11), write: 'ligada', open: [] },
          {
            campaign_id: uuid(13),
            write: 'ligada',
            open: comEspera
              ? [{ id: uuid(501), tool: 'orcamento_ajustar', action: 'orcamento.reduzir', resource_id: 'campanha:120210000000013', status: 'aguardando_aprovacao', value_micros: 36_000_000, created_at: AGORA }]
              : [],
          },
        ],
      }),
      podePedir,
      aberta: null,
      aoPedir: () => undefined,
    });
    const NOTA = '“Pedir mudança” vale para as campanhas da Meta: mudar a verba, pausar e retomar, sempre com a sua aprovação. As do Google seguem só para leitura.';
    const botoes = (html: string) => [...html.matchAll(/aria-label="Pedir mudança na campanha ([^"]+)"/g)].map((m) => m[1]);

    // Sem a lista do servidor, a tela é a de antes.
    const sem = desenhar(base7(), '7', 'pro');
    expect(sem).not.toContain('Pedir mudança');
    expect(sem).not.toContain('class="mudar"');

    const lite = desenhar(base7(), '7', 'lite', 'Loja Centro', null, alvos(true));
    semLixo(lite);
    expect(lite).toContain('class="camp-b camp-b--pedir"');
    // Na lista do Lite, um botão por campanha com pedido; a tabela do Pro (escondida) traz os dela.
    expect(lite.split('id="camp-pro"')[0]!.match(/class="camp-acao"/g)).toHaveLength(4);
    expect(botoes(lite.split('id="camp-pro"')[0]!)).toEqual(['Combo sexta', 'Smash em dobro']);
    expect(lite).toContain(`<a class="pedido-esperando" href="/aprovacoes?pedido=${uuid(501)}">1 pedido esperando</a>`);
    expect(lite).toContain(NOTA);
    expect(lite).toContain('aria-haspopup="dialog"');

    const pro = desenhar(base7(), '7', 'pro', 'Loja Centro', null, alvos(true));
    semLixo(pro);
    expect(pro).toContain('<th scope="col" class="mudar">Mudar</th>');
    expect(pro).toContain('; na última coluna, o pedido de mudança</caption>');
    // Cada campanha com pedido tem o botão na coluna e embaixo do nome (no celular a coluna some).
    expect(botoes(pro)).toEqual(['Combo sexta', 'Combo sexta', 'Smash em dobro', 'Smash em dobro']);
    expect(pro.match(/class="mudar-linha"/g)).toHaveLength(2);
    // Quatro campanhas, a linha "sem campanha identificada" e o total: a coluna existe em todas.
    expect(pro.match(/<td class="mudar">/g)).toHaveLength(6);
    // O Google segue só para leitura; a campanha da Meta sem pedido (fora da lista do servidor) fica em branco.
    expect(pro.match(/<span class="eixo-nota">só leitura<\/span>/g)).toHaveLength(1);
    expect(pro).toContain(NOTA);
    expect(pro).toContain('>Pedir</button>');

    // Quem só acompanha as campanhas vê o pedido que espera, sem o botão; sem nada a mostrar, a coluna não existe.
    const soVe = desenhar(base7(), '7', 'pro', 'Loja Centro', null, alvos(false));
    expect(botoes(soVe)).toEqual([]);
    expect(soVe).toContain('1 pedido esperando');
    expect(soVe).toContain('<th scope="col" class="mudar">Mudar</th>');
    expect(desenhar(base7(), '7', 'pro', 'Loja Centro', null, alvos(false, false))).not.toContain('class="mudar"');
  });

  it('piloto no modo simples: a faixa do topo pede o Regem, o gasto de cada campanha e os estados vazios do caixa', () => {
    const html = desenhar(piloto(), '7', 'lite', 'Mister Burgers');
    semLixo(html);
    expect(html).toContain('<b>Falta o caixa da loja.</b> Conecte o Regem para ver o que virou pedido.');
    expect(html).toContain('<a class="btn btn--sm btn--primary" href="/contas">Abrir Contas conectadas</a>');
    expect(html).toContain('Quanto voltou, só o caixa da loja diz.');
    expect(html).toContain('Não conectado');
    expect(html).toContain('Conecte o Regem para ver de onde vieram os pedidos');
    expect(html).toContain('Sem o Regem, não há pedidos para mostrar');
    expect(html).toContain('R$ 580,00 investidos');
    // Lite: "Ver detalhes" em cada cartão, com o Pro escondido e ligado por aria-controls.
    expect(html).toContain('aria-controls="camp-pro"');
    expect(html).toMatch(/id="camp-pro" hidden=""/);
  });

  it('piloto no Pro: tabela por campanha com caption, fontes e o modelo', () => {
    const html = desenhar(piloto(), '7', 'pro', 'Mister Burgers');
    semLixo(html);
    expect(html).toContain('<caption class="sr-only">Resultado por campanha em últimos 7 dias');
    expect(html).toContain('De onde vêm os números');
    expect(html).toContain('Modelo: último toque · v1 · 7 dias · sem visualização');
    expect(html).toContain('VENDAS | COMPRAR | SEX A DOM');
    expect(html).toContain('3,3×');
    expect(html).not.toContain('Ver detalhes');
    expect(html).not.toMatch(/id="camp-pro" hidden/);
  });

  it('"Hoje" e a margem incompleta desenhados', () => {
    const h = desenhar(hoje(), 'hoje', 'lite');
    semLixo(h);
    expect(h).toContain('O retorno sai amanhã');
    expect(h).toContain('sai amanhã, com o gasto do dia');
    // Em "Hoje" não há veredito: o único selo é o neutro, que diz que o retorno sai amanhã.
    expect(h).not.toMatch(/veredito--(bom|atencao|ruim|incompleta)/);
    // A faixa "O gasto de hoje sai amanhã" é do Pro; no modo simples, quem diz é o cartão.
    expect(h).not.toContain('O gasto de hoje sai amanhã');
    expect(desenhar(hoje(), 'hoje', 'pro')).toContain('O gasto de hoje sai amanhã');

    const r = base7();
    r.totals.confirmed = { ...r.totals.confirmed, margin_known_micros: null, margin_coverage_pct: '0.0', verdict: null };
    const m = desenhar(r, '7', 'lite');
    semLixo(m);
    expect(m).toContain('Margem incompleta');
    expect(m).toContain('Ainda não dá para dizer');
    expect(m).toContain('veredito veredito--incompleta');
  });

  it('7 dias no Pro: halteres com rótulo, total da tabela e canais sem clique', () => {
    const html = desenhar(base7(), '7', 'pro');
    semLixo(html);
    expect(html).toContain('role="img" aria-label="Combo sexta: plataforma 6,1, confirmado no caixa 4,3"');
    expect(html).toContain('<caption class="sr-only">Pedidos dos canais sem clique no período</caption>');
    expect(html).toContain('Meta · sem campanha identificada');
    expect(html).toContain('janelas diferentes');
  });

  it('"Explicar" (A3 · I4): o botão entra no cabeçalho do número principal, o da LIA ou o neutro; sem o que explicar, não aparece', () => {
    const r = base7();
    const pedido = { de: 'resultados' as const, brand_id: uuid(900), from: r.period.from, to: r.period.to };
    const comLia = desenhar(r, '7', 'lite', 'Loja Centro', { pedido, lia: true, semOrigemAlta: true });
    semLixo(comLia);
    // O botão fica dentro do cartão do ROAS, fechado (sem apontar para um bloco que ainda não está na tela).
    const heroi = comLia.slice(comLia.indexOf('class="card res-hero"'), comLia.indexOf('</article>'));
    expect(heroi).toContain('<button class="ia-bt" type="button" aria-expanded="false">');
    expect(heroi).toContain('>Explicar</button>');
    // Fechada, a explicação não está na tela (ela abre logo abaixo do número, a pedido).
    expect(comLia).not.toContain('id="exp-resultados"');
    expect(desenhar(r, '7', 'pro', 'Loja Centro', { pedido, lia: false, semOrigemAlta: false })).toContain('<button class="ia-bt ia-bt--neutro" type="button" aria-expanded="false"');
    expect(desenhar(r, '7', 'lite')).not.toContain('ia-bt');
  });
});

describe('menu e permissão', () => {
  const agencia = NAVEGACAO.find((g) => g.id === 'agencia')!;

  it('Resultados aparece só para quem tem vendas.ver (a mesma permissão que a API exige)', () => {
    expect(agencia.itens.find((i) => i.href === '/resultados')).toMatchObject({ permissao: 'vendas.ver', modos: true });
    // Sem o modo, todas as telas que a pessoa pode ver (o menu passa o modo: Resumo no Lite, Atenção no Pro).
    expect(itensVisiveis(agencia, () => true).map((i) => i.href)).toEqual(['/resumo', '/atencao', '/aprovacoes', '/resultados', '/verba', '/criativos', '/equipe', '/marca', '/contas', '/pessoas']);
    expect(itensVisiveis(agencia, (p) => p !== 'vendas.ver').map((i) => i.href)).toEqual(['/atencao', '/aprovacoes', '/verba', '/criativos', '/equipe', '/marca', '/contas', '/pessoas']);
    expect(itensVisiveis(agencia, (p) => p === 'vendas.ver').map((i) => i.href)).toEqual(['/resumo', '/resultados']);
  });

  it('título da tela e o seletor Lite/Pro só onde há as duas visões e a pessoa pode ver a tela', () => {
    const todas = () => true;
    expect(tituloDa('/resultados')).toBe('Resultados');
    expect(temModos('/resultados', todas)).toBe(true);
    expect(temModos('/resultados', (p) => p !== 'vendas.ver')).toBe(false);
    expect(temModos('/contas', todas)).toBe(false);
    expect(temModos('/seguranca', todas)).toBe(false);
  });
});
