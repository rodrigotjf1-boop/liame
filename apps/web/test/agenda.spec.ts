import type { BrandPhoto, PostChannelResponse, PostListResponse, PostResponse } from '@liame/contracts';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { GavetaNovoPost } from '@/components/agenda/gaveta-novo-post';
import { GavetaPacote } from '@/components/agenda/gaveta-pacote';
import { GavetaPost } from '@/components/agenda/gaveta-post';
import {
  avisoDoNovo,
  campoDaRecusa,
  conferirNovo,
  contaDoCanal,
  ddmm,
  dicaDaHora,
  dicaDoLinkDoPost,
  dicaDoTexto,
  ehDoPacote,
  ehPacote,
  enderecoSeguro,
  formatoDaPrevia,
  fraseDaSituacao,
  fraseDoPacote,
  inicioDaSemana,
  instanteNoFuso,
  linhaDoCanal,
  linkCurto,
  noFuso,
  type NovoPost,
  periodo,
  posicaoDoRecorte,
  quadroDoRecorte,
  quando,
  situacaoDoPost,
  somaDias,
  telaDaAgenda,
  textoDoBotao,
} from '@/components/agenda/textos';
import { motivoDe } from '@/components/resultados/pedidos';
import { itensVisiveis, NAVEGACAO, temModos, tituloDa } from '@/components/shell/navegacao';

// A Agenda (A6 · Z5c; mockups/prototipo-post.html, P19 aprovado em 21/10/2026): os posts da marca na semana, de segunda
// a domingo, no fuso da empresa que o servidor manda; a situação de cada post e de cada canal; e a gaveta de um post (a
// prévia, o que aconteceu em cada canal e o que dá para fazer). O cenário é a semana de 26/10 a 01/11/2026, com "hoje"
// na quinta, 29/10, em São Paulo.

const SP = 'America/Sao_Paulo';
const HOJE = '2026-10-29';
const MARCA = '22222222-2222-4222-8222-222222222222';
const IG = '11111111-1111-4111-8111-111111111111';
const FB = '11111111-1111-4111-8111-222222222222';
const id = (n: number) => `33333333-3333-4333-8333-${String(n).padStart(12, '0')}`;
/** A hora de São Paulo (UTC-3) como o servidor manda (UTC). */
const sp = (dia: string, hora: string) => new Date(`${dia}T${hora}:00-03:00`).toISOString();

function canal(c: 'instagram' | 'facebook', parcial: Partial<PostChannelResponse> = {}): PostChannelResponse {
  return {
    channel: c,
    account_id: c === 'instagram' ? IG : FB,
    account_name: c === 'instagram' ? '@misterburgers' : 'Mister Burgers',
    text: c === 'instagram' ? 'Sexta é dia de combo.\nPeça pelo link da bio.' : 'Sexta é dia de combo: smash duplo e batata.',
    status: 'aguardando',
    permalink: null,
    error: null,
    published_at: null,
    ...parcial,
  };
}

function post(n: number, dia: string, hora: string, status: string, canais = [canal('instagram'), canal('facebook')], parcial: Partial<PostResponse> = {}): PostResponse {
  return {
    id: id(n),
    brand_id: MARCA,
    kind: 'post',
    photo_id: id(900 + n),
    crop_pos: null,
    publish_at: sp(dia, hora),
    action_id: id(500 + n),
    status,
    created_at: sp('2026-10-28', '10:15'),
    channels: canais,
    link: null,
    ...parcial,
  };
}

const contas = (ig = true, fb = true): PostListResponse['channels'] => [
  { channel: 'instagram', accounts: ig ? [{ id: IG, name: '@misterburgers' }] : [] },
  { channel: 'facebook', accounts: fb ? [{ id: FB, name: 'Mister Burgers' }] : [] },
];

function lista(items: PostResponse[], parcial: Partial<PostListResponse> = {}): PostListResponse {
  return { enabled: true, timezone: SP, channels: contas(), items, post_link: { ok: true, reason: null }, ...parcial };
}

function foto(largura: number, altura: number): BrandPhoto {
  return {
    id: id(901),
    brand_id: MARCA,
    product: 'Smash duplo',
    description: '',
    width: largura,
    height: altura,
    bytes: 400_000,
    orientation: largura === altura ? 'quadrada' : largura > altura ? 'horizontal' : 'vertical',
    narrow_for_instagram: false,
    instagram_crop: 'nenhum',
    uploaded_at: sp('2026-10-21', '09:00'),
    uploaded_by: null,
    url: 'https://imagens.exemplo/foto.jpg',
    thumbnail_url: 'https://imagens.exemplo/foto-mini.jpg',
    urls_expire_at: sp('2026-10-29', '10:05'),
  };
}

