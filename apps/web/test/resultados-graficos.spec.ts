import type { ClosedLoopResponse, DailyResultsResponse } from '@liame/contracts';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { campanhasLiteDe, conversasDe, diasDe, faixaDe, montarGraficos, origemLiteDe, realDe, retornoDe } from '@/components/resultados/graficos';
import { ResultadosConteudo } from '@/components/resultados/resultados-conteudo';
import { montarTela, textoDe } from '@/components/resultados/textos';
import { ModoProvider } from '@/lib/modo';
import { AGORA, base7, confirmado, fonte, hoje, micros, piloto, sp, uuid } from './resultados-dados';

// Os desenhos do modo simples de Resultados (mockups/prototipo-resultados-graficos.html, aprovado em 07/10/2026): a
// faixa única do topo, o número principal com as duas barras e a marca do empate, a variação e o gráfico dos dias,
// "para onde foi cada real vendido", cada campanha em "sobrou" ou "faltou", as conversas que viraram pedido e a
// origem dos pedidos. Tamanhos e posições saem de inteiros (micros e centésimos). Datas fixas (LIC-006).

const tela = (r: ClosedLoopResponse, periodo: 'hoje' | '7' | '30' = '7') => montarTela(r, periodo, new Date(r.generated_at), 'Loja Centro');

/** A semana de 22 a 28/09 (terça a segunda), com as vendas e o gasto de cada dia, e o período anterior somado. */
function semana(roasAnterior: string | null = '2.65'): DailyResultsResponse {
  const vendas = ['380.00', '420.00', '405.00', '690.00', '685.00', '560.00', '465.00'];
  const gasto = ['160.00', '160.00', '170.00', '195.00', '195.00', '200.00', '160.00'];
  return {
    period: { from: '2026-09-22', to: '2026-09-28', timezone: 'America/Sao_Paulo' },
    currency: 'BRL',
    days: vendas.map((v, i) => ({ date: `2026-09-${22 + i}`, spend_micros: micros(gasto[i]!), orders: 5 + i, revenue_micros: micros(v) })),
    previous: { from: '2026-09-15', to: '2026-09-21', spend_micros: micros('1180.00'), orders: 47, revenue_micros: micros('3127.00'), roas: roasAnterior },
    generated_at: AGORA,
  };
}

/** Os 7 dias do protótipo com a receita de custo conhecido que a rota manda (85% de R$ 3.605,00). */
function comCusto(): ClosedLoopResponse {
  const r = base7();
  r.totals.confirmed = { ...r.totals.confirmed, revenue_with_margin_micros: micros('3064.25') };
  return r;
}

/** O marketing não se pagou: R$ 2.129 vendidos, R$ 846,30 de margem conhecida e R$ 1.240 de anúncios. */
function prejuizo(): ClosedLoopResponse {
  const r = base7();
  r.totals.confirmed = confirmado({
    orders: 32,
    revenue_micros: micros('2129.00'),
    roas: '1.72',
    cost_per_order_micros: micros('38.75'),
    margin_known_micros: micros('846.30'),
    margin_coverage_pct: '94.3',
    revenue_with_margin_micros: micros('2007.29'),
    verdict: 'prejuizo',
  });
  return r;
}

const graficos = (r: ClosedLoopResponse, periodo: 'hoje' | '7' | '30' = '7', serie: DailyResultsResponse | null = null) => {
  const t = tela(r, periodo);
  return { t, g: montarGraficos(r, t.base, t.fontes, t.avisos, serie) };
};

