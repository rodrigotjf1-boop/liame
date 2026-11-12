import type { CSSProperties, ReactNode } from 'react';
import { Img } from 'remotion';
import { COR, FONTE } from './estilo';

// As partes que os modelos dividem, com as medidas do protótipo (P43) já multiplicadas pela escala `s`.

type Base = { s: number; estilo: { opacity: number; transform: string } };

/** O título: a faixa clara em cima, centralizada. */
export function Titulo({ s, estilo, altura, children }: Base & { altura: number; children: ReactNode }) {
  return (
    <div
      style={{
        position: 'absolute',
        left: '7%',
        right: '7%',
        top: altura * 0.04 + 40 * s,
        padding: `${6 * s}px ${10 * s}px`,
        borderRadius: 8 * s,
        background: COR.claro,
        color: COR.tinta,
        fontFamily: FONTE.texto,
        fontSize: 16 * s,
        fontWeight: 700,
        lineHeight: 1.2,
        textAlign: 'center',
        overflowWrap: 'anywhere',
        ...estilo,
      }}
    >
      {children}
    </div>
  );
}

/** A linha do preço: a pílula âmbar, com a fonte dos números. */
export function Preco({ s, estilo, baixo, children }: Base & { baixo: string; children: ReactNode }) {
  return (
    <div
      style={{
        position: 'absolute',
        left: '7%',
        bottom: baixo,
        maxWidth: '86%',
        padding: `${4 * s}px ${12 * s}px`,
        borderRadius: 999 * s,
        background: COR.preco,
        color: COR.tinta,
        fontFamily: FONTE.numero,
        fontSize: 18 * s,
        fontWeight: 700,
        lineHeight: 1.3,
        overflowWrap: 'anywhere',
        ...estilo,
      }}
    >
      {children}
    </div>
  );
}

/** A chamada: a faixa escura embaixo, centralizada. */
export function Chamada({ s, estilo, altura, children }: Base & { altura: number; children: ReactNode }) {
  return (
    <div
      style={{
        position: 'absolute',
        left: '7%',
        right: '7%',
        bottom: Math.max(altura * 0.08, 36 * s),
        padding: `${6 * s}px ${10 * s}px`,
        borderRadius: 8 * s,
        background: COR.tinta,
        color: COR.claro,
        fontFamily: FONTE.texto,
        fontSize: 13 * s,
        fontWeight: 600,
        lineHeight: 1.25,
        textAlign: 'center',
        overflowWrap: 'anywhere',
        ...estilo,
      }}
    >
      {children}
    </div>
  );
}

/** A logo de Minha marca no selo redondo claro, no canto de cima. */
export function Logo({ s, url, topo }: { s: number; url: string; topo: string }) {
  const lado = 34 * s;
  return (
    <div
      style={{
        position: 'absolute',
        right: '6%',
        top: topo,
        width: lado,
        height: lado,
        borderRadius: '50%',
        background: COR.claro,
        overflow: 'hidden',
        display: 'grid',
        placeItems: 'center',
      }}
    >
      <Img src={url} style={{ width: '78%', height: '78%', objectFit: 'contain' }} />
    </div>
  );
}

/** A foto inteira no quadro (cobrindo), com o zoom do modelo. */
export function Foto({ url, zoom, extra }: { url: string; zoom: number; extra?: CSSProperties }) {
  return (
    <Img
      src={url}
      style={{
        position: 'absolute',
        inset: 0,
        width: '100%',
        height: '100%',
        objectFit: 'cover',
        transformOrigin: '50% 55%',
        transform: `scale(${zoom.toFixed(4)})`,
        ...extra,
      }}
    />
  );
}