describe('a Agenda: o menu e a semana', () => {
  it('a Agenda fica logo abaixo de Avaliações, para quem acompanha as campanhas, uma tela só nos dois modos (D-A6-24)', () => {
    const agencia = NAVEGACAO.find((g) => g.id === 'agencia')!;
    const hrefs = agencia.itens.map((i) => i.href);
    expect(hrefs.indexOf('/agenda')).toBe(hrefs.indexOf('/avaliacoes') + 1);
    expect(agencia.itens.find((i) => i.href === '/agenda')).toMatchObject({ rotulo: 'Agenda', icone: 'calendar', permissao: 'campanhas.ver' });
    expect(tituloDa('/agenda')).toBe('Agenda');
    expect(temModos('/agenda', () => true)).toBe(false);
    expect(itensVisiveis(agencia, (p) => p !== 'campanhas.ver').some((i) => i.href === '/agenda')).toBe(false);
  });

  it('a semana vai de segunda a domingo; o dia e a hora são os do fuso da empresa', () => {
    expect(inicioDaSemana('2026-10-29')).toBe('2026-10-26');
    expect(inicioDaSemana('2026-11-01')).toBe('2026-10-26');
    expect(inicioDaSemana('2026-10-26')).toBe('2026-10-26');
    expect(somaDias('2026-10-26', 6)).toBe('2026-11-01');
    expect(periodo('2026-10-26')).toBe('26/10 a 01/11');
    expect(ddmm('2026-11-01')).toBe('01/11');
    // 22h em UTC é 19h em São Paulo, e já é o dia seguinte em Moscou (UTC+3).
    expect(noFuso(new Date('2026-10-30T22:00:00Z'), SP)).toEqual({ dia: '2026-10-30', hora: '19:00' });
    expect(noFuso(new Date('2026-10-30T22:00:00Z'), 'Europe/Moscow')).toEqual({ dia: '2026-10-31', hora: '01:00' });
    expect(quando('2026-10-29', '19:00', HOJE)).toBe('hoje, às 19:00');
    expect(quando('2026-10-30', '08:00', HOJE)).toBe('amanhã, às 08:00');
    expect(quando('2026-10-28', '12:30', HOJE)).toBe('ontem, às 12:30');
    expect(quando('2026-10-31', '19:00', HOJE)).toBe('sábado, 31/10, às 19:00');
  });

  it('a situação de cada post: o rótulo, o ícone e o tom; a desconhecida fica neutra, com o próprio nome', () => {
    expect(situacaoDoPost('esperando_aprovacao')).toEqual({ rotulo: 'Espera aprovação', icone: 'alert', tom: 'espera' });
    expect(situacaoDoPost('publicado')).toMatchObject({ rotulo: 'Publicado', tom: 'ok' });
    expect(situacaoDoPost('em_parte')).toMatchObject({ rotulo: 'Saiu em parte', tom: 'falha' });
    expect(situacaoDoPost('nao_saiu')).toMatchObject({ rotulo: 'Não saiu', tom: 'falha' });
    expect(situacaoDoPost('agendado')).toMatchObject({ rotulo: 'Agendado', icone: 'clock', tom: '' });
    expect(situacaoDoPost('na_fila_nova')).toEqual({ rotulo: 'na fila nova', icone: 'info', tom: '' });
  });

  it('a tela: desligada, sem conta em nenhum canal, e a semana com os posts no dia certo, pela hora, sem os que não vão ao ar', () => {
    expect(telaDaAgenda(lista([], { enabled: false, channels: [] }), '2026-10-26', HOJE)).toEqual({ tipo: 'desligada' });
    // Sem conta em canal nenhum, a semana segue (o pacote pronto não precisa de conta; D-A6-44), com o aviso.
    expect(telaDaAgenda(lista([], { channels: contas(false, false) }), '2026-10-26', HOJE)).toMatchObject({ tipo: 'semana', semConta: true, faltam: ['Instagram', 'Página do Facebook'] });

    const posts = [
      post(1, '2026-10-30', '19:00', 'agendado'),
      post(2, '2026-10-30', '12:00', 'esperando_aprovacao'),
      post(3, '2026-10-27', '19:00', 'publicado'),
      post(4, '2026-10-28', '19:00', 'cancelado'),
      post(5, '2026-10-28', '20:00', 'recusado'),
      post(6, '2026-10-31', '09:00', 'expirado'),
      post(7, '2026-10-27', '21:30', 'em_parte', [canal('instagram')]),
    ];
    const t = telaDaAgenda(lista(posts), '2026-10-26', HOJE);
    if (t.tipo !== 'semana') throw new Error('era a semana');
    expect(t.faltam).toEqual([]);
    expect(t.semConta).toBe(false);
    expect(t.dias.map((d) => [d.iso, d.curto, d.hoje, d.passado, d.posts.map((p) => `${p.hora} ${p.post.status}`)])).toEqual([
      ['2026-10-26', 'seg', false, true, []],
      ['2026-10-27', 'ter', false, true, ['19:00 publicado', '21:30 em_parte']],
      ['2026-10-28', 'qua', false, true, []],
      ['2026-10-29', 'qui', true, false, []],
      ['2026-10-30', 'sex', false, false, ['12:00 esperando_aprovacao', '19:00 agendado']],
      ['2026-10-31', 'sáb', false, false, []],
      ['2026-11-01', 'dom', false, false, []],
    ]);
    const sexta = t.dias[4]!.posts;
    expect(sexta[1]).toMatchObject({ canais: 'Instagram · Facebook', rotulo: 'Post de amanhã, às 19:00, Instagram e Página do Facebook: agendado' });
    expect(t.dias[1]!.posts[1]!.canais).toBe('Instagram');

    // Um canal sem conta: a semana aparece, com o aviso do que falta conectar.
    const semPagina = telaDaAgenda(lista(posts, { channels: contas(true, false) }), '2026-10-26', HOJE);
    expect(semPagina.tipo === 'semana' && semPagina.faltam).toEqual(['Página do Facebook']);
  });
});

