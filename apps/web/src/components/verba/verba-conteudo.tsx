'use client';

import type { BudgetLimitsRequest } from '@liame/contracts';
import Link from 'next/link';
import type { Ref } from 'react';
import { DicaDosDesenhos } from '@/components/resultados/desenhos';
import { BotaoDetalhes } from '@/components/resultados/pecas';
import { ListaDeFontes, NumeroComFonte, TextoComNumeros, useFontes } from '@/components/resumo/numeros';
import { Estado } from '@/components/ui/estado';
import { Faixa } from '@/components/ui/faixa';
import { Icone } from '@/components/ui/icone';
import type { Problema } from '@/lib/api';
import { useDetalhes } from '@/lib/modo';
import { BarraDoTeto } from './barra-do-teto';
import { GraficoDoMes, OndeOGastoFoi, SeloDaVerba, TabelaDosDias } from './desenhos';
import { FormLimites } from './form-limites';
import type { AvisoDaVerba, TelaDaVerba } from './textos';

// O corpo da tela Verba do mês (A4 · P9, aprovado em 05/10/2026) com os dados já lidos: as faixas do topo, o gasto do
// mês contra o teto, os limites da empresa e o que o Liame mudou, conferido todo dia. Separado da busca para ser
// desenhado igual no teste e no navegador. No Lite, o que é do Pro fica a um "Ver detalhes" (nada some).
// O cartão do mês leva os desenhos do protótipo `mockups/prototipo-verba-graficos.html` (aprovado em 07/10/2026): o
// selo, "O mês, dia a dia" e "Onde o gasto foi"; a barra do teto só entra quando a resposta não traz o gasto de cada dia.

type Props = {
  tela: TelaDaVerba;
  /** Os limites de agora, em micros: o formulário abre com eles. */
  limites: { mes: number | null; campanha: number | null };
  /** Quem define os limites (`orcamento.gerenciar`): o Dono e o Administrador. */
  podeDefinir: boolean;
  podeVerContas: boolean;
  /** Quem vê as campanhas em Resultados (`vendas.ver`). */
  podeVerResultados: boolean;
  editando: boolean;
  aoEditar: () => void;
  aoCancelar: () => void;
  aoSalvar: (corpo: BudgetLimitsRequest) => Promise<Problema | null>;
  /** O botão "Definir os limites" / "Mudar os limites": o foco volta para ele depois de salvar ou cancelar. */
  botaoEditar?: Ref<HTMLButtonElement>;
};

function AcaoDoAviso({ a, podeVerContas, podeVerResultados }: { a: AvisoDaVerba; podeVerContas: boolean; podeVerResultados: boolean }) {
  if (a.acao === 'contas' && podeVerContas) {
    return (
      <Link className="btn" href="/contas">
        Ver a conexão
      </Link>
    );
  }
  if (a.acao === 'campanhas' && podeVerResultados) {
    return (
      <Link className="btn" href="/resultados">
        Ver as campanhas
      </Link>
    );
  }
  return null;
}

