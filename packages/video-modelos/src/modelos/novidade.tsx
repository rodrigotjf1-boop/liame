import type { VideoRenderProps } from '@liame/contracts';
import { AbsoluteFill, OffthreadVideo, useCurrentFrame, useVideoConfig } from 'remotion';
import { COR, entrada, escala } from '../estilo';
import { Chamada, Faixa, Foto, Logo, Titulo } from '../partes';

// "Novidade da casa" (P43; D-A6-133): uma foto ou um vídeo de Fotos, a faixa "Novidade" aos 5%, o título e a chamada,
// sem linha do preço. Com o vídeo, sem zoom, o título aos 20% e a chamada aos 55% (o vídeo já se mexe), e o som do
// vídeo só quando pedido; com a foto, zoom leve (de 1 a 1,05), o título aos 12% e a chamada aos 60%. O pedido confere
// que o vídeo tem pelo menos a duração escolhida.

export function Novidade(p: VideoRenderProps) {
  const quadro = useCurrentFrame();
  const { fps, durationInFrames, width, height } = useVideoConfig();
  const s = escala(p.format, width);
  const D = p.duration_s;
  const x = quadro / durationInFrames;
  const midia = p.media[0];
  const video = midia?.kind === 'video';
  return (
    <AbsoluteFill style={{ backgroundColor: COR.tinta }}>
      {midia && video ? (
        <OffthreadVideo src={midia.url} muted={p.sound !== 'original'} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover' }} />
      ) : null}
      {midia && !video ? <Foto url={midia.url} zoom={1 + 0.05 * x} /> : null}
      <Faixa s={s} estilo={entrada(quadro, fps, 0.05 * D, s)}>
        Novidade
      </Faixa>
      <Titulo s={s} altura={height} estilo={entrada(quadro, fps, (video ? 0.2 : 0.12) * D, s)}>
        {p.title}
      </Titulo>
      <Chamada s={s} altura={height} estilo={entrada(quadro, fps, (video ? 0.55 : 0.6) * D, s)}>
        {p.cta}
      </Chamada>
      {p.logo_url ? <Logo s={s} url={p.logo_url} topo="4%" /> : null}
    </AbsoluteFill>
  );
}
