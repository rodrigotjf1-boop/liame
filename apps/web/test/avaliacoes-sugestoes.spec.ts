import type { ReviewItem, ReviewsResponse, ReviewStore, ReviewSuggestionTurn } from '@liame/contracts';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { AvaliacoesConteudo } from '@/components/avaliacoes/avaliacoes-conteudo';
import { faixaDasSugestoes, type QuemAprova, seloDasSugestoes, situacaoDaVez } from '@/components/avaliacoes/sugestoes-textos';
import { telaDasAvaliacoes, type TelaDasAvaliacoes } from '@/components/avaliacoes/textos';

// As sugestões de resposta do Social media na tela Avaliações (A6 · Z6, parte 4b; mockups/prototipo-respostas-
// sugeridas.html, P31): o selo da avaliação cujas sugestões esperam (só "você" para quem decide, V128), a vez de cada
// avaliação sem resposta (escrevendo, com a hora; no limite de IA do dia ou do mês; barrada, com as regras), a faixa do
// topo, uma só e na ordem do P31, e a tela montada e desenhada com elas.

// O instante e o "agora" saem do relógio local (V113).
const local = (h: number, m = 0, d = 22) => new Date(2026, 9, d, h, m).toISOString();
const AGORA = new Date(2026, 9, 22, 15, 0);
const MARCA = '22222222-2222-4222-8222-222222222222';
const LOJA = '11111111-1111-4111-8111-111111111111';
const id = (n: number) => `33333333-3333-4333-8333-${String(n).padStart(12, '0')}`;
const pedidoDe = (n: number) => `44444444-4444-4444-8444-${String(n).padStart(12, '0')}`;

const loja = (parcial: Partial<ReviewStore> = {}): ReviewStore => ({ id: LOJA, name: 'Mister Burgers — Centro', status: 'ativa', status_reason: null, rating: 4.6, review_count: 128, read_at: local(14, 10), waiting_until: null, ...parcial });
const avaliacao = (n: number, estrelas: number, parcial: Partial<ReviewItem> = {}): ReviewItem => ({ id: id(n), store_id: LOJA, stars: estrelas, text: `Texto da avaliação ${n}.`, reviewed_at: local(12, 0, 21), changed_at: local(12, 0, 21), reply: null, ...parcial });
const vez = (n: number, state: string, parcial: Partial<ReviewSuggestionTurn> = {}): ReviewSuggestionTurn => ({ review_id: id(n), state, next_at: null, barred_by: null, ...parcial });

