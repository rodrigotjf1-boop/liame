'use client';

import { useId, useRef, useState } from 'react';
import { Icone } from '@/components/ui/icone';
import { useDialogo } from '@/components/ui/use-dialogo';
import { api, chamar, mensagemDe } from '@/lib/api';
import { disparar } from '@/lib/disparar';

// Apagar uma foto (P20): a confirmação, por cima da gaveta. A foto sai da lista na hora, e o servidor tira o arquivo do
// armazenamento logo depois (rotina `fotos` do worker). O que já foi publicado nas redes não muda.

type Props = {
  id: string;
  /** Apagou (ou ela já não estava mais aqui): a tela tira a foto da lista. */
  aoApagar: (jaTinhaSaido: boolean) => void;
  aoFechar: () => void;
};

export function DialogoApagarFoto({ id, aoApagar, aoFechar }: Props) {
  const ids = useId();
  const cancelar = useRef<HTMLButtonElement>(null);
  const { ref, fechar, devolverFoco } = useDialogo({ focoInicial: cancelar });
  const [enviando, setEnviando] = useState(false);
  const [erro, setErro] = useState('');
  const feito = useRef<boolean | null>(null);

  async function apagar() {
    setErro('');
    setEnviando(true);
    const r = await chamar(() => api.DELETE('/v1/brand-photos/{id}', { params: { path: { id } } }));
    setEnviando(false);
    if (r.ok || r.problema.code === 'foto-nao-encontrada') {
      feito.current = !r.ok;
      return fechar();
    }
    setErro(mensagemDe(r.problema));
  }

  return (
    <dialog
      ref={ref}
      className="dialogo"
      aria-labelledby={`${ids}-t`}
      aria-describedby={`${ids}-d`}
      onClose={() => {
        // Apagou: quem abriu (o botão da gaveta) some junto com a gaveta, e a tela leva o foco à foto vizinha.
        if (feito.current !== null) return aoApagar(feito.current);
        aoFechar();
        devolverFoco();
      }}
      onClick={(e) => {
        if (e.target === ref.current && !enviando) fechar();
      }}
    >
      <div className="dialogo-form">
        <div className="dialogo-cab">
          <h2 id={`${ids}-t`}>Apagar esta foto?</h2>
          <button className="btn btn--icon btn--ghost" type="button" onClick={fechar} aria-label="Fechar" disabled={enviando}>
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
          <p id={`${ids}-d`}>Ela sai do Liame de vez. O que já foi publicado nas redes não muda.</p>
        </div>
        <div className="dialogo-acoes">
          <button className="btn" type="button" ref={cancelar} onClick={fechar} disabled={enviando}>
            Cancelar
          </button>
          <button className="btn btn--perigo-cheio" type="button" onClick={() => disparar(apagar())} disabled={enviando}>
            <Icone nome="trash" />
            {enviando ? 'Apagando…' : 'Apagar foto'}
          </button>
        </div>
      </div>
    </dialog>
  );
}
