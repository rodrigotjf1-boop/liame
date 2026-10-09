import type { ActionOpenRequest, ActionOptionsResponse, ActionTargetsResponse, BudgetMonthResponse } from '@liame/contracts';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { BotaoPedir, type PedirNaLista } from '@/components/pedir/botao-pedir';
import { GavetaPedir } from '@/components/pedir/gaveta-pedir';
import {
  acoesDe,
  agoraNaPlataforma,
  conferirPedido,
  depoisDeCriar,
  dicaDaVerba,
  efeitoDoPedido,
  erroDoPedido,
  faixaDaVerba,
  falhaDaLeitura,
  lendoNaPlataforma,
  limitesDaGaveta,
  listaLidaEm,
  mostraOPedir,
  naPlataforma,
  notaDoPedido,
  notaDoPedir,
  ondeDe,
  pedirPorCampanha,
  type Rascunho,
  semOpcoes,
  temOnde,
  verbaDividida,
  tituloDoPedido,
  verbaNoCampo,
} from '@/components/pedir/textos';
import { textoDe } from '@/components/resultados/textos';
import { reaisDigitados } from '@/components/verba/textos';

// O pedido de mudança (A4 · X8; protótipo P9, aprovado em 05/10/2026: mockups/prototipo-anuncios.html): o botão
// "Pedir mudança" de Resultados e a gaveta "Pedir uma mudança". As frases saem do que a API manda
// (`GET /v1/actions/targets`, `GET /v1/actions/options` e `GET /v1/budget/month`); quem decide o pedido é o servidor.
// O cenário é o do protótipo: terça, 29/09, com dois dias até o fim do mês e os dois limites definidos.

