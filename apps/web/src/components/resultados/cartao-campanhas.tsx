'use client';

import type { LinhaDasVendas } from '@/components/contas/vendas-google';
import { BotaoPedir, type PedirNaLista } from '@/components/pedir/botao-pedir';
import { mostraOPedir, notaDoPedir } from '@/components/pedir/textos';
import { useDetalhes } from '@/lib/modo';
import { ListaDeCampanhas } from './campanhas-lite';
import type { CampanhasLite } from './graficos';
import { Halteres } from './halteres';
import { LinhaVendasGoogle } from './linha-vendas-google';
import { BotaoDetalhes, SeloVeredito, TextoRico } from './pecas';
import type { CartaoCampanhas as Dados, Celula, LinhaCampanha } from './textos';

// "Por campanha". No modo simples (protótipo de Resultados em gráficos, 07/10/2026): cada campanha numa barra para a
// direita (sobrou) ou para a esquerda (faltou), com "Dá lucro / Empata / Dá prejuízo" (ou "Margem incompleta"). No
// Pro (protótipo P1): a tabela com o ROAS da plataforma (na janela dela) ao lado do confirmado no caixa, e os
// halteres. O clique só da plataforma fica numa linha à parte.
// Com o pedido de mudança (protótipo P9), cada campanha em que o Liame pode mexer ganha o botão "Pedir mudança":
// ao lado dela no Lite e na coluna "Mudar" do Pro (no celular, embaixo do nome).
// Com "vendas informadas ao Google" ligado (protótipo P14, parte B), uma linha embaixo da lista diz quantas vendas o
// Liame informou ao Google: no modo simples, antes de "Ver detalhes"; no Pro, embaixo da tabela (uma vez só).

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
  /** O desenho do modo simples. */
  lite: CampanhasLite;
  rotuloPeriodo: string;
  /** O pedido de mudança nas campanhas (nulo para quem não acompanha as campanhas, ou antes de a lista chegar). */
  pedir?: PedirNaLista | null;
  /** A linha das vendas informadas ao Google; nula sem a função ligada ou para quem não vê as contas. */
  vendasAoGoogle?: LinhaDasVendas | null;
};

export function CartaoCampanhas({ campanhas, lite, rotuloPeriodo, pedir = null, vendasAoGoogle = null }: Props) {
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
          <h2 id="t-camp">{d.pro || campanhas.vazio ? 'Por campanha' : lite.titulo}</h2>
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
            <div className="desenho-b">
              <ListaDeCampanhas campanhas={lite} pedir={comPedir} />
            </div>
          )}
          {!d.pro &&
            campanhas.soPlataforma.map((s) => (
              <p className="lite-frase" key={s.provider}>
                <TextoRico frase={s.frase} />
              </p>
            ))}
          {!d.pro && nota && <p className="eixo-nota">{nota}</p>}
          {!d.pro && vendasAoGoogle && <LinhaVendasGoogle linha={vendasAoGoogle} />}
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
            {d.pro && vendasAoGoogle && <LinhaVendasGoogle linha={vendasAoGoogle} />}
          </div>
        </>
      )}
    </article>
  );
}
