import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { WeeklyReview, WeeklyReviewChange } from '@liame/contracts';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { campanhasDaRevisao, mudancaDesenhada, numerosDaRevisao } from '@/components/revisao/graficos';
import { RevisaoConteudo } from '@/components/revisao/revisao-conteudo';
import {
  avisoDaLeitura,
  destinoDaDecisao,
  diaEscrito,
  envioDaRevisao,
  introDaRevisao,
  momentoEscrito,
  mudancaDe,
  razao,
  semanaEscrita,
  valorDe,
  variacao,
  vereditoDaSemana,
} from '@/components/revisao/textos';
import { temModos, tituloDa } from '@/components/shell/navegacao';
import { AvisosProvider } from '@/components/ui/avisos';

// "Revisão da semana" (A3 · I7; mockups/prototipo-explicar.html, P4; em gráficos desde 07/10/2026,
// mockups/prototipo-revisao-graficos.html): as regras de escrita da tela, os desenhos e a tela
// desenhada pelo mesmo componente do navegador. A revisão do teste é o arquivo que o servidor usa para
// provar o que ele guarda no banco: a tela desenha exatamente o que está guardado.

const FUSO = 'America/Sao_Paulo';
const guardada = JSON.parse(readFileSync(resolve(process.cwd(), '../server/test/fixtures/revisao-semanal/v1.json'), 'utf8')) as Omit<WeeklyReview, 'id' | 'email'>;
const revisao = (over: Partial<WeeklyReview> = {}): WeeklyReview => ({
  ...guardada,
  id: 'a0000000-0000-4000-8000-000000000060',
  email: { status: 'enviado', sent_at: '2026-09-28T10:00:00.000Z', recipients: 3 },
  ...over,
});
const doSistema = (reason: string, extra: Partial<WeeklyReview['reading']> = {}): WeeklyReview['reading'] => ({ ...guardada.reading, source: 'sistema', reason, usage_id: null, ...extra });
const mudanca = (m: Partial<WeeklyReviewChange>): WeeklyReviewChange => ({ kind: 'pedidos_de_anuncios', campaign: null, unit: 'contagem', before: '47', now: '53', change_pct: '+12.8', ...m });
const tudoPode = () => true;
/** O dinheiro da tela usa o espaço fixo depois do "R$" (o mesmo do `Intl`): a tela não quebra o valor no meio. */
const nbsp = (s: string) => s.replaceAll('R$ ', `R$${String.fromCharCode(160)}`);
const desenhar = (r: WeeklyReview, pode: (p: string) => boolean = tudoPode) =>
  renderToStaticMarkup(createElement(AvisosProvider, { children: createElement(RevisaoConteudo, { revisao: r, podeVerContas: pode('contas.ver'), pode }) }));

