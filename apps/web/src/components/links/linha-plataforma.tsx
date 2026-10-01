'use client';

import type { CouponListResponse, CouponStore } from '@liame/contracts';
import { linhaPlataforma, type PlataformaDaLoja } from './cupons-textos';

// "Pedidos online da Loja Centro: Anota AI" (protótipo P3 com a plataforma de pedidos): onde a loja recebe
// os pedidos e como o Liame mede as vendas de cada campanha por causa disso. Sem a plataforma informada, a
// linha mostra a sugestão dos anúncios e pede para confirmar.

type Props = {
  loja: CouponStore;
  plataforma: PlataformaDaLoja;
  sugerida: CouponListResponse['detected_platform'];
  podeAlterar: boolean;
  aoAlterar: () => void;
};

export function LinhaPlataforma({ loja, plataforma, sugerida, podeAlterar, aoAlterar }: Props) {
  const { titulo, texto } = linhaPlataforma(loja, plataforma, sugerida);
  return (
    <div className="plataforma-linha">
      <span className="pl-txt">
        <b>{titulo}</b>
        <span>
          {texto}
          {!loja.unit && ' Para informar, ligue esta loja do Regem a uma loja do Liame em Contas conectadas.'}
        </span>
      </span>
      {podeAlterar && loja.unit && (
        <button className="btn btn--sm" type="button" aria-haspopup="dialog" onClick={aoAlterar}>
          {plataforma.informada ? 'Alterar' : 'Confirmar'}
        </button>
      )}
    </div>
  );
}
