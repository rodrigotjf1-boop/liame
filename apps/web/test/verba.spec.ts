import type { BudgetMonthChange, BudgetMonthDay, BudgetMonthPlatform, BudgetMonthResponse } from '@liame/contracts';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { acaoDoAviso, destinoDoAviso, destinoPedeVendas } from '@/components/atencao/textos';
import { textoDe } from '@/components/resultados/textos';
import { Fontes, textoCorrido } from '@/components/resumo/textos';
import { itensVisiveis, NAVEGACAO, temModos, tituloDa } from '@/components/shell/navegacao';
import { Icone } from '@/components/ui/icone';
import { desenhosDaVerba, diasLidos, mesDesenhado, ondeOGastoFoi, passoDaGrade, reaisCurtos, vereditoDaVerba } from '@/components/verba/graficos';
import {
  avisosDaVerba,
  barraDaVerba,
  conferirLimites,
  diaQuePassaDoTeto,
  erroAoSalvarLimites,
  fonteDoGasto,
  fraseDaVerba,
  heroiDaVerba,
  lidoDaVerba,
  limitesDaVerba,
  linhaDaMudanca,
  mesDaVerba,
  mudancasDaVerba,
  oQueMudou,
  plataformasDaVerba,
  reaisDigitados,
  reaisParaOCampo,
  telaDaVerba,
  verbaNoResumo,
} from '@/components/verba/textos';
import { VerbaConteudo } from '@/components/verba/verba-conteudo';
import { ModoProvider } from '@/lib/modo';

// "Verba do mês" (A4 · P9, aprovado em 05/10/2026; mockups/prototipo-anuncios.html): quanto a empresa pode gastar em
// anúncios, quanto já gastou, os dois limites e o que o Liame mudou. As frases e os números saem do que a API manda
// (`GET /v1/budget/month`); a tela é desenhada pelo mesmo componente do navegador. O cenário é o do protótipo:
// setembro, terça 29/09, com a Meta e o Google lidos de manhã. Os desenhos do cartão do mês são os do protótipo
// `mockups/prototipo-verba-graficos.html` (aprovado em 07/10/2026).

