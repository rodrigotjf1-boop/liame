'use client';

import type { ActionResponse } from '@liame/contracts';
import { type RefObject, useEffect, useId, useState } from 'react';
import { Icone } from '@/components/ui/icone';
import { BarraDaDecisao, type Decisao } from './barra-da-decisao';
import { apresentar, aprovacaoParcial, cabecalhoDe, type Grupo, identidadeDoPlano, MOTIVOS_DA_RECUSA, politicaDe, prazoDe, resultadoDe, riscoDe, ROTULO_RISCO } from './textos';

// O pedido aberto (protótipo aprovado): quem pediu e quando, o que muda, o risco e os limites, e a decisão.
// Aprovar pede o código do app autenticador agora (ADR-007) e vale só para o plano mostrado (o hash); recusar
// pede um motivo. No Lite, a frase do que acontece e "Ver detalhes"; no Pro, tudo aberto.

export type { Decisao };

type Props = {
  acao: ActionResponse;
  grupo: Grupo | null;
  agora: Date;
  pro: boolean;
  /** Pode aprovar e recusar (`acoes.aprovar`). */
  podeDecidir: boolean;
  /** A conta de quem vê tem o app autenticador ativo (sem ele, o servidor não deixa aprovar). */
  temApp: boolean;
  titulo: RefObject<HTMLHeadingElement | null>;
  campoCodigo: RefObject<HTMLInputElement | null>;
  aoVoltar: () => void;
  aoAprovar: (acao: ActionResponse, codigo: string) => Promise<Decisao>;
  aoRecusar: (acao: ActionResponse, motivo: string) => Promise<Decisao>;
};

const MOTIVOS = MOTIVOS_DA_RECUSA.map((m) => ({ valor: m, rotulo: m }));

export function DetalhePedido({ acao, grupo, agora, pro, podeDecidir, temApp, titulo, campoCodigo, aoVoltar, aoAprovar, aoRecusar }: Props) {
  const ids = useId();
  const [aberto, setAberto] = useState(false);
  const p = apresentar(acao);
  const cab = cabecalhoDe(acao, agora);
  const plano = identidadeDoPlano(acao);
  const risco = riscoDe(acao);
  const prazo = prazoDe(acao, agora);
  const detalhado = pro || aberto;

  // Outro pedido aberto: os detalhes abertos eram do anterior (o código e o erro saem com a barra, pela `key`).
  useEffect(() => {
    setAberto(false);
  }, [acao.id, acao.plan_hash]);

  const voltar = (
    <button className="btn btn--ghost btn--sm voltar" type="button" onClick={aoVoltar}>
      <Icone nome="chevron-left" />
      Voltar para a lista
    </button>
  );
  const cabecalho = (
    <>
      <div className="det-cab">
        <span>
          <b>{cab.quem}</b> {cab.verbo}
        </span>
        <span>· {cab.quando}</span>
      </div>
      <h2 className="det-titulo" id="ap-det-titulo" ref={titulo} tabIndex={-1}>
        {p.titulo}
      </h2>
    </>
  );
  const mudancas = (
    <div className="secao">
      <p className="rotulo-marca">Antes e depois</p>
      <div className="table-wrap">
        <table className="tabela">
          <caption className="sr-only">O que muda se o pedido for aprovado</caption>
          <thead>
            <tr>
              <th scope="col">Item</th>
              <th scope="col">Agora</th>
              <th scope="col">Depois</th>
            </tr>
          </thead>
          <tbody>
            {p.mudancas.map(([item, antes, depois]) => (
              <tr key={item}>
                <th scope="row">{item}</th>
                <td className="ap-antes">{antes}</td>
                <td className="ap-depois">{depois}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );

  if (grupo !== 'pendente') {
    const resultado = resultadoDe(acao);
    return (
      <>
        {voltar}
        {cabecalho}
        <p className="plano-id">
          Plano {plano.plano} · hash <b>{plano.hash}</b>
        </p>
        <div className="secao">
          <div className="politica">
            <Icone nome={resultado.ok ? 'check' : 'x'} />
            <span>{resultado.texto}</span>
          </div>
        </div>
        {mudancas}
      </>
    );
  }

  const parcial = aprovacaoParcial(acao);
  return (
    <>
      {voltar}
      {cabecalho}
      {!pro && (
        <div className="secao secao--lite">
          <p className="lite-frase lite-frase--grande">{p.resumo}</p>
          <div className="lite-chips">
            <span className={`risco risco--${risco}`}>{ROTULO_RISCO[risco]}</span>
            <span className="lite-chip">Dá para desfazer</span>
            <span className="lite-chip">{prazo}</span>
          </div>
          <button className="detalhes-bt" type="button" aria-expanded={aberto} aria-controls={`${ids}-detalhes`} onClick={() => setAberto((x) => !x)}>
            {aberto ? 'Ocultar detalhes' : 'Ver detalhes'}
            <Icone nome="chevron-down" pequeno />
          </button>
        </div>
      )}
      <div id={`${ids}-detalhes`} hidden={!detalhado}>
        <p className="plano-id">
          Plano {plano.plano} · hash <b>{plano.hash}</b> · a aprovação vale só para este plano
        </p>
        {mudancas}
        <div className="secao">
          <p className="rotulo-marca">Risco e limites</p>
          <div className="politica">
            <Icone nome="shield" />
            <span>
              <b className={`risco risco--${risco}`}>{ROTULO_RISCO[risco]}.</b> {politicaDe(acao)}
            </span>
          </div>
          <p className="nota">
            <Icone nome="undo" />
            <span>{p.desfazer}</span>
          </p>
          <p className="nota">
            <Icone nome="clock" />
            <span>Prazo: {prazo}. Se ninguém decidir, o pedido expira e nada é feito.</span>
          </p>
        </div>
      </div>
      {parcial && (
        <p className="alerta-versao" role="status">
          <Icone nome="info" pequeno />
          <span>{parcial}</span>
        </p>
      )}
      {podeDecidir ? (
        <BarraDaDecisao
          key={`${acao.id}:${acao.plan_hash}`}
          ids={ids}
          temApp={temApp}
          campoCodigo={campoCodigo}
          motivos={MOTIVOS}
          dica="O código de 6 números que o app autenticador mostra agora. A aprovação vale só para este plano."
          aoAprovar={(codigo) => aoAprovar(acao, codigo)}
          aoRecusar={(motivo) => aoRecusar(acao, motivo)}
        />
      ) : (
        <p className="nota ap-so-leitura">
          <Icone nome="lock" />
          <span>Só quem pode aprovar decide este pedido. Você acompanha por aqui.</span>
        </p>
      )}
    </>
  );
}
