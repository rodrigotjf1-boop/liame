'use client';

import type { InstagramMedia } from '@liame/contracts';
import { type RefObject, useId, useRef, useState } from 'react';
import { Icone } from '@/components/ui/icone';
import { useDialogo } from '@/components/ui/use-dialogo';
import { comMusicaDoInstagram, ehReels, fatosDaPublicacao, NOTA_DA_MUSICA, nomeDaPublicacao } from './do-seu-instagram';

// Uma publicação do Instagram ("Do seu Instagram", A6 · Z10, parte 5b; P37 parte A; D-A6-83), na gaveta à direita: a
// miniatura (a capa, no Reels), a legenda, os números e o link para ver no Instagram. Só lê: o vídeo não toca dentro do
// Liame, e as ações que o protótipo desenhou além da leitura ficam para depois (D-A6-83, item 4).

type Props = {
  publicacao: InstagramMedia;
  agora: Date;
  reserva: RefObject<HTMLElement | null>;
  aoFechar: () => void;
};

export function GavetaDoInstagram({ publicacao, agora, reserva, aoFechar }: Props) {
  const ids = useId();
  const fecharBt = useRef<HTMLButtonElement>(null);
  const { ref, fechar, devolverFoco } = useDialogo({ focoInicial: fecharBt, reserva });
  const [semImagem, setSemImagem] = useState(!publicacao.thumbnail_url);
  const reels = ehReels(publicacao);
  const nome = nomeDaPublicacao(publicacao, agora);

  return (
    <dialog
      ref={ref}
      className="dialogo dialogo--lado ft-gaveta"
      aria-labelledby={`${ids}-t`}
      data-ig-gaveta={publicacao.id}
      onClose={() => {
        aoFechar();
        devolverFoco();
      }}
      onClick={(e) => {
        if (e.target === ref.current) fechar();
      }}
    >
      <div className="dialogo-form">
        <div className="dialogo-cab">
          <div className="dlg-titulo">
            <p className="rotulo-marca">Do seu Instagram</p>
            <h2 id={`${ids}-t`}>{nome}</h2>
          </div>
          <button className="btn btn--icon btn--ghost" type="button" ref={fecharBt} onClick={fechar} aria-label="Fechar">
            <Icone nome="x" />
          </button>
        </div>
        <div className="dialogo-corpo">
          <div className="ft-tela-caixa">
            <div className={`ig-tela${reels ? '' : ' ig-tela--post'}`}>
              {semImagem ? (
                <span className="ig-sem-imagem">
                  <Icone nome="image" />
                  <span>A miniatura não veio do Instagram.</span>
                </span>
              ) : (
                <img src={publicacao.thumbnail_url!} alt={publicacao.caption ? `${nome}: ${publicacao.caption}` : nome} referrerPolicy="no-referrer" onError={() => setSemImagem(true)} />
              )}
              {reels && !semImagem && (
                <span className="ft-play" aria-hidden="true">
                  <Icone nome="play" />
                </span>
              )}
            </div>
          </div>
          {comMusicaDoInstagram(publicacao) && (
            <p className="ft-nota ft-nota--aviso" data-ig-musica="">
              <Icone nome="alert" pequeno />
              <span>{NOTA_DA_MUSICA}</span>
            </p>
          )}
          {publicacao.caption && (
            <p className="ft-nota ig-legenda">
              <Icone nome="info" pequeno />
              <span>{publicacao.caption}</span>
            </p>
          )}
          <dl className="ft-fatos">
            {fatosDaPublicacao(publicacao, agora).map(([t, d]) => (
              <div key={t}>
                <dt>{t}</dt>
                <dd>{d}</dd>
              </div>
            ))}
          </dl>
        </div>
        <div className="dialogo-acoes">
          {publicacao.permalink && (
            <a className="btn" href={publicacao.permalink} target="_blank" rel="noopener noreferrer" data-ig-abrir="">
              <Icone nome="external" />
              Ver no Instagram
            </a>
          )}
          <span className="spacer" />
          <button className="btn" type="button" onClick={fechar}>
            Fechar
          </button>
        </div>
      </div>
    </dialog>
  );
}
