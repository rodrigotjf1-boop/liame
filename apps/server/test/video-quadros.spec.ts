import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RenderInternals } from '@remotion/renderer';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { medidasDoJpeg, problemaDasImagens } from '../src/ai/imagens.js';
import { argumentosDoQuadro, LADO_MAIOR_DO_QUADRO, medidasDoQuadro, QUADROS_MAXIMOS, quadrosDoVideo, temposDosQuadros } from '../src/video/quadros.js';
import { VideoQueNaoReduz } from '../src/video/redutor.js';

// Os quadros de um vídeo para o Social media escolher os cortes (A6, o item 7; D-A6-82): as medidas, os tempos e os
// argumentos, e o ffmpeg que vem com o Remotion tirando os quadros de verdade de um vídeo deitado, de um gravado com a
// rotação do celular e de um com as cores do HLG, com os tempos depois do fim pulados.

describe('os quadros: as medidas, os tempos e os argumentos', () => {
  it('o lado maior em até 768 px, na mesma proporção, com os lados pares; o menor fica', () => {
    expect(LADO_MAIOR_DO_QUADRO).toBe(768);
    expect(medidasDoQuadro(3840, 2160)).toEqual({ largura: 768, altura: 432 });
    expect(medidasDoQuadro(2160, 3840)).toEqual({ largura: 432, altura: 768 });
    expect(medidasDoQuadro(1080, 1080)).toEqual({ largura: 768, altura: 768 });
    expect(medidasDoQuadro(640, 360)).toEqual({ largura: 640, altura: 360 });
    expect(medidasDoQuadro(641, 361)).toEqual({ largura: 642, altura: 362 });
  });

  it('os tempos no meio de cada fatia; de 1 a 16; sem duração, nenhum', () => {
    expect(temposDosQuadros(2_000, 4)).toEqual([250, 750, 1250, 1750]);
    expect(temposDosQuadros(30_000, 3)).toEqual([5000, 15000, 25000]);
    expect(temposDosQuadros(10_000, 40)).toHaveLength(QUADROS_MAXIMOS);
    expect(temposDosQuadros(10_000, 0)).toEqual([5000]);
    expect(temposDosQuadros(0, 4)).toEqual([]);
  });

  it('o argumento: pula para o tempo antes de abrir, um quadro, sem som e sem metadados, em JPEG', () => {
    const a = argumentosDoQuadro('in.mov', 'q.jpg', 1250, 'scale=768:432:flags=lanczos,format=yuv420p').join(' ');
    expect(a).toBe('-hide_banner -nostdin -v error -y -ss 1.250 -i in.mov -frames:v 1 -an -vf scale=768:432:flags=lanczos,format=yuv420p -c:v mjpeg -q:v 4 -pix_fmt yuvj420p -map_metadata -1 q.jpg');
  });
});

// O binário de verdade (o do Remotion, o mesmo da imagem do `liame-render`).
const gerar = async (args: string[]) => {
  await RenderInternals.callFf({ bin: 'ffmpeg', args: ['-hide_banner', '-nostdin', '-v', 'error', '-y', ...args], indent: false, logLevel: 'error', binariesDirectory: null, cancelSignal: undefined });
};
const medidas = async (jpeg: Uint8Array, pasta: string, nome: string) => {
  const { writeFile } = await import('node:fs/promises');
  const arquivo = join(pasta, nome);
  await writeFile(arquivo, jpeg);
  const r = await RenderInternals.callFf({
    bin: 'ffprobe',
    args: ['-v', 'error', '-print_format', 'json', '-show_streams', arquivo],
    indent: false,
    logLevel: 'error',
    binariesDirectory: null,
    cancelSignal: undefined,
  });
  const s = (JSON.parse(r.stdout) as { streams: Array<{ width: number; height: number; codec_name: string }> }).streams[0]!;
  return { largura: s.width, altura: s.height, codec: s.codec_name };
};

