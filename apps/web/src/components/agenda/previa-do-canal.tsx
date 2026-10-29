'use client';

import type { BrandPhoto } from '@liame/contracts';
import { Icone } from '@/components/ui/icone';
import { formatoDaPrevia, NOME_DO_CANAL, posicaoDoRecorte } from './textos';

// Como o post sai num canal (P19): o cabeçalho da conta, a foto (no Instagram, o recorte que ele pede, no ponto
// escolhido; na Página, inteira) e o texto. Na gaveta do post e no novo post.

type Props = {
  canal: string;
  /** O nome da conta do canal ("@misterburgers", o nome da Página); nulo quando ela foi desligada da marca. */
  conta: string | null;
  texto: string;
  foto: BrandPhoto | null;
  recorte: number | null;
  /** O que dizer no lugar da foto, quando não há foto para mostrar. */
  semFoto?: string;
  aoFalharImagem?: () => void;
  /** O link do post (A6, Z7): no fim do texto da Página, ele aparece destacado, como no P19. */
  link?: string | null;
};

export function PreviaDoCanal({ canal, conta, texto, foto, recorte, semFoto, aoFalharImagem, link }: Props) {
  const formato = foto ? formatoDaPrevia(canal, foto.width, foto.height) : 'inteira';
  const comLink = canal === 'facebook' && link && texto.endsWith(link);
  return (
    <div className="po-previa" role="group" aria-label={`Como sai: ${NOME_DO_CANAL[canal] ?? canal}`}>
      <div className="po-previa-cab">
        <span className="po-avatar" aria-hidden="true">
          {(conta ?? '?').replace('@', '').slice(0, 2).toUpperCase()}
        </span>
        <span>
          <b>{conta ?? 'Conta desligada da marca'}</b>
          <br />
          <span>{canal === 'instagram' ? 'no feed' : 'na Página'}</span>
        </span>
      </div>
      {canal !== 'instagram' &&
        (comLink ? (
          <p className="po-texto">
            {texto.slice(0, texto.length - link.length).trimEnd()}
            {'\n\n'}
            <span className="po-link">{link}</span>
          </p>
        ) : (
          <p className="po-texto">{texto}</p>
        ))}
      {foto ? (
        <div className={`po-foto po-foto--${formato}`}>
          <img
            src={foto.url}
            alt={foto.description || `Foto do produto: ${foto.product ?? 'sem produto'}`}
            referrerPolicy="no-referrer"
            onError={aoFalharImagem}
            style={formato === 'inteira' ? undefined : { objectPosition: posicaoDoRecorte(formato, recorte) }}
          />
        </div>
      ) : (
        semFoto && (
          <p className="po-nota">
            <Icone nome="image" pequeno />
            <span>{semFoto}</span>
          </p>
        )
      )}
      {canal === 'instagram' && (
        <p className="po-texto">
          <b>{conta ?? ''}</b> {texto}
        </p>
      )}
    </div>
  );
}
