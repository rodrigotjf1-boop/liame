import type { ReviewAuthorsResponse, ReviewItem, ReviewsResponse, ReviewStore } from '@liame/contracts';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { AvaliacoesConteudo } from '@/components/avaliacoes/avaliacoes-conteudo';
import { haQuanto, nota, situacaoDaResposta, telaDasAvaliacoes, type TelaDasAvaliacoes } from '@/components/avaliacoes/textos';
import { itensVisiveis, NAVEGACAO, temModos, tituloDa } from '@/components/shell/navegacao';
import { Icone } from '@/components/ui/icone';

// "Avaliações" (A6 · Z1; mockups/prototipo-avaliacoes.html, P17 aprovado em 09/10/2026): a nota da empresa no Google,
// as avaliações sem resposta primeiro e a situação da resposta de cada uma. As frases e os números saem do que a API
// manda (`GET /v1/reviews` e, para o nome, `GET /v1/reviews/authors`); a tela é desenhada pelo mesmo componente do
// navegador. O cenário é o do protótipo: nota 4,6 com 128 avaliações. Na Z1 a tela só lê: sem o botão "Responder".

// O instante e o "agora" saem do relógio local: a tela fala em "hoje", "ontem" e "há 4 dias" (V113).
const local = (h: number, m = 0, d = 11) => new Date(2026, 9, d, h, m).toISOString();
const AGORA = new Date(2026, 9, 11, 15, 0);
const MARCA = '22222222-2222-4222-8222-222222222222';
const LOJA = '11111111-1111-4111-8111-111111111111';
const OUTRA = '11111111-1111-4111-8111-222222222222';
const id = (n: number) => `33333333-3333-4333-8333-${String(n).padStart(12, '0')}`;

function loja(parcial: Partial<ReviewStore> = {}): ReviewStore {
  return { id: LOJA, name: 'Mister Burgers — Centro', status: 'ativa', status_reason: null, rating: 4.6, review_count: 128, read_at: local(14, 10), waiting_until: null, ...parcial };
}

function avaliacao(n: number, estrelas: number, feitaNoDia: number, parcial: Partial<ReviewItem> = {}): ReviewItem {
  return { id: id(n), store_id: LOJA, stars: estrelas, text: `Texto da avaliação ${n}`, reviewed_at: local(12, 0, feitaNoDia), changed_at: local(12, 0, feitaNoDia), reply: null, ...parcial };
}

const resposta = (state: string, violation: string | null = null) => ({ text: 'Obrigado pela visita!', state, changed_at: local(9, 0, 10), violation });

/** A lista como o servidor a manda: as sem resposta primeiro, das notas mais baixas para as mais altas. */
const AVALIACOES: ReviewItem[] = [
  avaliacao(1, 1, 7, { text: 'Pedi pelo cardápio às 19h e o lanche chegou depois das 21h, frio.' }),
  avaliacao(3, 4, 9, { text: null }),
  avaliacao(6, 2, 8, { reply: resposta('recusada', 'SPAM') }),
  avaliacao(5, 3, 2, { reply: resposta('pendente') }),
  avaliacao(4, 5, 5, { reply: resposta('aprovada') }),
];

function pronta(parcial: Partial<ReviewsResponse> = {}): ReviewsResponse {
  return {
    brand_id: MARCA,
    state: 'pronta',
    stores: [loja()],
    summary: { rating: 4.6, review_count: 128, unanswered: 2, oldest_unanswered_at: local(12, 0, 7), last_30_days: { count: 9, average: 4.4 } },
    reviews: AVALIACOES,
    has_more: false,
    generated_at: local(15, 0),
    ...parcial,
  };
}

const semLoja = (state: string): ReviewsResponse => ({ brand_id: MARCA, state, stores: [], summary: null, reviews: [], has_more: false, generated_at: local(15, 0) });

const NOMES: ReviewAuthorsResponse = { status: 'ok', items: [{ review_id: id(1), name: 'Paulo R.' }, { review_id: id(3), name: 'Diego A.' }, { review_id: id(4), name: 'Carla M.' }] };

const lista = (t: TelaDasAvaliacoes) => {
  if (t.tipo !== 'lista') throw new Error(`esperava a lista, veio ${t.tipo}`);
  return t;
};
const desenhar = (t: TelaDasAvaliacoes, podeVerContas = true) => renderToStaticMarkup(createElement(AvaliacoesConteudo, { tela: t, podeVerContas }));

