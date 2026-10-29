'use client';

import type { BrandPhoto, PostResponse } from '@liame/contracts';
import { useState } from 'react';
import { Icone } from '@/components/ui/icone';
import { PreviaDoCanal } from './previa-do-canal';
import { formatoDaPrevia, NOME_DO_CANAL } from './textos';

// Como o post sai em cada canal (P19): as abas dos canais (quando são dois), a prévia do canal escolhido e as notas do
// Instagram (o recorte que ele pede e a legenda sem link). Na gaveta do post da Agenda e no pedido em Aprovações. Quem
// usa troca a `key` quando o post muda: a aba volta para o primeiro canal.

type Props = {
  post: Pick<PostResponse, 'channels' | 'crop_pos' | 'photo_id'> & { link?: string | null };
  /** A foto do post (das Fotos); nula quando ela saiu das Fotos, ou a lista não pôde ser lida, ou quem vê não vê as Fotos. */
  foto: BrandPhoto | null;
  /** O que dizer no lugar da foto que existe mas não pode ser mostrada aqui. */
  semFoto?: string;
  aoFalharImagem?: () => void;
};

export function PreviasDoPost({ post, foto, semFoto = 'A foto deste post não pôde ser mostrada aqui.', aoFalharImagem }: Props) {
  const [aba, setAba] = useState(post.channels[0]?.channel ?? 'instagram');
  const canal = post.channels.find((c) => c.channel === aba) ?? post.channels[0];
  const formato = foto ? formatoDaPrevia(canal?.channel ?? 'facebook', foto.width, foto.height) : 'inteira';
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
      {canal && (
        <PreviaDoCanal
          canal={canal.channel}
          conta={canal.account_name}
          texto={canal.text}
          foto={foto}
          recorte={post.crop_pos}
          semFoto={post.photo_id ? semFoto : 'A foto deste post foi apagada nas Fotos: ele não sai.'}
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
