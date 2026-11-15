import type { VideoRenderProps } from '@liame/contracts';
import { AbsoluteFill, OffthreadVideo, Sequence, useCurrentFrame, useVideoConfig } from 'remotion';
import { COR, entrada, escala } from '../estilo';
import { Legenda, Logo } from '../partes';

// "Os melhores momentos" (P46; A6 · Z16, D-A6-150 a D-A6-154): os cortes escolhidos pelo Social media (ou mudados pela
// pessoa), um depois do outro, cada um com a sua legenda embaixo, a logo no canto se pedida e sem título nem chamada.
// O vídeo dura a soma dos cortes (o pedido confere o total perto da duração escolhida); o som de cada corte só quando
// pedido. Sem zoom: o vídeo já se mexe.

type Corte = NonNullable<VideoRenderProps['cuts']>[number];

/** Em que quadro do vídeo de origem o corte começa (o `trimBefore` do Remotion conta em quadros do vídeo montado). */
export function quadroDoComeco(c: Corte, fps: number): number {
  return Math.round((c.start_ms * fps) / 1000);
}

/** Quantos quadros o corte ocupa no vídeo montado (pelo menos 1). */
export function quadrosDoCorte(c: Corte, fps: number): number {
  return Math.max(1, Math.round(((c.end_ms - c.start_ms) * fps) / 1000));
}

/** Quantos quadros os cortes ocupam juntos: a duração do vídeo montado. */
export function quadrosDosCortes(cortes: readonly Corte[], fps: number): number {
  return cortes.reduce((soma, c) => soma + quadrosDoCorte(c, fps), 0);
}

/** A legenda entra 0,15 s depois do começo do corte (o corte é curto: de 1,5 a 8 s). */
const LEGENDA_ENTRA_S = 0.15;

function UmCorte({ corte, url, mudo, s, altura }: { corte: Corte; url: string; mudo: boolean; s: number; altura: number }) {
  const quadro = useCurrentFrame();
  const { fps } = useVideoConfig();
  return (
    <AbsoluteFill>
      <OffthreadVideo
        src={url}
        muted={mudo}
        trimBefore={quadroDoComeco(corte, fps)}
        style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover' }}
      />
      <Legenda s={s} altura={altura} estilo={entrada(quadro, fps, LEGENDA_ENTRA_S, s)}>
        {corte.caption}
      </Legenda>
    </AbsoluteFill>
  );
}

export function Momentos(p: VideoRenderProps) {
  const { fps, width, height } = useVideoConfig();
  const s = escala(p.format, width);
  const cortes = p.cuts ?? [];
  let de = 0;
  return (
    <AbsoluteFill style={{ backgroundColor: COR.tinta }}>
      {cortes.map((corte, i) => {
        const midia = p.media[corte.media];
        const dura = quadrosDoCorte(corte, fps);
        const desde = de;
        de += dura;
        if (!midia || midia.kind !== 'video') return null;
        return (
          <Sequence key={i} from={desde} durationInFrames={dura} name={`Corte ${i + 1}`}>
            <UmCorte corte={corte} url={midia.url} mudo={p.sound !== 'original'} s={s} altura={height} />
          </Sequence>
        );
      })}
      {p.logo_url ? <Logo s={s} url={p.logo_url} topo="4%" /> : null}
    </AbsoluteFill>
  );
}