describe('a faixa única do topo', () => {
  const faixa = (r: ClosedLoopResponse, periodo: 'hoje' | '7' | '30' = '7') => {
    const t = tela(r, periodo);
    return faixaDe(r, t.base, t.fontes, t.avisos);
  };

  it('com tudo em dia, uma linha discreta, só no modo simples', () => {
    expect(faixa(base7())).toMatchObject({ tom: 'ok', titulo: 'Números em dia.', texto: 'Caixa lido hoje, 14:05.', acao: null, soNoSimples: true });
  });

  it('falta conectar: o caixa da loja primeiro, depois a conta de anúncios, com o caminho para Contas conectadas', () => {
    expect(faixa(piloto())).toMatchObject({ tom: 'acao', titulo: 'Falta o caixa da loja.', texto: 'Conecte o Regem para ver o que virou pedido.', acao: { rotulo: 'Abrir Contas conectadas', principal: true }, soNoSimples: false });
    const semMidia = base7();
    semMidia.sources = [fonte('regem')];
    expect(faixa(semMidia)).toMatchObject({ tom: 'acao', titulo: 'Falta a conta de anúncios.', acao: { principal: true } });
  });

  it('uma fonte sem leitura nova: até que hora os números valem', () => {
    const r = base7();
    r.sources = [fonte('google_ads'), fonte('meta_ads'), fonte('regem', { freshness: 'delayed', last_success_at: '2026-09-29T12:42:00.000Z' })];
    expect(faixa(r)).toMatchObject({ tom: 'atencao', titulo: 'Caixa até 09:42.', texto: 'Regem sem leitura nova.', acao: { rotulo: 'Ver a conexão', principal: false }, soNoSimples: false });
  });

  it('três fontes paradas viram uma faixa só, com a leitura mais antiga', () => {
    const r = base7();
    r.sources = [
      fonte('google_ads', { freshness: 'stale', last_success_at: '2026-09-26T09:20:00.000Z' }),
      fonte('meta_ads', { freshness: 'stale', last_success_at: '2026-09-27T09:12:00.000Z' }),
      fonte('regem', { freshness: 'delayed', last_success_at: '2026-09-29T02:48:00.000Z' }),
    ];
    const f = faixa(r);
    expect(f.titulo).toBe('Números até 26/09.');
    expect(f.texto).toBe('Google Ads, Meta Ads e Regem sem leitura nova.');
    expect(f.nota).toBe('O Liame tenta ler de novo sozinho. Se continuar parado, confira a conexão.');
  });

  it('conta desconectada: a conexão precisa de atenção; a de ontem diz "ontem"', () => {
    const r = base7();
    r.sources = [fonte('google_ads'), fonte('meta_ads', { status: 'desconectada', freshness: 'stale', last_success_at: '2026-09-28T09:12:00.000Z' }), fonte('regem', { freshness: 'delayed', last_success_at: '2026-09-29T12:42:00.000Z' })];
    const f = faixa(r);
    expect(f.titulo).toBe('Números até ontem, 06:12.');
    expect(f.texto).toBe('Meta Ads: a conexão precisa de atenção. Regem sem leitura nova.');
  });

  it('conta de anúncio em outro fuso: aviso curto, só no modo simples, com a explicação nos detalhes', () => {
    const r = base7();
    r.sources = [fonte('google_ads'), fonte('meta_ads', { timezone: 'America/Los_Angeles' }), fonte('regem')];
    const f = faixa(r);
    expect(f).toMatchObject({ tom: 'atencao', titulo: 'A conta da Meta fecha o dia em outro fuso.', texto: 'Em “Hoje”, o gasto e os pedidos não caem no mesmo dia.', soNoSimples: true });
    expect(f.nota).toContain('cada dia de gasto da Meta vai das 04:00 às 03:59 no horário da loja');
  });

  it('fonte que ainda não foi lida não é atraso', () => {
    const r = base7();
    r.sources = [fonte('google_ads'), fonte('meta_ads', { last_success_at: null, freshness: 'unknown' }), fonte('regem')];
    expect(faixa(r)).toMatchObject({ tom: 'ok', titulo: 'Primeira leitura a caminho.', texto: 'Meta Ads ainda sem leitura.' });
  });
});

