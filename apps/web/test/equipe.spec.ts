import type { AutonomyItem, AutonomyResponse, TeamActivityItem, TeamActivityResponse, TeamMember, TeamResponse, TeamShadowDecision, TeamShadowResponse } from '@liame/contracts';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ConversaProvider } from '@/components/conversa/contexto';
import type { Historico } from '@/components/equipe/bloco-historico';
import { EquipeConteudo } from '@/components/equipe/equipe-conteudo';
import {
  acaoDa,
  acertoDo,
  alvoDe,
  atividadeDo,
  avisosDa,
  custoDo,
  custoNaTela,
  dataDe,
  diaDaLoja,
  emReais,
  fraseDaSombra,
  gruposDa,
  historicoDo,
  linhaDaSombra,
  mesDe,
  modoDo,
  notaDaCotacao,
  perguntaSobre,
  podeConversarSobre,
  porcento,
  portoesDe,
  quandoNaFrase,
  rodadaDa,
  seloDaIa,
  situacaoDo,
  usdDeMicros,
} from '@/components/equipe/textos';
import { itensVisiveis, NAVEGACAO, temModos, tituloDa } from '@/components/shell/navegacao';
import { quandoComHora } from '@/lib/formato';
import type { Modo } from '@/lib/modo';

// "Sua equipe" (A3 · P7, aprovado em 03/10/2026; mockups/prototipo-equipe.html): as frases e os números saem do que a
// API manda (`/v1/team`, `/v1/team/members/:key/activity`, `/v1/team/shadow` e `/v1/autonomy`); a tela é desenhada
// pelo mesmo componente do navegador.