describe('formatos da tela', () => {
  it('a nota sai com uma casa, e o tempo em dias de calendário: hoje, ontem, há N dias e, passado um mês, a data', () => {
    expect([nota(4.6), nota(5), nota(4.44)]).toEqual(['4,6', '5,0', '4,4']);
    expect(haQuanto(local(9, 0), AGORA)).toBe('hoje');
    expect(haQuanto(local(23, 50, 10), AGORA)).toBe('ontem');
    expect(haQuanto(local(12, 0, 7), AGORA)).toBe('há 4 dias');
    expect(haQuanto(new Date(2026, 8, 11, 12, 0).toISOString(), AGORA)).toBe('há 30 dias');
    expect(haQuanto(new Date(2026, 8, 10, 12, 0).toISOString(), AGORA)).toBe('10/09');
    expect(haQuanto(new Date(2025, 11, 24, 12, 0).toISOString(), AGORA)).toBe('24/12/2025');
    // O relógio do servidor um pouco à frente não vira "há -1 dias".
    expect(haQuanto(local(9, 0, 12), AGORA)).toBe('hoje');
  });

  it('a situação da resposta, como o Google a tem; a que ele não informa conta como respondida', () => {
    expect(situacaoDaResposta(null)).toEqual({ classe: 'aguardando', rotulo: 'Sem resposta' });
    expect(situacaoDaResposta(resposta('pendente'))).toEqual({ classe: 'espera', rotulo: 'O Google está conferindo' });
    expect(situacaoDaResposta(resposta('aprovada'))).toEqual({ classe: 'concluido', rotulo: 'Respondida' });
    expect(situacaoDaResposta(resposta('recusada', 'SPAM'))).toEqual({ classe: 'perigo', rotulo: 'O Google recusou a resposta' });
    expect(situacaoDaResposta(resposta('desconhecida')).rotulo).toBe('Respondida');
    expect(situacaoDaResposta(resposta('situacao_nova')).rotulo).toBe('Respondida');
  });
});