describe('a gaveta do post', () => {
  it('cada canal em palavras: publicado (com o endereço só https), não saiu (com o motivo), esperando a aprovação ou a hora', () => {
    const publicado = canal('instagram', { status: 'publicado', published_at: sp('2026-10-27', '19:01'), permalink: 'https://www.instagram.com/p/abc/' });
    const p = post(1, '2026-10-27', '19:00', 'em_parte', [publicado, canal('facebook', { status: 'falhou', error: 'A Página do Facebook não aceitou o post. O post não saiu na Página do Facebook.' })]);
    expect(linhaDoCanal(p.channels[0]!, p, SP, HOJE)).toMatchObject({ nome: 'Instagram', tom: 'ok', frase: 'publicado em 27/10, às 19:01.', endereco: 'https://www.instagram.com/p/abc/', rotuloDoEndereco: 'Ver no Instagram' });
    expect(linhaDoCanal(p.channels[1]!, p, SP, HOJE)).toMatchObject({ nome: 'Página do Facebook', tom: 'falha', frase: 'não saiu. A Página do Facebook não aceitou o post. O post não saiu na Página do Facebook.', endereco: null });
    const espera = post(2, '2026-10-30', '19:00', 'esperando_aprovacao');
    expect(linhaDoCanal(espera.channels[0]!, espera, SP, HOJE).frase).toBe('sai amanhã, às 19:00, depois de aprovado.');
    const agendado = post(3, '2026-10-30', '19:00', 'agendado');
    expect(linhaDoCanal(agendado.channels[1]!, agendado, SP, HOJE).frase).toBe('sai amanhã, às 19:00.');
    expect(enderecoSeguro('javascript:alert(1)')).toBeNull();
    expect(enderecoSeguro('http://www.instagram.com/p/abc/')).toBeNull();
    expect(fraseDaSituacao(agendado, SP, HOJE)).toBe('Agendado: aprovado, sai amanhã, às 19:00.');
    expect(fraseDaSituacao(espera, SP, HOJE)).toBe('Espera aprovação: o post só sai depois de aprovado, com o código do app.');
  });

  it('a prévia: no Instagram, a foto alta em 4:5 e a larga em 1,91:1, no ponto do recorte; a que cabe, e a da Página, inteira', () => {
    expect(formatoDaPrevia('instagram', 1200, 1800)).toBe('alta');
    expect(formatoDaPrevia('instagram', 2048, 800)).toBe('larga');
    expect(formatoDaPrevia('instagram', 1600, 1200)).toBe('inteira');
    expect(formatoDaPrevia('facebook', 1200, 1800)).toBe('inteira');
    expect(posicaoDoRecorte('alta', 0)).toBe('50% 0%');
    expect(posicaoDoRecorte('larga', 100)).toBe('100% 50%');
    expect(posicaoDoRecorte('alta', null)).toBe('50% 50%');
  });

  const gaveta = (p: PostResponse, o: { foto?: BrandPhoto | null; podeOperar?: boolean; podeVerContas?: boolean } = {}) =>
    renderToStaticMarkup(
      createElement(GavetaPost, {
        post: p,
        fuso: SP,
        hoje: HOJE,
        foto: o.foto === undefined ? foto(1200, 1800) : o.foto,
        podeOperar: o.podeOperar ?? true,
        podeVerContas: o.podeVerContas ?? true,
        reserva: { current: null },
        aoMudar: () => undefined,
        aoFalharImagem: () => undefined,
        aoFechar: () => undefined,
      }),
    );

  it('o que dá para fazer: abrir em Aprovações o que espera; cancelar o agendado (quem opera); abrir Contas no que não saiu', () => {
    const espera = gaveta(post(2, '2026-10-30', '19:00', 'esperando_aprovacao'));
    expect(espera).toContain(`href="/aprovacoes?pedido=${id(502)}"`);
    expect(espera).toContain('Abrir em Aprovações');
    expect(espera).not.toContain('Cancelar o post');

    const agendado = gaveta(post(3, '2026-10-30', '19:00', 'agendado'));
    expect(agendado).toContain('Cancelar o post');
    expect(agendado).toContain('Post de amanhã, às 19:00');
    expect(gaveta(post(3, '2026-10-30', '19:00', 'agendado'), { podeOperar: false })).not.toContain('Cancelar o post');

    const naoSaiu = gaveta(post(4, '2026-10-27', '19:00', 'nao_saiu'));
    expect(naoSaiu).toContain('href="/contas"');
    expect(gaveta(post(4, '2026-10-27', '19:00', 'nao_saiu'), { podeVerContas: false })).not.toContain('href="/contas"');
  });

  it('a prévia do Instagram: as abas dos canais, a foto alta recortada no ponto aprovado, a nota do recorte e a do link', () => {
    const html = gaveta(post(1, '2026-10-30', '19:00', 'agendado', undefined, { crop_pos: 0 }));
    expect(html).toContain('aria-pressed="true">Instagram</button>');
    expect(html).toContain('aria-pressed="false">Página do Facebook</button>');
    expect(html).toContain('po-foto po-foto--alta');
    expect(html).toContain('object-position:50% 0%');
    expect(html).toContain('No Instagram, a foto sai recortada em 4:5, em pé');
    expect(html).toContain('Na Página, ela vai inteira.');
    expect(html).toContain('a legenda não tem link que abre');
    // Sem a foto (apagada nas Fotos), a gaveta diz que o post não sai.
    expect(gaveta(post(1, '2026-10-30', '19:00', 'agendado', undefined, { photo_id: null }), { foto: null })).toContain('A foto deste post foi apagada nas Fotos: ele não sai.');
  });
});

