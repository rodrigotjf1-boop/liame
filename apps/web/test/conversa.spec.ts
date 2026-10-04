import type { ConversationCard, ConversationMessage, CouponRequest, DemandResponse, SummaryResponse } from '@liame/contracts';
import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ConversaProvider } from '@/components/conversa/contexto';
import { eventosDoTexto } from '@/components/conversa/fluxo';
import { type Item, MensagemDaLia, MensagemDaPessoa, MensagemDoSistema } from '@/components/conversa/mensagem';
import {
  avisoDoSistema,
  caminhosDa,
  cartaoDaDemanda,
  contaDaMensagem,
  diaDaMensagem,
  diaPorExtenso,
  faixaDa,
  gruposDe,
  notaDeDadoPessoal,
  prazoDoAtendimento,
  saudacaoDa,
  situacaoDaProposta,
  SUGESTOES,
  textoDaResposta,
} from '@/components/conversa/textos';
import { perguntasDoResumo, perguntasDoVeredito } from '@/components/resumo/textos';
import { AvisosProvider } from '@/components/ui/avisos';
import { quandoComHora } from '@/lib/formato';
import { uuidv7 } from '@/lib/uuid';

// Conversa com a LIA (A3 · P5, aprovado em 03/10/2026; mockups/prototipo-conversa.html): a resposta chega por um fluxo
// de eventos, em blocos já conferidos pelo servidor. A tela só escreve em volta: a saudação, os avisos do sistema, as
// faixas de limite e os cartões do que a LIA registrou.

