'use client';

import { Icone } from '@/components/ui/icone';
import { NOME_DO_CANAL } from './textos';
import { type CapaNaTela, comoSaiNaPagina, duracaoDoVideo, type VideoDasFotos, videoDeitado, videoNoTempo } from './video-do-post';

// Como o post com vídeo sai num canal (P37, parte B; A6, Z10, parte 4a): no Instagram, o Reels em pé, com a capa, o selo,
// a duração e a legenda por cima (o vídeo deitado aparece com faixas); na Página, o cabeçalho, o texto e o vídeo, como
// Reels (em pé) ou vídeo comum (deitado). A capa é a escolhida no novo post: a imagem pronta ou o quadro do próprio
// vídeo, que o navegador mostra pelo tempo (sem ler os bytes).

type Props = {
  canal: string;
  conta: string | null;
  texto: string;
  video: VideoDasFotos;
  capa: CapaNaTela;
  link?: string | null;
};

function Capa({ capa, alt }: { capa: CapaNaTela; alt: string }) {
  if ('imagem' in capa) return <img src={capa.imagem} alt={alt} referrerPolicy="no-referrer" />;
  return <video src={videoNoTempo(capa.video, capa.tempoMs)} muted playsInline preload="metadata" aria-label={alt} />;
}

export function PreviaDoReels({ canal, conta, texto, video, capa, link }: Props) {
  const deitado = videoDeitado(video);
  const alt = `Capa do vídeo: ${video.description || video.product || 'sem produto'}, ${duracaoDoVideo(video)}`;
  const selo = (rotulo: string) => (
    <>
      <span className="po-reels-selo">
        <Icone nome="video" pequeno />
        {rotulo}
      </span>
      <span className="po-reels-dur" aria-hidden="true">
        {duracaoDoVideo(video)}
      </span>
      <span className="po-reels-tocar" aria-hidden="true">
        <Icone nome="play" />
      </span>
    </>
  );
  if (canal === 'instagram') {
    return (
      <div className="po-previa" role="group" aria-label="Como sai: Instagram, como Reels">
        <div className="po-reels-caixa">
          <div className={`po-reels${deitado ? ' po-reels--faixas' : ''}`}>
            <Capa capa={capa} alt={alt} />
            {selo('Reels')}
            <div className="po-reels-legenda">
              <p className="po-texto">
                <b>{conta ?? ''}</b> {texto}
              </p>
            </div>
          </div>
        </div>
      </div>
    );
  }
  const reels = comoSaiNaPagina(video) === 'reels';
  const comLink = canal === 'facebook' && link && texto.endsWith(link);
  return (
    <div className="po-previa" role="group" aria-label={`Como sai: ${NOME_DO_CANAL[canal] ?? canal}, como ${reels ? 'Reels' : 'vídeo'}`}>
      <div className="po-previa-cab">
        <span className="po-avatar" aria-hidden="true">
          {(conta ?? '?').replace('@', '').slice(0, 2).toUpperCase()}
        </span>
        <span>
          <b>{conta ?? 'Conta desligada da marca'}</b>
          <br />
          <span>na Página</span>
        </span>
      </div>
      {comLink ? (
        <p className="po-texto">
          {texto.slice(0, texto.length - link.length).trimEnd()}
          {'\n\n'}
          <span className="po-link">{link}</span>
        </p>
      ) : (
        <p className="po-texto">{texto}</p>
      )}
      <div className="po-reels-caixa">
        <div className={`po-reels${reels ? '' : ' po-reels--deitado'}`}>
          <Capa capa={capa} alt={alt} />
          {selo(reels ? 'Reels' : 'Vídeo')}
        </div>
      </div>
    </div>
  );
}
