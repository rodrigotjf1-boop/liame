import type { BrandPhoto, VideoMontageResponse } from '@liame/contracts';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { CartaoFoto } from '@/components/fotos/cartao-foto';
import { rotuloDoVideo } from '@/components/fotos/textos';
import { CartaoDaMontagem } from '@/components/fotos/video-montado/cartao';
import { quadroNoTempo } from '@/components/fotos/video-montado/previa';
import { aceitas, antesDeste, contagem, quantasLeva, rotuloDaPrevia, semIaTxt, textoDaFase } from '@/components/fotos/video-montado/textos';

// A tela do vídeo montado pelo Liame (A6 · Z15, parte 4; P43): as regras puras da gaveta (as fotos que cada modelo
// aceita, o que cada fase diz, o porquê de o Social media não propor), o tempo da prévia (os instantes do modelo) e o
// cartão do pedido e o selo "Montado pelo Liame" na grade de Fotos.

const foto = (id: string, o: Partial<BrandPhoto> = {}): BrandPhoto => ({
  id,
  brand_id: 'b',
  product: 'Smash Clássico',
  description: '',
  width: 1080,
  height: 1080,
  bytes: 1000,
  orientation: 'quadrada',
  narrow_for_instagram: false,
  instagram_crop: 'nenhum',
  uploaded_at: '2026-11-12T10:00:00.000Z',
  uploaded_by: null,
  url: `https://armazem.test/${id}.jpg`,
  thumbnail_url: `https://armazem.test/${id}-mini.jpg`,
  urls_expire_at: '2026-11-12T10:05:00.000Z',
  kind: 'foto_produto',
  video: null,
  montage_id: null,
  ...o,
});
const montagem = (o: Partial<VideoMontageResponse> = {}): VideoMontageResponse => ({
  id: 'm1',
  brand_id: 'b',
  template: 'combo',
  format: '4x5',
  duration_s: 10,
  media_ids: ['f1', 'f2'],
  title: 'Sexta é dia de combo',
  price_line: 'R$ 39,90',
  cta: 'Já escolheu o seu?',
  with_logo: false,
  sound: 'sem',
  status: 'na_fila',
  progress: 0,
  error: null,
  queue_ahead: 2,
  photo_id: null,
  created_at: '2026-11-12T10:00:00.000Z',
  started_at: null,
  finished_at: null,
  ...o,
});

describe('o vídeo montado: as regras da gaveta', () => {
  const video = foto('v1', { kind: 'video', video: { width: 1080, height: 1920, duration_ms: 12_000, media_type: 'video/mp4', has_audio: true, has_cover: true } });
  const montado = foto('v2', { kind: 'video', montage_id: 'm0', video: { width: 1080, height: 1920, duration_ms: 10_000, media_type: 'video/mp4', has_audio: false, has_cover: true } });
  const fotos = [foto('f1'), foto('f2'), video, montado];

  it('cada modelo aceita as suas: só fotos no destaque e no combo; foto ou vídeo na Novidade; o montado nunca', () => {
    expect(aceitas(fotos, 'destaque').map((f) => f.id)).toEqual(['f1', 'f2']);
    expect(aceitas(fotos, 'combo').map((f) => f.id)).toEqual(['f1', 'f2']);
    expect(aceitas(fotos, 'novidade').map((f) => f.id)).toEqual(['f1', 'f2', 'v1']);
    expect([quantasLeva('destaque'), quantasLeva('combo'), quantasLeva('novidade')]).toEqual(['1 foto', 'de 2 a 4 fotos, na ordem em que entram no vídeo', '1 foto ou 1 vídeo']);
    expect([contagem(12, 40), contagem(44, 40)]).toEqual(['12 de 40', '44 de 40: passou 4']);
  });

  it('o que cada fase diz, na gaveta e no cartão', () => {
    expect([antesDeste(0), antesDeste(1), antesDeste(3)]).toEqual(['É o próximo da fila', '1 vídeo antes deste', '3 vídeos antes deste']);
    expect(textoDaFase(montagem()).t).toBe('Na fila');
    expect(textoDaFase(montagem()).txt).toContain('2 vídeos antes deste');
    expect(textoDaFase(montagem({ status: 'montando', progress: 45, queue_ahead: null })).t).toBe('É a vez deste vídeo');
    expect(textoDaFase(montagem({ status: 'pronto', photo_id: 'v9', queue_ahead: null })).txt).toContain('Montado pelo Liame');
    expect(textoDaFase(montagem({ status: 'pronto', photo_id: null, queue_ahead: null })).t).toBe('O vídeo saiu de Fotos');
    expect(textoDaFase(montagem({ status: 'nao_deu', error: 'A montagem parou no meio.', queue_ahead: null }))).toEqual({ t: 'Não deu para montar este vídeo', txt: 'A montagem parou no meio.' });
  });

  it('o porquê de o Social media não propor, para cada motivo', () => {
    const r = (reason: string, retry_at: string | null = null) => ({ origin: 'sem_ia' as const, reason: reason as never, texts: null, offer: null, retry_at, usage_id: null });
    expect(semIaTxt(r('sem-rota'))).toContain('ainda não escreve');
    expect(semIaTxt(r('barrado'))).toContain('Compliance');
    expect(semIaTxt(r('funcionario_desligado'))).toContain('Sua equipe');
    expect(semIaTxt(r('teto', '2026-11-13T03:00:00.000Z'))).toContain('Ela volta em');
  });
});

