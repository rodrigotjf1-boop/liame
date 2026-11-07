import { INSTAGRAM_MEDIA_LIMIT, InstagramMediaResponse } from '@liame/contracts';
import { describe, expect, it } from 'vitest';
import { esperaDaFalhaDoInstagram, publicacoesDaLista, releDosNumeros, tipoDaPublicacao } from '../src/fotos/do-seu-instagram.js';
import { situacaoDaLeitura } from '../src/fotos/do-seu-instagram.service.js';

// A6 · Z10, parte 5: "Do seu Instagram" (D-A6-71 e D-A6-83), as funções puras. A lista segue a referência do objeto de
// mídia do Instagram, lida em 07/11/2026: o Reels pelo `media_product_type`; `media_url` falta no vídeo com música do
// Instagram; `thumbnail_url` só no vídeo; `like_count` falta quando a conta esconde as curtidas.

const HORA = 3_600_000;
const item = (o: Record<string, unknown> = {}) => ({
  id: '17900000000000001',
  caption: 'Smash duplo saindo da chapa 🔥',
  media_type: 'IMAGE',
  media_product_type: 'FEED',
  media_url: 'https://scontent.cdninstagram.com/v/foto.jpg?oe=1',
  permalink: 'https://www.instagram.com/p/abc123/',
  timestamp: '2026-10-12T22:00:00+0000',
  like_count: 512,
  comments_count: 38,
  ...o,
});

