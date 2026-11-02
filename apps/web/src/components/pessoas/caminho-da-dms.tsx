'use client';

import type { OwnershipClaimResponse } from '@liame/contracts';
import { useState } from 'react';
import { useAvisar } from '@/components/ui/avisos';
import { ConfirmaNaLinha } from '@/components/ui/confirma-na-linha';
import { api, chamar, mensagemDe } from '@/lib/api';
import { disparar } from '@/lib/disparar';
import { podePedir, situacaoDoPedido } from './propriedade-dms-textos';

// No cartão "A propriedade da conta", para quem não é o Dono (P34 aprovado; A7, W8, parte 6b; D-A7-63): "O Dono não pode
// mais cuidar da conta?" com "Pedir a propriedade à DMS", ou a situação do pedido de quem pediu, com "Desistir do pedido".

type Props = {
  pedido: OwnershipClaimResponse | null;
  /** O primeiro nome do Dono. */
  dono: string;
  aoPedir: () => void;
  aoMudar: (r: OwnershipClaimResponse) => void;
};

export function CaminhoDaDms({ pedido, dono, aoPedir, aoMudar }: Props) {
  const avisar = useAvisar();
  const [desistindo, setDesistindo] = useState(false);
  const [enviando, setEnviando] = useState(false);
  const meu = pedido?.mine ? pedido.claim : null;

  async function desistir(id: string) {
    setEnviando(true);
    const r = await chamar(() => api.DELETE('/v1/ownership/claims/{id}', { params: { path: { id } } }));
    setEnviando(false);
    setDesistindo(false);
    if (!r.ok) return avisar(mensagemDe(r.problema), { tipo: 'perigo' });
    avisar('Você desistiu do pedido. Nada mudou na conta.');
    aoMudar(r.data);
  }

  const convite = podePedir(pedido) && (
    <>
      <p className="lite-frase">
        <b>{dono} não pode mais cuidar da conta?</b> Quando {dono} saiu da sociedade, faleceu ou perdeu o e-mail e o celular, quem representa a empresa pede a
        propriedade à DMS.
      </p>
      <div>
        <button className="link-bt" type="button" aria-haspopup="dialog" onClick={aoPedir}>
          Pedir a propriedade à DMS
        </button>
      </div>
    </>
  );

  if (!meu || meu.status === 'aprovado') return convite || null;
  const s = situacaoDoPedido(meu, dono);
  const anda = ['pedido', 'conferido', 'contestado'].includes(meu.status);
  return (
    <>
      <div className="prop-pedido" role="status">
        <span className={`st ${meu.status === 'recusado' ? 'st--perigo' : meu.status === 'cancelado' ? 'st--neutro' : 'st--aguardando'}`}>
          <span className="dot" aria-hidden="true" />
          {s.rotulo}
        </span>
        <span>{s.texto}</span>
      </div>
      {meu.status === 'rascunho' && (
        <div className="prop-acoes">
          <button className="btn" type="button" aria-haspopup="dialog" onClick={aoPedir}>
            Continuar o pedido
          </button>
        </div>
      )}
      {anda && (
        <div className="prop-acoes">
          {desistindo ? (
            <ConfirmaNaLinha
              texto="Desistir do pedido da propriedade? A DMS para de conferir, e nada muda na conta."
              rotulo="Desistir do pedido"
              rotuloOcupado="Desistindo…"
              voltar="Manter"
              ocupado={enviando}
              aoConfirmar={() => disparar(desistir(meu.id))}
              aoCancelar={() => setDesistindo(false)}
            />
          ) : (
            <button className="btn btn--perigo" type="button" onClick={() => setDesistindo(true)}>
              Desistir do pedido
            </button>
          )}
        </div>
      )}
      {!anda && meu.status !== 'rascunho' && convite}
    </>
  );
}