describe('o que a tela mostra quando não há avaliação para ler', () => {
  it('a função desligada, o perfil por conectar, a permissão que falta e a espera do Google: cada um com a frase dele', () => {
    expect(['desligada', 'sem_perfil', 'sem_permissao', 'esperando_google'].map((s) => telaDasAvaliacoes(semLoja(s), AGORA).tipo)).toEqual(['desligada', 'sem_perfil', 'sem_permissao', 'esperando_google']);

    const desligada = desenhar(telaDasAvaliacoes(semLoja('desligada'), AGORA));
    expect(desligada).toContain('As avaliações do Google ainda não estão ligadas para esta empresa');
    expect(desligada).toContain('Quem liga é a Liame, a pedido do dono.');
    expect(desligada).not.toContain('href="/contas"');

    const semPerfil = desenhar(telaDasAvaliacoes(semLoja('sem_perfil'), AGORA));
    expect(semPerfil).toContain('Conecte o perfil da empresa no Google');
    expect(semPerfil).toContain('href="/contas"');
    // Na Z1 o Liame só lê: a tela não promete a resposta proposta.
    expect(semPerfil).not.toContain('propor');

    const semPermissao = desenhar(telaDasAvaliacoes(semLoja('sem_permissao'), AGORA));
    expect(semPermissao).toContain('A autorização do Google não inclui o perfil da empresa');
    expect(semPermissao).toContain('Autorize o Google de novo em Contas conectadas: as contas ligadas continuam como estão.');

    const esperando = desenhar(telaDasAvaliacoes(semLoja('esperando_google'), AGORA));
    expect(esperando).toContain('O Google ainda não liberou o acesso ao perfil');
    expect(esperando).toContain('que não informa o prazo');
    // A pessoa escolhe a loja (P17, parte B): o Liame avisa, e não liga sozinho.
    expect(esperando).toContain('o Liame avisa em Atenção quando as lojas aparecerem, para você escolher');
    expect(esperando).not.toContain('href="/contas"');
  });

  it('quem não cuida das contas lê o que falta, sem o botão de Contas conectadas', () => {
    const semPerfil = desenhar(telaDasAvaliacoes(semLoja('sem_perfil'), AGORA), false);
    expect(semPerfil).toContain('Quem conecta é quem cuida das contas da empresa.');
    expect(semPerfil).not.toContain('href="/contas"');
    const semPermissao = desenhar(telaDasAvaliacoes(semLoja('sem_permissao'), AGORA), false);
    expect(semPermissao).toContain('Quem autoriza de novo é quem cuida das contas da empresa');
    expect(semPermissao).not.toContain('href="/contas"');
  });

  it('a situação que a tela não conhece não vira lista vazia nem "desligada"', () => {
    expect(telaDasAvaliacoes(semLoja('situacao_nova'), AGORA).tipo).toBe('outra');
    expect(telaDasAvaliacoes(pronta({ summary: null }), AGORA).tipo).toBe('outra');
    expect(desenhar({ tipo: 'outra' })).toContain('Não foi possível mostrar as avaliações');
  });

  it('a loja ligada antes da primeira leitura, e o perfil que ainda não tem avaliação', () => {
    const antes = telaDasAvaliacoes(pronta({ stores: [loja({ rating: null, review_count: null, read_at: null })], summary: { rating: null, review_count: null, unanswered: 0, oldest_unanswered_at: null, last_30_days: { count: 0, average: null } }, reviews: [] }), AGORA);
    expect(antes.tipo).toBe('primeira_leitura');
    expect(desenhar(antes)).toContain('A primeira leitura das avaliações ainda não terminou');

    const vazia = telaDasAvaliacoes(pronta({ stores: [loja({ rating: null, review_count: 0 })], summary: { rating: null, review_count: 0, unanswered: 0, oldest_unanswered_at: null, last_30_days: { count: 0, average: null } }, reviews: [] }), AGORA);
    expect(vazia).toMatchObject({ tipo: 'vazia', lido: 'Lido do Google hoje, 14:10' });
    const html = desenhar(vazia);
    expect(html).toContain('Nenhuma avaliação ainda');
    expect(html).toContain('Quando alguém avaliar a sua empresa no Google, a avaliação aparece aqui.');
    expect(html).not.toContain('av-nota');
  });
});

