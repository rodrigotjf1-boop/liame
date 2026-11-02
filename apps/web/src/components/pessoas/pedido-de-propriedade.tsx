'use client';

import type { OwnershipTransfer } from '@liame/contracts';
import { useState } from 'react';
import { useAvisar } from '@/components/ui/avisos';
import { ConfirmaNaLinha } from '@/components/ui/confirma-na-linha';
import { api, chamar, mensagemDe } from '@/lib/api';
import { disparar } from '@/lib/disparar';
import { dataCompleta, quandoComHora } from '@/lib/formato';
import { depoisDoAceite, primeiroNome } from './propriedade-textos';

// O pedido de propriedade para quem recebe (P34 aprovado; A7, W8, parte 3): no alto de Pessoas e acessos, com "Ver e
// aceitar" (a gaveta com o código do app e os Termos) e "Recusar". Nada muda até o aceite.

type Props = {
  pedido: OwnershipTransfer;
  empresa: string;
  aoVerEAceitar: () => void;
  aoRecusado: () => void;
};

export function PedidoDePropriedade({ pedido: p, empresa, aoVerEAceitar, aoRecusado }: Props) {
  const avisar = useAvisar();
  const [recusando, setRecusando] = useState(false);
  const [enviando, setEnviando] = useState(false);
  const de = primeiroNome(p.from.name);

  async function recusar() {
    setEnviando(true);
    const r = await chamar(() => api.POST('/v1/ownership/transfers/{id}/decline', { params: { path: { id: p.id } } }));
    setEnviando(false);
    setRecusando(false);
    if (!r.ok && r.problema.status !== 404) return avisar(mensagemDe(r.problema), { tipo: 'perigo' });
    aoRecusado();
  }

  return (
    <article className="card pedido-prop" aria-labelledby="pp-t">
      <div className="pedido-prop-cab">
        <span className="st st--aguardando">
          <span className="dot" aria-hidden="true" />
          Pedido para você
        </span>
        <span className="campo-dica">
          Recebido {quandoComHora(p.created_at)} · vale até {dataCompleta(p.expires_at)}
        </span>
      </div>
      <h2 id="pp-t">
        {de} quer passar a propriedade da {empresa} para você
      </h2>
      <p className="lite-frase">
        Se você aceitar, passa a responder pela conta no Liame: a cobrança, quem tem acesso e a decisão de encerrar a conta.{' '}
        <b>Nada muda até você aceitar com o código do seu app.</b>
      </p>
      <dl className="pedido-prop-dados">
        <div>
          <dt>Pedido por</dt>
          <dd>{p.from.name}, o dono</dd>
        </div>
        <div>
          <dt>{de} fica como</dt>
          <dd>{depoisDoAceite(p.old_owner_stays, empresa)}</dd>
        </div>
      </dl>
      <div className="pedido-prop-acoes">
        {recusando ? (
          <ConfirmaNaLinha
            texto={`Recusar a propriedade? ${de} continua o dono.`}
            rotulo="Recusar"
            rotuloOcupado="Recusando…"
            voltar="Voltar"
            ocupado={enviando}
            aoConfirmar={() => disparar(recusar())}
            aoCancelar={() => setRecusando(false)}
          />
        ) : (
          <>
            <button className="btn btn--primary" type="button" aria-haspopup="dialog" onClick={aoVerEAceitar}>
              Ver e aceitar
            </button>
            <button className="btn btn--perigo" type="button" onClick={() => setRecusando(true)}>
              Recusar
            </button>
          </>
        )}
      </div>
    </article>
  );
}
