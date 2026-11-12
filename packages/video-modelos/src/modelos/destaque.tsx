import type { VideoRenderProps } from '@liame/contracts';
import { AbsoluteFill, useCurrentFrame, useVideoConfig } from 'remotion';
import { COR, entrada, escala } from '../estilo';
import { Chamada, Foto, Logo, Preco, Titulo } from '../partes';

// "Produto em destaque" (P43; D-A6-133): uma foto, com zoom lento (de 1 a 1,12 no vídeo inteiro), o título, a linha do
// preço e a chamada entrando como no protótipo (aos 12%, 35% e 60% da duração), e a logo no canto quando pedida.

export function Destaque(p: VideoRenderProps) {
  const quadro = useCurrentFrame();
  const { fps, durationInFrames, width, height } = useVideoConfig();
  const s = escala(p.format, width);
  const x = quadro / durationInFrames;
  const D = p.duration_s;
  const foto = p.media[0];
  return (
    <AbsoluteFill style={{ backgroundColor: COR.tinta }}>
      {foto ? <Foto url={foto.url} zoom={1 + 0.12 * x} /> : null}
      <Titulo s={s} altura={height} estilo={entrada(quadro, fps, 0.12 * D, s)}>
        {p.title}
      </Titulo>
      {p.price_line ? (
        <Preco s={s} baixo={p.format === '1x1' ? '27%' : '22%'} estilo={entrada(quadro, fps, 0.35 * D, s)}>
          {p.price_line}
        </Preco>
      ) : null}
      <Chamada s={s} altura={height} estilo={entrada(quadro, fps, 0.6 * D, s)}>
        {p.cta}
      </Chamada>
      {p.logo_url ? <Logo s={s} url={p.logo_url} topo="3%" /> : null}
    </AbsoluteFill>
  );
}