describe('o novo post (Z5c, parte 3)', () => {
  // Quinta, 29/10/2026, às 10h em São Paulo.
  const AGORA = new Date(sp('2026-10-29', '10:00'));
  const base: NovoPost = { foto: id(901), canais: ['instagram', 'facebook'], textos: { instagram: 'Peça pelo link da bio.', facebook: 'Peça pelo cardápio.' }, dia: '2026-10-30', hora: '19:00', recorte: 50 };
  const conferir = (p: Partial<NovoPost>) => conferirNovo({ ...base, ...p }, AGORA, SP);

  it('a conferência antes de mandar: a foto, os canais, o texto de cada canal e a hora (8h às 22h, 15 minutos adiante, até 60 dias)', () => {
    expect(conferir({})).toEqual({});
    expect(conferir({ foto: null })).toEqual({ foto: 'Escolha a foto do post.' });
    expect(conferir({ canais: [] })).toEqual({ canais: 'Escolha pelo menos um canal.' });
    expect(conferir({ textos: { instagram: '  ', facebook: 'ok' } })).toEqual({ 'texto-instagram': 'Escreva o texto da legenda no Instagram.' });
    expect(conferir({ textos: { instagram: 'x'.repeat(2201), facebook: 'ok' } })).toEqual({ 'texto-instagram': 'No Instagram, o texto passa de 2.200 caracteres (tem 2.201).' });
    // O texto do canal que não está no post não conta.
    expect(conferir({ canais: ['facebook'], textos: { instagram: '', facebook: 'ok' } })).toEqual({});
    expect(conferir({ hora: '07:45' }).hora).toBe('Escolha uma hora entre 8h e 22h.');
    expect(conferir({ hora: '22:15' }).hora).toBe('Escolha uma hora entre 8h e 22h.');
    expect(conferir({ hora: '22:00' })).toEqual({});
    expect(conferir({ dia: '2026-10-29', hora: '10:10' }).hora).toBe('Escolha uma hora daqui a pelo menos 15 minutos.');
    expect(conferir({ dia: '2026-10-29', hora: '10:15' })).toEqual({});
    expect(conferir({ dia: '2026-12-29' }).hora).toBe('O post pode ser marcado para até 60 dias.');
    expect(conferir({ dia: '' }).hora).toBe('Escolha o dia e a hora.');
  });

  it('a hora no fuso da empresa vira o instante certo; o quadro do recorte; a conta de cada canal; o campo da recusa do servidor', () => {
    expect(instanteNoFuso('2026-10-30', '19:00', SP).toISOString()).toBe('2026-10-30T22:00:00.000Z');
    expect(instanteNoFuso('2026-10-30', '19:00', 'Europe/Lisbon').toISOString()).toBe('2026-10-30T19:00:00.000Z');
    expect(instanteNoFuso('2026-07-30', '19:00', 'Europe/Lisbon').toISOString()).toBe('2026-07-30T18:00:00.000Z');
    expect(quadroDoRecorte(1200, 1800, 0)).toEqual({ top: 0, left: 0, width: 100, height: (1500 / 1800) * 100 });
    expect(quadroDoRecorte(1200, 1800, 100)!.top).toBeCloseTo(100 - (1500 / 1800) * 100);
    expect(quadroDoRecorte(2048, 800, 100)).toEqual({ top: 0, left: 100 - ((800 * 1.91) / 2048) * 100, width: ((800 * 1.91) / 2048) * 100, height: 100 });
    expect(quadroDoRecorte(1600, 1200, 50)).toBeNull();
    expect(contaDoCanal([{ id: IG, name: '@misterburgers' }])).toEqual({ conta: { id: IG, name: '@misterburgers' }, fora: null });
    expect(contaDoCanal([]).fora).toBe('Não conectado: ligue em Contas conectadas para publicar aqui.');
    expect(contaDoCanal([{ id: IG, name: 'a' }, { id: FB, name: 'b' }]).fora).toBe('Mais de uma conta ligada à marca: deixe uma só em Contas conectadas.');
    expect(['hora-no-passado', 'hora-fora-da-janela', 'foto-fora-da-marca', 'canal-nao-conectado', 'texto-longo-demais', 'funcao-desligada'].map(campoDaRecusa)).toEqual(['hora', 'hora', 'foto', 'canais', 'texto', null]);
  });

  const novo = (canais: PostListResponse['channels'], fotos: BrandPhoto[] | null = [foto(1200, 1800)]) =>
    renderToStaticMarkup(
      createElement(GavetaNovoPost, {
        marca: MARCA,
        fotos,
        canais,
        fuso: SP,
        hoje: HOJE,
        podeVerContas: true,
        podeVerFotos: true,
        reserva: { current: null },
        aoMandar: () => undefined,
        aoFechar: () => undefined,
      }),
    );

  it('a gaveta: as fotos das Fotos, os canais com a conta (o sem conta, desligado), o texto com o limite, amanhã às 19h e mandar para aprovação', () => {
    const html = novo(contas(true, false));
    expect(html).toContain('Novo post');
    expect(html).toContain('aria-label="Smash duplo"');
    expect(html).toContain('@misterburgers');
    expect(html).toContain('Não conectado: ligue em Contas conectadas para publicar aqui.');
    expect(html).toMatch(/<input type="checkbox" disabled=""\/>Página do Facebook/);
    expect(html).toContain('Texto da legenda no Instagram');
    expect(html).toContain('0 de 2.200');
    expect(html).toContain('value="2026-10-30"');
    expect(html).toContain('value="19:00"');
    expect(html).toContain('Mandar para aprovação');
    // Sem foto nas Fotos, a gaveta diz por quê; sem conta em canal nenhum, o caminho para Contas, e mandar segue ligado:
    // o pacote do TikTok e do YouTube não precisa de conta (P22).
    expect(novo(contas(true, true), [])).toContain('Nenhuma foto pronta nas Fotos desta marca');
    expect(novo(contas(true, true), null)).toContain('As Fotos não estão ligadas para esta empresa');
    const semConta = novo(contas(false, false));
    expect(semConta).toContain('href="/contas"');
    expect(semConta).toMatch(/<button class="btn btn--primary" type="submit">Mandar para aprovação<\/button>/);
  });

  it('os canais em dois grupos (P22): o que o Liame publica e o que você publica, o TikTok e o YouTube sem conta e livres', () => {
    const html = novo(contas(true, true));
    expect(html).toContain('O Liame publica, depois de aprovado');
    expect(html).toContain('Você publica: o Liame monta o pacote');
    expect(html).toMatch(/<input type="checkbox"\/>TikTok/);
    expect(html).toMatch(/<input type="checkbox"\/>YouTube/);
    expect(html).toContain('No TikTok e no YouTube, o Liame não publica');
    // Os do Liame vêm marcados (com a conta); os do pacote, não.
    expect(html).toMatch(/<input type="checkbox" checked=""\/>Instagram/);
  });
});

