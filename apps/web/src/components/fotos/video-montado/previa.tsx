'use client';

import { VIDEO_TEMPLATE_RULES, type VideoFormat, type VideoTemplate } from '@liame/contracts';
import { useEffect, useRef, useState } from 'react';
import { Icone } from '@/components/ui/icone';
import { duracaoTxt, FORMATOS, rotuloDaPrevia } from './textos';

// A prévia do vídeo montado (P43): o quadro que simula o modelo com as fotos ou o vídeo escolhidos, os textos e a logo,
// no tempo do modelo (os mesmos instantes do `packages/video-modelos`). O tempo anda por requestAnimationFrame; com o
// movimento reduzido, o quadro fica parado num momento em que tudo já entrou. É aproximada: o vídeo final sai igual ao
// modelo.

export type MidiaDaPrevia = { id: string; url: string; video: boolean; produto: string };

type Props = {
  modelo: VideoTemplate;
  formato: VideoFormat;
  dur: number;
  midias: MidiaDaPrevia[];
  titulo: string;
  preco: string;
  chamada: string;
  /** As iniciais da marca no selo da logo, quando a pessoa pede a logo. */
  logo: string | null;
  somOriginal: boolean;
};

const reduzido = () => typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const mmss = (s: number) => `0:${String(Math.floor(s)).padStart(2, '0')}`;

/** O que aparece no instante `t` (segundos): a cena, o zoom e os textos que já entraram. */
export function quadroNoTempo(p: Pick<Props, 'modelo' | 'dur'> & { n: number; video: boolean }, t: number) {
  const D = p.dur;
  const x = Math.min(1, t / D);
  if (p.modelo === 'combo') {
    const fim = x >= 0.7;
    const n = Math.max(p.n, 1);
    const k = fim ? n - 1 : Math.min(n - 1, Math.floor((x / 0.7) * n));
    const pedaco = (0.7 * D) / n;
    const ini = k * pedaco;
    return { cena: k, zoom: 1 + 0.06 * Math.min(1, Math.max(0, (t - ini) / pedaco)), fim, faixa: false, titulo: x >= 0.05 && !fim, preco: fim, chamada: x >= 0.8, x };
  }
  const zoom = p.modelo === 'destaque' ? 0.12 : p.video ? 0 : 0.05;
  return { cena: 0, zoom: 1 + zoom * x, fim: false, faixa: x >= 0.05, titulo: x >= (p.video ? 0.2 : 0.12), preco: x >= 0.35, chamada: x >= (p.video ? 0.55 : 0.6), x };
}

export function PreviaDoVideo(p: Props) {
  const parado = reduzido();
  const [tocando, setTocando] = useState(!parado);
  const [t, setT] = useState(parado ? 0.86 * p.dur : 0);
  const inicio = useRef(0);
  const regra = VIDEO_TEMPLATE_RULES[p.modelo];
  const comVideo = p.midias.some((m) => m.video);

  // A prévia toca em volta; a duração que muda recomeça do zero.
  useEffect(() => {
    if (parado) {
      setT(0.86 * p.dur);
      return;
    }
    if (!tocando) return;
    let raf = 0;
    inicio.current = performance.now() - (t % p.dur) * 1000;
    const passo = (agora: number) => {
      setT(((agora - inicio.current) / 1000) % p.dur);
      raf = requestAnimationFrame(passo);
    };
    raf = requestAnimationFrame(passo);
    return () => cancelAnimationFrame(raf);
    // `t` fica de fora: é o próprio relógio; o laço recomeça só quando toca, para ou muda a duração.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tocando, p.dur, parado]);

  const q = quadroNoTempo({ modelo: p.modelo, dur: p.dur, n: p.midias.length, video: comVideo }, t);
  const fmt = FORMATOS[p.formato];
  const vis = (sim: boolean) => (sim ? ' vm-vis' : '');
  return (
    <div className="vm-lado">
      <p className="rotulo-marca">Prévia</p>
      <div
        className={`vm-quadro vm-quadro--${p.formato} vm-quadro--${p.modelo}${q.fim ? ' vm-quadro--combo-fim' : ''}`}
        role="img"
        aria-label={rotuloDaPrevia({ modelo: p.modelo, formato: p.formato, dur: p.dur, midias: p.midias, titulo: p.titulo, preco: p.preco, chamada: p.chamada, logo: Boolean(p.logo), somOriginal: p.somOriginal })}
      >
        {p.midias.length ? (
          p.midias.map((m, i) =>
            m.video ? (
              <video key={m.id} className={`vm-cena${vis(i === q.cena)}`} src={m.url} muted autoPlay={!parado} loop playsInline aria-hidden="true" />
            ) : (
              <img key={m.id} className={`vm-cena${vis(i === q.cena)}`} src={m.url} alt="" referrerPolicy="no-referrer" style={i === q.cena && q.zoom !== 1 ? { transform: `scale(${q.zoom.toFixed(4)})` } : undefined} />
            ),
          )
        ) : (
          <span className="vm-vazio">
            <Icone nome="image" />
            <span>Escolha {regra.min > 1 ? `de ${regra.min} a ${regra.max} fotos` : regra.video ? 'uma foto ou um vídeo' : 'uma foto'} para ver a prévia</span>
          </span>
        )}
        {regra.video && <span className={`vm-v vm-v-faixa${vis(q.faixa)}`} aria-hidden="true">Novidade</span>}
        {p.titulo && <span className={`vm-v vm-v-titulo${vis(q.titulo)}`} aria-hidden="true">{p.titulo}</span>}
        {regra.price && p.preco && <span className={`vm-v vm-v-preco${vis(q.preco)}`} aria-hidden="true">{p.preco}</span>}
        {p.chamada && <span className={`vm-v vm-v-chamada${vis(q.chamada)}`} aria-hidden="true">{p.chamada}</span>}
        {p.logo && (
          <span className="vm-logo" aria-hidden="true">
            {p.logo}
          </span>
        )}
        {p.somOriginal && (
          <span className="vm-som" aria-hidden="true">
            <Icone nome="volume" pequeno />
          </span>
        )}
        <span className="vm-barra" aria-hidden="true">
          <span style={{ width: `${(q.x * 100).toFixed(1)}%` }} />
        </span>
      </div>
      {parado ? (
        <p className="campo-dica">Movimento reduzido: a prévia mostra um quadro parado.</p>
      ) : (
        <div className="vm-controles">
          <button className="btn btn--sm" type="button" aria-pressed={tocando} onClick={() => setTocando((v) => !v)}>
            <Icone nome={tocando ? 'pause' : 'play'} />
            {tocando ? 'Pausar a prévia' : 'Tocar a prévia'}
          </button>
          <span className="vm-tempo">
            {mmss(t)} / {mmss(p.dur)}
          </span>
        </div>
      )}
      <p className="campo-dica">A prévia é aproximada: o vídeo final sai igual ao modelo.</p>
      <p className="campo-dica">
        {fmt.nome} · {duracaoTxt(p.dur)} · {fmt.w.toLocaleString('pt-BR')} × {fmt.h.toLocaleString('pt-BR')} px · {p.somOriginal ? 'com o som do vídeo' : 'sem música'}
      </p>
    </div>
  );
}
