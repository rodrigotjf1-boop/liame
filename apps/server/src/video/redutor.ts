import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { BRAND_VIDEO_LIMITS, fitsInstagramReels } from '@liame/contracts';
import { medidasNoReels } from '../fotos/conferencia.js';

// A cópia do vídeo para o Instagram (A6 · Z10, parte 3b; D-A6-149): o ffmpeg que vem com o Remotion (o mesmo binário que
// a montagem usa, na imagem do `liame-render`; nada novo para instalar) lê o vídeo como a loja gravou e grava um MP4 em
// H.264 e AAC com até 1.920 px no lado maior, na mesma proporção, abaixo dos 25 Mbps. Só o serviço `liame-render` usa
// isto: o renderer é carregado na hora (a API e o worker nunca o carregam).

export const REDUTOR = Symbol('REDUTOR');

/** A cópia reduzida numa pasta temporária, com as medidas e o tamanho que vão para o banco. */
export type VideoReduzidoNoDisco = { arquivo: string; largura: number; altura: number; duracaoMs: number; bytes: number };

export interface Redutor {
  /** Reduz `entrada` (o arquivo como a loja gravou) para o Instagram, gravando a cópia em `pasta`. */
  reduzir(entrada: string, pasta: string): Promise<VideoReduzidoNoDisco>;
}

/** O arquivo que o ffmpeg não abre (ou sem imagem): tentar de novo não adianta. */
export class VideoQueNaoReduz extends Error {}

/** O que o `ffprobe` diz do vídeo: as medidas como ele aparece (a rotação aplicada), o HDR, a duração e o som. */
export type Sondagem = {
  largura: number;
  altura: number;
  transferencia: string | null;
  /** A faixa das cores: `pc` (cheia) ou `tv` (a limitada, a do celular e o padrão quando o arquivo não diz). */
  faixa: 'pc' | 'tv';
  duracaoMs: number;
  temAudio: boolean;
  codec: string;
};

/** As transferências do HDR que o celular grava (o HLG do iPhone e o PQ): a cópia converte para as cores do SDR. */
const TRANSFERENCIAS_DO_HDR = new Set(['arib-std-b67', 'smpte2084']);

/** O quanto o vídeo está girado, em graus (a matriz do `ffprobe` novo, ou a etiqueta `rotate` do antigo). */
function rotacaoDe(stream: Record<string, unknown>): number {
  const lados = Array.isArray(stream.side_data_list) ? (stream.side_data_list as Array<Record<string, unknown>>) : [];
  for (const l of lados) if (typeof l.rotation === 'number') return l.rotation;
  const tags = stream.tags as Record<string, unknown> | undefined;
  const r = Number(tags?.rotate);
  return Number.isFinite(r) ? r : 0;
}

/** Lê a saída JSON do `ffprobe -show_streams -show_format`. Sem imagem, o vídeo não reduz. */
export function lerSondagem(saida: unknown): Sondagem {
  const s = (saida ?? {}) as { streams?: Array<Record<string, unknown>>; format?: Record<string, unknown> };
  const streams = Array.isArray(s.streams) ? s.streams : [];
  const video = streams.find((x) => x.codec_type === 'video');
  const largura = Number(video?.width);
  const altura = Number(video?.height);
  if (!video || !(largura > 0) || !(altura > 0)) throw new VideoQueNaoReduz('o ffprobe não achou a imagem do vídeo');
  const deitado = Math.abs(rotacaoDe(video)) % 180 === 90;
  const duracao = Number(s.format?.duration ?? video.duration);
  return {
    largura: deitado ? altura : largura,
    altura: deitado ? largura : altura,
    transferencia: typeof video.color_transfer === 'string' ? video.color_transfer : null,
    faixa: video.color_range === 'pc' ? 'pc' : 'tv',
    duracaoMs: Number.isFinite(duracao) && duracao > 0 ? Math.round(duracao * 1000) : 0,
    temAudio: streams.some((x) => x.codec_type === 'audio'),
    codec: typeof video.codec_name === 'string' ? video.codec_name : '',
  };
}

