import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RenderInternals } from '@remotion/renderer';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chaveDaVersaoDoInstagram, copiaAoEntrar, arquivoDoInstagram, versaoDoInstagram } from '../src/fotos/versao-do-instagram.js';
import { argumentosDaReducao, lerSondagem, medidasDaCopia, RedutorFfmpeg, type Sondagem, VideoQueNaoReduz } from '../src/video/redutor.js';

// A cópia do vídeo para o Instagram (A6 · Z10, parte 3b; D-A6-149): a regra da versão (uma só para a lista, o novo post
// e a publicação), a leitura do ffprobe, os argumentos do ffmpeg e o ffmpeg que vem com o Remotion reduzindo de verdade
// um vídeo deitado com som e um em pé em HDR (o HLG do iPhone), gerados na hora pelo mesmo binário.

const E = '0194a1b2-0000-7000-8000-000000000001';
const M = '0194a1b2-0000-7000-8000-000000000002';
const ID = '0194a1b2-0000-7000-8000-000000000003';
const chave = `t/${E}/b/${M}/video/${ID}.mov`;

const semCopia = { instagram_status: null, instagram_bytes: null, instagram_width: null, instagram_height: null };
const video = (o: Partial<Parameters<typeof versaoDoInstagram>[0]> = {}) => ({
  object_key: chave,
  width: 2160,
  height: 3840,
  bytes: 150_000_000,
  duration_ms: 60_000,
  ...semCopia,
  ...o,
});

describe('a versão do vídeo para o Instagram', () => {
  it('a chave da cópia fica ao lado do arquivo, sempre em MP4', () => {
    expect(chaveDaVersaoDoInstagram(chave)).toBe(`t/${E}/b/${M}/video/${ID}-instagram.mp4`);
    expect(chaveDaVersaoDoInstagram(`t/${E}/b/${M}/video/${ID}.mp4`)).toBe(`t/${E}/b/${M}/video/${ID}-instagram.mp4`);
  });

  it('o que cabe vai como está; o maior espera a cópia, vai por ela pronta e, sem ela, não vai', () => {
    // 1080 × 1920 a 8 Mbps: cabe como está, e nem entra na fila.
    const cabe = video({ width: 1080, height: 1920, bytes: 60_000_000 });
    expect(copiaAoEntrar(cabe)).toBeNull();
    expect(versaoDoInstagram(cabe)).toBe('como_esta');
    expect(arquivoDoInstagram(cabe)).toEqual({ chave, largura: 1080, altura: 1920, bytes: 60_000_000, reduzida: false });
    // O 4K em pé (2.160 px de largura) e o 1080p pesado demais (300 MB em 60 s = 40 Mbps) entram na fila.
    expect(copiaAoEntrar(video())).toBe('na_fila');
    expect(copiaAoEntrar(video({ width: 1080, height: 1920, bytes: 300_000_000 }))).toBe('na_fila');
    expect(versaoDoInstagram(video({ instagram_status: 'na_fila' }))).toBe('preparando');
    expect(versaoDoInstagram(video({ instagram_status: 'reduzindo' }))).toBe('preparando');
    expect(arquivoDoInstagram(video({ instagram_status: 'reduzindo' }))).toBeNull();
    const pronta = video({ instagram_status: 'pronta', instagram_bytes: '40000000', instagram_width: 1080, instagram_height: 1920 });
    expect(versaoDoInstagram(pronta)).toBe('reduzida');
    expect(arquivoDoInstagram(pronta)).toEqual({ chave: chaveDaVersaoDoInstagram(chave), largura: 1080, altura: 1920, bytes: 40_000_000, reduzida: true });
    // Não deu (ou o grande de antes, que nunca entrou na fila): só na Página.
    expect(versaoDoInstagram(video({ instagram_status: 'nao_deu' }))).toBe('nao_deu');
    expect(versaoDoInstagram(video())).toBe('nao_deu');
    expect(arquivoDoInstagram(video({ instagram_status: 'nao_deu' }))).toBeNull();
    // "pronta" sem as medidas não vale como cópia.
    expect(arquivoDoInstagram(video({ instagram_status: 'pronta' }))).toBeNull();
  });
});

