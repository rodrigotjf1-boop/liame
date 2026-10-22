import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { MonthlyReport, type MonthlyReportBudget, type MonthlyReportBudgetChange, type MonthlyReportTeam, type MonthlyReportWeek, type WeeklyReview } from '@liame/contracts';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { semanasDoMes } from '@/components/relatorio/graficos';
import { RelatorioConteudo } from '@/components/relatorio/relatorio-conteudo';
import {
  avisoDaLeituraDoMes,
  custoDoMes,
  envioDoRelatorio,
  equipeDoMes,
  introDoRelatorio,
  mesEscrito,
  mesQueFecha,
  mesValido,
  mudancaDoMes,
  naData,
  noMomento,
  nomeDoMes,
  notaDoCorte,
  periodoDoMes,
  semMesAnterior,
  verbaNaTela,
} from '@/components/relatorio/textos';
import { campanhasDaRevisao, numerosDoPeriodo } from '@/components/revisao/graficos';
import { destinoDaDecisao } from '@/components/revisao/textos';
import { temModos, tituloDa } from '@/components/shell/navegacao';
import { AvisosProvider } from '@/components/ui/avisos';

// "Relatório do mês" (A3 · I7; mockups/prototipo-relatorio-mes.html, P24 aprovado em 21/10/2026): as regras de escrita
// da tela, os desenhos que só o mês tem e a tela desenhada pelo mesmo componente do navegador. As partes que o mês
// divide com a revisão da semana (os números do topo, a leitura, as campanhas e o que mudou) vêm da revisão guardada que
// o servidor usa nos testes dele; o resto (as semanas, a verba e a equipe) é deste arquivo, e o relatório inteiro passa
// pelo contrato antes de ir para a tela.

const FUSO = 'America/Sao_Paulo';
const guardada = JSON.parse(readFileSync(resolve(process.cwd(), '../server/test/fixtures/revisao-semanal/v1.json'), 'utf8')) as Omit<WeeklyReview, 'id' | 'email'>;
const MARCA = guardada.brand_id;
const nbsp = (s: string) => s.replaceAll('R$ ', `R$${String.fromCharCode(160)}`);
const tudoPode = () => true;

const semana = (w: Pick<MonthlyReportWeek, 'from' | 'to' | 'days' | 'week'> & Partial<MonthlyReportWeek>): MonthlyReportWeek => ({
  has_review: true,
  spend_micros: '0',
  orders: 0,
  revenue_micros: '0',
  roas: null,
  verdict: null,
  ...w,
});
/** Setembro de 2026: começa numa terça-feira e termina numa quarta, e por isso as semanas das pontas ficam cortadas. */
const SEMANAS: MonthlyReportWeek[] = [
  semana({ from: '2026-09-01', to: '2026-09-06', days: 6, week: { from: '2026-08-31', to: '2026-09-06' }, spend_micros: '900000000', orders: 30, revenue_micros: '2700000000', roas: '3.00', verdict: 'lucro' }),
  semana({ from: '2026-09-07', to: '2026-09-13', days: 7, week: { from: '2026-09-07', to: '2026-09-13' }, spend_micros: '1000000000', orders: 40, revenue_micros: '3500000000', roas: '3.50', verdict: 'lucro' }),
  semana({ from: '2026-09-14', to: '2026-09-20', days: 7, week: { from: '2026-09-14', to: '2026-09-20' }, spend_micros: '1100000000', roas: '0.00', verdict: 'prejuizo' }),
  semana({ from: '2026-09-21', to: '2026-09-27', days: 7, week: { from: '2026-09-21', to: '2026-09-27' }, spend_micros: '1214300000', orders: 53, revenue_micros: '3471000000', roas: '2.86', verdict: 'empata' }),
  // A revisão da semana de 28/09 a 04/10 sai em 05/10: no dia 1º ela ainda não existe.
  semana({ from: '2026-09-28', to: '2026-09-30', days: 3, week: { from: '2026-09-28', to: '2026-10-04' }, has_review: false, spend_micros: '300000000', orders: 5, revenue_micros: '400000000', roas: '1.33', verdict: 'prejuizo' }),
];