const AGORA = new Date('2026-10-03T17:40:00Z');
const uuid = (n: number) => `a0000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const CONTATO = { email: 'suporte@agencialiame.com', hours: 'de segunda a sexta-feira, das 9h às 18h (horário de Brasília)', response_time: 'em até 1 dia útil' };

const mensagem = (over: Partial<ConversationMessage> = {}): ConversationMessage => ({
  id: uuid(1),
  role: 'lia',
  created_at: '2026-10-03T17:32:00.000Z',
  status: 'ok',
  text: null,
  removed_personal_data: null,
  blocks: [],
  numbers: [],
  read: [],
  cards: [],
  economy: false,
  usage_id: uuid(2),
  notice: null,
  contact: null,
  retry_at: null,
  budget_window: null,
  stale_sources: [],
  ...over,
});
const t = (text: string, number: number | null = null) => ({ text, number });
const RESPOSTA = mensagem({
  blocks: [
    { kind: 'paragrafo', text: [t('Nos últimos 7 dias, o ROAS confirmado no caixa foi de '), t('2,86', 0), t('.')], risk: null },
    { kind: 'item', text: [t('Combo sexta dá lucro.')], risk: null },
    { kind: 'item', text: [t('Smash em dobro gastou mais do que a margem que trouxe.')], risk: null },
    { kind: 'risco', text: [t('a semana empata.')], risk: 'medio' },
    { kind: 'fazer', text: [t('Comece pela Delivery noite.')], risk: null },
    { kind: 'bloco_novo_do_servidor', text: [t('Um bloco que a tela ainda não conhece.')], risk: null },
  ],
  numbers: [{ value: '2,86', sources: ['Liame · receita confirmada ÷ investimento · calculado pelo sistema'] }],
  read: ['Resultados de 26/09 a 02/10', 'Avisos da Atenção', 'Frescor das fontes'],
});

const DEMANDA: DemandResponse = {
  id: uuid(10),
  brand_id: uuid(3),
  kind: 'promocao',
  title: 'Promoção para sexta-feira: combo com refrigerante',
  detail: 'Quero uma promoção para sexta-feira.',
  notes: null,
  assignee: { agent: 'estrategista', name: 'Estrategista' },
  due_on: '2026-10-09',
  status: 'aberta',
  requested_by: { id: uuid(9), name: 'Rodrigo' },
  opened_by_agent: 'lia',
  conversation_id: uuid(4),
  created_at: '2026-10-03T13:13:00.000Z',
  updated_at: '2026-10-03T13:13:00.000Z',
  cancelled_at: null,
};
const PEDIDO: CouponRequest = {
  action_id: uuid(20),
  code: 'NOITE10',
  connected_account_id: uuid(21),
  kind: 'percentual',
  percent: 10,
  value_micros: null,
  min_order_micros: null,
  valid_from: '2026-10-03',
  valid_until: '2026-10-09',
  campaign: { id: uuid(22), name: 'Delivery noite', provider: 'meta_ads', status: 'ativa' } as CouponRequest['campaign'],
  exclusive: true,
  status: 'aguardando_aprovacao',
  status_reason: null,
  requested_by: { id: uuid(9), name: 'Rodrigo' },
  requested_at: '2026-10-03T14:47:00.000Z',
  expires_at: '2026-10-06T14:47:00.000Z',
};

const nada = () => {};
const tudoPode = () => true;
const CARTOES = { euId: uuid(9), agora: AGORA, pode: tudoPode, ocupado: null, aoCancelarDemanda: nada, aoCancelarProposta: nada };
const desenhar = (filho: ReactNode) => renderToStaticMarkup(createElement(AvisosProvider, { children: createElement('ol', null, filho) }));
const daLia = (m: ConversationMessage, modo: 'lite' | 'pro' = 'lite', pode: (p: string) => boolean = tudoPode, ultima = true) =>
  desenhar(createElement(MensagemDaLia, { item: { de: 'lia', id: m.id, em: m.created_at, fase: m.status === 'parada' ? 'parada' : 'pronta', m }, modo, pode, cartoes: CARTOES, ultima, aoPerguntarDeNovo: nada }));

describe('Conversa: o fluxo de eventos da resposta', () => {
  it('tira os eventos completos e guarda o que ainda não chegou inteiro', () => {
    const inicio = { type: 'inicio', conversation: null, message: null, step: null, problem: null };
    const passo = { type: 'passo', conversation: null, message: null, step: { id: 'p1', label: 'Lendo os resultados', status: 'lendo' }, problem: null };
    const texto = `event: inicio\ndata: ${JSON.stringify(inicio)}\n\n: segue\n\nevent: passo\ndata: ${JSON.stringify(passo)}\n\nevent: mensagem\ndata: {"type":"mens`;
    const r = eventosDoTexto(texto);
    expect(r.eventos.map((e) => e.type)).toEqual(['inicio', 'passo']);
    expect(r.eventos[1]!.step).toEqual({ id: 'p1', label: 'Lendo os resultados', status: 'lendo' });
    expect(r.resto).toBe('event: mensagem\ndata: {"type":"mens');
    // O resto se completa no pedaço seguinte; fim de linha do Windows também serve.
    const fim = eventosDoTexto(`${r.resto}agem","conversation":null,"message":null,"step":null,"problem":null}\r\n\r\n`);
    expect(fim.eventos.map((e) => e.type)).toEqual(['mensagem']);
    expect(fim.resto).toBe('');
  });

  it('linha que só mantém a conexão e evento torto não viram evento', () => {
    expect(eventosDoTexto(': segue\n\n').eventos).toEqual([]);
    expect(eventosDoTexto('event: passo\ndata: {torto\n\n').eventos).toEqual([]);
    expect(eventosDoTexto('event: passo\ndata: {"sem":"tipo"}\n\n').eventos).toEqual([]);
  });

  it('o id da mensagem é um UUID v7: o começo cresce com o relógio', () => {
    const a = uuidv7(1_700_000_000_000);
    const b = uuidv7(1_700_000_000_001);
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(a.slice(0, 13) < b.slice(0, 13)).toBe(true);
    expect(a).not.toBe(uuidv7(1_700_000_000_000));
  });
});