describe('o pacote pronto (Z8, parte b; P22)', () => {
  // Quinta, 29/10/2026, às 10h em São Paulo.
  const AGORA = new Date(sp('2026-10-29', '10:00'));
  const base: NovoPost = { foto: id(901), canais: ['tiktok'], textos: { tiktok: 'Peça pelo link da bio!', youtube: 'Peça pelo cardápio no link do canal.' }, dia: '2026-10-30', hora: '12:00', recorte: 50 };

  function canalDoPacote(c: 'tiktok' | 'youtube', parcial: Partial<PostChannelResponse> = {}): PostChannelResponse {
    return { channel: c, account_id: null, account_name: null, text: 'A batata nova chegou 🍟 Peça pelo link da bio! #batatafrita', status: 'pronto', permalink: null, error: null, published_at: null, ...parcial };
  }
  const pacote = (n: number, dia: string, hora: string, status = 'pacote_pronto', c = canalDoPacote('tiktok'), parcial: Partial<PostResponse> = {}) =>
    post(n, dia, hora, status, [c], { kind: 'pacote', action_id: null, ...parcial });

  it('o canal e o post do pacote; a situação ("Você publica", "Você publicou"); o cartão diz "Pacote de…"; o tirado sai da semana', () => {
    expect(['tiktok', 'youtube', 'instagram', 'facebook'].map(ehDoPacote)).toEqual([true, true, false, false]);
    expect(ehPacote(pacote(1, '2026-10-30', '12:00'))).toBe(true);
    expect(ehPacote(post(2, '2026-10-30', '12:00', 'agendado'))).toBe(false);
    expect(situacaoDoPost('pacote_pronto')).toEqual({ rotulo: 'Você publica', icone: 'send', tom: '' });
    expect(situacaoDoPost('pacote_publicado')).toEqual({ rotulo: 'Você publicou', icone: 'check-circle', tom: 'ok' });
    const t = telaDaAgenda(
      lista([pacote(1, '2026-10-30', '12:00'), pacote(2, '2026-10-27', '19:00', 'pacote_publicado', canalDoPacote('youtube', { status: 'publicado' })), pacote(3, '2026-10-30', '18:00', 'cancelado', canalDoPacote('tiktok', { status: 'cancelado' }))]),
      '2026-10-26',
      HOJE,
    );
    if (t.tipo !== 'semana') throw new Error('era a semana');
    expect(t.dias[4]!.posts.map((p) => [p.canais, p.rotulo])).toEqual([['TikTok', 'Pacote de amanhã, às 12:00, TikTok: você publica']]);
    expect(t.dias[1]!.posts.map((p) => p.rotulo)).toEqual(['Pacote de terça, 27/10, às 19:00, YouTube: você publicou']);
  });

  it('o novo post: o botão diz o que acontece, a dica da hora e a do texto, a conferência do texto do TikTok e do YouTube', () => {
    expect(textoDoBotao(['instagram', 'facebook'])).toBe('Mandar para aprovação');
    expect(textoDoBotao(['tiktok'])).toBe('Montar o pacote');
    expect(textoDoBotao(['tiktok', 'youtube'])).toBe('Montar o pacote');
    expect(textoDoBotao(['instagram', 'tiktok'])).toBe('Mandar para aprovação e montar o pacote');
    expect(textoDoBotao([])).toBe('Mandar para aprovação');
    expect(dicaDaHora(['tiktok'])).toBe('Entre 8h e 22h. O pacote aparece na Agenda nessa hora, para você publicar.');
    expect(dicaDaHora(['facebook', 'youtube'])).toContain('o pacote fica pronto na Agenda, na mesma hora');
    expect(dicaDaHora(['instagram'])).toBe('Entre 8h e 22h. O Liame publica na hora marcada, só depois de aprovado.');
    expect(dicaDoTexto('tiktok')).toContain('No TikTok, a legenda não tem link que abre');
    expect(dicaDoTexto('youtube')).toBe('Quem publica é você: o Liame monta o pacote com o texto e a foto.');
    const conferir = (p: Partial<NovoPost>) => conferirNovo({ ...base, ...p }, AGORA, SP);
    expect(conferir({})).toEqual({});
    expect(conferir({ textos: { tiktok: ' ' } })).toEqual({ 'texto-tiktok': 'Escreva o texto no TikTok.' });
    expect(conferir({ textos: { tiktok: 'x'.repeat(2201) } })).toEqual({ 'texto-tiktok': 'No TikTok, o texto passa de 2.200 caracteres (tem 2.201).' });
    expect(conferir({ canais: ['youtube'], textos: { youtube: 'x'.repeat(5000) } })).toEqual({});
    expect(conferir({ canais: ['youtube'], textos: { youtube: 'x'.repeat(5001) } })).toEqual({ 'texto-youtube': 'No YouTube, o texto passa de 5.000 caracteres (tem 5.001).' });
    // A hora vale para o pacote também (o servidor confere a mesma janela).
    expect(conferir({ hora: '07:45' }).hora).toBe('Escolha uma hora entre 8h e 22h.');
  });

  it('o aviso depois de mandar: o post para aprovação, o pacote pronto, os dois, e dois pacotes', () => {
    const resposta = { publish_at: sp('2026-10-30', '12:00') };
    expect(avisoDoNovo(resposta, ['instagram'], SP, HOJE)).toBe('Mandado para aprovação. O post sai amanhã, às 12:00, depois de aprovado.');
    expect(avisoDoNovo(resposta, ['tiktok'], SP, HOJE)).toBe('Pacote pronto. Ele aparece na Agenda amanhã, às 12:00, para você publicar no TikTok.');
    expect(avisoDoNovo(resposta, ['tiktok', 'youtube'], SP, HOJE)).toBe('Pacotes prontos. Eles aparecem na Agenda amanhã, às 12:00, para você publicar no TikTok e no YouTube.');
    expect(avisoDoNovo(resposta, ['instagram', 'tiktok'], SP, HOJE)).toBe('Mandado para aprovação, e o pacote do TikTok está na Agenda amanhã, às 12:00, para você publicar.');
    expect(avisoDoNovo(resposta, ['instagram', 'facebook', 'tiktok', 'youtube'], SP, HOJE)).toBe('Mandado para aprovação, e os pacotes do TikTok e do YouTube estão na Agenda amanhã, às 12:00, para você publicar.');
  });

  const gaveta = (p: PostResponse, o: { foto?: BrandPhoto | null; podeOperar?: boolean } = {}) =>
    renderToStaticMarkup(
      createElement(GavetaPacote, {
        post: p,
        fuso: SP,
        hoje: HOJE,
        foto: o.foto === undefined ? foto(1200, 1800) : o.foto,
        podeOperar: o.podeOperar ?? true,
        reserva: { current: null },
        aoMudar: () => undefined,
        aoTirar: () => undefined,
        aoFalharImagem: () => undefined,
        aoFechar: () => undefined,
      }),
    );

  it('a gaveta do pacote pronto: a foto inteira e o texto, os quatro passos, "Publiquei" e "Tirar da Agenda" (quem opera)', () => {
    const p = pacote(1, '2026-10-30', '12:00');
    expect(fraseDoPacote(p, SP, HOJE)).toBe('Você publica: TikTok, amanhã, às 12:00.');
    const html = gaveta(p);
    for (const t of ['Pacote pronto', 'Pacote de amanhã, às 12:00', 'Pacote para o TikTok', 'você publica', 'po-foto po-foto--inteira', 'Baixe a foto', 'Baixar a foto', 'Copie o texto', 'Copiar o texto', 'Publique no TikTok', 'Amanhã, às 12:00. O Liame não publica nessa rede: quem publica é você.', 'Marque como publicado', 'Publiquei', 'Tirar da Agenda', 'A batata nova chegou']) {
      expect(html, t).toContain(t);
    }
    // Sem a permissão de operar: só ler e copiar o texto.
    const leitor = gaveta(p, { podeOperar: false });
    expect(leitor).toContain('Copiar o texto');
    for (const t of ['Baixar a foto', 'Publiquei', 'Tirar da Agenda']) expect(leitor, t).not.toContain(t);
    // O YouTube: o passo 3 diz a rede.
    expect(gaveta(pacote(2, '2026-10-30', '12:00', 'pacote_pronto', canalDoPacote('youtube')))).toContain('Publique no YouTube');
  });

  it('o pacote publicado: a hora em que a pessoa marcou, sem "Publiquei" nem "Tirar"; sem a foto, o passo 1 diz por quê', () => {
    const feito = pacote(1, '2026-10-29', '12:00', 'pacote_publicado', canalDoPacote('tiktok', { status: 'publicado', published_at: sp('2026-10-29', '12:04') }));
    expect(fraseDoPacote(feito, SP, HOJE)).toBe('Você marcou como publicado hoje, às 12:04.');
    const html = gaveta(feito);
    expect(html).toContain('Você marcou como publicado hoje, às 12:04.');
    expect(html).toContain('Feito: a Agenda mostra que saiu.');
    expect(html).toContain('Baixar a foto');
    for (const t of ['Publiquei', 'Tirar da Agenda']) expect(html, t).not.toContain(t);
    const semFoto = gaveta(pacote(3, '2026-10-30', '12:00', 'pacote_pronto', canalDoPacote('tiktok'), { photo_id: null }), { foto: null });
    expect(semFoto).toContain('A foto deste pacote foi apagada nas Fotos.');
    expect(semFoto).toContain('A foto foi apagada nas Fotos: monte outro pacote com outra foto.');
    expect(semFoto).not.toContain('Baixar a foto');
  });
});