describe('o vídeo montado: o tempo da prévia (os instantes do modelo)', () => {
  it('destaque: zoom de 1 a 1,12; o título aos 12%, o preço aos 35%, a chamada aos 60%', () => {
    const q = (t: number) => quadroNoTempo({ modelo: 'destaque', dur: 10, n: 1, video: false }, t);
    expect(q(0)).toMatchObject({ zoom: 1, titulo: false, preco: false, chamada: false });
    expect(q(1.3)).toMatchObject({ titulo: true, preco: false });
    expect(q(3.6)).toMatchObject({ preco: true, chamada: false });
    expect(q(6.1)).toMatchObject({ chamada: true });
    expect(q(10).zoom).toBeCloseTo(1.12);
  });

  it('combo: uma foto de cada vez nos primeiros 70%; no fim, o preço ao centro e o título sai', () => {
    const q = (t: number) => quadroNoTempo({ modelo: 'combo', dur: 10, n: 2, video: false }, t);
    expect(q(1)).toMatchObject({ cena: 0, fim: false, titulo: true, preco: false });
    expect(q(4)).toMatchObject({ cena: 1, fim: false });
    expect(q(7.5)).toMatchObject({ cena: 1, fim: true, titulo: false, preco: true, chamada: false });
    expect(q(8.5)).toMatchObject({ chamada: true });
  });

  it('novidade com vídeo: sem zoom, a faixa aos 5%, o título aos 20%, a chamada aos 55%', () => {
    const q = (t: number) => quadroNoTempo({ modelo: 'novidade', dur: 10, n: 1, video: true }, t);
    expect(q(0.6)).toMatchObject({ faixa: true, titulo: false, zoom: 1 });
    expect(q(2.1)).toMatchObject({ titulo: true, chamada: false });
    expect(q(5.6)).toMatchObject({ chamada: true });
  });

  it('o rótulo da prévia diz o que o quadro mostra', () => {
    expect(
      rotuloDaPrevia({ modelo: 'novidade', formato: '1x1', dur: 6, midias: [{ video: true, produto: 'Smash Clássico' }], titulo: 'Saiu agora', preco: '', chamada: 'Vem provar', logo: true, somOriginal: true }),
    ).toBe('Prévia do vídeo: Novidade da casa, Quadrado (1:1), 6 segundos: o vídeo de Smash Clássico, a faixa “Novidade”, o título “Saiu agora”, a chamada “Vem provar”, com a logo, com o som do vídeo original.');
  });
});

describe('o vídeo montado em Fotos', () => {
  it('o pedido na fila e montando, na grade', () => {
    const html = renderToStaticMarkup(createElement(CartaoDaMontagem, { montagem: montagem(), capa: foto('f1'), aoAbrir: () => {} }));
    expect(html).toContain('Na fila');
    expect(html).toContain('2 vídeos antes deste');
    expect(html).toContain('Montado pelo Liame');
    const montando = renderToStaticMarkup(createElement(CartaoDaMontagem, { montagem: montagem({ status: 'montando', progress: 45, queue_ahead: null }), capa: null, aoAbrir: () => {} }));
    expect(montando).toContain('Montando: 45%');
    expect(montando).toContain('width:45%');
  });

  it('o vídeo pronto leva o selo e o rótulo dizem quem montou', () => {
    const pronto = foto('v3', { kind: 'video', montage_id: 'm1', video: { width: 1080, height: 1920, duration_ms: 10_000, media_type: 'video/mp4', has_audio: false, has_cover: true } });
    const html = renderToStaticMarkup(createElement(CartaoFoto, { foto: pronto, agora: new Date('2026-11-12T12:00:00.000Z'), aberta: false, aoAbrir: () => {}, aoFalhar: () => {} }));
    expect(html).toContain('Montado pelo Liame');
    expect(rotuloDoVideo(pronto, new Date('2026-11-12T12:00:00.000Z'))).toMatch(/^Vídeo montado: Smash Clássico, 10 segundos, em pé, montado pelo Liame hoje$/);
    expect(rotuloDoVideo({ ...pronto, montage_id: null }, new Date('2026-11-12T12:00:00.000Z'))).toContain('enviado hoje');
  });
});
