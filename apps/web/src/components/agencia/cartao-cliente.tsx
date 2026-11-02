'use client';

import type { AgencyClientResponse } from '@liame/contracts';
import { Icone } from '@/components/ui/icone';
import { dataCompleta, iniciais } from '@/lib/formato';
import { acessoDaAgencia, avisosDoCliente, empresaFechada, seuAcesso, timeDoCliente } from './textos';

// Uma empresa na lista de Clientes (P27 aprovado; A7, W7, parte 2; D-A7-52): o acesso, o que pede atenção nela (só o
// que o nível da pessoa ali deixa ver, decidido no servidor), quem do time está nela e as ações. Quem cuida dos
// clientes (a dona e o administrador) vê o que o dono deu à agência e o time; o membro vê o próprio acesso.

type Props = {
  cliente: AgencyClientResponse;
  /** `agencia.clientes`: a dona e o administrador. */
  cuida: boolean;
  /** `agencia.time`: escolhe quem do time entra. */
  escolhe: boolean;
  aoAbrir: () => void;
  aoEscolher: () => void;
  aoDeixar: () => void;
};

export function CartaoCliente({ cliente: c, cuida, escolhe, aoAbrir, aoEscolher, aoDeixar }: Props) {
  const avisos = avisosDoCliente(c, escolhe);
  const acesso = cuida || !c.my_access ? acessoDaAgencia(c) : seuAcesso(c.my_access);
  return (
    <article className="card cliente" role="listitem" aria-labelledby={`cl-${c.id}`}>
      <div className="cliente-cab">
        <span className="pessoa-av" aria-hidden="true">
          {iniciais(c.organization.name)}
        </span>
        <div>
          <h3 id={`cl-${c.id}`}>{c.organization.name}</h3>
          <p>Parceira desde {dataCompleta(c.since)}</p>
        </div>
      </div>
      <p className="cliente-acesso">{acesso}</p>
      {avisos.length > 0 && (
        <ul className="atencao-lista" aria-label={`O que pede atenção em ${c.organization.name}`}>
          {avisos.map((a) => (
            <li className={`tom-${a.tom}`} key={a.texto}>
              <Icone nome={a.icone} />
              <span>{a.texto}</span>
            </li>
          ))}
        </ul>
      )}
      {cuida && <p className="cliente-time">No time desta empresa: {timeDoCliente(c)}</p>}
      <div className="cliente-acoes">
        {c.my_access && !empresaFechada(c) && (
          <button className="btn btn--sm btn--primary" type="button" onClick={aoAbrir}>
            Abrir a empresa
          </button>
        )}
        {escolhe && (
          <button className="btn btn--sm" type="button" aria-haspopup="dialog" onClick={aoEscolher}>
            Escolher quem entra
          </button>
        )}
        {cuida && (
          <button className="btn btn--sm btn--perigo" type="button" aria-haspopup="dialog" onClick={aoDeixar}>
            Deixar de cuidar
          </button>
        )}
      </div>
    </article>
  );
}
