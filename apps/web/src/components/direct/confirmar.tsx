'use client';

import type { PasskeyAssertion } from '@liame/contracts';
import { type FormEvent, type ReactNode, type RefObject, useId, useRef, useState } from 'react';
import { ConfirmarComChave } from '@/components/seguranca/confirmar-com-chave';
import { Icone } from '@/components/ui/icone';
import { useDialogo } from '@/components/ui/use-dialogo';
import { type Problema, mensagemDe } from '@/lib/api';
import { disparar } from '@/lib/disparar';
import { type FormasDeConfirmar, useFormasDeConfirmar } from '@/lib/sessao';

// O diálogo de confirmar quem é (P39): ligar o Direct na marca e abrir o atendimento antes da primeira resposta. A
// pessoa confirma com a chave de acesso ou com os 6 números do app autenticador; a recusa do código volta ao campo.

export type Confirmacao = { code: string } | { passkey: PasskeyAssertion };
export type ResultadoDaConfirmacao = { ok: true } | { ok: false; problema: Problema };

type Props = {
  titulo: string;
  children: ReactNode;
  /** O rótulo do botão de mandar com o código ("Abrir e mandar", "Ligar o Direct"). */
  rotulo: string;
  reserva: RefObject<HTMLElement | null>;
  aoConfirmar: (c: Confirmacao) => Promise<ResultadoDaConfirmacao>;
  aoFechar: () => void;
  /** Como a pessoa confirma, no lugar da sessão (os testes de desenho). */
  confirmar?: FormasDeConfirmar;
};

export function DialogoDeConfirmar({ titulo, children, rotulo, reserva, aoConfirmar, aoFechar, confirmar }: Props) {
  const ids = useId();
  const campo = useRef<HTMLInputElement>(null);
  const { ref, fechar, devolverFoco } = useDialogo({ focoInicial: campo, reserva });
  const { temApp, temChave } = useFormasDeConfirmar(confirmar);
  const [codigo, setCodigo] = useState('');
  const [erroCodigo, setErroCodigo] = useState('');
  const [erroGeral, setErroGeral] = useState('');
  const [enviando, setEnviando] = useState(false);

  async function mandar(c: Confirmacao) {
    setEnviando(true);
    setErroGeral('');
    const r = await aoConfirmar(c);
    setEnviando(false);
    if (r.ok) return fechar();
    if ('code' in c && (r.problema.code === 'codigo-invalido' || r.problema.errors?.some((x) => x.path === 'code'))) {
      setCodigo('');
      setErroCodigo(r.problema.code === 'codigo-invalido' ? 'O código não confere. Digite o que aparece agora no app autenticador.' : 'Digite os 6 números do app autenticador.');
      campo.current?.focus();
      return;
    }
    setErroGeral(mensagemDe(r.problema));
  }

  function enviar(e: FormEvent) {
    e.preventDefault();
    const cod = codigo.trim();
    if (!/^\d{6}$/.test(cod)) {
      setErroCodigo('Digite os 6 números do app autenticador.');
      campo.current?.focus();
      return;
    }
    setErroCodigo('');
    disparar(mandar({ code: cod }));
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
    >
      <form className="dialogo-form" onSubmit={enviar} noValidate>
        <div className="dialogo-cab">
          <h2 id={`${ids}-t`}>{titulo}</h2>
          <button className="btn btn--ghost btn--icon" type="button" onClick={fechar} aria-label="Fechar" disabled={enviando}>
            <Icone nome="x" />
          </button>
        </div>
        <div className="dialogo-corpo">
          {erroGeral && (
            <p className="dialogo-erro" role="alert">
              <Icone nome="alert" pequeno />
              <span>{erroGeral}</span>
            </p>
          )}
          <div className="dir-dialogo-texto">{children}</div>
          {temChave && (
            <ConfirmarComChave
              rotulo={`${rotulo} com a chave`}
              impedido={enviando}
              alternativa={temApp ? 'use o código do app' : 'tente de novo'}
              aoErro={setErroGeral}
              aoProvar={(passkey) => mandar({ passkey })}
            />
          )}
          {temApp && (
            <div className="campo">
              <label htmlFor={`${ids}-cod`}>{temChave ? 'Ou o código do app autenticador' : 'Código do app autenticador'}</label>
              <input
                ref={campo}
                className="input campo-mono dir-codigo"
                id={`${ids}-cod`}
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                value={codigo}
                onChange={(e) => setCodigo(e.target.value)}
                aria-invalid={erroCodigo ? true : undefined}
                aria-describedby={erroCodigo ? `${ids}-cod-erro` : undefined}
              />
              {erroCodigo && (
                <p className="campo-erro" id={`${ids}-cod-erro`}>
                  {erroCodigo}
                </p>
              )}
            </div>
          )}
          {!temApp && !temChave && (
            <p className="nota">
              <Icone nome="lock" />
              <span>Para confirmar, cadastre o app autenticador ou uma chave de acesso em Segurança da conta.</span>
            </p>
          )}
        </div>
        <div className="dialogo-acoes">
          <button className="btn" type="button" onClick={fechar} disabled={enviando}>
            Cancelar
          </button>
          {temApp && (
            <button className={`btn${temChave ? '' : ' btn--primary'}`} type="submit" disabled={enviando} aria-busy={enviando}>
              {enviando ? 'Confirmando…' : temChave ? `${rotulo} com o código` : rotulo}
            </button>
          )}
        </div>
      </form>
    </dialog>
  );
}