/** As medidas da cópia: as do Reels (1.920 px no lado maior, na mesma proporção), sempre com os lados pares. */
export function medidasDaCopia(s: Pick<Sondagem, 'largura' | 'altura'>): { largura: number; altura: number } {
  const m = medidasNoReels(s.largura, s.altura);
  const par = (n: number) => Math.max(2, n - (n % 2));
  return { largura: par(m.largura), altura: par(m.altura) };
}

/** A taxa máxima da cópia: bem abaixo dos 25 Mbps do Instagram (com o som e a folga do contêiner). */
export const TAXA_MAXIMA_DA_COPIA = '12M';

/**
 * Os argumentos do ffmpeg para a cópia. A imagem: girada como aparece (o ffmpeg aplica a rotação sozinho), reduzida às
 * medidas da cópia; o HDR convertido para o SDR (BT.709) antes, para o Instagram não mostrar as cores lavadas. O H.264 em
 * `high`, com qualidade constante e o teto de taxa, até 60 quadros por segundo e um quadro-chave a cada 120 (o GOP
 * fechado do x264), em yuv420p. O som em AAC, 48 kHz, estéreo, 128 kbps (sem som, nenhum). Sem os metadados do celular
 * (como o lugar da gravação) e com o índice no começo do arquivo, para a Meta ler enquanto baixa.
 */
export function argumentosDaReducao(entrada: string, saida: string, s: Sondagem): string[] {
  const { largura, altura } = medidasDaCopia(s);
  const imagem = filtroDaImagem(s, largura, altura);
  const som = s.temAudio ? ['-map', '0:a:0', '-c:a', 'aac', '-b:a', '128k', '-ar', '48000', '-ac', '2'] : ['-an'];
  return [
    '-hide_banner',
    '-nostdin',
    '-v',
    'error',
    '-y',
    '-i',
    entrada,
    '-map',
    '0:v:0',
    '-vf',
    imagem,
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-profile:v',
    'high',
    '-crf',
    '21',
    '-maxrate',
    TAXA_MAXIMA_DA_COPIA,
    '-bufsize',
    '24M',
    '-fpsmax',
    '60',
    '-g',
    '120',
    '-pix_fmt',
    'yuv420p',
    '-color_primaries',
    'bt709',
    '-color_trc',
    'bt709',
    '-colorspace',
    'bt709',
    ...som,
    '-map_metadata',
    '-1',
    '-movflags',
    '+faststart',
    saida,
  ];
}

/**
 * O filtro da imagem: reduzida às medidas dadas (girada como aparece: o ffmpeg aplica a rotação sozinho) e, no HDR, as
 * cores convertidas para o SDR (BT.709) antes, para não sair lavada. Termina em yuv420p. Vale para a cópia do Instagram
 * e para os quadros que vão à IA (`video/quadros.ts`).
 */
export function filtroDaImagem(s: Pick<Sondagem, 'transferencia' | 'faixa'>, largura: number, altura: number): string {
  if (s.transferencia && TRANSFERENCIAS_DO_HDR.has(s.transferencia)) {
    return [
      // A entrada dita inteira (a transferência, as primárias, a matriz e a faixa): sem uma delas, o zscale não acha o
      // caminho entre as cores ("no path between colorspaces").
      `zscale=w=${largura}:h=${altura}:f=lanczos:tin=${s.transferencia}:pin=bt2020:min=bt2020nc:rin=${s.faixa}:t=linear:npl=100`,
      'format=gbrpf32le',
      'zscale=p=bt709',
      'tonemap=tonemap=hable:desat=0',
      'zscale=t=bt709:m=bt709:r=tv',
      'format=yuv420p',
    ].join(',');
  }
  return `scale=${largura}:${altura}:flags=lanczos,format=yuv420p`;
}

/** O ffmpeg tem até 20 minutos por vídeo (90 s de 4K em HEVC, em 2 núcleos, levam bem menos). */
export const TEMPO_DA_REDUCAO_MS = 20 * 60_000;
const TEMPO_DA_SONDAGEM_MS = 60_000;

