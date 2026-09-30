'use client';

import { useDetalhes } from '@/lib/modo';
import { Halteres } from './halteres';
import { BotaoDetalhes, SeloVeredito, TextoRico } from './pecas';
import type { CartaoCampanhas as Dados, Celula, LinhaCampanha } from './textos';

// "Por campanha" (protótipo P1): no Lite, cada campanha em palavras simples com "Dá lucro / Empata /
// Dá prejuízo" (ou "Margem incompleta"); no Pro, a tabela com o ROAS da plataforma (na janela dela) ao
// lado do confirmado no caixa, e os halteres. O clique só da plataforma fica numa linha à parte.

function Numero({ c }: { c: Celula }) {
  return (
    <td className={c.forte ? 'n num forte' : 'n num'}>
      {c.texto}
      {c.sub && <span className={c.subAtencao ? 'sub sub--atencao' : 'sub'}>{c.sub}</span>}
    </td>
  );
}

function Celulas({ c }: { c: LinhaCampanha['celulas'] }) {
  return (
    <>
      <Numero c={c.investimento} />
      <Numero c={c.conversas} />
      <Numero c={c.pedidos} />
      <Numero c={c.receita} />
      <Numero c={c.margem} />
      <Numero c={c.custoPorPedido} />
      <Numero c={c.roasPlataforma} />
      <Numero c={c.roasCaixa} />
    </>
  );
}

export function CartaoCampanhas({ campanhas, rotuloPeriodo }: { campanhas: Dados; rotuloPeriodo: string }) {
  const d = useDetalhes();
  return (
    <article className="card" aria-labelledby="t-camp">
      <div className="card-cab">
        <div>
          <h2 id="t-camp">Por campanha</h2>
          {!d.pro && (
            <p className="card-sub">Quais campanhas dão lucro depois de pagar o anúncio. “Dá lucro” e “dá prejuízo” só aparecem com 80% ou mais das vendas com custo.</p>
          )}
          {d.mostraPro && <p className="card-sub">Cada linha compara o ROAS que a plataforma informa, na janela dela, com o confirmado no caixa, na janela de 7 dias do Liame.</p>}
        </div>
        {d.mostraPro && !campanhas.vazio && (
          <div className="legenda" aria-hidden="true">
            <span>
              <i />
              Plataforma
            </span>
            <span>
              <i className="lg-caixa" />
              Confirmado no caixa
            </span>
          </div>
        )}
      </div>

      {campanhas.vazio ? (
        <p className="lite-frase">{campanhas.vazio}</p>
      ) : (
        <>
          {!d.pro && (
            <ul className="camp-lite" aria-label="Campanhas em palavras simples">
              {campanhas.lite.map((c) => (
                <li className="camp-lite-item" key={c.id}>
                  <div className="cl-nome">
                    <b>{c.nome}</b>
                    <span>{c.sub}</span>
                  </div>
                  <div className="cl-valor">
                    <span>{c.valor}</span>
                    {c.detalhe && <span className="cl-sobra">{c.detalhe}</span>}
                  </div>
                  {c.veredito && <SeloVeredito veredito={c.veredito} />}
                </li>
              ))}
            </ul>
          )}
          {!d.pro &&
            campanhas.soPlataforma.map((s) => (
              <p className="lite-frase" key={s.provider}>
                <TextoRico frase={s.frase} />
              </p>
            ))}
          {!d.pro && <BotaoDetalhes aberto={d.aberto} controla="camp-pro" aoAlternar={d.alternar} />}
          <div className="res-pro" id="camp-pro" hidden={!d.mostraPro}>
            <div className="table-wrap">
              <table className="tabela tabela--camp">
                <caption className="sr-only">
                  Resultado por campanha em {rotuloPeriodo}: investimento, conversas, pedidos, receita, margem conhecida, custo por pedido, ROAS da plataforma e ROAS confirmado no caixa
                </caption>
                <thead>
                  <tr>
                    <th scope="col">Campanha</th>
                    <th scope="col" className="n">
                      Investimento
                    </th>
                    <th scope="col" className="n">
                      Conversas
                    </th>
                    <th scope="col" className="n">
                      Pedidos
                    </th>
                    <th scope="col" className="n">
                      Receita
                    </th>
                    <th scope="col" className="n">
                      Margem conhecida
                    </th>
                    <th scope="col" className="n">
                      Custo por pedido
                    </th>
                    <th scope="col" className="n">
                      ROAS plataforma
                    </th>
                    <th scope="col" className="n">
                      ROAS caixa
                    </th>
                    <th scope="col">Plataforma × caixa</th>
                  </tr>
                </thead>
                <tbody>
                  {campanhas.linhas.map((l) => (
                    <tr key={l.id}>
                      <th scope="row">
                        {l.nome}
                        <span className="camp-canal">
                          <span className={`plat plat--${l.classe}`}>{l.nomePlataforma}</span>
                          {l.situacao}
                        </span>
                      </th>
                      <Celulas c={l.celulas} />
                      <td>{l.halteres ? <Halteres plataforma={l.halteres.plataforma} caixa={l.halteres.caixa} rotulo={l.rotuloHalteres} /> : <span className="eixo-nota">—</span>}</td>
                    </tr>
                  ))}
                  {campanhas.soPlataforma.map((s) => (
                    <tr className="linha-plat" key={s.provider}>
                      <th scope="row">
                        {s.titulo}
                        <span className="camp-canal">id de clique, sem o id da campanha</span>
                      </th>
                      <td className="n">—</td>
                      <td className="n">—</td>
                      <td className="n num">{s.pedidos}</td>
                      <td className="n num">{s.receita}</td>
                      <td className="n">—</td>
                      <td className="n">—</td>
                      <td className="n">—</td>
                      <td className="n">—</td>
                      <td>
                        <span className="eixo-nota">{s.nota}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <th scope="row">Total</th>
                    <Celulas c={campanhas.total} />
                    <td />
                  </tr>
                </tfoot>
              </table>
            </div>
            <p className="eixo-nota">Escala de 0 a 7. A linha vertical marca ROAS 1, o ponto em que a mídia se paga.</p>
          </div>
        </>
      )}
    </article>
  );
}