describe('Conversa: o que a tela escreve em volta da resposta', () => {
  it('a saudação usa o primeiro nome e a marca; as sugestões mudam com o modo', () => {
    const s = saudacaoDa('Rodrigo de Oliveira', 'Mister Burgers');
    expect(s[0]).toBe('Oi, Rodrigo. Eu sou a LIA, a assistente de IA da Liame.');
    expect(s[1]).toContain('Leio os números da Mister Burgers');
    expect(s[2]).toBe('Não mexo em campanha e não aprovo gasto: isso continua com você.');
    expect(SUGESTOES.lite[0]).toBe('Como foi a semana?');
    expect(SUGESTOES.pro[0]).toBe('Compare Meta e Google em 7 dias');
  });

  it('o aviso do limite da mensagem e o do dado pessoal retirado', () => {
    expect(contaDaMensagem(1799)).toBeNull();
    expect(contaDaMensagem(1880)).toBe('Faltam 120 caracteres para o limite da mensagem.');
    expect(contaDaMensagem(2000)).toBe('A mensagem chegou ao limite de 2.000 caracteres.');
    expect(notaDeDadoPessoal(0)).toBeNull();
    expect(notaDeDadoPessoal(null)).toBeNull();
    expect(notaDeDadoPessoal(1)).toBe('Um dado pessoal foi retirado antes de a mensagem ir para a LIA: dado de cliente não é enviado à IA.');
    expect(notaDeDadoPessoal(2)).toContain('2 dados pessoais foram retirados');
  });

  it('o dia que separa as mensagens e o dia por extenso do cartão', () => {
    expect(diaDaMensagem('2026-10-03T15:00:00.000Z', AGORA)).toBe('Hoje');
    expect(diaDaMensagem('2026-10-02T15:00:00.000Z', AGORA)).toBe('Ontem');
    expect(diaDaMensagem('2026-09-22T15:00:00.000Z', AGORA)).toBe('22/09');
    expect(diaPorExtenso('2026-10-09')).toBe('sexta-feira, 09/10');
  });

  it('os blocos viram parágrafo, lista, risco e "O que fazer"; bloco de tipo novo vira parágrafo', () => {
    expect(gruposDe(RESPOSTA.blocks).map((g) => g.tipo)).toEqual(['paragrafo', 'lista', 'risco', 'fazer', 'paragrafo']);
    const lista = gruposDe(RESPOSTA.blocks)[1]!;
    expect(lista.tipo === 'lista' && lista.itens.length).toBe(2);
    expect(textoDaResposta(RESPOSTA)).toBe(
      [
        'Nos últimos 7 dias, o ROAS confirmado no caixa foi de 2,86.',
        '- Combo sexta dá lucro.',
        '- Smash em dobro gastou mais do que a margem que trouxe.',
        'Risco médio: a semana empata.',
        'O que fazer:',
        '- Comece pela Delivery noite.',
        'Um bloco que a tela ainda não conhece.',
      ].join('\n'),
    );
  });

  it('os caminhos da resposta saem do que a LIA leu, no máximo dois, só para quem pode ver a tela', () => {
    expect(caminhosDa(RESPOSTA.read, tudoPode)).toEqual([
      { href: '/resultados', rotulo: 'Ver em Resultados' },
      { href: '/atencao', rotulo: 'Ver os avisos' },
    ]);
    expect(caminhosDa(['Cupons', 'Links e rastreio'], tudoPode)).toEqual([{ href: '/links', rotulo: 'Ver links e cupons' }]);
    expect(caminhosDa(RESPOSTA.read, (p) => p !== 'vendas.ver')).toEqual([{ href: '/atencao', rotulo: 'Ver os avisos' }]);
    expect(caminhosDa(['Frescor das fontes'], tudoPode)).toEqual([]);
  });
});

