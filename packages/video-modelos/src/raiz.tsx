import { VIDEO_RENDER_FPS, VIDEO_RENDER_SIZES, type VideoRenderProps, type VideoTemplate } from '@liame/contracts';
import { type CalculateMetadataFunction, Composition } from 'remotion';
import { carregarFontes } from './fontes';
import { Combo } from './modelos/combo';
import { Destaque } from './modelos/destaque';
import { Novidade } from './modelos/novidade';

// Os modelos do vídeo montado (A6 · Z15). O id de cada composição é o `template` do pedido; as medidas e a duração saem
// do pedido (o formato e os segundos). "Produto em destaque" (parte 2b), "Combo com preço" e "Novidade da casa" (parte 3).

carregarFontes();

const EXEMPLO: Record<VideoTemplate, VideoRenderProps> = {
  destaque: { template: 'destaque', format: '9x16', duration_s: 10, media: [], title: 'Smash duplo na chapa', price_line: 'R$ 39,90', cta: 'Peça pelo link da bio', logo_url: null, sound: 'sem' },
  combo: { template: 'combo', format: '4x5', duration_s: 15, media: [], title: 'Sexta é dia de combo', price_line: 'R$ 39,90', cta: 'Já escolheu o seu?', logo_url: null, sound: 'sem' },
  novidade: { template: 'novidade', format: '1x1', duration_s: 6, media: [], title: 'Smash duplo, direto da chapa', price_line: null, cta: 'Peça pelo link da bio', logo_url: null, sound: 'sem' },
};

const medidas: CalculateMetadataFunction<VideoRenderProps> = ({ props }) => {
  const m = VIDEO_RENDER_SIZES[props.format];
  return { width: m.width, height: m.height, durationInFrames: props.duration_s * VIDEO_RENDER_FPS, fps: VIDEO_RENDER_FPS };
};

const COMPONENTES = { destaque: Destaque, combo: Combo, novidade: Novidade } as const;

export function Raiz() {
  return (
    <>
      {(Object.keys(COMPONENTES) as VideoTemplate[]).map((id) => (
        <Composition
          key={id}
          id={id}
          component={COMPONENTES[id]}
          fps={VIDEO_RENDER_FPS}
          width={1080}
          height={1920}
          durationInFrames={EXEMPLO[id].duration_s * VIDEO_RENDER_FPS}
          defaultProps={EXEMPLO[id]}
          calculateMetadata={medidas}
        />
      ))}
    </>
  );
}
