'use client';

import Link from 'next/link';
import { Estado } from '@/components/ui/estado';
import { useDetalhes } from '@/lib/modo';
import { BotaoDetalhes } from './pecas';
import type { CartaoOrigem as Dados } from './textos';

// "De onde vieram os pedidos" (protótipo P1): pedido só ganha campanha com evidência; os sem origem (com
// a porcentagem sobre os canais com clique), os canais sem clique e os cancelados aparecem à parte.

export function CartaoOrigem({ origem, podeVerContas }: { origem: Dados; podeVerContas: boolean }) {
  const d = useDetalhes();
  return (
    <article className="card" aria-labelledby="t-origem">
      <div className="card-cab">
        <div>
          <h2 id="t-origem">De onde vieram os pedidos</h2>
          <p className="card-sub">Pedido só ganha campanha com evidência; o resto aparece aqui, separado.</p>
        </div>
      </div>

      {origem.tipo === 'sem-regem' && (
        <Estado
          compacto
          icone="plug"
          titulo="Conecte o Regem para ver de onde vieram os pedidos"
          acao={
            podeVerContas ? (
              <div className="vazio-acoes">
                <Link className="btn" href="/contas">
                  Abrir Contas conectadas
                </Link>
              </div>
            ) : undefined
          }
        >
          A origem de cada pedido sai do caixa da loja, ligada aos cliques, às conversas e aos cupons das campanhas.
        </Estado>
      )}

      {origem.tipo === 'sem-pedido' && (
        <Estado compacto icone="clock" titulo={origem.titulo}>
          {origem.texto}
        </Estado>
      )}

      {origem.tipo === 'ok' && (
        <>
          {!d.pro && (
            <ul className="origem-lite">
              {origem.lite.map((i) => (
                <li key={i.titulo}>
                  <span className="origem-n num">{i.numero}</span>
                  <span>
                    <b>{i.titulo}</b>
                    {i.texto}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {!d.pro && <BotaoDetalhes aberto={d.aberto} controla="origem-pro" aoAlternar={d.alternar} />}
          <div className="origem-grid" id="origem-pro" hidden={!d.mostraPro}>
            <section className="bloco" aria-labelledby="t-sem">
              <h3 id="t-sem">Pedidos sem origem</h3>
              <p className="bloco-num num">{origem.semOrigem.porcentagem}</p>
              <p className="lite-frase">{origem.semOrigem.frase}</p>
              <p className="eixo-nota">O motivo de cada um aparece em Pedido a pedido, no filtro “Sem origem”.</p>
              {origem.cancelados && <p className="eixo-nota">{origem.cancelados}</p>}
            </section>
            <section className="bloco" aria-labelledby="t-canais">
              <h3 id="t-canais">Canais sem clique</h3>
              <p className="lite-frase">
                Ficam fora do ROAS de mídia própria. Os marketplaces (iFood, 99Food, Keeta) chegam sem identificador do cliente; balcão e outros canais só entram numa campanha por
                cupom exclusivo.
              </p>
              {origem.canais.length ? (
                <div className="table-wrap">
                  <table className="tabela tabela--compacta">
                    <caption className="sr-only">Pedidos dos canais sem clique no período</caption>
                    <thead>
                      <tr>
                        <th scope="col">Canal</th>
                        <th scope="col" className="n">
                          Pedidos
                        </th>
                        <th scope="col" className="n">
                          Receita
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {origem.canais.map((c) => (
                        <tr key={c.grupo}>
                          <th scope="row">{c.grupo}</th>
                          <td className="n num">{c.pedidos}</td>
                          <td className="n num">{c.receita}</td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot>
                      <tr>
                        <th scope="row">{origem.totalCanais.grupo}</th>
                        <td className="n num">{origem.totalCanais.pedidos}</td>
                        <td className="n num">{origem.totalCanais.receita}</td>
                      </tr>
                    </tfoot>
                  </table>
                </div>
              ) : (
                <p className="eixo-nota">Nenhum pedido de canal sem clique no período.</p>
              )}
              <p className="eixo-nota">{origem.loja}</p>
            </section>
          </div>
        </>
      )}
    </article>
  );
}
