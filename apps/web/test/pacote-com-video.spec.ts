import type { BrandPhoto, PostListResponse, PostResponse } from '@liame/contracts';
import { createElement, createRef } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { CampoDoVideo } from '@/components/agenda/campo-do-video';
import { GavetaPacote } from '@/components/agenda/gaveta-pacote';
import { PreviaDoPacote } from '@/components/agenda/previa-do-pacote';
import { dicaDoTexto, telaDaAgenda } from '@/components/agenda/textos';
import {
  BAIXAR_O_VIDEO,
  CAPA_NO_PACOTE,
  type CapaDoNovo,
  canalNoVideo,
  dicaDaCapa,
  NO_YOUTUBE_DEITADO,
  PACOTE_COM_VIDEO,
  type VideoDasFotos,
} from '@/components/agenda/video-do-post';

// A6 · Z10, parte 4c: o vídeo no pacote do TikTok e do YouTube (P37, parte B: "o mesmo vídeo vai no pacote pronto, para
// você publicar"; D-A6-79). O que se prova: a dica dos canais do pacote; o YouTube com o vídeo deitado (não é Shorts); a
// capa é a do Reels (só com o pacote, ela sai da tela; com o pacote junto, a dica diz quem escolhe); a dica do texto fala
// do vídeo; a prévia do pacote mostra o vídeo; a gaveta do pacote com "Baixe o vídeo" (e o vídeo apagado); e o cartão
// da semana "Pacote com vídeo", com a duração.