describe('Conversa: avisos do sistema (nenhum é escrito por IA)', () => {
  const aviso = (notice: string, over: Partial<ConversationMessage> = {}) => avisoDoSistema(mensagem({ role: 'sistema', notice, usage_id: null, ...over }));

  it('cada aviso com o título, o selo e o que dá para fazer', () => {
    expect(aviso('pessoa')).toMatchObject({ titulo: 'Falar com uma pessoa da Liame', acao: 'contato', selo: 'Sem IA' });
    expect(aviso('politico')).toMatchObject({ titulo: 'A Liame não faz conteúdo político ou eleitoral', selo: 'Recusado por regra', acao: null });
    expect(aviso('desligada')).toMatchObject({ titulo: 'A LIA está desligada nesta empresa', acao: 'contato' });
    expect(aviso('pausada')).toMatchObject({ titulo: 'A LIA está parada agora', acao: 'tentar' });
    expect(aviso('recusada')).toMatchObject({ titulo: 'A resposta foi retirada na conferência', acao: 'tentar' });
    expect(aviso('fora_do_ar')).toMatchObject({ titulo: 'A LIA não respondeu agora', acao: 'tentar' });
    // Aviso que a tela ainda não conhece é tratado como "fora do ar".
    expect(aviso('aviso_novo')).toMatchObject({ titulo: 'A LIA não respondeu agora', acao: 'tentar' });
  });

  it('dado velho diz a fonte e a última leitura; os limites dizem quando a LIA volta', () => {
    const velho = aviso('dado_velho', { stale_sources: [{ platform: 'Regem', name: 'Loja Centro', freshness: 'parado', last_read: '03/10/2026 09:42' }] });
    expect(velho).toMatchObject({ titulo: 'Com dado velho a LIA não analisa', acao: 'ver-conexao' });
    expect(velho.paragrafos[0]).toBe('Regem · Loja Centro: última leitura em 03/10/2026 09:42. Para não explicar com número desatualizado, a resposta não foi mostrada.');
    expect(aviso('limite_pessoa', { retry_at: '2026-10-03T18:20:00.000Z' }).paragrafos[0]).toMatch(/^A LIA volta a responder às \d\d:\d\d\. /);
    expect(aviso('teto', { budget_window: 'dia' })).toMatchObject({ titulo: 'O limite de uso de IA de hoje foi atingido' });
    expect(aviso('teto', { budget_window: 'mes' }).paragrafos[0]).toContain('no mês que vem');
    expect(prazoDoAtendimento(CONTATO)).toBe('O atendimento responde em até 1 dia útil, de segunda a sexta-feira, das 9h às 18h (horário de Brasília).');
  });
});

describe('Conversa: a faixa acima do campo', () => {
  const conversa = { lia_answers: 3, max_lia_answers: 20 };

  it('conversa no tamanho máximo, limite por hora, teto e respostas mais curtas', () => {
    expect(faixaDa(conversa, [RESPOSTA], AGORA)).toBeNull();
    expect(faixaDa({ lia_answers: 20, max_lia_answers: 20 }, [RESPOSTA], AGORA)).toMatchObject({ chave: 'limite-conversa', bloqueia: true, novaConversa: true });
    const limite = mensagem({ role: 'sistema', notice: 'limite_pessoa', retry_at: '2026-10-03T18:20:00.000Z', usage_id: null });
    expect(faixaDa(conversa, [RESPOSTA, limite], AGORA)).toMatchObject({ chave: 'limite-pessoa', bloqueia: true });
    // Passada a hora, o campo volta.
    expect(faixaDa(conversa, [RESPOSTA, limite], new Date('2026-10-03T18:21:00Z'))).toBeNull();
    const teto = mensagem({ role: 'sistema', notice: 'teto', budget_window: 'dia', usage_id: null });
    expect(faixaDa(conversa, [teto], AGORA)).toMatchObject({ chave: 'teto', bloqueia: true });
    // No dia seguinte, o teto do dia já virou.
    expect(faixaDa(conversa, [teto], new Date('2026-10-05T12:00:00Z'))).toBeNull();
    expect(faixaDa(conversa, [mensagem({ economy: true })], AGORA)).toMatchObject({ chave: 'economico', neutro: true, bloqueia: false });
  });
});

