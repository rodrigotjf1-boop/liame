'use client';

import type { InstagramMedia, NewCampaignOptionsResponse } from '@liame/contracts';
import Link from 'next/link';
import { type RefObject, useId, useRef, useState } from 'react';
import { situacaoDaCampanha } from '@/components/criativos/campanha-nova-textos';
import { Icone } from '@/components/ui/icone';
import { useDialogo } from '@/components/ui/use-dialogo';
import { comMusicaDoInstagram, ehReels, fatosDaPublicacao, NOTA_DA_MUSICA, nomeDaPublicacao } from './do-seu-instagram';

// Uma publicação do Instagram ("Do seu Instagram", A6 · Z10, parte 5b; P37 parte A; D-A6-83), na gaveta à direita: a
// miniatura (a capa, no Reels), a legenda, os números e o link para ver no Instagram. O vídeo não toca dentro do Liame.
// No Reels, com a campanha nova ligada, "Usar como base de um anúncio" (A4, X5, parte 6; P42; D-A4-46) abre a gaveta da
// campanha nova por cima desta; as outras ações do protótipo ficam para depois (D-A6-83, item 4).

/** A campanha nova a partir deste Reels: em que pé está a última, quem pode pedir e o que abre a gaveta. */
export type CampanhaDoReels = {
  atual: NewCampaignOptionsResponse['by_reels'][number] | null;
  podePedir: boolean;
  aoUsar: () => void;
};

type Props = {
  publicacao: InstagramMedia;
  agora: Date;
  reserva: RefObject<HTMLElement | null>;
  /** Nula sem a função `campanha_nova`, ou quando as opções dela não abriram. */
  campanha?: CampanhaDoReels | null;
  aoFechar: () => void;
};

export function GavetaDoInstagram({ publicacao, agora, reserva, campanha = null, aoFechar }: Props) {
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
          {reels && campanha && <CampanhaDoReelsNaGaveta campanha={campanha} ids={ids} />}
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

/** A campanha nova a partir do Reels: o botão da gaveta, ou em que pé está a campanha deste Reels (como na peça). */
function CampanhaDoReelsNaGaveta({ campanha, ids }: { campanha: CampanhaDoReels; ids: string }) {
  const atual = campanha.atual;
  const andando = atual && (atual.status === 'pedida' || atual.status === 'criando');
  const situacao = atual ? situacaoDaCampanha(atual) : null;
  return (
    <section className="cn-na-peca ig-campanha" aria-labelledby={`${ids}-cn-t`}>
      <div className="card-cab">
        <h3 className="rotulo-marca" id={`${ids}-cn-t`}>
          Campanha nova na Meta
        </h3>
        {situacao && <span className={`st st--${situacao.tom}`}>{situacao.rotulo}</span>}
      </div>
      <p className="campo-dica">
        {atual
          ? andando
            ? 'Este Reels já tem um pedido de campanha: decida em Aprovações antes de pedir outro.'
            : atual.status === 'nao_criada'
              ? 'A última campanha com este Reels não foi criada: o motivo está em Aprovações. Dá para pedir de novo.'
              : 'A campanha com este Reels já existe na Meta. Ativar e pausar ficam em Aprovações.'
          : 'O Reels vira uma campanha na Meta como está no post, criada pausada: não aparece para ninguém e não gasta até você ativar. Antes, o Liame pergunta à Meta se ele pode virar anúncio: post com música protegida ou com filtro interativo não pode.'}
      </p>
      <div className="vazio-acoes">
        {campanha.podePedir && !andando && (
          <button className="btn btn--sm" type="button" aria-haspopup="dialog" data-ig-campanha="" onClick={campanha.aoUsar}>
            <Icone nome="megaphone" pequeno />
            Usar como base de um anúncio
          </button>
        )}
        {atual?.action_id && (
          <Link className="btn btn--sm" href={`/aprovacoes?pedido=${atual.action_id}`}>
            Ver em Aprovações
          </Link>
        )}
      </div>
    </section>
  );
}
