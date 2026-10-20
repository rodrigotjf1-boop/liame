import type { GoogleVisibilityResponse } from '@liame/contracts';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { VistaDoGoogle } from '@/components/resultados/cartao-google';
import { buscaNaTela, diaCurto, linhaDosCliques, montarCartaoDoGoogle, posicaoComUmaCasa, semanaEmPalavras, variacaoDe } from '@/components/resultados/google';

// "Como te acham no Google" em Resultados (P18; mockups/prototipo-como-te-acham.html). Os números do protótipo: o
// perfil 1.640 na busca e 700 no Maps (2.090 antes), o site com 156 cliques (139 antes), 1.920 vezes e posição 6,8.

const LOJA = '01a40000-0000-7000-8000-0000000000c1';
const SITE = '01a40000-0000-7000-8000-0000000000c2';
const DIAS = ['2026-09-20', '2026-09-21', '2026-09-22', '2026-09-23', '2026-09-24', '2026-09-25', '2026-09-26'];
const CLIQUES = [18, 22, 19, 25, 27, 24, 21];
const BUSCAS: Array<[string, number, number, string | null]> = [
  ['mister burgers', 38, 120, '1.2'],
  ['hamburgueria perto de mim', 21, 640, '6.8'],
  ['smash burger', 14, 210, '4.1'],
  ['hamburguer delivery centro', 9, 330, '8.9'],
  ['burger lapa', 6, 150, '7.4'],
  ['combo smash', 4, 60, '3.3'],
  ['lanchonete aberta agora', 3, 280, '11.2'],
  ['mister burgers cardápio', 3, 22, '1'],
  ['hamburgueria artesanal rio de janeiro zona central entrega rápida', 2, 190, '14.5'],
  ['onion rings', 1, 75, null],
];
const conta = (id: string, name: string) => ({ connected_account_id: id, name, status: 'ativa', last_success_at: '2026-09-29T10:00:00.000Z' });

function resposta(over: { profile?: Partial<GoogleVisibilityResponse['profile']>; site?: Partial<GoogleVisibilityResponse['site']>; days?: number } = {}): GoogleVisibilityResponse {
  const days = over.days ?? 7;
  return {
    enabled: (over.profile?.enabled ?? true) || (over.site?.enabled ?? true),
    days,
    profile: {
      enabled: true,
      waiting_google: false,
      accounts: [conta(LOJA, 'Mister Burgers — Centro')],
      period: { from: '2026-09-20', to: '2026-09-26' },
      views_search: '1640',
      views_maps: '700',
      previous_views: '2090',
      direction_requests: '128',
      call_clicks: '46',
      website_clicks: '212',
      menu_clicks: '88',
      ...over.profile,
    },
    site: {
      enabled: true,
      accounts: [conta(SITE, 'misterburgers.com.br')],
      period: { from: '2026-09-20', to: '2026-09-26' },
      clicks: '156',
      impressions: '1920',
      position: '6.8',
      previous_clicks: '139',
      daily: DIAS.map((day, i) => ({ day, clicks: String(CLIQUES[i]) })),
      queries: { week: { from: '2026-09-21', to: '2026-09-27' }, items: BUSCAS.map(([query, c, v, p]) => ({ query, clicks: String(c), impressions: String(v), position: p })) },
      ...over.site,
    },
  };
}
const texto = (f: { t: string }[]) => f.map((x) => x.t).join('');
const ok = (r: GoogleVisibilityResponse, periodo: 'hoje' | '7' | '30' = '7', contas = true) => {
  const c = montarCartaoDoGoogle(r, periodo, contas);
  if (c.tipo !== 'ok') throw new Error('o cartão devia aparecer');
  return c;
};

