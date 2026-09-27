'use client';

import type { SessionResponse } from '@liame/contracts';
import { useEffect, useRef, useState } from 'react';
import { disparar } from '@/lib/disparar';
import { detalheDoAparelho, siglaDoAparelho } from './textos';

// Um aparelho com a conta aberta. "Encerrar" confirma na própria linha (protótipo aprovado).

type Props = { sessao: SessionResponse; agora: Date; aoEncerrar: () => Promise<boolean> };

export function ItemAparelho({ sessao: s, agora, aoEncerrar }: Props) {
  const [confirmando, setConfirmando] = useState(false);
  const [encerrando, setEncerrando] = useState(false);
  const confirmar = useRef<HTMLButtonElement>(null);
  const encerrar = useRef<HTMLButtonElement>(null);
  const perguntou = useRef(false);

  // Foco depois do commit: na confirmação quando ela aparece; de volta no "Encerrar" quando some.
  useEffect(() => {
    if (confirmando) {
      perguntou.current = true;
      confirmar.current?.focus();
    } else if (perguntou.current) {
      perguntou.current = false;
      encerrar.current?.focus();
    }
  }, [confirmando]);

  async function encerrarAgora() {
    setEncerrando(true);
    const ok = await aoEncerrar();
    if (!ok) {
      setEncerrando(false);
      setConfirmando(false);
    }
  }

  return (
    <li className="aparelho">
      <span className="ap-ic" aria-hidden="true">
        {siglaDoAparelho(s.device)}
      </span>
      <div className="ap-txt">
        <p className="ap-nome">
          {s.device}
          {s.current && <span className="lite-chip">Este aparelho</span>}
        </p>
        <p className="ap-meta">{detalheDoAparelho(s, agora)}</p>
      </div>
      {!s.current &&
        (confirmando ? (
          <div className="seg-acoes">
            <button
              ref={confirmar}
              className="btn btn--sm btn--perigo-cheio"
              type="button"
              onClick={() => disparar(encerrarAgora())}
              disabled={encerrando}
              aria-busy={encerrando}
            >
              {encerrando ? 'Encerrando…' : 'Encerrar agora'}
            </button>
            <button className="btn btn--sm" type="button" disabled={encerrando} onClick={() => setConfirmando(false)}>
              Cancelar
            </button>
          </div>
        ) : (
          <button
            ref={encerrar}
            className="btn btn--sm btn--perigo"
            type="button"
            onClick={() => setConfirmando(true)}
            aria-label={`Encerrar ${s.device}`}
          >
            Encerrar
          </button>
        ))}
    </li>
  );
}
