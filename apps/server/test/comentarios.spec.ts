import { describe, expect, it } from 'vitest';
import {
  chaveDoAutor,
  comentariosDaPagina,
  comentariosDoInstagram,
  postDevido,
  postsDaPagina,
  postsDoInstagram,
  tipoPorRegra,
} from '../src/comentarios/comentarios.js';

// A6 · Z11, parte 1: as funções puras da leitura dos comentários (P38, D-A6-85 a D-A6-87). O tipo pela regra (o que ela
// decide e o que deixa para a IA), a leitura das respostas da Meta (o Instagram com as respostas, a Página com o
// `filter=stream`, o que falta), os posts da janela de 30 dias e a fila de cada post.

const AGORA = new Date('2026-11-07T15:00:00.000Z');
const HORA = 3_600_000;
const DIA = 24 * HORA;
const dataDaMeta = (ms: number) => `${new Date(ms).toISOString().slice(0, 19)}+0000`;

describe('o tipo do comentário pela regra (D-A6-87)', () => {
  it('decide o que é claro, cada tipo com casos do dia a dia', () => {
    const casos: Array<[string, string | null]> = [
      ['Quanto custa o combo duplo?', 'pergunta'],
      ['vcs entregam no Méier', 'pergunta'],
      ['Qual o horário de domingo', 'pergunta'],
      ['Que horas abre hoje', 'pergunta'],
      ['Pedi ontem e veio frio, demorou 1h30', 'reclamacao'],
      ['Péssimo atendimento, nunca mais', 'reclamacao'],
      ['O pedido não chegou até agora', 'reclamacao'],
      ['😡😡', 'reclamacao'],
      ['Que delícia 😍🔥', 'elogio'],
      ['Melhor smash da Tijuca!', 'elogio'],
      ['🔥🔥🔥', 'elogio'],
      ['muito bom demais', 'elogio'],
      ['@ana_paula bora sexta?', 'marcacao'],
      ['@joao.silva @maria', 'marcacao'],
      ['Ganhe seguidores grátis no meu perfil', 'golpe'],
      ['Promoção imperdível em www.lojaxyz.com', 'golpe'],
      ['Confira: bit.ly/abc123', 'golpe'],
      ['seu idiota', 'ofensivo'],
      ['Que lixo de gente', 'ofensivo'],
      ['Hoje é sexta', null],
      ['', null],
      ['   ', null],
    ];
    const errados = casos.filter(([texto, tipo]) => tipoPorRegra(texto, 'casabrasa') !== tipo).map(([texto, tipo]) => `${texto} → ${tipoPorRegra(texto, 'casabrasa')} (esperado ${tipo})`);
    expect(errados).toEqual([]);
  });

  it('a ordem: o golpe primeiro, a reclamação antes do ofensivo (a reclamação com palavrão pede resposta), a marcação antes da pergunta', () => {
    expect(tipoPorRegra('Demorou pra caralho, veio frio', null)).toBe('reclamacao');
    expect(tipoPorRegra('Pedi no www.outraloja.com.br e veio frio', null)).toBe('golpe');
    expect(tipoPorRegra('@ana bora?', null)).toBe('marcacao');
    expect(tipoPorRegra('@ana vocês fazem entrega no Grajaú ainda hoje à noite?', null)).toBe('pergunta');
  });

  it('marcar a própria marca não é marcação de amigo', () => {
    expect(tipoPorRegra('@casabrasa abre hoje?', 'casabrasa')).toBe('pergunta');
    expect(tipoPorRegra('@CasaBrasa', 'casabrasa')).toBeNull();
    expect(tipoPorRegra('@casabrasa', null)).toBe('marcacao');
  });

  it('um domínio no meio de uma palavra comum não é link', () => {
    expect(tipoPorRegra('o combo tem batata', null)).toBeNull();
    expect(tipoPorRegra('a comida chegou .com atraso', null)).toBe('reclamacao');
  });
});