describe('os números, como a tela escreve', () => {
  it('a posição com uma casa, sem ponto flutuante; o dia e a semana', () => {
    expect(posicaoComUmaCasa('6.8')).toBe('6,8');
    expect(posicaoComUmaCasa('6.75')).toBe('6,8');
    expect(posicaoComUmaCasa('6.74')).toBe('6,7');
    expect(posicaoComUmaCasa('11.25')).toBe('11,3');
    expect(posicaoComUmaCasa('1')).toBe('1,0');
    expect(posicaoComUmaCasa('1234.5')).toBe('1.234,5');
    expect(posicaoComUmaCasa(null)).toBe('—');
    expect(diaCurto('2026-09-26')).toBe('26/09');
    expect(semanaEmPalavras({ from: '2026-09-21', to: '2026-09-27' })).toBe('de 21 a 27/09');
    expect(semanaEmPalavras({ from: '2026-09-28', to: '2026-10-04' })).toBe('de 28/09 a 04/10');
  });

  it('a variação contra os dias de antes: a mais, a menos, igual e sem os dias de antes', () => {
    expect(variacaoDe(2340n, '2090', ['vez', 'vezes'], 7)).toEqual({ sentido: 'sobe', frase: [{ t: '250 vezes a mais', b: true }, { t: ' que nos 7 dias anteriores (2.090)' }] });
    expect(texto(variacaoDe(1n, '2', ['clique', 'cliques'], 30)!.frase)).toBe('1 clique a menos que nos 30 dias anteriores (2)');
    expect(variacaoDe(5n, '5', ['vez', 'vezes'], 7)).toEqual({ sentido: 'igual', frase: [{ t: 'Igual aos 7 dias anteriores.' }] });
    expect(variacaoDe(5n, null, ['vez', 'vezes'], 7)).toBeNull();
  });

  it('cada busca: a barra na régua da que mais trouxe cliques, o texto curto e o completo (com a taxa e a posição)', () => {
    const b = buscaNaTela({ query: 'hamburgueria perto de mim', clicks: '21', impressions: '640', position: '6.8' }, 38n);
    expect(b.largura).toBe(55.26);
    expect(texto(b.curta)).toBe('21 cliques · apareceu 640 vezes');
    expect(texto(b.completa)).toBe('21 cliques · apareceu 640 vezes · 3,3% clicaram · posição 6,8');
    expect(b.rotulo).toBe('“hamburgueria perto de mim”: 21 cliques');
    expect(texto(buscaNaTela({ query: 'x', clicks: '1', impressions: '1', position: null }, 1n).completa)).toBe('1 clique · apareceu 1 vez · 100% clicaram · posição —');
  });

  it('a linha dos cliques por dia: um ponto e um alvo por dia, as datas, o último dia e o rótulo para o leitor de tela', () => {
    const l = linhaDosCliques(DIAS.map((day, i) => ({ day, clicks: String(CLIQUES[i]) })))!;
    expect(l.pontos).toHaveLength(7);
    expect(l.marcas.map((m) => m.texto)).toEqual(['20/09', '21/09', '22/09', '23/09', '24/09', '25/09', '26/09']);
    // No minigráfico estreito, só a primeira, a do meio e a última ficam (as outras se sobrepunham no celular).
    expect(l.marcas.filter((m) => !m.extra).map((m) => m.texto)).toEqual(['20/09', '23/09', '26/09']);
    expect(l.ultimo).toMatchObject({ valor: '21', quando: 'em 26/09' });
    expect(l.rotulo).toBe('Cliques vindos das buscas por dia, de 20/09 a 26/09. O dia com mais cliques teve 27 cliques; o último, 21 cliques.');
    expect(l.pontos[4]!.y).toBeCloseTo(8, 5);
    // 30 dias: as datas do começo, do meio e do fim.
    const trinta = linhaDosCliques(Array.from({ length: 30 }, (_, i) => ({ day: `2026-09-${String(i + 1).padStart(2, '0')}`, clicks: '0' })))!;
    expect(trinta.marcas.map((m) => m.texto)).toEqual(['01/09', '15/09', '30/09']);
    expect(trinta.marcas.some((m) => m.extra)).toBe(false);
    // Tudo zero não divide por zero.
    expect(JSON.stringify(trinta)).not.toMatch(/NaN|Infinity/);
    expect(linhaDosCliques([{ day: '2026-09-26', clicks: '3' }])).toBeNull();
  });
});

