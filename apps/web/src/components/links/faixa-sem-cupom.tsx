'use client';

import type { CouponCampaign, CouponItem } from '@liame/contracts';
import { useId, useState } from 'react';
import { Faixa } from '@/components/ui/faixa';
import { Icone } from '@/components/ui/icone';
import { campanhasSemCupom, type PlataformaDaLoja } from './cupons-textos';
import { classePlataforma, rotuloPlataforma } from './textos';

// Aba Links na loja que recebe pedidos por outra plataforma (protótipo P3 com a plataforma de pedidos): o
// clique do anúncio não chega ao pedido, então a conferência pede um cupom exclusivo por campanha em vez de
// parâmetros no link. Na plataforma que ainda não chega ao Regem, só avisa que essas vendas não são medidas.

type Props = {
  plataforma: PlataformaDaLoja;
  campanhas: CouponCampaign[];
  itens: CouponItem[];
  podeInformar: boolean;
  aoInformar: (campanha: string) => void;
};

export function FaixaSemCupom({ plataforma, campanhas, itens, podeInformar, aoInformar }: Props) {
  const [aberta, setAberta] = useState(false);
  const id = useId();
  const { info } = plataforma;
  if (!info.integrado) {
    return (
      <Faixa
        icone={<Icone nome="info" />}
        titulo={`Os anúncios levam ${info.a}, que ainda não está integrada ao Regem`}
        texto="Os pedidos de lá não chegam ao Regem, então o Liame ainda não sabe quais anúncios vendem. O ROAS da plataforma segue em Resultados."
      />
    );
  }
  const sem = campanhasSemCupom(campanhas, itens);
  if (!sem.length) {
    if (!campanhas.some((c) => c.status === 'ativa')) return null;
    return (
      <Faixa
        tipo="acao"
        icone={<Icone nome="check" />}
        titulo="Todas as campanhas ativas têm cupom exclusivo"
        texto={`Os pedidos ${info.de} com o cupom de cada campanha contam para ela.`}
      />
    );
  }
  const n = sem.length;
  return (
    <>
      <Faixa
        tipo="atencao"
        icone={<Icone nome="alert" />}
        titulo={`${n} ${n === 1 ? 'campanha ativa' : 'campanhas ativas'} sem cupom exclusivo — as vendas ${n === 1 ? 'dela ficam' : 'delas ficam'} sem origem.`}
        texto={`Os anúncios levam ${info.a}, a plataforma de pedidos da loja. Crie um cupom lá para cada campanha e informe o código aqui.`}
        acao={
          <button className="btn btn-alternar" type="button" aria-expanded={aberta} aria-controls={id} onClick={() => setAberta((a) => !a)}>
            {aberta ? 'Ocultar' : n === 1 ? 'Ver a campanha' : `Ver as ${n} campanhas`}
          </button>
        }
      />
      <ul className="sem-rastreio" id={id} hidden={!aberta} aria-label="Campanhas sem cupom exclusivo">
        {sem.map((c) => (
          <li key={c.id}>
            <span className={classePlataforma(c.provider)}>{rotuloPlataforma(c.provider)}</span>
            <span className="sr-txt">
              <b>{c.name}</b>
              <span>Sem cupom exclusivo · os anúncios levam {info.a} e o clique não chega ao pedido</span>
            </span>
            {podeInformar && (
              <button className="btn btn--sm" type="button" aria-haspopup="dialog" onClick={() => aoInformar(c.id)}>
                Informar cupom
              </button>
            )}
          </li>
        ))}
      </ul>
    </>
  );
}
