'use client';

import type { CampaignTopAd } from '@liame/contracts';
import { useId, useRef } from 'react';
import { Icone } from '@/components/ui/icone';
import { useDialogo } from '@/components/ui/use-dialogo';

// A imagem do anúncio em "Por campanha" (A3 · I14, parte 2; P44 aprovado em 11/11/2026; D-A3-29 a D-A3-33): a cópia da
// miniatura do anúncio que mais gastou no período, para reconhecer a campanha. Sem imagem: o anúncio de texto do Google
// (o ícone e "Anúncio de texto"), o anúncio reprovado ou removido ("Anúncio fora do ar") e a imagem que ainda não foi
// lida (um quadro neutro). No cartão, a imagem abre a prévia maior; no modo simples, é só a miniatura.

/** O que a imagem diz para quem não vê (o leitor de tela ouve o nome do anúncio). */
export function rotuloDaImagem(a: CampaignTopAd): string {
  if (a.off_air) return `${a.name}: anúncio fora do ar`;
  if (a.kind === 'texto') return `${a.name}: anúncio de texto, sem imagem`;
  if (!a.image) return `${a.name}: a imagem ainda não foi lida`;
  return a.kind === 'video' ? `Vídeo do anúncio ${a.name}` : `Imagem do anúncio ${a.name}`;
}

function Conteudo({ a, pequeno }: { a: CampaignTopAd | null; pequeno: boolean }) {
  if (!a) {
    return (
      <span className="cc-mini-ic" aria-hidden="true">
        <Icone nome="image" pequeno />
      </span>
    );
  }
  if (a.image && !a.off_air) {
    return (
      <>
        <img src={a.image.url} alt="" referrerPolicy="no-referrer" />
        {a.kind === 'video' && (
          <span className="cc-mini-play" aria-hidden="true">
            <Icone nome="play" pequeno />
          </span>
        )}
      </>
    );
  }
  const icone = a.off_air ? 'ban' : a.kind === 'texto' ? 'search' : 'image';
  return (
    <>
      <span className={`cc-mini-ic${a.off_air ? ' cc-mini-ic--fora' : ''}`} aria-hidden="true">
        <Icone nome={icone} pequeno />
      </span>
      {!pequeno && <span className="cc-mini-txt">{a.off_air ? 'Anúncio fora do ar' : a.kind === 'texto' ? 'Anúncio de texto' : 'Imagem ainda não lida'}</span>}
    </>
  );
}

/** A miniatura: no cartão, um botão que abre a prévia (quando há imagem); no modo simples, só a imagem. */
export function MiniaturaDoAnuncio({ anuncio, pequeno = false, aoAbrir }: { anuncio: CampaignTopAd | null; pequeno?: boolean; aoAbrir?: (botao: HTMLButtonElement) => void }) {
  const vazio = !anuncio || !anuncio.image || anuncio.off_air;
  const classe = `cc-mini${pequeno ? ' cc-mini--lite' : ''}${vazio ? ' cc-mini--vazio' : ''}${anuncio?.off_air ? ' cc-mini--fora' : ''}`;
  if (aoAbrir && anuncio && !vazio) {
    return (
      <button className={classe} type="button" aria-label={`${rotuloDaImagem(anuncio)}. Abrir a prévia`} aria-haspopup="dialog" onClick={(e) => aoAbrir(e.currentTarget)}>
        <Conteudo a={anuncio} pequeno={pequeno} />
      </button>
    );
  }
  return (
    <span className={classe} role={anuncio ? 'img' : undefined} aria-label={anuncio ? rotuloDaImagem(anuncio) : undefined} aria-hidden={anuncio ? undefined : true}>
      <Conteudo a={anuncio} pequeno={pequeno} />
    </span>
  );
}

/** A prévia maior do anúncio, com o link do Gerenciador de Anúncios; Esc fecha e o foco volta para a imagem. */
export function PreviaDoAnuncio({ campanha, anuncio, aoFechar }: { campanha: string; anuncio: CampaignTopAd; aoFechar: () => void }) {
  const ids = useId();
  const titulo = useRef<HTMLHeadingElement>(null);
  const { ref, fechar, devolverFoco } = useDialogo({ focoInicial: titulo });
  return (
    <dialog
      ref={ref}
      className="dialogo cc-dlg"
      aria-labelledby={`${ids}-t`}
      onClose={() => {
        aoFechar();
        devolverFoco();
      }}
      onClick={(e) => {
        if (e.target === ref.current) fechar();
      }}
    >
      <div className="dialogo-cab">
        <div className="dlg-titulo">
          <p className="rotulo-marca">O anúncio que mais gastou</p>
          <h2 id={`${ids}-t`} ref={titulo} tabIndex={-1}>
            {anuncio.name}
          </h2>
        </div>
        <button className="btn btn--icon btn--ghost" type="button" onClick={fechar} aria-label="Fechar">
          <Icone nome="x" />
        </button>
      </div>
      <div className="dialogo-corpo cc-prev">
        {anuncio.image && (
          <figure className="cc-prev-midia">
            <img src={anuncio.image.url} alt={rotuloDaImagem(anuncio)} referrerPolicy="no-referrer" />
            {anuncio.kind === 'video' && (
              <span className="cc-mini-play" aria-hidden="true">
                <Icone nome="play" />
              </span>
            )}
            <figcaption className="eixo-nota">Na campanha {campanha}. A imagem é a miniatura que a plataforma mostra; o anúncio de verdade está no Gerenciador.</figcaption>
          </figure>
        )}
        {anuncio.manager_url && (
          <a className="btn btn--sm" href={anuncio.manager_url} target="_blank" rel="noopener noreferrer">
            <Icone nome="external" pequeno />
            Abrir no Gerenciador de Anúncios
            <span className="sr-only"> (abre em outra aba)</span>
          </a>
        )}
      </div>
    </dialog>
  );
}
