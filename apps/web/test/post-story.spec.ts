import type { BrandPhoto, PostChannelResponse, PostListResponse, PostResponse } from '@liame/contracts';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ApagarDasRedes } from '@/components/agenda/apagar-das-redes';
import { GavetaNovoPost } from '@/components/agenda/gaveta-novo-post';
import { canalNoStory, ehStory, emPeNoStory, fimDoStory, foraDoStory, storyNoAr } from '@/components/agenda/story-do-post';
import {
  avisoDoApagar,
  campoDaRecusa,
  deOndeSai,
  fraseDaSituacao,
  podeApagar,
  situacaoNaTela,
  storyFicaNaPagina,
  telaDaAgenda,
} from '@/components/agenda/textos';

// A6 · Z13, parte 2: a tela do Story (P41, aprovado pelo dono em 11/11/2026; D-A6-126 a D-A6-129 e D-A6-132). As regras
// do Story na tela: o que é em pé, os limites de cada canal, o "no ar até" e o "saiu do ar", a Agenda, o formato no novo
// post (só com a função ligada) e o "Tirar do ar" (só do Instagram, nas 24 horas; a Página fica, e a tela diz por quê).

const SP = 'America/Sao_Paulo';
const HOJE = '2026-11-11';
const MARCA = '22222222-2222-4222-8222-222222222222';
const id = (n: number) => `33333333-3333-4333-8333-${String(n).padStart(12, '0')}`;
const sp = (dia: string, hora: string) => new Date(`${dia}T${hora}:00-03:00`).toISOString();

function canal(c: 'instagram' | 'facebook', parcial: Partial<PostChannelResponse> = {}): PostChannelResponse {
  return {
    channel: c,
    account_id: id(c === 'instagram' ? 61 : 62),
    account_name: c === 'instagram' ? '@misterburgers' : 'Mister Burgers',
    text: '',
    status: 'aguardando',
    permalink: null,
    error: null,
    published_at: null,
    removed_at: null,
    metrics: null,
    metrics_status: null,
    metrics_read_at: null,
    retry_until: null,
    ...parcial,
  };
}

/** O Story publicado nos dois canais às 10h de hoje, em São Paulo. */
function story(parcial: Partial<PostResponse> = {}, canais?: PostChannelResponse[]): PostResponse {
  return {
    id: id(1),
    brand_id: MARCA,
    kind: 'post',
    format: 'story',
    photo_id: id(900),
    crop_pos: null,
    publish_at: sp(HOJE, '10:00'),
    action_id: id(500),
    status: 'publicado',
    created_at: sp('2026-11-10', '18:00'),
    channels: canais ?? [canal('instagram', { status: 'publicado', published_at: sp(HOJE, '10:00') }), canal('facebook', { status: 'publicado', published_at: sp(HOJE, '10:01') })],
    removal: null,
    link: null,
    ...parcial,
  };
}

function midia(largura: number, altura: number, o: Partial<BrandPhoto> = {}): BrandPhoto {
  return {
    id: id(900),
    brand_id: MARCA,
    product: 'Smash duplo',
    description: '',
    width: largura,
    height: altura,
    bytes: 400_000,
    orientation: largura === altura ? 'quadrada' : largura > altura ? 'horizontal' : 'vertical',
    narrow_for_instagram: false,
    instagram_crop: 'nenhum',
    uploaded_at: sp('2026-11-01', '09:00'),
    uploaded_by: null,
    url: 'https://imagens.exemplo/foto.jpg',
    thumbnail_url: 'https://imagens.exemplo/foto-mini.jpg',
    urls_expire_at: sp(HOJE, '10:05'),
    ...o,
  };
}
const video = (duracaoMs: number, bytes = 20_000_000): BrandPhoto =>
  midia(1080, 1920, { kind: 'video', bytes, video: { width: 1080, height: 1920, duration_ms: duracaoMs, media_type: 'video/mp4', has_audio: true, has_cover: true } });

const contas: PostListResponse['channels'] = [
  { channel: 'instagram', accounts: [{ id: id(61), name: '@misterburgers' }] },
  { channel: 'facebook', accounts: [{ id: id(62), name: 'Mister Burgers' }] },
];