describe('a lista e as três caixas do topo', () => {
  it('a nota do Google, as sem resposta com a mais antiga e os últimos 30 dias', () => {
    const t = lista(telaDasAvaliacoes(pronta(), AGORA, NOMES));
    expect(t.lido).toBe('Lido do Google hoje, 14:10');
    expect(t.caixas).toEqual([
      { id: 'av-nota', rotulo: 'Nota no Google', valor: '4,6 de 5', sub: '128 avaliações ao todo' },
      { id: 'av-sem', rotulo: 'Sem resposta', valor: '2', sub: 'a mais antiga é de 4 dias atrás' },
      { id: 'av-recentes', rotulo: 'Nos últimos 30 dias', valor: '9 avaliações', sub: 'nota média de 4,4' },
    ]);
    expect(t.tudoRespondido).toBe(false);
    expect(t.avisos).toEqual([]);
  });

  it('as caixas quando falta dado: sem nota, sem total, uma avaliação só, a mais antiga de hoje, de ontem e de mais de um mês', () => {
    const com = (summary: Partial<NonNullable<ReviewsResponse['summary']>>) => lista(telaDasAvaliacoes(pronta({ summary: { ...pronta().summary!, ...summary } }), AGORA)).caixas;
    expect(com({ rating: null, review_count: null })[0]).toMatchObject({ valor: 'Sem nota ainda', sub: 'o Google ainda não informou o total de avaliações' });
    expect(com({ review_count: 1 })[0]!.sub).toBe('1 avaliação ao todo');
    expect(com({ review_count: 1284 })[0]!.sub).toBe('1.284 avaliações ao todo');
    expect(com({ oldest_unanswered_at: local(8, 0) })[1]!.sub).toBe('a mais antiga é de hoje');
    expect(com({ oldest_unanswered_at: local(8, 0, 10) })[1]!.sub).toBe('a mais antiga é de ontem');
    expect(com({ oldest_unanswered_at: new Date(2026, 7, 20, 8, 0).toISOString() })[1]!.sub).toBe('a mais antiga é de 20/08');
    expect(com({ last_30_days: { count: 1, average: 5 } })[2]).toMatchObject({ valor: '1 avaliação', sub: 'nota média de 5,0' });
    expect(com({ last_30_days: { count: 0, average: null } })[2]).toMatchObject({ valor: 'Nenhuma avaliação', sub: 'ninguém avaliou neste período' });
  });

  it('cada avaliação: as estrelas, quem avaliou (lido do Google na hora), há quanto tempo, o texto e a situação da resposta, na ordem do servidor', () => {
    const t = lista(telaDasAvaliacoes(pronta(), AGORA, NOMES));
    expect(t.itens.map((i) => [i.estrelas, i.sob, i.selo.rotulo])).toEqual([
      [1, 'Paulo R. · há 4 dias', 'Sem resposta'],
      [4, 'Diego A. · há 2 dias', 'Sem resposta'],
      // O Google não informou o nome desta agora: a linha fica só com o tempo.
      [2, 'há 3 dias', 'O Google recusou a resposta'],
      [3, 'há 9 dias', 'O Google está conferindo'],
      [5, 'Carla M. · há 6 dias', 'Respondida'],
    ]);
    expect(t.itens[0]!.texto).toBe('Pedi pelo cardápio às 19h e o lanche chegou depois das 21h, frio.');
    expect(t.itens[1]!.texto).toBeNull();
    expect(lista(telaDasAvaliacoes(pronta({ reviews: [avaliacao(9, 5, 10, { text: '   ' })] }), AGORA)).itens[0]!.texto).toBeNull();
  });

  it('a lista aparece antes de os nomes chegarem, e segue igual quando o Google não responde por eles', () => {
    const semNomes = lista(telaDasAvaliacoes(pronta(), AGORA));
    expect(semNomes.itens.map((i) => i.sob)).toEqual(['há 4 dias', 'há 2 dias', 'há 3 dias', 'há 9 dias', 'há 6 dias']);
    expect(semNomes.notas[0]).toContain('O nome de quem avaliou é lido do Google na hora, só para esta tela: o Liame não guarda o nome nem a foto.');
    expect(semNomes.notas[0]).toContain('Avaliação sem nome: quem avaliou não se identificou, ou o Google não informou o nome agora.');

    for (const autores of ['falhou' as const, { status: 'indisponivel', items: [] }]) {
      const t = lista(telaDasAvaliacoes(pronta(), AGORA, autores));
      expect(t.itens).toHaveLength(5);
      expect(t.notas[0]).toContain('O Google não respondeu agora, e por isso o nome de quem avaliou não aparece.');
      expect(t.notas[0]).toContain('o Liame não guarda o nome nem a foto');
    }
    const parcial = lista(telaDasAvaliacoes(pronta(), AGORA, { status: 'parcial', items: NOMES.items.slice(0, 1) }));
    expect(parcial.itens[0]!.sob).toBe('Paulo R. · há 4 dias');
    expect(parcial.notas[0]).toContain('O Google não respondeu para todas as lojas');
  });

  it('as notas do rodapé: o que o Liame não guarda, o que a lista olha e quando chega a resposta dada no Google', () => {
    const t = lista(telaDasAvaliacoes(pronta(), AGORA, NOMES));
    expect(t.notas).toHaveLength(2);
    expect(t.notas[0]).toContain('O Liame não apaga avaliação; para denunciar uma avaliação indevida, o caminho é o próprio Google.');
    expect(t.notas[1]).toBe(
      'A lista e a contagem das sem resposta olham as avaliações feitas ou alteradas nos últimos 12 meses; a nota e o total são os do Google, de sempre. A resposta dada direto no perfil da empresa no Google aparece aqui em até um dia; se a avaliação tem mais de 45 dias, em até uma semana.',
    );
    const cheia = lista(telaDasAvaliacoes(pronta({ has_more: true, stores: [loja({ waiting_until: local(16, 30) })] }), AGORA));
    expect(cheia.notas.slice(2)).toEqual([
      'A lista mostra as 5 primeiras nesta ordem. As outras continuam no perfil da empresa no Google.',
      'O Google pediu para o Liame esperar: a próxima leitura de Mister Burgers — Centro fica para depois de hoje, 16:30.',
    ]);
  });

  it('todas respondidas: a faixa diz, e a caixa não inventa uma mais antiga', () => {
    const t = lista(telaDasAvaliacoes(pronta({ summary: { ...pronta().summary!, unanswered: 0, oldest_unanswered_at: null }, reviews: AVALIACOES.slice(2) }), AGORA));
    expect(t.tudoRespondido).toBe(true);
    expect(t.caixas[1]).toMatchObject({ valor: '0', sub: 'todas as avaliações dos últimos 12 meses têm resposta' });
    const html = desenhar(t);
    expect(html).toContain('Nenhuma avaliação sem resposta');
    expect(html).toContain('Quando chegar uma nova, ela aparece no topo da lista.');
  });

  it('o Google tem avaliações, e nenhuma dos últimos 12 meses: as caixas aparecem, e a lista diz por que está vazia', () => {
    const t = lista(telaDasAvaliacoes(pronta({ summary: { ...pronta().summary!, unanswered: 0, oldest_unanswered_at: null, last_30_days: { count: 0, average: null } }, reviews: [] }), AGORA));
    expect(t.itens).toEqual([]);
    // Sem avaliação na lista, a faixa "nenhuma sem resposta" não aparece: não há lista para ela falar.
    expect(t.tudoRespondido).toBe(false);
    const html = desenhar(t);
    expect(html).toContain('4,6 de 5');
    expect(html).toContain('Nenhuma avaliação nos últimos 12 meses');
    expect(html).not.toContain('<ul class="av-lista"');
  });
});

