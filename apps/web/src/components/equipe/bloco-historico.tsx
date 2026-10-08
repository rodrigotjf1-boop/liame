'use client';

import type { TeamActivityResponse } from '@liame/contracts';
import { Icone } from '@/components/ui/icone';
import type { Modo } from '@/lib/modo';
import { historicoDaAprovacao } from './aprovacao-textos';
import { historicoDo } from './textos';

// "O que fez" (protótipo P7): os acontecimentos do funcionário, do mais novo para o mais antigo. No Lite, o mais
// recente e o caminho para ver tudo no Pro; no Pro, a lista inteira que a API mandou.

export type Historico = { tipo: 'carregando' } | { tipo: 'ok'; dados: TeamActivityResponse } | { tipo: 'erro' };

export function BlocoHistorico({
  historico,
  modo,
  agora,
  aoIrParaPro,
  aoTentarDeNovo,
}: {
  historico: Historico;
  modo: Modo;
  agora: Date;
  aoIrParaPro: () => void;
  aoTentarDeNovo: () => void;
}) {
  let corpo;
  if (historico.tipo === 'carregando') {
    corpo = (
      <div aria-busy="true">
        <p className="sr-only">Carregando o que ele fez…</p>
        <span className="esqueleto" aria-hidden="true" />
        <span className="esqueleto esqueleto--medio" aria-hidden="true" />
      </div>
    );
  } else if (historico.tipo === 'erro') {
    corpo = (
      <>
        <p className="card-sub" role="alert">
          Não foi possível carregar o histórico. Nada foi perdido.
        </p>
        <button className="btn btn--sm" type="button" onClick={aoTentarDeNovo}>
          <Icone nome="refresh" pequeno />
          Tentar de novo
        </button>
      </>
    );
  } else if (!historico.dados.items.length) {
    corpo = <p className="card-sub">Nada ainda. Quando ele trabalhar, cada coisa aparece aqui, com o resultado.</p>;
  } else {
    const itens = historico.dados.items;
    const visiveis = modo === 'lite' ? itens.slice(0, 1) : itens;
    corpo = (
      <>
        <ul className="eqp-hist">
          {visiveis.map((i, n) => {
            // Os tipos do modo Aprovação (o pedido dele, a proposta, a volta) têm os textos deles.
            const linha = { ...historicoDo(i, agora), ...historicoDaAprovacao(i) };
            return (
              <li key={`${i.at}-${i.kind}-${n}`}>
                <time dateTime={i.at}>{linha.quando}</time>
                <div>
                  <b>{linha.titulo}</b>
                  {linha.texto && <p>{linha.texto}</p>}
                </div>
              </li>
            );
          })}
        </ul>
        {modo === 'lite' && itens.length > 1 && (
          <button className="detalhes-bt" type="button" onClick={aoIrParaPro}>
            <Icone nome="chevron-down" />
            <span className="rot">Ver tudo no Pro</span>
          </button>
        )}
        {modo === 'pro' && historico.dados.has_more && <p className="explica-nota">Aqui estão os {itens.length} acontecimentos mais recentes dos últimos 90 dias.</p>}
      </>
    );
  }
  return (
    <div className="eqp-bloco">
      <div className="eqp-bloco-cab">
        <h3>O que fez</h3>
      </div>
      {corpo}
    </div>
  );
}
