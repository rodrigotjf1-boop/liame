import type { BrandPhoto } from '@liame/contracts';
import { Icone } from '@/components/ui/icone';
import { dia } from '@/lib/formato';
import { deitado, duracaoCurta, ehVideo, nomeDoProduto, rotuloDoCartao, rotuloDoVideo } from './textos';

// Uma foto na grade (P20): a foto em quadrado (o recorte é só da vista; a foto guardada é inteira), o produto, a
// orientação, o dia e, quando for o caso, o aviso de que é pequena para o Instagram. Abre a gaveta da foto.
// O vídeo (A6 · Z10, parte 2; P37): a capa (um quadro do vídeo; antes dela, o primeiro quadro do próprio arquivo), o
// botão de tocar e a duração no canto, o selo "Vídeo", em pé ou deitado e, deitado, o aviso para o Reels.

type Props = {
  foto: BrandPhoto;
  agora: Date;
  aberta: boolean;
  aoAbrir: (botao: HTMLButtonElement) => void;
  /** O endereço assinado venceu (a imagem não carregou): a tela pede a lista de novo. */
  aoFalhar: () => void;
};

function MidiaDoVideo({ foto, aoFalhar }: { foto: BrandPhoto; aoFalhar: () => void }) {
  return (
    <span className="ft-img ft-midia">
      {foto.video?.has_cover ? (
        <img src={foto.thumbnail_url} alt="" decoding="async" loading="lazy" referrerPolicy="no-referrer" onError={aoFalhar} />
      ) : (
        // Antes da capa: o primeiro quadro do próprio vídeo (o `#t` pede ao navegador o quadro, sem tocar).
        <video src={`${foto.url}#t=0.1`} preload="metadata" muted playsInline tabIndex={-1} aria-hidden="true" onError={aoFalhar} />
      )}
      <span className="ft-play" aria-hidden="true">
        <Icone nome="play" />
      </span>
      {foto.video && (
        <span className="ft-dur" aria-hidden="true">
          {duracaoCurta(foto.video.duration_ms)}
        </span>
      )}
    </span>
  );
}

export function CartaoFoto({ foto, agora, aberta, aoAbrir, aoFalhar }: Props) {
  const video = ehVideo(foto);
  const ehDeitado = video && deitado(foto);
  return (
    <li>
      <button
        className="ft-card"
        type="button"
        data-ft-foto={foto.id}
        data-ft-video={video ? 'sim' : undefined}
        aria-haspopup="dialog"
        aria-expanded={aberta}
        aria-label={video ? rotuloDoVideo(foto, agora) : rotuloDoCartao(foto, agora)}
        onClick={(e) => aoAbrir(e.currentTarget)}
      >
        {video ? (
          <MidiaDoVideo foto={foto} aoFalhar={aoFalhar} />
        ) : (
          <span className="ft-img">
            <img src={foto.thumbnail_url} alt="" decoding="async" loading="lazy" referrerPolicy="no-referrer" onError={aoFalhar} />
          </span>
        )}
        <span className="ft-leg">
          <b>{nomeDoProduto(foto.product)}</b>
          {video ? (
            <>
              <span className="ft-selo-linha">
                <span className="st st--info">
                  <Icone nome="video" pequeno />
                  Vídeo
                </span>
              </span>
              <span>
                {ehDeitado ? 'deitado' : 'em pé'} · {dia(foto.uploaded_at, agora)}
              </span>
              {ehDeitado && (
                <span className="ft-av">
                  <Icone nome="alert" pequeno />
                  deitado para o Reels
                </span>
              )}
            </>
          ) : (
            <>
              <span>
                {foto.orientation} · {dia(foto.uploaded_at, agora)}
              </span>
              {foto.narrow_for_instagram && (
                <span className="ft-av">
                  <Icone nome="alert" pequeno />
                  pequena para o Instagram
                </span>
              )}
            </>
          )}
        </span>
      </button>
    </li>
  );
}