describe('a leitura das respostas da Meta', () => {
  const conta = { id: '17841400000000001', usuario: 'casabrasa' };

  it('o Instagram: o de primeiro nível com as respostas; a da marca pelo id ou pelo @; a lista de respostas pela metade', () => {
    const r = comentariosDoInstagram(
      {
        data: [
          {
            id: '1801',
            text: 'Quanto custa o combo?',
            timestamp: dataDaMeta(AGORA.getTime() - HORA),
            username: 'ana_paula',
            from: { id: '901', username: 'ana_paula' },
            like_count: 3,
            hidden: false,
            replies: {
              data: [
                { id: '1802', text: 'R$ 39,90!', timestamp: dataDaMeta(AGORA.getTime() - 30 * 60_000), username: 'casabrasa', from: { id: conta.id, username: 'casabrasa' }, like_count: 1, hidden: false },
                { id: '1803', text: 'obrigada', timestamp: dataDaMeta(AGORA.getTime() - 10 * 60_000), from: { id: '901', username: 'ana_paula' } },
              ],
              paging: { cursors: { after: 'x' }, next: 'https://graph.facebook.com/mais' },
            },
          },
          // A marca comentando no próprio post, só pelo @ (sem o from).
          { id: '1804', text: 'Sexta tem combo', timestamp: dataDaMeta(AGORA.getTime() - 2 * HORA), username: 'CasaBrasa' },
          // Sem data, fica de fora; sem id também.
          { id: '1805', text: 'sem data' },
          { text: 'sem id', timestamp: dataDaMeta(AGORA.getTime()) },
          { id: '1806', text: 'Que lixo', timestamp: dataDaMeta(AGORA.getTime() - HORA), hidden: true },
        ],
        paging: { cursors: { after: 'QVFI' }, next: 'https://graph.facebook.com/proxima' },
      },
      conta,
    );
    expect(r.proxima).toBe('QVFI');
    expect(r.respostasIncompletas).toBe(true);
    expect(r.comentarios.map((c) => [c.comment_id, c.parent_comment_id, c.by_brand, c.kind, c.reply_count])).toEqual([
      ['1801', null, false, 'pergunta', 2],
      ['1802', '1801', true, null, null],
      ['1803', '1801', false, null, null],
      ['1804', null, true, null, 0],
      ['1806', null, false, 'ofensivo', 0],
    ]);
    expect(r.comentarios[0]).toMatchObject({ author_name: 'ana_paula', author_key: chaveDoAutor('instagram', '901', null), like_count: 3, hidden: false, message: 'Quanto custa o combo?' });
    expect(r.comentarios[4]).toMatchObject({ author_name: null, author_key: null, hidden: true, like_count: null });
    // Sem próxima página quando a Meta não diz que há mais.
    expect(comentariosDoInstagram({ data: [], paging: { cursors: { after: 'QVFI' } } }, conta)).toEqual({ comentarios: [], proxima: null, respostasIncompletas: false });
    expect(comentariosDoInstagram(null, conta)).toEqual({ comentarios: [], proxima: null, respostasIncompletas: false });
  });

  it('a Página: todos os níveis com o parent; sem o from, sem o nome e sem a chave (o pior caso); o da Página é da marca', () => {
    const pagina = '100200300';
    const r = comentariosDaPagina(
      {
        data: [
          { id: '55_1', message: 'Vocês abrem no feriado?', created_time: dataDaMeta(AGORA.getTime() - HORA), like_count: 2, comment_count: 1, is_hidden: false },
          { id: '55_2', message: 'Abrimos sim, das 18h às 23h', created_time: dataDaMeta(AGORA.getTime() - 50 * 60_000), from: { id: pagina, name: 'Casa Brasa' }, parent: { id: '55_1' } },
          { id: '55_3', message: 'Delícia', created_time: dataDaMeta(AGORA.getTime() - 40 * 60_000), from: { id: '777', name: 'Maria Souza' }, is_hidden: true },
        ],
      },
      pagina,
    );
    expect(r.proxima).toBeNull();
    expect(r.comentarios.map((c) => [c.comment_id, c.parent_comment_id, c.author_name, c.by_brand, c.kind, c.hidden])).toEqual([
      ['55_1', null, null, false, 'pergunta', false],
      ['55_2', '55_1', 'Casa Brasa', true, null, false],
      ['55_3', null, 'Maria Souza', false, 'elogio', true],
    ]);
    expect(r.comentarios[0]).toMatchObject({ author_key: null, reply_count: 1, like_count: 2 });
    expect(r.comentarios[2]!.author_key).toBe(chaveDoAutor('facebook', '777', null));
  });

  it('a chave de quem comentou: SHA-256 em hexadecimal; pelo id, ou pelo @ sem diferença de maiúsculas; sem nenhum, nula', () => {
    expect(chaveDoAutor('instagram', '901', null)).toMatch(/^[0-9a-f]{64}$/);
    expect(chaveDoAutor('instagram', null, 'Ana')).toBe(chaveDoAutor('instagram', null, 'ana'));
    expect(chaveDoAutor('instagram', '901', null)).not.toBe(chaveDoAutor('facebook', '901', null));
    expect(chaveDoAutor('facebook', null, null)).toBeNull();
  });
});

