'use client';

import type { PartnerResponse } from '@liame/contracts';
import { type FormEvent, type RefObject, useId, useRef, useState } from 'react';
import { Icone } from '@/components/ui/icone';
import { useDialogo } from '@/components/ui/use-dialogo';
import { api, chamar, mensagemDe } from '@/lib/api';
import { disparar } from '@/lib/disparar';
import { daAgencia } from './parceiros';

// "Desfazer o vínculo" (P27 aprovado; D-A7-50): o que acontece na hora, sem o código, porque é tirar acesso.

type Props = {
  parceiro: PartnerResponse;
  pessoas: number;
  nomeEmpresa: string;
  reserva: RefObject<HTMLElement | null>;
  aoDesfazer: (aviso: string) => void;
  aoFechar: () => void;
};

export function DialogoDesfazer({ parceiro: p, pessoas, nomeEmpresa, reserva, aoDesfazer, aoFechar }: Props) {
  const ids = useId();
  const voltar = useRef<HTMLButtonElement>(null);
  const { ref, fechar, devolverFoco } = useDialogo({ focoInicial: voltar, reserva });
  const [enviando, setEnviando] = useState(false);
  const [erro, setErro] = useState('');
  const qt = `${pessoas} ${pessoas === 1 ? 'pessoa' : 'pessoas'}`;

  async function desfazer(e: FormEvent) {
    e.preventDefault();
    setErro('');
    setEnviando(true);
    const r = await chamar(() => api.DELETE('/v1/partners/{id}', { params: { path: { id: p.id } } }));
    setEnviando(false);
    // Já desfeito (pela agência, ou noutra aba): o resultado é o mesmo, e a tela lê de novo.
    if (r.ok || r.problema.status === 404) {
      aoDesfazer(r.ok ? 'Vínculo desfeito. As pessoas da agência saíram na hora.' : 'O vínculo já estava desfeito.');
      return fechar();
    }
    setErro(mensagemDe(r.problema));
  }

  const itens = [
    'Elas saem de todas as sessões nesta empresa; nas outras empresas em que trabalham, nada muda.',
    'O que elas fizeram continua no registro de atividades, com o nome da agência.',
    'A agência recebe um e-mail dizendo que o vínculo foi desfeito.',
    'Se a agência pedir de novo, você decide outra vez.',
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
      <form className="dialogo-form" onSubmit={(e) => disparar(desfazer(e))} noValidate>
        <div className="dialogo-cab">
          <h2 id={`${ids}-t`}>Desfazer o vínculo com {p.agency.name}</h2>
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
            {pessoas ? `As ${qt} ${daAgencia(p.agency.name)} saem da ${nomeEmpresa} na hora.` : `${p.agency.name} sai da ${nomeEmpresa} na hora.`}
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
            {enviando ? 'Desfazendo…' : 'Desfazer o vínculo'}
          </button>
        </div>
      </form>
    </dialog>
  );
}
