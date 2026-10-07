import type { AttentionItem, BudgetMonthResponse, SourceFreshness, SummaryResponse, TeamMember, TeamResponse } from '@liame/contracts';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ConversaProvider } from '@/components/conversa/contexto';
import { ResumoConteudo } from '@/components/resumo/resumo-conteudo';
import { balaDe, canaisDo, dinheiroDo, nomeDoCanal, pedidosDo, statsDo } from '@/components/resumo/graficos';
import { contadorDoResumo, equipeDo, Fontes, hojeEscrito, pontosFalados, precisaDe, primeiroNome, saudacao, textoCorrido, variacaoEntre, vereditoDo } from '@/components/resumo/textos';
import { destinoInicial } from '@/components/shell/inicio';
import { itensVisiveis, NAVEGACAO, temModos, tituloDa } from '@/components/shell/navegacao';
import { AvisosProvider } from '@/components/ui/avisos';

// "Resumo" (A3 · P8, aprovado em 03/10/2026; mockups/prototipo-resumo.html): a página inicial do Lite. As frases e
// os números saem do que a API manda (`GET /v1/summary` e `/v1/team`); a tela é desenhada pelo mesmo componente
// do navegador. Desde 07/10/2026 os cartões de análise são desenhos (mockups/prototipo-resumo-graficos.html): os
// três números contra a semana anterior, para onde foi cada real vendido, os pedidos e cada canal de anúncio.