const AGORA = new Date('2026-10-03T17:40:00Z');
const nbsp = (s: string) => s.replaceAll('R$ ', `R$${String.fromCharCode(160)}`).replaceAll('US$ ', `US$${String.fromCharCode(160)}`);
const uuid = (n: number) => `a0000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const PTAX = { rate: '5.2238', date: '2026-10-02', source: 'bcb_ptax_venda' };
const stat = (key: string, value: number | string, unit = 'qtd') => ({ key, value: String(value), unit });

const membro = (key: string, over: Partial<TeamMember> = {}): TeamMember => ({
  key,
  kind: ['relatorios', 'compliance', 'trafego'].includes(key) ? 'regra' : 'ia',
  status: key === 'trafego' ? 'sombra' : 'ativo',
  working_now: false,
  can_pause: key !== 'compliance',
  paused: null,
  cost: { usd_micros: '0', calls: 0 },
  stats: [],
  ...over,
});

function equipe(over: Partial<TeamResponse> = {}, membros: Record<string, Partial<TeamMember>> = {}): TeamResponse {
  return {
    brand_id: uuid(1),
    month: { from: '2026-10-01', to: '2026-10-31', timezone: 'America/Sao_Paulo' },
    ai: { enabled: true, spent_usd_micros: '4340000', ceiling_usd_micros: '20000000', band: 'livre' },
    usd_brl: PTAX,
    stop: null,
    members: ['lia', 'analista', 'relatorios', 'compliance', 'estrategista', 'pesquisador', 'trafego'].map((k) => membro(k, membros[k])),
    can_manage: true,
    can_stop: true,
    generated_at: AGORA.toISOString(),
    ...over,
  };
}

const item = (over: Partial<TeamActivityItem>): TeamActivityItem => ({
  at: '2026-10-03T15:00:00.000Z',
  kind: 'respondeu',
  subject: null,
  detail: null,
  period: null,
  count: null,
  rules: [],
  by: null,
  mine: false,
  feedback: null,
  ...over,
});

const decisao = (over: Partial<TeamShadowDecision> = {}): TeamShadowDecision => ({
  id: uuid(50),
  decided_on: '2026-10-03',
  campaign: { id: uuid(60), name: 'Delivery noite', provider: 'meta_ads' },
  tool: 'orcamento_reduzir',
  percent: 20,
  confidence_pct: '76.0',
  status: 'aberta',
  evaluate_on: '2026-10-10',
  human_action: null,
  human_action_on: null,
  agreement: null,
  regret_label: null,
  regret_micros: null,
  ...over,
});

const LIMITES = { sample_size: 30, agreement_min_pct: 80, worse_max_pct: 10, regret_max_micros: '0', confidence_min_pct: 70, sample_after_rejection: 30 };

const autonomiaItem = (over: Partial<AutonomyItem> = {}): AutonomyItem => ({
  connected_account_id: uuid(70),
  provider: 'meta_ads',
  account_name: 'CA - Mister Burguer',
  tool: 'orcamento_reduzir',
  action: 'orcamento.reduzir',
  mode: 'SHADOW',
  mode_source: { policy: 'padrao', version: null },
  readiness: { computed_on: '2026-10-03', rule_version: 1, sample_size: 22, agreement_pct: '86.0', worse_pct: '5.0', regret_sum_micros: '-41200000', confidence_avg_pct: '76.4', missing: ['amostra'] },
  proposal: null,
  ...over,
});

const autonomia = (items: AutonomyItem[], podeDecidir = true): AutonomyResponse => ({ brand_id: uuid(1), items, thresholds: LIMITES, can_decide: podeDecidir, generated_at: AGORA.toISOString() });
const sombra = (items: TeamShadowDecision[], over: Partial<TeamShadowResponse> = {}): TeamShadowResponse => ({
  brand_id: uuid(1),
  rule_version: 1,
  last_run: { on: '2026-10-03', status: 'feito', at: '2026-10-03T09:31:00.000Z' },
  items,
  has_more: false,
  generated_at: AGORA.toISOString(),
  ...over,
});

const nada = () => {};
function desenhar(over: {
  t?: TeamResponse;
  autonomia?: AutonomyResponse | null;
  sombra?: TeamShadowResponse | null;
  historicos?: Record<string, Historico>;
  escolhido?: string;
  modo?: Modo;
  parando?: boolean;
  desligando?: string | null;
  recusando?: string | null;
  /** A pessoa conversa com a LIA (o painel do shell em volta da tela). */
  comConversa?: boolean;
}): string {
  const dentro = (tela: ReturnType<typeof createElement>) => (over.comConversa ? createElement(ConversaProvider, { disponivel: true, children: tela }) : tela);
  return renderToStaticMarkup(
    dentro(createElement(EquipeConteudo, {
      t: over.t ?? equipe(),
      autonomia: over.autonomia === undefined ? autonomia([]) : over.autonomia,
      sombra: over.sombra === undefined ? sombra([]) : over.sombra,
      historicos: over.historicos ?? {},
      escolhido: over.escolhido ?? 'lia',
      mostraDetalhe: false,
      modo: over.modo ?? 'lite',
      agora: AGORA,
      nomeDaMarca: 'Mister Burgers',
      topo: { ocupado: null, parando: over.parando ?? false, aoPedirParada: nada, aoParar: nada, aoRetomar: nada },
      membro: { ocupado: null, desligando: over.desligando ?? null, aoPedirDesligar: nada, aoDesligar: nada, aoLigar: nada, aoIrParaPro: nada, aoRecarregarHistorico: nada },
      prontidao: { ocupado: null, recusando: over.recusando ?? null, aoAprovar: nada, aoPedirRecusa: nada, aoRecusar: nada, aoVoltarParaSombra: nada },
      aoEscolher: nada,
      aoVoltar: nada,
    })),
  );
}
const historico = (items: TeamActivityItem[], hasMore = false): Historico => ({
  tipo: 'ok',
  dados: { brand_id: uuid(1), member: 'analista', since: '2026-07-05T17:40:00.000Z', items, has_more: hasMore, generated_at: AGORA.toISOString() } satisfies TeamActivityResponse,
});

describe('Sua equipe: o custo de IA em reais pela cotação de referência (D-A3-14)', () => {
  it('dólar em reais só com inteiros, igual ao servidor; sem cotação, a tela mostra o dólar', () => {
    expect(emReais(4_340_000n, '5.2238')).toBe(22_671_292n);
    expect(emReais(1n, '5.5')).toBe(6n);
    expect(usdDeMicros('4340000')).toBe(nbsp('US$ 4,34'));
    expect(usdDeMicros('1234567890')).toBe(nbsp('US$ 1.234,57'));
    expect(custoNaTela('4340000', PTAX)).toBe(nbsp('R$ 22,67'));
    expect(custoNaTela('4340000', null)).toBe(nbsp('US$ 4,34'));
  });

  it('a tela diz de onde vem o valor em reais: a fonte, o dia e a cotação', () => {
    expect(notaDaCotacao(PTAX)).toBe(nbsp('Valor aproximado em reais, pela PTAX de venda do Banco Central de 02/10/2026 (US$ 1 = R$ 5,2238). O custo e o teto de IA são medidos em dólar.'));
    expect(notaDaCotacao({ ...PTAX, rate: '5.0' })).toContain(nbsp('R$ 5,0000'));
    expect(notaDaCotacao(null)).toBeNull();
    expect(seloDaIa(equipe())).toBe(nbsp('IA em outubro: R$ 22,67 de R$ 104,48'));
    expect(seloDaIa(equipe({ usd_brl: null }))).toBe(nbsp('IA em outubro: US$ 4,34 de US$ 20,00'));
  });

  it('datas do calendário, sem fuso no meio', () => {
    expect(mesDe('2026-10-01')).toBe('outubro');
    expect(dataDe('2026-10-02')).toBe('02/10/2026');
    expect(diaDaLoja('2026-10-03', AGORA)).toBe('hoje');
    expect(diaDaLoja('2026-09-27', AGORA)).toBe('27/09');
    // O instante dentro de uma frase: hoje e ontem sem o "em".
    expect(quandoNaFrase('2026-10-03T15:00:00.000Z', AGORA)).toMatch(/^hoje, \d\d:\d\d$/);
    expect(quandoNaFrase('2026-09-30T15:00:00.000Z', AGORA)).toMatch(/^em 30\/09, \d\d:\d\d$/);
  });
});

describe('Sua equipe: a situação, o modo e os grupos da lista', () => {
  it('o selo de cada situação', () => {
    expect(situacaoDo(membro('lia')).rotulo).toBe('Online');
    expect(situacaoDo(membro('relatorios')).rotulo).toBe('Em espera');
    expect(situacaoDo(membro('estrategista', { working_now: true }))).toMatchObject({ rotulo: 'Trabalhando', classe: 'st st--trabalhando' });
    expect(situacaoDo(membro('trafego')).rotulo).toBe('Em sombra');
    expect(situacaoDo(membro('lia', { status: 'parado' })).rotulo).toBe('Parado');
    expect(situacaoDo(membro('pesquisador', { status: 'desligado' })).rotulo).toBe('Desligado');
    expect(situacaoDo(membro('lia', { status: 'desligado_pela_liame' }))).toMatchObject({ rotulo: 'Desligado pela Liame', ponto: false });
  });

  it('o modo: como cada um trabalha; o Gestor de tráfego mostra Sugerir quando alguma ação foi promovida', () => {
    expect(modoDo(membro('lia'), null).rotulo).toBe('Conversa');
    expect(modoDo(membro('relatorios'), null)).toEqual({ rotulo: 'Auto · relatório', classe: 'modo-chip modo-chip--auto' });
    expect(modoDo(membro('trafego'), [autonomiaItem()]).rotulo).toBe('Sombra');
    expect(modoDo(membro('trafego'), [autonomiaItem({ mode: 'SUGGEST' })]).rotulo).toBe('Sombra e Sugerir');
    expect(modoDo(membro('pesquisador', { status: 'desligado' }), null).rotulo).toBe('Desligado');
  });

  it('os grupos: quem trabalha, quem está em sombra e quem a empresa desligou', () => {
    const g = gruposDa(equipe({}, { pesquisador: { status: 'desligado' }, lia: { status: 'parado' } }));
    expect(g.ativos.map((m) => m.key)).toEqual(['lia', 'analista', 'relatorios', 'compliance', 'estrategista']);
    expect(g.sombra.map((m) => m.key)).toEqual(['trafego']);
    expect(g.desligados.map((m) => m.key)).toEqual(['pesquisador']);
  });

  it('a linha de cada um na lista: o que fez no mês, ou o que faz', () => {
    expect(atividadeDo(membro('analista', { stats: [stat('explicacoes', 52)] }), 'outubro', AGORA)).toBe('Explicou 52 números em outubro');
    expect(atividadeDo(membro('analista'), 'outubro', AGORA)).toBe('Explica os números quando você pede');
    expect(atividadeDo(membro('compliance', { stats: [stat('textos_conferidos', 138), stat('textos_barrados', 9)] }), 'outubro', AGORA)).toBe('Conferiu 138 textos em outubro e barrou 9');
    expect(atividadeDo(membro('estrategista', { working_now: true }), 'outubro', AGORA)).toBe('Montando um plano');
    expect(atividadeDo(membro('estrategista', { stats: [stat('planos_esperando', 1)] }), 'outubro', AGORA)).toBe('1 plano espera você');
    expect(atividadeDo(membro('trafego', { stats: [stat('recomendacoes', 26)] }), 'outubro', AGORA)).toBe('Recomendou 26 ações em outubro, sem mexer em nada');
    const pausa = { by: { id: uuid(9), name: 'Rodrigo' }, at: '2026-09-30T21:20:00.000Z', reason: null };
    expect(atividadeDo(membro('pesquisador', { status: 'desligado', paused: pausa }), 'outubro', AGORA)).toBe(`Desligado por Rodrigo ${quandoNaFrase(pausa.at, AGORA)}`);
  });
});

describe('Sua equipe: acerto e custo do mês', () => {
  it('o acerto de cada um, contado pelo servidor', () => {
    const analista = membro('analista', { stats: [stat('explicacoes', 41), stat('fez_sentido', 34), stat('discordo', 3), stat('retiradas_na_conferencia', 0)] });
    expect(acertoDo(analista, 'outubro')).toEqual([
      { valor: '34', rotulo: 'de 41 explicações marcadas "Fez sentido" (82%)' },
      { valor: '3', rotulo: '"Discordo", com o motivo' },
      { valor: '0', rotulo: 'respostas retiradas na conferência dos números' },
    ]);
    const compliance = membro('compliance', { stats: [stat('textos_conferidos', 138), stat('textos_barrados', 9)] });
    expect(acertoDo(compliance, 'outubro')).toEqual([
      { valor: '9', rotulo: 'textos barrados em outubro' },
      { valor: '138', rotulo: 'textos conferidos' },
    ]);
    // O Gestor de tráfego mostra a sombra e a prontidão no lugar do acerto.
    expect(acertoDo(membro('trafego'), 'outubro')).toEqual([]);
  });

  it('o custo em reais pela cotação, com o que foi feito; quem trabalha por regra não custa', () => {
    const t = equipe();
    expect(custoDo(membro('analista', { cost: { usd_micros: '1310000', calls: 52 }, stats: [stat('explicacoes', 52)] }), t)).toEqual({ valor: nbsp('R$ 6,84'), rotulo: '52 explicações' });
    expect(custoDo(membro('compliance'), t)).toEqual({ valor: nbsp('R$ 0,00'), rotulo: 'as regras rodam no código' });
    // Com o revisor de IA ligado para a empresa, o custo do Compliance é o dele; as regras seguem sem custo.
    const comRevisor = custoDo(membro('compliance', { cost: { usd_micros: '1310000', calls: 130 } }), t);
    expect(comRevisor).toEqual({ valor: nbsp('R$ 6,84'), rotulo: '130 chamadas ao revisor de IA; as regras rodam no código' });
    expect(custoDo(membro('compliance', { cost: { usd_micros: '0', calls: 1 } }), t).rotulo).toBe('1 chamada ao revisor de IA; as regras rodam no código');
    expect(custoDo(membro('trafego'), t).rotulo).toBe('nesta fase, as recomendações são por regra');
    expect(custoDo(membro('lia', { cost: { usd_micros: '1800000', calls: 61 }, stats: [stat('respostas', 61)] }), equipe({ usd_brl: null }))).toEqual({ valor: nbsp('US$ 1,80'), rotulo: '61 respostas' });
  });
});

describe('Sua equipe: os avisos do topo', () => {
  it('IA desligada, equipe parada pela empresa e pela Liame', () => {
    expect(avisosDa(equipe(), AGORA)).toEqual([]);
    expect(avisosDa(equipe({ ai: { enabled: false, spent_usd_micros: '0', ceiling_usd_micros: '20000000', band: 'livre' } }), AGORA).map((a) => a.titulo)).toEqual(['A IA está desligada nesta empresa']);
    const parada = { id: uuid(80), level: 'tenant', by_company: true, since: '2026-10-03T17:22:00.000Z', reason: 'Equipe parada pela tela Sua equipe.', by: { id: uuid(9), name: 'Rodrigo' } };
    const [daEmpresa] = avisosDa(equipe({ stop: parada }), AGORA);
    expect(daEmpresa).toMatchObject({ tipo: 'perigo', titulo: `A equipe está parada desde ${quandoComHora(parada.since, AGORA)}, por Rodrigo` });
    expect(daEmpresa!.texto).toContain('até você retomar');
    const [daLiame] = avisosDa(equipe({ stop: { ...parada, by_company: false, by: null } }), AGORA);
    expect(daLiame!.titulo).toContain('parada pela Liame');
    expect(daLiame!.texto).toContain('até a Liame retomar');
  });

  it('o teto: a faixa é a pior entre o dia e o mês, e a tela diz qual dos dois passou', () => {
    const peloMes = avisosDa(equipe({ ai: { enabled: true, spent_usd_micros: '14500000', ceiling_usd_micros: '20000000', band: 'alerta' } }), AGORA)[0]!;
    expect(peloMes).toMatchObject({ tipo: 'atencao', titulo: 'O uso de IA de outubro passou de 70% do teto da empresa' });
    expect(peloMes.texto).toContain(nbsp('R$ 75,75 de R$ 104,48 em outubro.'));
    // O mês está folgado: quem passou foi o teto do dia.
    const peloDia = avisosDa(equipe({ ai: { enabled: true, spent_usd_micros: '4340000', ceiling_usd_micros: '20000000', band: 'economico' } }), AGORA)[0]!;
    expect(peloDia.titulo).toBe('O uso de IA de hoje passou de 80% do teto do dia');
    const noTeto = avisosDa(equipe({ ai: { enabled: true, spent_usd_micros: '20000000', ceiling_usd_micros: '20000000', band: 'bloqueado' } }), AGORA)[0]!;
    expect(noTeto).toMatchObject({ tipo: 'perigo', titulo: 'O uso de IA de outubro chegou ao teto da empresa' });
  });
});

describe('Sua equipe: "O que fez" em frases', () => {
  const linha = (over: Partial<TeamActivityItem>) => historicoDo(item(over), AGORA);

  it('a conversa da própria pessoa vem pelo nome; a dos outros, sem o assunto e sem quem perguntou', () => {
    expect(linha({ subject: 'Como foi a semana?', mine: true, by: { id: uuid(9), name: 'Rodrigo' }, feedback: 'fez_sentido' })).toEqual({
      quando: quandoComHora('2026-10-03T15:00:00.000Z', AGORA),
      titulo: 'Respondeu na conversa "Como foi a semana?"',
      texto: 'Com a fonte de cada número. Você marcou "Fez sentido".',
    });
    expect(linha({})).toMatchObject({ titulo: 'Respondeu a uma pergunta', texto: 'Com a fonte de cada número.' });
  });

  it('explicações, revisão, textos barrados e retirados', () => {
    expect(linha({ kind: 'explicou_resultados', mine: true, feedback: 'discordo' })).toMatchObject({ titulo: 'Explicou os resultados', texto: 'Com a fonte de cada número. Você discordou; o motivo ficou guardado.' });
    expect(linha({ kind: 'gerou_revisao', detail: 'lia', period: { from: '2026-09-21', to: '2026-09-27' } })).toMatchObject({ titulo: 'Gerou a revisão de 21/09 a 27/09', texto: 'Com a leitura da LIA.' });
    expect(linha({ kind: 'enviou_revisao', count: 3, period: { from: '2026-09-21', to: '2026-09-27' } })).toMatchObject({ titulo: 'Enviou a revisão de 21/09 a 27/09 por e-mail', texto: 'Para 3 pessoas.' });
    expect(linha({ kind: 'barrou_texto', detail: 'analista', count: 1, rules: ['promessa_de_resultado'] })).toMatchObject({
      titulo: 'Barrou um texto do Analista de dados',
      texto: 'Regra: promessa de resultado. Ele não apareceu: ficou o que o sistema escreve.',
    });
    expect(linha({ kind: 'barrou_texto', detail: 'pesquisador', count: 3, rules: ['dado_pessoal'] }).titulo).toBe('Barrou 3 textos do Pesquisador');
    // O revisor de IA: as categorias dele vêm no campo das regras, e a tela diz o que ele apontou.
    expect(linha({ kind: 'barrou_texto', detail: 'lia', count: 1, rules: ['tom'] })).toMatchObject({
      titulo: 'Barrou um texto da LIA',
      texto: 'O revisor de IA apontou o tom. Ele não apareceu: ficou o que o sistema escreve.',
    });
    expect(linha({ kind: 'barrou_texto', detail: 'estrategista', count: 1, rules: ['tom', 'clareza', 'alegacao'] }).texto).toBe(
      'O revisor de IA apontou o tom, a clareza e uma alegação que ninguém pode provar. Ele não apareceu: ficou o que o sistema escreve.',
    );
    expect(linha({ kind: 'retirada_na_conferencia', detail: 'revisor', count: 1, rules: ['alegacao'] }).texto).toBe(
      'Barrado pelo Compliance. O revisor de IA apontou uma alegação que ninguém pode provar. Ficou o que o sistema escreve.',
    );
    expect(linha({ kind: 'retirada_na_conferencia', detail: 'revisor', count: 1 }).texto).toBe('Barrado pelo revisor de IA. Ficou o que o sistema escreve.');
    expect(linha({ kind: 'retirada_na_conferencia', detail: 'revisor_sem_resposta', count: 1 }).texto).toBe(
      'O revisor de IA não respondeu, e sem a revisão dele o texto não aparece. Ficou o que o sistema escreve.',
    );
    // Categoria que a tela ainda não conhece junto de outra: cai no texto das regras, sem inventar.
    expect(linha({ kind: 'barrou_texto', detail: 'lia', count: 1, rules: ['tom', 'categoria_nova'] }).texto).toBe('Regra: tom, categoria nova. Ele não apareceu: ficou o que o sistema escreve.');
    expect(linha({ kind: 'retirada_na_conferencia', detail: 'numero_fora', count: 1 })).toMatchObject({
      titulo: 'Um texto não passou na conferência',
      texto: 'Citava um número que o sistema não calculou. Ficou o que o sistema escreve.',
    });
  });

  it('planos, páginas, sombra e autonomia; o que a tela não conhece vira uma linha genérica', () => {
    expect(linha({ kind: 'plano_aprovado', subject: 'Smash em dobro', mine: true }).texto).toBe('Você aprovou.');
    expect(linha({ kind: 'plano_recusado', subject: null, by: { id: uuid(8), name: 'Juliana' } })).toMatchObject({ titulo: 'Plano recusado', texto: 'Juliana recusou. Ele guardou o motivo.' });
    expect(linha({ kind: 'montou_plano', subject: 'Smash em dobro', detail: 'oferta', count: 2 }).texto).toBe('Oferta, versão 2. Nada vai ao ar sem a decisão de uma pessoa.');
    expect(linha({ kind: 'leu_pagina', subject: 'exemplo.com.br', detail: 'concorrente', count: 2 })).toMatchObject({
      titulo: 'Leu a página de exemplo.com.br',
      texto: 'Trouxe sugestões para 2 partes de Minha marca. Nada entra sem alguém confirmar.',
    });
    expect(linha({ kind: 'pagina_recusada', detail: 'robots' }).texto).toBe('O site pede para não ser lido por robôs.');
    expect(linha({ kind: 'recomendou', subject: 'Delivery noite', detail: 'orcamento_reduzir', count: 20 })).toMatchObject({
      titulo: 'Recomendou reduzir a verba em 20%: Delivery noite',
      texto: 'Em sombra: nada mudou na plataforma.',
    });
    expect(linha({ kind: 'promocao_aprovada', detail: 'orcamento_reduzir', mine: true }).titulo).toBe('Promoção aprovada: reduzir a verba');
    expect(linha({ kind: 'desligado', by: { id: uuid(8), name: 'Juliana' } }).texto).toBe('Juliana desligou. O histórico ficou guardado.');
    expect(linha({ kind: 'coisa_nova_do_servidor' }).titulo).toBe('Registrou um trabalho');
  });
});

describe('Sua equipe: a sombra e a prontidão do Gestor de tráfego', () => {
  it('cada recomendação na tabela: o que ele faria, o que a pessoa fez e o resultado', () => {
    expect(linhaDaSombra(decisao(), AGORA)).toEqual({ dia: 'hoje', campanha: 'Delivery noite', eleFaria: 'Reduzir a verba em 20%', voceFez: 'Nada ainda', resultado: 'compara em 10/10' });
    expect(linhaDaSombra(decisao({ decided_on: '2026-09-27', human_action: 'reduziu_verba', human_action_on: '2026-09-27', agreement: 'mesma_direcao', evaluate_on: '2026-10-04' }), AGORA)).toMatchObject({
      dia: '27/09',
      voceFez: 'Reduziu a verba no mesmo dia',
      resultado: 'mesma direção · compara em 04/10',
    });
    const avaliada = decisao({ status: 'avaliada', human_action: 'nenhuma', agreement: 'nenhuma', regret_label: 'teria_melhorado', regret_micros: '-18400000' });
    expect(linhaDaSombra(avaliada, AGORA)).toMatchObject({ voceFez: 'Nada', resultado: nbsp('teria rendido R$ 18,40 a mais') });
    expect(linhaDaSombra({ ...avaliada, tool: 'campanha_pausar', percent: null, regret_label: 'teria_piorado', regret_micros: '6100000' }, AGORA)).toMatchObject({
      eleFaria: 'Pausar a campanha',
      resultado: nbsp('teria rendido R$ 6,10 a menos'),
    });
    expect(linhaDaSombra(decisao({ status: 'avaliada', human_action: 'aumentou_verba', human_action_on: '2026-10-05', agreement: 'mesma_direcao', regret_label: 'sem_dado' }), AGORA)).toMatchObject({
      voceFez: 'Aumentou a verba em 05/10',
      resultado: 'mesma direção · sem como comparar',
    });
    expect(linhaDaSombra(decisao({ status: 'descartada' }), AGORA).resultado).toBe('sem como comparar');
    expect(acaoDa('orcamento_aumentar', null)).toBe('aumentar a verba');
  });

  it('a frase do Lite: recomendações do mês, mesma direção e o resultado na soma', () => {
    const escrita = (m: TeamMember) => fraseDaSombra(m, 'outubro').partes.map((p) => p.texto).join('');
    const cheio = membro('trafego', { stats: [stat('recomendacoes', 26), stat('comparaveis', 22), stat('mesma_direcao', 19), stat('arrependimento', '-41200000', 'brl_micros')] });
    expect(escrita(cheio)).toBe(nbsp('Em outubro, ele recomendou 26 ações. Das 22 que já dá para comparar, em 19 você fez o mesmo ou foi na mesma direção. Na soma, as recomendações dele teriam rendido R$ 41,20 a mais do que o que foi feito.'));
    expect(escrita(membro('trafego', { stats: [stat('recomendacoes', 2)] }))).toBe('Em outubro, ele recomendou 2 ações. Ainda não dá para comparar nenhuma: a comparação sai 7 dias depois de cada recomendação.');
    expect(escrita(membro('trafego'))).toContain('ainda não recomendou nada');
  });

  it('a última rodada: o dia, a versão das regras e o que foi registrado', () => {
    const r = rodadaDa(sombra([decisao(), decisao({ id: uuid(51), decided_on: '2026-09-27' })]), AGORA)!;
    expect(r).toMatchObject({ dia: 'hoje', nota: 'regras da sombra, versão 1', aviso: null });
    expect(r.passos[2]!.texto).toBe('Registrou 1 recomendação, sem mexer em nada');
    expect(rodadaDa(sombra([], { last_run: { on: '2026-10-02', status: 'dado_velho', at: '2026-10-03T09:31:00.000Z' } }), AGORA)).toMatchObject({ dia: '02/10', aviso: expect.stringContaining('os dados das contas não estavam em dia') });
    expect(rodadaDa(sombra([], { last_run: null }), AGORA)).toBeNull();
  });

  it('os cinco portões, com o valor de agora e o que falta', () => {
    const a = autonomiaItem();
    expect(alvoDe(a)).toBe('Meta Ads · Reduzir a verba');
    expect(portoesDe(a, LIMITES).map((p) => [p.chave, p.valor, p.passou])).toEqual([
      ['amostra', '22 de 30', false],
      ['concordancia', '86% (mín. 80%)', true],
      ['piora', '5% (máx. 10%)', true],
      ['arrependimento', nbsp('R$ 41,20 melhor que você'), true],
      ['confianca', '76,4% (mín. 70%)', true],
    ]);
    // Antes da primeira decisão avaliada não há retrato: nenhum portão passou.
    expect(portoesDe(autonomiaItem({ readiness: null }), LIMITES).every((p) => !p.passou)).toBe(true);
    expect(porcento(null)).toBe('—');
  });
});

describe('Sua equipe: a tela', () => {
  it('Lite: a lista em grupos, o detalhe do escolhido, o custo em reais com a fonte e só o acontecimento mais recente', () => {
    const t = equipe({}, { analista: { cost: { usd_micros: '1310000', calls: 52 }, stats: [stat('explicacoes', 52), stat('fez_sentido', 34), stat('discordo', 3)] } });
    const html = desenhar({
      t,
      escolhido: 'analista',
      historicos: { analista: historico([item({ kind: 'explicou_resultados', mine: true, feedback: 'fez_sentido' }), item({ kind: 'explicou_aviso', at: '2026-10-02T12:00:00.000Z' })]) },
    });
    expect(html).toContain('Trabalhando para você');
    expect(html).toContain('Chegam nas próximas fases');
    expect(html).toContain('Na fase A4');
    expect(html).toContain('aria-current="true"');
    expect(html).toContain('Modo: Explica');
    expect(html).toContain('Custo em outubro');
    expect(html).toContain(nbsp('R$ 6,84'));
    expect(html).toContain('PTAX de venda do Banco Central de 02/10/2026');
    expect(html).toContain('Modelos de IA: automático');
    expect(html).toContain('Explicou os resultados');
    // No Lite, só o mais recente, com o caminho para o resto.
    expect(html).not.toContain('Explicou um aviso da Atenção');
    expect(html).toContain('Ver tudo no Pro');
    expect(html).toContain('Desligar este funcionário');
    expect(html).toContain('Parar a equipe');
  });

  it('Pro: o histórico inteiro; o Compliance não desliga; quem só vê não tem os botões', () => {
    const html = desenhar({
      modo: 'pro',
      escolhido: 'analista',
      historicos: { analista: historico([item({ kind: 'explicou_resultados' }), item({ kind: 'explicou_aviso', at: '2026-10-02T12:00:00.000Z' })], true) },
    });
    expect(html).toContain('Explicou um aviso da Atenção');
    expect(html).toContain('Aqui estão os 2 acontecimentos mais recentes dos últimos 90 dias.');
    expect(html).not.toContain('Modelos de IA: automático');
    expect(desenhar({ escolhido: 'compliance' })).toContain('O Compliance não desliga');
    const soVe = desenhar({ t: equipe({ can_manage: false, can_stop: false }), escolhido: 'analista' });
    expect(soVe).not.toContain('Desligar este funcionário');
    expect(soVe).not.toContain('Parar a equipe');
  });

  it('confirmações na linha: parar a equipe e desligar um funcionário, com o motivo opcional', () => {
    const parar = desenhar({ parando: true });
    expect(parar).toContain('Para todos os funcionários de IA agora, em todas as marcas da empresa.');
    expect(parar).toContain('btn--perigo-cheio');
    const desligar = desenhar({ escolhido: 'pesquisador', desligando: 'pesquisador' });
    expect(desligar).toContain('Desligar Pesquisador nesta marca? Ele para de trabalhar e de custar; o histórico fica guardado.');
    expect(desligar).toContain('Motivo (opcional)');
  });

  it('equipe parada, IA desligada e funcionário desligado', () => {
    const parada = { id: uuid(80), level: 'tenant', by_company: true, since: '2026-10-03T17:22:00.000Z', reason: 'x', by: { id: uuid(9), name: 'Rodrigo' } };
    const parado = desenhar({ t: equipe({ stop: parada }, { lia: { status: 'parado' } }) });
    expect(parado).toContain('A equipe está parada desde');
    expect(parado).toContain('Retomar a equipe');
    expect(parado).not.toContain('eqp-bt-parar');
    const semIa = desenhar({ t: equipe({ ai: { enabled: false, spent_usd_micros: '0', ceiling_usd_micros: '20000000', band: 'livre' } }, { lia: { status: 'desligado_pela_liame' } }) });
    expect(semIa).toContain('A IA está desligada nesta empresa');
    expect(semIa).toContain('Desligado pela Liame');
    expect(semIa).not.toContain('Parar a equipe');
    expect(semIa).not.toContain('Desligar este funcionário');
    const pausa = { by: { id: uuid(9), name: 'Rodrigo' }, at: '2026-09-30T21:20:00.000Z', reason: 'não quero que ele leia o site dos concorrentes por enquanto' };
    const desligado = desenhar({ t: equipe({}, { pesquisador: { status: 'desligado', paused: pausa } }), escolhido: 'pesquisador' });
    expect(desligado).toContain('Desligados');
    expect(desligado).toContain('Desligado por Rodrigo em');
    expect(desligado).toContain('Motivo: &quot;não quero que ele leia o site dos concorrentes por enquanto&quot;');
    expect(desligado).toContain('Ligar de novo');
    expect(desligado).toContain('Modo: Desligado');
  });

  it('funcionário de uma fase seguinte: entra depois, não trabalha ainda', () => {
    const html = desenhar({ escolhido: 'criativo' });
    expect(html).toContain('Ele entra na fase <b>A4</b> do roadmap. Até lá, não trabalha para a Mister Burgers.');
    expect(html).not.toContain('O que fez');
  });

  it('Gestor de tráfego no Lite: a frase da sombra e o que falta; no Pro, a rodada, a tabela e os portões', () => {
    const t = equipe({}, { trafego: { stats: [stat('recomendacoes', 26), stat('comparaveis', 22), stat('mesma_direcao', 19), stat('arrependimento', '-41200000', 'brl_micros')] } });
    const a = autonomia([autonomiaItem(), autonomiaItem({ tool: 'campanha_pausar', action: 'campanha.pausar', readiness: null })]);
    const s = sombra([decisao()]);
    const lite = desenhar({ t, autonomia: a, sombra: s, escolhido: 'trafego' });
    expect(lite).toContain('Em outubro, ele recomendou ');
    expect(lite).toContain('<b>Ainda não.</b>');
    // Só a amostra falta: quatro portões passaram.
    expect(lite).toContain('4 de 5');
    expect(lite).toContain('faltam <b>8</b> decisões comparáveis');
    expect(lite).not.toContain('<table');
    expect(lite).toContain('Nunca, nesta fase:');
    const pro = desenhar({ t, autonomia: a, sombra: s, escolhido: 'trafego', modo: 'pro' });
    expect(pro).toContain('Rodada de hoje');
    expect(pro).toContain('Recomendações em sombra, o que você fez e o resultado');
    expect(pro).toContain('Prontidão por conta e por ação');
    expect(pro).toContain('aria-label="4 de 5 portões"');
    expect(pro).toContain('Falta:');
    expect(pro).toContain('Meta Ads · Pausar a campanha');
  });

  it('a promoção: a proposta com aprovar e recusar; aprovada, com o caminho de volta; quem não decide só lê', () => {
    const proposta = { id: uuid(90), status: 'pendente', from_mode: 'SHADOW' as const, to_mode: 'SUGGEST' as const, sample_size: 31, proposed_at: '2026-10-03T09:31:00.000Z', decided_by: null, decided_at: null, policy_version: null, undone_by: null, undone_at: null, reason: null, next_sample_size: null };
    const pronto = autonomiaItem({ readiness: { computed_on: '2026-10-03', rule_version: 1, sample_size: 31, agreement_pct: '84.0', worse_pct: '6.0', regret_sum_micros: '-58900000', confidence_avg_pct: '77.0', missing: [] }, proposal: proposta });
    const pendente = desenhar({ autonomia: autonomia([pronto]), escolhido: 'trafego' });
    expect(pendente).toContain('Proposta do sistema: Meta Ads · Reduzir a verba, de Sombra para Sugerir');
    expect(pendente).toContain('Aprovar a promoção');
    expect(pendente).toContain('Quem decide é você');
    const recusando = desenhar({ autonomia: autonomia([pronto]), escolhido: 'trafego', recusando: proposta.id });
    expect(recusando).toContain('Recusar a promoção? Ele segue em sombra nessa ação.');
    const semDecidir = desenhar({ autonomia: autonomia([pronto], false), escolhido: 'trafego' });
    expect(semDecidir).not.toContain('Aprovar a promoção');
    expect(semDecidir).toContain('Quem decide é o Dono ou o Administrador.');

    const aprovada = { ...proposta, status: 'aprovada', decided_by: { id: uuid(9), name: 'Rodrigo' }, decided_at: '2026-10-03T17:22:00.000Z', policy_version: 2 };
    const emSugerir = desenhar({ autonomia: autonomia([{ ...pronto, mode: 'SUGGEST', mode_source: { policy: 'marca', version: 2 }, proposal: aprovada }]), escolhido: 'trafego' });
    expect(emSugerir).toContain('Meta Ads · Reduzir a verba está em Sugerir');
    expect(emSugerir).toContain('regra de autonomia, versão 2');
    expect(emSugerir).toContain('Voltar para sombra');
    expect(emSugerir).toContain('Modo: Sombra e Sugerir');

    const recusada = { ...proposta, status: 'recusada', decided_by: { id: uuid(9), name: 'Rodrigo' }, decided_at: '2026-10-03T17:22:00.000Z', next_sample_size: 61 };
    const depois = desenhar({ autonomia: autonomia([{ ...pronto, proposal: recusada }]), escolhido: 'trafego' });
    expect(depois).toContain('Promoção recusada por Rodrigo');
    expect(depois).toContain('O sistema só propõe de novo com 61 decisões comparáveis.');
  });

  it('a prontidão e a lista da sombra que não carregaram não derrubam a tela', () => {
    const html = desenhar({ autonomia: null, sombra: null, escolhido: 'trafego', modo: 'pro' });
    expect(html).toContain('Não foi possível carregar a prontidão.');
    expect(html).toContain('Não foi possível carregar a lista das recomendações.');
    expect(desenhar({ escolhido: 'lia', historicos: { lia: { tipo: 'erro' } } })).toContain('Não foi possível carregar o histórico.');
  });
});

describe('menu: "Sua equipe" depois de Resultados, para quem acompanha as campanhas, com Lite e Pro', () => {
  const agencia = NAVEGACAO.find((g) => g.id === 'agencia')!;

  it('o item, a permissão e o título', () => {
    const i = agencia.itens.findIndex((x) => x.href === '/equipe');
    expect(agencia.itens[i - 1]!.href).toBe('/resultados');
    expect(agencia.itens[i]).toEqual({ href: '/equipe', rotulo: 'Sua equipe', icone: 'users', permissao: 'campanhas.ver', modos: true });
    expect(itensVisiveis(agencia, (p) => p !== 'campanhas.ver', 'lite').map((x) => x.href)).not.toContain('/equipe');
    expect(tituloDa('/equipe')).toBe('Sua equipe');
    expect(temModos('/equipe', () => true)).toBe(true);
  });
});

describe('Sua equipe: "Conversar sobre ele" (P7)', () => {
  it('a pergunta que abre a conversa já fala do funcionário, com o nome da tela', () => {
    expect(perguntaSobre('analista')).toBe('Quero falar sobre o trabalho do Analista de dados: o que ele fez este mês?');
    expect(perguntaSobre('relatorios')).toBe('Quero falar sobre o trabalho de Relatórios: o que ele fez este mês?');
    expect(perguntaSobre('trafego')).toBe('Quero falar sobre o trabalho do Gestor de tráfego: o que ele fez este mês?');
  });

  it('o botão aparece para quem conversa com a LIA, com ela ativa; sobre a própria LIA, não', () => {
    const t = equipe();
    expect(podeConversarSobre('analista', t, true)).toBe(true);
    expect(podeConversarSobre('compliance', t, true)).toBe(true);
    expect(podeConversarSobre('lia', t, true)).toBe(false);
    // Sem a conversa (quem não tem `conversa.usar`, ou fora do shell), com a IA desligada ou com a LIA desligada nesta marca.
    expect(podeConversarSobre('analista', t, false)).toBe(false);
    expect(podeConversarSobre('analista', equipe({ ai: { ...t.ai, enabled: false } }), true)).toBe(false);
    expect(podeConversarSobre('analista', equipe({}, { lia: { status: 'desligado' } }), true)).toBe(false);
  });

  it('na tela: ao lado de desligar; no Compliance, antes da nota; sem a conversa, a tela fica como era', () => {
    const analista = desenhar({ escolhido: 'analista', comConversa: true });
    expect(analista).toContain('id="eqp-bt-conversar"');
    expect(analista).toContain('Conversar sobre ele');
    expect(analista.indexOf('Conversar sobre ele')).toBeLessThan(analista.indexOf('Desligar este funcionário'));
    const compliance = desenhar({ escolhido: 'compliance', comConversa: true });
    expect(compliance.indexOf('Conversar sobre ele')).toBeLessThan(compliance.indexOf('O Compliance não desliga'));
    expect(desenhar({ escolhido: 'lia', comConversa: true })).not.toContain('Conversar sobre ele');
    expect(desenhar({ escolhido: 'analista' })).not.toContain('Conversar sobre ele');
    // Confirmando o desligamento, a linha é só da confirmação.
    expect(desenhar({ escolhido: 'analista', comConversa: true, desligando: 'analista' })).not.toContain('Conversar sobre ele');
  });
});
