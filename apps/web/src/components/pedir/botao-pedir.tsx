'use client';

import Link from 'next/link';
import { Icone } from '@/components/ui/icone';
import type { CampanhaDoPedido } from './gaveta-pedir';
import type { PedirNaCampanha } from './textos';

// O botão "Pedir mudança" de uma campanha e, quando há, o atalho para o pedido que já espera (protótipo P9). Quem
// decide onde ele aparece é `GET /v1/actions/targets`: campanha fora da lista não tem botão.

/** O que a lista de campanhas recebe para desenhar o pedido de mudança. */
export type PedirNaLista = {
  porCampanha: ReadonlyMap<string, PedirNaCampanha>;
  /** Quem opera as campanhas vê o botão; quem só acompanha vê o pedido que espera. */
  podePedir: boolean;
  /** A campanha com a gaveta aberta (para o `aria-expanded` do botão dela). */
  aberta: string | null;
  aoPedir: (campanha: CampanhaDoPedido) => void;
};

/**
 * O botão "Pedir mudança" de uma campanha que está à vista (a lista do Lite e a tabela do Pro têm um cada, e no
 * celular o da tabela muda de lugar). É para onde o foco volta quando a gaveta fecha e o navegador não tinha posto o
 * foco no botão ao clicar.
 */
export function botaoPedirAVista(campanhaId: string): HTMLElement | null {
  const botoes = document.querySelectorAll<HTMLElement>(`button[data-pedir="${CSS.escape(campanhaId)}"]`);
  return [...botoes].find((b) => b.getClientRects().length > 0) ?? null;
}

export function BotaoPedir({ campanha, pedir, curto = false }: { campanha: CampanhaDoPedido; pedir: PedirNaLista; curto?: boolean }) {
  const p = pedir.porCampanha.get(campanha.id);
  if (!p) return null;
  return (
    <>
      {pedir.podePedir && (
        <button
          className="btn btn--sm"
          type="button"
          data-pedir={campanha.id}
          aria-haspopup="dialog"
          aria-expanded={pedir.aberta === campanha.id}
          aria-label={`Pedir mudança na campanha ${campanha.nome}`}
          onClick={() => pedir.aoPedir({ id: campanha.id, nome: campanha.nome, provider: campanha.provider })}
        >
          <Icone nome="sliders" pequeno />
          {curto ? 'Pedir' : 'Pedir mudança'}
        </button>
      )}
      {p.esperando && (
        <Link className="pedido-esperando" href={p.esperando.href}>
          {p.esperando.rotulo}
        </Link>
      )}
    </>
  );
}