describe('revisão da semana: como a tela escreve o que a API manda', () => {
  it('valores pela unidade: dinheiro em reais, contagem com milhar e ROAS com duas casas', () => {
    expect(razao('2.86')).toBe('2,86');
    expect(razao(null)).toBe('—');
    expect(variacao('+12.8')).toBe('+12,8%');
    expect(variacao('0.0')).toBe('0,0%');
    expect(variacao(null)).toBeNull();
    expect(valorDe(mudanca({ unit: 'dinheiro', now: '3471000000' }), 'now')).toBe(nbsp('R$ 3.471,00'));
    expect(valorDe(mudanca({ now: '1250' }), 'now')).toBe('1.250');
    expect(valorDe(mudanca({ unit: 'razao', now: '2.86' }), 'now')).toBe('2,86');
    expect(valorDe(mudanca({ before: null }), 'before')).toBe('—');
  });

  it('os quatro números do topo: o valor, a barra desta semana com a marca da anterior, quanto mudou e o valor de antes', () => {
    const [investido, pedidos, receita, roas] = numerosDaRevisao(revisao());
    expect([investido, pedidos, receita, roas].map((k) => [k!.id, k!.rotulo, k!.valor, k!.anterior])).toEqual([
      ['investimento', 'Investido em anúncios', nbsp('R$ 1.214,30'), nbsp('R$ 1.180,00')],
      ['pedidos_de_anuncios', 'Pedidos de anúncios', '53', '47'],
      ['receita_confirmada', 'Receita confirmada no caixa', nbsp('R$ 3.471,00'), nbsp('R$ 3.068,00')],
      ['roas_confirmado', 'ROAS confirmado no caixa', '2,86', '2,60'],
    ]);
    // Gastar mais não é bom nem ruim; vender mais é bom; no ROAS a revisão mostra só os dois valores, e a tela diz se subiu.
    expect(investido!.mudou).toEqual({ texto: '2,9% a mais', tom: 'neutro', seta: 'sobe' });
    expect(pedidos!.mudou).toEqual({ texto: '12,8% a mais', tom: 'bom', seta: 'sobe' });
    expect(receita!.mudou).toEqual({ texto: '13,1% a mais', tom: 'bom', seta: 'sobe' });
    expect(roas!.mudou).toEqual({ texto: 'subiu', tom: 'bom', seta: 'sobe' });
    // A barra: esta semana é a régua inteira (era maior), e a marca fica onde estava a semana anterior. A cor é a da coisa.
    expect(investido!.bala).toMatchObject({ cor: 'c1', de: 0, largura: 100, marca: 97.17, negativa: false, zero: null });
    expect(pedidos!.bala).toMatchObject({ cor: 'foco', largura: 100, marca: 88.67 });
    expect(receita!.bala).toMatchObject({ cor: 'foco', largura: 100, marca: 88.38 });
    expect(roas!.bala).toMatchObject({ cor: 'foco', largura: 100, marca: 90.9 });
    expect(pedidos!.bala!.rotulo).toBe('Pedidos de anúncios: 53 nesta semana; 47 na semana anterior.');
    expect(pedidos!.bala!.dicaAgora).toBe('53|esta semana · 21/09 a 27/09');
    expect(pedidos!.bala!.dicaAntes).toBe('47|semana anterior · 14/09 a 20/09');
  });

  it('os números do topo sem comparação, caindo, iguais, sem valor e de um tipo que a tela ainda não conhece', () => {
    const com = (m: Partial<WeeklyReviewChange>) => numerosDaRevisao({ ...revisao(), totals: [mudanca(m)] })[0]!;
    // Sem semana anterior: a barra fica, sem a marca, e não há o que dizer da mudança.
    const semAntes = numerosDaRevisao({ ...revisao(), totals: guardada.totals.map((m) => ({ ...m, before: null, change_pct: null })) });
    expect(semAntes.map((k) => [k.anterior, k.mudou, k.bala!.marca, k.bala!.dicaAntes])).toEqual(Array(4).fill([null, null, null, null]));
    expect(semAntes[1]!.bala!.rotulo).toBe('Pedidos de anúncios: 53 nesta semana.');
    // Caiu: a barra fica menor que a régua, e a marca vai para a ponta.
    const caiu = com({ before: '53', now: '47', change_pct: '-11.3' });
    expect(caiu.mudou).toEqual({ texto: '11,3% a menos', tom: 'ruim', seta: 'desce' });
    expect(caiu.bala).toMatchObject({ largura: 88.67, marca: 100 });
    expect(com({ kind: 'investimento', unit: 'dinheiro', before: '1180000000', now: '900000000', change_pct: '-23.7' }).mudou).toEqual({ texto: '23,7% a menos', tom: 'neutro', seta: 'desce' });
    // De zero para doze não tem porcentagem: diz que subiu. Igual, diz que está igual.
    expect(com({ before: '0', now: '12', change_pct: null })).toMatchObject({ anterior: '0', mudou: { texto: 'subiu', tom: 'bom', seta: 'sobe' } });
    expect(com({ before: '5', now: '5', change_pct: '0.0' }).mudou).toEqual({ texto: 'igual à semana anterior', tom: 'neutro', seta: null });
    // O ROAS sem investimento não existe: fica o travessão, sem barra.
    expect(com({ kind: 'roas_confirmado', unit: 'razao', before: '2.60', now: null, change_pct: null })).toMatchObject({ valor: '—', bala: null, mudou: null, anterior: '2,60' });
    // Tipo que a tela ainda não conhece aparece com o nome que veio, sem quebrar.
    expect(com({ kind: 'numero_novo' }).rotulo).toBe('numero novo');
  });

  it('cada campanha com o que foi investido e o que voltou no caixa, na mesma régua para todas', () => {
    const c = campanhasDaRevisao(revisao());
    expect(c.linhas.map((l) => [l.nome, l.sub, l.investido.valor, l.investido.largura, l.caixa.valor, l.caixa.largura, l.selo])).toEqual([
      ['Combo sexta', 'Meta Ads · 26 pedidos', nbsp('R$ 404,10'), 23.54, nbsp('R$ 1.716,00'), 100, { rotulo: 'Dá lucro', classe: 'bom' }],
      ['Busca perto', 'Google Ads · 12 pedidos', nbsp('R$ 386,20'), 22.5, nbsp('R$ 804,00'), 46.85, { rotulo: 'Empata', classe: 'atencao' }],
      ['Smash em dobro', 'Meta Ads · 9 pedidos', nbsp('R$ 274,00'), 15.96, nbsp('R$ 612,00'), 35.66, { rotulo: 'Empata', classe: 'atencao' }],
      ['Delivery noite', 'Meta Ads · 2 pedidos', nbsp('R$ 150,00'), 8.74, nbsp('R$ 114,00'), 6.64, { rotulo: 'Dá prejuízo', classe: 'ruim' }],
    ]);
    expect(c.linhas[0]!.rotulo).toBe(nbsp('Combo sexta: R$ 404,10 investidos e R$ 1.716,00 no caixa, em 26 pedidos.'));
    expect(c.linhas[0]!.caixa.dica).toBe(nbsp('R$ 1.716,00|confirmado no caixa · ROAS 4,25'));
    // O que só a plataforma prova não tem campanha: vira uma nota, e conta no total.
    expect(c.notas).toEqual([nbsp('Mais 4 pedidos (R$ 1.029,00) vieram da Meta sem dizer a campanha: contam no total.')]);
    expect(campanhasDaRevisao({ campaigns: [], platform_only: [{ provider: 'google_ads', orders: 1, revenue_micros: null }] }).notas).toEqual(['Mais 1 pedido veio do Google Ads sem dizer a campanha: conta no total.']);
    // Sem pedido: a barra do caixa não aparece e o selo diz "Sem pedido"; com pedido e sem veredito, "Margem incompleta".
    const semPedido = campanhasDaRevisao({ campaigns: [{ ...guardada.campaigns[0]!, orders: 0, revenue_micros: '0', roas: '0.00', verdict: null }], platform_only: [] }).linhas[0]!;
    expect(semPedido).toMatchObject({ sub: 'Meta Ads · sem pedido na semana', selo: { rotulo: 'Sem pedido', classe: 'neutro' }, caixa: { largura: 0 }, investido: { largura: 100 } });
    expect(semPedido.rotulo).toBe(nbsp('Combo sexta: R$ 404,10 investidos e nenhum pedido confirmado no caixa.'));
    expect(campanhasDaRevisao({ campaigns: [{ ...guardada.campaigns[0]!, verdict: null }], platform_only: [] }).linhas[0]!.selo).toEqual({ rotulo: 'Margem incompleta', classe: 'incompleta' });
    expect(campanhasDaRevisao({ campaigns: [], platform_only: [] })).toEqual({ linhas: [], notas: [] });
  });

  it('o que mudou, desenhado: o nome sem os dois pontos, de quanto para quanto e a barra com a marca de antes', () => {
    const r = revisao();
    expect(mudancaDesenhada(mudanca({}), r)).toMatchObject({ chave: 'pedidos_de_anuncios-', nome: 'Pedidos de anúncios', de: '47', para: '53', variacao: '+12,8%', bala: { cor: 'foco', largura: 100, marca: 88.67 } });
    const campanha = { id: 'a0000000-0000-4000-8000-000000000101', name: 'Combo sexta', provider: 'meta_ads' };
    const roas = mudancaDesenhada(mudanca({ kind: 'roas_da_campanha', campaign: campanha, unit: 'razao', before: '4.02', now: '4.25', change_pct: '+5.7' }), r);
    expect(roas).toMatchObject({ nome: 'Combo sexta: ROAS no caixa', de: '4,02', para: '4,25', variacao: null, bala: { marca: 94.58 } });
    expect(roas.bala!.rotulo).toBe('Combo sexta: ROAS no caixa: 4,25 nesta semana; 4,02 na semana anterior.');
    // O que ficou sem prova tem a cor dele (o cinza 2), e o ROAS que caiu fica menor que a marca.
    expect(mudancaDesenhada(mudanca({ kind: 'pedidos_sem_origem', before: '41', now: '44', change_pct: '+7.3' }), r)).toMatchObject({ nome: 'Pedidos sem origem', bala: { cor: 'c2' } });
    expect(mudancaDesenhada(mudanca({ kind: 'roas_da_campanha', campaign: campanha, unit: 'razao', before: '1.12', now: '0.76', change_pct: '-32.1' }), r).bala).toMatchObject({ largura: 67.85, marca: 100 });
  });

  it('melhorou e piorou: de quanto para quanto; no ROAS da campanha, só os dois valores', () => {
    expect(mudancaDe(mudanca({}))).toEqual({ chave: 'pedidos_de_anuncios-', nome: 'Pedidos de anúncios:', de: '47', para: '53', variacao: '+12,8%' });
    const campanha = { id: 'a0000000-0000-4000-8000-000000000101', name: 'Combo sexta', provider: 'meta_ads' };
    expect(mudancaDe(mudanca({ kind: 'roas_da_campanha', campaign: campanha, unit: 'razao', before: '4.02', now: '4.25', change_pct: '+5.7' }))).toEqual({
      chave: `roas_da_campanha-${campanha.id}`,
      nome: 'Combo sexta: ROAS no caixa',
      de: '4,02',
      para: '4,25',
      variacao: null,
    });
    expect(mudancaDe(mudanca({ kind: 'pedidos_sem_origem', before: '41', now: '44', change_pct: '+7.3' })).nome).toBe('Pedidos sem origem:');
  });

  it('o selo de cada campanha é o veredito do servidor; sem margem, "Margem incompleta"; sem pedido, nenhum', () => {
    expect(vereditoDaSemana('lucro', 26, '404100000')).toEqual({ rotulo: 'Dá lucro', classe: 'bom' });
    expect(vereditoDaSemana('empata', 12, '386200000')).toEqual({ rotulo: 'Empata', classe: 'atencao' });
    expect(vereditoDaSemana('prejuizo', 2, '150000000')).toEqual({ rotulo: 'Dá prejuízo', classe: 'ruim' });
    expect(vereditoDaSemana(null, 5, '100000000')).toEqual({ rotulo: 'Margem incompleta', classe: 'incompleta' });
    expect(vereditoDaSemana(null, 0, '100000000')).toBeNull();
    expect(vereditoDaSemana('veredito_novo', 5, '100000000')).toBeNull();
  });

  it('cada decisão leva à tela onde se resolve; o aviso da Atenção, só para quem abre a Atenção', () => {
    expect(destinoDaDecisao({ kind: 'prejuizo_seguido' }, tudoPode)).toEqual({ href: '/resultados', rotulo: 'Ver em Resultados' });
    expect(destinoDaDecisao({ kind: 'anuncio_sem_rastreio' }, tudoPode)).toEqual({ href: '/links', rotulo: 'Abrir Links e cupons' });
    expect(destinoDaDecisao({ kind: 'cupom_sem_uso' }, tudoPode)).toEqual({ href: '/atencao', rotulo: 'Ver na Atenção' });
    expect(destinoDaDecisao({ kind: 'aviso_novo' }, tudoPode)).toEqual({ href: '/atencao', rotulo: 'Ver na Atenção' });
    expect(destinoDaDecisao({ kind: 'cupom_sem_uso' }, (p) => p !== 'campanhas.ver')).toBeNull();
  });

  it('datas por extenso, no fuso da loja', () => {
    expect(diaEscrito('2026-09-28')).toBe('segunda-feira, 28/09');
    expect(diaEscrito('2026-10-04')).toBe('domingo, 04/10');
    // 08:10 UTC são 05:10 em Brasília.
    expect(momentoEscrito('2026-09-28T08:10:00.000Z', FUSO)).toBe('segunda-feira, 28/09, às 05:10');
    // 01:30 UTC de segunda ainda é domingo em Brasília.
    expect(momentoEscrito('2026-09-28T01:30:00.000Z', FUSO)).toBe('domingo, 27/09, às 22:30');
    expect(semanaEscrita({ from: '2026-09-21', to: '2026-09-27' })).toBe('Semana de 21/09 a 27/09');
  });

  it('a tela só fala de e-mail quando a empresa o recebe', () => {
    expect(envioDaRevisao({ status: 'enviado', sent_at: '2026-09-28T10:00:00.000Z', recipients: 3 }, FUSO)).toBe('Enviada por e-mail na segunda-feira, 28/09, às 07:00, para 3 pessoas.');
    expect(envioDaRevisao({ status: 'enviado', sent_at: '2026-09-28T10:00:00.000Z', recipients: 1 }, FUSO)).toBe('Enviada por e-mail na segunda-feira, 28/09, às 07:00, para 1 pessoa.');
    expect(envioDaRevisao({ status: 'pendente', sent_at: null, recipients: 0 }, FUSO)).toBe('O e-mail desta revisão sai a partir das 7h.');
    for (const status of ['desligado', 'sem_destinatario', 'falhou', 'expirado', 'situacao_nova']) expect(envioDaRevisao({ status, sent_at: null, recipients: 0 }, FUSO), status).toBeNull();
    expect(introDaRevisao({ status: 'enviado', sent_at: '2026-09-28T10:00:00.000Z', recipients: 3 })).toBe(
      'O que vendeu, o que cada campanha trouxe no caixa, o que mudou e o que precisa de decisão. Sai toda segunda-feira de manhã, na tela e por e-mail.',
    );
    expect(introDaRevisao({ status: 'desligado', sent_at: null, recipients: 0 })).toBe('O que vendeu, o que cada campanha trouxe no caixa, o que mudou e o que precisa de decisão. Sai toda segunda-feira de manhã.');
    expect(introDaRevisao(null)).toMatch(/Sai toda segunda-feira de manhã\.$/);
  });

  it('por que a leitura é a do sistema: com fonte atrasada, qual e desde quando; nos outros casos, que o resto está completo', () => {
    expect(avisoDaLeitura(guardada.reading)).toBeNull();
    expect(avisoDaLeitura(doSistema('desligada'))).toEqual({
      tom: 'neutro',
      icone: 'info',
      titulo: 'A revisão desta semana saiu sem a leitura da LIA',
      texto: 'Os números, as listas e o resumo abaixo são do sistema e estão completos.',
      acao: null,
    });
    expect(avisoDaLeitura(doSistema('teto'))?.titulo).toBe('A revisão desta semana saiu sem a leitura da LIA');
    expect(avisoDaLeitura(doSistema('dado_velho', { stale_sources: [{ platform: 'Meta', name: 'CA - Mister', freshness: 'atrasado', last_read: '27/09/2026 05:10' }] }))).toEqual({
      tom: 'atencao',
      icone: 'clock',
      titulo: 'A revisão saiu sem a leitura da LIA',
      texto: 'Na hora de gerar, uma fonte estava atrasada (Meta · CA - Mister, última leitura em 27/09/2026 05:10). Os números abaixo valem até essa hora.',
      acao: 'ver-conexao',
    });
    expect(avisoDaLeitura(doSistema('dado_velho'))?.texto).toBe('Na hora de gerar, uma fonte estava atrasada. Os números abaixo valem até essa hora.');
  });

  it('a trilha da tela e o seletor Lite/Pro: a revisão é uma tela só', () => {
    expect(tituloDa('/resultados/revisao')).toBe('Resultados · Revisão da semana');
    expect(tituloDa('/resultados')).toBe('Resultados');
    expect(temModos('/resultados', tudoPode)).toBe(true);
    expect(temModos('/resultados/revisao', tudoPode)).toBe(false);
  });
});