describe('o cartão a partir da resposta', () => {
  it('sem as duas funções, o cartão não existe', () => {
    expect(montarCartaoDoGoogle(resposta({ profile: { enabled: false }, site: { enabled: false } }), '7', true)).toEqual({ tipo: 'desligado' });
  });

  it('o perfil e o site lidos: o subtítulo com a data, os números do perfil e do site e as buscas da semana', () => {
    const c = ok(resposta());
    expect(c.sub).toBe('Os números que o Google informa, nos 7 dias até 26/09: ele entrega com 2 a 3 dias de atraso.');
    expect(c.perfil).toMatchObject({ tipo: 'perfil', ate: null, total: '2.340' });
    if (c.perfil.tipo !== 'perfil') throw new Error('perfil');
    expect(texto(c.perfil.variacao!.frase)).toBe('250 vezes a mais que nos 7 dias anteriores (2.090)');
    expect(c.perfil.barra.partes.map((p) => [p.valor, p.rotulo, p.dica])).toEqual([
      ['1.640', 'na busca do Google', '1.640 vezes|na busca do Google · 70%'],
      ['700', 'no Google Maps', '700 vezes|no Google Maps · 30%'],
    ]);
    expect(c.perfil.barra.rotulo).toBe('O perfil apareceu 2.340 vezes: 1.640 na busca do Google e 700 no Google Maps.');
    expect(c.perfil.acoes).toEqual([
      { valor: '128', rotulo: 'pedidos de rota' },
      { valor: '46', rotulo: 'ligações' },
      { valor: '212', rotulo: 'cliques no site' },
      { valor: '88', rotulo: 'cliques no cardápio' },
    ]);
    expect(c.site).toMatchObject({ tipo: 'site', ate: null, cliques: '156' });
    if (c.site.tipo !== 'site') throw new Error('site');
    expect(texto(c.site.variacao!.frase)).toBe('17 cliques a mais que nos 7 dias anteriores (139)');
    expect(texto(c.site.sub)).toBe('O site apareceu 1.920 vezes nas buscas, em média na posição 6,8 (1 é o primeiro lugar).');
    expect(c.site.dias?.pontos).toHaveLength(7);
    expect(c.buscas).toMatchObject({ semana: 'de 21 a 27/09', poucas: null, vazia: false });
    expect(c.buscas!.lista).toHaveLength(10);
    expect(c.buscas!.lista[0]!.largura).toBe(100);
  });

  it('"Hoje": o dia ainda não chegou, e o cartão mostra os 7 dias fechados', () => {
    expect(ok(resposta(), 'hoje').sub).toBe('O Google entrega os números com 2 a 3 dias de atraso: hoje ainda não chegou. Abaixo, os 7 dias até 26/09.');
    expect(ok(resposta({ days: 30, profile: { period: { from: '2026-08-28', to: '2026-09-26' } }, site: { period: { from: '2026-08-28', to: '2026-09-26' } } }), '30').sub).toBe(
      'Os números que o Google informa, nos 30 dias até 26/09: ele entrega com 2 a 3 dias de atraso.',
    );
  });

  it('o perfil e o site acabam em dias diferentes: a data vai em cada parte', () => {
    const c = ok(resposta({ site: { period: { from: '2026-09-19', to: '2026-09-25' } } }));
    expect(c.sub).toBe('Os números que o Google informa, nos últimos 7 dias que ele já informou: ele entrega com 2 a 3 dias de atraso.');
    expect(c.perfil).toMatchObject({ ate: 'Nos 7 dias até 26/09.' });
    expect(c.site).toMatchObject({ ate: 'Nos 7 dias até 25/09.' });
  });

  it('a parte da função desligada não aparece, e sem o site não há buscas', () => {
    const soPerfil = ok(resposta({ site: { enabled: false } }));
    expect(soPerfil.site).toEqual({ tipo: 'fora' });
    expect(soPerfil.buscas).toBeNull();
    const soSite = ok(resposta({ profile: { enabled: false } }));
    expect(soSite.perfil).toEqual({ tipo: 'fora' });
    expect(soSite.sub).toContain('nos 7 dias até 26/09');
  });

  it('antes dos números: nada ligado (o convite, com o caminho só para quem vê as contas), esperando o Google, primeira leitura', () => {
    const nada = ok(resposta({ profile: { accounts: [], period: null }, site: { accounts: [], period: null, queries: null } }));
    expect(nada.perfil).toMatchObject({ tipo: 'convite', contas: true });
    expect(nada.site).toMatchObject({ tipo: 'convite', contas: true });
    expect(nada.buscas).toBeNull();
    expect(ok(resposta({ profile: { accounts: [], period: null } }), '7', false).perfil).toMatchObject({ tipo: 'convite', contas: false });
    expect(ok(resposta({ profile: { accounts: [], period: null, waiting_google: true } })).perfil).toEqual({
      tipo: 'aviso',
      destaque: 'Esperando o Google.',
      texto: 'O Google ainda não liberou o acesso do Liame ao perfil da empresa. O Liame procura de novo todo dia, e os números aparecem aqui assim que o Google liberar.',
    });
    expect(ok(resposta({ profile: { period: null } })).perfil).toMatchObject({ tipo: 'aviso', destaque: 'Primeira leitura.' });
    expect(ok(resposta({ site: { period: null, queries: null } })).site).toMatchObject({
      tipo: 'aviso',
      texto: 'O site foi ligado agora: os cliques dos últimos 90 dias e as buscas das últimas 12 semanas chegam em até um dia.',
    });
  });

  it('as buscas: poucas, nenhuma, e os dias sem os números de antes', () => {
    const duas = ok(resposta({ site: { queries: { week: { from: '2026-09-21', to: '2026-09-27' }, items: BUSCAS.slice(0, 2).map(([query, c, v, p]) => ({ query, clicks: String(c), impressions: String(v), position: p })) } } }));
    expect(duas.buscas?.poucas).toBe('Só 2 buscas trouxeram cliques nesta semana.');
    const uma = ok(resposta({ site: { queries: { week: { from: '2026-09-21', to: '2026-09-27' }, items: BUSCAS.slice(0, 1).map(([query, c, v, p]) => ({ query, clicks: String(c), impressions: String(v), position: p })) } } }));
    expect(uma.buscas?.poucas).toBe('Só 1 busca trouxe cliques nesta semana.');
    const nenhuma = ok(resposta({ site: { queries: { week: { from: '2026-09-21', to: '2026-09-27' }, items: [] } } }));
    expect(nenhuma.buscas).toMatchObject({ vazia: true, lista: [] });
    const semAntes = ok(resposta({ profile: { previous_views: null }, site: { previous_clicks: null } }));
    expect(semAntes.perfil).toMatchObject({ variacao: null });
    expect(semAntes.site).toMatchObject({ variacao: null });
    const semVezes = ok(resposta({ site: { impressions: '0', clicks: '0', position: null } }));
    expect(semVezes.site.tipo === 'site' && texto(semVezes.site.sub)).toBe('O site não apareceu nas buscas nestes dias.');
  });
});