const RODRIGO = { id: 'a0000000-0000-4000-8000-000000000071', name: 'Rodrigo' };
const mudancaDaVerba = (m: Partial<MonthlyReportBudgetChange> = {}): MonthlyReportBudgetChange => ({
  action_id: 'a0000000-0000-4000-8000-000000000081',
  executed_on: '2026-09-12',
  action: 'orcamento.aumentar',
  provider: 'meta_ads',
  target: { kind: 'conjunto', name: 'Combo sexta · Rio', campaign_name: 'Combo sexta' },
  from: { status: 'ativo', daily_micros: '50000000' },
  to: { status: 'ativo', daily_micros: '70000000' },
  requested_by: RODRIGO,
  approved_by: RODRIGO,
  agent_key: null,
  check: 'confere',
  ...m,
});
const PAUSA = mudancaDaVerba({
  action_id: 'a0000000-0000-4000-8000-000000000082',
  executed_on: '2026-09-20',
  action: 'campanha.pausar',
  target: { kind: 'campanha', name: 'Delivery noite', campaign_name: null },
  from: { status: 'ativo', daily_micros: null },
  to: { status: 'pausado', daily_micros: null },
  approved_by: null,
  check: null,
});
const VERBA: MonthlyReportBudget = { currency: 'BRL', spend_micros: '4514300000', limit_micros: '5500000000', missing: [], changes: [mudancaDaVerba(), PAUSA] };

/** Os números de Sua equipe vêm em texto, como inteiros (o contrato de `TeamStat`). */
const numero = (key: string, value: number) => ({ key, value: String(value), unit: 'qtd' });
const EQUIPE: MonthlyReportTeam = {
  members: [
    { key: 'lia', stats: [numero('respostas', 12), numero('fez_sentido', 3), numero('discordo', 0), numero('demandas', 0)] },
    { key: 'relatorios', stats: [numero('revisoes', 4), numero('com_leitura_da_ia', 3), numero('so_do_sistema', 1)] },
    { key: 'compliance', stats: [numero('textos_conferidos', 40), numero('textos_barrados', 0)] },
    // Um funcionário que a tela ainda não conhece não vira linha (V23).
    { key: 'social', stats: [numero('posts', 3)] },
  ],
  ai: { spent_usd_micros: '12500000', ceiling_usd_micros: '50000000' },
  usd_brl: { rate: '5.40', date: '2026-09-30', source: 'bcb' },
};

const relatorio = (over: Partial<MonthlyReport> = {}): MonthlyReport =>
  MonthlyReport.parse({
    id: 'a0000000-0000-4000-8000-000000000060',
    brand_id: MARCA,
    month: { from: '2026-09-01', to: '2026-09-30' },
    previous_month: { from: '2026-08-01', to: '2026-08-31' },
    timezone: guardada.timezone,
    currency: guardada.currency,
    // Na quinta-feira, 01/10, às 05:10 da loja; o e-mail, às 07:00.
    generated_at: '2026-10-01T08:10:00.000Z',
    totals: guardada.totals,
    verdict: guardada.verdict,
    weeks: SEMANAS,
    campaigns: guardada.campaigns,
    platform_only: guardada.platform_only,
    improved: guardada.improved,
    worsened: guardada.worsened,
    decisions: [{ ...guardada.decisions[0]!, kind: 'prejuizo_no_mes', title: 'Delivery noite deu prejuízo em setembro' }],
    budget: VERBA,
    team: EQUIPE,
    reading: guardada.reading,
    email: { status: 'enviado', sent_at: '2026-10-01T10:00:00.000Z', recipients: 3 },
    ...over,
  });
const doSistema = (reason: string, extra: Partial<WeeklyReview['reading']> = {}): WeeklyReview['reading'] => ({ ...guardada.reading, source: 'sistema', reason, usage_id: null, ...extra });
const desenhar = (r: MonthlyReport, pode: (p: string) => boolean = tudoPode) =>
  renderToStaticMarkup(createElement(AvisosProvider, { children: createElement(RelatorioConteudo, { relatorio: r, podeVerContas: pode('contas.ver'), pode }) }));

