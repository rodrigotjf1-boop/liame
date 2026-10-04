import type { AttentionItem, SourceFreshness, SummaryResponse, TeamMember, TeamResponse } from '@liame/contracts';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ConversaProvider } from '@/components/conversa/contexto';
import { ResumoConteudo } from '@/components/resumo/resumo-conteudo';
import {
  canaisDo,
  contadorDoResumo,
  equipeDo,
  Fontes,
  hojeEscrito,
  pedidosDo,
  pontosFalados,
  precisaDe,
  primeiroNome,
  saudacao,
  statsDo,
  textoCorrido,
  variacaoEntre,
  vereditoDo,
} from '@/components/resumo/textos';
import { destinoInicial } from '@/components/shell/inicio';
import { itensVisiveis, NAVEGACAO, temModos, tituloDa } from '@/components/shell/navegacao';
import { AvisosProvider } from '@/components/ui/avisos';

// "Resumo" (A3 · P8, aprovado em 03/10/2026; mockups/prototipo-resumo.html): a página inicial do Lite. As frases e
// os números saem do que a API manda (`GET /v1/summary` e `/v1/team`); a tela é desenhada pelo mesmo componente
// do navegador.

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

  it('semana normal: vendas, gasto e o que sobrou, cada um com a fonte e a comparação', () => {
    const f = new Fontes();
    const [vendas, gasto, sobra] = statsDo(resumo(), f, AGORA);
    expect(vendas!.valor!.texto).toBe(nbsp('R$ 3.471'));
    expect(textoCorrido(vendas!.sub!.texto)).toBe('13,1% a mais que na semana anterior');
    expect(vendas!.sub!.tom).toBe('bom');
    expect(gasto!.valor!.texto).toBe(nbsp('R$ 1.214'));
    expect(gasto!.sub!.tom).toBe('neutro');
    expect(sobra).toMatchObject({ rotulo: 'Sobrou depois de pagar os anúncios', foco: true });
    expect(sobra!.valor!.texto).toBe(nbsp('R$ 287'));
    expect(textoCorrido(sobra!.sub!.texto)).toBe('a margem conhecida cobre 91% da receita');
    expect(f.lista).toEqual([
      { valor: nbsp('R$ 3.471'), fonte: 'Regem · confirmado no caixa · 22/09 a 28/09' },
      { valor: '13,1%', fonte: 'Liame · comparação com 15/09 a 21/09 · calculada pelo sistema' },
      { valor: nbsp('R$ 1.214'), fonte: 'Meta Ads e Google Ads · gasto · 22/09 a 28/09 · lido hoje, 06:12 e 06:20' },
      { valor: '2,9%', fonte: 'Liame · comparação com 15/09 a 21/09 · calculada pelo sistema' },
      { valor: nbsp('R$ 287'), fonte: 'Liame · margem conhecida − investimento · calculado pelo sistema' },
      { valor: '91%', fonte: 'Regem · parte da receita com custo cadastrado · 22/09 a 28/09' },
    ]);
  });

  it('vendas caindo ficam em vermelho; prejuízo vira "Faltou para pagar os anúncios", sem o destaque verde', () => {
    const [vendas, , sobra] = statsDo(resumo({}, { revenue_micros: { now: '2000000000', before: '3000000000' }, left_micros: { now: '-150000000', before: null } }), new Fontes(), AGORA);
    expect(vendas!.sub).toMatchObject({ tom: 'ruim', seta: 'desce' });
    expect(sobra).toMatchObject({ rotulo: 'Faltou para pagar os anúncios', foco: false });
    expect(sobra!.valor!.texto).toBe(nbsp('R$ 150'));
  });

  it('margem abaixo de 80% (o piloto sem o custo dos produtos): ainda não dá para dizer o que sobrou', () => {
    const [, , baixa] = statsDo(resumo({}, { left_micros: { now: null, before: null }, margin_coverage_pct: '62.0', verdict: null }), new Fontes(), AGORA);
    expect(baixa).toMatchObject({ valor: null, vazio: 'Ainda não dá para dizer' });
    expect(textoCorrido(baixa!.sub!.texto)).toBe('só 62% das vendas têm custo no Regem');
    const [, , semCusto] = statsDo(resumo({}, { left_micros: { now: null, before: null }, margin_known_micros: null, margin_coverage_pct: null, verdict: null }), new Fontes(), AGORA);
    expect(textoCorrido(semCusto!.sub!.texto)).toBe('nenhuma venda tem o custo dos produtos no Regem');
  });

  it('sem o Regem: só o gasto; na primeira semana, nenhum dos três', () => {
    const semRegem = statsDo(resumo({ state: 'sem_regem' }), new Fontes(), AGORA);
    expect(semRegem.map((s) => s.vazio)).toEqual(['Sem o Regem, não dá para saber', null, 'Sem o Regem, não dá para saber']);
    expect(semRegem[1]!.valor!.texto).toBe(nbsp('R$ 1.214'));
    const primeira = statsDo(resumo({ state: 'primeira_semana' }), new Fontes(), AGORA);
    expect(primeira.map((s) => s.vazio)).toEqual(Array(3).fill('Ainda sem 7 dias completos'));
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
  it('os pedidos do caixa; sem pedido de anúncio, sem o valor médio', () => {
    const f = new Fontes();
    expect(pedidosDo(resumo(), f)!.map((m) => [m.rotulo, m.valor.texto])).toEqual([
      ['Pedidos que vieram do marketing', '53'],
      ['Valor médio desses pedidos', nbsp('R$ 65,49')],
      ['Pedidos de todos os canais', '412'],
      ['Sem origem provada', '61'],
    ]);
    expect(pedidosDo(resumo({ orders: { marketing: 0, average_micros: null, all_channels: 12, without_origin: 4 } }), new Fontes())!.map((m) => m.rotulo)).not.toContain('Valor médio desses pedidos');
    expect(pedidosDo(resumo({ state: 'sem_regem' }), new Fontes())).toBeNull();
  });

  it('cada canal com a parte dos pedidos e o que sobrou (ou faltou); sem margem, não diz quanto', () => {
    const c = canaisDo(resumo(), new Fontes())!;
    expect(c.canais.map((x) => [x.nome, x.pedidos.texto, x.parte, textoCorrido(x.sub)])).toEqual([
      ['Instagram e Facebook', '41', 77, nbsp('sobraram R$ 402 depois dos anúncios')],
      ['Google', '12', 23, nbsp('faltaram R$ 116 para pagar os anúncios')],
    ]);
    expect(c.canais[0]!.falado).toBe('41 de 53 pedidos com origem provada');
    expect(c.semOrigem.texto).toBe('61');
    const semMargem = canaisDo(resumo({ platforms: [{ provider: 'meta_ads', orders: 0, left_micros: null }] }), new Fontes())!;
    expect(semMargem.canais[0]).toMatchObject({ parte: 0 });
    expect(textoCorrido(semMargem.canais[0]!.sub)).toBe('sem margem conhecida bastante para dizer quanto sobrou');
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

  it('semana normal: saudação, os três números com fonte, o veredito, o que precisa de você e a lista das fontes', () => {
    const html = desenhar(resumo({ needs_you: { critical: 1, attention: 0, items: [aviso({})], approvals: { actions: 1, plans: 0, autonomy: 0 } } }), equipe([membro('lia', { stats: [stat('respostas', 3)] })]));
    expect(html).toContain('Terça, 29 de setembro · Mister Burgers');
    expect(html).toContain('Boa tarde, Rodrigo.');
    expect(html).toContain('Assim foi o seu marketing nos últimos 7 dias.');
    expect(html).toContain('class="nf"');
    expect(html).toContain('De onde vêm os números (');
    expect(html).toContain('O marketing se pagou, mas sobrou pouco.');
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

describe('menu: o Resumo é a página inicial do Lite, a Atenção a do Pro', () => {
  const agencia = NAVEGACAO.find((g) => g.id === 'agencia')!;

  it('no Lite, o Resumo e não a Atenção; no Pro, o contrário; sem ver as vendas, a Atenção fica no Lite também', () => {
    expect(itensVisiveis(agencia, tudoPode, 'lite').map((i) => i.href)).toEqual(['/resumo', '/aprovacoes', '/resultados', '/equipe', '/marca', '/contas', '/pessoas']);
    expect(itensVisiveis(agencia, tudoPode, 'pro').map((i) => i.href)).toEqual(['/atencao', '/aprovacoes', '/resultados', '/equipe', '/marca', '/contas', '/pessoas']);
    expect(itensVisiveis(agencia, (p) => p !== 'vendas.ver', 'lite').map((i) => i.href)).toEqual(['/atencao', '/aprovacoes', '/equipe', '/marca', '/contas', '/pessoas']);
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
