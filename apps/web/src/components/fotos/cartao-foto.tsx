import type { BrandPhoto } from '@liame/contracts';
import { Icone } from '@/components/ui/icone';
import { dia } from '@/lib/formato';
import { nomeDoProduto, rotuloDoCartao } from './textos';

// Uma foto na grade (P20): a foto em quadrado (o recorte é só da vista; a foto guardada é inteira), o produto, a
// orientação, o dia e, quando for o caso, o aviso de que é pequena para o Instagram. Abre a gaveta da foto.

type Props = {
  foto: BrandPhoto;
  agora: Date;
  aberta: boolean;
  aoAbrir: (botao: HTMLButtonElement) => void;
  /** O endereço assinado venceu (a imagem não carregou): a tela pede a lista de novo. */
  aoFalhar: () => void;
};

export function CartaoFoto({ foto, agora, aberta, aoAbrir, aoFalhar }: Props) {
  return (
    <li>
      <button
        className="ft-card"
        type="button"
        data-ft-foto={foto.id}
        aria-haspopup="dialog"
        aria-expanded={aberta}
        aria-label={rotuloDoCartao(foto, agora)}
        onClick={(e) => aoAbrir(e.currentTarget)}
      >
        <span className="ft-img">
          <img src={foto.thumbnail_url} alt="" decoding="async" loading="lazy" referrerPolicy="no-referrer" onError={aoFalhar} />
        </span>
        <span className="ft-leg">
          <b>{nomeDoProduto(foto.product)}</b>
          <span>
            {foto.orientation} · {dia(foto.uploaded_at, agora)}
          </span>
          {foto.narrow_for_instagram && (
            <span className="ft-av">
              <Icone nome="alert" pequeno />
              pequena para o Instagram
            </span>
          )}
        </span>
      </button>
    </li>
  );
}
