'use client';

import type { BrandPhoto } from '@liame/contracts';
import { useRef, useState } from 'react';
import { Icone } from '@/components/ui/icone';
import { disparar } from '@/lib/disparar';
import { deitado, duracaoPorExtenso, nomeDoProduto } from './textos';

// O vídeo na gaveta (A6 · Z10, parte 2; P37): em pé (9:16) ou deitado (16:9), com a capa enquanto não toca, o botão
// "Assistir ao vídeo" por cima e a barra de quanto já tocou. Nada toca sozinho; o som vem com o clique.

type Props = {
  foto: BrandPhoto;
  /** O vídeo não carregou (o endereço de 5 minutos venceu, ou o navegador não toca este formato). */
  aoFalhar: () => void;
};

export function TelaDoVideo({ foto, aoFalhar }: Props) {
  const ref = useRef<HTMLVideoElement>(null);
  const [tocando, setTocando] = useState(false);
  const [pct, setPct] = useState(0);
  const [falhou, setFalhou] = useState(false);
  const duracao = foto.video ? duracaoPorExtenso(foto.video.duration_ms) : '';

  function alternar() {
    const v = ref.current;
    if (!v) return;
    if (v.paused) disparar(v.play().catch(() => setTocando(false)));
    else v.pause();
  }

  return (
    <div className="ft-tela-caixa">
      <div className={`ft-video${deitado(foto) ? ' ft-video--deitado' : ''}`}>
        <video
          ref={ref}
          src={foto.url}
          poster={foto.video?.has_cover ? foto.thumbnail_url : undefined}
          preload="metadata"
          playsInline
          aria-label={foto.description || `Vídeo do produto: ${nomeDoProduto(foto.product)}`}
          onPlay={() => setTocando(true)}
          onPause={() => setTocando(false)}
          onEnded={() => setTocando(false)}
          onTimeUpdate={(e) => {
            const v = e.currentTarget;
            setPct(v.duration ? Math.min(100, Math.round((v.currentTime / v.duration) * 100)) : 0);
          }}
          onError={() => {
            setFalhou(true);
            aoFalhar();
          }}
        />
        <button className="ft-tocar" type="button" data-ft-tocar aria-pressed={tocando} aria-label={tocando ? 'Pausar o vídeo' : `Assistir ao vídeo (${duracao})`} onClick={alternar}>
          <Icone nome={tocando ? 'pause' : 'play'} />
        </button>
        <span className="ft-progresso" aria-hidden="true">
          <span style={{ width: `${pct}%` }} />
        </span>
      </div>
      {falhou && (
        <p className="ft-nota">
          <Icone nome="info" pequeno />
          <span>Não deu para tocar o vídeo neste navegador. Ele continua guardado como a loja gravou.</span>
        </p>
      )}
    </div>
  );
}
