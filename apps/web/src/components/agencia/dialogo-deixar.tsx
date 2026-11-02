'use client';

import type { AgencyClientResponse } from '@liame/contracts';
import { type FormEvent, type RefObject, useId, useRef, useState } from 'react';
import { Icone } from '@/components/ui/icone';
import { useDialogo } from '@/components/ui/use-dialogo';
import { api, chamar, mensagemDe } from '@/lib/api';
import { disparar } from '@/lib/disparar';

// "Deixar de cuidar" de uma empresa (P27 aprovado; D-A7-50): a agência desfaz o vínculo pelo lado dela, na hora e sem o
// código; o time sai da empresa e o dono recebe um e-mail.

type Props = {
  cliente: AgencyClientResponse;
  reserva: RefObject<HTMLElement | null>;
  aoDeixar: (aviso: string) => void;
  aoFechar: () => void;
};

export function DialogoDeixar({ cliente: c, reserva, aoDeixar, aoFechar }: Props) {
  const ids = useId();
  const voltar = useRef<HTMLButtonElement>(null);
  const { ref, fechar, devolverFoco } = useDialogo({ focoInicial: voltar, reserva });
  const [enviando, setEnviando] = useState(false);
  const [erro, setErro] = useState('');
  const pessoas = c.team?.length ?? 0;
  const nome = c.organization.name;

  async function deixar(e: FormEvent) {
    e.preventDefault();
    setErro('');
    setEnviando(true);
    const r = await chamar(() => api.DELETE('/v1/agency/clients/{id}', { params: { path: { id: c.id } } }));
    setEnviando(false);
    if (r.ok || r.problema.status === 404) {
      aoDeixar(r.ok ? `A agência deixou de cuidar da ${nome}. O dono recebeu um e-mail.` : 'O vínculo com esta empresa já tinha acabado.');
      return fechar();
    }
    setErro(mensagemDe(r.problema));
  }

  const itens = [
    'O dono recebe um e-mail dizendo que a agência deixou de cuidar da conta.',
    'O que o time fez continua no registro de atividades da empresa.',
    'Para voltar, a agência pede acesso de novo, e o dono decide outra vez.',
  ];
  return (
    <dialog
      ref={ref}
      className="dialogo"
      aria-labelledby={`${ids}-t`}
      onClose={() => {
        aoFechar();
        devolverFoco();
      }}
    >
      <form className="dialogo-form" onSubmit={(e) => disparar(deixar(e))} noValidate>
        <div className="dialogo-cab">
          <h2 id={`${ids}-t`}>Deixar de cuidar da {nome}</h2>
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
          <p className="dlg-lead">
            {pessoas
              ? `${pessoas === 1 ? 'A pessoa' : `As ${pessoas} pessoas`} da agência ${pessoas === 1 ? 'sai' : 'saem'} da ${nome} na hora.`
              : `A agência sai da ${nome} na hora.`}
          </p>
          <ul className="ag-lista">
            {itens.map((t) => (
              <li key={t}>
                <Icone nome="arrow-right" pequeno />
                <span>{t}</span>
              </li>
            ))}
          </ul>
        </div>
        <div className="dialogo-acoes">
          <button ref={voltar} className="btn" type="button" onClick={fechar} disabled={enviando}>
            Voltar
          </button>
          <button className="btn btn--perigo-cheio" type="submit" disabled={enviando} aria-busy={enviando}>
            {enviando ? 'Deixando…' : 'Deixar de cuidar'}
          </button>
        </div>
      </form>
    </dialog>
  );
}