describe('o link do post (Z7, parte a; D-A6-46 a D-A6-48)', () => {
  const LINK = 'https://cardapio.regem.exemplo/casa-brasa-centro?utm_source=facebook&utm_medium=social&utm_campaign=post&lk=ABCDE12345';
  const LINK_BIO = 'https://cardapio.regem.exemplo/casa-brasa-centro?utm_source=tiktok&utm_medium=social&utm_campaign=post&lk=FGHJK67890';
  const comLink = (p: PostResponse): PostResponse => ({
    ...p,
    link: LINK,
    channels: p.channels.map((c) => (c.channel === 'facebook' ? { ...c, text: `${c.text}\n\n${LINK}` } : c)),
  });

  it('o link curto (o cardápio sem os parâmetros), o que o novo post diz da Página e o motivo em Resultados', () => {
    expect(linkCurto(LINK)).toBe('cardapio.regem.exemplo/casa-brasa-centro');
    expect(linkCurto('não é endereço')).toBe('não é endereço');
    expect(dicaDoLinkDoPost({ ok: true, reason: null })).toBe('O link do post entra no fim, com o código só deste post.');
    expect(dicaDoLinkDoPost(undefined)).toBe('O link do post entra no fim, com o código só deste post.');
    expect(dicaDoLinkDoPost({ ok: false, reason: 'varias_lojas' })).toBe('A marca tem mais de uma loja com o cardápio ligado: por enquanto, o post sai sem o link.');
    expect(dicaDoLinkDoPost({ ok: false, reason: 'sem_cardapio' })).toBe('Sem o cardápio do Regem ligado a uma loja desta marca, o post sai sem o link.');
    expect(dicaDoTexto('facebook', { ok: true, reason: null })).toBe('O texto que sai na Página, com a foto. O link do post entra no fim, com o código só deste post.');
    expect(dicaDoTexto('instagram', { ok: true, reason: null })).not.toContain('link do post');
    expect(motivoDe('link_do_post', 7)).toBe('Pelo link de um post');
  });

  const gaveta = (p: PostResponse) =>
    renderToStaticMarkup(
      createElement(GavetaPost, {
        post: p,
        fuso: SP,
        hoje: HOJE,
        foto: foto(1600, 1200),
        podeOperar: true,
        podeVerContas: true,
        reserva: { current: null },
        aoMudar: () => undefined,
        aoFalharImagem: () => undefined,
        aoFechar: () => undefined,
      }),
    );

  it('a gaveta do post com a Página: o link destacado no fim do texto, a nota e o fato "Link" com "Copiar o link"', () => {
    const p = comLink(post(1, '2026-10-30', '19:00', 'agendado', [canal('facebook')]));
    const html = gaveta(p);
    expect(html).toContain(`<span class="po-link">${LINK.replaceAll('&', '&amp;')}</span>`);
    expect(html).toContain('O link do post vai no fim do texto da Página, com o código só deste post: o pedido por ele fica separado dos anúncios.');
    expect(html).toContain('<dt>Link</dt>');
    expect(html).toContain('cardapio.regem.exemplo/casa-brasa-centro, com o código só deste post');
    expect(html).toContain('Copiar o link');
    // Sem o link (o post sem a Página, ou a marca sem uma loja só), nada disso aparece.
    const sem = gaveta(post(2, '2026-10-30', '19:00', 'agendado'));
    for (const t of ['po-link', '<dt>Link</dt>', 'Copiar o link', 'O link do post vai no fim']) expect(sem, t).not.toContain(t);
  });

  it('o pacote com o link da bio: o link curto e "Copiar o link"; o novo post só com a Página diz por que sai sem o link', () => {
    const pacote = post(3, '2026-10-30', '12:00', 'pacote_pronto', [{ channel: 'tiktok', account_id: null, account_name: null, text: 'Peça pelo link da bio!', status: 'pronto', permalink: null, error: null, published_at: null }], { kind: 'pacote', action_id: null, link: LINK_BIO });
    const html = renderToStaticMarkup(
      createElement(GavetaPacote, {
        post: pacote,
        fuso: SP,
        hoje: HOJE,
        foto: foto(1200, 1800),
        podeOperar: true,
        reserva: { current: null },
        aoMudar: () => undefined,
        aoTirar: () => undefined,
        aoFalharImagem: () => undefined,
        aoFechar: () => undefined,
      }),
    );
    expect(html).toContain('Para medir pelo pedido, o link do cardápio só deste pacote pode ir na bio: <b>cardapio.regem.exemplo/casa-brasa-centro</b>, com o código do pacote.');
    expect(html).toContain('Copiar o link');
    const novo = renderToStaticMarkup(
      createElement(GavetaNovoPost, {
        marca: MARCA,
        fotos: [foto(1600, 1200)],
        canais: contas(false, true),
        postLink: { ok: false, reason: 'varias_lojas' },
        fuso: SP,
        hoje: HOJE,
        podeVerContas: true,
        podeVerFotos: true,
        reserva: { current: null },
        aoMandar: () => undefined,
        aoFechar: () => undefined,
      }),
    );
    expect(novo).toContain('Texto na Página do Facebook');
    expect(novo).toContain('A marca tem mais de uma loja com o cardápio ligado: por enquanto, o post sai sem o link.');
  });
});