describe('o ffmpeg do Remotion tira os quadros de verdade', () => {
  let pasta = '';
  beforeAll(async () => {
    pasta = await mkdtemp(join(tmpdir(), 'liame-quadros-teste-'));
  });
  afterAll(async () => {
    if (pasta) await rm(pasta, { recursive: true, force: true });
  });

  it('o deitado 2560 × 1440: quatro quadros de 768 × 432 em JPEG, nos tempos do meio de cada fatia', async () => {
    const entrada = join(pasta, 'deitado.mp4');
    await gerar(['-filter_complex', 'nullsrc=s=2560x1440:r=10:d=2[v]', '-map', '[v]', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', entrada]);
    const q = await quadrosDoVideo(entrada, { quantos: 4, duracaoMs: 2_000 });
    expect(q.map((x) => x.tempoMs)).toEqual([250, 750, 1250, 1750]);
    for (const [i, x] of q.entries()) {
      expect(x.jpeg.slice(0, 3)).toEqual(new Uint8Array([0xff, 0xd8, 0xff]));
      expect(await medidas(x.jpeg, pasta, `d-${i}.jpg`)).toEqual({ largura: 768, altura: 432, codec: 'mjpeg' });
      expect(x.jpeg.byteLength).toBeLessThan(400_000);
      // A medida lida do próprio JPEG pelo gateway (o SOF) é a mesma.
      expect(medidasDoJpeg(x.jpeg)).toEqual({ largura: 768, altura: 432 });
    }
    // A régua do gateway (a tarefa da lista, até 16, JPEG com SOF, até 768 px e 400 KB) aceita a saída de verdade do ffmpeg.
    expect(problemaDasImagens('social_cortes', q)).toBeNull();
  }, 120_000);

  it('o gravado com a rotação do celular sai em pé (432 × 768); o HLG passa ao SDR; os tempos depois do fim são pulados', async () => {
    const semRotacao = join(pasta, 'sem-rotacao.mp4');
    await gerar(['-filter_complex', 'nullsrc=s=2560x1440:r=10:d=2[v]', '-map', '[v]', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', semRotacao]);
    const girado = join(pasta, 'girado.mp4');
    await gerar(['-display_rotation:v:0', '90', '-i', semRotacao, '-c', 'copy', girado]);
    const [g] = await quadrosDoVideo(girado, { quantos: 1, duracaoMs: 2_000 });
    expect(await medidas(g!.jpeg, pasta, 'g.jpg')).toMatchObject({ largura: 432, altura: 768 });

    const hlg = join(pasta, 'hlg.mov');
    await gerar([
      '-filter_complex',
      'nullsrc=s=1440x2560:r=10:d=2[v]',
      '-map',
      '[v]',
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-pix_fmt',
      'yuv420p',
      '-x264-params',
      'colorprim=bt2020:transfer=arib-std-b67:colormatrix=bt2020nc',
      hlg,
    ]);
    const [h] = await quadrosDoVideo(hlg, { quantos: 1, duracaoMs: 2_000 });
    expect(await medidas(h!.jpeg, pasta, 'h.jpg')).toMatchObject({ largura: 432, altura: 768 });
    // O girado e o HLG também passam na régua do gateway, com a medida em pé lida do JPEG.
    expect(medidasDoJpeg(g!.jpeg)).toEqual({ largura: 432, altura: 768 });
    expect(problemaDasImagens('social_cortes', [g!, h!])).toBeNull();

    // A duração maior que o vídeo (2 s): os tempos depois do fim não dão quadro, e os outros seguem.
    const comSobra = await quadrosDoVideo(semRotacao, { quantos: 4, duracaoMs: 8_000 });
    expect(comSobra.map((x) => x.tempoMs)).toEqual([1000]);
  }, 120_000);

  it('o arquivo que não é vídeo derruba o pedido (o ffprobe não acha a imagem)', async () => {
    const falso = join(pasta, 'falso.mp4');
    await gerar(['-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-c:a', 'aac', falso]);
    await expect(quadrosDoVideo(falso, { quantos: 2, duracaoMs: 1_000 })).rejects.toBeInstanceOf(VideoQueNaoReduz);
  }, 60_000);
});
