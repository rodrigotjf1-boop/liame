'use client';

import type { OwnershipClaim, OwnershipClaimResponse } from '@liame/contracts';
import { useState } from 'react';
import { useAvisar } from '@/components/ui/avisos';
import { ConfirmaNaLinha } from '@/components/ui/confirma-na-linha';
import { Faixa } from '@/components/ui/faixa';
import { Icone } from '@/components/ui/icone';
import { api, chamar, mensagemDe } from '@/lib/api';
import { disparar } from '@/lib/disparar';
import { dataCompleta, quandoComHora } from '@/lib/formato';
import { primeiroNome } from './propriedade-textos';

// O pedido da propriedade à DMS visto pelo Dono (A7, W8, parte 6b; D-A7-63): na espera, no alto de Pessoas e acessos, com
// "Ainda cuido da conta". Respondido, a faixa diz que a DMS fala com os dois antes de decidir.

type Props = { pedido: OwnershipClaim; empresa: string; aoMudar: (r: OwnershipClaimResponse) => void };

export function PedidoSobreODono({ pedido: p, empresa, aoMudar }: Props) {
  const avisar = useAvisar();
  const [respondendo, setRespondendo] = useState(false);
  const [enviando, setEnviando] = useState(false);
  const quem = primeiroNome(p.requester.name);

  async function responder() {
    setEnviando(true);
    const r = await chamar(() => api.POST('/v1/ownership/claims/{id}/contest', { params: { path: { id: p.id } } }));
    setEnviando(false);
    setRespondendo(false);
    if (!r.ok) return avisar(mensagemDe(r.problema), { tipo: 'perigo' });
    avisar(`Resposta enviada. A DMS fala com você e com ${quem} antes de decidir.`);
    aoMudar(r.data);
  }

  if (p.status === 'contestado') {
    return (
      <Faixa
        tipo="atencao"
        icone={<Icone nome="alert" />}
        titulo="Você respondeu que ainda cuida da conta"
        texto={`A DMS fala com você e com ${quem} antes de decidir o pedido ${p.protocol}. Nada muda até lá.`}
      />
    );
  }

  return (
    <article className="card pedido-prop" aria-labelledby="pd-dms-t">
      <div className="pedido-prop-cab">
        <span className="st st--aguardando">
          <span className="dot" aria-hidden="true" />
          Pedido da propriedade à DMS
        </span>
        <span className="campo-dica">
          Protocolo <span className="num">{p.protocol}</span>
        </span>
      </div>
      <h2 id="pd-dms-t">{quem} pediu à DMS a propriedade da conta</h2>
      <p className="lite-frase">
        {p.requester.name}, Administrador da {empresa}, pediu à DMS a propriedade, dizendo que você não pode mais cuidar da conta. A DMS conferiu os documentos e o
        quadro de sócios.{' '}
        {p.decide_from && (
          <b>
            Se ninguém responder, a DMS pode aprovar a partir de {dataCompleta(p.decide_from)}: {quem} vira a dona, e o seu acesso sai.
          </b>
        )}
      </p>
      <dl className="pedido-prop-dados">
        <div>
          <dt>Pedido em</dt>
          <dd className="num">{quandoComHora(p.sent_at ?? p.created_at)}</dd>
        </div>
        {p.checked_at && (
          <div>
            <dt>Conferido pela DMS em</dt>
            <dd className="num">{quandoComHora(p.checked_at)}</dd>
          </div>
        )}
      </dl>
      <div className="pedido-prop-acoes">
        {respondendo ? (
          <ConfirmaNaLinha
            texto={`Responder que ainda cuida da conta? A DMS fala com você e com ${quem} antes de decidir.`}
            rotulo="Ainda cuido da conta"
            rotuloOcupado="Enviando…"
            voltar="Voltar"
            ocupado={enviando}
            aoConfirmar={() => disparar(responder())}
            aoCancelar={() => setRespondendo(false)}
          />
        ) : (
          <button className="btn btn--primary" type="button" onClick={() => setRespondendo(true)}>
            Ainda cuido da conta
          </button>
        )}
      </div>
    </article>
  );
}