describe('Conversa: os cartões do que a LIA registrou', () => {
  it('a demanda: quem cuida, quem pediu, para quando e o próximo passo; cancelada, sem próximo passo', () => {
    const c = cartaoDaDemanda(DEMANDA, uuid(9), AGORA);
    expect(c).toMatchObject({ titulo: 'Demanda aberta', selo: { rotulo: 'Aberta' }, nota: 'Nada vai ao ar sem a sua aprovação.' });
    expect(c.linhas).toEqual([
      ['Pedido', 'Promoção: Promoção para sexta-feira: combo com refrigerante'],
      ['Quem cuida', 'Estrategista (assistente de IA)'],
      ['Pedido por', `você, ${quandoComHora(DEMANDA.created_at, AGORA)}`],
      ['Para quando', 'sexta-feira, 09/10'],
      ['Próximo passo', 'o plano chega em Aprovações, para você decidir'],
    ]);
    expect(cartaoDaDemanda({ ...DEMANDA, status: 'entregue' }, uuid(9), AGORA).linhas.at(-1)).toEqual(['Próximo passo', 'o plano está em Aprovações, para você decidir']);
    const cancelada = cartaoDaDemanda({ ...DEMANDA, status: 'cancelada', cancelled_at: '2026-10-03T14:00:00.000Z' }, uuid(8), AGORA);
    expect(cancelada).toMatchObject({ titulo: 'Demanda cancelada', nota: 'Nada foi feito. Se precisar, é só pedir de novo.' });
    expect(cancelada.linhas.map((l) => l[0])).toEqual(['Pedido', 'Quem cuida', 'Pedido por']);
    expect(cancelada.linhas[2]![1]).toContain('Rodrigo, ');
  });

  it('a proposta de cupom: a situação e a nota de cada uma', () => {
    expect(situacaoDaProposta(PEDIDO)).toMatchObject({ rotulo: 'Esperando aprovação', fim: false });
    expect(situacaoDaProposta({ ...PEDIDO, status: 'recusada' })).toMatchObject({ rotulo: 'Recusada', nota: 'Nada foi criado no Regem.' });
    expect(situacaoDaProposta({ ...PEDIDO, status: 'cancelada' })).toMatchObject({ rotulo: 'Cancelada', fim: true });
    expect(situacaoDaProposta({ ...PEDIDO, status: 'expirada' }).nota).toContain('Ninguém aprovou a tempo');
  });
});