describe('o número principal: quanto voltou para cada R$ 1', () => {
  it('7 dias: o valor em reais, o selo do período, as duas barras na mesma régua e a marca do empate', () => {
    const { g } = graficos(comCusto(), '7', semana());
    const r = g.retorno;
    expect(r.titulo).toBe('Retorno dos anúncios · últimos 7 dias');
    expect(sp(r.valor)).toBe('R$ 2,91');
    expect(r.selo).toEqual({ rotulo: 'Empatou', classe: 'atencao' });
    expect(textoDe(r.sub)).toBe('de volta para cada R$ 1 em anúncio');
    // Margem conhecida de R$ 1.298,71 em R$ 3.605,00 vendidos: o anúncio se paga a partir de R$ 2,78 por real.
    expect(sp(r.par!.empate!.valor)).toBe('R$ 2,78');
    expect(r.par!.linhas.map((l) => [l.rotulo, sp(l.valor), l.barra?.tom, l.barra?.largura])).toEqual([
      ['Você pôs', 'R$ 1', 'gasto', 34.36],
      ['Voltou', 'R$ 2,91', 'foco', 100],
    ]);
    expect(r.par!.empate!.posicao).toBe(95.53);
    expect(sp(r.par!.rotulo)).toBe('Para cada 1 real em anúncio, voltaram R$ 2,91 em vendas confirmadas no caixa. O anúncio se paga a partir de R$ 2,78.');
    expect(sp(r.par!.linhas[1].barra!.dica)).toBe('R$ 3.605,00|em vendas confirmadas no caixa · 55 pedidos');
  });

  it('a variação compara com o período anterior de mesmo tamanho: a mais, a menos, igual ou nada', () => {
    const variacao = (anterior: string | null) => graficos(comCusto(), '7', semana(anterior)).g.retorno.variacao;
    expect(variacao('2.65')).toMatchObject({ sentido: 'sobe' });
    expect(sp(textoDe(variacao('2.65')!.frase))).toBe('R$ 0,26 a mais que nos 7 dias anteriores (R$ 2,65)');
    expect(sp(textoDe(variacao('3.40')!.frase))).toBe('R$ 0,49 a menos que nos 7 dias anteriores (R$ 3,40)');
    expect(variacao('3.40')!.sentido).toBe('cai');
    expect(variacao('2.91')).toEqual({ sentido: 'igual', frase: [{ t: 'Igual ao que voltou nos 7 dias anteriores.' }] });
    // Sem gasto no período anterior não há retorno para comparar; e sem a série, nada se afirma.
    expect(variacao(null)).toBeNull();
    expect(graficos(comCusto()).g.retorno.variacao).toBeNull();
  });

  it('prejuízo: a barra do que voltou não chega na marca do empate', () => {
    const r = graficos(prejuizo()).g.retorno;
    expect(r.selo).toEqual({ rotulo: 'Deu prejuízo', classe: 'ruim' });
    expect(sp(r.valor)).toBe('R$ 1,72');
    expect(sp(r.par!.empate!.valor)).toBe('R$ 2,52');
    expect(r.par!.empate!.posicao).toBe(100);
    expect(r.par!.linhas[1].barra!.largura).toBe(68.25);
  });

  it('margem incompleta: o número aparece, mas sem a marca do empate', () => {
    const parcial = base7();
    parcial.totals.confirmed = { ...parcial.totals.confirmed, margin_known_micros: micros('410.00'), margin_coverage_pct: '62.0', verdict: null };
    const r = graficos(parcial).g.retorno;
    expect(r.selo).toEqual({ rotulo: 'Margem incompleta', classe: 'incompleta' });
    expect(r.par!.empate).toBeNull();
    expect(r.par!.linhas[1].barra!.largura).toBe(100);
  });

  it('"Hoje": as vendas até agora; o que você pôs sai amanhã', () => {
    const r = graficos(hoje(), 'hoje').g.retorno;
    expect(r.titulo).toBe('Vendas dos anúncios · hoje');
    expect(sp(r.valor)).toBe('R$ 268');
    expect(r.selo).toEqual({ rotulo: 'O retorno sai amanhã', classe: 'neutro' });
    expect(textoDe(r.sub)).toBe('em 4 pedidos que vieram de anúncios, até 14:20');
    expect(r.par!.linhas[0]).toEqual({ rotulo: 'Você pôs', valor: '—', barra: null, vazio: 'sai amanhã, com o gasto do dia' });
    expect(r.par!.linhas[1].barra).toMatchObject({ largura: 100, tom: 'foco' });
    expect(r.par!.empate).toBeNull();
    expect(r.variacao).toBeNull();
    expect(r.dias).toBeNull();
  });

  it('sem o Regem: o que foi investido, e o que voltou pedindo o caixa', () => {
    const r = graficos(piloto()).g.retorno;
    expect(sp(r.valor)).toBe('R$ 719');
    expect(textoDe(r.sub)).toBe('investidos em anúncios. Quanto voltou, só o caixa da loja diz.');
    expect(r.par!.linhas[0].barra).toMatchObject({ largura: 100, tom: 'gasto' });
    expect(r.par!.linhas[1]).toMatchObject({ valor: '—', barra: null, vazio: 'conecte o Regem para ver' });
    expect(r.selo).toBeNull();
  });

  it('sem pedido, sem mídia, sem prova de anúncio e sem gasto: nada de número inventado', () => {
    const vazio = hoje();
    vazio.totals = { ...vazio.totals, orders_confirmed: 0, revenue_micros: '0', confirmed: confirmado({ roas: '0.00' }), without_origin: { orders: 0, revenue_micros: '0', share_pct: null }, no_click_channels: [] };
    expect(graficos(vazio, 'hoje').g.retorno).toMatchObject({ valor: '—', vazio: true, par: null });
    expect(textoDe(graficos(vazio, 'hoje').g.retorno.sub)).toBe('Nenhum pedido confirmado hoje, até agora. Quando entrar pedido, ele aparece aqui.');

    const semMidia = base7();
    semMidia.sources = [fonte('regem')];
    semMidia.platforms = [];
    semMidia.campaigns = [];
    semMidia.totals = { ...semMidia.totals, spend_micros: '0', confirmed: confirmado() };
    expect(textoDe(graficos(semMidia).g.retorno.sub)).toBe('Falta a conta de anúncios para saber quanto eles custaram e quanto voltou.');

    // Houve gasto e pedido, mas nenhum com prova de anúncio: voltou R$ 0,00, e isso é informação.
    const semProva = base7();
    semProva.totals.confirmed = confirmado({ roas: '0.00' });
    const r = graficos(semProva).g.retorno;
    expect(sp(r.valor)).toBe('R$ 0,00');
    expect(textoDe(r.sub)).toBe('Nenhum pedido com prova de anúncio no período.');
    expect(r.par!.linhas.map((l) => l.barra!.largura)).toEqual([100, 0]);
    expect(r.selo).toBeNull();

    const semGasto = base7();
    semGasto.totals = { ...semGasto.totals, spend_micros: '0', confirmed: { ...semGasto.totals.confirmed, roas: null, verdict: null } };
    expect(sp(textoDe(graficos(semGasto).g.retorno.sub))).toBe('Sem gasto com anúncios no período. As vendas com prova de anúncio somam R$ 3.605,00.');
  });
});

