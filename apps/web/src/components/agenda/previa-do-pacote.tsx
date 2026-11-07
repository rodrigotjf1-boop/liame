'use client';

import type { BrandPhoto } from '@liame/contracts';
import { Icone } from '@/components/ui/icone';
import { NOME_DO_CANAL } from './textos';
import { duracaoDoVideo, ehVideoPronto } from './video-do-post';

// O pacote de uma rede (P22): a foto inteira e o texto, sem imitar a tela da rede (o Liame não publica nela; quem
// publica é a pessoa). No novo post e na gaveta do pacote. O pacote com vídeo (A6, Z10, parte 4c): o próprio vídeo, que
// a pessoa pode assistir antes de baixar, com a capa guardada parada antes de tocar.

type Props = {
  canal: string;
  texto: string;
  /** A foto do pacote, ou o vídeo (das Fotos e vídeos). */
  foto: BrandPhoto | null;
  /** O que dizer no lugar da foto, quando não há foto para mostrar. */
  semFoto?: string;
  aoFalharImagem?: () => void;
};

export function PreviaDoPacote({ canal, texto, foto, semFoto, aoFalharImagem }: Props) {
  const nome = NOME_DO_CANAL[canal] ?? canal;
  const video = foto && ehVideoPronto(foto) ? foto : null;
  return (
    <div className="po-previa" role="group" aria-label={`O pacote: ${nome}`}>
      <div className="po-previa-cab">
        <span className="po-avatar" aria-hidden="true">
          <Icone nome="send" pequeno />
        </span>
        <span>
          <b>Pacote para o {nome}</b>
          <br />
          <span>você publica</span>
        </span>
      </div>
      {video ? (
        <div className="po-foto po-foto--inteira">
          <video
            src={video.url}
            poster={video.video.has_cover ? video.thumbnail_url : undefined}
            controls
            playsInline
            preload="metadata"
            aria-label={`Vídeo do pacote: ${video.description || video.product || 'sem produto'}, ${duracaoDoVideo(video)}`}
            onError={aoFalharImagem}
          />
        </div>
      ) : foto ? (
        <div className="po-foto po-foto--inteira">
          <img src={foto.url} alt={foto.description || `Foto do produto: ${foto.product ?? 'sem produto'}`} referrerPolicy="no-referrer" onError={aoFalharImagem} />
        </div>
      ) : (
        semFoto && (
          <p className="po-nota">
            <Icone nome="image" pequeno />
            <span>{semFoto}</span>
          </p>
        )
      )}
      <p className="po-texto">{texto}</p>
    </div>
  );
}