describe('mais de uma loja, e a loja que parou de ser lida', () => {
  const duas = (segunda: Partial<ReviewStore>) => pronta({ stores: [loja(), loja({ id: OUTRA, name: 'Mister Burgers — Praia', read_at: local(9, 5, 10), ...segunda })], reviews: [avaliacao(1, 1, 7), avaliacao(2, 5, 9, { store_id: OUTRA })] });

  it('com duas lojas, cada avaliação diz de qual é, e "lido" é a leitura mais antiga', () => {
    const t = lista(telaDasAvaliacoes(duas({}), AGORA, NOMES));
    expect(t.itens.map((i) => i.sob)).toEqual(['Paulo R. · há 4 dias · Mister Burgers — Centro', 'há 2 dias · Mister Burgers — Praia']);
    expect(t.lido).toBe('Lido do Google ontem, 09:05');
    // A loja ainda sem leitura não entra na conta do "lido".
    expect(lista(telaDasAvaliacoes(duas({ read_at: null }), AGORA)).lido).toBe('Lido do Google hoje, 14:10');
  });

  it('a loja desconectada, sem permissão ou com a leitura falhando vira faixa com o nome dela; a que espera o Google, não', () => {
    const aviso = (segunda: Partial<ReviewStore>) => lista(telaDasAvaliacoes(duas(segunda), AGORA)).avisos;
    expect(aviso({ status: 'desconectada' })).toEqual([
      { chave: `${OUTRA}:desconectada`, tipo: 'perigo', icone: 'plug', titulo: 'Mister Burgers — Praia está desconectada', texto: 'O Google recusou a autorização desta loja. Conecte o Google de novo em Contas conectadas: as avaliações voltam a ser lidas. O que está aqui é da última leitura.', contas: true },
    ]);
    expect(aviso({ status: 'sem_permissao' })[0]).toMatchObject({ tipo: 'atencao', titulo: 'Sem permissão para ler Mister Burgers — Praia', contas: true });
    expect(aviso({ status: 'erro', read_at: null })[0]).toMatchObject({ tipo: 'atencao', titulo: 'A leitura de Mister Burgers — Praia está falhando', texto: 'Nada a fazer por enquanto: o Liame tenta de novo sozinho.', contas: false });
    expect(aviso({ waiting_until: local(18, 0) })).toEqual([]);
    expect(aviso({ status: 'situacao_nova' })).toEqual([]);

    const comBotao = desenhar(telaDasAvaliacoes(duas({ status: 'desconectada' }), AGORA));
    expect(comBotao).toContain('Mister Burgers — Praia está desconectada');
    expect(comBotao).toContain('href="/contas"');
    expect(desenhar(telaDasAvaliacoes(duas({ status: 'desconectada' }), AGORA), false)).not.toContain('href="/contas"');
    expect(desenhar(telaDasAvaliacoes(duas({ status: 'erro' }), AGORA))).not.toContain('href="/contas"');
  });
});

