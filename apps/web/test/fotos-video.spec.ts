import type { BrandPhoto } from '@liame/contracts';
import { createElement, createRef } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { CartaoFoto } from '@/components/fotos/cartao-foto';
import { FilaDoEnvio, type ItemDoEnvio } from '@/components/fotos/fila-do-envio';
import { TelaDoVideo } from '@/components/fotos/tela-do-video';
import {
  aceita,
  AVISO_DEITADO,
  canaisDoVideo,
  CONFERINDO_O_VIDEO,
  conferirArquivoDeVideo,
  conferirOVideo,
  doTipo,
  duracaoCurta,
  duracaoPorExtenso,
  ehArquivoDeVideo,
  entrouOVideo,
  type Fase,
  INFO_COM_VIDEO,
  medidasDoVideo,
  quantosNaGrade,
  RECUSA,
  recusaDoCodigo,
  resumoDoEnvio,
  rotuloDoVideo,
  rotulosDoTipo,
  tituloDoEnvio,
} from '@/components/fotos/textos';

// O vídeo nas Fotos, a tela (A6 · Z10, parte 2; P37, parte A, aprovado em 04/11/2026; mockups/prototipo-video-fotos.html):
// a conferência antes de enviar (a mesma conta do servidor), os textos do P37, a lista do envio com vídeos, o filtro por
// tipo, o cartão e o vídeo da gaveta, pelos mesmos componentes do navegador.

