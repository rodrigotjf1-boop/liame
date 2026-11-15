'use client';

import type { BrandPhoto } from '@liame/contracts';
import { Icone } from '@/components/ui/icone';
import { duracaoCurta, ehVideo, temCapa } from './campanha-nova-textos';

// A foto ou o vídeo de um criativo do teste (R8, D-RG-96): as fotos e os vídeos com capa de Fotos, como na campanha nova.
// O vídeo sem capa não aparece: o anúncio usa a capa que o vídeo tem lá.

type Props = {
  id: string;
  letra: 'A' | 'B';
  midias: BrandPhoto[] | null;
  marcada: string | null;
  aoMarcar: (id: string) => void;
  desligado: boolean;
  erro?: string;
};

export function MidiasDoCriativo({ id, letra, midias, marcada, aoMarcar, desligado, erro }: Props) {
  const lista = (midias ?? []).filter(temCapa);
  return (
    <div className="campo" role="group" aria-labelledby={`${id}-t`} aria-describedby={erro ? `${id}-d ${id}-e` : `${id}-d`}>
      <span className="rotulo" id={`${id}-t`}>
        A foto ou o vídeo do criativo {letra}
      </span>
      <span className="campo-dica" id={`${id}-d`}>
        De Fotos, como na campanha nova.
      </span>
      {lista.length ? (
        <ul className="po-fotos" aria-label={`Fotos e vídeos para o criativo ${letra}`}>
          {lista.map((m, i) => (
            <li key={m.id}>
              <button
                className="po-foto-op cn-op"
                type="button"
                data-campo={i === 0 ? `midia${letra}` : undefined}
                aria-pressed={marcada === m.id}
                aria-label={`${m.product ?? 'Sem produto'}${m.description ? `: ${m.description}` : ''}${ehVideo(m) && m.video ? `, vídeo de ${duracaoCurta(m.video.duration_ms)}` : ''}`}
                onClick={() => aoMarcar(m.id)}
                disabled={desligado}
              >
                <img src={m.thumbnail_url} alt="" referrerPolicy="no-referrer" />
                {ehVideo(m) && m.video && (
                  <span className="po-video-dur" aria-hidden="true">
                    {duracaoCurta(m.video.duration_ms)}
                  </span>
                )}
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="pd-nota">
          <Icone nome="camera" pequeno />
          <span>{midias === null ? 'As Fotos não abriram agora, ou não estão ligadas para esta empresa: o teste precisa de uma foto ou de um vídeo de lá.' : 'Nenhuma foto ou vídeo pronto em Fotos desta marca. Envie em Fotos.'}</span>
        </p>
      )}
      {erro && (
        <p className="campo-erro" id={`${id}-e`}>
          {erro}
        </p>
      )}
    </div>
  );
}
