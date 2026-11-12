import { VIDEO_RENDER_FPS, VIDEO_RENDER_SIZES, type VideoRenderProps } from '@liame/contracts';
import { type CalculateMetadataFunction, Composition } from 'remotion';
import { carregarFontes } from './fontes';
import { Destaque } from './modelos/destaque';

// Os modelos do vídeo montado (A6 · Z15). O id de cada composição é o `template` do pedido; as medidas e a duração saem
// do pedido (o formato e os segundos). Parte 2b: "Produto em destaque"; o Combo e a Novidade vêm na parte 3.

carregarFontes();

const EXEMPLO: VideoRenderProps = {
  template: 'destaque',
  format: '9x16',
  duration_s: 10,
  media: [],
  title: 'Smash duplo na chapa',
  price_line: 'R$ 39,90',
  cta: 'Peça pelo link da bio',
  logo_url: null,
  sound: 'sem',
};

const medidas: CalculateMetadataFunction<VideoRenderProps> = ({ props }) => {
  const m = VIDEO_RENDER_SIZES[props.format];
  return { width: m.width, height: m.height, durationInFrames: props.duration_s * VIDEO_RENDER_FPS, fps: VIDEO_RENDER_FPS };
};

export function Raiz() {
  return (
    <Composition
      id="destaque"
      component={Destaque}
      fps={VIDEO_RENDER_FPS}
      width={1080}
      height={1920}
      durationInFrames={10 * VIDEO_RENDER_FPS}
      defaultProps={EXEMPLO}
      calculateMetadata={medidas}
    />
  );
}