describe('Z2: responder pelo Liame, a partir das Avaliações', () => {
  const PEDIDO = (n: number) => `44444444-4444-4444-8444-${String(n).padStart(12, '0')}`;
  const ligada = (parcial: Partial<ReviewsResponse> = {}) => pronta({ can_reply: true, pending_replies: [], ...parcial });

  it('"Responder" na sem resposta e na que o Google recusou, para quem pode pedir, com a resposta pelo Liame ligada', () => {
    const itens = lista(telaDasAvaliacoes(ligada(), AGORA, NOMES, { podePedir: true })).itens;
    expect(itens.map((i) => i.acao)).toEqual([
      { tipo: 'responder', href: `/aprovacoes?responder=${id(1)}&marca=${MARCA}` },
      { tipo: 'responder', href: `/aprovacoes?responder=${id(3)}&marca=${MARCA}` },
      { tipo: 'responder', href: `/aprovacoes?responder=${id(6)}&marca=${MARCA}` },
      null,
      null,
    ]);
    // Sem a função ligada para a marca, ou sem poder pedir, a tela só lê.
    expect(lista(telaDasAvaliacoes(ligada({ can_reply: false }), AGORA, NOMES, { podePedir: true })).itens.every((i) => i.acao === null)).toBe(true);
    expect(lista(telaDasAvaliacoes(pronta(), AGORA, NOMES, { podePedir: true })).itens.every((i) => i.acao === null)).toBe(true);
    expect(lista(telaDasAvaliacoes(ligada(), AGORA, NOMES)).itens.every((i) => i.acao === null)).toBe(true);
  });

  it('a resposta que espera a aprovação: o selo, "Ver a resposta" e a faixa no topo, também para quem só lê', () => {
    const DONO = { podeAprovar: true, souDono: true };
    const t = lista(telaDasAvaliacoes(ligada({ pending_replies: [{ review_id: id(1), action_id: PEDIDO(1), owner_only: true }] }), AGORA, NOMES, DONO));
    expect(t.itens[0]).toMatchObject({ selo: { classe: 'info', rotulo: 'Resposta espera você' }, acao: { tipo: 'ver', href: `/aprovacoes?pedido=${PEDIDO(1)}` } });
    expect(t.itens[1]!.selo).toEqual(situacaoDaResposta(null));
    expect(t.esperando).toEqual({ titulo: '1 resposta espera a sua aprovação', texto: 'Paulo R. deu 1 estrela; a resposta está pronta para você ler.', botao: 'Ver a resposta', href: `/aprovacoes?pedido=${PEDIDO(1)}` });
    // Sem o nome (o Google não informou), a nota; sem a avaliação na lista (mais de 200), só a frase.
    expect(lista(telaDasAvaliacoes(ligada({ pending_replies: [{ review_id: id(3), action_id: PEDIDO(3), owner_only: false }] }), AGORA, null, DONO)).esperando?.texto).toBe('Uma avaliação de 4 estrelas; a resposta está pronta para você ler.');
    expect(lista(telaDasAvaliacoes(ligada({ pending_replies: [{ review_id: id(99), action_id: PEDIDO(9), owner_only: false }] }), AGORA, NOMES, DONO)).esperando?.texto).toBe('A resposta está pronta para você ler.');
    // Várias: a faixa leva a Aprovações.
    const duasEsperando = ligada({ pending_replies: [{ review_id: id(1), action_id: PEDIDO(1), owner_only: true }, { review_id: id(3), action_id: PEDIDO(3), owner_only: false }] });
    const varias = lista(telaDasAvaliacoes(duasEsperando, AGORA, NOMES, { podePedir: true, ...DONO }));
    expect(varias.esperando).toEqual({ titulo: '2 respostas esperam a sua aprovação', texto: 'Estão em Aprovações, cada uma com a avaliação ao lado.', botao: 'Abrir Aprovações', href: '/aprovacoes' });
    expect(varias.itens.slice(0, 2).map((i) => i.acao?.tipo)).toEqual(['ver', 'ver']);
    // Sem resposta esperando, sem faixa.
    expect(lista(telaDasAvaliacoes(ligada(), AGORA, NOMES, DONO)).esperando).toBeNull();
  });

  it('"a sua aprovação" só para quem aprova: a de 1 ou 2 estrelas espera o dono; quem não aprova lê "espera aprovação"', () => {
    const baixa = ligada({ pending_replies: [{ review_id: id(1), action_id: PEDIDO(1), owner_only: true }] });
    const comum = ligada({ pending_replies: [{ review_id: id(3), action_id: PEDIDO(3), owner_only: false }] });
    // Quem aprova ações, mas não é o dono: a comum é dele; a de nota baixa, do dono.
    const gerente = { podePedir: true, podeAprovar: true, souDono: false };
    expect(lista(telaDasAvaliacoes(comum, AGORA, NOMES, gerente)).esperando?.titulo).toBe('1 resposta espera a sua aprovação');
    const doDono = lista(telaDasAvaliacoes(baixa, AGORA, NOMES, gerente));
    expect(doDono.itens[0]!.selo).toEqual({ classe: 'info', rotulo: 'Resposta espera o dono' });
    expect(doDono.esperando).toEqual({ titulo: '1 resposta espera a aprovação do dono', texto: 'Paulo R. deu 1 estrela; só o dono da empresa aprova a resposta.', botao: 'Ver a resposta', href: `/aprovacoes?pedido=${PEDIDO(1)}` });
    expect(lista(telaDasAvaliacoes(baixa, AGORA, null, gerente)).esperando?.texto).toBe('Uma avaliação de 1 estrela; só o dono da empresa aprova a resposta.');
    // Quem não aprova ações lê a mesma resposta, sem "a sua".
    const soLe = lista(telaDasAvaliacoes(comum, AGORA, NOMES));
    expect(soLe.itens.find((i) => i.id === id(3))!.selo).toEqual({ classe: 'info', rotulo: 'Resposta espera aprovação' });
    expect(soLe.esperando).toMatchObject({ titulo: '1 resposta espera aprovação', texto: 'Diego A. deu 4 estrelas; a resposta está pronta para ler.' });
    expect(lista(telaDasAvaliacoes(ligada({ pending_replies: [{ review_id: id(99), action_id: PEDIDO(9), owner_only: false }] }), AGORA, NOMES)).esperando?.texto).toBe('A resposta está pronta para ler.');
    // Várias, uma delas do dono: "esperam aprovação", sem "a sua".
    const duas = ligada({ pending_replies: [{ review_id: id(1), action_id: PEDIDO(1), owner_only: true }, { review_id: id(3), action_id: PEDIDO(3), owner_only: false }] });
    expect(lista(telaDasAvaliacoes(duas, AGORA, NOMES, gerente)).esperando?.titulo).toBe('2 respostas esperam aprovação');
    expect(lista(telaDasAvaliacoes(duas, AGORA, NOMES)).esperando?.titulo).toBe('2 respostas esperam aprovação');
  });
});