/** O cenário do P31: a de 1 estrela e a de 5 com sugestões esperando, a de 4 só com a nota escrevendo, a de 2 barrada. */
const AVALIACOES = [avaliacao(1, 1), avaliacao(2, 2), avaliacao(3, 4, { text: null }), avaliacao(5, 5), avaliacao(6, 5, { reply: { text: 'Obrigado!', state: 'aprovada', changed_at: local(9, 0), violation: null } })];
function pronta(parcial: Partial<ReviewsResponse> = {}): ReviewsResponse {
  return {
    brand_id: MARCA,
    state: 'pronta',
    stores: [loja()],
    summary: { rating: 4.6, review_count: 128, unanswered: 4, oldest_unanswered_at: local(12, 0, 21), last_30_days: { count: 9, average: 4.4 } },
    reviews: AVALIACOES,
    has_more: false,
    can_reply: true,
    pending_replies: [
      { review_id: id(1), action_id: pedidoDe(1), owner_only: true, suggestions: 2 },
      { review_id: id(5), action_id: pedidoDe(5), owner_only: false, suggestions: 2 },
    ],
    suggestions: { state: 'ligadas', turns: [vez(3, 'escrevendo', { next_at: local(15, 2) }), vez(2, 'barrada', { barred_by: ['regras_da_resposta'] })] },
    generated_at: local(15, 0),
    ...parcial,
  };
}
const lista = (t: TelaDasAvaliacoes) => {
  if (t.tipo !== 'lista') throw new Error(`esperava a lista, veio ${t.tipo}`);
  return t;
};
const DONO = { podePedir: true, podeAprovar: true, souDono: true, podeLigarOSocial: true, podeVerEquipe: true };
const desenhar = (t: TelaDasAvaliacoes) => renderToStaticMarkup(createElement(AvaliacoesConteudo, { tela: t, podeVerContas: true }));
const semMarcas = (html: string) => html.replace(/<[^>]+>/g, '').replace(/&quot;/g, '"').replace(/&#x27;/g, "'");
const quem = (q: QuemAprova) => () => q;

describe('as sugestões do Social media na tela Avaliações: os textos (A6 · Z6, parte 4b)', () => {
  it('o selo das sugestões que esperam: "você" só para quem decide; o dono, na de 1 ou 2 estrelas; "aprovação", para os outros', () => {
    expect(seloDasSugestoes(2, 'voce')).toEqual({ classe: 'info', rotulo: '2 sugestões esperam você' });
    expect(seloDasSugestoes(1, 'voce').rotulo).toBe('1 sugestão espera você');
    expect(seloDasSugestoes(2, 'dono').rotulo).toBe('2 sugestões esperam o dono');
    expect(seloDasSugestoes(1, 'outra_pessoa').rotulo).toBe('1 sugestão espera aprovação');
  });

  it('a vez da avaliação: escrevendo, com a hora quando passa de alguns minutos; o limite do dia e o do mês; a barrada, com as regras; o convite só para quem responde', () => {
    const op = { soANota: false, podeResponder: true, agora: AGORA };
    expect(situacaoDaVez(vez(1, 'escrevendo', { next_at: local(15, 2) }), op)).toEqual({
      selo: { classe: 'espera', rotulo: 'O Social media está escrevendo' },
      motivo: 'As sugestões ficam prontas em alguns minutos; quer responder antes? Escreva você mesmo.',
    });
    // Depois de uma tentativa que falhou, a rotina olha de novo em 15 ou 30 minutos: a tela diz a hora.
    expect(situacaoDaVez(vez(1, 'escrevendo', { next_at: local(15, 30) }), op)!.motivo).toBe('As sugestões ficam prontas depois das 15:30; quer responder antes? Escreva você mesmo.');
    expect(situacaoDaVez(vez(1, 'escrevendo'), { ...op, soANota: true, podeResponder: false })!.motivo).toBe('A sugestão fica pronta em alguns minutos.');
    expect(situacaoDaVez(vez(1, 'limite_dia', { next_at: local(16, 0) }), op)).toEqual({
      selo: { classe: 'aguardando', rotulo: 'Sem sugestão hoje' },
      motivo: 'O limite de uso de IA de hoje foi atingido: as sugestões desta avaliação ficam para amanhã. Responda escrevendo você mesmo.',
    });
    expect(situacaoDaVez(vez(1, 'limite_mes'), { ...op, soANota: true })).toEqual({
      selo: { classe: 'aguardando', rotulo: 'Sem sugestão este mês' },
      motivo: 'O limite de uso de IA do mês foi atingido: a sugestão desta avaliação fica para o mês que vem. Responda escrevendo você mesmo.',
    });
    expect(situacaoDaVez(vez(1, 'barrada', { barred_by: ['regras_da_resposta'] }), op)).toEqual({
      selo: { classe: 'aguardando', rotulo: 'Sem sugestão' },
      motivo: 'O Compliance barrou as sugestões desta avaliação: elas prometiam compensação, citavam um nome ou afirmavam o que a loja não confirmou. Responda escrevendo você mesmo.',
    });
    expect(situacaoDaVez(vez(1, 'barrada', { barred_by: ['numeros', 'regras_da_marca'] }), { ...op, soANota: true, podeResponder: false })!.motivo).toBe(
      'O Compliance barrou a sugestão desta avaliação: ela trazia um número que não está na avaliação nem em Minha marca; e dizia o que Minha marca pede para nunca dizer.',
    );
    expect(situacaoDaVez(vez(1, 'barrada', { barred_by: ['politica_da_empresa'] }), op)!.motivo).toBe('A política da empresa não deixa o Social media pedir esta resposta. Responda escrevendo você mesmo.');
    // Uma regra que a tela não conhece não vira frase inventada; um estado que ela não conhece não aparece.
    expect(situacaoDaVez(vez(1, 'barrada', { barred_by: ['regra_nova'] }), op)!.motivo).toBe('O Compliance barrou as sugestões desta avaliação. Responda escrevendo você mesmo.');
    expect(situacaoDaVez(vez(1, 'estado_novo'), op)).toBeNull();
  });

  it('a faixa do topo, uma só, na ordem do P31: desligado, não ligadas, o limite (o do mês antes do do dia) e as que esperam', () => {
    const o = { quemAprova: quem('voce'), podeResponder: true, podeLigarOSocial: true, podeVerEquipe: true };
    expect(faixaDasSugestoes(pronta({ suggestions: { state: 'funcionario_desligado', turns: [] } }), o)).toEqual({
      tipo: 'info',
      icone: 'pause',
      titulo: 'O Social media está desligado nesta marca',
      texto: 'Ninguém sugere resposta agora: as respostas são escritas por você, como antes. Quem desliga e liga o Social media é você, em Sua equipe.',
      botao: { rotulo: 'Abrir Sua equipe', href: '/equipe', primario: false },
    });
    // Quem não liga nem desliga lê quem faz; quem não vê Sua equipe não ganha o botão.
    const deOutro = faixaDasSugestoes(pronta({ suggestions: { state: 'funcionario_desligado', turns: [] } }), { ...o, podeResponder: false, podeLigarOSocial: false, podeVerEquipe: false })!;
    expect([deOutro.texto, deOutro.botao]).toEqual(['Ninguém sugere resposta agora: as respostas são escritas por uma pessoa, como antes. Quem desliga e liga o Social media é quem cuida da equipe, em Sua equipe.', null]);
    for (const state of ['funcao_desligada', 'ia_desligada'])
      expect(faixaDasSugestoes(pronta({ suggestions: { state, turns: [] } }), o)).toEqual({
        tipo: 'info',
        icone: 'info',
        titulo: 'As sugestões de resposta ainda não estão ligadas para esta empresa',
        texto: 'Quem liga é a Liame, a pedido do dono. Enquanto isso, a resposta é escrita por você, como hoje, e nada custa.',
        botao: null,
      });
    const comLimite = (states: string[]) => pronta({ suggestions: { state: 'ligadas', turns: states.map((s, i) => vez(i + 1, s)) } });
    expect(faixaDasSugestoes(comLimite(['limite_dia']), o)).toMatchObject({ titulo: 'O limite de uso de IA de hoje foi atingido', texto: 'As sugestões das avaliações que chegaram depois disso ficam para amanhã. Responder escrevendo você continua, a qualquer hora.' });
    expect(faixaDasSugestoes(comLimite(['limite_dia', 'limite_mes']), { ...o, podeResponder: false })).toMatchObject({ titulo: 'O limite de uso de IA do mês foi atingido', texto: 'As sugestões das avaliações que chegaram depois disso ficam para o mês que vem.' });
    // As que esperam: "você" só para quem decide todas.
    expect(faixaDasSugestoes(pronta(), o)).toEqual({
      tipo: 'acao',
      icone: 'sparkles',
      titulo: '2 avaliações têm sugestões de resposta esperando você',
      texto: 'O Social media escreveu as sugestões; você escolhe, ajusta se quiser e aprova. A de 1 ou 2 estrelas só o dono aprova.',
      botao: { rotulo: 'Ver em Aprovações', href: `/aprovacoes?pedido=${pedidoDe(1)}`, primario: true },
    });
    expect(faixaDasSugestoes(pronta(), { ...o, quemAprova: quem('dono') })).toMatchObject({ titulo: '2 avaliações têm sugestões de resposta esperando o dono' });
    expect(faixaDasSugestoes(pronta(), { ...o, quemAprova: (p) => (p.owner_only ? 'dono' : 'voce') })).toMatchObject({ titulo: '2 avaliações têm sugestões de resposta esperando aprovação', texto: 'O Social media escreveu as sugestões; elas estão em Aprovações.' });
    expect(faixaDasSugestoes(pronta({ pending_replies: [{ review_id: id(5), action_id: pedidoDe(5), owner_only: false, suggestions: 1 }] }), o)).toMatchObject({ titulo: '1 avaliação tem sugestões de resposta esperando você' });
    // Sem nada disso, ou sem responder pelo Liame, sem faixa; um estado que a tela não conhece, também.
    expect(faixaDasSugestoes(pronta({ pending_replies: [], suggestions: { state: 'ligadas', turns: [] } }), o)).toBeNull();
    expect(faixaDasSugestoes(pronta({ suggestions: null }), o)).toBeNull();
    expect(faixaDasSugestoes(pronta({ suggestions: { state: 'estado_novo', turns: [] } }), o)).toBeNull();
  });
});

describe('as sugestões do Social media na tela Avaliações: a tela (A6 · Z6, parte 4b)', () => {
  it('cada avaliação com a vez dela: as sugestões que esperam, com "Ver as sugestões"; a escrevendo e a barrada, com o porquê e "Responder"; a respondida, como antes', () => {
    const t = lista(telaDasAvaliacoes(pronta(), AGORA, null, DONO));
    const item = (n: number) => t.itens.find((i) => i.id === id(n))!;
    expect([item(1).selo.rotulo, item(1).acao]).toEqual(['2 sugestões esperam você', { tipo: 'sugestoes', href: `/aprovacoes?pedido=${pedidoDe(1)}`, quantas: 2 }]);
    expect([item(2).selo.rotulo, item(2).acao?.tipo, item(2).motivo]).toEqual([
      'Sem sugestão',
      'responder',
      'O Compliance barrou as sugestões desta avaliação: elas prometiam compensação, citavam um nome ou afirmavam o que a loja não confirmou. Responda escrevendo você mesmo.',
    ]);
    expect([item(3).selo.rotulo, item(3).motivo]).toEqual(['O Social media está escrevendo', 'A sugestão fica pronta em alguns minutos; quer responder antes? Escreva você mesmo.']);
    expect([item(6).selo.rotulo, item(6).motivo, item(6).acao]).toEqual(['Respondida', null, null]);
    expect(t.sugestoes?.titulo).toBe('2 avaliações têm sugestões de resposta esperando você');
    // Uma faixa de ação só: a do P17 (respostas de uma pessoa) não aparece junto.
    expect(t.esperando).toBeNull();
    expect(t.notas[0]).toContain('As sugestões são do Social media, da sua equipe: nenhuma sai sem a aprovação de uma pessoa com o código do app.');
    expect(t.notas[0]).toContain('o Liame não guarda o nome nem a foto, e o Social media não recebe');
  });

  it('quem não decide nem responde lê sem convite; a resposta de uma pessoa segue com a faixa do P17 quando não há sugestões esperando', () => {
    const t = lista(telaDasAvaliacoes(pronta(), AGORA, null, { podePedir: false, podeAprovar: false, souDono: false }));
    const item = (n: number) => t.itens.find((i) => i.id === id(n))!;
    expect([item(1).selo.rotulo, item(5).selo.rotulo]).toEqual(['2 sugestões esperam o dono', '2 sugestões esperam aprovação']);
    expect([item(2).acao, item(2).motivo]).toEqual([null, 'O Compliance barrou as sugestões desta avaliação: elas prometiam compensação, citavam um nome ou afirmavam o que a loja não confirmou.']);
    expect(t.sugestoes?.titulo).toBe('2 avaliações têm sugestões de resposta esperando aprovação');

    const daPessoa = lista(telaDasAvaliacoes(pronta({ pending_replies: [{ review_id: id(5), action_id: pedidoDe(5), owner_only: false, suggestions: null }] }), AGORA, null, DONO));
    expect(daPessoa.sugestoes).toBeNull();
    expect(daPessoa.esperando?.titulo).toBe('1 resposta espera a sua aprovação');
    expect(daPessoa.itens.find((i) => i.id === id(5))!.acao).toEqual({ tipo: 'ver', href: `/aprovacoes?pedido=${pedidoDe(5)}` });
  });

  it('sem responder pelo Liame, nada do Social media aparece: nem a faixa, nem a vez, nem a nota', () => {
    const t = lista(telaDasAvaliacoes(pronta({ can_reply: false, pending_replies: [], suggestions: null }), AGORA, null, DONO));
    expect(t.sugestoes).toBeNull();
    expect(t.itens.every((i) => i.motivo === null)).toBe(true);
    expect(t.notas[0]).not.toContain('Social media');
  });

  it('o desenho: a faixa com o botão, o porquê embaixo do texto e "Ver as sugestões" ou "Ver a sugestão"', () => {
    const html = desenhar(telaDasAvaliacoes(pronta({ pending_replies: [{ review_id: id(1), action_id: pedidoDe(1), owner_only: true, suggestions: 2 }, { review_id: id(5), action_id: pedidoDe(5), owner_only: false, suggestions: 1 }] }), AGORA, null, DONO));
    const t = semMarcas(html);
    expect(t).toContain('2 avaliações têm sugestões de resposta esperando você');
    expect(t).toContain('Ver em Aprovações');
    expect(html).toContain(`href="/aprovacoes?pedido=${pedidoDe(1)}"`);
    expect(t).toContain('Ver as sugestões');
    expect(t).toContain('Ver a sugestão');
    expect(html).toContain('class="av-item-motivo"');
    expect(t).toContain('O Social media está escrevendo');
    const desligado = semMarcas(desenhar(telaDasAvaliacoes(pronta({ suggestions: { state: 'funcionario_desligado', turns: [] } }), AGORA, null, DONO)));
    expect(desligado).toContain('O Social media está desligado nesta marca');
    expect(desligado).toContain('Abrir Sua equipe');
  });
});
