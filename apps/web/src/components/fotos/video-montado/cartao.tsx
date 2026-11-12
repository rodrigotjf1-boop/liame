import type { BrandPhoto, VideoMontageResponse } from '@liame/contracts';
import { Icone } from '@/components/ui/icone';
import { antesDeste, MODELOS } from './textos';

// O vídeo que está sendo montado, na grade de Fotos (P43): a primeira foto escolhida com o véu da fase ("Na fila" ou
// "Montando: N%"), o título, a etiqueta "Montado pelo Liame" e quantos estão na frente ou a barra do andamento. Abre a
// gaveta do pedido. Pronto, ele sai daqui e entra na grade como um vídeo da marca.

type Props = {
  montagem: VideoMontageResponse;
  /** A primeira foto ou o vídeo do pedido, para o quadro (sumiu de Fotos, o quadro fica vazio). */
  capa: BrandPhoto | null;
  aoAbrir: (botao: HTMLButtonElement) => void;
};

export function CartaoDaMontagem({ montagem, capa, aoAbrir }: Props) {
  const fila = montagem.status === 'na_fila';
  const fase = fila ? 'Na fila' : `Montando: ${montagem.progress}%`;
  const frase = fila ? antesDeste(montagem.queue_ahead ?? 0) : 'Montando o vídeo';
  return (
    <li>
      <button
        className="ft-card vm-job"
        type="button"
        data-vm-montagem={montagem.id}
        aria-haspopup="dialog"
        aria-label={`Vídeo montado pelo Liame, ${MODELOS[montagem.template].nome}: ${montagem.title}. ${fase}. ${frase}.`}
        onClick={(e) => aoAbrir(e.currentTarget)}
      >
        <span className="ft-img ft-midia">
          {capa && <img src={capa.thumbnail_url} alt="" decoding="async" loading="lazy" referrerPolicy="no-referrer" />}
          <span className="vm-job-veu" aria-hidden="true">
            <Icone nome={fila ? 'clock' : 'video'} />
            <span>{fase}</span>
          </span>
        </span>
        <span className="ft-leg">
          <b>{montagem.title}</b>
          <span className="ft-selo-linha">
            <span className="st st--espera">
              <Icone nome="video" pequeno />
              Montado pelo Liame
            </span>
          </span>
          <span>{frase}</span>
          {!fila && (
            <span className="ft-barra" aria-hidden="true">
              <span style={{ width: `${montagem.progress}%` }} />
            </span>
          )}
        </span>
      </button>
    </li>
  );
}