describe('os posts da janela e a fila de cada post', () => {
  it('o Instagram: só os dos últimos 30 dias (sem o Story)', () => {
    const lista = {
      data: [
        { id: '1', media_type: 'IMAGE', media_product_type: 'FEED', timestamp: dataDaMeta(AGORA.getTime() - DIA), comments_count: 4, caption: 'Combo' },
        { id: '2', media_type: 'VIDEO', media_product_type: 'STORY', timestamp: dataDaMeta(AGORA.getTime() - HORA) },
        { id: '3', media_type: 'VIDEO', media_product_type: 'REELS', timestamp: dataDaMeta(AGORA.getTime() - 29 * DIA), comments_count: 0 },
        { id: '4', media_type: 'IMAGE', media_product_type: 'FEED', timestamp: dataDaMeta(AGORA.getTime() - 31 * DIA) },
      ],
    };
    expect(postsDoInstagram(lista, AGORA).map((p) => [p.post_id, p.channel, p.kind, p.comment_count])).toEqual([
      ['1', 'instagram', 'foto', 4],
      ['3', 'instagram', 'reels', 0],
    ]);
  });

  it('a Página: só os publicados dos últimos 30 dias, com a miniatura e o endereço da Meta', () => {
    const lista = {
      data: [
        { id: '9_1', created_time: dataDaMeta(AGORA.getTime() - DIA), message: 'Sexta tem combo', permalink_url: 'https://www.facebook.com/9/posts/1', full_picture: 'https://scontent.xx.fbcdn.net/v/1.jpg', is_published: true },
        { id: '9_2', created_time: dataDaMeta(AGORA.getTime() - HORA), message: 'Agendado', is_published: false },
        { id: '9_3', created_time: dataDaMeta(AGORA.getTime() - 40 * DIA), message: 'Antigo' },
        { id: 'abc', created_time: dataDaMeta(AGORA.getTime() - HORA) },
        { id: '9_4', created_time: dataDaMeta(AGORA.getTime() - 2 * DIA), permalink_url: 'https://outro.site/x', full_picture: 'http://sem-https/x.jpg' },
      ],
    };
    expect(postsDaPagina(lista, AGORA)).toEqual([
      { post_id: '9_1', channel: 'facebook', kind: null, caption: 'Sexta tem combo', permalink: 'https://www.facebook.com/9/posts/1', thumbnail_url: 'https://scontent.xx.fbcdn.net/v/1.jpg', published_at: new Date(AGORA.getTime() - DIA).toISOString(), comment_count: null },
      { post_id: '9_4', channel: 'facebook', kind: null, caption: '', permalink: null, thumbnail_url: null, published_at: new Date(AGORA.getTime() - 2 * DIA).toISOString(), comment_count: null },
    ]);
  });

  it('até 7 dias, a cada leitura; de 8 a 30, de hora em hora (55 minutos); o nunca lido e o "Ler agora", sempre', () => {
    const recente = new Date(AGORA.getTime() - 6 * DIA).toISOString();
    const antigo = new Date(AGORA.getTime() - 10 * DIA).toISOString();
    const lido = (min: number) => new Date(AGORA.getTime() - min * 60_000).toISOString();
    expect(postDevido(recente, lido(1), AGORA, false)).toBe(true);
    expect(postDevido(antigo, null, AGORA, false)).toBe(true);
    expect(postDevido(antigo, lido(15), AGORA, false)).toBe(false);
    expect(postDevido(antigo, lido(54), AGORA, false)).toBe(false);
    expect(postDevido(antigo, lido(55), AGORA, false)).toBe(true);
    expect(postDevido(antigo, lido(15), AGORA, true)).toBe(true);
    // O limite dos 7 dias, exato.
    expect(postDevido(new Date(AGORA.getTime() - 7 * DIA).toISOString(), lido(15), AGORA, false)).toBe(true);
    expect(postDevido(new Date(AGORA.getTime() - 7 * DIA - 1).toISOString(), lido(15), AGORA, false)).toBe(false);
  });
});