describe('revisão da semana desenhada (o mesmo componente do navegador)', () => {
  it('com a leitura da LIA: os números com a barra, o bloco fixo com a hora da geração, as campanhas desenhadas, a tabela, as mudanças e as decisões', () => {
    const html = desenhar(revisao());
    expect(html).not.toMatch(/NaN|undefined|\[object Object\]|>null</);
    expect(html).toContain('<a class="btn btn--sm btn--ghost" href="/resultados">Voltar aos Resultados</a>');
    expect(html).toContain('Enviada por e-mail na segunda-feira, 28/09, às 07:00, para 3 pessoas.');
    // Os quatro números.
    expect(html).toContain('<div class="rev-nums" role="group" aria-label="Números da semana">');
    expect(html).toContain('<p class="kpi-rot">Pedidos de anúncios</p><p class="kpi-val num">53</p><div class="bala" role="img" aria-label="Pedidos de anúncios: 53 nesta semana; 47 na semana anterior.">');
    expect(html).toContain('<span>12,8% a mais</span>');
    expect(html).toContain('<span>semana anterior: <b class="num">47</b></span>');
    // Cada número tem a barra e a marca; a legenda diz o que é cada uma.
    expect(html.match(/class="kpi"/g)).toHaveLength(4);
    expect(html.match(/<div class="kpi">.*?<div class="bala" role="img"/g)).toHaveLength(4);
    expect(html).toContain('<p class="rev-chave" aria-hidden="true">');
    expect(html.match(/class="kpi"/g)).toHaveLength(4);
    // A leitura: o mesmo bloco do Explicar, fixo (sem fechar), com o título e a hora da revisão.
    expect(html).toContain('<article class="card explica" id="exp-revisao" aria-labelledby="exp-t-revisao">');
    expect(html).toContain('<h2 id="exp-t-revisao" tabindex="-1">Leitura da semana, pela LIA</h2>');
    expect(html).toMatch(/Feito com IA<\/span><span>com os números desta revisão · gerada na segunda-feira, 28\/09, às 05:10<\/span>/);
    expect(html).not.toContain('Fechar a explicação');
    expect(html).toContain('<a class="btn btn--sm" href="/resultados">Ver os Resultados</a>');
    expect(html).toContain('role="group" aria-label="Esta explicação fez sentido?"');
    expect(html).toContain('De onde vêm os números (1)');
    // As campanhas desenhadas: o investido e o que voltou no caixa, na mesma régua, com o selo.
    expect(html).toContain('<ul class="camp-rev" aria-label="Campanhas da semana de 21/09 a 27/09">');
    expect(html).toContain(nbsp('<div class="par" role="img" aria-label="Combo sexta: R$ 404,10 investidos e R$ 1.716,00 no caixa, em 26 pedidos.">'));
    expect(html.match(/<span class="barra barra--gasto"/g)).toHaveLength(4);
    expect(html).toContain(nbsp('Mais 4 pedidos (R$ 1.029,00) vieram da Meta sem dizer a campanha: contam no total.'));
    expect(html).toContain('<b>Total:</b>');
    // A tabela inteira continua na tela, atrás de "Ver a tabela", com o que só a plataforma prova e o total.
    expect(html).toContain('<details class="rev-tabela"><summary>');
    expect(html).toContain('Ver a tabela</summary>');
    expect(html).toContain('<caption class="sr-only">Campanhas da semana de 21/09 a 27/09: investimento, pedidos, receita, ROAS confirmado no caixa e resultado</caption>');
    expect(html).toContain(
      nbsp('<th scope="row">Combo sexta<span class="camp-canal"><span class="plat plat--meta">Meta Ads</span></span></th><td class="n num">R$ 404,10</td><td class="n num">26</td><td class="n num">R$ 1.716,00</td><td class="n num forte">4,25</td><td><span class="veredito veredito--bom">Dá lucro</span></td>'),
    );
    expect(html).toContain('<span class="plat plat--google">Google Ads</span>');
    expect(html).toContain(nbsp('<tr class="linha-plat"><th scope="row">Meta · sem campanha identificada</th><td class="n">—</td><td class="n num">4</td><td class="n num">R$ 1.029,00</td><td class="n">—</td><td><span class="eixo-nota">conta no total</span></td></tr>'));
    expect(html).toContain(nbsp('<tfoot><tr><th scope="row">Total</th><td class="n num">R$ 1.214,30</td><td class="n num">53</td><td class="n num">R$ 3.471,00</td><td class="n num forte">2,86</td><td><span class="veredito veredito--atencao">Empata</span></td></tr></tfoot>'));
    // Melhorou e piorou.
    const dePara = (nome: string, de: string, para: string, variacao = '') =>
      `<span class="mud-nome">${nome}</span><span class="mud-de-para"><span class="sr-only">de </span>${de}<span aria-hidden="true"> → </span><span class="sr-only"> para </span>${para}${variacao ? `<small> ${variacao}</small>` : ''}</span>`;
    expect(html).toContain('<ul class="rev-lista rev-lista--g rev-lista--bom">');
    expect(html).toContain(dePara('Pedidos de anúncios', '47', '53', '+12,8%'));
    expect(html).toContain(dePara('Combo sexta: ROAS no caixa', '4,02', '4,25'));
    expect(html).toContain('<ul class="rev-lista rev-lista--g rev-lista--ruim">');
    expect(html).toContain(dePara('Delivery noite: ROAS no caixa', '1,12', '0,76'));
    expect(html).toContain(dePara('Pedidos sem origem', '41', '44', '+7,3%'));
    // Cada mudança tem a barra dela: quatro números, quatro que melhoraram e duas que pioraram.
    expect(html.match(/class="bala" role="img"/g)).toHaveLength(10);
    // Precisa de decisão: o que aconteceu e para onde ir (só navegação).
    expect(html).toContain('O Liame aponta; quem decide é você. Nada muda nas campanhas por aqui.');
    expect(html).toContain('<b>Delivery noite deu prejuízo nas duas últimas semanas</b>');
    expect(html).toContain('<a class="btn btn--sm" href="/resultados">Ver em Resultados</a>');
  });

  it('sem a LIA: a leitura do sistema, com o motivo da revisão, sem retorno e sem "tentar de novo"', () => {
    const html = desenhar(revisao({ reading: doSistema('desligada'), email: { status: 'desligado', sent_at: null, recipients: 0 } }));
    expect(html).toContain('<article class="card explica explica--sistema" id="exp-revisao" aria-labelledby="exp-t-revisao">');
    expect(html).toContain('<h2 id="exp-t-revisao" tabindex="-1">Leitura da semana, pelo sistema</h2>');
    expect(html).toContain('<span class="st st--espera">Sem IA</span><span>montado por regra, com os números desta revisão</span>');
    expect(html).toContain('<b>A revisão desta semana saiu sem a leitura da LIA</b>Os números, as listas e o resumo abaixo são do sistema e estão completos.');
    expect(html).not.toContain('A LIA está desligada nesta empresa');
    expect(html).not.toContain('Fez sentido');
    expect(html).not.toContain('Tentar de novo');
    // Sem o envio ligado, a tela não fala de e-mail.
    expect(html).not.toContain('rev-envio');
  });

  it('gerada com fonte atrasada: diz qual e leva à conexão (só para quem vê as contas)', () => {
    const velho = revisao({ reading: doSistema('dado_velho', { stale_sources: [{ platform: 'Meta', name: 'CA - Mister', freshness: 'atrasado', last_read: '27/09/2026 05:10' }] }) });
    const html = desenhar(velho);
    expect(html).toContain('<div class="explica-aviso" role="status">');
    expect(html).toContain('<b>A revisão saiu sem a leitura da LIA</b>Na hora de gerar, uma fonte estava atrasada (Meta · CA - Mister, última leitura em 27/09/2026 05:10). Os números abaixo valem até essa hora.');
    expect(html).toContain('<a class="btn btn--sm" href="/contas">Ver a conexão</a>');
    expect(desenhar(velho, (p) => p !== 'contas.ver')).not.toContain('Ver a conexão');
  });

  it('semana sem comparação, sem campanha e sem decisão: cada parte diz que não há, e a tabela some', () => {
    const html = desenhar(revisao({ campaigns: [], platform_only: [], improved: [], worsened: [], decisions: [] }));
    expect(html).not.toContain('t-rev-camp');
    expect(html).toContain('<p class="rev-nada">Nada mudou para melhor sobre a semana anterior.</p>');
    expect(html).toContain('<p class="rev-nada">Nada piorou sobre a semana anterior.</p>');
    expect(html).toContain('<p class="rev-nada">Nada pede decisão nesta semana.</p>');
    // Campanha sem pedido não tem selo; com gasto e sem margem, "Margem incompleta".
    const semPedido = desenhar(revisao({ campaigns: [{ ...guardada.campaigns[0]!, orders: 0, revenue_micros: '0', roas: '0.00', verdict: null }] }));
    expect(semPedido).toContain('<td><span class="eixo-nota">sem pedido na semana</span></td>');
    expect(semPedido).toContain('<span class="veredito veredito--neutro">Sem pedido</span>');
    // Sem semana anterior, cada número diz que não há com o que comparar, e a legenda da marca não aparece.
    const semAntes = desenhar(revisao({ totals: guardada.totals.map((m) => ({ ...m, before: null, change_pct: null })) }));
    expect(semAntes.match(/<p class="kpi-sub">sem semana anterior para comparar<\/p>/g)).toHaveLength(4);
    expect(semAntes).not.toContain('rev-chave');
    expect(desenhar(revisao({ campaigns: [{ ...guardada.campaigns[0]!, verdict: null }] }))).toContain('<span class="veredito veredito--incompleta">Margem incompleta</span>');
  });

  it('aviso da Atenção entre as decisões: leva à Atenção; sem acesso a ela, fica só o texto', () => {
    const aviso = { kind: 'cupom_sem_uso', severity: 'atencao', title: 'O cupom SMASH10 não teve nenhum uso em 7 dias', detail: 'Ele é o cupom exclusivo da campanha "Smash em dobro".', action: 'Confira o código.', connected_account_id: null, campaign_id: null, provider: 'meta_ads', brand_id: guardada.brand_id };
    const r = revisao({ decisions: [...guardada.decisions, aviso] });
    const html = desenhar(r);
    expect(html).toContain('<b>O cupom SMASH10 não teve nenhum uso em 7 dias</b><span>Ele é o cupom exclusivo da campanha &quot;Smash em dobro&quot;.</span></div><a class="btn btn--sm" href="/atencao">Ver na Atenção</a>');
    const semAtencao = desenhar(r, (p) => p !== 'campanhas.ver');
    expect(semAtencao).toContain('O cupom SMASH10 não teve nenhum uso em 7 dias');
    expect(semAtencao).not.toContain('Ver na Atenção');
  });
});
