'use client';

import type { BrandPhoto, PostResponse } from '@liame/contracts';
import { useState } from 'react';
import { Icone } from '@/components/ui/icone';
import { PreviaDoCanal } from './previa-do-canal';
import { PreviaDoReels } from './previa-do-reels';
import { formatoDaPrevia, NOME_DO_CANAL } from './textos';
import { capaDoPost, ehPostComVideo, ehVideoPronto } from './video-do-post';

// Como o post sai em cada canal (P19): as abas dos canais (quando são dois), a prévia do canal escolhido e as notas do
// Instagram (o recorte que ele pede e a legenda sem link). Na gaveta do post da Agenda e no pedido em Aprovações. Quem
// usa troca a `key` quando o post muda: a aba volta para o primeiro canal. O post com vídeo (P37, parte B; A6, Z10,
// parte 4b) mostra o Reels, com a capa escolhida no pedido.

type Props = {
  post: Pick<PostResponse, 'channels' | 'crop_pos' | 'photo_id' | 'media' | 'cover_photo_id' | 'cover_offset_ms'> & { link?: string | null };
  /** A foto do post (das Fotos); nula quando ela saiu das Fotos, ou a lista não pôde ser lida, ou quem vê não vê as Fotos. No post com vídeo, o vídeo. */
  foto: BrandPhoto | null;
  /** No post com vídeo, a foto escolhida como capa, quando ela está na lista das Fotos. */
  capaFoto?: BrandPhoto | null;
  /** O que dizer no lugar da foto que existe mas não pode ser mostrada aqui. */
  semFoto?: string;
  aoFalharImagem?: () => void;
};

export function PreviasDoPost({ post, foto, capaFoto = null, semFoto, aoFalharImagem }: Props) {
  const [aba, setAba] = useState(post.channels[0]?.channel ?? 'instagram');
  const canal = post.channels.find((c) => c.channel === aba) ?? post.channels[0];
  const comVideo = ehPostComVideo(post);
  const video = comVideo && foto && ehVideoPronto(foto) ? foto : null;
  const formato = foto && !comVideo ? formatoDaPrevia(canal?.channel ?? 'facebook', foto.width, foto.height) : 'inteira';
  const naoMostra = semFoto ?? (comVideo ? 'O vídeo deste post não pôde ser mostrado aqui.' : 'A foto deste post não pôde ser mostrada aqui.');
  const apagada = comVideo ? 'O vídeo deste post foi apagado nas Fotos: ele não sai.' : 'A foto deste post foi apagada nas Fotos: ele não sai.';
  return (
    <>
      {post.channels.length > 1 && (
        <div className="seg po-canais-seg" role="group" aria-label="Ver como sai em">
          {post.channels.map((c) => (
            <button key={c.channel} type="button" aria-pressed={c.channel === canal?.channel} onClick={() => setAba(c.channel)}>
              {NOME_DO_CANAL[c.channel] ?? c.channel}
            </button>
          ))}
        </div>
      )}
      {canal && video && (
        <PreviaDoReels canal={canal.channel} conta={canal.account_name} texto={canal.text} video={video} capa={capaDoPost(post, video, capaFoto)} link={post.link ?? null} />
      )}
      {canal && !video && (
        <PreviaDoCanal
          canal={canal.channel}
          conta={canal.account_name}
          texto={canal.text}
          foto={comVideo ? null : foto}
          recorte={post.crop_pos}
          semFoto={post.photo_id ? naoMostra : apagada}
          aoFalharImagem={aoFalharImagem}
          link={post.link ?? null}
        />
      )}
      {canal?.channel === 'instagram' && formato !== 'inteira' && (
        <p className="po-nota">
          <Icone nome="info" pequeno />
          <span>
            No Instagram, a foto sai recortada em {formato === 'alta' ? '4:5, em pé' : '1,91:1, deitada'}: a foto inteira é {formato === 'alta' ? 'mais alta' : 'mais larga'} do que o Instagram aceita.
            {post.channels.length > 1 ? ' Na Página, ela vai inteira.' : ''}
          </span>
        </p>
      )}
      {canal?.channel === 'instagram' && (
        <p className="po-nota">
          <Icone nome="link" pequeno />
          <span>No Instagram, a legenda não tem link que abre: o texto diz onde pedir (&ldquo;Peça pelo link da bio&rdquo;).</span>
        </p>
      )}
      {canal?.channel === 'facebook' && post.link && (
        <p className="po-nota">
          <Icone nome="link" pequeno />
          <span>O link do post vai no fim do texto da Página, com o código só deste post: o pedido por ele fica separado dos anúncios.</span>
        </p>
      )}
    </>
  );
}