export function VerbaConteudo({ tela, limites, podeDefinir, podeVerContas, podeVerResultados, editando, aoEditar, aoCancelar, aoSalvar, botaoEditar }: Props) {
  const fontes = useFontes(tela.fontes);
  const doMes = useDetalhes();
  const dasMudancas = useDetalhes();
  const { heroi: h, desenhos: d, plataformas: p, limites: l, mudancas: m } = tela;
  const numero = (texto: Parameters<typeof TextoComNumeros>[0]['texto']) => <TextoComNumeros texto={texto} lista={tela.fontes} aoTocar={fontes.mostrar} />;
  const tres = (gasto: string, ritmo: string, previsto: string) => (
    <>
      <td className="n num" data-rot="Gasto até ontem">
        {gasto}
      </td>
      <td className="n num" data-rot="Ritmo por dia">
        {ritmo}
      </td>
      <td className="n num" data-rot="Previsão do mês">
        {previsto}
      </td>
    </>
  );

  return (
    <div className="verba">
      {tela.avisos.length > 0 && (
        <div className="verba-avisos">
          {tela.avisos.map((a) => (
            <Faixa key={a.chave} tipo={a.tipo} icone={<Icone nome={a.icone} />} titulo={a.titulo} texto={a.texto} acao={<AcaoDoAviso a={a} podeVerContas={podeVerContas} podeVerResultados={podeVerResultados} />} />
          ))}
        </div>
      )}

      {tela.semContas ? (
        <div className="card">
          <Estado
            icone="plug"
            titulo="Conecte uma conta de anúncio para acompanhar a verba"
            acao={
              podeVerContas ? (
                <div className="vazio-acoes">
                  <Link className="btn btn--primary" href="/contas">
                    Abrir Contas conectadas
                  </Link>
                </div>
              ) : undefined
            }
          >
            A verba do mês soma o que as contas da Meta e do Google gastam em anúncios. Sem uma conta conectada, não há gasto para mostrar. Os limites da empresa já podem ser definidos.
          </Estado>
        </div>
      ) : (
        <article className="card verba-heroi" aria-labelledby="vb-t">
          <div className="card-cab">
            <h2 id="vb-t" className="rotulo-marca">
              {h.titulo}
            </h2>
            <span className="lite-chip">{h.chip}</span>
          </div>
          <p className="verba-num num">
            <NumeroComFonte num={h.numero} lista={tela.fontes} aoTocar={fontes.mostrar} />
            <small>{h.sub}</small>
          </p>
          <SeloDaVerba veredito={d.veredito} />
          {d.mes ? <GraficoDoMes mes={d.mes} /> : h.barra && <BarraDoTeto barra={h.barra} />}
          <div className="verba-stats" role="group" aria-label="A conta do mês">
            {h.stats.map((s) => (
              <div className="kpi" key={s.rotulo}>
                <p className="kpi-rot">{s.rotulo}</p>
                <p className="kpi-val num">{s.falta ? <span className="limite-val--falta">{numero(s.valor)}</span> : numero(s.valor)}</p>
                <p className="kpi-sub">{numero(s.sub)}</p>
              </div>
            ))}
          </div>
          {d.onde.length > 0 && <OndeOGastoFoi plataformas={d.onde} />}
          {!doMes.pro && <BotaoDetalhes aberto={doMes.aberto} controla="verba-pro" aoAlternar={doMes.alternar} />}
          {/* O bloco existe sempre (é o alvo do "Ver detalhes"); fechado, fica oculto, como nos cartões de Resultados. */}
          <div className="res-pro" id="verba-pro" hidden={!doMes.mostraPro}>
            {doMes.mostraPro && (
              <>
                <div className="table-wrap">
                  <table className="tabela tabela--pilha">
                    <caption className="sr-only">{p.legenda}</caption>
                    <thead>
                      <tr>
                        <th scope="col">Plataforma</th>
                        <th scope="col" className="n">
                          Gasto até ontem
                        </th>
                        <th scope="col" className="n">
                          Ritmo por dia
                        </th>
                        <th scope="col" className="n">
                          Previsão do mês
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {p.linhas.map((linha) => (
                        <tr key={linha.provider}>
                          <th scope="row">
                            <span className={linha.classe ? `plat plat--${linha.classe}` : 'plat'}>{linha.nome}</span>
                            {linha.nota && <span className="sub">{linha.nota}</span>}
                          </th>
                          {tres(linha.gasto, linha.ritmo, linha.previsto)}
                        </tr>
                      ))}
                    </tbody>
                    <tfoot>
                      <tr>
                        <th scope="row">Total</th>
                        {tres(p.total.gasto, p.total.ritmo, p.total.previsto)}
                      </tr>
                    </tfoot>
                  </table>
                </div>
                <p className="eixo-nota">{p.nota}</p>
                {d.dias && <TabelaDosDias dias={d.dias} />}
              </>
            )}
          </div>
        </article>
      )}

      <article className="card" aria-labelledby="lm-t">
        <div className="card-cab">
          <div>
            <h2 id="lm-t">Limites da empresa</h2>
            <p className="card-sub">{podeDefinir ? 'Você define; o Liame nega o pedido que passar.' : 'A empresa define; o Liame nega o pedido que passar.'}</p>
          </div>
          {podeDefinir && !editando && (
            <button className="btn btn--sm" type="button" ref={botaoEditar} onClick={aoEditar}>
              <Icone nome="pencil" pequeno />
              {l.definidos ? 'Mudar os limites' : 'Definir os limites'}
            </button>
          )}
        </div>
        <div className="limites-grade">
          <div className="limites-lado">
            {editando ? (
              <FormLimites limites={l} atuais={limites} aoSalvar={aoSalvar} aoCancelar={aoCancelar} />
            ) : (
              <>
                <div className="limites-dois">
                  <div className="limite">
                    <p className="limite-rot">Teto do mês</p>
                    {l.mes ? <p className="limite-val">{l.mes}</p> : <p className="limite-val limite-val--falta">Ainda não definido</p>}
                    <p className="limite-sub">
                      Tudo o que a empresa pode gastar em anúncios por mês, na Meta e no Google. Vale para cada mês, até {podeDefinir ? 'você' : 'a empresa'} mudar.
                    </p>
                  </div>
                  <div className="limite">
                    <p className="limite-rot">Teto por campanha</p>
                    {l.campanha ? <p className="limite-val">{l.campanha}</p> : <p className="limite-val limite-val--falta">Ainda não definido</p>}
                    <p className="limite-sub">A maior verba diária que um aumento pode deixar numa campanha ou num conjunto. Reduzir é sempre permitido.</p>
                  </div>
                </div>
                {l.definidos ? (
                  l.quem && <p className="eixo-nota">{l.quem}</p>
                ) : (
                  <p className="pd-aviso">
                    <Icone nome="alert" />
                    <span>Sem os dois limites, o Liame só reduz verba e pausa. Aumentar e retomar ficam negados.</span>
                  </p>
                )}
                {!podeDefinir && (
                  <p className="nota">
                    <Icone nome="lock" />
                    <span>Só o Dono e o Administrador mudam os limites. Você acompanha por aqui.</span>
                  </p>
                )}
              </>
            )}
          </div>
          <div>
            <p className="rotulo-marca">Regras da Liame, que valem sempre</p>
            <ul className="regras-liame">
              {l.regras.map((regra) => (
                <li key={regra}>
                  <Icone nome="check" />
                  <span>{regra}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </article>

      <article className="card" aria-labelledby="md-t">
        <div className="card-cab">
          <div>
            <h2 id="md-t">{m.titulo}</h2>
            <p className="card-sub">{m.sub}</p>
          </div>
          <Link className="btn btn--ghost btn--sm" href="/aprovacoes">
            Ver os pedidos
          </Link>
        </div>
        {m.linhas.length ? (
          <>
            <div className="table-wrap" id="verba-mudancas">
              <table className="tabela tabela--compacta tabela--pilha">
                <caption className="sr-only">{m.legenda}</caption>
                <thead>
                  <tr>
                    <th scope="col">Quando</th>
                    <th scope="col">O que mudou</th>
                    {dasMudancas.mostraPro && <th scope="col">{m.colunaInforma}</th>}
                    {dasMudancas.mostraPro && <th scope="col">Gasto depois</th>}
                    <th scope="col">Situação</th>
                  </tr>
                </thead>
                <tbody>
                  {m.linhas.map((linha) => (
                    <tr key={linha.id}>
                      <td className="num" data-rot="Quando">
                        {linha.quando}
                      </td>
                      <th scope="row">
                        {linha.oque}
                        <span className="sub">{linha.dequem}</span>
                      </th>
                      {dasMudancas.mostraPro && (
                        <td className="num" data-rot={m.colunaInforma}>
                          {linha.informa}
                        </td>
                      )}
                      {dasMudancas.mostraPro && (
                        <td className="num" data-rot="Gasto depois">
                          {linha.gasto}
                          {linha.media && <span className="sub">{linha.media}</span>}
                        </td>
                      )}
                      <td className="larga" data-rot="Situação">
                        <span className={`concilia-sit concilia-sit--${linha.situacao}`}>
                          <Icone nome={linha.icone} />
                          {linha.rotulo}
                        </span>
                        {linha.nota && <span className="sub">{linha.nota}</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {!dasMudancas.pro && <BotaoDetalhes aberto={dasMudancas.aberto} controla="verba-mudancas" aoAlternar={dasMudancas.alternar} />}
            <p className="eixo-nota">{m.nota}</p>
            {m.deAntes && <p className="eixo-nota">{m.deAntes}</p>}
          </>
        ) : (
          <Estado compacto icone="history" titulo={m.vazio.titulo}>
            {m.vazio.texto}
          </Estado>
        )}
      </article>

      <ListaDeFontes lista={tela.fontes} estado={fontes} id="verba-fontes" />
      <DicaDosDesenhos />
    </div>
  );
}
