'use client';

import type { InstagramMedia, NewCampaignObjective } from '@liame/contracts';
import { useState } from 'react';
import { numeroCurto } from '@/components/fotos/do-seu-instagram';
import { Icone } from '@/components/ui/icone';
import { diaDoReels, OBJETIVOS } from './campanha-nova-textos';

// A campanha a partir de um Reels já publicado (A4, X5, parte 6; P42 aprovado em 11/11/2026; D-A4-46): o bloco "O
// Reels" da gaveta (o post como está, o que fica e o que o Liame põe) e a prévia do anúncio no Feed do Instagram (a
// capa, a faixa do botão e a legenda do post). A miniatura é a do próprio Instagram, no endereço da Meta.

/** O Reels como está no post: a capa, o dia, a legenda e os números; o que fica e o que o Liame põe. */
export function BlocoDoReels({ reels }: { reels: InstagramMedia }) {
  const [semCapa, setSemCapa] = useState(!reels.thumbnail_url);
  const m = reels.metrics;
  const numeros = (
    [
      [m.views, 'visualizações'],
      [m.likes, 'curtidas'],
      [m.comments, 'comentários'],
      [m.saved, 'salvamentos'],
    ] as const
  )
    .filter(([n]) => n !== null)
    .map(([n, nome]) => `${numeroCurto(n)} ${nome}`);
  return (
    <div className="pd-bloco">
      <p className="rotulo-marca">O Reels</p>
      <div className="cn-reels">
        <span className="cn-reels-capa">
          {semCapa ? <Icone nome="video" /> : <img src={reels.thumbnail_url!} alt="" referrerPolicy="no-referrer" onError={() => setSemCapa(true)} />}
        </span>
        <div>
          <b>Reels de {diaDoReels(reels.published_at)}</b>
          {reels.caption ? <p>{reels.caption}</p> : <small>O post não tem legenda.</small>}
          {numeros.length > 0 && <small>{numeros.join(' · ')}</small>}
        </div>
      </div>
      <dl className="cn-fica">
        <div>
          <dt>O vídeo e a legenda</dt>
          <dd>ficam como estão no post: o anúncio aponta para ele. A Meta não deixa mudar o texto de um anúncio feito de um post já publicado.</dd>
        </div>
        <div>
          <dt>O botão e o rastreio</dt>
          <dd>o Liame põe: o botão leva ao destino escolhido abaixo, com o rastreio do Liame.</dd>
        </div>
        <div>
          <dt>As curtidas e os comentários</dt>
          <dd>ficam no mesmo post.</dd>
        </div>
      </dl>
      <p className="campo-dica">Para outro texto, o caminho é um vídeo novo, com o texto no próprio vídeo, e um anúncio com ele.</p>
    </div>
  );
}

/** A prévia do anúncio do Reels no Feed do Instagram (4:5, como o Feed recorta): quem assina, a capa, o botão e a legenda. */
export function PreviaDoReels({ reels, objetivo, nome }: { reels: Pick<InstagramMedia, 'thumbnail_url' | 'caption'> | null; objetivo: NewCampaignObjective; nome: string }) {
  const [semCapa, setSemCapa] = useState(!reels?.thumbnail_url);
  const iniciais = nome
    .replace('@', '')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((x) => x.charAt(0).toLocaleUpperCase('pt-BR'))
    .join('');
  return (
    <div className="previa cn-previa" role="group" aria-label="Prévia do anúncio no Feed do Instagram">
      <div className="pv-cab">
        <span className="pv-av" aria-hidden="true">
          {iniciais || <Icone nome="store" pequeno />}
        </span>
        <span className="pv-quem">
          <b>{nome || 'O Instagram da Página'}</b>
          <small>Patrocinado</small>
        </span>
      </div>
      <div className={`cn-midia ${semCapa ? 'cn-midia--vazia' : 'cn-midia--alta'}`}>
        {semCapa ? (
          <span>
            <Icone nome="video" />
            {reels ? 'A capa do Reels não veio do Instagram.' : 'O Reels saiu da leitura do Instagram da marca.'}
          </span>
        ) : (
          <>
            <img src={reels!.thumbnail_url!} alt={reels!.caption ? `Capa do Reels: ${reels!.caption}` : 'Capa do Reels'} referrerPolicy="no-referrer" onError={() => setSemCapa(true)} />
            <span className="cn-play" aria-hidden="true">
              <Icone nome="play" />
            </span>
          </>
        )}
      </div>
      <div className="cn-ig-cta">
        <span>{OBJETIVOS[objetivo].botao}</span>
        <Icone nome="chevron-right" pequeno />
      </div>
      {reels?.caption && (
        <p className="pv-texto cn-ig-texto">
          {nome && <b>{nome}</b>} {reels.caption}
        </p>
      )}
    </div>
  );
}