const uuid = (n: number) => `c0000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const SP = 'America/Sao_Paulo';
// Quinta, 29/10/2026, em São Paulo.
const HOJE = '2026-10-29';
const semMarcas = (html: string) => html.replace(/<[^>]+>/g, '');

const base: BrandPhoto = {
  id: uuid(80),
  brand_id: uuid(50),
  product: 'Smash duplo',
  description: 'A chapa e o queijo derretendo',
  width: 1080,
  height: 1920,
  bytes: 18_000_000,
  orientation: 'vertical',
  narrow_for_instagram: false,
  instagram_crop: 'nenhum',
  uploaded_at: '2026-10-28T12:00:00.000Z',
  uploaded_by: null,
  url: 'https://bucket.example/video.mp4?assinado',
  thumbnail_url: 'https://bucket.example/video-mini.jpg?assinado',
  urls_expire_at: '2026-10-29T15:05:00.000Z',
  kind: 'video',
  video: { width: 1080, height: 1920, duration_ms: 24_000, media_type: 'video/mp4', has_audio: true, has_cover: true },
};
const video = (gravado: Partial<NonNullable<BrandPhoto['video']>> = {}): VideoDasFotos => ({ ...base, video: { ...base.video!, ...gravado } }) as VideoDasFotos;
const deitado = () => video({ width: 1920, height: 1080 });

const canalDoPacote = (channel: 'tiktok' | 'youtube', o: Partial<PostResponse['channels'][number]> = {}): PostResponse['channels'][number] => ({
  channel,
  account_id: null,
  account_name: null,
  text: 'O smash saindo da chapa 🔥 Peça pelo link da bio!',
  status: 'pronto',
  permalink: null,
  error: null,
  published_at: null,
  removed_at: null,
  metrics: null,
  metrics_status: null,
  metrics_read_at: null,
  retry_until: null,
  ...o,
});

const pacote = (o: Partial<PostResponse> = {}, c = canalDoPacote('tiktok')): PostResponse => ({
  id: uuid(70),
  brand_id: uuid(50),
  kind: 'pacote',
  photo_id: base.id,
  media: 'video',
  cover_photo_id: null,
  cover_offset_ms: null,
  crop_pos: null,
  // Sexta, 30/10, 12:00 em São Paulo.
  publish_at: '2026-10-30T15:00:00.000Z',
  action_id: null,
  status: 'pacote_pronto',
  created_at: '2026-10-29T14:20:00.000Z',
  link: null,
  removal: null,
  channels: [c],
  ...o,
});

const gaveta = (p: PostResponse, foto: BrandPhoto | null = video()) =>
  renderToStaticMarkup(
    createElement(GavetaPacote, {
      post: p,
      fuso: SP,
      hoje: HOJE,
      foto,
      podeOperar: true,
      reserva: { current: null },
      aoMudar: () => undefined,
      aoTirar: () => undefined,
      aoFalharImagem: () => undefined,
      aoFechar: () => undefined,
    }),
  );

const campo = (o: { soPacote?: boolean; comPacote?: boolean; capa?: CapaDoNovo } = {}) =>
  renderToStaticMarkup(
    createElement(CampoDoVideo, {
      ids: 'n',
      videos: [video()],
      fotos: [],
      escolhido: base.id,
      aoEscolher: () => undefined,
      capa: o.capa ?? { modo: 'quadro', quadro: 2 },
      aoMudarCapa: () => undefined,
      enviando: false,
      podeVerFotos: true,
      primeiro: createRef<HTMLButtonElement>(),
      soPacote: o.soPacote,
      comPacote: o.comPacote,
    }),
  );

describe('o vídeo no pacote do TikTok e do YouTube (A6 · Z10, parte 4c)', () => {
  it('os canais do pacote no vídeo: a dica do P37; o YouTube com o vídeo deitado não é Shorts; o TikTok e o em pé sem dica', () => {
    expect(PACOTE_COM_VIDEO).toBe('TikTok e YouTube Shorts: o mesmo vídeo vai no pacote pronto, para você publicar.');
    expect(canalNoVideo('youtube', deitado())).toEqual({ nome: 'YouTube', dica: NO_YOUTUBE_DEITADO });
    expect(canalNoVideo('youtube', video())).toBeNull();
    expect(canalNoVideo('tiktok', deitado())).toBeNull();
    expect(canalNoVideo('youtube', null)).toBeNull();
  });

  it('a capa é a do Reels: só com o pacote, a capa sai da tela e a nota diz quem escolhe; com o pacote junto, a dica diz o mesmo', () => {
    const soPacote = campo({ soPacote: true });
    expect(soPacote).not.toContain('A capa');
    expect(soPacote).not.toContain('Quadros do vídeo');
    expect(soPacote).toContain('data-po-capa-pacote');
    expect(semMarcas(soPacote)).toContain(CAPA_NO_PACOTE);
    // Com o Instagram ou a Página: a capa de sempre, e a dica do pacote no fim.
    const junto = campo({ comPacote: true });
    expect(junto).toContain('A capa');
    expect(semMarcas(junto)).toContain(dicaDaCapa('quadro', true));
    expect(dicaDaCapa('quadro', true)).toBe(`Vem marcado o quadro do meio. A capa é o que aparece antes de o vídeo tocar. ${CAPA_NO_PACOTE}`);
    expect(dicaDaCapa('foto', true).endsWith(CAPA_NO_PACOTE)).toBe(true);
    // Sem o pacote: como na parte 4a.
    const semPacote = campo();
    expect(semMarcas(semPacote)).toContain(dicaDaCapa('quadro'));
    expect(semMarcas(semPacote)).not.toContain(CAPA_NO_PACOTE);
  });

  it('a dica do texto fala do vídeo no lugar da foto (o YouTube e a Página); sem o vídeo, como antes', () => {
    expect(dicaDoTexto('youtube', undefined, true)).toBe('Quem publica é você: o Liame monta o pacote com o texto e o vídeo.');
    expect(dicaDoTexto('facebook', { ok: true, reason: null }, true)).toBe('O texto que sai na Página, com o vídeo. O link do post entra no fim, com o código só deste post.');
    expect(dicaDoTexto('youtube')).toBe('Quem publica é você: o Liame monta o pacote com o texto e a foto.');
  });

  it('a prévia do pacote mostra o próprio vídeo, com os controles e a capa guardada parada; a foto segue como antes', () => {
    const html = renderToStaticMarkup(createElement(PreviaDoPacote, { canal: 'tiktok', texto: 'O smash saindo', foto: video() }));
    expect(html).toContain('Pacote para o TikTok');
    expect(html).toMatch(/<video[^>]*src="https:\/\/bucket\.example\/video\.mp4\?assinado"/);
    expect(html).toContain('controls');
    expect(html).toContain('poster="https://bucket.example/video-mini.jpg?assinado"');
    expect(html).toContain('aria-label="Vídeo do pacote: A chapa e o queijo derretendo, 0:24"');
    expect(html).not.toContain('<img');
    // Sem a capa guardada ainda, sem o poster (o navegador mostra o primeiro quadro).
    expect(renderToStaticMarkup(createElement(PreviaDoPacote, { canal: 'tiktok', texto: 'x', foto: video({ has_cover: false }) }))).not.toContain('poster=');
    const foto = renderToStaticMarkup(createElement(PreviaDoPacote, { canal: 'tiktok', texto: 'x', foto: { ...base, kind: 'foto_produto', video: null } }));
    expect(foto).toContain('<img');
    expect(foto).not.toContain('<video');
  });

  it('a gaveta do pacote com vídeo: "Pacote com vídeo de…", "Baixe o vídeo" e o botão; no YouTube, o deitado não é Shorts; o vídeo apagado diz por quê', () => {
    const html = gaveta(pacote());
    const texto = semMarcas(html);
    for (const t of ['Pacote com vídeo de amanhã, às 12:00', BAIXAR_O_VIDEO.titulo, BAIXAR_O_VIDEO.texto, BAIXAR_O_VIDEO.botao, 'Copie o texto', 'Publique no TikTok', 'Publiquei']) {
      expect(texto, t).toContain(t);
    }
    for (const t of ['Baixe a foto', 'Baixar a foto', 'em JPEG', NO_YOUTUBE_DEITADO]) expect(texto, t).not.toContain(t);
    expect(html).toContain('<video');
    // O YouTube: com o vídeo deitado, o passo 3 avisa; em pé, não.
    const youtube = (v: VideoDasFotos) => semMarcas(gaveta(pacote({}, canalDoPacote('youtube')), v));
    expect(youtube(deitado())).toContain(`O Liame não publica nessa rede: quem publica é você. ${NO_YOUTUBE_DEITADO}`);
    expect(youtube(video())).not.toContain(NO_YOUTUBE_DEITADO);
    // O vídeo apagado em Fotos e vídeos (o pacote sem o id): o passo 1 e a prévia dizem, sem o botão.
    const apagado = semMarcas(gaveta(pacote({ photo_id: null }), null));
    expect(apagado).toContain(BAIXAR_O_VIDEO.apagado);
    expect(apagado).toContain('O vídeo deste pacote foi apagado em Fotos e vídeos.');
    expect(apagado).not.toContain(BAIXAR_O_VIDEO.botao);
    // O vídeo que a lista não trouxe (a função desligada, ou a lista não abriu): a prévia diz, e o botão segue.
    const semLista = semMarcas(gaveta(pacote(), null));
    expect(semLista).toContain('O vídeo deste pacote não pôde ser mostrado aqui.');
    expect(semLista).toContain(BAIXAR_O_VIDEO.botao);
  });

  it('a semana da Agenda: "Pacote com vídeo" com a duração na miniatura; sem a lista das Fotos, sem a duração', () => {
    const dados: PostListResponse = { enabled: true, timezone: SP, channels: [], items: [pacote()], post_link: { ok: false, reason: null }, pauta: [], dates: [] };
    const comFotos = telaDaAgenda(dados, '2026-10-26', HOJE, new Map([[base.id, video()]]));
    if (comFotos.tipo !== 'semana') throw new Error('esperava a semana');
    const item = comFotos.dias.flatMap((d) => d.posts)[0]!;
    expect(item.rotulo).toBe('Pacote com vídeo (24 segundos) de amanhã, às 12:00, TikTok: você publica');
    expect(item.canais).toBe('TikTok');
    expect(item.duracao).toBe('0:24');
    const semFotos = telaDaAgenda(dados, '2026-10-26', HOJE);
    if (semFotos.tipo !== 'semana') throw new Error('esperava a semana');
    expect(semFotos.dias.flatMap((d) => d.posts)[0]!.rotulo).toBe('Pacote com vídeo de amanhã, às 12:00, TikTok: você publica');
  });
});