describe('o gráfico dos dias', () => {
  const base = { fuso: 'America/Sao_Paulo', agora: new Date(AGORA) };

  it('7 dias: um ponto por dia, o dia da semana embaixo e o último dia como "ontem"', () => {
    const d = diasDe(semana(), base)!;
    expect(d.fino).toBe(false);
    expect(d.dias.map((x) => x.x)).toEqual([0, 16.67, 33.33, 50, 66.67, 83.33, 100]);
    // A maior venda (sexta, R$ 690) fica a 8% do topo; o gasto usa a mesma escala em reais.
    expect(d.dias[3]).toMatchObject({ y: 8, altura: 26 });
    expect(sp(d.dias[3]!.dica)).toBe('sex, 25/09|vendas R$ 690 · anúncios R$ 195');
    expect(d.marcas.map((m) => m.texto)).toEqual(['ter', 'qua', 'qui', 'sex', 'sáb', 'dom', 'seg']);
    expect({ ...d.ultimo, valor: sp(d.ultimo.valor) }).toEqual({ valor: 'R$ 465', quando: 'ontem', y: 38 });
    expect(d.linha.startsWith('M0 49.33 L16.67 44 L')).toBe(true);
    expect(d.area.startsWith('M0 100 L0 49.33 L')).toBe(true);
    expect(d.area.endsWith('L100 38 L100 100 Z')).toBe(true);
    expect(sp(d.rotulo)).toBe(
      'Vendas dos anúncios e gasto com anúncios por dia, de 22/09 a 28/09. O melhor dia foi sex, 25/09, com R$ 690 em vendas. O último dia teve R$ 465 em vendas e R$ 160 em anúncios.',
    );
  });

  it('30 dias: colunas finas e cinco datas embaixo', () => {
    const dias = Array.from({ length: 30 }, (_, i) => {
      const dia = new Date(Date.UTC(2026, 7, 30 + i)).toISOString().slice(0, 10);
      return { date: dia, spend_micros: micros('40.00'), orders: 3, revenue_micros: micros(`${100 + i}.00`) };
    });
    const d = diasDe({ ...semana(), days: dias, period: { from: dias[0]!.date, to: dias[29]!.date, timezone: 'America/Sao_Paulo' } }, base)!;
    expect(d.fino).toBe(true);
    expect(d.marcas.map((m) => m.texto)).toEqual(['30/08', '06/09', '14/09', '21/09', '28/09']);
    expect(d.dias).toHaveLength(30);
  });

  it('um dia só, ou um período sem venda e sem gasto, não tem o que desenhar; último dia que não é ontem leva a data', () => {
    expect(diasDe(null, base)).toBeNull();
    expect(diasDe({ ...semana(), days: semana().days.slice(0, 1) }, base)).toBeNull();
    expect(diasDe({ ...semana(), days: semana().days.map((d) => ({ ...d, spend_micros: '0', revenue_micros: '0' })) }, base)).toBeNull();
    expect(diasDe(semana(), { fuso: 'America/Sao_Paulo', agora: new Date('2026-10-02T15:00:00.000Z') })!.ultimo.quando).toBe('em 28/09');
  });

  it('entra no cartão do número só com pedido de anúncio e retorno calculado', () => {
    expect(graficos(comCusto(), '7', semana()).g.retorno.dias).not.toBeNull();
    expect(graficos(piloto(), '7', semana()).g.retorno.dias).toBeNull();
  });
});

