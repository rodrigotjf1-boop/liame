import type { VideoRenderProps } from '@liame/contracts';
import { AbsoluteFill, useCurrentFrame, useVideoConfig } from 'remotion';
import { COR, entrada, entradaESaida, escala } from '../estilo';
import { Chamada, Foto, Logo, Preco, Titulo } from '../partes';

// "Combo com preço" (P43; D-A6-133): de 2 a 4 fotos, uma de cada vez nos primeiros 70% do vídeo, cada uma com zoom lento
// (de 1 a 1,06 no tempo dela); nos 30% finais, a última foto escurece e a linha do preço vem ao centro, maior. O título
// entra aos 5% e sai quando o preço chega; a chamada entra aos 80%. As medidas e os tempos são os do protótipo.

const PARTE_DAS_FOTOS = 0.7;

export function Combo(p: VideoRenderProps) {
  const quadro = useCurrentFrame();
  const { fps, durationInFrames, width, height } = useVideoConfig();
  const s = escala(p.format, width);
  const D = p.duration_s;
  const t = quadro / fps;
  const x = quadro / durationInFrames;
  const n = Math.max(p.media.length, 1);
  const fim = x >= PARTE_DAS_FOTOS;
  const pedaco = (PARTE_DAS_FOTOS * D) / n;
  const k = fim ? n - 1 : Math.min(n - 1, Math.floor((x / PARTE_DAS_FOTOS) * n));
  const inicioDaFoto = k * pedaco;
  const zoom = 1 + 0.06 * Math.min(1, Math.max(0, (t - inicioDaFoto) / pedaco));
  const foto = p.media[k];
  return (
    <AbsoluteFill style={{ backgroundColor: COR.tinta }}>
      {foto ? <Foto url={foto.url} zoom={zoom} extra={fim ? { filter: 'brightness(0.55)' } : undefined} /> : null}
      <Titulo s={s} altura={height} estilo={entradaESaida(quadro, fps, 0.05 * D, PARTE_DAS_FOTOS * D, s)}>
        {p.title}
      </Titulo>
      {p.price_line ? (
        <Preco s={s} baixo="40%" centro estilo={entrada(quadro, fps, PARTE_DAS_FOTOS * D, s)}>
          {p.price_line}
        </Preco>
      ) : null}
      <Chamada s={s} altura={height} estilo={entrada(quadro, fps, 0.8 * D, s)}>
        {p.cta}
      </Chamada>
      {p.logo_url ? <Logo s={s} url={p.logo_url} topo="3%" /> : null}
    </AbsoluteFill>
  );
}