describe('a tela desenhada', () => {
  it('a lista do protótipo: as caixas, as estrelas com nome para quem ouve, o texto e a situação; e só leitura', () => {
    const html = desenhar(telaDasAvaliacoes(pronta(), AGORA, NOMES));
    expect(html).toContain('<div class="av-caixa" id="av-nota"><span>Nota no Google</span><b class="num">4,6 de 5</b><span>128 avaliações ao todo</span></div>');
    expect(html).toContain('<div class="av-caixa" id="av-sem"><span>Sem resposta</span><b class="num">2</b>');
    expect(html).toContain('<h2 id="t-av-lista">As avaliações</h2>');
    expect(html).toContain('As sem resposta vêm primeiro, das notas mais baixas para as mais altas.');
    expect(html).toContain('<ul class="av-lista" aria-label="Avaliações do Google">');
    expect(html.split('<li class="av-item">')).toHaveLength(6);
    expect(html).toContain('<span class="estrelas" role="img" aria-label="1 de 5 estrelas">★<i>★★★★</i></span>');
    expect(html).toContain('<span class="estrelas" role="img" aria-label="5 de 5 estrelas">★★★★★<i></i></span>');
    expect(html).toContain('<span>Paulo R. · há 4 dias</span>');
    expect(html).toContain('<p class="av-item-txt av-item-txt--vazio">Só a nota, sem texto.</p>');
    expect(html).toContain('<span class="st st--aguardando"><span class="dot" aria-hidden="true"></span>Sem resposta</span>');
    expect(html).toContain('<span class="st st--perigo"><span class="dot" aria-hidden="true"></span>O Google recusou a resposta</span>');
    expect(html).toContain('o Liame não guarda o nome nem a foto');
    // Com a resposta pelo Liame desligada, a tela só lê: nem o botão de responder, nem o código do Google, nem o texto
    // da resposta da empresa.
    expect(html).not.toContain('Responder');
    expect(html).not.toContain('<button');
    expect(html).not.toContain('SPAM');
    expect(html).not.toContain('Obrigado pela visita!');
    expect(html).not.toMatch(/NaN|undefined|\[object Object\]/);
  });

  it('Z2: com a resposta pelo Liame ligada, "Responder" leva ao rascunho; a resposta que espera ganha o selo, o caminho e a faixa', () => {
    const PEDIDO = '44444444-4444-4444-8444-000000000001';
    const html = desenhar(telaDasAvaliacoes(pronta({ can_reply: true, pending_replies: [{ review_id: id(3), action_id: PEDIDO, owner_only: false }] }), AGORA, NOMES, { podePedir: true, podeAprovar: true }));
    expect(html).toContain('<div class="faixa faixa--acao" role="status">');
    expect(html).toContain('<b>1 resposta espera a sua aprovação</b><span>Diego A. deu 4 estrelas; a resposta está pronta para você ler.</span>');
    expect(html).toContain(`<a class="btn btn--primary" href="/aprovacoes?pedido=${PEDIDO}">Ver a resposta</a>`);
    expect(html).toContain('<span class="st st--info"><span class="dot" aria-hidden="true"></span>Resposta espera você</span>');
    expect(html).toContain(`<a class="btn btn--sm btn--primary" href="/aprovacoes?pedido=${PEDIDO}">Ver a resposta</a>`);
    expect(html).toContain(`href="/aprovacoes?responder=${id(1)}&amp;marca=${MARCA}"`);
    expect(html.split('>Responder</a>')).toHaveLength(3);
    expect(html).not.toContain('<button');
  });

  it('o texto de quem avaliou entra como texto, nunca como marcação', () => {
    const html = desenhar(telaDasAvaliacoes(pronta({ reviews: [avaliacao(1, 1, 7, { text: '<img src=x onerror=alert(1)> péssimo' })] }), AGORA, { status: 'ok', items: [{ review_id: id(1), name: '<b>Fulano</b>' }] }));
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt; péssimo');
    expect(html).toContain('&lt;b&gt;Fulano&lt;/b&gt; · há 4 dias');
    expect(html).not.toContain('<img');
  });
});

