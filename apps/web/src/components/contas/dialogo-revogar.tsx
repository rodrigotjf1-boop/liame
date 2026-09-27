'use client';

import type { ConnectionResponse } from '@liame/contracts';
import { type RefObject, useId, useRef, useState } from 'react';
import { Icone } from '@/components/ui/icone';
import { useDialogo } from '@/components/ui/use-dialogo';
import { api, chamar, mensagemDe } from '@/lib/api';
import { disparar } from '@/lib/disparar';
import { autorizadorDa, contasDaAutorizacao } from './textos';

// "Revogar a autorização?" (protótipo aprovado): a leitura das contas dela para na hora; o histórico
// fica. Na Meta, o passo que falta é na própria Meta (base de conhecimento §2.1, verificado em 26/09/2026).

type Props = {
  conexao: ConnectionResponse;
  reserva: RefObject<HTMLElement | null>;
  aoRevogar: () => void;
  aoFechar: () => void;
};

export function DialogoRevogar({ conexao, reserva, aoRevogar, aoFechar }: Props) {
  const cancelar = useRef<HTMLButtonElement>(null);
  const { ref, fechar, devolverFoco } = useDialogo({ focoInicial: cancelar, reserva });
  const ids = useId();
  const [enviando, setEnviando] = useState(false);
  const [erro, setErro] = useState('');
  const n = contasDaAutorizacao(conexao);
  const meta = autorizadorDa(conexao.provider) === 'meta';

  async function revogar() {
    setErro('');
    setEnviando(true);
    const r = await chamar(() => api.DELETE('/v1/connections/{id}', { params: { path: { id: conexao.id } } }));
    setEnviando(false);
    if (!r.ok) return setErro(mensagemDe(r.problema));
    aoRevogar();
    fechar();
  }

  return (
    <dialog
      ref={ref}
      className="dialogo"
      aria-labelledby={`${ids}-t`}
      onClose={() => {
        aoFechar();
        devolverFoco();
      }}
      onClick={(e) => {
        if (e.target === ref.current && !enviando) fechar();
      }}
    >
      <div className="dialogo-form">
        <div className="dialogo-cab">
          <h2 id={`${ids}-t`}>Revogar a autorização?</h2>
          <button className="btn btn--ghost btn--icon" type="button" onClick={fechar} aria-label="Fechar" disabled={enviando}>
            <Icone nome="x" />
          </button>
        </div>
        <div className="dialogo-corpo">
          {erro && (
            <p className="dialogo-erro" role="alert">
              <Icone nome="alert" pequeno />
              <span>{erro}</span>
            </p>
          )}
          <p>
            {n ? (
              <>
                A leitura {n === 1 ? 'da' : 'das'} <b>{n === 1 ? 'conta' : `${n} contas`}</b> desta autorização para agora. O histórico de números fica.
              </>
            ) : (
              'Nenhuma conta está ligada por esta autorização. Revogar tira o acesso do Liame à plataforma.'
            )}
          </p>
          {meta ? (
            <p className="dialogo-nota">
              <Icone nome="shield" pequeno />
              <span>
                Na Meta, para tirar o acesso de vez, remova também o app Liame em <b>Configurações do negócio → Integrações → Apps conectados</b>.
              </span>
            </p>
          ) : (
            <p className="dialogo-nota">
              <Icone nome="shield" pequeno />
              <span>No Google, o acesso é revogado lá também, na hora.</span>
            </p>
          )}
        </div>
        <div className="dialogo-acoes">
          <button ref={cancelar} className="btn" type="button" onClick={fechar} disabled={enviando}>
            Cancelar
          </button>
          <button className="btn btn--perigo-cheio" type="button" onClick={() => disparar(revogar())} disabled={enviando} aria-busy={enviando}>
            {enviando ? 'Revogando…' : 'Revogar'}
          </button>
        </div>
      </div>
    </dialog>
  );
}
