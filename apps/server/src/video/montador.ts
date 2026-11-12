import { join } from 'node:path';
import type { VideoRenderProps } from '@liame/contracts';

// A montagem do vídeo (A6 · Z15, parte 2b; D-A6-139): o Remotion abre o modelo empacotado (`packages/video-modelos`,
// pasta `build/`) no Chrome Headless Shell e grava o MP4 (H.264) e a capa (um quadro em JPEG). Só o serviço
// `liame-render` usa isto: o renderer é carregado na hora (a API e o worker nunca o carregam).

export const MONTADOR = Symbol('MONTADOR');

/** O vídeo montado numa pasta temporária, com a capa e as medidas que vão para Fotos. */
export type VideoMontadoNoDisco = {
  arquivo: string;
  capa: Buffer;
  largura: number;
  altura: number;
  duracaoMs: number;
  temAudio: boolean;
};

export interface Montador {
  /** Monta o vídeo em `pasta`; `aoAndar` recebe o andamento de 0 a 1. */
  montar(props: VideoRenderProps, pasta: string, aoAndar: (andamento: number) => void): Promise<VideoMontadoNoDisco>;
}

/** O quadro da capa: 86% do vídeo, onde a prévia do P43 para com tudo já na tela. */
export const QUADRO_DA_CAPA = 0.86;

/** O tempo máximo de um quadro (o padrão do Remotion é 30 s): a foto vem do armazenamento, perto da VPS. */
const ESPERA_DO_QUADRO_MS = 60_000;

export type ConfigDoMontador = {
  /** A pasta do modelo empacotado (`LIAME_VIDEO_MODELOS`). */
  modelos: string;
  /** Quantas abas do navegador montam ao mesmo tempo (o serviço tem 2 núcleos; D-A6-139). */
  concorrencia: number;
  /** A licença do Remotion: a grátis (`free-license`) enquanto a DMS tiver até 3 pessoas (D-A6-137). */
  licenca: string;
};

/** A configuração pelo ambiente do serviço `liame-render`. */
export function configDoMontador(env: NodeJS.ProcessEnv = process.env): ConfigDoMontador {
  const concorrencia = Number(env.LIAME_RENDER_CONCORRENCIA ?? 2);
  return {
    modelos: env.LIAME_VIDEO_MODELOS || join(process.cwd(), 'video-modelos'),
    concorrencia: Number.isInteger(concorrencia) && concorrencia >= 1 && concorrencia <= 4 ? concorrencia : 2,
    licenca: env.REMOTION_LICENSE_KEY || 'free-license',
  };
}

export class MontadorRemotion implements Montador {
  constructor(private readonly config: ConfigDoMontador) {}

  async montar(props: VideoRenderProps, pasta: string, aoAndar: (andamento: number) => void): Promise<VideoMontadoNoDisco> {
    const r = await import('@remotion/renderer');
    const serveUrl = this.config.modelos;
    const composition = await r.selectComposition({ serveUrl, id: props.template, inputProps: props, logLevel: 'warn', timeoutInMilliseconds: ESPERA_DO_QUADRO_MS });
    const arquivo = join(pasta, 'video.mp4');
    await r.renderMedia({
      composition,
      serveUrl,
      inputProps: props,
      codec: 'h264',
      outputLocation: arquivo,
      concurrency: this.config.concorrencia,
      muted: props.sound === 'sem',
      timeoutInMilliseconds: ESPERA_DO_QUADRO_MS,
      licenseKey: this.config.licenca,
      logLevel: 'warn',
      onProgress: ({ progress }) => aoAndar(progress),
    });
    const quadro = Math.min(composition.durationInFrames - 1, Math.round(QUADRO_DA_CAPA * composition.durationInFrames));
    const capa = await r.renderStill({
      composition,
      serveUrl,
      inputProps: props,
      frame: quadro,
      imageFormat: 'jpeg',
      jpegQuality: 90,
      timeoutInMilliseconds: ESPERA_DO_QUADRO_MS,
      licenseKey: this.config.licenca,
      logLevel: 'warn',
    });
    if (!capa.buffer) throw new Error('o Remotion não devolveu a capa');
    return {
      arquivo,
      capa: Buffer.from(capa.buffer),
      largura: composition.width,
      altura: composition.height,
      duracaoMs: Math.round((composition.durationInFrames / composition.fps) * 1000),
      temAudio: props.sound === 'original',
    };
  }
}