describe('"Do seu Instagram": a leitura da lista (A6 · Z10, parte 5)', () => {
  it('o tipo: o Reels pelo produto, o carrossel, o vídeo do feed e a foto; o Story e o anúncio ficam de fora', () => {
    expect(tipoDaPublicacao('VIDEO', 'REELS')).toBe('reels');
    expect(tipoDaPublicacao('CAROUSEL_ALBUM', 'FEED')).toBe('carrossel');
    expect(tipoDaPublicacao('VIDEO', 'FEED')).toBe('video');
    expect(tipoDaPublicacao('IMAGE', 'FEED')).toBe('foto');
    expect(tipoDaPublicacao('IMAGE', 'STORY')).toBeNull();
    expect(tipoDaPublicacao('VIDEO', 'AD')).toBeNull();
    expect(tipoDaPublicacao('OUTRO', 'FEED')).toBeNull();
  });

  it('a foto: a miniatura é a própria imagem, com o arquivo; a data do Instagram (+0000) vira ISO', () => {
    expect(publicacoesDaLista({ data: [item()] })).toEqual([
      {
        media_id: '17900000000000001',
        kind: 'foto',
        caption: 'Smash duplo saindo da chapa 🔥',
        permalink: 'https://www.instagram.com/p/abc123/',
        thumbnail_url: 'https://scontent.cdninstagram.com/v/foto.jpg?oe=1',
        has_file: true,
        published_at: '2026-10-12T22:00:00.000Z',
        likes: 512,
        comments: 38,
      },
    ]);
  });

  it('o Reels: a miniatura é a capa; com a música do Instagram (sem `media_url`), sem o arquivo; a conta que esconde as curtidas', () => {
    const [reels, comMusica] = publicacoesDaLista({
      data: [
        item({ id: '1', media_type: 'VIDEO', media_product_type: 'REELS', media_url: 'https://scontent.cdninstagram.com/v/r.mp4', thumbnail_url: 'https://scontent.cdninstagram.com/v/capa.jpg' }),
        item({ id: '2', media_type: 'VIDEO', media_product_type: 'REELS', media_url: undefined, thumbnail_url: 'https://scontent.cdninstagram.com/v/capa2.jpg', like_count: undefined }),
      ],
    });
    expect(reels).toMatchObject({ kind: 'reels', thumbnail_url: 'https://scontent.cdninstagram.com/v/capa.jpg', has_file: true });
    expect(comMusica).toMatchObject({ kind: 'reels', thumbnail_url: 'https://scontent.cdninstagram.com/v/capa2.jpg', has_file: false, likes: null, comments: 38 });
  });

  it('o que fica de fora: sem id, id repetido, sem data, data inválida, o Story; e o endereço que não é https vira nulo', () => {
    const lista = publicacoesDaLista({
      data: [
        item({ id: '' }),
        item({ id: '10' }),
        item({ id: '10', caption: 'repetido' }),
        item({ id: '11', timestamp: undefined }),
        item({ id: '12', timestamp: '2026-13-40T99:00:00+0000' }),
        item({ id: '13', media_product_type: 'STORY' }),
        item({ id: '14', permalink: 'http://www.instagram.com/p/x/', media_url: 'javascript:alert(1)' }),
        item({ id: '15', media_url: 'https://usuario:senha@scontent.cdninstagram.com/x.jpg' }),
        null,
        'texto',
      ],
    });
    expect(lista.map((p) => p.media_id)).toEqual(['10', '14', '15']);
    expect(lista[0]!.caption).toBe('Smash duplo saindo da chapa 🔥');
    expect(lista[1]).toMatchObject({ permalink: null, thumbnail_url: null, has_file: false });
    expect(lista[2]).toMatchObject({ thumbnail_url: null, has_file: false });
    expect(publicacoesDaLista(null)).toEqual([]);
    expect(publicacoesDaLista({ data: 'x' })).toEqual([]);
  });

  it('a legenda: sem o caractere nulo e sem metade de par, cortada em 2.200 sem partir um emoji; as contagens que não são inteiras viram nulo', () => {
    const [p] = publicacoesDaLista({ data: [item({ caption: `a\u0000b\uD800c`, like_count: -1, comments_count: 1.5 })] });
    expect(p!.caption).toBe('ab�c');
    expect([p!.likes, p!.comments]).toEqual([null, null]);
    const longa = `${'x'.repeat(2199)}🔥🔥`;
    const [q] = publicacoesDaLista({ data: [item({ caption: longa })] });
    expect(q!.caption).toBe('x'.repeat(2199));
    expect(q!.caption.isWellFormed()).toBe(true);
  });

  it('até o limite do Liame, na ordem da Meta (as mais novas primeiro)', () => {
    const data = Array.from({ length: INSTAGRAM_MEDIA_LIMIT + 5 }, (_, i) => item({ id: String(1000 + i) }));
    const lista = publicacoesDaLista({ data });
    expect(lista).toHaveLength(INSTAGRAM_MEDIA_LIMIT);
    expect(lista[0]!.media_id).toBe('1000');
  });

  it('os números se releem nos primeiros 30 dias e uma vez para a nunca lida', () => {
    const agora = new Date('2026-11-07T12:00:00.000Z');
    const dias = (n: number) => new Date(agora.getTime() - n * 24 * HORA).toISOString();
    expect(releDosNumeros(dias(40), null, agora)).toBe(true);
    expect(releDosNumeros(dias(40), dias(1), agora)).toBe(false);
    expect(releDosNumeros(dias(29), dias(1), agora)).toBe(true);
    expect(releDosNumeros(dias(30), dias(1), agora)).toBe(false);
  });

  it('a espera depois da falha: sem permissão ou sem autorização, um dia; a cota, a espera pedida (no mínimo 1 hora); a definitiva, 6 horas; o resto, 1 hora', () => {
    expect(esperaDaFalhaDoInstagram('permissao', null)).toBe(24 * HORA);
    expect(esperaDaFalhaDoInstagram('autenticacao', null)).toBe(24 * HORA);
    expect(esperaDaFalhaDoInstagram('limite', 3 * HORA)).toBe(3 * HORA);
    expect(esperaDaFalhaDoInstagram('limite', 60_000)).toBe(HORA);
    expect(esperaDaFalhaDoInstagram('definitivo', null)).toBe(6 * HORA);
    expect(esperaDaFalhaDoInstagram('transitorio', null)).toBe(HORA);
    expect(esperaDaFalhaDoInstagram('circuito_aberto', 5 * HORA)).toBe(HORA);
  });

  it('a situação da leitura: a permissão que falta vence; com uma leitura boa, lido; sem nenhuma, a primeira ou a falha', () => {
    expect(situacaoDaLeitura({ last_success_at: null, last_error: null, cursor: null })).toBe('primeira_leitura');
    expect(situacaoDaLeitura({ last_success_at: null, last_error: 'transitorio: fora', cursor: { falha: 'transitorio' } })).toBe('falhou');
    expect(situacaoDaLeitura({ last_success_at: new Date(), last_error: 'transitorio: fora', cursor: { falha: 'transitorio' } })).toBe('lido');
    expect(situacaoDaLeitura({ last_success_at: new Date(), last_error: 'permissao: sem', cursor: { falha: 'permissao' } })).toBe('sem_permissao');
    expect(situacaoDaLeitura({ last_success_at: new Date(), last_error: null, cursor: {} })).toBe('lido');
  });

  it('o contrato aceita a resposta de cada situação (texto, V23) e recusa o tipo fora do desenho', () => {
    const base = { brand_id: '00000000-0000-4000-8000-000000000001', enabled: true, account: { name: '@casabrasa' }, read_at: null, items: [] };
    for (const situation of ['desligada', 'sem_conta', 'duas_contas', 'primeira_leitura', 'lido', 'sem_permissao', 'falhou']) {
      expect(InstagramMediaResponse.safeParse({ ...base, situation }).success, situation).toBe(true);
    }
    expect(InstagramMediaResponse.safeParse({ ...base, situation: 'Lido!' }).success).toBe(false);
  });
});
