'use client';

import type { BrandPhoto } from '@liame/contracts';
import { Icone } from '@/components/ui/icone';
import { NOME_DO_CANAL } from './textos';

// O pacote de uma rede (P22): a foto inteira e o texto, sem imitar a tela da rede (o Liame não publica nela; quem
// publica é a pessoa). No novo post e na gaveta do pacote.

type Props = {
  canal: string;
  texto: string;
  foto: BrandPhoto | null;
  /** O que dizer no lugar da foto, quando não há foto para mostrar. */
  semFoto?: string;
  aoFalharImagem?: () => void;
};

export function PreviaDoPacote({ canal, texto, foto, semFoto, aoFalharImagem }: Props) {
  const nome = NOME_DO_CANAL[canal] ?? canal;
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
      {foto ? (
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