describe('Conversa: as mensagens na tela', () => {
  it('a mensagem da pessoa, com o aviso do dado pessoal retirado', () => {
    const item: Item = { de: 'eu', id: uuid(30), em: '2026-10-03T17:31:00.000Z', texto: 'O cliente [telefone] disse que o cupom não funcionou', nota: notaDeDadoPessoal(1) };
    const html = desenhar(createElement(MensagemDaPessoa, { item }));
    expect(html).toContain('<span class="sr-only">Você: </span>');
    expect(html).toContain('[telefone]');
    expect(html).toContain('dado de cliente não é enviado à IA');
  });

  it('a resposta da LIA: o número como botão da fonte, as listas, o risco, os caminhos, as fontes e o retorno', () => {
    const lite = daLia(RESPOSTA);
    expect(lite).toContain('Feito com IA');
    expect(lite).toContain('class="nf"');
    expect(lite).toContain('<h3>O que fazer</h3>');
    expect(lite).toContain('Risco médio');
    expect(lite).toContain('href="/resultados"');
    expect(lite).toContain('href="/atencao"');
    expect(lite).toContain('De onde vêm os números (1)');
    expect(lite).toContain('A LIA leu: Resultados de 26/09 a 02/10; Avisos da Atenção; Frescor das fontes.');
    expect(lite).toContain('Fez sentido');
    expect(lite).toContain('Discordo');
    expect(lite).toContain('Copiar');
    // "Leu:" em selos é do Pro.
    expect(lite).not.toContain('class="msg-leu"');
    expect(daLia(RESPOSTA, 'pro')).toContain('class="msg-leu"');
    // Quem não vê as vendas não ganha o caminho para Resultados.
    expect(daLia(RESPOSTA, 'lite', (p) => p !== 'vendas.ver')).not.toContain('href="/resultados"');
  });

  it('os cartões da resposta: demanda com cancelar, proposta com Aprovações e a reunião de decisão', () => {
    const cards: ConversationCard[] = [
      { kind: 'demanda', demand: DEMANDA, coupon: null, meeting: null },
      { kind: 'proposta_cupom', demand: null, coupon: { request: PEDIDO, store_name: 'Loja Centro' }, meeting: null },
      {
        kind: 'reuniao',
        demand: null,
        coupon: null,
        meeting: {
          topic: [t('pausar a Delivery noite?')],
          voices: [
            { agent: 'analista', name: 'Analista de dados', role: 'os números', text: [t('Foram '), t('3', 0), t(' pedidos.')] },
            { agent: 'voz_contraria', name: 'Voz contrária', role: 'discorda de propósito', text: [t('Três pedidos é pouca amostra.')] },
          ],
          recommendation: [t('Não pausar ainda.')],
          risk: 'medio',
          risk_reason: [t('manter custa pouco por dia.')],
        },
      },
      { kind: 'cartao_novo', demand: null, coupon: null, meeting: null },
    ];
    const html = daLia(mensagem({ blocks: [{ kind: 'paragrafo', text: [t('Registrei o seu pedido.')], risk: null }], numbers: [{ value: '3', sources: ['Regem · pedidos da campanha'] }], cards }));
    expect(html).toContain('Demanda aberta');
    expect(html).toContain('Cancelar a demanda');
    expect(html).toContain('Proposta enviada para Aprovações');
    expect(html).toContain('NOITE10');
    expect(html).toContain('Delivery noite · exclusivo dela');
    expect(html).toContain('href="/aprovacoes"');
    expect(html).toContain('Cancelar o pedido');
    expect(html).toContain('Reunião de decisão');
    expect(html).toContain('reuniao-voz--contra');
    expect(html).toContain('Quem decide é você.');
    // Quem não pode abrir demanda nem criar cupom não vê os botões de cancelar.
    const soLe = desenhar(
      createElement(MensagemDaLia, { item: { de: 'lia', id: uuid(1), em: RESPOSTA.created_at, fase: 'pronta', m: mensagem({ cards }) }, modo: 'lite', pode: () => false, cartoes: { ...CARTOES, pode: () => false }, ultima: true, aoPerguntarDeNovo: nada }),
    );
    expect(soLe).not.toContain('Cancelar a demanda');
    expect(soLe).not.toContain('Cancelar o pedido');
  });

  it('respondendo: o que a LIA está lendo; interrompida: perguntar de novo só na última mensagem', () => {
    const respondendo: Item = {
      de: 'lia',
      id: 'r-1',
      em: '2026-10-03T17:32:00.000Z',
      fase: 'respondendo',
      passos: [
        { id: 'p1', label: 'Lendo os resultados de 26/09 a 02/10', status: 'ok' },
        { id: 'p2', label: 'Lendo os avisos da Atenção', status: 'lendo' },
      ],
    };
    const html = desenhar(createElement(MensagemDaLia, { item: respondendo, modo: 'lite', pode: tudoPode, cartoes: CARTOES, ultima: true, aoPerguntarDeNovo: nada }));
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('Lendo os avisos da Atenção…');
    expect(html).toContain('A LIA está respondendo');
    const parada = mensagem({ status: 'parada', usage_id: null });
    expect(daLia(parada)).toContain('Interrompida por você');
    expect(daLia(parada)).toContain('Perguntar de novo');
    expect(daLia(parada, 'lite', tudoPode, false)).not.toContain('Perguntar de novo');
    // A interrompida não tem texto de IA: fica sem o selo "Feito com IA" e sem o retorno.
    expect(daLia(parada)).not.toContain('Feito com IA');
    expect(daLia(parada)).not.toContain('Fez sentido');
  });

  it('interrompida depois de a LIA registrar um pedido: o cartão aparece e não se oferece perguntar de novo', () => {
    const comDemanda = daLia(mensagem({ status: 'parada', usage_id: null, cards: [{ kind: 'demanda', demand: DEMANDA, coupon: null, meeting: null }] }));
    expect(comDemanda).toContain('Interrompida por você');
    expect(comDemanda).toContain('Demanda aberta');
    expect(comDemanda).toContain('Cancelar a demanda');
    // A mesma pergunta registraria outro pedido.
    expect(comDemanda).not.toContain('Perguntar de novo');
  });

  it('o aviso do sistema: o contato para falar com uma pessoa; tentar de novo só na última mensagem', () => {
    const pessoa: Item = { de: 'sistema', id: 's-1', em: '2026-10-03T17:33:00.000Z', m: mensagem({ role: 'sistema', notice: 'pessoa', contact: CONTATO, usage_id: null }) };
    const html = desenhar(createElement(MensagemDoSistema, { item: pessoa, podeVerContas: true, ultima: true, contato: null, aoTentarDeNovo: nada }));
    expect(html).toContain('Aviso do sistema');
    expect(html).toContain('Sem IA');
    expect(html).toContain('suporte@agencialiame.com');
    expect(html).toContain('Copiar o e-mail');
    expect(html).toContain('href="mailto:suporte@agencialiame.com"');
    const recusada: Item = { de: 'sistema', id: 's-2', em: '2026-10-03T17:33:00.000Z', m: mensagem({ role: 'sistema', notice: 'recusada', usage_id: null }) };
    expect(desenhar(createElement(MensagemDoSistema, { item: recusada, podeVerContas: true, ultima: true, contato: CONTATO, aoTentarDeNovo: nada }))).toContain('Tentar de novo');
    expect(desenhar(createElement(MensagemDoSistema, { item: recusada, podeVerContas: true, ultima: false, contato: CONTATO, aoTentarDeNovo: nada }))).not.toContain('Tentar de novo');
    const velho: Item = { de: 'sistema', id: 's-3', em: '2026-10-03T17:33:00.000Z', m: mensagem({ role: 'sistema', notice: 'dado_velho', usage_id: null }) };
    expect(desenhar(createElement(MensagemDoSistema, { item: velho, podeVerContas: true, ultima: true, contato: CONTATO, aoTentarDeNovo: nada }))).toContain('href="/contas"');
    expect(desenhar(createElement(MensagemDoSistema, { item: velho, podeVerContas: false, ultima: true, contato: CONTATO, aoTentarDeNovo: nada }))).not.toContain('href="/contas"');
  });
});

