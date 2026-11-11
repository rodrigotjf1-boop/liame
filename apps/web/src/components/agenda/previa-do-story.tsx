'use client';

import type { BrandPhoto } from '@liame/contracts';
import { Icone } from '@/components/ui/icone';
import { emPeNoStory } from './story-do-post';
import { NOME_DO_CANAL } from './textos';
import { duracaoDoVideo, ehVideoPronto, videoNoTempo } from './video-do-post';

// Como o Story sai num canal (P41, aprovado pelo dono em 11/11/2026; A6, Z13, parte 2): a tela em pé, a barra de cima, o
// nome da conta e a mídia inteira (cobrindo a tela quando ela é em pé; com faixas quando não é), sem texto. O vídeo
// mostra a capa guardada com ele (ou o quadro do começo) e a duração.

type Props = {
  canal: string;
  conta: string | null;
  midia: BrandPhoto;
};

export function PreviaDoStory({ canal, conta, midia }: Props) {
  const video = ehVideoPronto(midia) ? midia : null;
  const emPe = emPeNoStory(midia);
  const alt = video ? `Vídeo: ${video.description || video.product || 'sem produto'}, ${duracaoDoVideo(video)}` : midia.description || `Foto do produto: ${midia.product ?? 'sem produto'}`;
  const nome = conta ?? (canal === 'instagram' ? 'Instagram da marca' : 'Página da marca');
  return (
    <div className="po-previa po-story-previa" role="group" aria-label={`Como sai: ${NOME_DO_CANAL[canal] ?? canal}, como Story`}>
      <div className={`po-story${emPe ? '' : ' po-story--faixas'}`}>
        <span className="po-story-barra" aria-hidden="true">
          <span />
        </span>
        <span className="po-story-cab">
          <span className="po-avatar" aria-hidden="true">
            {nome.replace('@', '').slice(0, 2).toUpperCase()}
          </span>
          <b>{nome}</b>
          <span>agora</span>
        </span>
        {video && !video.video.has_cover ? (
          <video src={videoNoTempo(video.url, 100)} muted playsInline preload="metadata" aria-label={alt} />
        ) : (
          <img src={video ? video.thumbnail_url : midia.url} alt={alt} referrerPolicy="no-referrer" />
        )}
        {video && (
          <>
            <span className="po-story-tocar" aria-hidden="true">
              <Icone nome="play" />
            </span>
            <span className="po-story-dur" aria-hidden="true">
              {duracaoDoVideo(video)}
            </span>
          </>
        )}
      </div>
    </div>
  );
}
