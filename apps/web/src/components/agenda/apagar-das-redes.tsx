'use client';

import type { PasskeyAssertion } from '@liame/contracts';
import { type FormEvent, useEffect, useId, useRef, useState } from 'react';
import { ConfirmarComChave } from '@/components/seguranca/confirmar-com-chave';
import { Icone } from '@/components/ui/icone';
import type { Prova } from '@/lib/chave-de-acesso';
import { disparar } from '@/lib/disparar';

// "Apagar das redes" (P19, aprovado pelo dono em 21/10/2026; A6, Z5d, parte 7; D-A6-57): de onde o post sai, a confirmação
// de quem apaga, "Apagar das redes" e "Manter". É a confirmação na linha do P19 com o campo do código, que o servidor
// exige: abre com o foco no código (a confirmação na linha comum foca o botão, que fica travado sem o código); a recusa
// (o código que não confere, o post que mudou) fica embaixo, com o foco de volta no código. Quem tem chave de acesso
// (A7, W9, parte 9c3; D-A7-56) apaga com ela primeiro; o código do app fica ao lado.

/** A recusa da tela, ou o que fazer depois (o ok fecha o formulário: quem chama troca o post e avisa). */
export type FeitoDoApagar = { ok: true } | { ok: false; texto: string };

type Props = {
  /** O id do formulário (o botão "Apagar das redes" aponta para o bloco dele em `aria-controls`). */
  id: string;
  /** "do Instagram e da Página do Facebook": de onde o post sai. */
  deOnde: string;
  temApp?: boolean;
  temChave?: boolean;
  aoApagar: (prova: Prova) => Promise<FeitoDoApagar>;
  aoManter: () => void;
};

/** Só algarismos, conferidos um a um (V48: sem expressão regular sobre o que a pessoa digita). */
const soDigitos = (v: string): boolean => [...v].every((d) => d >= '0' && d <= '9');

/** O código do app conferido antes de mandar: 6 números. Nulo: pode mandar. */
export function erroDoCodigo(codigo: string): string | null {
  return codigo.length === 6 && soDigitos(codigo) ? null : 'Digite os 6 números do app.';
}

export function ApagarDasRedes({ id, deOnde, temApp = true, temChave = false, aoApagar, aoManter }: Props) {
  const ids = useId();
  const [codigo, setCodigo] = useState('');
  const [erro, setErro] = useState<string | null>(null);
  const [enviando, setEnviando] = useState(false);
  const campo = useRef<HTMLInputElement>(null);
  const formulario = useRef<HTMLFormElement>(null);
  // O foco vai para o código depois do commit (V27, ERR-185): ao abrir e a cada recusa. Só com a chave, para o botão dela.
  const [focar, setFocar] = useState(1);
  useEffect(() => {
    if (temApp) campo.current?.focus();
    else formulario.current?.querySelector<HTMLElement>('[data-foco]')?.focus();
  }, [focar, temApp]);

  async function mandar(prova: Prova) {
    setEnviando(true);
    setErro(null);
    const r = await aoApagar(prova);
    setEnviando(false);
    if (!r.ok) {
      setErro(r.texto);
      setCodigo('');
      setFocar((n) => n + 1);
    }
  }

  async function enviar() {
    if (!temApp) return;
    const local = erroDoCodigo(codigo);
    if (local) {
      setErro(local);
      setFocar((n) => n + 1);
      return;
    }
    await mandar({ code: codigo });
  }

  return (
    <form
      ref={formulario}
      className="po-apagar"
      id={id}
      noValidate
      aria-label="Apagar o post das redes"
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        disparar(enviar());
      }}
    >
      <p className="po-apagar-frase">Sai {deOnde}, onde o Liame publicou. Apagar não se desfaz, e quem já viu o post, viu.</p>
      {temApp && (
        <div className="campo">
          <label htmlFor={`${ids}-codigo`}>{temChave ? 'Ou o código do app' : 'Código do app'}</label>
          <input
            ref={campo}
            className="input mono"
            id={`${ids}-codigo`}
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            placeholder="000000"
            value={codigo}
            onChange={(e) => setCodigo([...e.target.value].filter((d) => d >= '0' && d <= '9').join(''))}
            disabled={enviando}
            {...(erro ? { 'aria-invalid': true as const, 'aria-describedby': `${ids}-erro` } : {})}
          />
        </div>
      )}
      {erro && (
        <span className="campo-erro" id={`${ids}-erro`} role="alert">
          {erro}
        </span>
      )}
      <div className="po-apagar-acoes">
        {temChave && (
          <ConfirmarComChave
            perigo
            focoInicial={!temApp}
            rotulo="Apagar com a chave"
            impedido={enviando}
            alternativa={temApp ? 'use o código do app' : 'tente de novo'}
            aoErro={setErro}
            aoProvar={(passkey: PasskeyAssertion) => mandar({ passkey })}
          />
        )}
        {temApp && (
          <button className={`btn ${temChave ? 'btn--perigo' : 'btn--perigo-cheio'}`} type="submit" disabled={enviando} aria-busy={enviando} data-po-apagar-confirma>
            <Icone nome="undo" pequeno />
            {enviando ? 'Apagando…' : temChave ? 'Apagar com o código' : 'Apagar das redes'}
          </button>
        )}
        <button className="btn" type="button" onClick={aoManter} disabled={enviando}>
          Manter
        </button>
      </div>
    </form>
  );
}