/** Uma chamada ao ffmpeg ou ao ffprobe, com o prazo: devolve a saída padrão (trocável nos testes). */
export type ChamadaDoFf = (bin: 'ffmpeg' | 'ffprobe', args: string[], tempoMs: number) => Promise<string>;

/** A sondagem do vídeo pelo ffprobe (as medidas como aparece, o HDR, a faixa, a duração e o som). */
export async function sondarVideo(arquivo: string, chamar: ChamadaDoFf = chamarPeloRemotion): Promise<Sondagem> {
  const saida = await chamar('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', arquivo], TEMPO_DA_SONDAGEM_MS);
  let json: unknown;
  try {
    json = JSON.parse(saida);
  } catch {
    throw new VideoQueNaoReduz('o ffprobe não devolveu o JSON do vídeo');
  }
  return lerSondagem(json);
}

/** O ffmpeg e o ffprobe que vêm com o Remotion (a pasta do binário e as bibliotecas dele, pelo próprio renderer). */
export const chamarPeloRemotion: ChamadaDoFf = async (bin, args, tempoMs) => {
  const { RenderInternals } = await import('@remotion/renderer');
  try {
    const r = await RenderInternals.callFf({ bin, args, indent: false, logLevel: 'error', binariesDirectory: null, cancelSignal: undefined, options: { timeout: tempoMs } });
    return r.stdout;
  } catch (err) {
    const e = err as { stderr?: unknown; timedOut?: boolean; message?: string };
    const detalhe = typeof e.stderr === 'string' && e.stderr.trim() ? e.stderr.trim().slice(-400) : (e.message ?? String(err));
    throw new Error(`${bin}${e.timedOut ? ' passou do tempo' : ' falhou'}: ${detalhe}`);
  }
};

export class RedutorFfmpeg implements Redutor {
  constructor(
    private readonly tempoMs: number = TEMPO_DA_REDUCAO_MS,
    private readonly chamar: ChamadaDoFf = chamarPeloRemotion,
  ) {}

  private sondar(arquivo: string): Promise<Sondagem> {
    return sondarVideo(arquivo, this.chamar);
  }

  async reduzir(entrada: string, pasta: string): Promise<VideoReduzidoNoDisco> {
    let original: Sondagem;
    try {
      original = await this.sondar(entrada);
    } catch (err) {
      if (err instanceof VideoQueNaoReduz) throw err;
      throw new VideoQueNaoReduz(err instanceof Error ? err.message : String(err));
    }
    const arquivo = join(pasta, 'instagram.mp4');
    await this.chamar('ffmpeg', argumentosDaReducao(entrada, arquivo, original), this.tempoMs);
    // A cópia conferida pelo que ela é de verdade, não pelo que se pediu.
    const copia = await this.sondar(arquivo);
    const bytes = (await stat(arquivo)).size;
    if (copia.codec !== 'h264') throw new Error(`a cópia saiu em ${copia.codec || 'formato desconhecido'}`);
    if (Math.max(copia.largura, copia.altura) > BRAND_VIDEO_LIMITS.reelsLongSide) throw new Error(`a cópia saiu com ${copia.largura} × ${copia.altura}`);
    if (original.duracaoMs > 0 && Math.abs(copia.duracaoMs - original.duracaoMs) > 1_500) {
      throw new Error(`a cópia saiu com ${copia.duracaoMs} ms, e o vídeo tem ${original.duracaoMs} ms`);
    }
    if (bytes < 1 || bytes > BRAND_VIDEO_LIMITS.maxBytes || !fitsInstagramReels(copia.largura, bytes, copia.duracaoMs)) {
      throw new Error(`a cópia não cabe no Instagram (${copia.largura} px, ${bytes} bytes em ${copia.duracaoMs} ms)`);
    }
    return { arquivo, largura: copia.largura, altura: copia.altura, duracaoMs: copia.duracaoMs, bytes };
  }
}