describe('o Story na tela (A6 · Z13, parte 2)', () => {
  it('o formato: só o Story leva a chave; em pé é 9:16 ou mais alto; os limites de cada canal (D-A6-128)', () => {
    expect(ehStory(story())).toBe(true);
    expect(ehStory({ format: undefined })).toBe(false);
    expect(emPeNoStory(midia(1080, 1920))).toBe(true);
    expect(emPeNoStory(midia(1080, 1350))).toBe(false);
    expect(foraDoStory('instagram', midia(1080, 1920, { bytes: 9 * 1024 * 1024 }))).toBe('Esta foto passa de 8 MB, o limite do Story do Instagram.');
    expect(foraDoStory('facebook', midia(1080, 1920, { bytes: 9 * 1024 * 1024 }))).toBeNull();
    // O vídeo de 1:15: fora do Story do Instagram (até 60 s), dentro do da Página (até 90 s).
    expect(foraDoStory('instagram', video(75_000))).toContain('o Story do Instagram vai até 60 segundos');
    expect(foraDoStory('facebook', video(75_000))).toBeNull();
    expect(foraDoStory('facebook', video(95_000))).toBe('Este vídeo passa de 90 segundos, o limite do Story da Página.');
    expect(canalNoStory('instagram', null)).toMatchObject({ nome: 'Instagram, como Story', fora: null });
    expect(['story-fora-do-limite', 'story-sem-pacote'].map(campoDaRecusa)).toEqual(['foto', 'canais']);
  });

  it('24 horas no ar, do primeiro canal em que saiu: "No ar até" e depois "Saiu do ar" (D-A6-129)', () => {
    const s = story();
    expect(fimDoStory(s)?.toISOString()).toBe(sp('2026-11-12', '10:00'));
    expect(fimDoStory(story({ status: 'agendado' }, [canal('instagram')]))).toBeNull();
    const antes = new Date(sp(HOJE, '15:00'));
    const depois = new Date(sp('2026-11-12', '10:30'));
    expect(storyNoAr(s, antes)).toBe(true);
    expect(storyNoAr(s, depois)).toBe(false);
    expect(situacaoNaTela(s, antes, SP).rotulo).toBe('No ar até 10:00');
    expect(situacaoNaTela(s, depois, SP).rotulo).toBe('Saiu do ar');
    expect(fraseDaSituacao(s, SP, HOJE, antes)).toBe('No ar até amanhã, às 10:00: some sozinho depois de 24 horas.');
    expect(fraseDaSituacao(story({ status: 'esperando_aprovacao' }, [canal('instagram')]), SP, HOJE, antes)).toContain('o Story só sai depois de aprovado');
  });

  it('a Agenda: o cartão diz Story, com a etiqueta, e o rótulo a situação de agora', () => {
    const dados: PostListResponse = { enabled: true, timezone: SP, channels: contas, items: [story()], post_link: { ok: true, reason: null }, pauta: [], dates: [], stories_enabled: true };
    const tela = telaDaAgenda(dados, '2026-11-09', HOJE, undefined, new Date(sp(HOJE, '15:00')));
    expect(tela.tipo).toBe('semana');
    const item = tela.tipo === 'semana' ? tela.dias.flatMap((d) => d.posts)[0]! : null;
    expect(item).toMatchObject({ story: true });
    expect(item!.rotulo).toBe('Story de hoje, às 10:00, Instagram e Página do Facebook: no ar até 10:00');
  });

  it('o novo post: o formato "Post ou Story" só com a função ligada; começa no post', () => {
    const novo = (storiesLigados: boolean) =>
      renderToStaticMarkup(
        createElement(GavetaNovoPost, {
          marca: MARCA,
          fotos: [midia(1080, 1920)],
          storiesLigados,
          canais: contas,
          fuso: SP,
          hoje: HOJE,
          podeVerContas: true,
          podeVerFotos: true,
          reserva: { current: null },
          aoMandar: () => undefined,
          aoFechar: () => undefined,
        }),
      );
    const ligado = novo(true);
    expect(ligado).toContain('Formato');
    expect(ligado).toMatch(/<button type="button" aria-pressed="true"[^>]*>[^<]*(<[^>]+>)*Post/);
    expect(ligado).toContain('Novo post');
    expect(novo(false)).not.toContain('Formato');
  });

  it('tirar do ar (D-A6-132): só do Instagram, nas 24 horas; a Página fica e a tela diz por quê', () => {
    const agora = new Date(sp(HOJE, '15:00'));
    const s = story();
    expect(podeApagar(s, agora)).toBe(true);
    expect(podeApagar(s, new Date(sp('2026-11-12', '11:00')))).toBe(false);
    // Só na Página: a Meta não deixa tirar pela API.
    expect(podeApagar(story({}, [canal('facebook', { status: 'publicado', published_at: sp(HOJE, '10:00') })]), agora)).toBe(false);
    expect(deOndeSai(s)).toBe('do Instagram');
    expect(storyFicaNaPagina(s)).toContain('a Meta não deixa tirar o Story pela API');
    expect(storyFicaNaPagina(story({}, [canal('instagram', { status: 'publicado', published_at: sp(HOJE, '10:00') })]))).toBeNull();
    // O pedido que tirou do Instagram e deixou a Página: o porquê, sem ser falha.
    expect(avisoDoApagar({ format: 'story', removal: { action_id: id(501), status: 'em_parte', reason: null, requested_by_name: 'Rodrigo', requested_at: sp(HOJE, '15:00') } })).toBe(
      'O Story saiu do Instagram. Na Página do Facebook, a Meta não deixa tirar pela API: tire direto na Página, ou espere, que ele some sozinho depois de 24 horas.',
    );
    const html = renderToStaticMarkup(
      createElement(ApagarDasRedes, { id: 'tirar', deOnde: deOndeSai(s), story: true, naPagina: storyFicaNaPagina(s), aoApagar: async () => ({ ok: true as const }), aoManter: () => undefined }),
    );
    expect(html).toContain('aria-label="Tirar o Story do ar"');
    expect(html).toContain('Sai do Instagram agora, antes das 24 horas.');
    expect(html).toContain('Tirar do ar');
    expect(html).toContain('Na Página do Facebook, a Meta não deixa tirar o Story pela API');
  });
});