describe('menu: "Avaliações" depois de Mensagens, para quem acompanha as campanhas, numa visão só', () => {
  const agencia = NAVEGACAO.find((g) => g.id === 'agencia')!;

  it('o item, a permissão e o ícone', () => {
    const i = agencia.itens.findIndex((x) => x.href === '/avaliacoes');
    expect(agencia.itens[i]).toEqual({ href: '/avaliacoes', rotulo: 'Avaliações', icone: 'message', permissao: 'campanhas.ver' });
    expect(agencia.itens.slice(i - 2, i + 3).map((x) => x.href)).toEqual(['/verba', '/mensagens', '/avaliacoes', '/agenda', '/criativos']);
    expect(itensVisiveis(agencia, (p) => p !== 'campanhas.ver').map((x) => x.href)).not.toContain('/avaliacoes');
    expect(itensVisiveis(agencia, () => true, 'lite').map((x) => x.href)).toContain('/avaliacoes');
    expect(itensVisiveis(agencia, () => true, 'pro').map((x) => x.href)).toContain('/avaliacoes');
    expect(renderToStaticMarkup(createElement(Icone, { nome: 'message' }))).toContain('<svg class="ic"');
  });

  it('o título da tela, sem o seletor Lite e Pro (a tela é uma só)', () => {
    expect(tituloDa('/avaliacoes')).toBe('Avaliações');
    expect(temModos('/avaliacoes', () => true)).toBe(false);
  });
});
