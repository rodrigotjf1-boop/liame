'use client';

import { type FormEvent, useEffect, useId, useRef, useState } from 'react';
import { Icone } from '@/components/ui/icone';
import { disparar } from '@/lib/disparar';

// "Apagar das redes" (P19, aprovado pelo dono em 21/10/2026; A6, Z5d, parte 7; D-A6-57): de onde o post sai, o código do
// app de quem apaga, "Apagar das redes" e "Manter". É a confirmação na linha do P19 com o campo do código, que o servidor
// exige: abre com o foco no código (a confirmação na linha comum foca o botão, que fica travado sem o código); a recusa
// (o código que não confere, o post que mudou) fica embaixo, com o foco de volta no código.

/** A recusa da tela, ou o que fazer depois (o ok fecha o formulário: quem chama troca o post e avisa). */
export type FeitoDoApagar = { ok: true } | { ok: false; texto: string };

type Props = {
  /** O id do formulário (o botão "Apagar das redes" aponta para o bloco dele em `aria-controls`). */
  id: string;
  /** "do Instagram e da Página do Facebook": de onde o post sai. */
  deOnde: string;
  aoApagar: (codigo: string) => Promise<FeitoDoApagar>;
  aoManter: () => void;
};

/** Só algarismos, conferidos um a um (V48: sem expressão regular sobre o que a pessoa digita). */
const soDigitos = (v: string): boolean => [...v].every((d) => d >= '0' && d <= '9');

/** O código do app conferido antes de mandar: 6 números. Nulo: pode mandar. */
export function erroDoCodigo(codigo: string): string | null {
  return codigo.length === 6 && soDigitos(codigo) ? null : 'Digite os 6 números do app.';
}

export function ApagarDasRedes({ id, deOnde, aoApagar, aoManter }: Props) {
  const ids = useId();
  const [codigo, setCodigo] = useState('');
  const [erro, setErro] = useState<string | null>(null);
  const [enviando, setEnviando] = useState(false);
  const campo = useRef<HTMLInputElement>(null);
  // O foco vai para o código depois do commit (V27, ERR-185): ao abrir e a cada recusa.
  const [focar, setFocar] = useState(1);
  useEffect(() => {
    campo.current?.focus();
  }, [focar]);

  async function enviar() {
    const local = erroDoCodigo(codigo);
    if (local) {
      setErro(local);
      setFocar((n) => n + 1);
      return;
    }
    setEnviando(true);
    setErro(null);
    const r = await aoApagar(codigo);
    setEnviando(false);
    if (!r.ok) {
      setErro(r.texto);
      setCodigo('');
      setFocar((n) => n + 1);
    }
  }

  return (
    <form
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
      <div className="campo">
        <label htmlFor={`${ids}-codigo`}>Código do app</label>
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
      {erro && (
        <span className="campo-erro" id={`${ids}-erro`} role="alert">
          {erro}
        </span>
      )}
      <div className="po-apagar-acoes">
        <button className="btn btn--perigo-cheio" type="submit" disabled={enviando} aria-busy={enviando} data-po-apagar-confirma>
          <Icone nome="undo" pequeno />
          {enviando ? 'Apagando…' : 'Apagar das redes'}
        </button>
        <button className="btn" type="button" onClick={aoManter} disabled={enviando}>
          Manter
        </button>
      </div>
    </form>
  );
}
