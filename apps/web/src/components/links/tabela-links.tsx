'use client';

import type { TrackingLink } from '@liame/contracts';
import { Icone } from '@/components/ui/icone';
import { inteiro } from '@/lib/formato';
import { classePlataforma, criadoEm, enderecoCurto, rotuloPlataforma, textoAnuncio } from './textos';

// Os links da marca (protótipo P3): nome e cardápio, campanha com a plataforma, o código `lk`, os pedidos
// dos últimos 7 dias e as ações. No celular, cada linha vira um cartão.

type Props = {
  links: TrackingLink[];
  marca: string;
  agora: Date;
  aoCopiar: (link: TrackingLink) => void;
  aoParametros: (link: TrackingLink) => void;
};

export function TabelaLinks({ links, marca, agora, aoCopiar, aoParametros }: Props) {
  const variasLojas = new Set(links.map((l) => l.unit?.id ?? '')).size > 1;
  return (
    <>
      <div className="table-wrap lista-cartoes">
        <table className="tabela">
          <caption className="sr-only">Links de campanha de {marca}</caption>
          <thead>
            <tr>
              <th scope="col">Link</th>
              <th scope="col">Campanha</th>
              <th scope="col">Código</th>
              <th scope="col" className="n">
                Pedidos em 7 dias
              </th>
              <th scope="col">
                <span className="sr-only">Ações</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {links.map((l) => (
              <tr key={l.id}>
                <th scope="row">
                  {l.name}
                  <span className="link-url" title={l.tracking_url}>
                    {enderecoCurto(l.destination_url)}
                  </span>
                  <span className="sub">{criadoEm(l.created_at, agora)}</span>
                </th>
                <td data-rot="Campanha">
                  <span className="camp-cel">
                    <span className="linha">
                      <b>{l.campaign?.name ?? 'Campanha fora da conta conectada'}</b>
                      <span className={classePlataforma(l.provider)}>{rotuloPlataforma(l.provider)}</span>
                    </span>
                    <small>
                      {textoAnuncio(l)}
                      {variasLojas && l.unit ? ` · ${l.unit.name}` : ''}
                    </small>
                  </span>
                </td>
                <td data-rot="Código">
                  <span className="cod-lk">{l.code}</span>
                </td>
                <td className="n num" data-rot="Pedidos em 7 dias">
                  {inteiro(l.orders_7d)}
                </td>
                <td className="acoes">
                  <span className="seg-acoes">
                    <button className="btn btn--sm" type="button" onClick={() => aoCopiar(l)} aria-label={`Copiar o link ${l.name}`}>
                      <Icone nome="copy" pequeno />
                      Copiar link
                    </button>
                    <button className="btn btn--sm" type="button" aria-haspopup="dialog" onClick={() => aoParametros(l)} aria-label={`Parâmetros e QR do link ${l.name}`}>
                      <Icone nome="qr" pequeno />
                      Parâmetros e QR
                    </button>
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="eixo-nota">Os pedidos de cada link são os que chegaram com o código dele e ficaram com a campanha. Pedido com cupom exclusivo conta pelo cupom.</p>
    </>
  );
}
