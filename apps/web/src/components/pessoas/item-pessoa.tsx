'use client';

import type { MemberResponse } from '@liame/contracts';
import { useEffect, useRef, useState } from 'react';
import { iniciais, quando } from '@/lib/formato';
import { EXIGEM_APP, NIVEIS } from '@/lib/niveis';
import { detalhesDe } from './textos';
import { disparar } from '@/lib/disparar';

type Props = {
  pessoa: MemberResponse;
  voce: boolean;
  souDono: boolean;
  podeAlterar: boolean;
  podeRemover: boolean;
  aoAlterar: () => void;
  aoRemover: () => Promise<boolean>;
};

export function ItemPessoa({ pessoa: p, voce, souDono, podeAlterar, podeRemover, aoAlterar, aoRemover }: Props) {
  const [confirmando, setConfirmando] = useState(false);
  const [removendo, setRemovendo] = useState(false);
  const confirmar = useRef<HTMLButtonElement>(null);
  const remover = useRef<HTMLButtonElement>(null);
  const perguntou = useRef(false);
  const primeiroNome = p.name.split(/\s+/)[0];

  // Foco depois do commit: na confirmação quando ela aparece; de volta no "Remover acesso" quando some.
  useEffect(() => {
    if (confirmando) {
      perguntou.current = true;
      confirmar.current?.focus();
    } else if (perguntou.current) {
      perguntou.current = false;
      remover.current?.focus();
    }
  }, [confirmando]);

  // O dono é intocável e ninguém mexe no próprio acesso (ADR-017): sem botões nesses casos.
  const editavel = p.role !== 'dono' && !voce;

  async function removerAgora() {
    setRemovendo(true);
    const ok = await aoRemover();
    if (!ok) {
      setRemovendo(false);
      setConfirmando(false);
    }
  }

  return (
    <li className="pessoa">
      <span className="pessoa-av" aria-hidden="true">
        {iniciais(p.name)}
      </span>
      <div className="pessoa-txt">
        <p className="pessoa-nome">
          {p.name}
          {voce && <span className="lite-chip">Você</span>}
        </p>
        <p className="pessoa-email">{p.email}</p>
        <p className="pessoa-det">{detalhesDe(p, souDono)}</p>
        <p className="pessoa-meta">
          <span className={`nivel-chip nivel-chip--${NIVEIS[p.role].chip}`}>{NIVEIS[p.role].nome}</span>
          {p.mfa_enabled ? (
            <span className="st st--concluido">
              <span className="dot" aria-hidden="true" />
              App autenticador ativo
            </span>
          ) : (
            EXIGEM_APP.has(p.role) && (
              <span className="st st--aguardando">
                <span className="dot" aria-hidden="true" />
                Falta ativar o app autenticador
              </span>
            )
          )}
          <span>{p.last_seen_at ? `Último acesso: ${quando(p.last_seen_at)}` : 'Ainda não entrou'}</span>
        </p>
      </div>
      {editavel && (podeAlterar || podeRemover) && (
        <div className="pessoa-acoes">
          {confirmando ? (
            <>
              <span className="pessoa-confirma">Tem certeza? A pessoa perde o acesso na hora.</span>
              <button
                ref={confirmar}
                className="btn btn--sm btn--perigo-cheio"
                type="button"
                onClick={() => disparar(removerAgora())}
                disabled={removendo}
                aria-busy={removendo}
              >
                {removendo ? 'Removendo…' : `Remover ${primeiroNome} agora`}
              </button>
              <button
                className="btn btn--sm"
                type="button"
                disabled={removendo}
                onClick={() => setConfirmando(false)}
              >
                Cancelar
              </button>
            </>
          ) : (
            <>
              {podeAlterar && (
                <button className="btn btn--sm" type="button" onClick={aoAlterar}>
                  Alterar
                </button>
              )}
              {podeRemover && (
                <button ref={remover} className="btn btn--sm btn--perigo" type="button" onClick={() => setConfirmando(true)}>
                  Remover acesso
                </button>
              )}
            </>
          )}
        </div>
      )}
    </li>
  );
}