const FUSO = 'America/Sao_Paulo';
const AGORA = new Date('2026-09-29T17:40:00Z'); // terça, 14:40 em São Paulo
const nbsp = (s: string) => s.replaceAll('R$ ', `R$${String.fromCharCode(160)}`);
const uuid = (n: number) => `a0000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const tudoPode = () => true;

const fonte = (provider: string, over: Partial<SourceFreshness> = {}): SourceFreshness =>
  ({
    connected_account_id: uuid(provider.length),
    provider,
    name: provider === 'regem' ? 'Loja Centro' : `Conta ${provider}`,
    dataset: provider === 'regem' ? 'pedidos' : 'metricas',
    status: 'ativa',
    freshness: 'fresh',
    last_success_at: '2026-09-29T09:12:00.000Z',
    timezone: FUSO,
    ...over,
  }) as SourceFreshness;

function resumo(over: Partial<SummaryResponse> = {}, dinheiro: Partial<SummaryResponse['money']> = {}): SummaryResponse {
  return {
    brand_id: uuid(1),
    state: 'ok',
    period: { from: '2026-09-22', to: '2026-09-28', timezone: FUSO },
    previous: { from: '2026-09-15', to: '2026-09-21' },
    money: {
      revenue_micros: { now: '3471000000', before: '3068000000' },
      spend_micros: { now: '1214300000', before: '1180000000' },
      left_micros: { now: '286500000', before: '120000000' },
      margin_known_micros: '1500800000',
      margin_coverage_pct: '91.4',
      verdict: 'empata',
      ...dinheiro,
    },
    campaigns: {
      profit: [{ campaign_id: uuid(11), name: 'Combo sexta', provider: 'meta_ads' }],
      loss: [
        { campaign_id: uuid(12), name: 'Smash em dobro', provider: 'meta_ads' },
        { campaign_id: uuid(13), name: 'Busca hambúrguer perto', provider: 'google_ads' },
      ],
    },
    orders: { marketing: 53, average_micros: '65490566', all_channels: 412, without_origin: 61 },
    platforms: [
      { provider: 'meta_ads', orders: 41, left_micros: '402100000' },
      { provider: 'google_ads', orders: 12, left_micros: '-115600000' },
    ],
    needs_you: { critical: 1, attention: 2, items: [], approvals: { actions: 2, plans: 0, autonomy: 0 } },
    sources: [fonte('meta_ads'), fonte('google_ads', { last_success_at: '2026-09-29T09:20:00.000Z' }), fonte('regem')],
    generated_at: '2026-09-29T17:40:00.000Z',
    ...over,
  };
}

const aviso = (over: Partial<AttentionItem>): AttentionItem => ({
  kind: 'campanha_parou',
  severity: 'critica',
  title: 'A Delivery noite parou de aparecer para as pessoas',
  detail: 'Nenhuma impressão ontem.',
  action: 'Veja na Meta se há anúncio reprovado.',
  connected_account_id: uuid(2),
  campaign_id: uuid(14),
  provider: 'meta_ads',
  brand_id: uuid(1),
  ...over,
});

const membro = (key: string, over: Partial<TeamMember> = {}): TeamMember => ({
  key,
  kind: 'ia',
  status: 'ativo',
  working_now: false,
  can_pause: key !== 'compliance',
  paused: null,
  cost: { usd_micros: '0', calls: 0 },
  stats: [],
  ...over,
});
const stat = (key: string, value: number) => ({ key, value: String(value), unit: 'qtd' });

function equipe(membros: TeamMember[], aiLigada = true): TeamResponse {
  return {
    brand_id: uuid(1),
    month: { from: '2026-09-01', to: '2026-09-30', timezone: FUSO },
    ai: { enabled: aiLigada, spent_usd_micros: '0', ceiling_usd_micros: '20000000', band: 'livre' },
    usd_brl: { rate: '5.2238', date: '2026-10-02', source: 'bcb_ptax_venda' },
    stop: null,
    members: membros,
    can_manage: true,
    can_stop: true,
    generated_at: '2026-09-29T17:40:00.000Z',
  };
}

describe('Resumo: o cabeçalho', () => {
  it('saudação pela hora da loja e o dia escrito como no protótipo', () => {
    expect(saudacao(AGORA, FUSO)).toBe('Boa tarde');
    expect(saudacao(new Date('2026-09-29T12:00:00Z'), FUSO)).toBe('Bom dia'); // 09:00
    expect(saudacao(new Date('2026-09-29T23:00:00Z'), FUSO)).toBe('Boa noite'); // 20:00
    expect(saudacao(new Date('2026-09-29T06:00:00Z'), FUSO)).toBe('Boa noite'); // 03:00
    expect(hojeEscrito(AGORA, FUSO)).toBe('Terça, 29 de setembro');
    expect(hojeEscrito(new Date('2026-10-04T15:00:00Z'), FUSO)).toBe('Domingo, 4 de outubro');
    expect(primeiroNome('Rodrigo de Oliveira')).toBe('Rodrigo');
    expect(primeiroNome('  Ana  ')).toBe('Ana');
  });
});

describe('Resumo: os três números do topo', () => {
  it('variação com uma casa, sem ponto flutuante; sem semana anterior (ou com ela em zero), não há comparação', () => {
    expect(variacaoEntre('3471000000', '3068000000')).toEqual({ sobe: true, texto: '13,1%' });
    expect(variacaoEntre('1000000', '2000000')).toEqual({ sobe: false, texto: '50,0%' });
    expect(variacaoEntre('5', '5')).toEqual({ sobe: true, texto: '0,0%' });
    expect(variacaoEntre('5', null)).toBeNull();
    expect(variacaoEntre('5', '0')).toBeNull();
  });

  it('a barra contra a semana anterior: as duas na mesma régua, que começa no zero; quando faltou, a régua vai para a esquerda', () => {
    // Esta semana maior: a barra ocupa a régua e a marca fica dentro dela.
    expect(balaDe(3_471_000_000n, 3_068_000_000n)).toEqual({ de: 0, largura: 100, negativa: false, zero: null, marca: 88.38 });
    // Esta semana menor: a marca fica na ponta.
    expect(balaDe(2_000_000_000n, 4_000_000_000n)).toEqual({ de: 0, largura: 50, negativa: false, zero: null, marca: 100 });
    // Sem semana anterior não há marca; tudo em zero não quebra.
    expect(balaDe(500n, null)).toEqual({ de: 0, largura: 100, negativa: false, zero: null, marca: null });
    expect(balaDe(0n, 0n)).toEqual({ de: 0, largura: 0, negativa: false, zero: null, marca: 0 });
    // Faltou agora e tinha sobrado antes: o zero aparece, a barra sai dele para a esquerda e a marca fica à direita.
    expect(balaDe(-300_000_000n, 100_000_000n)).toEqual({ de: 0, largura: 75, negativa: true, zero: 75, marca: 100 });
    // Sobrou agora e tinha faltado antes.
    expect(balaDe(100_000_000n, -100_000_000n)).toEqual({ de: 50, largura: 50, negativa: false, zero: 50, marca: 0 });
  });

  it('semana normal: cada número com a barra, quanto mudou, o valor da semana anterior e a fonte de cada um', () => {
    const f = new Fontes();
    const [vendas, gasto, sobra] = statsDo(resumo(), f, AGORA);
    expect(vendas!.valor!.texto).toBe(nbsp('R$ 3.471'));
    expect(textoCorrido(vendas!.mudou!.texto)).toBe('13,1% a mais');
    expect(vendas!.mudou).toMatchObject({ tom: 'bom', seta: 'sobe' });
    expect(textoCorrido(vendas!.anterior!)).toBe(nbsp('semana anterior: R$ 3.068'));
    expect(vendas!.bala).toMatchObject({ cor: 'foco', de: 0, largura: 100, marca: 88.38, negativa: false });
    expect(vendas!.bala!.rotulo).toBe(nbsp('Esta semana, R$ 3.471,00 em vendas que vieram do marketing; na semana anterior, R$ 3.068,00.'));
    expect(vendas!.bala!.dicaAntes).toBe(nbsp('R$ 3.068,00|semana anterior · 15/09 a 21/09'));
    expect(gasto!.valor!.texto).toBe(nbsp('R$ 1.214'));
    // Gastar mais não é bom nem ruim: a seta fica, a cor é neutra, e a barra é a do gasto (cinza 1).
    expect(gasto!.mudou).toMatchObject({ tom: 'neutro', seta: 'sobe' });
    expect(gasto!.bala).toMatchObject({ cor: 'c1', marca: 97.17 });
    expect(sobra).toMatchObject({ rotulo: 'Sobrou depois de pagar os anúncios', foco: true });
    expect(sobra!.valor!.texto).toBe(nbsp('R$ 287'));
    // O que sobrou muda em reais (a diferença entre os dois números escritos), não em porcentagem.
    expect(textoCorrido(sobra!.mudou!.texto)).toBe(nbsp('R$ 167 a mais'));
    expect(sobra!.mudou).toMatchObject({ tom: 'bom', seta: 'sobe' });
    expect(textoCorrido(sobra!.anterior!)).toBe(nbsp('semana anterior: R$ 120'));
    expect(sobra!.bala!.rotulo).toBe(nbsp('Esta semana, sobraram R$ 286,50; na semana anterior, sobraram R$ 120,00.'));
    // A lista das fontes segue a ordem da tela: o valor, quanto mudou e o valor de antes.
    expect(f.lista).toEqual([
      { valor: nbsp('R$ 3.471'), fonte: 'Regem · confirmado no caixa · 22/09 a 28/09' },
      { valor: '13,1%', fonte: 'Liame · comparação com 15/09 a 21/09 · calculada pelo sistema' },
      { valor: nbsp('R$ 3.068'), fonte: 'Regem · confirmado no caixa · 15/09 a 21/09' },
      { valor: nbsp('R$ 1.214'), fonte: 'Meta Ads e Google Ads · gasto · 22/09 a 28/09 · lido hoje, 06:12 e 06:20' },
      { valor: '2,9%', fonte: 'Liame · comparação com 15/09 a 21/09 · calculada pelo sistema' },
      { valor: nbsp('R$ 1.180'), fonte: 'Meta Ads e Google Ads · gasto · 15/09 a 21/09' },
      { valor: nbsp('R$ 287'), fonte: 'Liame · margem conhecida − investimento · calculado pelo sistema' },
      { valor: nbsp('R$ 167'), fonte: 'Liame · comparação com 15/09 a 21/09 · calculada pelo sistema' },
      { valor: nbsp('R$ 120'), fonte: 'Liame · margem conhecida − investimento · 15/09 a 21/09 · calculado pelo sistema' },
    ]);
  });

  it('vendas caindo ficam em vermelho; prejuízo vira "Faltou para pagar os anúncios", com a barra para a esquerda do zero', () => {
    const [vendas, , sobra] = statsDo(resumo({}, { revenue_micros: { now: '2000000000', before: '3000000000' }, left_micros: { now: '-150000000', before: '50000000' } }), new Fontes(), AGORA);
    expect(vendas!.mudou).toMatchObject({ tom: 'ruim', seta: 'desce' });
    expect(textoCorrido(vendas!.mudou!.texto)).toBe('33,3% a menos');
    expect(sobra).toMatchObject({ rotulo: 'Faltou para pagar os anúncios', foco: false });
    expect(sobra!.valor!.texto).toBe(nbsp('R$ 150'));
    expect(sobra!.bala).toMatchObject({ negativa: true, zero: 75, de: 0, largura: 75, marca: 100 });
    expect(textoCorrido(sobra!.mudou!.texto)).toBe(nbsp('R$ 200 a menos'));
    expect(sobra!.mudou).toMatchObject({ tom: 'ruim', seta: 'desce' });
    expect(sobra!.bala!.rotulo).toBe(nbsp('Esta semana, faltaram R$ 150,00; na semana anterior, sobraram R$ 50,00.'));
    // Na semana anterior também tinha faltado: a legenda da marca diz.
    const [, , faltava] = statsDo(resumo({}, { left_micros: { now: '-150000000', before: '-90000000' } }), new Fontes(), AGORA);
    expect(textoCorrido(faltava!.anterior!)).toBe(nbsp('semana anterior: faltaram R$ 90'));
  });

  it('sem a semana anterior: a barra fica, sem a marca; igual à anterior diz que está igual', () => {
    const [vendas, gasto, sobra] = statsDo(resumo({}, { revenue_micros: { now: '3471000000', before: null }, spend_micros: { now: '1214300000', before: '1214300000' }, left_micros: { now: '286500000', before: null } }), new Fontes(), AGORA);
    expect(vendas).toMatchObject({ mudou: null, anterior: null });
    expect(vendas!.bala).toMatchObject({ marca: null, dicaAntes: null });
    expect(vendas!.bala!.rotulo).toBe(nbsp('Esta semana, R$ 3.471,00 em vendas que vieram do marketing.'));
    expect(textoCorrido(gasto!.mudou!.texto)).toBe('igual à semana anterior');
    expect(gasto!.mudou).toMatchObject({ tom: 'neutro', seta: null });
    expect(sobra).toMatchObject({ mudou: null, anterior: null });
  });

  it('margem abaixo de 80% (o piloto sem o custo dos produtos): ainda não dá para dizer o que sobrou, e não há barra', () => {
    const [, , baixa] = statsDo(resumo({}, { left_micros: { now: null, before: null }, margin_coverage_pct: '62.0', verdict: null }), new Fontes(), AGORA);
    expect(baixa).toMatchObject({ valor: null, vazio: 'Ainda não dá para dizer', bala: null, mudou: null, anterior: null });
    expect(textoCorrido(baixa!.nota!)).toBe('só 62% das vendas têm custo no Regem');
    const [, , semCusto] = statsDo(resumo({}, { left_micros: { now: null, before: null }, margin_known_micros: null, margin_coverage_pct: null, verdict: null }), new Fontes(), AGORA);
    expect(textoCorrido(semCusto!.nota!)).toBe('nenhuma venda tem o custo dos produtos no Regem');
    // Sem pedido dos anúncios, o motivo é outro: não há venda para descontar do gasto.
    const semPedido = resumo({ orders: { marketing: 0, average_micros: null, all_channels: 12, without_origin: 4 } }, { revenue_micros: { now: '0', before: '3068000000' }, left_micros: { now: null, before: null }, margin_known_micros: null, margin_coverage_pct: null, verdict: null });
    const [semVenda, , semSobra] = statsDo(semPedido, new Fontes(), AGORA);
    expect(textoCorrido(semSobra!.nota!)).toBe('nenhuma venda veio dos anúncios');
    expect(semVenda!.valor!.texto).toBe(nbsp('R$ 0'));
    expect(textoCorrido(semVenda!.mudou!.texto)).toBe('100,0% a menos');
  });

  it('sem o Regem: só o gasto; na primeira semana, nenhum dos três', () => {
    const semRegem = statsDo(resumo({ state: 'sem_regem' }), new Fontes(), AGORA);
    expect(semRegem.map((s) => s.vazio)).toEqual(['Sem o Regem, não dá para saber', null, 'Sem o Regem, não dá para saber']);
    expect(semRegem[1]!.valor!.texto).toBe(nbsp('R$ 1.214'));
    expect(semRegem[1]!.bala).not.toBeNull();
    expect(textoCorrido(semRegem[0]!.nota!)).toBe('O caixa da loja é que confirma cada venda.');
    const primeira = statsDo(resumo({ state: 'primeira_semana' }), new Fontes(), AGORA);
    expect(primeira.map((s) => s.vazio)).toEqual(Array(3).fill('Ainda sem 7 dias completos'));
    expect(primeira.every((s) => s.bala === null)).toBe(true);
  });
});

describe('Resumo: para onde foi cada real vendido', () => {
  const partes = (r: SummaryResponse) => {
    const d = dinheiroDo(r, new Fontes());
    if (d.tipo !== 'barra') throw new Error('esperava a barra');
    return d;
  };

  it('semana normal: o selo, a barra com o custo, o que não tem custo, os anúncios e o que sobrou, e as campanhas de cada lado', () => {
    const f = new Fontes();
    const d = dinheiroDo(resumo(), f);
    if (d.tipo !== 'barra') throw new Error('esperava a barra');
    expect(d.selo).toEqual({ rotulo: 'Empatou', classe: 'atencao' });
    expect(textoCorrido(d.sub)).toBe('53 pedidos com prova de anúncio · 22/09 a 28/09');
    // Sem a receita com custo conhecido na resposta (as de antes de 07/10/2026), ela sai da porcentagem: 91,4%.
    expect(d.partes.map((p) => [p.classe, p.num.texto, p.rotulo])).toEqual([
      ['c2', nbsp('R$ 1.672'), 'custo dos produtos'],
      ['semcusto', nbsp('R$ 299'), 'em itens sem custo no Regem'],
      ['c1', nbsp('R$ 1.214'), 'anúncios'],
      ['foco', nbsp('R$ 287'), 'sobrou'],
    ]);
    expect(d.marca).toBeNull();
    expect(d.frase).toBeNull();
    expect(d.rotulo).toBe(nbsp('Dos R$ 3.471,00 vendidos: R$ 1.672 de custo dos produtos, R$ 299 em itens sem custo no Regem, R$ 1.214 de anúncios e R$ 287 que sobraram.'));
    expect(d.lados).toEqual({ lucro: ['Combo sexta'], prejuizo: ['Smash em dobro', 'Busca hambúrguer perto'] });
    // Cada valor da legenda leva à fonte dele.
    expect(f.lista.map((l) => l.fonte)).toEqual([
      'Regem · confirmado no caixa · 22/09 a 28/09',
      'Regem · custo dos produtos vendidos · 22/09 a 28/09',
      'Regem · vendas de itens sem custo cadastrado · 22/09 a 28/09',
      'Meta Ads e Google Ads · gasto · 22/09 a 28/09',
      'Liame · margem conhecida − investimento · calculado pelo sistema',
    ]);
    // Com a receita com custo conhecido vinda do servidor, a conta é exata: tudo tem custo, e a parte hachurada some.
    const exato = partes(resumo({}, { revenue_with_margin_micros: '3471000000' }));
    expect(exato.partes.map((p) => [p.classe, p.num.texto])).toEqual([['c2', nbsp('R$ 1.970')], ['c1', nbsp('R$ 1.214')], ['foco', nbsp('R$ 287')]]);
    expect(partes(resumo({}, { verdict: 'lucro' })).selo).toEqual({ rotulo: 'Deu lucro', classe: 'bom' });
  });

  it('prejuízo: a barra dos anúncios vai até onde a margem cobre, o que faltou continua depois da marca do que foi vendido', () => {
    const d = partes(resumo({}, { left_micros: { now: '-150000000', before: null }, margin_known_micros: '1064300000', revenue_with_margin_micros: '3471000000', verdict: 'prejuizo' }));
    expect(d.selo).toEqual({ rotulo: 'Deu prejuízo', classe: 'ruim' });
    expect(d.partes.map((p) => [p.classe, p.num.texto, p.peso])).toEqual([
      ['c2', nbsp('R$ 2.407'), 240670],
      ['c1', nbsp('R$ 1.214'), 106430],
      ['falta', nbsp('R$ 150'), 15000],
    ]);
    expect(d.marca).toEqual({ posicao: 0.95857, antes: 2, texto: nbsp('vendido: R$ 3.471') });
    expect(d.rotulo).toContain(nbsp('R$ 150 que faltaram para pagar os anúncios'));
  });

  it('margem incompleta: quanto das vendas tem custo, com a marca dos 80%, e sem as campanhas de cada lado', () => {
    const d = partes(resumo({}, { left_micros: { now: null, before: null }, margin_coverage_pct: '62.0', verdict: null }));
    expect(d.selo).toEqual({ rotulo: 'Margem incompleta', classe: 'incompleta' });
    expect(d.partes.map((p) => [p.classe, p.num.texto, p.rotulo])).toEqual([
      ['foco', '62%', 'das vendas com custo no Regem'],
      ['semcusto', nbsp('R$ 1.319'), 'em itens sem custo'],
    ]);
    expect(d.marca).toEqual({ posicao: 0.8, antes: 0, texto: 'precisa de 80%' });
    expect(d.frase!.map((x) => x.t).join('')).toBe('Ainda não dá para dizer se sobrou. Falta o custo de alguns itens no Regem.');
    expect(d.lados).toEqual({ lucro: [], prejuizo: [] });
  });

  it('sem o que desenhar (primeira semana, sem o Regem, sem gasto, sem pedido de anúncio): fica a frase do veredito', () => {
    const vago = (r: SummaryResponse) => {
      const d = dinheiroDo(r, new Fontes());
      if (d.tipo !== 'vago') throw new Error('esperava a frase');
      return textoCorrido(d.veredito.frase);
    };
    expect(vago(resumo({ state: 'primeira_semana' }))).toMatch(/^Os primeiros 7 dias completos ainda não fecharam\./);
    expect(vago(resumo({ state: 'sem_regem' }))).toMatch(/^Sem o Regem, o Liame vê o gasto, não as vendas\./);
    expect(vago(resumo({}, { spend_micros: { now: '0', before: null } }))).toMatch(/^Sem gasto com anúncios/);
    expect(vago(resumo({ orders: { marketing: 0, average_micros: null, all_channels: 12, without_origin: 4 } }))).toMatch(/^Nenhum pedido com prova de anúncio/);
    expect(dinheiroDo(resumo({ state: 'sem_regem' }), new Fontes())).toMatchObject({ tipo: 'vago', veredito: { conectarRegem: true } });
  });
});

describe('Resumo: o veredito', () => {
  it('a regra de Resultados, com as campanhas de cada lado', () => {
    expect(textoCorrido(vereditoDo(resumo()).frase)).toBe(
      'O marketing se pagou, mas sobrou pouco. A Combo sexta dá lucro; a Smash em dobro e a Busca hambúrguer perto gastaram mais do que a margem que trouxeram.',
    );
    expect(textoCorrido(vereditoDo(resumo({}, { verdict: 'lucro' })).frase)).toMatch(/^O marketing deu lucro\./);
    const soPrejuizo = resumo({ campaigns: { profit: [], loss: [{ campaign_id: uuid(12), name: 'Smash em dobro', provider: 'meta_ads' }] } }, { verdict: 'prejuizo' });
    expect(textoCorrido(vereditoDo(soPrejuizo).frase)).toBe('O marketing não se pagou. A Smash em dobro gastou mais do que a margem que trouxe.');
  });

  it('sem margem, sem gasto, sem pedido de anúncio, sem o Regem e na primeira semana', () => {
    expect(textoCorrido(vereditoDo(resumo({}, { verdict: null, margin_coverage_pct: '62.0' })).frase)).toBe(
      'Ainda não dá para dizer se sobrou. Só 62% das vendas têm custo cadastrado no Regem; com menos de 80%, o Liame não diz se deu lucro.',
    );
    expect(textoCorrido(vereditoDo(resumo({}, { spend_micros: { now: '0', before: null } })).frase)).toMatch(/^Sem gasto com anúncios/);
    expect(textoCorrido(vereditoDo(resumo({ orders: { marketing: 0, average_micros: null, all_channels: 12, without_origin: 4 } })).frase)).toMatch(/^Nenhum pedido com prova de anúncio/);
    expect(vereditoDo(resumo({ state: 'sem_regem' }))).toMatchObject({ conectarRegem: true });
    expect(textoCorrido(vereditoDo(resumo({ state: 'primeira_semana' })).frase)).toMatch(/^Os primeiros 7 dias completos ainda não fecharam\./);
  });
});

describe('Resumo: precisa de você', () => {
  const itens = [aviso({}), aviso({ kind: 'cupom_sem_uso', severity: 'atencao', title: 'O cupom SMASH10 não foi usado', campaign_id: uuid(12) }), aviso({ kind: 'anuncio_sem_rastreio', severity: 'atencao', title: '3 anúncios estão sem o rastreio do Liame', campaign_id: null })];

  const TUDO = { acoes: true, planos: true, autonomia: true };
  const NADA = { acoes: false, planos: false, autonomia: false };

  it('os críticos primeiro, depois o pedido de decisão, depois os de atenção; cada um leva à tela onde se resolve', () => {
    const lista = precisaDe(resumo({ needs_you: { critical: 1, attention: 2, items: itens, approvals: { actions: 2, plans: 0, autonomy: 0 } } }), true, true, TUDO);
    expect(lista.map((i) => [i.gravidade, i.titulo, i.botao?.href])).toEqual([
      ['urgente', 'A Delivery noite parou de aparecer para as pessoas', '/atencao'],
      ['decisao', '2 pedidos esperam a sua decisão', '/aprovacoes'],
      ['atencao', 'O cupom SMASH10 não foi usado', '/links#cupons'],
      ['atencao', '3 anúncios estão sem o rastreio do Liame', '/links'],
    ]);
    expect(lista[1]!.botao).toMatchObject({ rotulo: 'Decidir', primario: true });
  });

  it('sem poder aprovar, não há o pedido de decisão; sem ver as vendas, os avisos do caixa levam à Atenção', () => {
    const r = resumo({ needs_you: { critical: 0, attention: 1, items: [itens[1]!], approvals: { actions: 3, plans: 0, autonomy: 0 } } });
    expect(precisaDe(r, true, true, NADA).map((i) => i.chave)).not.toContain('decisao');
    expect(precisaDe(r, false, true, NADA)[0]!.botao!.href).toBe('/atencao');
    expect(textoCorrido(precisaDe(resumo({ needs_you: { critical: 0, attention: 0, items: [], approvals: { actions: 1, plans: 0, autonomy: 0 } } }), true, true, TUDO)[0]!.sub)).toBe('Nada vai ao ar sem você.');
  });

  it('o pedido de decisão junta as ações e os planos do Estrategista que a pessoa pode decidir', () => {
    const r = resumo({ needs_you: { critical: 0, attention: 0, items: [], approvals: { actions: 2, plans: 1, autonomy: 0 } } });
    const juntos = precisaDe(r, true, true, TUDO);
    expect(juntos.map((i) => [i.chave, i.titulo, i.botao?.href])).toEqual([['decisao', '3 pedidos esperam a sua decisão', '/aprovacoes']]);
    expect(textoCorrido(juntos[0]!.sub)).toBe('2 ações e 1 plano do Estrategista. Nada vai ao ar sem você.');
    // Quem só decide planos vê só os planos; quem só aprova ações, só as ações.
    const soPlanos = precisaDe(r, true, true, { ...NADA, planos: true });
    expect(soPlanos[0]!.titulo).toBe('1 pedido espera a sua decisão');
    expect(textoCorrido(soPlanos[0]!.sub)).toBe('Um plano do Estrategista. Nada vai ao ar sem você.');
    expect(precisaDe(r, true, true, { ...NADA, acoes: true })[0]!.titulo).toBe('2 pedidos esperam a sua decisão');
    const varios = precisaDe(resumo({ needs_you: { critical: 0, attention: 0, items: [], approvals: { actions: 0, plans: 3, autonomy: 0 } } }), true, true, TUDO);
    expect(textoCorrido(varios[0]!.sub)).toBe('3 planos do Estrategista. Nada vai ao ar sem você.');
  });

  it('a proposta de um funcionário passar a sugerir é um pedido à parte, decidido em Sua equipe', () => {
    const r = resumo({ needs_you: { critical: 1, attention: 1, items: [itens[0]!, itens[1]!], approvals: { actions: 1, plans: 0, autonomy: 2 } } });
    const lista = precisaDe(r, true, true, TUDO);
    expect(lista.map((i) => i.chave)).toEqual([expect.stringContaining(''), 'decisao', 'autonomia', expect.stringContaining('')]);
    expect(lista.map((i) => i.gravidade)).toEqual(['urgente', 'decisao', 'decisao', 'atencao']);
    const autonomia = lista[2]!;
    expect(autonomia.titulo).toBe('O Gestor de tráfego espera a sua decisão');
    expect(textoCorrido(autonomia.sub)).toBe('Em sombra, ele mostrou que acerta. Você decide se ele passa a sugerir mudanças (2 propostas).');
    expect(autonomia.botao).toEqual({ rotulo: 'Ver', href: '/equipe', primario: false });
    // Quem não gerencia as políticas não vê a proposta.
    expect(precisaDe(r, true, true, { ...TUDO, autonomia: false }).map((i) => i.chave)).not.toContain('autonomia');
  });

  it('o número do menu: os avisos e, havendo pedido esperando, mais um', () => {
    expect(contadorDoResumo(3, 2)).toBe(4);
    expect(contadorDoResumo(3, 0)).toBe(3);
    expect(contadorDoResumo(null, null)).toBe(0);
    expect(pontosFalados(1)).toBe(', 1 ponto para você');
    expect(pontosFalados(4)).toBe(', 4 pontos para você');
  });
});

describe('Resumo: pedidos, canais e a equipe', () => {
  it('os pedidos numa barra só: de anúncios com prova, de aplicativos e balcão, e sem prova; o valor médio à parte', () => {
    const f = new Fontes();
    const p = pedidosDo(resumo(), f)!;
    expect(p.total.texto).toBe('412');
    expect(p.partes.map((x) => [x.classe, x.num.texto, x.peso, x.rotulo])).toEqual([
      ['foco', '53', 53, 'de anúncios, com prova'],
      ['c1', '298', 298, 'de aplicativos de entrega e balcão'],
      ['c2', '61', 61, 'do cardápio e do WhatsApp, sem prova de anúncio'],
    ]);
    expect(p.rotulo).toBe('Dos 412 pedidos da semana: 53 de anúncios, com prova, 298 de aplicativos de entrega e balcão e 61 do cardápio e do WhatsApp, sem prova de anúncio.');
    expect(p.partes[0]!.dica).toBe('53 pedidos|de anúncios, com prova · 13%');
    expect(p.medio!.texto).toBe(nbsp('R$ 65,49'));
    expect(f.lista[0]).toEqual({ valor: '412', fonte: 'Regem · pedidos de todos os canais · 22/09 a 28/09' });
    // Sem pedido de anúncio, a parte dele some e não há valor médio; sem pedido nenhum, não há barra.
    const semAnuncio = pedidosDo(resumo({ orders: { marketing: 0, average_micros: null, all_channels: 12, without_origin: 4 } }), new Fontes())!;
    expect(semAnuncio.partes.map((x) => [x.classe, x.num.texto])).toEqual([['c1', '8'], ['c2', '4']]);
    expect(semAnuncio.medio).toBeNull();
    expect(pedidosDo(resumo({ orders: { marketing: 0, average_micros: null, all_channels: 0, without_origin: 0 } }), new Fontes())!.partes).toEqual([]);
    expect(pedidosDo(resumo({ state: 'sem_regem' }), new Fontes())).toBeNull();
  });

  it('cada canal de anúncio na mesma régua: o que sobrou vai para a direita do zero, e o que faltou, para a esquerda', () => {
    const c = canaisDo(resumo(), new Fontes())!;
    if (c.tipo !== 'lista') throw new Error('esperava a lista');
    expect(c.legenda).toEqual({ faltou: true, sobrou: true });
    expect(c.zero).toBeCloseTo(22.32, 1);
    expect(c.linhas.map((l) => [l.nome, l.pedidos.texto, l.tipo, l.valor?.sinal, l.valor?.num.texto])).toEqual([
      ['Instagram e Facebook', '41', 'ganho', '+', nbsp('R$ 402')],
      ['Google', '12', 'perda', '−', nbsp('R$ 116')],
    ]);
    // A mesma régua dos dois lados: as duas barras juntas ocupam a régua inteira, cada uma no lado dela.
    expect(c.linhas[0]!.largura).toBeCloseTo(100 - c.zero, 0);
    expect(c.linhas[1]!.largura).toBeCloseTo(c.zero, 0);
    expect(c.linhas[0]!.rotulo).toBe(nbsp('Instagram e Facebook: sobraram R$ 402,10 depois de pagar o anúncio'));
    expect(c.linhas[1]!.rotulo).toBe(nbsp('Google: faltaram R$ 115,60 depois de pagar o anúncio'));
    expect(nomeDoCanal('meta_ads')).toBe('Instagram e Facebook');
    // Só sobrou: o zero fica na borda e não há "faltou" na legenda. Só faltou: o zero vai para a direita.
    const soSobrou = canaisDo(resumo({ platforms: [{ provider: 'meta_ads', orders: 41, left_micros: '402100000' }] }), new Fontes())!;
    expect(soSobrou).toMatchObject({ tipo: 'lista', zero: 0, legenda: { faltou: false, sobrou: true } });
    const soFaltou = canaisDo(resumo({ platforms: [{ provider: 'google_ads', orders: 12, left_micros: '-115600000' }] }), new Fontes())!;
    expect(soFaltou).toMatchObject({ tipo: 'lista', zero: 60, legenda: { faltou: true, sobrou: false } });
  });

  it('canal sem pedido diz o que gastou; com a margem incompleta, não diz quanto sobrou; sem canal, diz por quê', () => {
    const c = canaisDo(resumo({ platforms: [{ provider: 'meta_ads', orders: 0, left_micros: null, spend_micros: '845300000' }, { provider: 'google_ads', orders: 12, left_micros: null }] }), new Fontes())!;
    if (c.tipo !== 'lista') throw new Error('esperava a lista');
    expect(c.linhas.map((l) => [l.tipo, l.texto, l.valor])).toEqual([
      ['neutro', nbsp('gastou R$ 845'), null],
      ['semcusto', 'margem incompleta', null],
    ]);
    expect(c.legenda).toEqual({ faltou: false, sobrou: false });
    expect(c.linhas[0]!.rotulo).toBe(nbsp('Instagram e Facebook: sem pedido na semana; gastou R$ 845,30'));
    // Resposta de antes de 07/10/2026 não traz o gasto do canal.
    const antiga = canaisDo(resumo({ platforms: [{ provider: 'meta_ads', orders: 0, left_micros: null }] }), new Fontes())!;
    expect(antiga).toMatchObject({ tipo: 'lista', linhas: [{ tipo: 'neutro', texto: 'sem pedido na semana' }] });
    // Conta conectada sem gasto na semana não é o mesmo que não ter conta de anúncio.
    expect(canaisDo(resumo({ platforms: [] }), new Fontes())).toEqual({ tipo: 'vazio', frase: 'Nenhum anúncio gastou nos últimos 7 dias.' });
    expect(canaisDo(resumo({ platforms: [], sources: [fonte('regem')] }), new Fontes())).toEqual({ tipo: 'vazio', frase: 'Nenhuma conta de anúncio conectada a esta marca.' });
    expect(canaisDo(resumo({ state: 'primeira_semana' }), new Fontes())).toBeNull();
  });

  it('a equipe: o que cada um fez no mês, contado pelo código; desligado e parado não entram', () => {
    const t = equipe([
      membro('lia', { stats: [stat('respostas', 61)] }),
      membro('analista', { stats: [stat('explicacoes', 1)] }),
      membro('relatorios', { kind: 'regra', stats: [stat('revisoes', 0)] }),
      membro('compliance', { kind: 'regra' }),
      membro('estrategista', { stats: [stat('planos_aprovados', 1), stat('planos_esperando', 2)] }),
      membro('pesquisador', { status: 'desligado' }),
      membro('trafego', { kind: 'regra', status: 'sombra', stats: [stat('recomendacoes', 12)] }),
    ]);
    expect(equipeDo(t).map((l) => `${l.nome}${l.sep}${l.texto}`)).toEqual([
      'LIA respondeu 61 perguntas na conversa, com a fonte de cada número.',
      'Analista de dados explicou 1 número em Resultados e na Atenção.',
      'Relatórios faz a revisão da semana toda segunda-feira.',
      'Compliance confere todo texto feito por IA antes de ele aparecer.',
      'Estrategista montou 3 planos: 2 esperam você.',
      'Gestor de tráfego, em sombra, anotou 12 recomendações, sem mexer em nada.',
    ]);
    expect(equipeDo(equipe([membro('lia', { status: 'desligado_pela_liame' }), membro('trafego', { status: 'desligado_pela_liame' })], false))).toEqual([]);
  });

  it('as fontes: o mesmo valor com a mesma fonte é uma linha só', () => {
    const f = new Fontes();
    expect(f.n('53', 'Regem')).toEqual({ texto: '53', i: 0 });
    expect(f.n('53', 'Regem')).toEqual({ texto: '53', i: 0 });
    expect(f.n('53', 'Liame')).toEqual({ texto: '53', i: 1 });
    expect(f.lista).toHaveLength(2);
  });
});

describe('Resumo: a tela', () => {
  const desenhar = (r: SummaryResponse, t: TeamResponse | null = null, pode: (p: string) => boolean = tudoPode) =>
    renderToStaticMarkup(createElement(AvisosProvider, { children: createElement(ResumoConteudo, { r, equipe: t, nomePessoa: 'Rodrigo de Oliveira', nomeMarca: 'Mister Burgers', agora: AGORA, pode }) }));

  it('com a conversa disponível: "Pergunte à LIA" e as perguntas prontas do veredito; sem ela, nada disso aparece', () => {
    const tela = (disponivel: boolean) =>
      renderToStaticMarkup(
        createElement(AvisosProvider, {
          children: createElement(ConversaProvider, {
            disponivel,
            children: createElement(ResumoConteudo, { r: resumo(), equipe: null, nomePessoa: 'Rodrigo de Oliveira', nomeMarca: 'Mister Burgers', agora: AGORA, pode: tudoPode }),
          }),
        }),
      );
    const com = tela(true);
    expect(com).toContain('Pergunte à LIA');
    expect(com).toContain('Por que sobrou pouco?');
    expect(com).toContain('O que eu faço primeiro?');
    expect(com).toContain('Como foi a semana?');
    expect(com).toContain('r-precisa--com-lia');
    const sem = tela(false);
    expect(sem).not.toContain('Pergunte à LIA');
    expect(sem).not.toContain('Por que sobrou pouco?');
    expect(sem).not.toContain('r-precisa--com-lia');
  });

  it('semana normal: saudação, os três números com a barra e a fonte, o veredito desenhado, os pedidos, os canais e a lista das fontes', () => {
    const html = desenhar(resumo({ needs_you: { critical: 1, attention: 0, items: [aviso({})], approvals: { actions: 1, plans: 0, autonomy: 0 } } }), equipe([membro('lia', { stats: [stat('respostas', 3)] })]));
    expect(html).toContain('Terça, 29 de setembro · Mister Burgers');
    expect(html).toContain('Boa tarde, Rodrigo.');
    expect(html).toContain('Assim foi o seu marketing nos últimos 7 dias.');
    expect(html).toContain('class="nf"');
    expect(html).toContain('De onde vêm os números (');
    // O veredito é desenhado: o selo, a barra dividida e as campanhas de cada lado; a frase de antes não aparece.
    expect(html).not.toContain('O marketing se pagou, mas sobrou pouco.');
    expect(html).toContain('Para onde foi cada real vendido');
    expect(html).toContain('<span class="veredito veredito--atencao">Empatou</span>');
    expect(html).toContain('<span class="veredito veredito--bom">Dá lucro</span><span>Combo sexta</span>');
    expect(html).toContain('<span class="veredito veredito--ruim">Dá prejuízo</span><span>Smash em dobro e Busca hambúrguer perto</span>');
    // Cada um dos três números tem a barra (com o rótulo para quem ouve a tela) e a marca da semana anterior.
    expect(html.match(/class="bala" role="img"/g)).toHaveLength(3);
    expect(html.match(/class="bala-marca"/g)).toHaveLength(3);
    expect(html).toContain('semana anterior: ');
    // Os pedidos numa barra só e cada canal na régua de sobrou e faltou.
    expect(html).toContain('De onde vieram os pedidos');
    expect(html).toContain('confirmados no caixa do Regem, em todos os canais.');
    expect(html).toContain('Cada pedido que veio dos anúncios valeu, em média,');
    expect(html).toContain('Cada canal de anúncio');
    expect(html).toContain('← faltou');
    expect(html).toContain('sobrou →');
    expect(html).toContain('class="b b--ganho"');
    expect(html).toContain('class="b b--perda"');
    // Os desenhos antigos saíram.
    expect(html).not.toContain('mini-stats');
    expect(html).not.toContain('canal-barra');
    expect(html).not.toContain('dono-veredito');
    expect(html).toContain('href="/aprovacoes"');
    expect(html).toContain('Ver todos os avisos');
    expect(html).toContain('O que a sua equipe fez');
    // O cartão da equipe leva à tela Sua equipe (P7).
    expect(html).toContain('href="/equipe"');
    expect(html).toContain('Convidar uma pessoa');
    expect(html).not.toContain('Conectar o Regem');
  });

  it('sem nada pendente: "Nada precisa de você agora"; sem o Regem: o convite para conectar', () => {
    expect(desenhar(resumo({ needs_you: { critical: 0, attention: 0, items: [], approvals: { actions: 0, plans: 0, autonomy: 0 } } }))).toContain('Nada precisa de você agora');
    const html = desenhar(resumo({ state: 'sem_regem' }));
    expect(html).toContain('Conectar o Regem');
    expect(html).toContain('Os pedidos vêm do caixa do Regem.');
    // Sem o que desenhar, o cartão do dinheiro fica com a frase e a barra vazia; só o gasto tem a barra dele.
    expect(html).toContain('Sem o Regem, o Liame vê o gasto, não as vendas.');
    expect(html).toContain('pilha pilha--vazia');
    expect(html.match(/class="bala" role="img"/g)).toHaveLength(1);
    expect(html).toContain('Sem o Regem, os pedidos não chegam ao Liame.');
    // Sem a permissão de ver as contas, o botão de conectar não aparece.
    expect(desenhar(resumo({ state: 'sem_regem' }), null, (p) => p !== 'contas.ver')).not.toContain('Conectar o Regem');
  });

  it('sem as permissões: sem o convite, sem "Ver todos os avisos", sem o cartão da equipe', () => {
    const html = desenhar(resumo({ needs_you: { critical: 1, attention: 0, items: [aviso({})], approvals: { actions: 0, plans: 0, autonomy: 0 } } }), null, (p) => p === 'vendas.ver');
    expect(html).not.toContain('Convidar uma pessoa');
    expect(html).not.toContain('Ver todos os avisos');
    expect(html).not.toContain('O que a sua equipe fez');
    // Sem a equipe e sem o convite, nenhum cartão fica sozinho pela metade.
    expect(html).not.toContain('r-cheio');
    const soConvite = desenhar(resumo(), null, tudoPode);
    expect(soConvite).toContain('card r-cta r-cheio');
  });
});

describe('Resumo: o cartão da verba do mês (P9)', () => {
  const micros = (reais: number) => Math.round(reais * 100) * 10_000;
  /** Setembro do protótipo: R$ 4.960,00 gastos até ontem, previsão de R$ 5.306,94 e teto de R$ 5.500,00. */
  function verbaDoMes(over: Partial<BudgetMonthResponse> = {}, limites: Partial<BudgetMonthResponse['limits']> = {}): BudgetMonthResponse {
    return {
      period: '2026-09',
      timezone: FUSO,
      today: '2026-09-29',
      month_start: '2026-09-01',
      month_end: '2026-09-30',
      through: '2026-09-28',
      days_left: 2,
      currency: 'BRL',
      spend_micros: micros(4960),
      daily_micros: micros(173.47),
      forecast_micros: micros(5306.94),
      forecast_days: 2,
      pending_daily_micros: 0,
      pending_micros: 0,
      limits: { month_micros: micros(5500), campaign_daily_micros: micros(80), set_by: { id: uuid(1), name: 'Rodrigo' }, set_at: '2026-09-20T15:00:00.000Z', ...limites },
      remaining_micros: micros(193.06),
      platforms: [
        { provider: 'meta_ads', accounts: 1, spend_micros: micros(3381.2), daily_micros: micros(120.76), forecast_micros: micros(3622.72), read_through: '2026-09-28', forecast_days: 2, stale: false, last_success_at: '2026-09-29T09:12:00.000Z' },
      ],
      rules: { change_percent_max: 10, rate_limit: { max: 3, window_minutes: 60 } },
      changes: [],
      overspend: [],
      largest_daily_micros: micros(60),
      generated_at: '2026-09-29T17:40:00.000Z',
      ...over,
    };
  }
  const semTeto = () => verbaDoMes({ remaining_micros: null }, { month_micros: null, campaign_daily_micros: null, set_by: null, set_at: null });
  const desenhar = (verba: BudgetMonthResponse | null, pode: (p: string) => boolean = tudoPode, variasMarcas = false) =>
    renderToStaticMarkup(
      createElement(AvisosProvider, {
        children: createElement(ResumoConteudo, { r: resumo(), equipe: null, verba, variasMarcas, nomePessoa: 'Rodrigo de Oliveira', nomeMarca: 'Mister Burgers', agora: AGORA, pode }),
      }),
    );

  it('com o teto: quanto de quanto, a barra, a frase do mês e o caminho para a tela', () => {
    const html = desenhar(verbaDoMes());
    expect(html).toContain('card r-verba');
    expect(html).toContain('Verba de setembro');
    expect(html).toContain(nbsp('Até ontem, R$ 4.960,00 de R$ 5.500,00.'));
    expect(html).toContain('role="img" aria-label="Gasto até ontem: 90% do teto. Previsão de fechamento: 96% do teto."');
    expect(html).toContain('<b>Setembro deve fechar dentro do teto.</b>');
    expect(html).toContain('href="/verba"');
    expect(html).toContain('Ver a verba do mês');
    expect(html).not.toContain('Definir os limites');
  });

  it('sem o teto: quem define os limites vai direto ao formulário; quem só acompanha vai à tela', () => {
    const dono = desenhar(semTeto());
    expect(dono).toContain('<b>Você ainda não definiu o teto do mês.</b>');
    expect(dono).toContain('O teto que você define. O Liame não aprova nada que passe dele.');
    expect(dono).toContain('href="/verba#limites"');
    expect(dono).toContain('Definir os limites');
    expect(dono).not.toContain('verba-barra');
    const gestor = desenhar(semTeto(), (p) => p !== 'orcamento.gerenciar');
    expect(gestor).not.toContain('Definir os limites');
    expect(gestor).toContain('Ver a verba do mês');
  });

  it('a verba é da empresa: com mais de uma marca, o cartão diz que soma todas', () => {
    expect(desenhar(verbaDoMes(), tudoPode, true)).toContain(nbsp('Até ontem, R$ 4.960,00 de R$ 5.500,00. Soma as contas de anúncio de todas as marcas da empresa.'));
    expect(desenhar(verbaDoMes())).not.toContain('todas as marcas');
  });

  it('sem a leitura da verba (sem a permissão ou com a leitura falha) e sem conta de anúncio, o cartão não aparece', () => {
    expect(desenhar(null)).not.toContain('r-verba');
    expect(desenhar(verbaDoMes({ platforms: [] }))).not.toContain('r-verba');
  });
});

describe('menu: o Resumo é a página inicial do Lite, a Atenção a do Pro', () => {
  const agencia = NAVEGACAO.find((g) => g.id === 'agencia')!;

  it('no Lite, o Resumo e não a Atenção; no Pro, o contrário; sem ver as vendas, a Atenção fica no Lite também', () => {
    expect(itensVisiveis(agencia, tudoPode, 'lite').map((i) => i.href)).toEqual(['/resumo', '/aprovacoes', '/resultados', '/verba', '/equipe', '/marca', '/contas', '/pessoas']);
    expect(itensVisiveis(agencia, tudoPode, 'pro').map((i) => i.href)).toEqual(['/atencao', '/aprovacoes', '/resultados', '/verba', '/equipe', '/marca', '/contas', '/pessoas']);
    expect(itensVisiveis(agencia, (p) => p !== 'vendas.ver', 'lite').map((i) => i.href)).toEqual(['/atencao', '/aprovacoes', '/verba', '/equipe', '/marca', '/contas', '/pessoas']);
    expect(agencia.itens[0]).toMatchObject({ href: '/resumo', rotulo: 'Resumo', icone: 'home', permissao: 'vendas.ver', contador: 'resumo', soNo: 'lite' });
  });

  it('título e seletor Lite/Pro no Resumo e na Atenção (trocar de modo troca a página inicial)', () => {
    expect(tituloDa('/resumo')).toBe('Resumo');
    expect(temModos('/resumo', tudoPode)).toBe(true);
    expect(temModos('/atencao', tudoPode)).toBe(true);
    expect(temModos('/resumo', (p) => p !== 'vendas.ver')).toBe(false);
  });

  it('a raiz leva à página inicial do modo; sem empresa, à conta', () => {
    expect(destinoInicial('lite', tudoPode, true)).toBe('/resumo');
    expect(destinoInicial('pro', tudoPode, true)).toBe('/atencao');
    expect(destinoInicial('lite', (p) => p !== 'vendas.ver', true)).toBe('/atencao');
    expect(destinoInicial('lite', (p) => p === 'pessoas.ver', true)).toBe('/pessoas');
    expect(destinoInicial('lite', () => false, true)).toBe('/seguranca');
    expect(destinoInicial('lite', tudoPode, false)).toBe('/seguranca');
  });
});
