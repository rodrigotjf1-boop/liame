'use client';

import type { OwnershipResponse } from '@liame/contracts';
import { useState } from 'react';
import { useAvisar } from '@/components/ui/avisos';
import { ConfirmaNaLinha } from '@/components/ui/confirma-na-linha';
import { api, chamar, mensagemDe } from '@/lib/api';
import { disparar } from '@/lib/disparar';
import { dataCompleta, iniciais } from '@/lib/formato';
import { fraseDepoisDoAceite, primeiroNome, situacaoDoDono } from './propriedade-textos';

// "A propriedade da conta" (P34 aprovado; A7, W8, parte 3): quem é o Dono e desde quando; para o Dono, "Transferir a
// propriedade", o pedido esperando o aceite (com "Cancelar o pedido") ou a espera de 7 dias depois de receber.

type Props = {
  propriedade: OwnershipResponse;
  souDono: boolean;
  empresa: string;
  aoTransferir: () => void;
  aoMudar: (aviso: string) => void;
};

export function CartaoPropriedade({ propriedade: p, souDono, empresa, aoTransferir, aoMudar }: Props) {
  const avisar = useAvisar();
  const [cancelando, setCancelando] = useState(false);
  const [enviando, setEnviando] = useState(false);
  const dono = (
    <div className="prop-dono">
      <span className="pessoa-av" aria-hidden="true">
        {iniciais(p.owner.name)}
      </span>
      <span>
        <b>
          {p.owner.name}
          {souDono ? ' · você' : ''}
        </b>
        <small>Dono desde {dataCompleta(p.owner.since)}</small>
      </span>
    </div>
  );

  async function cancelar(id: string) {
    setEnviando(true);
    const r = await chamar(() => api.DELETE('/v1/ownership/transfers/{id}', { params: { path: { id } } }));
    setEnviando(false);
    setCancelando(false);
    if (!r.ok && r.problema.status !== 404) return avisar(mensagemDe(r.problema), { tipo: 'perigo' });
    aoMudar(`Pedido cancelado. Você continua o dono, e ${primeiroNome(p.pending?.to.name ?? '')} recebeu um e-mail.`);
  }

  let corpo;
  if (!souDono && p.addressed_to_me && p.pending) {
    corpo = <p className="lite-frase">{primeiroNome(p.owner.name)} pediu para passar a propriedade para você. Veja o pedido no alto da página.</p>;
  } else if (!souDono) {
    corpo = <p className="lite-frase">Só {primeiroNome(p.owner.name)} transfere a propriedade.</p>;
  } else {
    const s = situacaoDoDono(p);
    if (s === 'pedido' && p.pending) {
      const para = p.pending;
      corpo = (
        <>
          <div className="prop-pedido" role="status">
            <span className="st st--aguardando">
              <span className="dot" aria-hidden="true" />
              Esperando o aceite de {para.to.name} até {dataCompleta(para.expires_at)}
            </span>
            <span>
              Até {primeiroNome(para.to.name)} aceitar com o código do app, nada muda. Depois do aceite,{' '}
              {fraseDepoisDoAceite('você', para.old_owner_stays, empresa)}.
            </span>
          </div>
          <div className="prop-acoes">
            {cancelando ? (
              <ConfirmaNaLinha
                texto={`Cancelar o pedido? ${primeiroNome(para.to.name)} recebe um e-mail dizendo que ele foi cancelado.`}
                rotulo="Cancelar o pedido"
                rotuloOcupado="Cancelando…"
                voltar="Manter"
                ocupado={enviando}
                aoConfirmar={() => disparar(cancelar(para.id))}
                aoCancelar={() => setCancelando(false)}
              />
            ) : (
              <button className="btn btn--perigo" type="button" onClick={() => setCancelando(true)}>
                Cancelar o pedido
              </button>
            )}
          </div>
        </>
      );
    } else if (s === 'espera' && p.can_transfer_from) {
      corpo = (
        <>
          <p className="lite-frase">Você recebeu a propriedade há pouco. Para transferir de novo, espere 7 dias.</p>
          <div className="prop-acoes">
            <button className="btn" type="button" disabled aria-describedby="prop-espera">
              Transferir a propriedade
            </button>
            <span className="campo-dica" id="prop-espera">
              Liberado em {dataCompleta(p.can_transfer_from)}
            </span>
          </div>
        </>
      );
    } else {
      corpo = (
        <>
          <p className="lite-frase">Só você transfere a propriedade. Quem recebe passa a cuidar da cobrança e de quem tem acesso, e aceita com o código do app.</p>
          <div className="prop-acoes">
            <button className="btn btn--primary" type="button" aria-haspopup="dialog" onClick={aoTransferir}>
              Transferir a propriedade
            </button>
          </div>
        </>
      );
    }
  }

  return (
    <article className="card prop-card" aria-labelledby="prop-t">
      <h2 className="card-titulo" id="prop-t">
        A propriedade da conta
      </h2>
      {dono}
      {corpo}
    </article>
  );
}
