'use client';

import type { Ref } from 'react';

// "O cupom é exclusivo desta campanha?" (ligar e informar): só o exclusivo prova de onde veio o pedido.

type Props = {
  nome: string;
  valor: '' | 'sim' | 'nao';
  textoSim: string;
  erro?: string;
  primeiroRef?: Ref<HTMLInputElement>;
  aoMudar: (v: 'sim' | 'nao') => void;
};

export function CampoExclusivo({ nome, valor, textoSim, erro, primeiroRef, aoMudar }: Props) {
  const idErro = `${nome}-erro`;
  return (
    <fieldset className="campo">
      <legend>O cupom é exclusivo desta campanha?</legend>
      <div className="opcoes">
        <label className="opcao">
          <input
            ref={primeiroRef}
            type="radio"
            name={nome}
            value="sim"
            checked={valor === 'sim'}
            onChange={() => aoMudar('sim')}
            aria-describedby={erro ? idErro : undefined}
          />
          <span className="opcao-txt">
            <b>Sim, só esta campanha divulga o cupom</b>
            <span>{textoSim}</span>
          </span>
        </label>
        <label className="opcao">
          <input type="radio" name={nome} value="nao" checked={valor === 'nao'} onChange={() => aoMudar('nao')} aria-describedby={erro ? idErro : undefined} />
          <span className="opcao-txt">
            <b>Não, ele aparece em outros lugares</b>
            <span>O cupom fica ligado para acompanhar os usos, mas não conta como evidência.</span>
          </span>
        </label>
      </div>
      {erro && (
        <p className="campo-erro" id={idErro}>
          {erro}
        </p>
      )}
    </fieldset>
  );
}