describe('para onde foi cada real vendido', () => {
  it('custo dos produtos, itens sem custo, anúncios e o que sobrou: as partes somam o que foi vendido', () => {
    const real = graficos(comCusto()).g.real;
    expect(real.tipo).toBe('barra');
    if (real.tipo !== 'barra') return;
    expect(real.barra.partes.map((p) => [p.classe, sp(p.valor), p.rotulo, p.peso])).toEqual([
      ['c2', 'R$ 1.766', 'custo dos produtos', 176554],
      ['semcusto', 'R$ 541', 'em itens sem custo no Regem', 54075],
      ['c1', 'R$ 1.240', 'anúncios', 124000],
      ['foco', 'R$ 59', 'sobrou', 5871],
    ]);
    expect(real.barra.partes.reduce((s, p) => s + p.peso, 0)).toBe(360500);
    expect(real.barra.marca).toBeNull();
    expect(sp(textoDe(real.frase))).toBe('De R$ 3.605 vendidos em 55 pedidos, sobraram R$ 59. O anúncio se pagou, por pouco.');
    expect(sp(real.barra.partes[0]!.dica)).toBe('R$ 1.765,54|custo dos produtos · 49% do que foi vendido');
    expect(sp(real.barra.rotulo)).toBe('Dos R$ 3.605,00 vendidos: R$ 1.766 de custo dos produtos, R$ 541 em itens sem custo no Regem, R$ 1.240 de anúncios e R$ 59 que sobraram.');
  });

  it('prejuízo: os anúncios vão até onde a margem cobre, e o que faltou passa da marca do vendido', () => {
    const real = realDe(prejuizo(), tela(prejuizo()).base);
    if (real.tipo !== 'barra') throw new Error('esperava a barra');
    expect(real.barra.partes.map((p) => [p.classe, sp(p.valor), p.peso])).toEqual([
      ['c2', 'R$ 1.161', 116099],
      ['semcusto', 'R$ 122', 12171],
      ['c1', 'R$ 1.240', 84630],
      ['falta', 'R$ 394', 39370],
    ]);
    // As três primeiras partes somam o que foi vendido; a marca fica entre os anúncios e o "faltou".
    expect(116099 + 12171 + 84630).toBe(212900);
    expect({ ...real.barra.marca!, texto: sp(real.barra.marca!.texto) }).toEqual({ posicao: 0.8439, antes: 3, texto: 'vendido: R$ 2.129' });
    expect(sp(textoDe(real.frase))).toBe('De R$ 2.129 vendidos em 32 pedidos, faltaram R$ 394 para pagar os anúncios.');
  });

  it('com menos de 80% das vendas com custo, a barra é a da cobertura, com a marca dos 80%', () => {
    const parcial = base7();
    parcial.totals.confirmed = { ...parcial.totals.confirmed, margin_known_micros: micros('410.00'), margin_coverage_pct: '62.0', revenue_with_margin_micros: micros('2235.10'), verdict: null };
    const real = realDe(parcial, tela(parcial).base);
    if (real.tipo !== 'barra') throw new Error('esperava a barra');
    expect(real.barra.partes.map((p) => [p.classe, sp(p.valor), p.rotulo])).toEqual([
      ['foco', '62%', 'das vendas com custo no Regem'],
      ['semcusto', 'R$ 1.370', 'em itens sem custo'],
    ]);
    expect(real.barra.marca).toEqual({ posicao: 0.8, antes: 0, texto: 'precisa de 80%' });
    expect(textoDe(real.frase)).toBe('Ainda não dá para dizer se sobrou. Falta o custo de alguns itens no Regem.');

    // Sem custo nenhum (o token do piloto sem custos.ler): só a parte hachurada.
    const semCusto = base7();
    semCusto.totals.confirmed = { ...semCusto.totals.confirmed, margin_known_micros: null, margin_coverage_pct: '0.0', revenue_with_margin_micros: '0', verdict: null };
    const zero = realDe(semCusto, tela(semCusto).base);
    if (zero.tipo !== 'barra') throw new Error('esperava a barra');
    expect(zero.barra.partes.map((p) => p.classe)).toEqual(['semcusto']);
  });

  it('resposta guardada de antes, sem a receita de custo conhecido: a parte sai da porcentagem', () => {
    const real = realDe(base7(), tela(base7()).base);
    if (real.tipo !== 'barra') throw new Error('esperava a barra');
    // 85,0% de R$ 3.605,00 = R$ 3.064,25: os mesmos valores da rota.
    expect(real.barra.partes.map((p) => p.peso)).toEqual([176554, 54075, 124000, 5871]);
  });

  it('quando não dá para dividir, um traço vazio e o porquê', () => {
    const frase = (r: ClosedLoopResponse, periodo: 'hoje' | '7' = '7') => {
      const real = realDe(r, tela(r, periodo).base);
      return real.tipo === 'vago' ? textoDe(real.frase) : 'barra';
    };
    expect(frase(piloto())).toBe('Precisa do caixa da loja. É o Regem que diz quanto custou cada produto vendido.');
    expect(frase(hoje(), 'hoje')).toBe('Fecha amanhã, com o gasto do dia.');
    const semProva = base7();
    semProva.totals.confirmed = confirmado({ roas: '0.00' });
    expect(frase(semProva)).toBe('Nenhum pedido com prova de anúncio no período.');
    const semGasto = base7();
    semGasto.totals = { ...semGasto.totals, spend_micros: '0' };
    expect(frase(semGasto)).toBe('Sem gasto com anúncios no período.');
  });
});

