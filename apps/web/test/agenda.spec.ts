import type { BrandPhoto, PostChannelResponse, PostListResponse, PostResponse } from '@liame/contracts';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { GavetaPost } from '@/components/agenda/gaveta-post';
import {
  ddmm,
  enderecoSeguro,
  formatoDaPrevia,
  fraseDaSituacao,
  inicioDaSemana,
  linhaDoCanal,
  noFuso,
  periodo,
  posicaoDoRecorte,
  quando,
  situacaoDoPost,
  somaDias,
  telaDaAgenda,
} from '@/components/agenda/textos';
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
    photo_id: id(900 + n),
    crop_pos: null,
    publish_at: sp(dia, hora),
    action_id: id(500 + n),
    status,
    created_at: sp('2026-10-28', '10:15'),
    channels: canais,
    ...parcial,
  };
}

const contas = (ig = true, fb = true): PostListResponse['channels'] => [
  { channel: 'instagram', accounts: ig ? [{ id: IG, name: '@misterburgers' }] : [] },
  { channel: 'facebook', accounts: fb ? [{ id: FB, name: 'Mister Burgers' }] : [] },
];

function lista(items: PostResponse[], parcial: Partial<PostListResponse> = {}): PostListResponse {
  return { enabled: true, timezone: SP, channels: contas(), items, ...parcial };
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
    expect(telaDaAgenda(lista([], { channels: contas(false, false) }), '2026-10-26', HOJE).tipo).toBe('sem-canal');

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
