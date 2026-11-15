import type { BrandPhoto } from '@liame/contracts';
import { describe, expect, it } from 'vitest';
import { foraDoStory } from '../src/components/agenda/story-do-post';
import { campoDaRecusa } from '../src/components/agenda/textos';
import {
  cabeNoInstagram,
  canalNoVideo,
  capaNaTela,
  capaNoPedido,
  comoSaiNaPagina,
  ehVideoPronto,
  foraDoInstagram,
  INSTAGRAM_NAO_DEU,
  INSTAGRAM_PREPARANDO,
  INSTAGRAM_REDUZIDO,
  QUADRO_DO_MEIO,
  rotuloDoVideoNoPost,
  temposDosQuadros,
  type VideoDasFotos,
  versaoNoInstagram,
  videoNoTempo,
} from '../src/components/agenda/video-do-post';

// A6 · Z10, parte 4a: as regras da tela do vídeo no novo post (P37, parte B; D-A6-68 a D-A6-70). O que é vídeo pronto; o que
// cabe no Reels do Instagram e como sai na Página (a mesma conta do servidor, nos contratos: V74); os quadros da capa e o
// que vai no pedido; a capa como a tela a mostra; os nomes dos canais; e o campo das recusas novas do servidor.

const base: BrandPhoto = {
  id: '00000000-0000-4000-8000-000000000001',
  brand_id: '00000000-0000-4000-8000-0000000000b1',
  product: 'Smash duplo',
  description: 'A chapa e o queijo derretendo',
  width: 1080,
  height: 1920,
  bytes: 18_000_000,
  orientation: 'vertical',
  narrow_for_instagram: false,
  instagram_crop: 'nenhum',
  uploaded_at: '2026-11-06T12:00:00.000Z',
  uploaded_by: null,
  url: 'https://bucket.example/video.mp4?assinado',
  thumbnail_url: 'https://bucket.example/video-mini.jpg?assinado',
  urls_expire_at: '2026-11-06T12:05:00.000Z',
  kind: 'video',
  video: { width: 1080, height: 1920, duration_ms: 24_000, media_type: 'video/mp4', has_audio: true, has_cover: true },
};
const video = (o: Partial<BrandPhoto> & { gravado?: Partial<NonNullable<BrandPhoto['video']>> } = {}): VideoDasFotos => {
  const { gravado, ...resto } = o;
  return { ...base, ...resto, video: { ...base.video!, ...gravado } } as VideoDasFotos;
};
const foto: BrandPhoto = { ...base, id: '00000000-0000-4000-8000-0000000000f1', kind: 'foto_produto', video: null, thumbnail_url: 'https://bucket.example/foto-mini.jpg' };