describe('Resumo: os atalhos para a LIA (protótipo P8)', () => {
  const resumo = (over: Partial<SummaryResponse> = {}, verdict: string | null = 'empata'): SummaryResponse =>
    ({
      state: 'ok',
      money: { revenue_micros: { now: '3471000000', before: null }, spend_micros: { now: '1214300000', before: null }, left_micros: { now: '286500000', before: null }, margin_known_micros: '1500800000', margin_coverage_pct: '91.4', verdict },
      orders: { marketing: 53, average_micros: '65490000', all_channels: 180, without_origin: 40 },
      ...over,
    }) as SummaryResponse;

  it('as perguntas do veredito seguem o que a semana deu; sem o que explicar, não há pergunta', () => {
    expect(perguntasDoVeredito(resumo())).toEqual(['Por que sobrou pouco?', 'O que eu faço primeiro?']);
    expect(perguntasDoVeredito(resumo({}, 'lucro'))[0]).toBe('Por que deu lucro?');
    expect(perguntasDoVeredito(resumo({}, 'prejuizo'))[0]).toBe('Por que o marketing não se pagou?');
    expect(perguntasDoVeredito(resumo({}, null))[0]).toBe('O que falta para saber se sobrou?');
    expect(perguntasDoVeredito(resumo({ state: 'primeira_semana' }))).toEqual([]);
    expect(perguntasDoVeredito(resumo({ state: 'sem_regem' }))).toEqual([]);
  });

  it('as perguntas prontas do cartão mudam com o estado', () => {
    expect(perguntasDoResumo(resumo())).toEqual(['Como foi a semana?', 'Por que tem pedido sem origem?', 'Vale pausar alguma campanha?']);
    expect(perguntasDoResumo(resumo({ state: 'primeira_semana' }))).toEqual(['O que o Liame já leu?', 'Quando sai a primeira revisão?']);
    expect(perguntasDoResumo(resumo({ state: 'sem_regem' }))[0]).toBe('Por que preciso do Regem?');
  });

  it('fora do shell (ou sem a permissão), a conversa não está disponível e nada dela aparece', () => {
    // O provedor só entrega a conversa quando ela está disponível para a pessoa.
    const dentro = renderToStaticMarkup(createElement(ConversaProvider, { disponivel: false, children: createElement('p', null, 'tela') }));
    expect(dentro).toBe('<p>tela</p>');
  });
});
