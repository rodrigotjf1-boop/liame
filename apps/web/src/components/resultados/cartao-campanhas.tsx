'use client';

import { BotaoPedir, type PedirNaLista } from '@/components/pedir/botao-pedir';
import { mostraOPedir, notaDoPedir } from '@/components/pedir/textos';
import { useDetalhes } from '@/lib/modo';
import { Halteres } from './halteres';
import { BotaoDetalhes, SeloVeredito, TextoRico } from './pecas';
import type { CartaoCampanhas as Dados, Celula, LinhaCampanha } from './textos';

// "Por campanha" (protótipo P1): no Lite, cada campanha em palavras simples com "Dá lucro / Empata /
// Dá prejuízo" (ou "Margem incompleta"); no Pro, a tabela com o ROAS da plataforma (na janela dela) ao
// lado do confirmado no caixa, e os halteres. O clique só da plataforma fica numa linha à parte.
// Com o pedido de mudança (protótipo P9), cada campanha em que o Liame pode mexer ganha o botão "Pedir mudança":
// ao lado dela no Lite e na coluna "Mudar" do Pro (no celular, embaixo do nome).

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

type Props = {
  campanhas: Dados;
  rotuloPeriodo: string;
  /** O pedido de mudança nas campanhas (nulo para quem não acompanha as campanhas, ou antes de a lista chegar). */
  pedir?: PedirNaLista | null;
};

export function CartaoCampanhas({ campanhas, rotuloPeriodo, pedir = null }: Props) {
  const d = useDetalhes();
  // A coluna só existe quando alguma campanha à vista tem o que mostrar nela.
  const comPedir =
    pedir &&
    mostraOPedir(
      campanhas.linhas.map((l) => l.id),
      pedir.porCampanha,
      pedir.podePedir,
    )
      ? pedir
      : null;
  const nota = comPedir
    ? notaDoPedir(
        campanhas.linhas.filter((l) => comPedir.porCampanha.has(l.id)).map((l) => l.provider),
        campanhas.linhas.filter((l) => !comPedir.porCampanha.has(l.id)).map((l) => l.provider),
      )
    : null;
  // Campanha de plataforma em que o Liame não muda nada: a coluna diz por quê.
  const comBotao = new Set(comPedir ? campanhas.linhas.filter((l) => comPedir.porCampanha.has(l.id)).map((l) => l.provider) : []);

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
            <ul className={comPedir ? 'camp-lite camp-lite--pedir' : 'camp-lite'} aria-label="Campanhas em palavras simples">
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
                  {comPedir && (
                    <div className="cl-pedir">
                      <BotaoPedir campanha={c} pedir={comPedir} />
                    </div>
                  )}
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
          {!d.pro && nota && <p className="eixo-nota">{nota}</p>}
          {!d.pro && <BotaoDetalhes aberto={d.aberto} controla="camp-pro" aoAlternar={d.alternar} />}
          <div className="res-pro" id="camp-pro" hidden={!d.mostraPro}>
            <div className="table-wrap">
              <table className="tabela tabela--camp">
                <caption className="sr-only">
                  Resultado por campanha em {rotuloPeriodo}: investimento, conversas, pedidos, receita, margem conhecida, custo por pedido, ROAS da plataforma e ROAS confirmado no caixa
                  {comPedir ? '; na última coluna, o pedido de mudança' : ''}
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
                    {comPedir && (
                      <th scope="col" className="mudar">
                        Mudar
                      </th>
                    )}
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
                        {/* No celular a tabela rola de lado e a coluna "Mudar" some: o botão fica embaixo do nome. */}
                        {comPedir && comPedir.porCampanha.has(l.id) && (
                          <span className="mudar-linha">
                            <BotaoPedir campanha={l} pedir={comPedir} curto />
                          </span>
                        )}
                      </th>
                      <Celulas c={l.celulas} />
                      <td>{l.halteres ? <Halteres plataforma={l.halteres.plataforma} caixa={l.halteres.caixa} rotulo={l.rotuloHalteres} /> : <span className="eixo-nota">—</span>}</td>
                      {comPedir && (
                        <td className="mudar">
                          {comPedir.porCampanha.has(l.id) ? <BotaoPedir campanha={l} pedir={comPedir} curto /> : !comBotao.has(l.provider) && <span className="eixo-nota">só leitura</span>}
                        </td>
                      )}
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
                      {comPedir && <td className="mudar" />}
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <th scope="row">Total</th>
                    <Celulas c={campanhas.total} />
                    <td />
                    {comPedir && <td className="mudar" />}
                  </tr>
                </tfoot>
              </table>
            </div>
            <p className="eixo-nota">Escala de 0 a 7. A linha vertical marca ROAS 1, o ponto em que a mídia se paga.</p>
            {nota && <p className="eixo-nota">{nota}</p>}
          </div>
        </>
      )}
    </article>
  );
}
