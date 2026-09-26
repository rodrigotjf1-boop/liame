'use client';

import type { InvitationResponse } from '@liame/contracts';
import { useState } from 'react';
import { Icone } from '@/components/ui/icone';
import { NIVEIS } from '@/lib/niveis';
import { envioDe } from './textos';
import { disparar } from '@/lib/disparar';

type Props = {
  convite: InvitationResponse;
  podeGerenciar: boolean;
  aoReenviar: () => Promise<void>;
  aoCancelar: () => Promise<void>;
};

export function ItemConvite({ convite: c, podeGerenciar, aoReenviar, aoCancelar }: Props) {
  const [ocupado, setOcupado] = useState<'reenviar' | 'cancelar' | null>(null);

  async function fazer(acao: 'reenviar' | 'cancelar') {
    setOcupado(acao);
    await (acao === 'reenviar' ? aoReenviar() : aoCancelar());
    setOcupado(null);
  }

  return (
    <li className="pessoa">
      <span className="pessoa-av pessoa-av--convite" aria-hidden="true">
        <Icone nome="send" />
      </span>
      <div className="pessoa-txt">
        <p className="pessoa-nome">{c.email}</p>
        <p className="pessoa-det">{envioDe(c)}</p>
        <p className="pessoa-meta">
          <span className={`nivel-chip nivel-chip--${NIVEIS[c.role].chip}`}>{NIVEIS[c.role].nome}</span>
          <span className="st st--aguardando">
            <span className="dot" aria-hidden="true" />
            Esperando resposta
          </span>
        </p>
      </div>
      {podeGerenciar && (
        <div className="pessoa-acoes">
          <button className="btn btn--sm" type="button" onClick={() => disparar(fazer('reenviar'))} disabled={ocupado !== null} aria-busy={ocupado === 'reenviar'}>
            {ocupado === 'reenviar' ? 'Reenviando…' : 'Reenviar'}
          </button>
          <button className="btn btn--sm btn--ghost" type="button" onClick={() => disparar(fazer('cancelar'))} disabled={ocupado !== null} aria-busy={ocupado === 'cancelar'}>
            {ocupado === 'cancelar' ? 'Cancelando…' : 'Cancelar convite'}
          </button>
        </div>
      )}
    </li>
  );
}