describe('o vídeo no novo post (A6 · Z10, parte 4a)', () => {
  it('o vídeo pronto: o tipo vídeo com o bloco do vídeo; a foto e o vídeo sem o bloco não', () => {
    expect(ehVideoPronto(video())).toBe(true);
    expect(ehVideoPronto(foto)).toBe(false);
    expect(ehVideoPronto({ ...base, video: null })).toBe(false);
  });

  it('o Reels do Instagram pela largura gravada e pela taxa (a mesma conta do servidor); a Página: Reels em pé, vídeo comum deitado ou pequeno', () => {
    expect(cabeNoInstagram(video())).toBe(true);
    // O 4K em pé: a largura gravada passa de 1.920 (a de `width` já vem reduzida, e não conta).
    expect(cabeNoInstagram(video({ width: 1080, height: 1920, gravado: { width: 2160, height: 3840 } }))).toBe(false);
    // 300 MB em 24 s passa de 25 Mbps.
    expect(cabeNoInstagram(video({ bytes: 300_000_000 }))).toBe(false);
    expect(comoSaiNaPagina(video())).toBe('reels');
    expect(comoSaiNaPagina(video({ gravado: { width: 1920, height: 1080 } }))).toBe('video');
    expect(comoSaiNaPagina(video({ gravado: { width: 480, height: 854 } }))).toBe('video');
  });

  it('os quadros da capa: cinco, o do meio marcado (a capa guardada); o pedido leva nada, o tempo ou a foto', () => {
    expect(temposDosQuadros(24_000)).toEqual([0, 6000, 12000, 18000, 22800]);
    expect(QUADRO_DO_MEIO).toBe(2);
    const v = video();
    expect(capaNoPedido({ modo: 'quadro', quadro: QUADRO_DO_MEIO }, v)).toEqual({});
    expect(capaNoPedido({ modo: 'quadro', quadro: 1 }, v)).toEqual({ cover_offset_ms: 6000 });
    expect(capaNoPedido({ modo: 'quadro', quadro: 4 }, v)).toEqual({ cover_offset_ms: 22800 });
    expect(capaNoPedido({ modo: 'foto', foto: foto.id }, v)).toEqual({ cover_photo_id: foto.id });
    expect(capaNoPedido({ modo: 'foto', foto: null }, v)).toEqual({});
  });

  it('a capa na tela: a foto escolhida, a capa guardada no meio, ou o quadro do próprio vídeo pelo tempo', () => {
    const v = video();
    expect(capaNaTela({ modo: 'foto', foto: foto.id }, v, [foto])).toEqual({ imagem: foto.thumbnail_url });
    expect(capaNaTela({ modo: 'quadro', quadro: QUADRO_DO_MEIO }, v, [])).toEqual({ imagem: v.thumbnail_url });
    expect(capaNaTela({ modo: 'quadro', quadro: 3 }, v, [])).toEqual({ video: v.url, tempoMs: 18000 });
    // Sem a capa guardada, o do meio também vem do vídeo.
    expect(capaNaTela({ modo: 'quadro', quadro: QUADRO_DO_MEIO }, video({ gravado: { has_cover: false } }), [])).toEqual({ video: v.url, tempoMs: 12000 });
    // O tempo no endereço, em segundos; o começo um décimo depois (o primeiro quadro pode vir preto).
    expect(videoNoTempo('https://x/v.mp4', 6000)).toBe('https://x/v.mp4#t=6.0');
    expect(videoNoTempo('https://x/v.mp4', 0)).toBe('https://x/v.mp4#t=0.1');
  });

  it('os nomes dos canais no vídeo (P37): Reels no Instagram; na Página, Reels ou vídeo; o grande demais só na Página', () => {
    expect(canalNoVideo('instagram', video())?.nome).toBe('Instagram, como Reels');
    expect(canalNoVideo('instagram', video())?.dica).toBe('Pode aparecer no Feed e na aba Reels.');
    expect(canalNoVideo('instagram', video({ gravado: { width: 2160, height: 3840 } }))?.dica).toContain('sai só na Página');
    expect(canalNoVideo('facebook', video())?.nome).toBe('Página do Facebook, como Reels');
    expect(canalNoVideo('facebook', video({ gravado: { width: 1920, height: 1080 } }))).toEqual({
      nome: 'Página do Facebook, como vídeo',
      dica: 'Deitado, ele sai como vídeo comum: o Reels da Página só aceita vídeo em pé.',
    });
    expect(canalNoVideo('tiktok', video())).toBeNull();
    expect(rotuloDoVideoNoPost(video())).toBe('Smash duplo: A chapa e o queijo derretendo, 24 segundos, em pé');
  });

  it('o 4K pela cópia para o Instagram (parte 3b; D-A6-149): a situação do servidor manda; preparando e não deu ficam fora, com a frase', () => {
    const quatroK = { width: 2160, height: 3840 };
    // A situação que o servidor decidiu vence a conta das medidas.
    expect(versaoNoInstagram(video({ gravado: { ...quatroK, instagram_version: 'reduzida' } }))).toBe('reduzida');
    expect(cabeNoInstagram(video({ gravado: { ...quatroK, instagram_version: 'reduzida' } }))).toBe(true);
    expect(cabeNoInstagram(video({ gravado: { ...quatroK, instagram_version: 'preparando' } }))).toBe(false);
    expect(cabeNoInstagram(video({ gravado: { ...quatroK, instagram_version: 'nao_deu' } }))).toBe(false);
    expect(cabeNoInstagram(video({ gravado: { instagram_version: 'como_esta' } }))).toBe(true);
    // Sem a situação (a resposta de antes), pelas medidas, como antes.
    expect(versaoNoInstagram(video({ gravado: quatroK }))).toBe('nao_deu');
    expect(versaoNoInstagram(video())).toBe('como_esta');
    // As frases do canal.
    expect(foraDoInstagram(video({ gravado: { ...quatroK, instagram_version: 'preparando' } }))).toBe(INSTAGRAM_PREPARANDO);
    expect(canalNoVideo('instagram', video({ gravado: { ...quatroK, instagram_version: 'preparando' } }))?.dica).toBe(INSTAGRAM_PREPARANDO);
    expect(canalNoVideo('instagram', video({ gravado: { ...quatroK, instagram_version: 'nao_deu' } }))?.dica).toBe(INSTAGRAM_NAO_DEU);
    expect(canalNoVideo('instagram', video({ gravado: { ...quatroK, instagram_version: 'reduzida' } }))).toEqual({ nome: 'Instagram, como Reels', dica: INSTAGRAM_REDUZIDO });
    expect(foraDoInstagram(video({ gravado: { ...quatroK, instagram_version: 'reduzida' } }))).toBeNull();
    // O Story do Instagram segue a mesma situação; com a cópia pronta, o tamanho do original não conta (a cópia de até 60 s
    // fica abaixo dos 100 MB, e o servidor confere o tamanho dela).
    expect(foraDoStory('instagram', video({ gravado: { ...quatroK, instagram_version: 'preparando' } }))).toBe(INSTAGRAM_PREPARANDO);
    expect(foraDoStory('instagram', video({ bytes: 200_000_000, gravado: { ...quatroK, instagram_version: 'reduzida' } }))).toBeNull();
    expect(foraDoStory('instagram', video({ bytes: 200_000_000, gravado: { instagram_version: 'como_esta' } }))).toContain('100 MB');
    expect(campoDaRecusa('video-preparando-para-o-instagram')).toBe('foto');
  });

  it('as recusas novas do servidor vão ao campo certo: o vídeo, a capa e o quadro', () => {
    expect(campoDaRecusa('video-grande-para-o-reels')).toBe('foto');
    expect(campoDaRecusa('capa-fora-da-marca')).toBe('capa');
    expect(campoDaRecusa('capa-repetida')).toBe('capa');
    expect(campoDaRecusa('quadro-fora-do-video')).toBe('capa');
    expect(campoDaRecusa('foto-fora-da-marca')).toBe('foto');
    expect(campoDaRecusa('recorte-so-na-foto')).toBeNull();
  });
});