describe('o cartão desenhado', () => {
  const desenhar = (r: GoogleVisibilityResponse, { pro = false, aberto = false, contas = true } = {}) => {
    const c = montarCartaoDoGoogle(r, '7', contas);
    if (c.tipo !== 'ok') throw new Error('o cartão devia aparecer');
    return renderToStaticMarkup(createElement(VistaDoGoogle, { cartao: c, pro, aberto, aoAlternar: () => {} }));
  };

  it('o simples: as duas partes, as 5 primeiras buscas e "Ver as 10 buscas", com o alvo sempre na página', () => {
    const html = desenhar(resposta());
    expect(html).toContain('<h2 id="t-google">Como te acham no Google</h2>');
    expect(html).toContain('No seu perfil do Google');
    expect(html).toContain('No seu site');
    expect(html).toContain('<b>2.340</b>vezes que o perfil apareceu');
    expect(html).toContain('<b>156</b>cliques vindos das buscas');
    expect(html).toContain('E as pessoas fizeram:');
    expect(html).toContain('<b>128</b>pedidos de rota');
    expect(html).toContain('O que as pessoas buscaram');
    expect(html).toContain('As buscas que mais trouxeram cliques ao site na semana de 21 a 27/09.');
    expect(html).toContain('A busca feita por poucas pessoas o Google não mostra');
    // A régua dos dias tem o nome dela (ERR-145).
    expect(html).toContain('class="faisca-dias"');
    expect(html).not.toMatch(/class="dias"/);
    // As 4 datas que somem no minigráfico estreito levam a marca (a regra do CSS esconde só essas).
    expect(html.split('class="faisca-dia-extra"').length - 1).toBe(4);
    // A lista curta (5) à vista, a completa (10) escondida, e o botão que a abre.
    expect(html.match(/<span class="gl-busca">/g)).toHaveLength(15);
    expect(html).toContain('<ul class="funil gl-funil" id="google-buscas" hidden="">');
    expect(html).toMatch(/<button class="detalhes-bt" type="button" aria-expanded="false" aria-controls="google-buscas"><span>Ver as 10 buscas<\/span>/);
    expect(html).toContain('<div class="gl-grade">');
    expect(html).not.toMatch(/NaN|undefined|\[object Object\]/);
  });

  it('aberto no simples e no Pro: as 10 buscas completas, sem a lista curta; no Pro, sem o botão', () => {
    const aberto = desenhar(resposta(), { aberto: true });
    expect(aberto.match(/<span class="gl-busca">/g)).toHaveLength(10);
    expect(aberto).toContain('<ul class="funil gl-funil" id="google-buscas">');
    expect(aberto).toContain('Ver só as 5 primeiras');
    expect(aberto).toContain('3,3% clicaram · posição 6,8');
    const pro = desenhar(resposta(), { pro: true });
    expect(pro.match(/<span class="gl-busca">/g)).toHaveLength(10);
    expect(pro).not.toContain('detalhes-bt');
  });

  it('uma parte só, o convite com e sem o caminho para Contas conectadas, e poucas buscas sem o botão', () => {
    const soSite = desenhar(resposta({ profile: { enabled: false } }));
    expect(soSite).toContain('<div class="gl-grade gl-grade--uma">');
    expect(soSite).not.toContain('No seu perfil do Google');
    const convite = desenhar(resposta({ profile: { accounts: [], period: null } }));
    expect(convite).toContain('O perfil da empresa no Google (o que aparece na busca e no Maps) não está ligado.');
    expect(convite).toContain('href="/contas"');
    expect(desenhar(resposta({ profile: { accounts: [], period: null } }), { contas: false })).not.toContain('href="/contas"');
    const poucas = desenhar(resposta({ site: { queries: { week: { from: '2026-09-21', to: '2026-09-27' }, items: BUSCAS.slice(0, 3).map(([query, c, v, p]) => ({ query, clicks: String(c), impressions: String(v), position: p })) } } }));
    expect(poucas).toContain('Só 3 buscas trouxeram cliques nesta semana.');
    expect(poucas).not.toContain('detalhes-bt');
  });
});