const FUSO = 'America/Sao_Paulo';
const AGORA = new Date('2026-09-29T17:40:00Z'); // terça, 14:40 em São Paulo
const nbsp = (s: string) => s.replaceAll('R$ ', `R$${String.fromCharCode(160)}`);
const uuid = (n: number) => `a0000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
/** Reais (com centavos) em micros, sem ponto flutuante na conta. */
const r = (reais: number) => Math.round(reais * 100) * 10_000;

const plataformaDoMes = (provider: string, over: Partial<BudgetMonthPlatform> = {}): BudgetMonthPlatform => ({
  provider,
  accounts: 1,
  spend_micros: provider === 'meta_ads' ? r(3381.2) : r(1578.8),
  daily_micros: provider === 'meta_ads' ? r(120.76) : r(52.71),
  forecast_micros: provider === 'meta_ads' ? r(3622.72) : r(1684.22),
  read_through: '2026-09-28',
  forecast_days: 2,
  stale: false,
  last_success_at: provider === 'meta_ads' ? '2026-09-29T09:12:00.000Z' : '2026-09-29T09:20:00.000Z',
  ...over,
});

function verba(over: Partial<BudgetMonthResponse> = {}, limites: Partial<BudgetMonthResponse['limits']> = {}): BudgetMonthResponse {
  return {
    period: '2026-09',
    timezone: FUSO,
    today: '2026-09-29',
    month_start: '2026-09-01',
    month_end: '2026-09-30',
    through: '2026-09-28',
    days_left: 2,
    currency: 'BRL',
    spend_micros: r(4960),
    daily_micros: r(173.47),
    forecast_micros: r(5306.94),
    forecast_days: 2,
    pending_daily_micros: 0,
    pending_micros: 0,
    limits: { month_micros: r(5500), campaign_daily_micros: r(80), set_by: { id: uuid(1), name: 'Rodrigo' }, set_at: '2026-09-20T15:00:00.000Z', ...limites },
    remaining_micros: r(193.06),
    platforms: [plataformaDoMes('meta_ads'), plataformaDoMes('google_ads')],
    rules: { change_percent_max: 10, rate_limit: { max: 3, window_minutes: 60 } },
    changes: [],
    overspend: [],
    largest_daily_micros: r(60),
    generated_at: '2026-09-29T17:40:00.000Z',
    ...over,
  };
}

/** O mês sem os dois limites: o Liame só reduz e pausa. */
const semTeto = (over: Partial<BudgetMonthResponse> = {}) => verba({ remaining_micros: null, ...over }, { month_micros: null, campaign_daily_micros: null, set_by: null, set_at: null });
/** O mesmo mês com outro teto (a sobra acompanha). */
const comTeto = (teto: number, over: Partial<BudgetMonthResponse> = {}) => verba({ remaining_micros: r(teto) - r(5306.94) - (over.pending_micros ?? 0), ...over }, { month_micros: r(teto) });
/** A Meta sem a leitura de hoje: o gasto dela vale até anteontem, e o dia que falta entra pelo ritmo. */
const metaAtrasada = () =>
  verba({
    spend_micros: r(4839.24),
    forecast_days: null,
    platforms: [
      plataformaDoMes('meta_ads', { spend_micros: r(3260.44), read_through: '2026-09-27', forecast_days: 3, stale: true, last_success_at: '2026-09-28T09:12:00.000Z' }),
      plataformaDoMes('google_ads'),
    ],
  });

type Conferencia = NonNullable<BudgetMonthChange['check']>;
const conferencia = (over: Partial<Conferencia> = {}): Conferencia => ({
  checked_on: '2026-09-29',
  status: 'confere',
  since: '2026-09-19',
  informed_status: 'ativo',
  informed_daily_micros: r(40),
  window: { from: '2026-09-22', to: '2026-09-28' },
  window_spend_micros: r(279.79),
  window_allowed_micros: r(280),
  days_after: 10,
  spend_after_micros: r(399.7),
  ...over,
});

/** A Smash em dobro, de R$ 44 para R$ 40 por dia em 18/09, conferida hoje. */
const mudanca = (over: Partial<BudgetMonthChange> = {}): BudgetMonthChange => ({
  action_id: uuid(50),
  executed_at: '2026-09-18T14:00:00.000Z',
  executed_on: '2026-09-18',
  tool: 'meta_ads.definir_verba',
  action: 'orcamento.reduzir',
  provider: 'meta_ads',
  account_id: uuid(2),
  target: { kind: 'campanha', name: 'Smash em dobro', campaign_name: null },
  from: { status: 'ativo', daily_micros: r(44) },
  to: { status: 'ativo', daily_micros: r(40) },
  requested_by: { id: uuid(1), name: 'Rodrigo' },
  agent_key: null,
  undoes: null,
  check: conferencia(),
  superseded_by: null,
  ...over,
});

/** O conjunto pausado em 26/09, que não gastou depois. */
const pausa = (over: Partial<BudgetMonthChange> = {}): BudgetMonthChange =>
  mudanca({
    action_id: uuid(51),
    executed_at: '2026-09-26T14:00:00.000Z',
    executed_on: '2026-09-26',
    tool: 'meta_ads.pausar',
    action: 'campanha.pausar',
    target: { kind: 'conjunto', name: 'Noite · quem já pediu', campaign_name: 'Delivery noite' },
    from: { status: 'ativo', daily_micros: null },
    to: { status: 'pausado', daily_micros: null },
    check: conferencia({ since: '2026-09-27', informed_status: 'pausado', informed_daily_micros: null, window_spend_micros: r(96.4), window_allowed_micros: null, days_after: 2, spend_after_micros: 0 }),
    ...over,
  });

const HOJE = { today: '2026-09-29', timezone: FUSO };

describe('Verba do mês: o mês', () => {
  it('o nome, até onde vai o gasto, os dias que faltam e quando o mês vira', () => {
    expect(mesDaVerba(verba())).toEqual({ nome: 'setembro', ate: '28/09', ultimoDia: 30, faltam: 'faltam 2 dias', virada: 'outubro começa na quinta-feira, 01/10', comecaHoje: false });
    expect(mesDaVerba(verba({ today: '2026-09-30', through: '2026-09-29', days_left: 1 })).faltam).toBe('falta 1 dia');
  });

  it('o mês que vira no fim de semana e o que vira o ano', () => {
    expect(mesDaVerba(verba({ period: '2026-10', month_start: '2026-10-01', month_end: '2026-10-31' })).virada).toBe('novembro começa no domingo, 01/11');
    expect(mesDaVerba(verba({ period: '2026-12', month_start: '2026-12-01', month_end: '2026-12-31' }))).toMatchObject({ nome: 'dezembro', virada: 'janeiro começa na sexta-feira, 01/01' });
  });

  it('no dia 1 ainda não há dia inteiro do mês: o gasto lido vai até a véspera, que é do mês anterior', () => {
    const dia1 = { period: '2026-10', today: '2026-10-01', month_start: '2026-10-01', month_end: '2026-10-31', through: '2026-09-30', days_left: 31, spend_micros: 0 };
    const agora = new Date('2026-10-01T17:40:00Z');
    const v = verba(dia1);
    expect(mesDaVerba(v)).toMatchObject({ nome: 'outubro', ate: '30/09', faltam: 'faltam 31 dias', comecaHoje: true });
    expect(heroiDaVerba(v, new Fontes(), agora).sub).toBe(nbsp('o mês começa hoje: a empresa pode gastar R$ 5.500,00 em outubro'));
    expect(heroiDaVerba(semTeto(dia1), new Fontes(), agora).sub).toBe('o mês começa hoje: o gasto de outubro aparece a partir de amanhã');
    // Sem dia inteiro do mês, a fonte não escreve um período ao contrário ("de 01/10 a 30/09").
    expect(fonteDoGasto(v, agora)).toContain(' · gasto do mês · ');
  });
});

describe('Verba do mês: a frase do dono', () => {
  it('cabe no teto: quanto o mês fecha e quanto sobra', () => {
    const f = fraseDaVerba(verba());
    expect(f[0]).toEqual({ t: 'Setembro deve fechar dentro do teto.', b: true });
    expect(textoDe(f)).toBe(nbsp('Setembro deve fechar dentro do teto. No ritmo dos últimos 7 dias, o mês fecha em R$ 5.306,94 e sobram R$ 193,06.'));
  });

  it('os aumentos pedidos ou feitos hoje entram na conta, e a frase diz', () => {
    expect(textoDe(fraseDaVerba(comTeto(5500, { pending_daily_micros: r(20), pending_micros: r(40) })))).toBe(
      nbsp('Setembro deve fechar dentro do teto. No ritmo dos últimos 7 dias, o mês fecha em R$ 5.346,94 e sobram R$ 153,06, já contando R$ 40,00 de aumentos pedidos ou feitos hoje.'),
    );
  });

  it('perto do teto (sobra menos de 2%): o aviso de que o próximo aumento pode ser negado', () => {
    expect(textoDe(fraseDaVerba(comTeto(5400)))).toBe(nbsp('Setembro está perto do teto: sobram R$ 93,06. Aumento ou retomada que não couber fica negado.'));
  });

  it('passa do teto: em quanto, e o que o Liame faz e não faz', () => {
    const f = fraseDaVerba(comTeto(5200));
    expect(f[0]).toEqual({ t: nbsp('No ritmo atual, setembro passa do teto em R$ 106,94.'), b: true });
    expect(textoDe(f)).toBe(
      nbsp('No ritmo atual, setembro passa do teto em R$ 106,94. O mês fecha em R$ 5.306,94, e o teto é de R$ 5.200,00. Aumentar e retomar ficam negados; o Liame não pausa nada sozinho.'),
    );
  });

  it('sem teto: o mês fecha em quanto, e o Liame só reduz e pausa', () => {
    expect(textoDe(fraseDaVerba(semTeto()))).toBe(
      nbsp('Setembro ainda não tem teto. No ritmo dos últimos 7 dias, o mês fecha em R$ 5.306,94. Sem o teto do mês e o teto por campanha, o Liame só reduz verba e pausa.'),
    );
  });
});

describe('Verba do mês: a barra do teto', () => {
  it('o gasto e a previsão como parte do teto; sem teto, não há barra', () => {
    expect(barraDaVerba(verba())).toEqual({ gasto: 90, previsto: 96, acima: false, rotulo: 'Gasto até ontem: 90% do teto. Previsão de fechamento: 96% do teto.', legendaPrevisto: 'Previsto até o dia 30' });
    expect(barraDaVerba(semTeto())).toBeNull();
  });

  it('com a previsão acima do teto, a barra inteira é a previsão, e a frase diz que ela passa', () => {
    expect(barraDaVerba(comTeto(5200))).toMatchObject({ gasto: 93, previsto: 100, acima: true, rotulo: 'Gasto até ontem: 95% do teto. A previsão passa do teto.' });
  });

  it('a previsão nunca fica atrás do gasto no desenho, nem com o mês sem gasto', () => {
    expect(barraDaVerba(verba({ spend_micros: 0, forecast_micros: 0, remaining_micros: r(5500) }))).toMatchObject({ gasto: 0, previsto: 0, acima: false });
    const b = barraDaVerba(verba({ spend_micros: r(5499.99), forecast_micros: r(5499.99), remaining_micros: r(0.01) }));
    expect(b!.previsto).toBeGreaterThanOrEqual(b!.gasto);
  });
});

describe('Verba do mês: o cartão do mês', () => {
  it('o número do gasto com a fonte (as duas plataformas, o período e a hora de cada leitura)', () => {
    const fontes = new Fontes();
    const h = heroiDaVerba(verba(), fontes, AGORA);
    expect(h.titulo).toBe('setembro · gasto em anúncios');
    expect(h.chip).toBe('faltam 2 dias · outubro começa na quinta-feira, 01/10');
    expect(h.numero.texto).toBe(nbsp('R$ 4.960,00'));
    expect(fontes.lista[h.numero.i]!.fonte).toBe('Meta Ads e Google Ads · gasto de 01/09 a 28/09 · lido hoje, 06:12 e 06:20');
    expect(h.sub).toBe(nbsp('gastos até ontem, de R$ 5.500,00 que a empresa pode gastar em setembro'));
    expect(h.barra).not.toBeNull();
  });

  it('os três números: a previsão (com a conta), os aumentos de hoje e a sobra', () => {
    const fontes = new Fontes();
    const h = heroiDaVerba(verba(), fontes, AGORA);
    expect(h.stats.map((s) => [s.rotulo, textoCorrido(s.valor), textoCorrido(s.sub)])).toEqual([
      ['Previsão de fechamento', nbsp('R$ 5.306,94'), nbsp('gasto até ontem + R$ 173,47 por dia × 2 dias')],
      ['Aumentos de hoje', nbsp('R$ 0,00'), 'aumentos e retomadas pedidos ou feitos hoje, até o fim do mês'],
      ['Sobra', nbsp('R$ 193,06'), nbsp('teto de R$ 5.500,00 por mês')],
    ]);
    expect(fontes.lista.map((l) => [l.valor, l.fonte])).toEqual([
      [nbsp('R$ 4.960,00'), 'Meta Ads e Google Ads · gasto de 01/09 a 28/09 · lido hoje, 06:12 e 06:20'],
      [nbsp('R$ 5.306,94'), 'Liame · gasto até ontem + ritmo dos últimos 7 dias × dias que faltam · calculado pelo sistema'],
      [nbsp('R$ 173,47'), 'Liame · gasto de 22/09 a 28/09 ÷ 7 · calculado pelo sistema'],
    ]);
  });

  it('com aumento pedido hoje, o sinal de mais; passando do teto, "Passa do teto"; sem teto, "não definido"', () => {
    const comPedido = heroiDaVerba(comTeto(5500, { pending_daily_micros: r(20), pending_micros: r(40) }), new Fontes(), AGORA);
    expect(textoCorrido(comPedido.stats[1]!.valor)).toBe(nbsp('+R$ 40,00'));
    const acima = heroiDaVerba(comTeto(5200), new Fontes(), AGORA);
    expect([acima.stats[2]!.rotulo, textoCorrido(acima.stats[2]!.valor)]).toEqual(['Passa do teto', nbsp('R$ 106,94')]);
    const sem = heroiDaVerba(semTeto(), new Fontes(), AGORA);
    expect(sem.stats[2]).toMatchObject({ rotulo: 'Teto do mês', falta: true });
    expect(textoCorrido(sem.stats[2]!.valor)).toBe('não definido');
    expect(sem.sub).toBe('gastos em anúncios de 01/09 a 28/09');
    expect(sem.barra).toBeNull();
  });

  it('a Meta sem a leitura de hoje: a fonte diz até onde vai cada plataforma, e a previsão explica os dias pelo ritmo', () => {
    const fontes = new Fontes();
    const h = heroiDaVerba(metaAtrasada(), fontes, AGORA);
    expect(fontes.lista[h.numero.i]!.fonte).toBe('Meta Ads (até 27/09) e Google Ads (até 28/09) · gasto do mês · lido ontem, 06:12, e hoje, 06:20');
    expect(textoCorrido(h.stats[0]!.sub)).toBe(nbsp('o gasto lido de cada conta + R$ 173,47 por dia nos dias que a leitura não cobre'));
  });

  it('uma plataforma só, e a conta que nunca foi lida', () => {
    const soMeta = verba({ platforms: [plataformaDoMes('meta_ads')] });
    expect(fonteDoGasto(soMeta, AGORA)).toBe('Meta Ads · gasto de 01/09 a 28/09 · lido hoje, 06:12');
    const nuncaLida = verba({ platforms: [plataformaDoMes('meta_ads', { stale: true, read_through: null, last_success_at: null, forecast_days: null })] });
    expect(fonteDoGasto(nuncaLida, AGORA)).toBe('Meta Ads · gasto do mês · ainda sem leitura');
    expect(fonteDoGasto(verba({ platforms: [] }), AGORA)).toBe('Liame · nenhuma conta de anúncio conectada');
  });

  it('a tabela por plataforma, com o total e a nota do Google (só leitura)', () => {
    const p = plataformasDaVerba(verba());
    expect(p.legenda).toBe('Gasto de setembro por plataforma: até ontem, ritmo por dia e previsão de fechamento');
    expect(p.linhas).toEqual([
      { provider: 'meta_ads', nome: 'Meta Ads', classe: 'meta', nota: null, gasto: nbsp('R$ 3.381,20'), ritmo: nbsp('R$ 120,76'), previsto: nbsp('R$ 3.622,72') },
      { provider: 'google_ads', nome: 'Google Ads', classe: 'google', nota: 'só leitura: o Liame ainda não muda campanhas do Google', gasto: nbsp('R$ 1.578,80'), ritmo: nbsp('R$ 52,71'), previsto: nbsp('R$ 1.684,22') },
    ]);
    expect(p.total).toEqual({ gasto: nbsp('R$ 4.960,00'), ritmo: nbsp('R$ 173,47'), previsto: nbsp('R$ 5.306,94') });
  });
});

describe('Verba do mês: o selo e as faixas do topo', () => {
  it('o selo diz a leitura mais recente; com uma plataforma atrasada, diz qual e desde quando', () => {
    expect(lidoDaVerba(verba(), AGORA)).toBe('Atualizado hoje, 06:20');
    expect(lidoDaVerba(metaAtrasada(), AGORA)).toBe('Meta: última leitura ontem, 06:12');
    expect(lidoDaVerba(verba({ platforms: [plataformaDoMes('google_ads', { stale: true, read_through: null, last_success_at: null })] }), AGORA)).toBe('Google: ainda sem leitura');
    expect(lidoDaVerba(verba({ platforms: [] }), AGORA)).toBeNull();
  });

  it('tudo em dia: nenhuma faixa', () => {
    expect(avisosDaVerba(verba(), AGORA)).toEqual([]);
  });

  it('a Meta não foi lida hoje: até onde vale o gasto, o dia que entra pelo ritmo e o caminho para a conexão', () => {
    expect(avisosDaVerba(metaAtrasada(), AGORA)).toEqual([
      {
        chave: 'leitura-meta_ads',
        tipo: 'atencao',
        icone: 'clock',
        titulo: 'A Meta não foi lida hoje: a última leitura é de ontem, 06:12',
        texto: 'O gasto da Meta abaixo vale até 27/09; o dia 28 entra na previsão pelo ritmo. O Liame tenta ler de novo sozinho. Enquanto isso, um pedido novo continua lendo a campanha na Meta na hora.',
        acao: 'contas',
      },
    ]);
  });

  it('o Google parado há dias: os dias que entram pelo ritmo; a conta nunca lida: o gasto dela não entra', () => {
    const parado = verba({ platforms: [plataformaDoMes('meta_ads'), plataformaDoMes('google_ads', { stale: true, read_through: '2026-09-24', last_success_at: '2026-09-25T09:20:00.000Z' })] });
    expect(avisosDaVerba(parado, AGORA)[0]).toMatchObject({
      titulo: 'O Google não foi lido hoje: a última leitura é de 25/09, 06:20',
      texto: 'O gasto do Google abaixo vale até 24/09; os dias de 25/09 a 28/09 entram na previsão pelo ritmo. O Liame tenta ler de novo sozinho.',
    });
    const nunca = verba({ platforms: [plataformaDoMes('meta_ads', { stale: true, read_through: null, last_success_at: null })] });
    expect(avisosDaVerba(nunca, AGORA)[0]).toMatchObject({
      titulo: 'A Meta ainda não foi lida',
      texto: 'Sem a primeira leitura, o gasto da Meta não entra na conta do mês. O Liame tenta ler sozinho; se continuar assim, confira a conexão.',
      acao: 'contas',
    });
  });

  it('no ritmo atual o mês passa do teto: o dia em que passa e o que fazer', () => {
    expect(diaQuePassaDoTeto(comTeto(5200))).toBe(30);
    expect(diaQuePassaDoTeto(comTeto(5100))).toBe(29);
    expect(diaQuePassaDoTeto(verba())).toBeNull();
    expect(diaQuePassaDoTeto(semTeto())).toBeNull();
    expect(avisosDaVerba(comTeto(5200), AGORA)).toEqual([
      {
        chave: 'acima-do-teto',
        tipo: 'perigo',
        icone: 'alert',
        titulo: 'No ritmo atual, setembro passa do teto no dia 30',
        texto: 'Para caber, reduza a verba de uma campanha ou pause uma (isso o Liame sempre aceita), ou suba o teto do mês.',
        acao: 'campanhas',
      },
    ]);
  });

  it('o aumento pedido hoje adianta o dia; com as contas lidas até dias diferentes, a faixa não diz o dia', () => {
    // R$ 4.960,00 + (R$ 173,47 + R$ 70,00) × 1 dia = R$ 5.203,47: passa de R$ 5.200,00 já no dia 29.
    expect(diaQuePassaDoTeto(comTeto(5200, { pending_daily_micros: r(70), pending_micros: r(140) }))).toBe(29);
    const atrasada = { ...metaAtrasada(), remaining_micros: -r(106.94), limits: { ...metaAtrasada().limits, month_micros: r(5200) } };
    expect(diaQuePassaDoTeto(atrasada)).toBeNull();
    expect(avisosDaVerba(atrasada, AGORA).find((a) => a.chave === 'acima-do-teto')!.titulo).toBe('No ritmo atual, setembro passa do teto');
  });

  it('o gasto lido já passou do teto', () => {
    expect(avisosDaVerba(comTeto(4900), AGORA)[0]).toMatchObject({
      tipo: 'perigo',
      titulo: 'Setembro já passou do teto',
      texto: nbsp('Foram R$ 4.960,00 até 28/09, e o teto é de R$ 4.900,00. Reduzir a verba de uma campanha ou pausar uma, o Liame sempre aceita; aumentar e retomar ficam negados. Você também pode subir o teto do mês.'),
    });
  });

  it('a campanha que gastou mais do que a verba: o aviso vem pronto do servidor, igual ao da Atenção', () => {
    const v = verba({
      overspend: [
        {
          action_id: uuid(52),
          title: 'A campanha "Combo sexta" gastou mais do que a verba permite',
          detail: 'Na semana de 20/09 a 26/09, ela gastou R$ 471,80. Com a verba de R$ 60,00 por dia que o Liame deixou, a semana iria até R$ 420,00.',
          action: 'Veja na Meta se a verba foi mudada por lá ou se há um conjunto com verba própria.',
        },
      ],
    });
    expect(avisosDaVerba(v, AGORA)).toEqual([
      {
        chave: `gasto-${uuid(52)}`,
        tipo: 'atencao',
        icone: 'alert',
        titulo: 'A campanha "Combo sexta" gastou mais do que a verba permite',
        texto: 'Na semana de 20/09 a 26/09, ela gastou R$ 471,80. Com a verba de R$ 60,00 por dia que o Liame deixou, a semana iria até R$ 420,00. Veja na Meta se a verba foi mudada por lá ou se há um conjunto com verba própria.',
        acao: null,
      },
    ]);
  });
});

describe('Verba do mês: os desenhos', () => {
  /** Setembro lido até 28/09: 27 dias de R$ 177,00 e o dia 28 com R$ 181,00 (R$ 4.960,00 no mês). */
  const dias = (ultimo = 181, falta: string[] = []): BudgetMonthDay[] =>
    Array.from({ length: 28 }, (_, i) => ({ day: `2026-09-${String(i + 1).padStart(2, '0')}`, spend_micros: r(i === 27 ? ultimo : 177), missing: i === 27 ? falta : [] }));
  const comDias = (over: Partial<BudgetMonthResponse> = {}) => verba({ days: dias(), ...over });
  const mes = (v: BudgetMonthResponse) => mesDaVerba(v);
  const desenho = (v: BudgetMonthResponse) => mesDesenhado(v, mes(v))!;
  /** A régua do cenário: o teto de R$ 5.500,00 é o maior valor, e o alto do desenho fica 10% acima dele (R$ 6.050,00). */
  const y = (reais: number, topo = 6050) => Math.round((100 - (reais / topo) * 100) * 100) / 100;

  it('o selo: cabe, perto, passa, já passou e sem teto, cada um com o que muda nos pedidos', () => {
    const selo = (v: BudgetMonthResponse) => vereditoDaVerba(v, mes(v));
    expect(selo(verba())).toEqual({ classe: 'concluido', rotulo: 'Cabe no teto', linha: 'No ritmo dos últimos 7 dias, setembro fecha abaixo do teto.' });
    expect(selo(comTeto(5350))).toEqual({ classe: 'aguardando', rotulo: 'Perto do teto', linha: 'Aumento ou retomada que não couber fica negado.' });
    expect(selo(comTeto(5200))).toEqual({ classe: 'perigo', rotulo: 'Passa do teto', linha: 'Aumentar e retomar ficam negados; o Liame não pausa nada sozinho.' });
    expect(selo(comTeto(4800))).toMatchObject({ classe: 'perigo', rotulo: 'Já passou do teto' });
    expect(selo(semTeto())).toEqual({ classe: 'espera', rotulo: 'Sem teto', linha: 'Sem o teto do mês e o teto por campanha, o Liame só reduz verba e pausa.' });
  });

  it('a régua: rótulos curtos e, no máximo, quatro linhas acima do zero', () => {
    expect([reaisCurtos(0), reaisCurtos(r(500)), reaisCurtos(r(437.5)), reaisCurtos(r(2000)), reaisCurtos(r(5500)), reaisCurtos(r(5350)), reaisCurtos(r(12000)), reaisCurtos(r(1250000))]).toEqual([
      'R$ 0',
      'R$ 500',
      'R$ 437,50',
      'R$ 2 mil',
      'R$ 5,5 mil',
      'R$ 5,35 mil',
      'R$ 12 mil',
      'R$ 1,25 mi',
    ]);
    // O passo é um número redondo: 1, 2, 2,5 ou 5 vezes uma potência de dez, e nunca menos que R$ 1,00.
    expect([passoDaGrade(r(6050)), passoDaGrade(r(100)), passoDaGrade(r(30)), passoDaGrade(r(40000)), passoDaGrade(r(275000)), passoDaGrade(r(3)), passoDaGrade(0)]).toEqual([
      r(2000),
      r(25),
      r(10),
      r(10000),
      r(100000),
      r(1),
      r(1),
    ]);
  });

  it('sem o gasto de cada dia na resposta, não há desenho do mês nem tabela dos dias (a tela fica com a barra do teto)', () => {
    const d = desenhosDaVerba(verba(), mes(verba()));
    expect([d.mes, d.dias]).toEqual([null, null]);
    expect(d.veredito.rotulo).toBe('Cabe no teto');
    expect(d.onde).toHaveLength(2);
  });

  it('o mês, dia a dia: a linha do gasto somado, o ponto de ontem, a previsão até o dia 30 e o teto, na mesma régua', () => {
    const d = desenho(comDias());
    expect(d.rotulo).toBe(nbsp('Gasto de setembro, dia a dia, em reais. Até 28/09, R$ 4.960,00. Previsto até o dia 30: R$ 5.306,94. Teto do mês: R$ 5.500,00. O dia de maior gasto foi 28/09, com R$ 181,00.'));
    expect(d.legenda).toEqual({ lido: 'Gasto até ontem', previsto: 'Previsto até o dia 30', teto: nbsp('R$ 5.500,00'), acima: false });
    // O teto fica a 9,09% do alto; a linha de R$ 6 mil não entra (ficaria colada no alto do desenho).
    expect(d.teto).toEqual({ y: 9.09, dica: nbsp('R$ 5.500,00|teto do mês') });
    expect(d.grade).toEqual([y(2000), y(4000)]);
    expect(d.eixo).toEqual([
      { y: 100, texto: 'R$ 0', doTeto: false },
      { y: y(2000), texto: 'R$ 2 mil', doTeto: false },
      { y: y(4000), texto: 'R$ 4 mil', doTeto: false },
      { y: 9.09, texto: 'R$ 5,5 mil', doTeto: true },
    ]);
    // A calha tem a largura do rótulo mais comprido: 10 letras de 6 px, mais 12 px de respiro.
    expect(d.calha).toBe(72);
    expect(d.fio.startsWith(`M0 100L3.33 ${y(177)}L6.67 ${y(354)}L`)).toBe(true);
    expect(d.fio.endsWith(`L93.33 ${y(4960)}`)).toBe(true);
    expect(d.pontoLido).toEqual({ x: 93.33, y: 18.02, acima: false, dica: nbsp('R$ 4.960,00|gastos até 28/09') });
    expect(d.pontoPrevisto).toEqual({ y: 12.28, acima: false, dica: nbsp('R$ 5.306,94|previsto até 30/09') });
    expect(d.previsao).toBe('M93.33 18.02L100 12.28');
    expect(d.areaLida!.startsWith('polygon(0% 100%,3.33% ')).toBe(true);
    expect(d.areaLida!.endsWith(',93.33% 18.02%,93.33% 100%)')).toBe(true);
    expect(d.areaPrevista).toBe('polygon(93.33% 18.02%,100% 12.28%,100% 100%,93.33% 100%)');
    expect(d.marcas).toEqual([
      { x: 0, texto: '01/09' },
      { x: 31.67, texto: '10' },
      { x: 65, texto: '20' },
      { x: 100, texto: '30/09' },
    ]);
  });

  it('um alvo por dia do mês: o lido diz o gasto e o acumulado; o que falta, até onde o mês vai no ritmo', () => {
    const d = desenho(comDias());
    expect(d.alvos).toHaveLength(30);
    expect(d.alvos[0]).toEqual({ x: 0, largura: 3.33, dica: nbsp('R$ 177,00 em 01/09|terça-feira · R$ 177,00 no mês até aqui') });
    expect(d.alvos[27]!.dica).toBe(nbsp('R$ 181,00 em 28/09|segunda-feira · R$ 4.960,00 no mês até aqui'));
    // Com tudo lido até ontem, cada dia previsto é o gasto mais o ritmo vezes os dias: o valor é exato.
    expect(d.alvos[28]!.dica).toBe(nbsp('R$ 5.133,47 até 29/09|previsto, se o ritmo de R$ 173,47 por dia continuar'));
    expect(d.alvos[29]!.dica).toBe(nbsp('R$ 5.306,94 até 30/09|previsto, se o ritmo de R$ 173,47 por dia continuar'));
    // O que foi pedido hoje entra no ritmo da previsão e no ponto do fim do mês.
    const comPedido = desenho(comDias({ pending_daily_micros: r(20), pending_micros: r(40) }));
    expect(comPedido.alvos[28]!.dica).toBe(nbsp('R$ 5.153,47 até 29/09|previsto, se o ritmo de R$ 193,47 por dia continuar'));
    expect(comPedido.pontoPrevisto.dica).toBe(nbsp('R$ 5.346,94|previsto até 30/09'));
  });

  it('o que passa do teto: a previsão, ou o gasto que já passou, levam o vermelho de estado e a palavra na legenda', () => {
    const passa = desenho({ ...comTeto(5200), days: dias() });
    expect([passa.legenda.acima, passa.pontoLido!.acima, passa.pontoPrevisto.acima]).toEqual([true, false, true]);
    const passou = desenho({ ...comTeto(4800), days: dias() });
    expect([passou.legenda.acima, passou.pontoLido!.acima, passou.pontoPrevisto.acima]).toEqual([true, true, true]);
    // A régua passa a ser a da previsão (o maior valor), e o rótulo da grade que ficaria em cima do teto dá lugar ao dele.
    const junto = desenho({ ...comTeto(4200), days: dias() });
    expect(junto.eixo.map((e) => e.texto)).toEqual(['R$ 0', 'R$ 2 mil', 'R$ 4,2 mil']);
    expect(junto.grade).toHaveLength(2);
  });

  it('sem teto: o desenho fica sem o traço escuro e sem o rótulo dele', () => {
    const d = desenho({ ...semTeto(), days: dias() });
    expect([d.teto, d.legenda.teto, d.legenda.acima]).toEqual([null, null, false]);
    expect(d.eixo.every((e) => !e.doTeto)).toBe(true);
    expect(d.rotulo).toContain('O mês ainda não tem teto.');
  });

  it('a Meta sem a leitura de hoje: o último dia entra só com o que foi lido, e a previsão dos dias deixa de ser exata', () => {
    const v = { ...metaAtrasada(), days: dias(60.24, ['meta_ads']) };
    const d = desenho(v);
    expect(d.alvos[27]!.dica).toBe(nbsp('R$ 60,24 em 28/09|segunda-feira · falta ler a Meta · R$ 4.839,24 no mês até aqui'));
    expect(d.alvos[28]!.dica).toBe(nbsp('cerca de R$ 5.073,09 até 29/09|previsto pelo ritmo dos últimos 7 dias'));
    expect(d.alvos[29]!.dica).toBe(nbsp('R$ 5.306,94 até 30/09|previsto pelo ritmo dos últimos 7 dias'));
    expect(d.pontoLido!.dica).toBe(nbsp('R$ 4.839,24|gastos até 28/09'));
    expect(diasLidos(v, mes(v))!.linhas.at(-1)).toEqual({ dia: '28/09', semana: 'segunda-feira', falta: 'falta ler a Meta', gasto: nbsp('R$ 60,24'), soma: nbsp('R$ 4.839,24') });
    // Com todas as contas paradas há dias, a linha cheia acaba antes de ontem: a legenda e o ponto dizem até que dia.
    const paradas = desenho({ ...metaAtrasada(), spend_micros: r(4602), days: dias().slice(0, 26) });
    expect([paradas.legenda.lido, paradas.pontoLido!.dica, paradas.pontoLido!.x]).toEqual(['Gasto até 26/09', nbsp('R$ 4.602,00|gastos até 26/09'), 86.67]);
  });

  it('no dia 1 ainda não há dia lido: o desenho é só a previsão, do zero ao fim do mês', () => {
    const v = verba({ period: '2026-10', today: '2026-10-01', month_start: '2026-10-01', month_end: '2026-10-31', through: '2026-09-30', days_left: 31, forecast_days: 31, spend_micros: 0, forecast_micros: r(5377.57), remaining_micros: r(122.43), days: [] });
    const d = desenho(v);
    expect([d.fio, d.areaLida, d.pontoLido, d.legenda.lido]).toEqual(['', null, null, null]);
    expect(d.previsao).toBe(`M0 100L100 ${y(5377.57)}`);
    expect(d.alvos).toHaveLength(31);
    expect(d.alvos[0]!.dica).toBe(nbsp('R$ 173,47 até 01/10|previsto, se o ritmo de R$ 173,47 por dia continuar'));
    expect(d.rotulo).toBe(nbsp('Gasto de outubro, dia a dia, em reais. Ainda não há dia inteiro lido neste mês. Previsto até o dia 31: R$ 5.377,57. Teto do mês: R$ 5.500,00.'));
    expect(d.marcas.map((m) => m.texto)).toEqual(['01/10', '10', '20', '31/10']);
    expect(diasLidos(v, mes(v))).toBeNull();
  });

  it('a tabela dos dias: o gasto de cada dia e o que o mês somava até ali', () => {
    const t = diasLidos(comDias(), mes(comDias()))!;
    expect(t.legenda).toBe('Gasto em anúncios em cada dia de setembro e o que o mês somava até ali');
    expect(t.linhas).toHaveLength(28);
    expect(t.linhas[0]).toEqual({ dia: '01/09', semana: 'terça-feira', falta: null, gasto: nbsp('R$ 177,00'), soma: nbsp('R$ 177,00') });
    expect(t.linhas[1]!.soma).toBe(nbsp('R$ 354,00'));
    expect(t.linhas.at(-1)!.soma).toBe(nbsp('R$ 4.960,00'));
  });

  it('onde o gasto foi: uma barra por plataforma, na régua da maior previsão, com o valor e a parte do gasto', () => {
    const [meta, google] = ondeOGastoFoi(verba(), mes(verba()));
    expect(meta).toEqual({
      provider: 'meta_ads',
      nome: 'Meta Ads',
      classe: 'meta',
      gasto: 93.33,
      aMais: 6.67,
      valor: nbsp('R$ 3.381,20'),
      parte: '68% do gasto',
      rotulo: nbsp('Meta Ads: R$ 3.381,20 até 28/09, 68% do gasto do mês. Previsão de fechamento: R$ 3.622,72.'),
      dicaGasto: nbsp('R$ 3.381,20|Meta Ads · gasto até 28/09'),
      dicaPrevisto: nbsp('R$ 3.622,72|Meta Ads · previsto até o dia 30'),
    });
    expect(google).toMatchObject({ nome: 'Google Ads', classe: 'google', gasto: 43.58, aMais: 2.91, parte: '32% do gasto' });
    // Sem gasto no mês não há parte a dizer; a conta nunca lida diz isso no lugar da data.
    const zerado = verba({ spend_micros: 0, platforms: [plataformaDoMes('meta_ads', { spend_micros: 0, forecast_micros: 0, read_through: null, stale: true, last_success_at: null })] });
    expect(ondeOGastoFoi(zerado, mes(zerado))[0]).toMatchObject({ gasto: 0, aMais: 0, parte: null, dicaGasto: nbsp('R$ 0,00|Meta Ads · gasto ainda sem leitura') });
    expect(ondeOGastoFoi(verba({ platforms: [] }), mes(verba()))).toEqual([]);
    // Num mês sem gasto, o leitor de tela não ouve "o dia de maior gasto".
    const parado = verba({ spend_micros: 0, forecast_micros: 0, daily_micros: 0, days: [{ day: '2026-09-01', spend_micros: 0, missing: [] }] });
    expect(mesDesenhado(parado, mes(parado))!.rotulo).toBe(nbsp('Gasto de setembro, dia a dia, em reais. Até 01/09, R$ 0,00. Previsto até o dia 30: R$ 0,00. Teto do mês: R$ 5.500,00.'));
  });
});

describe('Verba do mês: os limites da empresa', () => {
  it('os dois limites, quem definiu, as regras da Liame e as dicas do formulário', () => {
    expect(limitesDaVerba(verba(), AGORA)).toEqual({
      definidos: true,
      mes: nbsp('R$ 5.500,00'),
      campanha: nbsp('R$ 80,00 por dia'),
      quem: 'Definidos por Rodrigo em 20/09.',
      regras: [
        'Nada muda na Meta sem a aprovação de uma pessoa, com o código do app.',
        'Cada pedido muda no máximo 10% da verba diária.',
        'No máximo 3 mudanças de verba por hora na mesma campanha ou conjunto.',
        'A Meta confere antes, e o Liame não passa por cima do que alguém mudou lá.',
        'O Liame não apaga nada na Meta e não mexe no limite de gastos da conta.',
      ],
      dicaDoMes: nbsp('Quanto a empresa pode gastar em anúncios por mês, somando a Meta e o Google. Em setembro, a previsão é de R$ 5.306,94.'),
      dicaDaCampanha: nbsp('A maior verba diária que um aumento pode deixar numa campanha ou num conjunto. Hoje a maior é de R$ 60,00 por dia.'),
    });
  });

  it('definidos hoje, em outro ano e sem o nome de quem definiu (a pessoa saiu)', () => {
    expect(limitesDaVerba(verba({}, { set_at: '2026-09-29T12:00:00.000Z' }), AGORA).quem).toBe('Definidos por Rodrigo hoje.');
    expect(limitesDaVerba(verba({}, { set_at: '2025-12-30T12:00:00.000Z' }), AGORA).quem).toBe('Definidos por Rodrigo em 30/12/2025.');
    expect(limitesDaVerba(verba({}, { set_by: null }), AGORA).quem).toBe('Definidos em 20/09.');
  });

  it('sem os limites; e as regras da distribuição que mudam ou saem', () => {
    const sem = limitesDaVerba(semTeto({ largest_daily_micros: null }), AGORA);
    expect(sem).toMatchObject({ definidos: false, mes: null, campanha: null, quem: null, dicaDaCampanha: 'A maior verba diária que um aumento pode deixar numa campanha ou num conjunto.' });
    // Só um dos dois definido (o envelope veio pela API antiga): os dois limites andam juntos, e a tela pede os dois.
    expect(limitesDaVerba(verba({}, { campaign_daily_micros: null }), AGORA)).toMatchObject({ definidos: false, mes: nbsp('R$ 5.500,00'), campanha: null });
    const outras = limitesDaVerba(verba({ rules: { change_percent_max: 12.5, rate_limit: { max: 1, window_minutes: 30 } } }), AGORA).regras;
    expect(outras).toContain('Cada pedido muda no máximo 12,5% da verba diária.');
    expect(outras).toContain('No máximo 1 mudança de verba a cada 30 minutos na mesma campanha ou conjunto.');
    expect(limitesDaVerba(verba({ rules: { change_percent_max: null, rate_limit: null } }), AGORA).regras).toHaveLength(3);
  });

  it('o valor digitado em reais: com ponto de milhar, com vírgula, com "R$" e com ponto de centavos', () => {
    expect(reaisDigitados('5.500,00')).toBe(5_500_000_000);
    expect(reaisDigitados('5500')).toBe(5_500_000_000);
    expect(reaisDigitados('5.500')).toBe(5_500_000_000);
    expect(reaisDigitados(' R$ 80 ')).toBe(80_000_000);
    expect(reaisDigitados(`R$${String.fromCharCode(160)}80,5`)).toBe(80_500_000);
    expect(reaisDigitados('80.5')).toBe(80_500_000);
    expect(reaisDigitados('80.50')).toBe(80_500_000);
    expect(reaisDigitados('1.234.567,89')).toBe(1_234_567_890_000);
    expect(reaisDigitados('0')).toBe(0);
  });

  it('o que não é um valor em reais não vira número', () => {
    for (const ruim of ['', '   ', 'abc', '1,2,3', '12,345', '5,', ',50', '-5', '1e3', '1.23.4', '5.5000', '12.34,5.6', '１２', '1234567890123456', '1 2']) {
      expect(reaisDigitados(ruim), ruim).toBe(ruim === '1 2' ? 12_000_000 : null);
    }
  });

  it('o valor de agora no campo, sem ponto de milhar', () => {
    expect(reaisParaOCampo(5_500_000_000)).toBe('5500');
    expect(reaisParaOCampo(80_500_000)).toBe('80,50');
    expect(reaisParaOCampo(null)).toBe('');
    expect(reaisDigitados(reaisParaOCampo(1_234_560_000))).toBe(1_234_560_000);
  });

  it('a conferência do formulário: os dois valores e o teto por campanha (por dia) dentro do teto do mês', () => {
    expect(conferirLimites({ mes: '5.500,00', campanha: '80' })).toEqual({ ok: true, corpo: { month_micros: 5_500_000_000, campaign_daily_micros: 80_000_000 } });
    expect(conferirLimites({ mes: '', campanha: '80' })).toEqual({ ok: false, erro: 'Digite o teto do mês em reais, como 5.500,00.', campo: 'mes' });
    expect(conferirLimites({ mes: '0,50', campanha: '80' })).toMatchObject({ ok: false, campo: 'mes' });
    expect(conferirLimites({ mes: '5500', campanha: 'oitenta' })).toEqual({ ok: false, erro: 'Digite o teto por campanha em reais, como 80,00.', campo: 'campanha' });
    expect(conferirLimites({ mes: '5500', campanha: '0' })).toMatchObject({ ok: false, campo: 'campanha' });
    expect(conferirLimites({ mes: '50', campanha: '80' })).toEqual({ ok: false, erro: 'O teto por campanha é por dia e não pode passar do teto do mês.', campo: 'campanha' });
    expect(conferirLimites({ mes: '80', campanha: '80' })).toMatchObject({ ok: true });
  });

  it('a recusa do servidor: o campo que ele aponta, a falta de permissão e o erro do nosso lado com o código de rastreio', () => {
    const base = { status: 400, code: 'entrada-invalida', title: 'Dados inválidos' };
    expect(erroAoSalvarLimites({ ...base, errors: [{ path: 'campaign_daily_micros', message: 'O teto por campanha é por dia e não pode passar do teto do mês.' }] })).toEqual({
      erro: 'O teto por campanha é por dia e não pode passar do teto do mês.',
      campo: 'campanha',
    });
    expect(erroAoSalvarLimites({ ...base, errors: [{ path: 'month_micros', message: 'O teto do mês começa em R$ 1,00' }] }).campo).toBe('mes');
    expect(erroAoSalvarLimites({ status: 403, code: 'sem-permissao', title: 'Sem permissão' })).toEqual({ erro: 'Só o Dono e o Administrador mudam os limites.', campo: null });
    expect(erroAoSalvarLimites({ status: 500, code: 'erro-interno', title: 'Algo deu errado', detail: 'Tente de novo.', trace_id: 'abc123' })).toEqual({ erro: 'Tente de novo. Código de rastreio: abc123', campo: null });
    expect(erroAoSalvarLimites({ status: 0, code: 'sem-conexao', title: 'Sem conexão', detail: 'Não conseguimos falar com o Liame. Confira a internet e tente de novo.' }).erro).toBe(
      'Não conseguimos falar com o Liame. Confira a internet e tente de novo.',
    );
  });
});

describe('Verba do mês: o que o Liame mudou', () => {
  it('a verba que mudou e confere: o que a Meta informa e o gasto por dia depois', () => {
    expect(linhaDaMudanca(mudanca(), HOJE)).toEqual({
      id: uuid(50),
      quando: '18/09',
      oque: nbsp('Smash em dobro: verba de R$ 44,00 para R$ 40,00'),
      dequem: 'pedido de Rodrigo',
      informa: nbsp('R$ 40,00'),
      gasto: nbsp('R$ 39,97 por dia'),
      media: 'média de 10 dias',
      situacao: 'ok',
      rotulo: 'Confere',
      icone: 'check',
      nota: null,
    });
  });

  it('o conjunto pausado que não gastou, com a campanha de que faz parte', () => {
    expect(linhaDaMudanca(pausa(), HOJE)).toMatchObject({
      quando: '26/09',
      oque: 'Conjunto “Noite · quem já pediu” pausado',
      dequem: 'pedido de Rodrigo · campanha Delivery noite',
      informa: 'pausado',
      gasto: 'não gastou',
      media: 'média de 2 dias',
      situacao: 'ok',
    });
  });

  it('a campanha concorda no feminino; o anúncio retomado; a verba que o objeto não tinha', () => {
    const campanha = { kind: 'campanha', name: 'Combo sexta', campaign_name: null };
    expect(oQueMudou(pausa({ target: campanha }))).toBe('Combo sexta pausada');
    expect(linhaDaMudanca(pausa({ target: campanha, check: conferencia({ informed_status: 'pausado', informed_daily_micros: null, days_after: 1, spend_after_micros: 0 }) }), HOJE)).toMatchObject({ informa: 'pausada', media: 'média de 1 dia' });
    const retomado = pausa({ target: { kind: 'anuncio', name: 'Vídeo 15s', campaign_name: 'Combo sexta' }, from: { status: 'pausado', daily_micros: null }, to: { status: 'ativo', daily_micros: null }, check: null, executed_on: '2026-09-29' });
    expect(oQueMudou(retomado)).toBe('Anúncio “Vídeo 15s” retomado');
    expect(linhaDaMudanca(retomado, HOJE).informa).toBe('ativo');
    expect(oQueMudou(mudanca({ from: { status: 'ativo', daily_micros: null } }))).toBe(nbsp('Smash em dobro: verba de R$ 40,00'));
  });

  it('a mudança de hoje: confere (o Liame leu de novo ao escrever), e o gasto sai amanhã', () => {
    expect(linhaDaMudanca(mudanca({ executed_on: '2026-09-29', executed_at: '2026-09-29T15:00:00.000Z', check: null, to: { status: 'ativo', daily_micros: r(36) }, from: { status: 'ativo', daily_micros: r(40) } }), HOJE)).toMatchObject({
      quando: 'hoje',
      informa: nbsp('R$ 36,00'),
      gasto: 'sai amanhã',
      media: null,
      situacao: 'ok',
      rotulo: 'Confere',
      nota: null,
    });
  });

  it('a de ontem, conferida hoje: ainda sem dia inteiro depois dela', () => {
    expect(linhaDaMudanca(mudanca({ executed_on: '2026-09-28', check: conferencia({ days_after: 0, spend_after_micros: 0 }) }), HOJE)).toMatchObject({ gasto: 'sai amanhã', media: null, situacao: 'ok' });
  });

  it('a de antes de hoje que ainda não foi conferida espera a leitura, sem dizer que confere', () => {
    expect(linhaDaMudanca(mudanca({ check: null }), HOJE)).toMatchObject({
      situacao: 'espera',
      rotulo: 'Esperando a leitura',
      icone: 'clock',
      informa: nbsp('R$ 40,00'),
      gasto: '—',
      nota: 'A conferência roda depois da leitura da manhã.',
    });
  });

  it('alguém mudou na Meta depois: não é erro, e a tela diz desde quando o Liame vê assim', () => {
    expect(linhaDaMudanca(mudanca({ check: conferencia({ status: 'mudou', since: '2026-09-27', informed_daily_micros: r(45) }) }), HOJE)).toMatchObject({
      informa: nbsp('R$ 45,00'),
      situacao: 'mudou',
      rotulo: 'Mudado na Meta',
      icone: 'pencil',
      nota: 'Alguém mudou na Meta (o Liame viu em 27/09). Não é erro: quem mexe na Meta manda. O Liame só não desfaz mais este pedido.',
    });
    // A situação mudou (a campanha pausada por lá) e a verba ficou: a coluna da verba mostra a verba, e a nota explica.
    expect(linhaDaMudanca(mudanca({ check: conferencia({ status: 'mudou', since: '2026-09-27', informed_status: 'pausado' }) }), HOJE).informa).toBe(nbsp('R$ 40,00'));
    expect(linhaDaMudanca(pausa({ check: conferencia({ status: 'mudou', since: '2026-09-28', informed_status: 'ativo', informed_daily_micros: null }) }), HOJE)).toMatchObject({ informa: 'ativo', rotulo: 'Mudado na Meta' });
  });

  it('o objeto que saiu da lista da conta', () => {
    expect(linhaDaMudanca(mudanca({ check: conferencia({ status: 'mudou', since: '2026-09-27', informed_status: null, informed_daily_micros: null }) }), HOJE)).toMatchObject({
      informa: 'fora da conta',
      nota: 'Não está mais na lista da conta na Meta (o Liame viu em 27/09): foi arquivada ou apagada por lá.',
    });
    expect(linhaDaMudanca(pausa({ check: conferencia({ status: 'mudou', since: '2026-09-27', informed_status: null, informed_daily_micros: null }) }), HOJE).nota).toContain('foi arquivado ou apagado por lá');
  });

  it('gastou a mais: a semana contra 7 vezes a verba diária', () => {
    const combo = mudanca({
      target: { kind: 'campanha', name: 'Combo sexta', campaign_name: null },
      executed_on: '2026-09-12',
      from: { status: 'ativo', daily_micros: r(55) },
      to: { status: 'ativo', daily_micros: r(60) },
      check: conferencia({ status: 'acima', since: '2026-09-27', informed_daily_micros: r(60), window: { from: '2026-09-20', to: '2026-09-26' }, window_spend_micros: r(471.8), window_allowed_micros: r(420), days_after: 16, spend_after_micros: r(1009.6) }),
    });
    expect(linhaDaMudanca(combo, HOJE)).toMatchObject({
      oque: nbsp('Combo sexta: verba de R$ 55,00 para R$ 60,00'),
      informa: nbsp('R$ 60,00'),
      gasto: nbsp('R$ 63,10 por dia'),
      media: 'média de 16 dias',
      situacao: 'acima',
      rotulo: 'Gastou a mais',
      icone: 'alert',
      nota: nbsp('Na semana de 20/09 a 26/09 gastou R$ 471,80; com R$ 60,00 por dia, a semana iria até R$ 420,00.'),
    });
  });

  it('gastou a mais com a mudança no meio da semana (a verba de cada dia), em menos de 7 dias e depois de pausado', () => {
    const noMeio = mudanca({ check: conferencia({ status: 'acima', window_spend_micros: r(300), window_allowed_micros: r(292) }) });
    expect(linhaDaMudanca(noMeio, HOJE).nota).toBe(nbsp('Na semana de 22/09 a 28/09 gastou R$ 300,00; com a verba de cada dia, iria até R$ 292,00.'));
    const curta = mudanca({ check: conferencia({ status: 'acima', window: { from: '2026-09-26', to: '2026-09-28' }, window_spend_micros: r(130), window_allowed_micros: r(120) }) });
    expect(linhaDaMudanca(curta, HOJE).nota).toBe(nbsp('De 26/09 a 28/09 gastou R$ 130,00; com a verba de cada dia, iria até R$ 120,00.'));
    const pausado = pausa({ check: conferencia({ status: 'acima', since: '2026-09-28', informed_status: 'pausado', informed_daily_micros: null, window: { from: '2026-09-27', to: '2026-09-28' }, window_spend_micros: r(12.3), window_allowed_micros: 0, days_after: 2, spend_after_micros: r(12.3) }) });
    expect(linhaDaMudanca(pausado, HOJE)).toMatchObject({ gasto: nbsp('R$ 6,15 por dia'), nota: nbsp('De 27/09 a 28/09 gastou R$ 12,30, depois de pausado pelo Liame.') });
  });

  it('a mudança que outro pedido do Liame trocou: vale o mais recente, e esta não é mais conferida', () => {
    const trocada = mudanca({ superseded_by: { action_id: uuid(60), executed_at: '2026-09-25T13:00:00.000Z' } });
    expect(linhaDaMudanca(trocada, HOJE)).toMatchObject({
      situacao: 'trocada',
      rotulo: 'Trocada por outro pedido',
      icone: 'history',
      informa: '—',
      gasto: '—',
      media: null,
      nota: 'O Liame mudou de novo em 25/09: vale o pedido mais recente.',
    });
    // Trocada no mesmo dia, perto da meia-noite: o dia é o da loja, não o do relógio do servidor.
    expect(linhaDaMudanca(mudanca({ check: null, executed_on: '2026-09-29', superseded_by: { action_id: uuid(61), executed_at: '2026-09-30T02:30:00.000Z' } }), HOJE).nota).toBe(
      'O Liame mudou de novo hoje: vale o pedido mais recente.',
    );
  });

  it('quem pediu: a pessoa, o Gestor de tráfego, outro funcionário de IA e o pedido de volta', () => {
    expect(linhaDaMudanca(mudanca({ agent_key: 'trafego' }), HOJE).dequem).toBe('pedido do Gestor de tráfego');
    expect(linhaDaMudanca(mudanca({ agent_key: 'funcionario_novo' }), HOJE).dequem).toBe('pedido de um funcionário de IA');
    expect(linhaDaMudanca(mudanca({ undoes: uuid(49) }), HOJE).dequem).toBe('pedido de volta de Rodrigo');
  });

  it('a mudança de outro ano leva o ano; a situação que a leitura não soube dizer', () => {
    expect(linhaDaMudanca(mudanca({ executed_on: '2025-12-30', check: null, superseded_by: { action_id: uuid(62), executed_at: '2026-01-02T13:00:00.000Z' } }), HOJE).quando).toBe('30/12/2025');
    expect(linhaDaMudanca(pausa({ check: conferencia({ status: 'mudou', informed_status: 'desconhecido', informed_daily_micros: null }) }), HOJE).informa).toBe('não informado');
    // Um resultado que a tela ainda não conhece aparece como veio: não vira "confere" nem "gastou a mais".
    expect(linhaDaMudanca(mudanca({ check: conferencia({ status: 'resultado_novo' }) }), HOJE)).toMatchObject({ situacao: 'outra', rotulo: 'Resultado novo', icone: 'info', nota: null });
  });

  it('o cartão: o título com o mês, a coluna com o nome da plataforma e a nota da semana', () => {
    const m = mudancasDaVerba(verba({ changes: [pausa(), mudanca()] }));
    expect(m).toMatchObject({
      titulo: 'O que o Liame mudou em setembro',
      sub: 'Cada mudança, conferida todo dia com o que a Meta informa e com o que ela gastou.',
      legenda: 'Mudanças feitas pelo Liame em setembro: o que mudou, o que a Meta informa hoje, o gasto por dia depois e a situação',
      colunaInforma: 'A Meta informa hoje',
      deAntes: null,
      nota: 'A verba diária é uma média: a Meta pode gastar mais num dia e menos em outros. Por isso o Liame confere a semana inteira, contra 7 vezes a verba diária, e avisa quando ela passa.',
    });
    expect(m.linhas.map((l) => l.id)).toEqual([uuid(51), uuid(50)]);
  });

  it('a lista traz o que mudou antes do mês e continua valendo; sem mudança, o cartão diz o que aparece ali', () => {
    expect(mudancasDaVerba(verba({ changes: [mudanca({ executed_on: '2026-08-30' })] })).deAntes).toBe(
      'A lista traz também as mudanças de antes de setembro que continuam valendo: o Liame confere cada uma por 35 dias.',
    );
    const vazio = mudancasDaVerba(verba());
    expect(vazio.linhas).toEqual([]);
    expect(vazio.vazio).toEqual({
      titulo: 'O Liame não mudou nada em setembro',
      texto: 'Quando um pedido de mudança de verba, de pausa ou de retomada for aprovado e executado, ele aparece aqui, conferido todo dia.',
    });
    // Com duas plataformas na lista, a frase não escolhe uma.
    expect(mudancasDaVerba(verba({ changes: [mudanca(), mudanca({ action_id: uuid(53), provider: 'google_ads' })] })).colunaInforma).toBe('A plataforma informa hoje');
  });
});

describe('Verba do mês: o cartão do Resumo', () => {
  it('com o teto: até ontem quanto de quanto, a barra e a frase do mês', () => {
    const c = verbaNoResumo(verba());
    expect(c).toMatchObject({ titulo: 'Verba de setembro', sub: nbsp('Até ontem, R$ 4.960,00 de R$ 5.500,00.'), semTeto: false });
    expect(c.barra).toEqual(barraDaVerba(verba()));
    expect(textoDe(c.frase)).toBe(textoDe(fraseDaVerba(verba())));
  });

  it('sem o teto: o convite para definir', () => {
    const c = verbaNoResumo(semTeto());
    expect(c).toMatchObject({ titulo: 'Verba de setembro', sub: 'O teto que você define. O Liame não aprova nada que passe dele.', barra: null, semTeto: true });
    expect(textoDe(c.frase)).toBe(nbsp('Você ainda não definiu o teto do mês. Até ontem foram R$ 4.960,00 em anúncios; no ritmo atual, setembro fecha em R$ 5.306,94. Sem o teto, o Liame só reduz verba e pausa.'));
  });
});

describe('Verba do mês: a tela', () => {
  type Opcoes = { modo?: 'lite' | 'pro'; podeDefinir?: boolean; podeVerContas?: boolean; podeVerResultados?: boolean; editando?: boolean };
  const desenhar = (v: BudgetMonthResponse, o: Opcoes = {}) =>
    renderToStaticMarkup(
      createElement(ModoProvider, {
        inicial: o.modo ?? 'lite',
        children: createElement(VerbaConteudo, {
          tela: telaDaVerba(v, AGORA),
          limites: { mes: v.limits.month_micros, campanha: v.limits.campaign_daily_micros },
          podeDefinir: o.podeDefinir ?? true,
          podeVerContas: o.podeVerContas ?? true,
          podeVerResultados: o.podeVerResultados ?? true,
          editando: o.editando ?? false,
          aoEditar: () => {},
          aoCancelar: () => {},
          aoSalvar: async () => null,
        }),
      }),
    );
  const comMudancas = () => verba({ changes: [pausa(), mudanca()] });
  /** Setembro lido até 28/09, somando os R$ 4.960,00 do cenário. */
  const dias28 = (): BudgetMonthDay[] => Array.from({ length: 28 }, (_, i) => ({ day: `2026-09-${String(i + 1).padStart(2, '0')}`, spend_micros: r(i === 27 ? 181 : 177), missing: [] }));

  it('no Lite, com a resposta de antes (sem o gasto de cada dia): o gasto com a fonte, o selo, a barra do teto, os três números, os limites e as mudanças em três colunas', () => {
    const html = desenhar(comMudancas());
    expect(html).toContain('setembro · gasto em anúncios');
    expect(html).toContain('class="nf"');
    expect(html).toContain(nbsp('R$ 4.960,00'));
    expect(html).toContain('role="img" aria-label="Gasto até ontem: 90% do teto. Previsão de fechamento: 96% do teto."');
    expect(html).toContain('--gasto:90;--previsto:96');
    expect(html).toContain('<span class="st st--concluido"><span class="dot"></span>Cabe no teto</span>');
    expect(html).toContain('No ritmo dos últimos 7 dias, setembro fecha abaixo do teto.');
    expect(html).not.toContain('mes-plot');
    expect(html).toContain('<h3>Onde o gasto foi</h3>');
    expect(html).toContain('Previsão de fechamento');
    expect(html).toContain('Limites da empresa');
    expect(html).toContain('Você define; o Liame nega o pedido que passar.');
    expect(html).toContain('Mudar os limites');
    expect(html).toContain('Definidos por Rodrigo em 20/09.');
    expect(html).toContain('Regras da Liame, que valem sempre');
    expect(html).toContain('O que o Liame mudou em setembro');
    expect(html).toContain('Conjunto “Noite · quem já pediu” pausado');
    expect(html).toContain('concilia-sit concilia-sit--ok');
    expect(html).toContain('href="/aprovacoes"');
    expect(html).toContain('De onde vêm os números (3)');
    // O que é do Pro fica a um "Ver detalhes": a tabela por plataforma e as duas colunas da conferência.
    expect(html.match(/Ver detalhes/g)).toHaveLength(2);
    expect(html).not.toContain('Ritmo por dia');
    expect(html).not.toContain('A Meta informa hoje</th>');
    expect(html).not.toContain('Gasto depois');
  });

  it('com o gasto de cada dia: o selo, "O mês, dia a dia" no lugar da barra e "Onde o gasto foi"', () => {
    const html = desenhar(verba({ days: dias28() }));
    expect(html).toContain('<span class="st st--concluido"><span class="dot"></span>Cabe no teto</span>');
    expect(html).toContain('<h3>O mês, dia a dia</h3>');
    expect(html).toContain(`class="mes-plot" role="img" tabindex="0" aria-label="${nbsp('Gasto de setembro, dia a dia, em reais. Até 28/09, R$ 4.960,00.')}`);
    expect(html).toContain(`Teto do mês <b>${nbsp('R$ 5.500,00')}</b>`);
    expect(html.match(/class="alvo"/g)).toHaveLength(30);
    expect(html).toContain('class="mes-teto"');
    expect(html).toContain('<clipPath');
    expect(html).not.toContain('verba-barra');
    expect(html).not.toContain('Acima do teto');
    expect(html).toContain('<h3>Onde o gasto foi</h3>');
    expect(html).toContain('68% do gasto');
    expect(html).toContain('class="dica-desenho"');
    // A tabela dos dias fica com o que é do Pro: no Lite, a um "Ver detalhes".
    expect(html).not.toContain('Ver o gasto de cada dia');
    const pro = desenhar(verba({ days: dias28() }), { modo: 'pro' });
    expect(pro).toContain('Ver o gasto de cada dia');
    expect(pro).toContain('<span class="num">01/09</span><span class="sub">terça-feira</span>');
  });

  it('o gasto que já passou do teto: o selo, o vermelho no desenho e o quadro com as duas contas', () => {
    const html = desenhar({ ...comTeto(4800), days: dias28() });
    expect(html).toContain('<span class="st st--perigo"><span class="dot"></span>Já passou do teto</span>');
    expect(html).toContain('Acima do teto');
    expect(html).toContain('class="mes-pt mes-pt--acima"');
    expect(html).toContain('class="mes-pt mes-pt--prev mes-pt--acima"');
    expect(html).toContain(nbsp('no fim do mês; até ontem, R$ 160,00 acima do teto de R$ 4.800,00'));
    expect(html).toContain('Setembro já passou do teto');
  });

  it('sem teto e com o gasto de cada dia: o desenho aparece sem o traço do teto', () => {
    const html = desenhar({ ...semTeto(), days: dias28() });
    expect(html).toContain('<span class="st st--espera"><span class="dot"></span>Sem teto</span>');
    expect(html).toContain('class="mes-plot"');
    expect(html).not.toContain('class="mes-teto"');
    expect(html).not.toContain('<clipPath');
    expect(html).not.toContain('Teto do mês <b>');
  });

  it('no Pro: a tabela por plataforma com o total e as colunas da conferência, sem "Ver detalhes"', () => {
    const html = desenhar(comMudancas(), { modo: 'pro' });
    expect(html).not.toContain('Ver detalhes');
    expect(html).toContain('<caption class="sr-only">Gasto de setembro por plataforma: até ontem, ritmo por dia e previsão de fechamento</caption>');
    expect(html).toContain('plat plat--meta');
    expect(html).toContain('só leitura: o Liame ainda não muda campanhas do Google');
    expect(html).toContain('<th scope="row">Total</th>');
    expect(html).toContain('data-rot="Ritmo por dia"');
    expect(html).toContain('<th scope="col">A Meta informa hoje</th>');
    expect(html).toContain('<th scope="col">Gasto depois</th>');
    expect(html).toContain(`data-rot="Gasto depois">${nbsp('R$ 39,97 por dia')}<span class="sub">média de 10 dias</span>`);
    expect(html).toContain('data-rot="Situação"');
  });

  it('sem os limites: o aviso do que o Liame deixa de fazer e o botão para definir', () => {
    const html = desenhar(semTeto());
    expect(html).toContain('Ainda não definido');
    expect(html).toContain('Sem os dois limites, o Liame só reduz verba e pausa. Aumentar e retomar ficam negados.');
    expect(html).toContain('Definir os limites');
    expect(html).not.toContain('verba-barra');
    expect(html).toContain('<span class="limite-val--falta">não definido</span>');
  });

  it('quem não gerencia o orçamento só acompanha: sem o botão, com o motivo', () => {
    const html = desenhar(verba(), { podeDefinir: false });
    expect(html).not.toContain('Mudar os limites');
    expect(html).toContain('Só o Dono e o Administrador mudam os limites. Você acompanha por aqui.');
    expect(html).toContain('A empresa define; o Liame nega o pedido que passar.');
    expect(html).toContain('até a empresa mudar');
  });

  it('o formulário dos limites abre com os valores de agora e as dicas do mês', () => {
    const html = desenhar(verba(), { editando: true });
    expect(html).toContain('<label for="lm-mes">Teto do mês</label>');
    expect(html).toContain('value="5500"');
    expect(html).toContain('value="80"');
    expect(html).toContain('inputMode="decimal"');
    expect(html).toContain(nbsp('Em setembro, a previsão é de R$ 5.306,94.'));
    expect(html).toContain(nbsp('Hoje a maior é de R$ 60,00 por dia.'));
    expect(html).toContain('Salvar os limites');
    expect(html).toContain('Os limites valem na hora, para os próximos pedidos. A mudança fica na auditoria, com o seu nome.');
    // Com o formulário aberto, o botão de abrir some (o foco volta para ele ao fechar).
    expect(html).not.toContain('Mudar os limites');
  });

  it('as faixas do topo levam a Contas e a Resultados, para quem pode vê-las', () => {
    const atrasada = { ...metaAtrasada(), remaining_micros: -r(106.94), limits: { ...metaAtrasada().limits, month_micros: r(5200) } };
    const html = desenhar(atrasada);
    expect(html).toContain('A Meta não foi lida hoje: a última leitura é de ontem, 06:12');
    expect(html).toContain('href="/contas"');
    expect(html).toContain('Ver a conexão');
    expect(html).toContain('role="alert"');
    expect(html).toContain('href="/resultados"');
    expect(html).toContain('Ver as campanhas');
    const semAcesso = desenhar(atrasada, { podeVerContas: false, podeVerResultados: false });
    expect(semAcesso).toContain('A Meta não foi lida hoje');
    expect(semAcesso).not.toContain('href="/contas"');
    expect(semAcesso).not.toContain('href="/resultados"');
  });

  it('sem conta de anúncio conectada: a tela explica, leva a Contas e ainda mostra os limites', () => {
    const html = desenhar(verba({ platforms: [], spend_micros: 0, daily_micros: 0, forecast_micros: 0, remaining_micros: r(5500), largest_daily_micros: null }));
    expect(html).toContain('Conecte uma conta de anúncio para acompanhar a verba');
    expect(html).toContain('Abrir Contas conectadas');
    expect(html).not.toContain('gasto em anúncios');
    expect(html).toContain('Limites da empresa');
    expect(html).not.toContain('De onde vêm os números');
  });

  it('sem mudança no mês: o cartão diz o que vai aparecer ali', () => {
    const html = desenhar(verba());
    expect(html).toContain('O Liame não mudou nada em setembro');
    expect(html).not.toContain('<table class="tabela tabela--compacta tabela--pilha">');
  });

  it('as situações que pedem atenção: mudado na Meta, gastou a mais e trocada por outro pedido', () => {
    const html = desenhar(
      verba({
        changes: [
          mudanca({ action_id: uuid(70), check: conferencia({ status: 'mudou', since: '2026-09-27', informed_daily_micros: r(45) }) }),
          mudanca({ action_id: uuid(71), check: conferencia({ status: 'acima', window_spend_micros: r(300), window_allowed_micros: r(280) }) }),
          mudanca({ action_id: uuid(72), superseded_by: { action_id: uuid(70), executed_at: '2026-09-25T13:00:00.000Z' } }),
        ],
      }),
      { modo: 'pro' },
    );
    expect(html).toContain('concilia-sit concilia-sit--mudou');
    expect(html).toContain('Mudado na Meta');
    expect(html).toContain('concilia-sit concilia-sit--acima');
    expect(html).toContain('Gastou a mais');
    expect(html).toContain('concilia-sit concilia-sit--trocada');
    expect(html).toContain('Trocada por outro pedido');
  });
});