describe('cada campanha, depois de pagar o anúncio', () => {
  it('sobrou para a direita e faltou para a esquerda, na mesma régua, com o selo em palavra', () => {
    const c = campanhasLiteDe(base7(), tela(base7()).base);
    expect(c).toMatchObject({ titulo: 'Cada campanha, depois de pagar o anúncio', modo: 'sobra', temFalta: true, temSobra: true });
    // Sobrou R$ 269,10 no máximo e faltou R$ 104,30 no máximo: o zero fica a 27,93% da régua.
    expect(c.zero).toBe(27.93);
    expect(c.linhas.map((l) => [l.nome, l.sub, l.barra.tipo, 'valor' in l.barra ? sp(l.barra.valor) : l.barra.texto, l.selo?.rotulo ?? null])).toEqual([
      ['Combo sexta', 'Meta Ads · ativa', 'ganho', '+ R$ 269', 'Dá lucro'],
      ['Busca “hambúrguer perto”', 'Google Ads · ativa', 'perda', '− R$ 104', 'Dá prejuízo'],
      ['Smash em dobro', 'Meta Ads · ativa', 'perda', '− R$ 54', 'Dá prejuízo'],
      ['Delivery noite', 'Meta Ads · pausada', 'semcusto', 'só 60% com custo', 'Margem incompleta'],
    ]);
    const largura = (i: number) => (c.linhas[i]!.barra as { largura: number }).largura;
    // A maior sobra enche o lado direito e a maior falta, o esquerdo; as outras guardam a proporção.
    expect(c.zero + largura(0)).toBeLessThanOrEqual(100);
    expect(largura(0)).toBeCloseTo(72.06, 1);
    expect(largura(1)).toBeCloseTo(27.93, 1);
    expect(largura(1) / largura(2)).toBeCloseTo(10430 / 5360, 1);
    expect(sp(c.linhas[0]!.rotulo)).toBe('Combo sexta: sobraram R$ 269,10 depois de pagar o anúncio');
    expect(sp(c.linhas[0]!.barra.dica)).toBe('Sobraram R$ 269,10|R$ 1 virou R$ 4,32 · 27 pedidos');
  });

  it('campanha sem pedido não ganha barra de prejuízo: mostra o que gastou', () => {
    const r = base7();
    r.campaigns[3] = { ...r.campaigns[3]!, confirmed: confirmado({ roas: '0.00' }) };
    const linha = campanhasLiteDe(r, tela(r).base).linhas[3]!;
    expect(linha.barra.tipo).toBe('neutro');
    expect('texto' in linha.barra && sp(linha.barra.texto)).toBe('gastou R$ 153');
    expect(linha.selo).toEqual({ rotulo: 'Sem pedido', classe: 'neutro' });
  });

  it('só sobra ou só falta: o zero vai para a ponta certa', () => {
    const soSobra = base7();
    soSobra.campaigns = [soSobra.campaigns[0]!];
    expect(campanhasLiteDe(soSobra, tela(soSobra).base)).toMatchObject({ zero: 0, temFalta: false, temSobra: true });
    const soFalta = base7();
    soFalta.campaigns = [soFalta.campaigns[1]!, soFalta.campaigns[2]!];
    const c = campanhasLiteDe(soFalta, tela(soFalta).base);
    expect(c).toMatchObject({ zero: 60, temFalta: true, temSobra: false });
    expect((c.linhas[0]!.barra as { largura: number }).largura).toBe(60);
  });

  it('"Hoje" conta os pedidos; sem o Regem, o gasto', () => {
    const h = campanhasLiteDe(hoje(), tela(hoje(), 'hoje').base);
    expect(h).toMatchObject({ titulo: 'Pedidos de hoje, por campanha', modo: 'tamanho' });
    expect(h.linhas.map((l) => [l.barra.tipo, 'largura' in l.barra ? l.barra.largura : null, 'valor' in l.barra ? l.barra.valor : null, l.selo])).toEqual([
      ['tamanho', 100, '27 pedidos', null],
      ['tamanho', 44.44, '12 pedidos', null],
      ['tamanho', 33.33, '9 pedidos', null],
      ['tamanho', 11.11, '3 pedidos', null],
    ]);
    const p = campanhasLiteDe(piloto(), tela(piloto()).base);
    expect(p.titulo).toBe('Quanto cada campanha gastou');
    expect(p.linhas.map((l) => ['largura' in l.barra ? l.barra.largura : null, 'valor' in l.barra ? sp(l.barra.valor) : null])).toEqual([
      [100, 'R$ 580,00'],
      [10.82, 'R$ 62,77'],
    ]);
  });
});