describe('a leitura do ffprobe e os argumentos do ffmpeg', () => {
  const base: Sondagem = { largura: 2160, altura: 3840, transferencia: 'bt709', faixa: 'tv', duracaoMs: 30_000, temAudio: true, codec: 'hevc' };

  it('as medidas como o vídeo aparece: a rotação de 90° troca os lados; o HDR, a duração e o som', () => {
    const giradoNovo = lerSondagem({
      streams: [{ codec_type: 'video', codec_name: 'hevc', width: 3840, height: 2160, color_transfer: 'arib-std-b67', side_data_list: [{ side_data_type: 'Display Matrix', rotation: -90 }] }, { codec_type: 'audio' }],
      format: { duration: '12.345' },
    });
    expect(giradoNovo).toEqual({ largura: 2160, altura: 3840, transferencia: 'arib-std-b67', faixa: 'tv', duracaoMs: 12_345, temAudio: true, codec: 'hevc' });
    const giradoAntigo = lerSondagem({ streams: [{ codec_type: 'video', codec_name: 'h264', width: 1920, height: 1080, color_range: 'pc', tags: { rotate: '270' } }], format: { duration: '5' } });
    expect(giradoAntigo).toMatchObject({ largura: 1080, altura: 1920, temAudio: false, transferencia: null, faixa: 'pc' });
    const deCabeca = lerSondagem({ streams: [{ codec_type: 'video', width: 1920, height: 1080, side_data_list: [{ rotation: 180 }] }], format: {} });
    expect(deCabeca).toMatchObject({ largura: 1920, altura: 1080, duracaoMs: 0 });
    expect(() => lerSondagem({ streams: [{ codec_type: 'audio' }] })).toThrow(VideoQueNaoReduz);
    expect(() => lerSondagem(null)).toThrow(VideoQueNaoReduz);
  });

  it('a cópia: 1.920 px no lado maior, na mesma proporção, sempre com os lados pares', () => {
    expect(medidasDaCopia({ largura: 2160, altura: 3840 })).toEqual({ largura: 1080, altura: 1920 });
    expect(medidasDaCopia({ largura: 3840, altura: 2160 })).toEqual({ largura: 1920, altura: 1080 });
    // O 1080p pesado demais fica com as medidas (só a taxa cai); o lado ímpar vira par.
    expect(medidasDaCopia({ largura: 1080, altura: 1920 })).toEqual({ largura: 1080, altura: 1920 });
    expect(medidasDaCopia({ largura: 1081, altura: 1917 })).toEqual({ largura: 1080, altura: 1916 });
  });

  it('o SDR reduz pelo scale; o HDR passa ao BT.709 antes; sem som, nenhum; sem os metadados do celular', () => {
    const sdr = argumentosDaReducao('in.mov', 'out.mp4', base);
    expect(sdr).toContain('scale=1080:1920:flags=lanczos,format=yuv420p');
    expect(sdr.join(' ')).toContain('-c:v libx264 -preset veryfast -profile:v high -crf 21 -maxrate 12M -bufsize 24M -fpsmax 60 -g 120 -pix_fmt yuv420p');
    expect(sdr.join(' ')).toContain('-map 0:a:0 -c:a aac -b:a 128k -ar 48000 -ac 2');
    expect(sdr.join(' ')).toContain('-map_metadata -1 -movflags +faststart out.mp4');
    const hdr = argumentosDaReducao('in.mov', 'out.mp4', { ...base, transferencia: 'arib-std-b67', temAudio: false });
    const filtro = hdr[hdr.indexOf('-vf') + 1] ?? '';
    expect(filtro.startsWith('zscale=w=1080:h=1920:f=lanczos:tin=arib-std-b67:pin=bt2020:min=bt2020nc:rin=tv:t=linear:npl=100,')).toBe(true);
    expect(filtro).toContain('tonemap=tonemap=hable:desat=0');
    expect(filtro.endsWith('zscale=t=bt709:m=bt709:r=tv,format=yuv420p')).toBe(true);
    expect(hdr).toContain('-an');
    expect(hdr).not.toContain('0:a:0');
  });
});

// O binário de verdade (o do Remotion, o mesmo da imagem do `liame-render`): gera os vídeos de entrada e reduz.
const gerar = async (args: string[]) => {
  await RenderInternals.callFf({ bin: 'ffmpeg', args: ['-hide_banner', '-nostdin', '-v', 'error', '-y', ...args], indent: false, logLevel: 'error', binariesDirectory: null, cancelSignal: undefined });
};
const sondar = async (arquivo: string) => {
  const r = await RenderInternals.callFf({
    bin: 'ffprobe',
    args: ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', arquivo],
    indent: false,
    logLevel: 'error',
    binariesDirectory: null,
    cancelSignal: undefined,
  });
  return JSON.parse(r.stdout) as { streams: Array<Record<string, unknown>> };
};