describe('menu: a Verba do mês vem depois de Resultados', () => {
  const agencia = NAVEGACAO.find((g) => g.id === 'agencia')!;

  it('o item, a permissão de quem acompanha as campanhas e o ícone', () => {
    const i = agencia.itens.findIndex((x) => x.href === '/verba');
    expect(agencia.itens[i]).toEqual({ href: '/verba', rotulo: 'Verba do mês', icone: 'wallet', permissao: 'campanhas.ver', modos: true });
    expect(agencia.itens[i - 1]!.href).toBe('/resultados');
    expect(itensVisiveis(agencia, (p) => p !== 'campanhas.ver').map((x) => x.href)).not.toContain('/verba');
    expect(renderToStaticMarkup(createElement(Icone, { nome: 'wallet' }))).toContain('<svg class="ic"');
  });

  it('o título da tela e o seletor Lite e Pro', () => {
    expect(tituloDa('/verba')).toBe('Verba do mês');
    expect(temModos('/verba', () => true)).toBe(true);
    expect(temModos('/verba', (p) => p !== 'campanhas.ver')).toBe(false);
  });

  it('o aviso de gasto acima da verba leva à Verba do mês, que é de quem acompanha as campanhas', () => {
    expect(acaoDoAviso('gasto_acima_da_verba')).toBe('abrir-verba');
    expect(destinoDoAviso('abrir-verba')).toEqual({ href: '/verba', rotulo: 'Abrir a Verba do mês' });
    expect(destinoPedeVendas('abrir-verba')).toBe(false);
    expect(destinoPedeVendas('abrir-resultados')).toBe(true);
  });
});