describe('das conversas ao pedido e a origem dos pedidos', () => {
  it('campanha de mensagem: os pedidos dentro das conversas abertas pelo anúncio', () => {
    const linhas = conversasDe(base7(), tela(base7()).base);
    expect(linhas.map((l) => [l.nome, l.plataforma, l.largura, l.fatia, sp(textoDe(l.frase))])).toEqual([
      ['Smash em dobro', 'Meta Ads', 100, 6.38, '9 de 141 conversas viraram pedido · R$ 1,98 por conversa · R$ 31,09 por pedido'],
    ]);
    expect(linhas[0]!.dicaPedidos).toBe('9 pedidos|6% das conversas');
    expect(conversasDe(hoje(), tela(hoje(), 'hoje').base)).toEqual([]);
    expect(conversasDe(piloto(), tela(piloto()).base)).toEqual([]);
  });

  it('a origem numa barra só: as três partes somam todos os pedidos da loja', () => {
    const o = origemLiteDe(base7(), tela(base7()).base)!;
    expect(o.titulo).toBe('De onde vieram os 412 pedidos');
    expect(o.barra.partes.map((p) => [p.classe, p.valor, p.rotulo, p.peso])).toEqual([
      ['foco', '55', 'de anúncios, com prova', 55],
      ['c1', '311', 'de aplicativos de entrega, balcão e outros canais sem clique', 311],
      ['c2', '46', 'do cardápio e do WhatsApp, sem prova de anúncio', 46],
    ]);
    expect(o.barra.partes[0]!.dica).toBe('55 pedidos|de anúncios, com prova · 13%');
    expect(textoDe(o.cancelados)).toBe('Mais 2 pedidos cancelados depois, fora da conta.');
    expect(origemLiteDe(piloto(), tela(piloto()).base)).toBeNull();
  });
});