describe('o ffmpeg do Remotion reduz de verdade', () => {
  let pasta = '';
  beforeAll(async () => {
    pasta = await mkdtemp(join(tmpdir(), 'liame-redutor-'));
  });
  afterAll(async () => {
    if (pasta) await rm(pasta, { recursive: true, force: true });
  });

  it('o deitado com som, maior que 1.920 px: vira 1920 × 1080 em H.264 e AAC, com a mesma duração', async () => {
    const entrada = join(pasta, 'deitado.mp4');
    // A entrada sai de um grafo de filtros (o build do Remotion não decodifica o `lavfi` de vídeo).
    await gerar([
      '-filter_complex',
      'nullsrc=s=2560x1440:r=10:d=2[v];sine=frequency=440:duration=2[a]',
      '-map',
      '[v]',
      '-map',
      '[a]',
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      entrada,
    ]);
    const saida = await mkdtemp(join(pasta, 'a-'));
    const r = await new RedutorFfmpeg().reduzir(entrada, saida);
    expect(r).toMatchObject({ largura: 1920, altura: 1080 });
    expect(Math.abs(r.duracaoMs - 2_000)).toBeLessThan(300);
    expect(r.bytes).toBe((await stat(r.arquivo)).size);
    const s = await sondar(r.arquivo);
    expect(s.streams.map((x) => `${x.codec_type}:${x.codec_name}`).sort()).toEqual(['audio:aac', 'video:h264']);
    const imagem = s.streams.find((x) => x.codec_type === 'video');
    expect(imagem).toMatchObject({ pix_fmt: 'yuv420p' });
    // O perfil High: o build do Remotion (`--enable-small`) mostra o número (100), sem o nome.
    expect(['High', '100']).toContain(String(imagem?.profile));
    expect(s.streams.find((x) => x.codec_type === 'audio')).toMatchObject({ sample_rate: '48000', channels: 2 });
  }, 120_000);

  it('o em pé em HDR (as cores do HLG do iPhone), sem som: vira 1080 × 1920 em H.264, nas cores do BT.709', async () => {
    // O x265 do Remotion é de 8 bits: a entrada vai em H.264 com as etiquetas do HLG (BT.2020), o que a conversão lê.
    const entrada = join(pasta, 'hdr.mov');
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
      entrada,
    ]);
    expect((await sondar(entrada)).streams[0]).toMatchObject({ color_transfer: 'arib-std-b67', color_primaries: 'bt2020' });
    const saida = await mkdtemp(join(pasta, 'b-'));
    const r = await new RedutorFfmpeg().reduzir(entrada, saida);
    expect(r).toMatchObject({ largura: 1080, altura: 1920 });
    const s = await sondar(r.arquivo);
    expect(s.streams).toHaveLength(1);
    expect(s.streams[0]).toMatchObject({ codec_name: 'h264', pix_fmt: 'yuv420p', color_transfer: 'bt709', color_primaries: 'bt709' });
  }, 120_000);

  it('o gravado deitado com a rotação do celular (aparece em pé): a cópia sai em pé, 1080 × 1920, sem a rotação', async () => {
    const deitado = join(pasta, 'sem-rotacao.mp4');
    await gerar(['-filter_complex', 'nullsrc=s=2560x1440:r=10:d=2[v]', '-map', '[v]', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', deitado]);
    // A rotação vai no arquivo como o celular põe (a matriz de exibição), sem mexer na imagem.
    const entrada = join(pasta, 'girado.mp4');
    await gerar(['-display_rotation:v:0', '90', '-i', deitado, '-c', 'copy', entrada]);
    expect(lerSondagem(await sondar(entrada))).toMatchObject({ largura: 1440, altura: 2560 });
    const saida = await mkdtemp(join(pasta, 'd-'));
    const r = await new RedutorFfmpeg().reduzir(entrada, saida);
    expect(r).toMatchObject({ largura: 1080, altura: 1920 });
    const s = await sondar(r.arquivo);
    expect(s.streams[0]).toMatchObject({ width: 1080, height: 1920 });
    expect(JSON.stringify(s.streams[0]?.side_data_list ?? [])).not.toContain('rotation');
  }, 120_000);

  it('o arquivo que não é vídeo não reduz (e não adianta tentar de novo)', async () => {
    const saida = await mkdtemp(join(pasta, 'c-'));
    const falso = join(pasta, 'falso.mp4');
    await gerar(['-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-c:a', 'aac', falso]);
    await expect(new RedutorFfmpeg().reduzir(falso, saida)).rejects.toBeInstanceOf(VideoQueNaoReduz);
  }, 60_000);
});
