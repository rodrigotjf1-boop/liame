'use client';

import type { PostResponse } from '@liame/contracts';
import { Icone } from '@/components/ui/icone';
import { linhaDoCanal, NO_CANAL, podeTentarDeNovo } from './textos';

// O que aconteceu em cada canal do post (P19: na gaveta da Agenda e no post decidido em Aprovações): a situação, a frase
// e o endereço do que saiu. No canal que não saiu e ainda dá (A6, Z5d; D-A6-54), quem opera vê "Tentar de novo": o
// mesmo post aprovado, só nesse canal, sem o código do app.

type Props = {
  post: PostResponse;
  fuso: string;
  hoje: string;
  agora: Date;
  /** O nome da lista para o leitor de tela, quando ela não está numa seção com título. */
  rotulo?: string;
  /** "Tentar de novo": nulo para quem não opera as campanhas. `ocupado`: o canal que está sendo pedido agora. */
  tentar: { aoTentar: (canal: string) => void; ocupado: string | null } | null;
};

export function SituacaoDosCanais({ post, fuso, hoje, agora, rotulo, tentar }: Props) {
  return (
    <ul className="po-situacao" aria-label={rotulo}>
      {post.channels.map((c) => {
        const l = linhaDoCanal(c, post, fuso, hoje);
        return (
          <li key={l.canal}>
            <span className={l.tom}>
              <Icone nome={l.icone} />
            </span>
            <span>
              <b>{l.nome}:</b> {l.frase}
            </span>
            {l.endereco && (
              <a className="btn btn--sm btn--ghost" href={l.endereco} target="_blank" rel="noopener noreferrer">
                <Icone nome="external" pequeno />
                {l.rotuloDoEndereco}
              </a>
            )}
            {tentar && podeTentarDeNovo(c, agora) && (
              <button
                className="btn btn--sm"
                type="button"
                data-tentar-de-novo={c.channel}
                disabled={tentar.ocupado !== null}
                aria-busy={tentar.ocupado === c.channel}
                onClick={() => tentar.aoTentar(c.channel)}
              >
                <Icone nome="refresh" pequeno />
                {tentar.ocupado === c.channel ? 'Tentando…' : 'Tentar de novo'}
                <span className="sr-only"> {NO_CANAL[c.channel] ?? c.channel}</span>
              </button>
            )}
          </li>
        );
      })}
    </ul>
  );
}