const FUSO = 'America/Sao_Paulo';
const AGORA = new Date('2026-09-29T17:40:00Z'); // 14:40 em São Paulo
/** O espaço fixo depois do "R$" vira espaço comum, para comparar as frases. */
const sp = (s: string) => s.replaceAll(String.fromCharCode(160), ' ');
const uuid = (n: number) => `a0000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
/** Reais (com centavos) em micros, sem ponto flutuante na conta. */
const r = (reais: number) => Math.round(reais * 100) * 10_000;

type Alvo = ActionOptionsResponse['target'];
const CAMPANHA = 'campanha:120210000000013';

function opcoes(over: Partial<ActionOptionsResponse> = {}, alvo: Partial<Alvo> = {}): ActionOptionsResponse {
  return {
    campaign: { id: uuid(13), name: 'Smash em dobro', provider: 'meta_ads', brand_id: uuid(900), account_id: uuid(800), account_name: 'Mister Burgers' },
    target: { resource_id: CAMPANHA, kind: 'campanha', name: 'Smash em dobro', status: 'ativo', effective_status: 'ACTIVE', daily_micros: r(40), ...alvo },
    read_at: '2026-09-29T17:32:00.000Z',
    tools: ['orcamento_ajustar', 'campanha_pausar'],
    ad_sets: [{ resource_id: 'conjunto:41', kind: 'conjunto', name: 'Smash · conversas no WhatsApp', status: 'ativo', daily_micros: null }],
    ads: [
      { resource_id: 'anuncio:1', kind: 'anuncio', name: 'Smash em dobro · vídeo', status: 'ativo', daily_micros: null, ad_set: 'conjunto:41' },
      { resource_id: 'anuncio:2', kind: 'anuncio', name: 'Smash em dobro · foto', status: 'pausado', daily_micros: null, ad_set: 'conjunto:41' },
    ],
    listed_at: '2026-09-29T09:12:00.000Z',
    open: [],
    ...over,
  };
}

/** A campanha com a verba nos conjuntos ("Delivery noite" do protótipo). */
const noiteNosConjuntos = (over: Partial<ActionOptionsResponse> = {}, alvo: Partial<Alvo> = {}) =>
  opcoes(
    {
      campaign: { id: uuid(14), name: 'Delivery noite', provider: 'meta_ads', brand_id: uuid(900), account_id: uuid(800), account_name: 'Mister Burgers' },
      tools: ['campanha_pausar'],
      ad_sets: [
        { resource_id: 'conjunto:1', kind: 'conjunto', name: 'Noite · raio de 3 km', status: 'ativo', daily_micros: r(18) },
        { resource_id: 'conjunto:2', kind: 'conjunto', name: 'Noite · quem já pediu', status: 'pausado', daily_micros: r(12) },
      ],
      ads: [{ resource_id: 'anuncio:4', kind: 'anuncio', name: 'Delivery noite · foto do combo', status: 'ativo', daily_micros: null, ad_set: 'conjunto:1' }],
      ...over,
    },
    { resource_id: 'campanha:120210000000014', name: 'Delivery noite', daily_micros: null, ...alvo },
  );
/** O conjunto em pausa, com a verba nele. */
const conjuntoPausado = () => noiteNosConjuntos({ tools: ['conjunto_retomar'] }, { resource_id: 'conjunto:2', kind: 'conjunto', name: 'Noite · quem já pediu', status: 'pausado', effective_status: 'PAUSED', daily_micros: r(12) });
/** O anúncio: nunca tem verba própria. */
const anuncio = (over: Partial<Alvo> = {}, tools = ['anuncio_pausar']) => opcoes({ tools }, { resource_id: 'anuncio:1', kind: 'anuncio', name: 'Smash em dobro · vídeo', daily_micros: null, ...over });

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
    platforms: [],
    rules: { change_percent_max: 10, rate_limit: { max: 3, window_minutes: 60 } },
    changes: [],
    overspend: [],
    largest_daily_micros: r(60),
    generated_at: '2026-09-29T17:40:00.000Z',
    ...over,
  };
}
const semTeto = () => verba({ remaining_micros: null }, { month_micros: null, campaign_daily_micros: null, set_by: null, set_at: null });

const aberto = (id: number, over: Partial<ActionOpenRequest> = {}): ActionOpenRequest => ({
  id: uuid(id),
  tool: 'orcamento_ajustar',
  action: 'orcamento.reduzir',
  resource_id: CAMPANHA,
  status: 'aguardando_aprovacao',
  value_micros: r(36),
  created_at: '2026-09-29T17:20:00.000Z',
  ...over,
});

const efeito = (o: ActionOptionsResponse, rascunho: Rascunho, v: BudgetMonthResponse | null = verba()) => sp(textoDe(efeitoDoPedido(o, rascunho, v)));
const recusa = (o: ActionOptionsResponse, rascunho: Rascunho, v: BudgetMonthResponse | null = verba()) => {
  const c = conferirPedido(o, rascunho, v);
  if (c.ok) throw new Error('esperava a recusa, e o pedido passou');
  return { ...c, erro: sp(c.erro) };
};

describe('Resultados: onde dá para pedir uma mudança', () => {
  const alvos: ActionTargetsResponse = {
    campaigns: [
      { campaign_id: uuid(11), write: 'ligada', open: [] },
      { campaign_id: uuid(13), write: 'ligada', open: [aberto(501), aberto(502, { tool: 'campanha_pausar', action: 'campanha.pausar', value_micros: null })] },
      { campaign_id: uuid(14), write: 'so_leitura', open: [aberto(503, { status: 'executando' })] },
    ],
  };

  it('cada campanha da lista do servidor ganha o botão; os pedidos em aberto viram o atalho para o mais novo', () => {
    const mapa = pedirPorCampanha(alvos);
    expect(mapa.get(uuid(11))).toEqual({ esperando: null });
    expect(mapa.get(uuid(13))).toEqual({ esperando: { rotulo: '2 pedidos esperando', href: `/aprovacoes?pedido=${uuid(501)}` } });
    // A conta que só lê também entra: a gaveta é quem diz para conectar de novo.
    expect(mapa.get(uuid(14))).toEqual({ esperando: { rotulo: '1 pedido esperando', href: `/aprovacoes?pedido=${uuid(503)}` } });
    expect(mapa.has(uuid(12))).toBe(false);
    expect(pedirPorCampanha(null).size).toBe(0);
  });

  it('a coluna só aparece com o que mostrar: o botão para quem opera, o pedido esperando para quem só acompanha', () => {
    const mapa = pedirPorCampanha(alvos);
    expect(mostraOPedir([uuid(11), uuid(12)], mapa, true)).toBe(true);
    expect(mostraOPedir([uuid(12)], mapa, true)).toBe(false);
    expect(mostraOPedir([uuid(11)], mapa, false)).toBe(false);
    expect(mostraOPedir([uuid(11), uuid(13)], mapa, false)).toBe(true);
    expect(mostraOPedir([], mapa, true)).toBe(false);
  });

  it('a nota diz onde o botão vale e quais plataformas seguem só para leitura', () => {
    expect(notaDoPedir(['meta_ads', 'meta_ads'], ['google_ads'])).toBe(
      '“Pedir mudança” vale para as campanhas da Meta: mudar a verba, pausar e retomar, sempre com a sua aprovação. As do Google seguem só para leitura.',
    );
    expect(notaDoPedir(['meta_ads'], [])).toBe('“Pedir mudança” vale para as campanhas da Meta: mudar a verba, pausar e retomar, sempre com a sua aprovação.');
    // A campanha da Meta sem botão (arquivada, ou de conta sem a escrita) não vira "as da Meta seguem só para leitura".
    expect(notaDoPedir(['meta_ads'], ['meta_ads'])).not.toContain('seguem só para leitura');
    expect(notaDoPedir(['meta_ads'], ['google_ads', 'plataforma_nova'])).toContain('As do Google e da plataforma seguem só para leitura.');
    expect([naPlataforma('meta_ads'), naPlataforma('google_ads'), naPlataforma('plataforma_nova')]).toEqual(['na Meta', 'no Google', 'na plataforma']);
  });

  it('o botão: rótulo falado com o nome da campanha, a versão curta da tabela e nada para a campanha fora da lista', () => {
    const pedir: PedirNaLista = { porCampanha: pedirPorCampanha(alvos), podePedir: true, aberta: uuid(13), aoPedir: () => undefined };
    const desenhar = (id: number, extra: { curto?: boolean; pedir?: PedirNaLista } = {}) =>
      renderToStaticMarkup(createElement(BotaoPedir, { campanha: { id: uuid(id), nome: 'Smash em dobro', provider: 'meta_ads' }, pedir: extra.pedir ?? pedir, ...(extra.curto ? { curto: true } : {}) }));
    const cheio = desenhar(13);
    expect(cheio).toContain('aria-label="Pedir mudança na campanha Smash em dobro"');
    expect(cheio).toContain('aria-haspopup="dialog"');
    // É por este atributo que o foco volta para o botão da campanha quando a gaveta fecha.
    expect(cheio).toContain(`data-pedir="${uuid(13)}"`);
    expect(cheio).toContain('aria-expanded="true"');
    expect(cheio).toContain('Pedir mudança</button>');
    expect(cheio).toContain(`<a class="pedido-esperando" href="/aprovacoes?pedido=${uuid(501)}">2 pedidos esperando</a>`);
    expect(desenhar(11)).toContain('aria-expanded="false"');
    expect(desenhar(11)).not.toContain('pedido-esperando');
    expect(desenhar(13, { curto: true })).toContain('Pedir</button>');
    expect(desenhar(12)).toBe('');
    // Quem só acompanha as campanhas vê o pedido que espera, sem o botão.
    const soVe = desenhar(13, { pedir: { ...pedir, podePedir: false } });
    expect(soVe).not.toContain('<button');
    expect(soVe).toContain('2 pedidos esperando');
  });
});

describe('a gaveta: o que dá para pedir e como o objeto está agora', () => {
  it('as ações seguem a ordem do servidor; a ferramenta que a tela não conhece fica de fora', () => {
    expect(acoesDe(['orcamento_ajustar', 'campanha_pausar'])).toEqual([
      { acao: 'verba', tool: 'orcamento_ajustar', rotulo: 'A verba diária', icone: 'wallet' },
      { acao: 'pausar', tool: 'campanha_pausar', rotulo: 'Pausar', icone: 'pause' },
    ]);
    expect(acoesDe(['conjunto_retomar'])).toEqual([{ acao: 'retomar', tool: 'conjunto_retomar', rotulo: 'Retomar', icone: 'play' }]);
    expect(acoesDe(['ferramenta_nova', 'anuncio_pausar']).map((a) => a.tool)).toEqual(['anuncio_pausar']);
    expect(acoesDe([])).toEqual([]);
  });

  it('o campo "Onde": os conjuntos e os anúncios da leitura diária, com o que está em pausa marcado e a hora da lista', () => {
    expect(ondeDe(opcoes())).toEqual({
      conjuntos: [{ valor: 'conjunto:41', rotulo: 'Smash · conversas no WhatsApp' }],
      anuncios: [
        { valor: 'anuncio:1', rotulo: 'Smash em dobro · vídeo' },
        { valor: 'anuncio:2', rotulo: 'Smash em dobro · foto (pausado)' },
      ],
    });
    expect(listaLidaEm(opcoes(), FUSO, AGORA)).toBe('A lista de conjuntos e anúncios é a da leitura de hoje, 06:12.');
    expect(listaLidaEm(opcoes({ listed_at: '2026-09-28T09:12:00.000Z' }), FUSO, AGORA)).toBe('A lista de conjuntos e anúncios é a da leitura de ontem, 06:12.');
    expect(listaLidaEm(opcoes({ listed_at: null }), FUSO, AGORA)).toBeNull();
    expect(listaLidaEm(opcoes({ ad_sets: [], ads: [] }), FUSO, AGORA)).toBeNull();
  });

  it('"Agora, na Meta": a situação, onde mora a verba e a hora da leitura', () => {
    const linhas = (o: ActionOptionsResponse) => agoraNaPlataforma(o, FUSO).linhas.map((l) => [l.rotulo, sp(l.valor), l.sub === null ? null : sp(l.sub)]);
    expect(agoraNaPlataforma(opcoes(), FUSO).titulo).toBe('Agora, na Meta');
    expect(linhas(opcoes())).toEqual([
      ['Situação', 'Ativa', null],
      ['Verba diária', 'R$ 40,00', 'na campanha'],
      ['Lido na Meta', 'agora, às 14:32', null],
    ]);
    // A verba nos conjuntos: a campanha diz onde ela está, com o que a leitura diária viu.
    expect(linhas(noiteNosConjuntos())[1]).toEqual(['Verba diária', 'Fica nos conjuntos', 'Noite · raio de 3 km: R$ 18,00 · Noite · quem já pediu: R$ 12,00 (pausado)']);
    expect(linhas(noiteNosConjuntos({ ad_sets: [] }))[1]).toEqual(['Verba diária', 'Não tem verba diária', 'a verba desta campanha é de período, ou a plataforma não informou']);
    expect(linhas(conjuntoPausado())).toEqual([
      ['Conjunto', 'Noite · quem já pediu', null],
      ['Situação', 'Pausado', null],
      ['Verba diária', 'R$ 12,00', 'no conjunto'],
      ['Lido na Meta', 'agora, às 14:32', null],
    ]);
    const conjuntoSemVerba = opcoes({}, { resource_id: 'conjunto:41', kind: 'conjunto', name: 'Smash · conversas no WhatsApp', daily_micros: null });
    expect(linhas(conjuntoSemVerba)[2]).toEqual(['Verba diária', 'Não tem verba própria', 'a verba fica na campanha, ou é de período']);
    // O anúncio gasta dentro da verba de quem a tem: a campanha, ou o conjunto dele.
    expect(linhas(anuncio())).toEqual([
      ['Anúncio', 'Smash em dobro · vídeo', null],
      ['Situação', 'Ativo', null],
      ['Verba diária', 'Não tem verba própria', 'o anúncio gasta dentro da verba da campanha'],
      ['Lido na Meta', 'agora, às 14:32', null],
    ]);
    const anuncioDaNoite = noiteNosConjuntos({ tools: ['anuncio_pausar'] }, { resource_id: 'anuncio:4', kind: 'anuncio', name: 'Delivery noite · foto do combo' });
    expect(linhas(anuncioDaNoite)[2]).toEqual(['Verba diária', 'Não tem verba própria', 'o anúncio gasta dentro da verba do conjunto dele']);
  });

  it('a situação: o pai em pausa aparece ao lado, e a que a tela não conhece sai como veio', () => {
    const situacao = (alvo: Partial<Alvo>) => {
      const l = agoraNaPlataforma(anuncio(alvo), FUSO).linhas.find((x) => x.rotulo === 'Situação')!;
      return [l.valor, l.sub];
    };
    expect(situacao({ effective_status: 'CAMPAIGN_PAUSED' })).toEqual(['Ativo', 'a campanha está em pausa: ele não roda enquanto ela estiver parada']);
    expect(situacao({ effective_status: 'ADSET_PAUSED' })).toEqual(['Ativo', 'o conjunto dele está em pausa: ele não roda enquanto o conjunto estiver parado']);
    expect(situacao({ status: 'pausado', effective_status: 'CAMPAIGN_PAUSED' })).toEqual(['Pausado', null]);
    expect(situacao({ status: 'arquivado', effective_status: null })).toEqual(['Arquivado', null]);
    expect(situacao({ status: 'desconhecido', effective_status: null })).toEqual(['Situação desconhecida', null]);
    expect(situacao({ status: 'em_analise', effective_status: null })).toEqual(['Em analise', null]);
    expect(agoraNaPlataforma(opcoes({}, { status: 'removido' }), FUSO).linhas[0]!.valor).toBe('Removida');
  });

  it('o objeto arquivado ou removido não aceita mudança, e a gaveta diz por quê', () => {
    expect(semOpcoes(opcoes({ tools: [] }, { status: 'arquivado' }))).toBe('A campanha “Smash em dobro” foi arquivada ou removida na Meta: não dá para mudar.');
    expect(semOpcoes(anuncio({ status: 'removido' }, []))).toBe('O anúncio “Smash em dobro · vídeo” foi arquivado ou removido na Meta: não dá para mudar.');
    expect(semOpcoes(anuncio({ status: 'desconhecido' }, []))).toBe('Não há mudança que caiba aqui agora: o anúncio “Smash em dobro · vídeo” está na Meta numa situação que o Liame não muda.');
  });

  it('os limites da empresa, o que sobra do mês e o passo por pedido', () => {
    const linhas = (v: BudgetMonthResponse): string[][] => {
      const l = limitesDaGaveta(v);
      if (l?.tipo !== 'ok') throw new Error('esperava os limites definidos');
      return l.linhas.map((x) => [x.rotulo, sp(x.valor)]);
    };
    expect(linhas(verba())).toEqual([
      ['Teto por campanha', 'R$ 80,00 por dia'],
      ['Verba de setembro', 'sobram R$ 193,06 de R$ 5.500,00'],
      ['Por pedido', 'no máximo 10% da verba'],
    ]);
    expect(linhas(verba({ remaining_micros: -r(100) }))[1]).toEqual(['Verba de setembro', 'passa R$ 100,00 do teto de R$ 5.500,00']);
    expect(linhas(verba({ rules: { change_percent_max: null, rate_limit: null } }))).toHaveLength(2);
    expect(limitesDaGaveta(semTeto())).toEqual({
      tipo: 'sem',
      titulo: 'A empresa ainda não definiu os limites',
      texto: 'Sem o teto do mês e o teto por campanha, o Liame só reduz verba e pausa. Aumentar e retomar ficam negados.',
    });
    // Sem a verba lida, a gaveta não inventa limite: o servidor confere no pedido.
    expect(limitesDaGaveta(null)).toBeNull();
  });
});

describe('a verba pedida', () => {
  it('a faixa de um pedido fica em centavos inteiros e nunca passa do passo', () => {
    expect(faixaDaVerba(r(40), 10)).toEqual({ min: r(36), max: r(44) });
    expect(faixaDaVerba(r(60), 10)).toEqual({ min: r(54), max: r(66) });
    // O mínimo arredonda para cima e o máximo para baixo.
    expect(faixaDaVerba(r(33.33), 10)).toEqual({ min: r(30), max: r(36.66) });
    expect(faixaDaVerba(r(40), 7.5)).toEqual({ min: r(37), max: r(43) });
    expect([verbaNoCampo(r(36)), verbaNoCampo(r(1234.5)), verbaNoCampo(r(0.05))]).toEqual(['36,00', '1234,50', '0,05']);
  });

  it('a dica e os dois atalhos saem da verba de agora e da regra lida do servidor', () => {
    const d = dicaDaVerba(r(40), verba());
    expect(sp(d.texto)).toBe('Hoje: R$ 40,00 por dia. Cada pedido muda no máximo 10%: de R$ 36,00 a R$ 44,00.');
    expect(d.atalhos).toEqual({ reduzir: { rotulo: 'Reduzir 10%', valor: '36,00' }, aumentar: { rotulo: 'Aumentar 10%', valor: '44,00' } });
    // Sem a regra lida, a tela não limita nem oferece atalho.
    const semRegra = dicaDaVerba(r(40), null);
    expect(sp(semRegra.texto)).toBe('Hoje: R$ 40,00 por dia.');
    expect(semRegra.atalhos).toBeNull();
  });

  it('os atalhos nunca pedem mais do que o servidor aceita (a mesma conta da política, em toda verba de R$ 1 a R$ 5.000)', () => {
    // A política recusa quando |valor − atual| ÷ atual × 100 passa de 10 (`policy/engine.ts`). A varredura usa só a
    // conta em inteiros da faixa (centavo a centavo); a formatação e a conferência do pedido ficam para a amostra abaixo.
    const foraDaRegra: number[] = [];
    for (let centavos = 100; centavos <= 500_000; centavos++) {
      const atual = centavos * 10_000;
      const f = faixaDaVerba(atual, 10);
      const passa = (valor: number) => Math.abs(((valor - atual) / atual) * 100) > 10;
      if (passa(f.min) || passa(f.max) || f.min < 1_000_000 || f.min > atual || f.max < atual) foraDaRegra.push(centavos);
    }
    expect(foraDaRegra).toEqual([]);

    // O atalho põe no campo a ponta da faixa, e a conferência aceita o que ele pôs.
    const folgado = verba({ remaining_micros: r(900000) }, { month_micros: r(1000000), campaign_daily_micros: r(100000) });
    for (const atual of [r(1.37), r(6), r(33.33), r(40), r(99.99), r(1234.56), r(5000)]) {
      const f = faixaDaVerba(atual, 10);
      const d = dicaDaVerba(atual, folgado).atalhos!;
      expect([reaisDigitados(d.reduzir.valor), reaisDigitados(d.aumentar.valor)]).toEqual([f.min, f.max]);
      for (const atalho of [d.reduzir, d.aumentar]) {
        expect(conferirPedido(opcoes({}, { daily_micros: atual }), { acao: 'verba', valor: atalho.valor }, folgado).ok, `${atual} → ${atalho.valor}`).toBe(true);
      }
    }
    // Na verba mínima não há como reduzir: o atalho repete o valor de agora, e a conferência diz isso.
    expect(dicaDaVerba(r(1), folgado).atalhos!.reduzir.valor).toBe('1,00');
    expect(conferirPedido(opcoes({}, { daily_micros: r(1) }), { acao: 'verba', valor: '1,00' }, folgado)).toMatchObject({ ok: false, noValor: true });
  });
});

describe('a frase do efeito', () => {
  it('a verba: digitar, reduzir e aumentar, com o que cabe nos limites', () => {
    expect(efeito(opcoes(), { acao: 'verba', valor: '' })).toBe('Digite a nova verba diária para ver o que muda.');
    expect(efeito(opcoes(), { acao: 'verba', valor: 'quarenta' })).toBe('Digite a nova verba diária para ver o que muda.');
    expect(efeito(opcoes(), { acao: 'verba', valor: '40' })).toBe('A verba já é de R$ 40,00 por dia.');
    expect(efeito(opcoes(), { acao: 'verba', valor: '36,00' })).toBe('A verba cai R$ 4,00 por dia (−10%). Reduzir não depende do teto por campanha nem da verba do mês.');
    expect(efeito(opcoes(), { acao: 'verba', valor: '44' })).toBe('A verba sobe R$ 4,00 por dia (+10%). Até o fim de setembro são R$ 8,00 a mais: cabem na verba do mês (sobram R$ 193,06).');
    expect(efeito(opcoes(), { acao: 'verba', valor: '43' })).toContain('(+7,5%)');
    // Fora do passo por pedido, a frase diz isso em vez de prometer que cabe.
    expect(efeito(opcoes(), { acao: 'verba', valor: '50' })).toBe('A verba sobe R$ 10,00 por dia (+25%): passa do máximo de 10% por pedido.');
    expect(efeito(opcoes(), { acao: 'verba', valor: '30' })).toBe('A verba cai R$ 10,00 por dia (−25%): passa do máximo de 10% por pedido.');
    // Sem a regra lida, a tela não sabe o passo: a frase segue a conta.
    expect(efeito(opcoes(), { acao: 'verba', valor: '30' }, null)).toBe('A verba cai R$ 10,00 por dia (−25%). Reduzir não depende do teto por campanha nem da verba do mês.');
    // O trecho em destaque é o que muda.
    expect(efeitoDoPedido(opcoes(), { acao: 'verba', valor: '36' }, verba()).find((t) => t.b)?.t).toBe(`cai R$${String.fromCharCode(160)}4,00 por dia`);
  });

  it('o aumento que os limites barrariam é avisado antes de pedir', () => {
    const sobe = { acao: 'verba', valor: '44' } as const;
    expect(efeito(opcoes(), sobe, verba({ remaining_micros: r(5) }))).toBe('A verba sobe R$ 4,00 por dia (+10%). Até o fim de setembro são R$ 8,00 a mais, e não cabem na verba do mês.');
    expect(efeito(opcoes({}, { daily_micros: r(78) }), { acao: 'verba', valor: '85,80' })).toBe(
      'A verba sobe R$ 7,80 por dia (+10%). Até o fim de setembro são R$ 15,60 a mais, mas o valor passa do teto por campanha.',
    );
    expect(efeito(opcoes(), sobe, semTeto())).toBe('A verba sobe R$ 4,00 por dia (+10%). Até o fim de setembro são R$ 8,00 a mais, e a empresa ainda não definiu os limites.');
    // Sem a verba do mês lida, a frase não promete: o servidor confere.
    expect(efeito(opcoes(), sobe, null)).toBe('A verba sobe R$ 4,00 por dia (+10%). O Liame confere com os limites da empresa ao receber o pedido.');
  });

  it('pausar: para de aparecer e de gastar, com o gênero do objeto', () => {
    expect(efeito(opcoes(), { acao: 'pausar', valor: '' })).toBe('A campanha “Smash em dobro” para de aparecer e de gastar (hoje R$ 40,00 por dia). Fica pausada, não apagada.');
    expect(efeito(anuncio(), { acao: 'pausar', valor: '' })).toBe('O anúncio “Smash em dobro · vídeo” para de aparecer e de gastar. Fica pausado, não apagado.');
  });

  it('retomar: volta a gastar, e a frase diz quando os limites negam', () => {
    const volta = { acao: 'retomar', valor: '' } as const;
    expect(efeito(conjuntoPausado(), volta)).toBe(
      'O conjunto “Noite · quem já pediu” volta a aparecer e a gastar até R$ 12,00 por dia. Até o fim de setembro são até R$ 24,00: cabem na verba do mês (sobram R$ 193,06).',
    );
    const anuncioPausado = anuncio({ status: 'pausado' }, ['anuncio_retomar']);
    expect(efeito(anuncioPausado, volta)).toBe('O anúncio “Smash em dobro · vídeo” volta a aparecer e a gastar, dentro da verba que já existe: a verba não muda.');
    expect(efeito(conjuntoPausado(), volta, verba({ remaining_micros: -r(100) }))).toBe(
      'O conjunto “Noite · quem já pediu” volta a aparecer e a gastar até R$ 12,00 por dia. Até o fim de setembro são até R$ 24,00. Mas o mês já passa do teto: retomar fica negado.',
    );
    expect(efeito(conjuntoPausado(), volta, verba({ remaining_micros: r(10) }))).toContain('são até R$ 24,00. Mas isso não cabe na verba do mês: retomar fica negado.');
    expect(efeito(conjuntoPausado(), volta, semTeto())).toContain('são até R$ 24,00. Mas a empresa ainda não definiu o teto do mês: retomar fica negado.');
    expect(efeito(anuncioPausado, volta, semTeto())).toBe(
      'O anúncio “Smash em dobro · vídeo” volta a aparecer e a gastar, dentro da verba que já existe: a verba não muda. Mas a empresa ainda não definiu o teto do mês: retomar fica negado.',
    );
    expect(efeito(conjuntoPausado(), volta, null)).toBe('O conjunto “Noite · quem já pediu” volta a aparecer e a gastar até R$ 12,00 por dia.');
  });
});

describe('a conferência antes de enviar', () => {
  it('a verba: valor ilegível, abaixo de R$ 1, igual ao de agora e fora do passo', () => {
    expect(recusa(opcoes(), { acao: 'verba', valor: '' })).toEqual({ ok: false, erro: 'Digite a nova verba diária em reais, como 36,00.', noValor: true });
    expect(recusa(opcoes(), { acao: 'verba', valor: '0,50' }).erro).toBe('Digite a nova verba diária em reais, como 36,00.');
    expect(recusa(opcoes(), { acao: 'verba', valor: '40,00' })).toEqual({ ok: false, erro: 'A verba já é de R$ 40,00 por dia.', noValor: true });
    expect(recusa(opcoes(), { acao: 'verba', valor: '50' })).toEqual({
      ok: false,
      erro: 'Cada pedido muda no máximo 10%. De R$ 40,00, dá para ir de R$ 36,00 a R$ 44,00. Para mudar mais, faça outro pedido depois deste.',
      noValor: true,
    });
    expect(recusa(opcoes(), { acao: 'verba', valor: '35,99' }).erro).toContain('Cada pedido muda no máximo 10%');
    // Sem a regra lida, a faixa é do servidor: a gaveta envia.
    expect(conferirPedido(opcoes(), { acao: 'verba', valor: '30' }, null).ok).toBe(true);
  });

  it('o pedido igual em aberto não entra duas vezes, e o atalho leva a ele', () => {
    const comIgual = opcoes({ open: [aberto(501)] });
    expect(recusa(comIgual, { acao: 'verba', valor: '38' })).toEqual({
      ok: false,
      erro: 'Já existe um pedido igual esperando aprovação. Decida esse antes de pedir outro.',
      noValor: false,
      ver: `/aprovacoes?pedido=${uuid(501)}`,
    });
    expect(recusa(opcoes({ open: [aberto(501, { status: 'executando' })] }), { acao: 'verba', valor: '38' }).erro).toBe(
      'Já existe um pedido igual sendo executado. Espere ele terminar antes de pedir outro.',
    );
    // Outra ferramenta no mesmo objeto, ou a mesma em outro objeto, não é o mesmo pedido.
    expect(conferirPedido(comIgual, { acao: 'pausar', valor: '' }, verba()).ok).toBe(true);
    expect(conferirPedido(opcoes({ open: [aberto(501, { resource_id: 'conjunto:41' })] }), { acao: 'verba', valor: '38' }, verba()).ok).toBe(true);
  });

  it('os limites da empresa: sem eles, acima do teto por campanha e sem caber no mês', () => {
    expect(recusa(opcoes(), { acao: 'verba', valor: '44' }, semTeto())).toEqual({
      ok: false,
      erro: 'Para aumentar a verba, a empresa precisa definir antes o teto do mês e o teto por campanha. Reduzir e pausar não dependem deles.',
      noValor: true,
      limites: true,
    });
    expect(recusa(conjuntoPausado(), { acao: 'retomar', valor: '' }, semTeto())).toEqual({
      ok: false,
      erro: 'Para retomar, a empresa precisa definir antes o teto do mês. Reduzir e pausar não dependem deles.',
      noValor: false,
      limites: true,
    });
    // Reduzir e pausar não dependem dos limites.
    expect(conferirPedido(opcoes(), { acao: 'verba', valor: '36' }, semTeto()).ok).toBe(true);
    expect(conferirPedido(opcoes(), { acao: 'pausar', valor: '' }, semTeto()).ok).toBe(true);

    expect(recusa(opcoes({}, { daily_micros: r(78) }), { acao: 'verba', valor: '85,80' }).erro).toBe(
      'R$ 85,80 passa do teto por campanha, que é de R$ 80,00 por dia. Quem muda o teto é o Dono ou o Administrador, em Verba do mês.',
    );
    expect(recusa(opcoes(), { acao: 'verba', valor: '44' }, verba({ remaining_micros: r(5) })).erro).toBe(
      'Não cabe na verba de setembro: o pedido acrescenta R$ 8,00 até o fim do mês, e sobram R$ 5,00. No ritmo atual, setembro fecha em R$ 5.306,94, e o teto é de R$ 5.500,00.',
    );
    expect(recusa(opcoes(), { acao: 'verba', valor: '44' }, verba({ remaining_micros: -r(100), pending_micros: r(60) })).erro).toBe(
      'Não cabe na verba de setembro: o mês já passa do teto em R$ 100,00. No ritmo atual, setembro fecha em R$ 5.306,94, mais R$ 60,00 de aumentos pedidos ou feitos hoje, e o teto é de R$ 5.500,00.',
    );
    // O anúncio sem verba própria, com o mês já acima do teto: retomar também é negado.
    expect(recusa(anuncio({ status: 'pausado' }, ['anuncio_retomar']), { acao: 'retomar', valor: '' }, verba({ remaining_micros: -r(100) })).erro).toContain('o mês já passa do teto em R$ 100,00');
  });

  it('o que passa vira o corpo do pedido, com a ferramenta do objeto e a recomendação quando há', () => {
    expect(conferirPedido(opcoes(), { acao: 'verba', valor: '36,00' }, verba())).toEqual({
      ok: true,
      corpo: { tool: 'orcamento_ajustar', brand_id: uuid(900), provider: 'meta_ads', account_id: uuid(800), resource_id: CAMPANHA, params: { daily_budget_micros: r(36) } },
    });
    expect(conferirPedido(opcoes(), { acao: 'pausar', valor: '40,00' }, verba())).toEqual({
      ok: true,
      corpo: { tool: 'campanha_pausar', brand_id: uuid(900), provider: 'meta_ads', account_id: uuid(800), resource_id: CAMPANHA, params: {} },
    });
    const daRecomendacao = conferirPedido(opcoes(), { acao: 'verba', valor: '44' }, verba(), uuid(700));
    expect(daRecomendacao.ok && daRecomendacao.corpo.recommendation_id).toBe(uuid(700));
    const retomar = conferirPedido(conjuntoPausado(), { acao: 'retomar', valor: '' }, verba());
    expect(retomar.ok && [retomar.corpo.tool, retomar.corpo.resource_id]).toEqual(['conjunto_retomar', 'conjunto:2']);
    // A ação que o objeto não oferece mais (ele mudou depois que a gaveta leu) não vira pedido.
    expect(recusa(opcoes(), { acao: 'retomar', valor: '' })).toEqual({ ok: false, erro: 'Esta mudança não cabe mais neste objeto. Feche e abra de novo para ler como ele está agora.', noValor: false });
  });

  it('a recusa do servidor ao criar o pedido, em palavras', () => {
    const problema = (code: string, over: object = {}) => ({ status: 422, code, title: 'Título', detail: 'O detalhe do servidor.', ...over });
    expect(erroDoPedido(problema('acao-duplicada', { status: 409 }))).toEqual({ erro: 'Já existe um pedido igual em aberto. Decida esse antes de pedir outro.', ver: '/aprovacoes' });
    expect(erroDoPedido(problema('teto-nao-definido'))).toEqual({ erro: 'O detalhe do servidor.', limites: true });
    expect(erroDoPedido(problema('envelope-nao-definido'))).toEqual({ erro: 'O detalhe do servidor.', limites: true });
    expect(
      erroDoPedido(
        problema('politica-negou', {
          errors: [
            { path: 'politica.platform.3', message: 'A variação de 12,5% passa do máximo de 10%.' },
            { path: 'politica.platform.2', message: 'Limite de 3 mudanças por hora atingido.' },
          ],
        }),
      ),
    ).toEqual({ erro: 'A variação de 12,5% passa do máximo de 10%. Limite de 3 mudanças por hora atingido.' });
    expect(erroDoPedido(problema('orcamento-insuficiente'))).toEqual({ erro: 'O detalhe do servidor.' });
    // No erro do nosso lado, o código de rastreio vai junto.
    expect(erroDoPedido(problema('erro-interno', { status: 500, trace_id: 'abc123' })).erro).toBe('O detalhe do servidor. Código de rastreio: abc123');
  });
});

describe('quando a gaveta não abre o formulário, e depois do pedido', () => {
  it('a leitura que falhou: a plataforma fora do ar, a conexão que só lê e o que não dá para pedir', () => {
    const problema = (status: number, code: string, detail = 'O detalhe do servidor.') => ({ status, code, title: 'Título', detail });
    expect(falhaDaLeitura(problema(502, 'plataforma-indisponivel'), 'meta_ads')).toEqual({
      tipo: 'fora',
      titulo: 'Não foi possível ler a campanha na Meta agora',
      texto: 'O pedido parte sempre do que está valendo na Meta neste momento. Sem essa leitura, nada foi pedido.',
    });
    expect(falhaDaLeitura(problema(0, 'sem-conexao'), 'meta_ads').tipo).toBe('fora');
    expect(falhaDaLeitura(problema(409, 'conexao-so-leitura'), 'meta_ads')).toEqual({
      tipo: 'reconectar',
      titulo: 'A conexão com a Meta ainda não deixa o Liame mudar anúncios',
      texto: 'Hoje ela só deixa ler. Conecte a Meta de novo em Contas conectadas: a Meta vai pedir a permissão de gerenciar anúncios, e as contas que já estão ligadas continuam as mesmas.',
    });
    expect(falhaDaLeitura(problema(409, 'conta-desconectada', 'A Meta recusou o acesso desta conta.'), 'meta_ads')).toEqual({
      tipo: 'reconectar',
      titulo: 'É preciso conectar a Meta de novo',
      texto: 'A Meta recusou o acesso desta conta.',
    });
    expect(falhaDaLeitura(problema(409, 'sem-permissao-na-plataforma'), 'meta_ads').tipo).toBe('reconectar');
    expect(falhaDaLeitura(problema(403, 'escrita-desligada', 'A escrita em meta_ads não está liberada para esta conta.'), 'meta_ads')).toEqual({
      tipo: 'outra',
      titulo: 'Não dá para pedir uma mudança aqui agora',
      texto: 'Nesta conta, o Liame ainda não muda anúncios: por enquanto ele só lê os números dela.',
    });
    for (const [status, code] of [
      [423, 'parada-acionada'],
      [404, 'nao-encontrado'],
      [422, 'plataforma-recusou'],
      [422, 'plataforma-so-leitura'],
    ] as const) {
      expect(falhaDaLeitura(problema(status, code), 'meta_ads'), code).toEqual({ tipo: 'outra', titulo: 'Não dá para pedir uma mudança aqui agora', texto: 'O detalhe do servidor.' });
    }
    expect(lendoNaPlataforma('meta_ads')).toBe('Lendo a campanha na Meta, para o pedido partir do que está valendo agora…');
  });

  it('o pedido criado: o título pela ação que o servidor registrou e o que vem depois', () => {
    const campanha = { kind: 'campanha', name: 'Smash em dobro' };
    expect(tituloDoPedido('orcamento.reduzir', campanha)).toBe('Reduzir a verba da campanha “Smash em dobro”');
    expect(tituloDoPedido('orcamento.aumentar', campanha)).toBe('Aumentar a verba da campanha “Smash em dobro”');
    expect(tituloDoPedido('campanha.pausar', campanha)).toBe('Pausar a campanha “Smash em dobro”');
    expect(tituloDoPedido('conjunto.retomar', { kind: 'conjunto', name: 'Noite · quem já pediu' })).toBe('Retomar o conjunto “Noite · quem já pediu”');
    expect(tituloDoPedido('anuncio.pausar', { kind: 'anuncio', name: 'Smash em dobro · vídeo' })).toBe('Pausar o anúncio “Smash em dobro · vídeo”');
    expect(tituloDoPedido('acao.nova', campanha)).toBe('Mudança da campanha “Smash em dobro”');
    expect(depoisDeCriar('aguardando_aprovacao', 'meta_ads')).toBe('Ele espera a aprovação com o código do app. Nada muda na Meta antes disso.');
    expect(depoisDeCriar('sombra', 'meta_ads')).toBe('Ele ficou só registrado: nesta conta o Liame ainda não executa este tipo de mudança. Nada muda na Meta.');
    expect(depoisDeCriar('aprovada', 'meta_ads')).toBe('Acompanhe o andamento em Aprovações.');
    expect(notaDoPedido('meta_ads')).toBe(
      'O pedido vai para Aprovações. Depois da aprovação com o código do app, o Liame confere com a Meta, faz a mudança e avisa. Dá para desfazer, se ninguém mexer depois.',
    );
  });

  it('a gaveta abre lendo a campanha na plataforma: o formulário só vem com a leitura', () => {
    const html = renderToStaticMarkup(
      createElement(GavetaPedir, {
        campanha: { id: uuid(13), nome: 'Smash em dobro', provider: 'meta_ads' },
        podeDefinirLimites: true,
        podeVerContas: true,
        reserva: { current: null },
        aoFechar: () => undefined,
        aoCriar: () => undefined,
      }),
    );
    expect(html).toContain('<dialog id="dlg-pedir" class="dialogo dialogo--lado" aria-labelledby="dlg-pedir-t">');
    expect(html).toContain('<p class="rotulo-marca">Pedir uma mudança</p>');
    expect(html).toContain('<h2 id="dlg-pedir-t">Smash em dobro</h2>');
    expect(html).toContain('Lendo a campanha na Meta, para o pedido partir do que está valendo agora…');
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('>Fechar</button>');
    expect(html).not.toContain('Pedir aprovação');
    expect(html).not.toMatch(/NaN|undefined|\[object Object\]/);
  });
});

describe('o Google no pedido de mudança (A5 · Y3; protótipo P13, parte 1)', () => {
  /** A campanha do protótipo: Busca “hambúrguer perto”, no Google, com a verba que é só dela. */
  const doGoogle = (over: Partial<ActionOptionsResponse> = {}, alvo: Partial<Alvo> = {}) =>
    opcoes(
      { campaign: { id: uuid(4), name: 'Busca “hambúrguer perto”', provider: 'google_ads', brand_id: uuid(900), account_id: uuid(801), account_name: 'Mister Burgers Ads' }, ad_sets: [], ads: [], ...over },
      { resource_id: 'campanha:21000000004', name: 'Busca “hambúrguer perto”', effective_status: 'ELIGIBLE', daily_micros: r(55), shared_budget: null, ...alvo },
    );
  /** A mesma campanha com a verba dividida: o servidor não oferece mudar a verba, só pausar. */
  const dividida = (com: string[], campanhas = com.length + 1, diario: number | null = r(120)) =>
    doGoogle({ tools: ['campanha_pausar'] }, { daily_micros: null, shared_budget: { daily_micros: diario, campaigns: campanhas, shared_with: com } });
  const aviso = (o: ActionOptionsResponse) => {
    const v = verbaDividida(o)!;
    return { ...v, texto: sp(textoDe(v.texto)) };
  };

  it('a nota do botão fala do Google e diz que nele a mudança é na campanha inteira', () => {
    expect(notaDoPedir(['meta_ads', 'google_ads'], [])).toBe(
      '“Pedir mudança” vale para as campanhas da Meta e do Google: mudar a verba, pausar e retomar, sempre com a sua aprovação. No Google, a mudança é na campanha inteira.',
    );
    expect(notaDoPedir(['google_ads'], ['meta_ads'])).toBe(
      '“Pedir mudança” vale para as campanhas do Google: mudar a verba, pausar e retomar, sempre com a sua aprovação. No Google, a mudança é na campanha inteira. As da Meta seguem só para leitura.',
    );
    expect(notaDoPedir(['meta_ads'], ['google_ads'])).not.toContain('campanha inteira');
    // A ordem das plataformas na frase é sempre a mesma, venha a lista de campanhas como vier.
    expect(notaDoPedir(['google_ads', 'meta_ads', 'google_ads'], [])).toContain('vale para as campanhas da Meta e do Google:');
    expect(notaDoPedir(['plataforma_nova'], ['google_ads', 'meta_ads'])).toContain('As da Meta e do Google seguem só para leitura.');
  });

  it('sem conjunto nem anúncio para escolher, a gaveta não tem o campo "Onde"', () => {
    expect(temOnde(ondeDe(doGoogle()))).toBe(false);
    expect(listaLidaEm(doGoogle(), FUSO, AGORA)).toBeNull();
    // Na Meta o campo segue, com o que houver para escolher.
    expect(temOnde(ondeDe(opcoes()))).toBe(true);
    expect(temOnde(ondeDe(opcoes({ ads: [] })))).toBe(true);
  });

  it('"Agora, no Google": a verba que é só da campanha, e as frases do caminho falam do Google', () => {
    const a = agoraNaPlataforma(doGoogle(), FUSO);
    expect(a.titulo).toBe('Agora, no Google');
    expect(a.linhas.map((l) => [l.rotulo, sp(l.valor), l.sub])).toEqual([
      ['Situação', 'Ativa', null],
      ['Verba diária', 'R$ 55,00', 'na campanha'],
      ['Lido no Google', 'agora, às 14:32', null],
    ]);
    expect(verbaDividida(doGoogle())).toBeNull();
    expect(acoesDe(doGoogle().tools).map((x) => x.acao)).toEqual(['verba', 'pausar']);
    expect(efeito(doGoogle(), { acao: 'verba', valor: '49,50' })).toContain('cai R$ 5,50 por dia');
    expect(notaDoPedido('google_ads')).toContain('o Liame confere com o Google, faz a mudança e avisa');
    expect(depoisDeCriar('aguardando_aprovacao', 'google_ads')).toBe('Ele espera a aprovação com o código do app. Nada muda no Google antes disso.');
    expect(lendoNaPlataforma('google_ads')).toBe('Lendo a campanha no Google, para o pedido partir do que está valendo agora…');
    expect(falhaDaLeitura({ status: 502, code: 'plataforma-indisponivel', title: 'A plataforma não respondeu' }, 'google_ads')).toMatchObject({ tipo: 'fora', titulo: 'Não foi possível ler a campanha no Google agora' });
    // O pedido vai com a plataforma e a conta da campanha.
    const c = conferirPedido(doGoogle(), { acao: 'verba', valor: '49,50' }, verba());
    expect(c).toMatchObject({ ok: true, corpo: { tool: 'orcamento_ajustar', provider: 'google_ads', account_id: uuid(801), resource_id: 'campanha:21000000004', params: { daily_budget_micros: r(49.5) } } });
  });

  it('a verba dividida com outra campanha: o Liame não muda, diz com quem e de quanto é o orçamento, e deixa pausar', () => {
    const o = dividida(['Busca “Mister Burgers”']);
    expect(agoraNaPlataforma(o, FUSO).linhas.map((l) => [l.rotulo, sp(l.valor), l.sub])[1]).toEqual(['Verba diária', 'R$ 120,00', 'dividida com outra campanha']);
    expect(aviso(o)).toEqual({
      titulo: 'O Liame não muda esta verba',
      texto: 'No Google, esta campanha divide um orçamento de R$ 120,00 por dia com outra campanha. Mudar aqui mudaria a verba dela também, sem ninguém ter pedido.',
      campanhas: [
        { nome: 'Busca “hambúrguer perto”', papel: 'esta campanha' },
        { nome: 'Busca “Mister Burgers”', papel: 'divide a mesma verba' },
      ],
      mais: null,
      depois: 'Pausar e retomar esta campanha pode: só ela para. Para mudar a verba, mude no Google Ads, onde você vê as campanhas juntas.',
    });
    // O valor do orçamento sai em destaque, como no protótipo.
    expect(verbaDividida(o)!.texto.find((t) => t.b)?.t).toBe(`R$${String.fromCharCode(160)}120,00 por dia`);
    // Só pausar cabe: a gaveta não oferece a verba, e a pausa diz o que acontece sem citar verba que não é dela.
    expect(acoesDe(o.tools).map((x) => x.acao)).toEqual(['pausar']);
    expect(efeito(o, { acao: 'pausar', valor: '' })).toBe('A campanha “Busca “hambúrguer perto”” para de aparecer e de gastar. Fica pausada, não apagada.');
    expect(conferirPedido(o, { acao: 'pausar', valor: '' }, verba())).toMatchObject({ ok: true, corpo: { tool: 'campanha_pausar', provider: 'google_ads', params: {} } });
    expect(conferirPedido(o, { acao: 'verba', valor: '100' }, verba())).toMatchObject({ ok: false, noValor: false });
  });

  it('com várias campanhas na mesma verba: o plural, e "e mais N" quando o Google informa mais campanhas do que os nomes que vieram', () => {
    const tres = dividida(['Busca combo', 'Busca “Mister Burgers”']);
    expect(agoraNaPlataforma(tres, FUSO).linhas[1]!.sub).toBe('dividida com outras 2 campanhas');
    expect(aviso(tres).texto).toBe('No Google, esta campanha divide um orçamento de R$ 120,00 por dia com outras 2 campanhas. Mudar aqui mudaria a verba delas também, sem ninguém ter pedido.');
    expect(aviso(tres).campanhas).toHaveLength(3);
    expect(aviso(tres).mais).toBeNull();
    // Doze campanhas no orçamento, dez nomes: a lista diz quantas ficaram de fora.
    const nomes = Array.from({ length: 10 }, (_, i) => `Busca ${String(i + 1).padStart(2, '0')}`);
    const muitas = dividida(nomes, 13);
    expect(aviso(muitas).texto).toContain('com outras 12 campanhas');
    expect(aviso(muitas).campanhas).toHaveLength(11);
    expect(aviso(muitas).mais).toBe('e mais 2 campanhas');
    expect(aviso(dividida(nomes, 12)).mais).toBe('e mais 1 campanha');
  });

  it('além do protótipo: o Google não disse os nomes, o orçamento é de período, ou só esta campanha usa o orçamento dividido', () => {
    // Sem os nomes (o Google não respondeu a tempo), a contagem que veio com a campanha basta para a frase; não há lista.
    const semNomes = dividida([], 3);
    expect(aviso(semNomes).texto).toContain('divide um orçamento de R$ 120,00 por dia com outras 2 campanhas');
    expect(aviso(semNomes).campanhas).toEqual([]);
    expect(aviso(semNomes).mais).toBeNull();
    expect(agoraNaPlataforma(semNomes, FUSO).linhas[1]!.sub).toBe('dividida com outras 2 campanhas');
    // Orçamento de período: não há valor por dia para citar.
    const dePeriodo = dividida(['Busca combo'], 2, null);
    expect(aviso(dePeriodo).texto).toBe('No Google, esta campanha divide um orçamento com outra campanha. Mudar aqui mudaria a verba dela também, sem ninguém ter pedido.');
    expect(agoraNaPlataforma(dePeriodo, FUSO).linhas[1]).toMatchObject({ valor: 'Dividida', sub: 'dividida com outra campanha' });
    // Criado para ser dividido, e hoje só esta usa: é dividido do mesmo jeito, sem "outra campanha" que não existe.
    const sozinha = dividida([], 1, r(40));
    expect(aviso(sozinha)).toEqual({
      titulo: 'O Liame não muda esta verba',
      texto: 'No Google, a verba desta campanha vem de um orçamento de R$ 40,00 por dia criado para ser dividido entre campanhas. Hoje só ela usa, mas o Liame não muda orçamento dividido.',
      campanhas: [],
      mais: null,
      depois: 'Pausar e retomar esta campanha pode. Para mudar a verba, mude no Google Ads.',
    });
    expect(agoraNaPlataforma(sozinha, FUSO).linhas[1]).toMatchObject({ sub: 'de um orçamento criado para ser dividido' });
    // A contagem estranha (zero) não vira número negativo nem "outras 0 campanhas".
    expect(aviso(dividida([], 0)).texto).not.toMatch(/outras? -?\d|NaN/);
  });

  it('retomar a campanha em pausa com a verba dividida: volta a gastar dentro da verba que já existe', () => {
    const pausada = doGoogle({ tools: ['campanha_retomar'] }, { status: 'pausado', effective_status: 'PAUSED', daily_micros: null, shared_budget: { daily_micros: r(120), campaigns: 2, shared_with: ['Busca “Mister Burgers”'] } });
    expect(acoesDe(pausada.tools).map((x) => x.acao)).toEqual(['retomar']);
    expect(efeito(pausada, { acao: 'retomar', valor: '' })).toBe('A campanha “Busca “hambúrguer perto”” volta a aparecer e a gastar, dentro da verba que já existe: a verba não muda.');
    expect(verbaDividida(pausada)).not.toBeNull();
  });
});