const uuid = (n: number) => `a0000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const AGORA = new Date(2026, 9, 21, 15, 0);
const local = (d: number, h: number, m: number) => new Date(2026, 9, d, h, m).toISOString();

function video(over: Partial<BrandPhoto> = {}, comoGravou: Partial<NonNullable<BrandPhoto['video']>> = {}): BrandPhoto {
  return {
    id: uuid(2),
    brand_id: uuid(9),
    product: 'Smash duplo',
    description: '',
    width: 1080,
    height: 1920,
    bytes: 24_000_000,
    orientation: 'vertical',
    narrow_for_instagram: false,
    instagram_crop: 'nenhum',
    uploaded_at: local(18, 19, 40),
    uploaded_by: { id: uuid(7), name: 'Rodrigo' },
    url: 'https://imagens.exemplo/video.mp4?assinado',
    thumbnail_url: 'https://imagens.exemplo/video-mini.jpg?assinado',
    urls_expire_at: new Date(AGORA.getTime() + 300_000).toISOString(),
    kind: 'video',
    video: { width: 1080, height: 1920, duration_ms: 18_000, media_type: 'video/mp4', has_audio: true, has_cover: true, ...comoGravou },
    ...over,
  };
}
const foto = (n: number): Pick<BrandPhoto, 'kind'> => ({ kind: n ? 'foto_produto' : undefined });

describe('O vídeo nas Fotos: a conferência antes de enviar (a mesma conta do servidor)', () => {
  it('o seletor aceita o vídeo só com a função ligada; o arquivo de vídeo pelo tipo ou pelo nome', () => {
    expect(aceita(false)).toBe('image/jpeg,image/png,image/webp');
    expect(aceita(true)).toBe('image/jpeg,image/png,image/webp,video/mp4,video/quicktime');
    expect(ehArquivoDeVideo({ name: 'smash.mp4', type: 'video/mp4' })).toBe(true);
    expect(ehArquivoDeVideo({ name: 'abertura.AVI', type: '' })).toBe(true);
    expect(ehArquivoDeVideo({ name: 'foto.jpg', type: 'image/jpeg' })).toBe(false);
    expect(INFO_COM_VIDEO).toBe(
      'JPEG, PNG ou WebP, até 10 MB. Vídeo em MP4 ou MOV, de 3 a 90 segundos e até 300 MB, de preferência em pé. Só o que a empresa pode usar, sem pessoas que dê para reconhecer.',
    );
  });

  it('o arquivo: MP4 ou MOV, até 300 MB; o vazio não abre', () => {
    expect(conferirArquivoDeVideo({ type: 'video/mp4', size: 24_000_000 })).toBeNull();
    expect(conferirArquivoDeVideo({ type: 'video/quicktime', size: 300 * 1024 * 1024 })).toBeNull();
    expect(conferirArquivoDeVideo({ type: 'video/x-msvideo', size: 12_000_000 })).toBe('formato_video');
    expect(conferirArquivoDeVideo({ type: 'video/webm', size: 1 })).toBe('formato_video');
    expect(conferirArquivoDeVideo({ type: 'video/mp4', size: 300 * 1024 * 1024 + 1 })).toBe('tamanho_video');
    expect(conferirArquivoDeVideo({ type: 'video/mp4', size: 0 })).toBe('nao_abre_video');
  });

  it('o vídeo aberto: de 3 a 90 s e até o 4K, nos mesmos limites do servidor; sem abrir no navegador, o servidor decide', () => {
    const v = (duracaoMs: number | null, largura = 1080, altura = 1920) => conferirOVideo({ duracaoMs, largura, altura });
    expect(v(null, 0, 0)).toBeNull();
    expect(v(3_000)).toBeNull();
    expect(v(90_000)).toBeNull();
    expect(v(2_999)).toBe('curto');
    expect(v(90_001)).toBe('longo');
    expect(v(30_000, 2160, 3840)).toBeNull();
    expect(v(30_000, 4096, 2160)).toBeNull();
    expect(v(30_000, 2160, 4097)).toBe('resolucao');
  });

  it('a recusa do servidor pelo código; os textos do P37 (e os dois de D-A6-74)', () => {
    expect(recusaDoCodigo('video-formato')).toBe('formato_video');
    expect(recusaDoCodigo('video-grande-demais')).toBe('tamanho_video');
    expect(recusaDoCodigo('video-nao-abre')).toBe('nao_abre_video');
    expect(recusaDoCodigo('video-longo')).toBe('longo');
    expect(recusaDoCodigo('video-curto')).toBe('curto');
    expect(recusaDoCodigo('video-codec')).toBe('codec');
    expect(recusaDoCodigo('video-resolucao')).toBe('resolucao');
    // Não é recusa: tentar de novo (o arquivo não chegou, a leitura falhou, o armazenamento não está configurado).
    for (const c of ['video-nao-chegou', 'video-nao-conferido', 'videos-indisponiveis', 'video-nao-subiu']) expect(recusaDoCodigo(c), c).toBeNull();
    expect(RECUSA.formato_video).toBe('Não entrou: vídeo só em MP4 ou MOV.');
    expect(RECUSA.tamanho_video).toBe('Não entrou: passa de 300 MB, o máximo do Reels. Grave em 1080p (não em 4K) ou corte no celular.');
    expect(RECUSA.nao_abre_video).toBe('Não entrou: o arquivo não abre como vídeo.');
    expect(RECUSA.longo).toBe('Não entrou: passa de 90 segundos, o máximo para sair também como Reels na Página do Facebook. Corte no celular e envie de novo.');
    expect(RECUSA.curto).toBe('Não entrou: tem menos de 3 segundos, o mínimo do Reels.');
    expect(RECUSA.codec).toBe('Não entrou: o vídeo precisa estar em H.264 ou HEVC, com o som em AAC, como o celular grava. Envie o arquivo original do celular.');
    expect(RECUSA.resolucao).toBe('Não entrou: passa de 4K (4.096 px no lado maior). Grave em 4K ou menos e envie de novo.');
  });
});

describe('O vídeo nas Fotos: a lista do envio', () => {
  it('o título e o anúncio: vídeos quando são todos vídeos, arquivos quando mistura; as fotos como antes', () => {
    const fim: Fase[] = ['ok', 'aviso'];
    expect(tituloDoEnvio(['enviando', 'na_fila'], [true, true])).toBe('Enviando 2 vídeos');
    expect(tituloDoEnvio(['ok'], [true])).toBe('O vídeo entrou');
    expect(tituloDoEnvio(fim, [true, true])).toBe('Os 2 vídeos entraram');
    expect(tituloDoEnvio(['recusada', 'falhou'], [true, true])).toBe('Nenhum dos 2 vídeos entrou');
    expect(tituloDoEnvio(['recusada'], [true])).toBe('O vídeo não entrou');
    expect(tituloDoEnvio(['ok', 'recusada', 'conferindo'], [true, false, false])).toBe('Enviando 3 arquivos');
    expect(tituloDoEnvio(['ok', 'recusada', 'falhou'], [true, false, false])).toBe('1 de 3 arquivos entrou');
    expect(tituloDoEnvio(['ok', 'ok'], [false, true])).toBe('Os 2 arquivos entraram');
    // As fotos, como no P20 (sem a lista de tipos, todas são fotos).
    expect(tituloDoEnvio(['ok', 'ok'])).toBe('As 2 fotos entraram');
    expect(tituloDoEnvio(['recusada', 'recusada'])).toBe('Nenhuma das 2 fotos entrou');
    expect(resumoDoEnvio(['ok', 'recusada'], [true, true])).toBe('1 vídeo entrou; 1 não entrou.');
    expect(resumoDoEnvio(['ok', 'ok'])).toBe('2 fotos entraram.');
  });

  it('cada situação do vídeo desenhada: conferindo o vídeo, entrou com a duração, deitado e a recusa com o motivo', () => {
    const item = (id: string, fase: Fase, extra: Partial<ItemDoEnvio> = {}): ItemDoEnvio => ({ id, nome: `${id}.mp4`, fase, pct: 0, previa: 'blob:arquivo', video: true, ...extra });
    const itens = [
      item('a', 'enviando', { pct: 40 }),
      item('b', 'conferindo', { pct: 100 }),
      item('c', 'ok', { texto: entrouOVideo(18_000) }),
      item('d', 'aviso'),
      item('e', 'recusada', { recusa: 'longo' }),
    ];
    const html = renderToStaticMarkup(createElement(FilaDoEnvio, { itens, tituloRef: createRef<HTMLHeadingElement>(), aoTentarDeNovo: () => undefined, aoFechar: () => undefined }));
    expect(html).toContain('Enviando 5 vídeos');
    expect(html).toContain('Enviando… 40%');
    expect(html).toContain(CONFERINDO_O_VIDEO);
    expect(html).toContain('Entrou: 18 segundos, em pé.');
    expect(html).toContain(AVISO_DEITADO);
    expect(html).toContain(RECUSA.longo);
    // A prévia do vídeo é o próprio arquivo (não é imagem): a linha mostra o ícone do vídeo.
    expect(html).not.toContain('src="blob:arquivo"');
  });
});

describe('O vídeo nas Fotos: a grade e a gaveta', () => {
  it('as durações do P37: no canto do cartão e para ler', () => {
    expect(duracaoCurta(18_000)).toBe('0:18');
    expect(duracaoCurta(90_000)).toBe('1:30');
    expect(duracaoCurta(59_600)).toBe('1:00');
    expect(duracaoPorExtenso(18_000)).toBe('18 segundos');
    expect(duracaoPorExtenso(90_000)).toBe('1 min e 30 s');
    expect(duracaoPorExtenso(60_000)).toBe('1 min');
  });

  it('o filtro por tipo: tudo, só as fotos ou só os vídeos, com a contagem; o que a grade diz ao leitor de tela', () => {
    const lista = [foto(1), { kind: 'video' }, foto(1), { kind: 'video' }, foto(0)];
    expect(rotulosDoTipo(lista)).toEqual([
      ['tudo', 'Tudo (5)'],
      ['fotos', 'Fotos (3)'],
      ['videos', 'Vídeos (2)'],
    ]);
    expect(doTipo(lista, 'videos')).toHaveLength(2);
    expect(doTipo(lista, 'fotos')).toHaveLength(3);
    expect(doTipo(lista, 'tudo')).toBe(lista);
    expect(quantosNaGrade(lista)).toBe('3 fotos e 2 vídeos');
    expect(quantosNaGrade([{ kind: 'video' }])).toBe('1 vídeo');
    expect(quantosNaGrade([foto(1)])).toBe('1 foto');
  });

  it('o cartão do vídeo: a capa, o tocar e a duração, o selo "Vídeo", em pé ou deitado; antes da capa, o primeiro quadro do próprio vídeo', () => {
    const html = renderToStaticMarkup(createElement(CartaoFoto, { foto: video(), agora: AGORA, aberta: false, aoAbrir: () => undefined, aoFalhar: () => undefined }));
    expect(html).toContain('aria-label="Vídeo: Smash duplo, 18 segundos, em pé, enviado em 18/10"');
    expect(html).toContain('src="https://imagens.exemplo/video-mini.jpg?assinado"');
    expect(html).toContain('>0:18<');
    expect(html).toContain('Vídeo');
    expect(html).toContain('em pé · 18/10');
    expect(html).not.toContain('deitado para o Reels');
    const semCapa = renderToStaticMarkup(createElement(CartaoFoto, { foto: video({}, { has_cover: false }), agora: AGORA, aberta: false, aoAbrir: () => undefined, aoFalhar: () => undefined }));
    expect(semCapa).toContain('<video src="https://imagens.exemplo/video.mp4?assinado#t=0.1"');
    expect(semCapa).not.toContain('<img');
    const deitado = video({ width: 1920, height: 1080, orientation: 'horizontal', product: null, uploaded_at: local(21, 9, 0) }, { width: 3840, height: 2160 });
    const html2 = renderToStaticMarkup(createElement(CartaoFoto, { foto: deitado, agora: AGORA, aberta: false, aoAbrir: () => undefined, aoFalhar: () => undefined }));
    expect(html2).toContain('deitado para o Reels');
    expect(rotuloDoVideo(deitado, AGORA)).toBe('Vídeo: Sem produto, 18 segundos, deitado, enviado hoje, deitado para o Reels');
  });

  it('a gaveta: as medidas como a loja gravou, onde pode sair (em pé e deitado) e o vídeo para assistir', () => {
    expect(medidasDoVideo(video({}, { width: 2160, height: 3840 }))).toBe('2.160 × 3.840 px, em pé');
    expect(medidasDoVideo(video({ width: 1920, height: 1080 }, { width: 1920, height: 1080 }))).toBe('1.920 × 1.080 px, deitado');
    expect(canaisDoVideo(false).map((c) => c.canal)).toEqual(['Reels no Instagram', 'Reels na Página do Facebook', 'TikTok e YouTube Shorts']);
    expect(canaisDoVideo(true).map((c) => `${c.canal}: ${c.detalhe}`)).toEqual([
      'Reels no Instagram: sai deitado: o Reels é feito para vídeo em pé',
      'Vídeo na Página do Facebook: como vídeo comum: o Reels da Página só aceita vídeo em pé',
      'TikTok e YouTube Shorts: no pacote pronto: o mesmo arquivo serve; o Liame monta, você publica',
    ]);
    const tela = renderToStaticMarkup(createElement(TelaDoVideo, { foto: video(), aoFalhar: () => undefined }));
    expect(tela).toContain('src="https://imagens.exemplo/video.mp4?assinado"');
    expect(tela).toContain('poster="https://imagens.exemplo/video-mini.jpg?assinado"');
    expect(tela).toContain('aria-label="Assistir ao vídeo (18 segundos)"');
    expect(tela).toContain('aria-pressed="false"');
    // Nada toca sozinho.
    expect(tela).not.toContain('autoplay');
    const deitadoNaGaveta = renderToStaticMarkup(createElement(TelaDoVideo, { foto: video({ width: 1920, height: 1080 }), aoFalhar: () => undefined }));
    expect(deitadoNaGaveta).toContain('ft-video ft-video--deitado');
  });
});
