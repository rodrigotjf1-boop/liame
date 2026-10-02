import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { WeeklyReview, WeeklyReviewChange } from '@liame/contracts';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { RevisaoConteudo } from '@/components/revisao/revisao-conteudo';
import {
  avisoDaLeitura,
  destinoDaDecisao,
  diaEscrito,
  envioDaRevisao,
  introDaRevisao,
  kpisDaRevisao,
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

// "Revisão da semana" (A3 · I7; mockups/prototipo-explicar.html, P4): as regras de escrita da tela e a tela
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

  it('os quatro números do topo, com a linha de baixo do protótipo; sem semana anterior, diz que não há comparação', () => {
    expect(kpisDaRevisao(revisao())).toEqual([
      { id: 'investimento', rotulo: 'Investido em anúncios', valor: nbsp('R$ 1.214,30'), sub: '+2,9% sobre a semana anterior' },
      { id: 'pedidos_de_anuncios', rotulo: 'Pedidos de anúncios', valor: '53', sub: '+12,8% · eram 47' },
      { id: 'receita_confirmada', rotulo: 'Receita confirmada no caixa', valor: nbsp('R$ 3.471,00'), sub: nbsp('+13,1% · era R$ 3.068,00') },
      { id: 'roas_confirmado', rotulo: 'ROAS confirmado no caixa', valor: '2,86', sub: 'era 2,60 na semana anterior' },
    ]);
    const semAntes = kpisDaRevisao({ totals: guardada.totals.map((m) => ({ ...m, before: null, change_pct: null })) });
    expect(semAntes.map((k) => k.sub)).toEqual(Array(4).fill('sem semana anterior para comparar'));
    // De zero para doze não tem porcentagem; um pedido só é "era".
    expect(kpisDaRevisao({ totals: [mudanca({ before: '0', now: '12', change_pct: null })] })[0]!.sub).toBe('eram 0');
    expect(kpisDaRevisao({ totals: [mudanca({ before: '1', now: '2', change_pct: '+100.0' })] })[0]!.sub).toBe('+100,0% · era 1');
    // Tipo que a tela ainda não conhece aparece com o nome que veio, sem quebrar.
    expect(kpisDaRevisao({ totals: [mudanca({ kind: 'numero_novo' })] })[0]!.rotulo).toBe('numero novo');
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
  it('com a leitura da LIA: os números, o bloco fixo com a hora da geração, a tabela, as listas e as decisões', () => {
    const html = desenhar(revisao());
    expect(html).not.toMatch(/NaN|undefined|\[object Object\]|>null</);
    expect(html).toContain('<a class="btn btn--sm btn--ghost" href="/resultados">Voltar aos Resultados</a>');
    expect(html).toContain('Enviada por e-mail na segunda-feira, 28/09, às 07:00, para 3 pessoas.');
    // Os quatro números.
    expect(html).toContain('<div class="rev-nums" role="group" aria-label="Números da semana">');
    expect(html).toContain('<p class="kpi-rot">Pedidos de anúncios</p><p class="kpi-val num">53</p><p class="kpi-sub">+12,8% · eram 47</p>');
    expect(html.match(/class="kpi"/g)).toHaveLength(4);
    // A leitura: o mesmo bloco do Explicar, fixo (sem fechar), com o título e a hora da revisão.
    expect(html).toContain('<article class="card explica" id="exp-revisao" aria-labelledby="exp-t-revisao">');
    expect(html).toContain('<h2 id="exp-t-revisao" tabindex="-1">Leitura da semana, pela LIA</h2>');
    expect(html).toMatch(/Feito com IA<\/span><span>com os números desta revisão · gerada na segunda-feira, 28\/09, às 05:10<\/span>/);
    expect(html).not.toContain('Fechar a explicação');
    expect(html).toContain('<a class="btn btn--sm" href="/resultados">Ver os Resultados</a>');
    expect(html).toContain('role="group" aria-label="Esta explicação fez sentido?"');
    expect(html).toContain('De onde vêm os números (1)');
    // A tabela das campanhas, com o que só a plataforma prova e o total.
    expect(html).toContain('<caption class="sr-only">Campanhas da semana de 21/09 a 27/09: investimento, pedidos, receita, ROAS confirmado no caixa e resultado</caption>');
    expect(html).toContain(
      nbsp('<th scope="row">Combo sexta<span class="camp-canal"><span class="plat plat--meta">Meta Ads</span></span></th><td class="n num">R$ 404,10</td><td class="n num">26</td><td class="n num">R$ 1.716,00</td><td class="n num forte">4,25</td><td><span class="veredito veredito--bom">Dá lucro</span></td>'),
    );
    expect(html).toContain('<span class="plat plat--google">Google Ads</span>');
    expect(html).toContain(nbsp('<tr class="linha-plat"><th scope="row">Meta · sem campanha identificada</th><td class="n">—</td><td class="n num">4</td><td class="n num">R$ 1.029,00</td><td class="n">—</td><td><span class="eixo-nota">conta no total</span></td></tr>'));
    expect(html).toContain(nbsp('<tfoot><tr><th scope="row">Total</th><td class="n num">R$ 1.214,30</td><td class="n num">53</td><td class="n num">R$ 3.471,00</td><td class="n num forte">2,86</td><td><span class="veredito veredito--atencao">Empata</span></td></tr></tfoot>'));
    // Melhorou e piorou.
    expect(html).toMatch(/<ul class="rev-lista rev-lista--bom"><li><svg[^>]*>.*?<\/svg><span>Pedidos de anúncios: de <b class="num">47<\/b> para <b class="num">53<\/b> \(\+12,8%\)\.<\/span><\/li>/);
    expect(html).toContain('<span>Combo sexta: ROAS no caixa de <b class="num">4,02</b> para <b class="num">4,25</b>.</span>');
    expect(html).toContain('<span>Delivery noite: ROAS no caixa de <b class="num">1,12</b> para <b class="num">0,76</b>.</span>');
    expect(html).toContain('<span>Pedidos sem origem: de <b class="num">41</b> para <b class="num">44</b> (+7,3%).</span>');
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