describe('relatório do mês: como a tela escreve o que a API manda', () => {
  it('o mês da URL só vale no formato; o nome do mês e o dia com a preposição certa (no sábado, na quinta-feira)', () => {
    expect(mesValido('2026-09')).toBe('2026-09');
    for (const errado of ['2026-13', '2026-00', '2026-9', '2026-09-01', 'setembro', '', null]) expect(mesValido(errado)).toBeNull();
    expect(nomeDoMes('2026-09-01')).toBe('setembro');
    expect(nomeDoMes('2026-12-31')).toBe('dezembro');
    expect(mesEscrito('2026-03-01')).toBe('Março de 2026');
    expect(naData('2026-11-01')).toBe('no domingo, 01/11');
    expect(naData('2026-08-01')).toBe('no sábado, 01/08');
    expect(naData('2026-10-01')).toBe('na quinta-feira, 01/10');
    expect(noMomento('2026-10-01T08:10:00.000Z', FUSO)).toBe('na quinta-feira, 01/10, às 05:10');
    // O relatório do dia 1º fecha o mês anterior, também na virada do ano.
    expect(mesQueFecha('2026-11-01')).toBe('2026-10-01');
    expect(mesQueFecha('2027-01-01')).toBe('2026-12-01');
  });

  it('os números do topo e as campanhas falam do mês: setembro contra agosto, "no mês"', () => {
    const r = relatorio();
    expect(periodoDoMes(r)).toEqual({
      agora: '01/09 a 30/09',
      antes: '01/08 a 31/08',
      noAgora: 'em setembro',
      noAntes: 'em agosto',
      dicaAgora: 'setembro',
      dicaAntes: 'agosto',
      igual: 'igual ao mês anterior',
      noPeriodo: 'no mês',
    });
    const [, pedidos] = numerosDoPeriodo(r.totals, periodoDoMes(r));
    expect(pedidos!.bala!.rotulo).toBe('Pedidos de anúncios: 53 em setembro; 47 em agosto.');
    expect(pedidos!.bala!.dicaAgora).toBe('53|setembro · 01/09 a 30/09');
    expect(pedidos!.bala!.dicaAntes).toBe('47|agosto · 01/08 a 31/08');
    const igual = numerosDoPeriodo([{ ...r.totals[1]!, before: '53', change_pct: '0.0' }], periodoDoMes(r));
    expect(igual[0]!.mudou).toEqual({ texto: 'igual ao mês anterior', tom: 'neutro', seta: null });
    const semPedido = campanhasDaRevisao({ campaigns: [{ ...r.campaigns[0]!, orders: 0, revenue_micros: '0', roas: '0.00' }], platform_only: [] }, 'no mês');
    expect(semPedido.linhas[0]!.sub).toBe('Meta Ads · sem pedido no mês');
    expect(semPedido.linhas[0]!.investido.dica).toBe(nbsp('R$ 404,10|investido no mês'));
  });

  it('a linha do envio diz para quantas pessoas e quando, ou por que o e-mail não saiu; a frase do topo fala do e-mail só quando ele vai', () => {
    const email = (status: string, recipients = 3): MonthlyReport['email'] => ({ status, sent_at: status === 'enviado' ? '2026-10-01T10:00:00.000Z' : null, recipients });
    expect(envioDoRelatorio(email('enviado'), FUSO)).toBe('Enviado por e-mail na quinta-feira, 01/10, às 07:00, para 3 pessoas.');
    expect(envioDoRelatorio(email('enviado', 1), FUSO)).toBe('Enviado por e-mail na quinta-feira, 01/10, às 07:00, para 1 pessoa.');
    expect(envioDoRelatorio(email('pendente'), FUSO)).toBe('O e-mail deste relatório ainda não saiu: ele sai a partir das 07:00.');
    expect(envioDoRelatorio(email('desligado'), FUSO)).toBe('O envio por e-mail não está ligado nesta empresa: o relatório fica só aqui.');
    expect(envioDoRelatorio(email('sem_destinatario'), FUSO)).toBe('Ninguém recebeu por e-mail: na empresa, ninguém com o nível que recebe confirmou o e-mail.');
    expect(envioDoRelatorio(email('falhou'), FUSO)).toBe('O envio por e-mail não chegou a ninguém: o relatório fica só aqui.');
    expect(envioDoRelatorio(email('expirado'), FUSO)).toBe('O prazo do e-mail (até o dia 7) passou sem dar para enviar: o relatório fica só aqui.');
    expect(envioDoRelatorio(email('outra_coisa'), FUSO)).toBeNull();
    expect(introDoRelatorio(email('enviado'))).toMatch(/, na tela e por e-mail\.$/);
    expect(introDoRelatorio(email('desligado'))).toMatch(/Sai no dia 1º de manhã\.$/);
    expect(introDoRelatorio(null)).toMatch(/Sai no dia 1º de manhã\.$/);
  });

  it('semana a semana: uma régua só para as semanas, o link da revisão só quando ela existe e a nota das semanas cortadas', () => {
    const [primeira, segunda, terceira, , ultima] = semanasDoMes(relatorio());
    expect([primeira, segunda, terceira, ultima].map((w) => [w!.nome, w!.sub])).toEqual([
      ['01/09 a 06/09', '6 dias · 30 pedidos'],
      ['07/09 a 13/09', '7 dias · 40 pedidos'],
      ['14/09 a 20/09', '7 dias · sem pedido'],
      ['28/09 a 30/09', '3 dias · 5 pedidos'],
    ]);
    // A régua é o maior valor das semanas (R$ 3.500,00 no caixa da segunda): ela vai até o fim, e as outras na proporção.
    expect(segunda!.caixa.largura).toBe(100);
    expect(primeira!.investido.largura).toBe(25.71);
    // Sem pedido, a barra do caixa não aparece, e o selo diz "Sem pedido" no lugar do veredito.
    expect(terceira!.caixa.largura).toBe(0);
    expect(terceira!.selo).toEqual({ rotulo: 'Sem pedido', classe: 'neutro' });
    expect(primeira!.selo).toEqual({ rotulo: 'Dá lucro', classe: 'bom' });
    expect(primeira!.revisao).toEqual({ href: `/resultados/revisao?marca=${MARCA}&semana=2026-08-31`, rotulo: 'Ver a revisão de 31/08 a 06/09' });
    expect(ultima!.revisao).toBeNull();
    expect(segunda!.rotulo).toBe(nbsp('De 07/09 a 13/09: R$ 1.000,00 investidos e R$ 3.500,00 no caixa, em 40 pedidos.'));
    expect(terceira!.rotulo).toBe(nbsp('De 14/09 a 20/09: R$ 1.100,00 investidos e nenhum pedido confirmado no caixa.'));
    expect(segunda!.caixa.dica).toBe(nbsp('R$ 3.500,00|confirmado no caixa · ROAS 3,50'));

    expect(notaDoCorte(SEMANAS)).toBe(
      'As semanas das pontas estão cortadas no mês: a de 01/09 a 06/09 começou na segunda-feira, 31/08, e a de 28/09 a 30/09 termina no domingo, 04/10. A revisão de cada uma tem a semana inteira.',
    );
    // Um mês que começa na segunda-feira só tem a última cortada; sem ponta cortada, a nota não aparece.
    expect(notaDoCorte(SEMANAS.slice(1))).toBe('As semanas das pontas estão cortadas no mês: a de 28/09 a 30/09 termina no domingo, 04/10. A revisão de cada uma tem a semana inteira.');
    expect(notaDoCorte(SEMANAS.slice(1, 4))).toBeNull();
  });

  it('a verba do mês: dentro do teto, acima dele e sem teto, na mesma régua; e a plataforma que não foi lida até o fim do mês', () => {
    const dentro = verbaNaTela(VERBA);
    expect(dentro).toMatchObject({ gasto: nbsp('R$ 4.514,30'), teto: nbsp('R$ 5.500,00'), doTeto: nbsp('de R$ 5.500,00 · 82% do teto'), acima: false, barra: { gasto: 82.07, teto: 100 }, atrasadas: null });
    expect(dentro.frase).toBe(nbsp('Ficou dentro do teto: sobraram R$ 985,70.'));
    expect(dentro.falado).toBe(nbsp('Gasto do mês: R$ 4.514,30, 82% do teto de R$ 5.500,00.'));
    // Acima do teto, a régua é o gasto, e a marca do teto fica antes do fim.
    const acima = verbaNaTela({ ...VERBA, spend_micros: '6000000000' });
    expect(acima).toMatchObject({ acima: true, doTeto: nbsp('de R$ 5.500,00 · 109% do teto'), barra: { gasto: 100, teto: 91.66 } });
    expect(acima.frase).toBe(nbsp('Passou do teto em R$ 500,00. Com o gasto acima do teto, o Liame não aprova aumento de verba nem retomada, e não pausa nada sozinho.'));
    expect(verbaNaTela({ ...VERBA, limit_micros: null })).toMatchObject({ teto: null, doTeto: null, barra: null, frase: null, falado: null });
    expect(verbaNaTela({ ...VERBA, missing: ['google_ads'] }).atrasadas).toBe('O gasto do Google Ads vale até a última leitura, que não chegou ao fim do mês.');
    expect(verbaNaTela({ ...VERBA, missing: ['meta_ads', 'google_ads'] }).atrasadas).toBe('O gasto da Meta e do Google Ads vale até a última leitura, que não chegou ao fim do mês.');
  });

  it('as mudanças do mês: o que mudou, quem aprovou e quando, e como a conferência ficou', () => {
    expect(mudancaDoMes(mudancaDaVerba())).toEqual({
      titulo: nbsp('Conjunto “Combo sexta · Rio”: verba de R$ 50,00 para R$ 70,00'),
      sub: 'Aprovado por Rodrigo em 12/09, com o código do app, e conferido com a Meta.',
      icone: 'trend-up',
    });
    expect(mudancaDoMes(PAUSA)).toEqual({ titulo: 'Delivery noite pausada', sub: 'Pedido por Rodrigo, feito em 20/09.', icone: 'pause' });
    expect(mudancaDoMes(mudancaDaVerba({ to: { status: 'ativo', daily_micros: '40000000' }, check: 'mudou' })).sub).toBe(
      'Aprovado por Rodrigo em 12/09, com o código do app; depois, a Meta mostrou outra situação.',
    );
    expect(mudancaDoMes(mudancaDaVerba({ to: { status: 'ativo', daily_micros: '40000000' } })).icone).toBe('trend-down');
    // Conferência que a tela não conhece não vira frase.
    expect(mudancaDoMes(mudancaDaVerba({ check: 'outra' })).sub).toBe('Aprovado por Rodrigo em 12/09, com o código do app.');
  });

  it('o que a equipe fez: os números principais de cada um (o primeiro sempre, os outros acima de zero) e o custo de IA', () => {
    expect(equipeDoMes(EQUIPE)).toEqual([
      { chave: 'lia', nome: 'LIA', cargo: 'Atendimento', icone: 'lia', feito: [{ valor: '12', texto: 'respostas na Conversa' }] },
      {
        chave: 'relatorios',
        nome: 'Relatórios',
        cargo: 'Revisão da semana',
        icone: 'file',
        feito: [
          { valor: '4', texto: 'revisões da semana' },
          { valor: '3', texto: 'com a leitura da LIA' },
        ],
      },
      {
        chave: 'compliance',
        nome: 'Compliance',
        cargo: 'Marca, lei e políticas',
        icone: 'shield',
        feito: [
          { valor: '0', texto: 'textos barrados antes de aparecer' },
          { valor: '40', texto: 'textos conferidos' },
        ],
      },
    ]);
    expect(custoDoMes(EQUIPE)).toEqual({ valor: nbsp('R$ 67,50'), doTeto: '25%' });
    expect(custoDoMes({ ...EQUIPE, usd_brl: null }).valor).toBe(`US$${String.fromCharCode(160)}12,50`);
    expect(custoDoMes({ ...EQUIPE, ai: { spent_usd_micros: '12500000', ceiling_usd_micros: '0' } }).doTeto).toBeNull();
  });

  it('sem a leitura da LIA, o aviso tem os títulos do relatório; "Para o mês que vem" leva o prejuízo do mês aos Resultados', () => {
    expect(avisoDaLeituraDoMes(guardada.reading)).toBeNull();
    expect(avisoDaLeituraDoMes(doSistema('dado_velho'))).toMatchObject({ titulo: 'O relatório saiu sem a leitura da LIA', acao: 'ver-conexao' });
    expect(avisoDaLeituraDoMes(doSistema('limite'))).toMatchObject({ titulo: 'O relatório deste mês saiu sem a leitura da LIA', acao: null });
    expect(destinoDaDecisao({ kind: 'prejuizo_no_mes' }, tudoPode)).toEqual({ href: '/resultados', rotulo: 'Ver em Resultados' });
    expect(semMesAnterior(relatorio())).toBe(false);
    expect(semMesAnterior({ totals: guardada.totals.map((m) => ({ ...m, before: null, change_pct: null })) })).toBe(true);
  });

  it('na trilha, "Resultados · Relatório do mês", sem o seletor de visão', () => {
    expect(tituloDa('/resultados/relatorio')).toBe('Resultados · Relatório do mês');
    expect(temModos('/resultados/relatorio', tudoPode)).toBe(false);
  });
});