describe('desenho do modo simples (o mesmo componente do navegador)', () => {
  const desenhar = (r: ClosedLoopResponse, periodo: 'hoje' | '7' | '30', modo: 'lite' | 'pro', serie: DailyResultsResponse | null = null) => {
    const { t, g } = graficos(r, periodo, serie);
    return renderToStaticMarkup(
      createElement(ModoProvider, {
        inicial: modo,
        children: createElement(ResultadosConteudo, { tela: t, graficos: g, modelo: r.model, consulta: { brand_id: uuid(900), from: r.period.from, to: r.period.to }, loja: 'Loja Centro', podeVerContas: true, reserva: { current: null } }),
      }),
    );
  };

  it('7 dias no modo simples: cada cartão com o desenho dele, o valor escrito ao lado e o rótulo para o leitor de tela', () => {
    const html = sp(desenhar(comCusto(), '7', 'lite', semana()));
    expect(html).not.toMatch(/NaN|undefined|\[object Object\]|Infinity|>null</);
    expect(html).toContain('<b>Números em dia.</b> Caixa lido hoje, 14:05.');
    expect(html).toContain('Retorno dos anúncios · últimos 7 dias');
    expect(html).toContain('<p class="heroi-valor num">R$ 2,91</p><span class="veredito veredito--atencao">Empatou</span>');
    expect(html).toContain('role="img" aria-label="Para cada 1 real em anúncio, voltaram R$ 2,91 em vendas confirmadas no caixa. O anúncio se paga a partir de R$ 2,78."');
    expect(html).toContain('Empata em <b>R$ 2,78</b>: é o que paga o produto e o anúncio.');
    expect(html).toContain('<b>R$ 0,26 a mais</b> que nos 7 dias anteriores (R$ 2,65)');
    expect(html).toContain('class="faisca" role="img" tabindex="0" aria-label="Vendas dos anúncios e gasto com anúncios por dia, de 22/09 a 28/09.');
    expect(html).toContain('Para onde foi cada real vendido');
    expect(html).toContain('<b>R$ 1.766</b>custo dos produtos');
    expect(html).toContain('Cada campanha, depois de pagar o anúncio');
    expect(html).toContain('aria-label="Busca “hambúrguer perto”: faltaram R$ 104,30 depois de pagar o anúncio"');
    expect(html).toContain('Das conversas ao pedido');
    expect(html).toContain('De onde vieram os 412 pedidos');
    // A dica é só para o ponteiro: não entra na ordem do teclado nem na leitura.
    expect(html).toContain('<div class="dica-desenho" hidden="" aria-hidden="true"></div>');
    // As faixas do Pro e as frases do modo simples antigo não aparecem.
    expect(html).not.toContain('class="faixa');
    expect(html).not.toContain('Para cada R$ 1 em anúncio, voltaram');
    expect(html).not.toContain('ROAS confirmado no caixa · últimos 7 dias');
    // "Ver detalhes" continua em cada cartão, com o Pro escondido.
    expect(html.match(/class="detalhes-bt"/g)).toHaveLength(6);
    expect(html).toMatch(/id="frescor-det" hidden=""/);
  });

  it('o Pro não muda: o ROAS, os oito números e as tabelas, sem os desenhos do modo simples', () => {
    const html = sp(desenhar(comCusto(), '7', 'pro', semana()));
    expect(html).toContain('ROAS confirmado no caixa · últimos 7 dias');
    expect(html).toContain('<p class="hero-num num">2,9×</p>');
    expect(html).toContain('Do anúncio ao caixa');
    expect(html).toContain('Por campanha');
    expect(html).toContain('Campanha de mensagem · conversa × pedido');
    for (const classe of ['heroi-grade', 'pilha', 'camp-b', 'funil', 'frescor', 'faisca']) expect(html).not.toContain(`class="${classe}`);
    expect(html).not.toContain('Das conversas ao pedido');
  });

  it('fonte parada aparece nos dois modos como a faixa única; no modo simples, "Ver detalhes" lista as fontes', () => {
    const r = comCusto();
    r.sources = [fonte('google_ads'), fonte('meta_ads'), fonte('regem', { freshness: 'delayed', last_success_at: '2026-09-29T12:42:00.000Z' })];
    for (const modo of ['lite', 'pro'] as const) {
      const html = desenhar(r, '7', modo);
      expect(html).toContain('<div class="frescor frescor--atencao"><div class="frescor-linha" role="status">');
      expect(html).toContain('<b>Caixa até 09:42.</b> Regem sem leitura nova.');
      expect(html).toContain('<a class="btn btn--sm" href="/contas">Ver a conexão</a>');
    }
    expect(desenhar(r, '7', 'lite')).toContain('aria-controls="frescor-det"');
    expect(desenhar(r, '7', 'pro')).not.toContain('aria-controls="frescor-det"');
  });

  it('prejuízo e sem o Regem desenhados', () => {
    const p = sp(desenhar(prejuizo(), '7', 'lite'));
    expect(p).toContain('<span class="veredito veredito--ruim">Deu prejuízo</span>');
    expect(p).toContain('<span>vendido: R$ 2.129</span>');
    expect(p).toContain('class="cor-falta"');
    const s = sp(desenhar(piloto(), '7', 'lite'));
    expect(s).toContain('<div class="trilho trilho--vazio">conecte o Regem para ver</div>');
    expect(s).toContain('Quanto cada campanha gastou');
    expect(s).toContain('<div class="pilha pilha--vazia" aria-hidden="true"></div>');
  });
});