describe('Verba do mês: onde o Liame muda campanhas (A5 · Y3)', () => {
  /** O mês com a escrita ligada (ou não) em cada plataforma, como o servidor informa em `writes`. */
  const comEscrita = (meta: boolean, google: boolean, over: Partial<BudgetMonthResponse> = {}) =>
    verba({ platforms: [plataformaDoMes('meta_ads', { writes: meta }), plataformaDoMes('google_ads', { writes: google })], ...over });
  const notas = (v: BudgetMonthResponse) => plataformasDaVerba(v).linhas.map((l) => l.nota);
  const regras = (v: BudgetMonthResponse) => limitesDaVerba(v, AGORA).regras;

  it('"só leitura" fica embaixo da plataforma em que a escrita está desligada, seja qual for', () => {
    expect(notas(comEscrita(true, true))).toEqual([null, null]);
    expect(notas(comEscrita(true, false))).toEqual([null, 'só leitura: o Liame ainda não muda campanhas do Google']);
    expect(notas(comEscrita(false, true))).toEqual(['só leitura: o Liame ainda não muda campanhas da Meta', null]);
    expect(notas(comEscrita(false, false))).toEqual(['só leitura: o Liame ainda não muda campanhas da Meta', 'só leitura: o Liame ainda não muda campanhas do Google']);
    // A resposta de antes de 09/10/2026 não dizia: vale o que a tela dizia então.
    expect(notas(verba())).toEqual([null, 'só leitura: o Liame ainda não muda campanhas do Google']);
  });

  it('as regras citam as plataformas em que o pedido existe: a Meta, o Google ou as duas', () => {
    expect(regras(comEscrita(true, true))).toEqual([
      'Nada muda na Meta nem no Google sem a aprovação de uma pessoa, com o código do app.',
      'Cada pedido muda no máximo 10% da verba diária.',
      'No máximo 3 mudanças de verba por hora na mesma campanha ou conjunto.',
      'A plataforma confere antes, e o Liame não passa por cima do que alguém mudou lá.',
      'O Liame não apaga nada na Meta nem no Google e não mexe no limite de gastos da conta.',
      'No Google, a mudança é na campanha inteira, e a verba dividida entre campanhas não muda pelo Liame.',
    ]);
    expect(regras(comEscrita(false, true))).toEqual([
      'Nada muda no Google sem a aprovação de uma pessoa, com o código do app.',
      'Cada pedido muda no máximo 10% da verba diária.',
      'No máximo 3 mudanças de verba por hora na mesma campanha ou conjunto.',
      'O Google confere antes, e o Liame não passa por cima do que alguém mudou lá.',
      'O Liame não apaga nada no Google e não mexe no limite de gastos da conta.',
      'No Google, a mudança é na campanha inteira, e a verba dividida entre campanhas não muda pelo Liame.',
    ]);
    // Só a Meta, e nenhuma (ou sem o servidor dizer): as regras de sempre.
    const deSempre = regras(verba());
    expect(deSempre[0]).toBe('Nada muda na Meta sem a aprovação de uma pessoa, com o código do app.');
    expect(regras(comEscrita(true, false))).toEqual(deSempre);
    expect(regras(comEscrita(false, false))).toEqual(deSempre);
    expect(deSempre.join(' ')).not.toContain('Google');
  });

  it('sem mudança nenhuma, o cartão "O que o Liame mudou" fala da plataforma em que o pedido existe', () => {
    expect(mudancasDaVerba(comEscrita(true, true)).sub).toBe('Cada mudança, conferida todo dia com o que a plataforma informa e com o que ela gastou.');
    expect(mudancasDaVerba(comEscrita(false, true)).sub).toBe('Cada mudança, conferida todo dia com o que o Google informa e com o que ela gastou.');
    expect(mudancasDaVerba(comEscrita(false, true)).colunaInforma).toBe('O Google informa hoje');
    // Só a Meta, nenhuma, ou sem o servidor dizer: a frase de sempre.
    for (const v of [comEscrita(true, false), comEscrita(false, false), verba()]) expect(mudancasDaVerba(v).sub).toBe('Cada mudança, conferida todo dia com o que a Meta informa e com o que ela gastou.');
  });

  it('a leitura atrasada só fala do pedido novo na plataforma em que ele existe', () => {
    const atrasada = (provider: string, writes: boolean | undefined) =>
      verba({
        forecast_days: null,
        platforms: [
          plataformaDoMes('meta_ads', provider === 'meta_ads' ? { read_through: '2026-09-27', forecast_days: 3, stale: true, last_success_at: '2026-09-28T09:12:00.000Z', writes } : { writes: true }),
          plataformaDoMes('google_ads', provider === 'google_ads' ? { read_through: '2026-09-27', forecast_days: 3, stale: true, last_success_at: '2026-09-28T09:20:00.000Z', writes } : { writes: false }),
        ],
      });
    const texto = (v: BudgetMonthResponse) => avisosDaVerba(v, AGORA)[0]!.texto;
    expect(texto(atrasada('google_ads', true))).toBe('O gasto do Google abaixo vale até 27/09; o dia 28 entra na previsão pelo ritmo. O Liame tenta ler de novo sozinho. Enquanto isso, um pedido novo continua lendo a campanha no Google na hora.');
    expect(texto(atrasada('google_ads', false))).toBe('O gasto do Google abaixo vale até 27/09; o dia 28 entra na previsão pelo ritmo. O Liame tenta ler de novo sozinho.');
    expect(texto(atrasada('meta_ads', true))).toContain('um pedido novo continua lendo a campanha na Meta na hora.');
    // Com a escrita na Meta desligada, a tela não promete pedido.
    expect(texto(atrasada('meta_ads', false))).not.toContain('pedido novo');
    // Sem o servidor dizer, vale o de sempre (a Meta com a frase).
    expect(texto(atrasada('meta_ads', undefined))).toContain('um pedido novo continua lendo a campanha na Meta na hora.');
  });
});