describe('relatório do mês: a tela desenhada', () => {
  it('desenha o mês inteiro, na ordem do protótipo, com o envio, a hora em que saiu e os links das revisões', () => {
    const html = desenhar(relatorio());
    const ordem = [
      'Voltar aos Resultados',
      'Enviado por e-mail na quinta-feira, 01/10, às 07:00, para 3 pessoas.',
      'aria-label="Números do mês"',
      'Leitura do mês, pela LIA',
      'Semana a semana',
      'O que cada campanha trouxe no caixa',
      'O que melhorou',
      'O que piorou',
      'A verba do mês',
      'O que a equipe fez em setembro',
      'Para o mês que vem',
    ].map((t) => html.indexOf(t));
    expect(ordem.every((i) => i >= 0)).toBe(true);
    expect([...ordem].sort((a, b) => a - b)).toEqual(ordem);
    expect(html).toContain('com os números deste relatório · gerada na quinta-feira, 01/10, às 05:10');
    expect(html).toContain('agosto: <b class="num">47</b>');
    expect(html).toContain(`href="/resultados/revisao?marca=${MARCA}&amp;semana=2026-08-31"`);
    expect(html).not.toContain('Ver a revisão de 28/09 a 04/10');
    expect(html).toContain('aria-label="Campanhas de setembro"');
    expect(html).toContain('aria-label="Semanas de setembro"');
    expect(html).toContain('As semanas das pontas estão cortadas no mês');
    // A verba: o gasto contra o teto, as duas mudanças e a Verba do mês; a equipe: quem trabalhou e o custo.
    expect(html).toContain('Dentro do teto');
    expect(html).toContain('O que o Liame mudou nas campanhas em setembro');
    expect(html).toContain('Delivery noite pausada');
    expect(html).toContain('>Ver a Verba do mês<');
    expect(html).toContain('respostas na Conversa');
    expect(html).not.toContain('posts');
    expect(html).toContain('Ver Sua equipe');
    expect(html).toContain('Delivery noite deu prejuízo em setembro');
    expect(html).toContain('href="/resultados"');
  });

  it('quem não vê a Verba do mês e Sua equipe (ou o relatório de antes deles) não tem os dois cartões', () => {
    const { budget: _verba, team: _equipe, ...semEles } = relatorio();
    const html = desenhar(semEles);
    expect(html).not.toContain('A verba do mês');
    expect(html).not.toContain('O que a equipe fez');
    expect(html).toContain('Para o mês que vem');
  });

  it('sem teto: diz quem define, e o botão de definir só aparece para quem pode', () => {
    const semTeto = relatorio({ budget: { ...VERBA, limit_micros: null, changes: [] } });
    const doDono = desenhar(semTeto);
    expect(doDono).toContain('Esta empresa não tem teto do mês. Quem define é o Dono ou o Administrador, na Verba do mês');
    expect(doDono).toContain('>Definir o teto do mês<');
    expect(doDono).toContain('O Liame não mudou nada nas campanhas em setembro.');
    expect(doDono).not.toContain('Dentro do teto');
    const doGestor = desenhar(semTeto, (p) => p !== 'orcamento.gerenciar');
    expect(doGestor).not.toContain('Definir o teto do mês');
    expect(doGestor).toContain('>Ver a Verba do mês<');
  });

  it('o primeiro mês: sem mês anterior para comparar, nem nos números nem no que mudou', () => {
    const html = desenhar(relatorio({ totals: guardada.totals.map((m) => ({ ...m, before: null, change_pct: null })), improved: [], worsened: [], decisions: [] }));
    expect(html.split('sem mês anterior para comparar').length - 1).toBe(4);
    expect(html.split('Sem mês anterior para comparar: este é o primeiro mês com as vendas conectadas.').length - 1).toBe(2);
    expect(html).not.toContain('rev-chave');
    expect(html).toContain('Nada pede decisão para o mês que vem.');
  });
});
