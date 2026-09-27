'use client';

import { type FormEvent, type RefObject, useEffect, useId, useRef, useState } from 'react';
import { Icone } from '@/components/ui/icone';
import { useDialogo } from '@/components/ui/use-dialogo';
import { api, chamar, mensagemDe } from '@/lib/api';
import { disparar } from '@/lib/disparar';
import { ListaCodigos } from './lista-codigos';
import { avisoDosCodigos } from './textos';

// "Gerar códigos novos" (protótipo aprovado): confirma com o código do app (nunca com código de
// recuperação); os antigos deixam de valer na hora e os 10 novos aparecem uma vez só.

type Props = {
  restantes: number;
  reserva: RefObject<HTMLElement | null>;
  aoGerar: () => void;
  aoFechar: () => void;
};

export function DialogoCodigos({ restantes, reserva, aoGerar, aoFechar }: Props) {
  const campo = useRef<HTMLInputElement>(null);
  const { ref, fechar, devolverFoco } = useDialogo({ focoInicial: campo, reserva });
  const ids = useId();
  const [codigo, setCodigo] = useState('');
  const [erroCampo, setErroCampo] = useState('');
  const [erroGeral, setErroGeral] = useState('');
  const [enviando, setEnviando] = useState(false);
  const [codigos, setCodigos] = useState<string[] | null>(null);
  const [guardei, setGuardei] = useState(false);

  // Depois de gerar, o foco vai para a lista nova (o botão de concluir fica no fim).
  useEffect(() => {
    if (codigos) ref.current?.querySelector<HTMLElement>('h2')?.focus();
  }, [codigos, ref]);

  async function gerar(e: FormEvent) {
    e.preventDefault();
    setErroCampo('');
    setErroGeral('');
    if (!/^\d{6}$/.test(codigo)) {
      setErroCampo('O código tem 6 dígitos: digite ou cole o que o app mostra agora.');
      return campo.current?.focus();
    }
    setEnviando(true);
    const r = await chamar(() => api.POST('/v1/me/mfa/recovery-codes', { body: { code: codigo } }));
    setEnviando(false);
    if (!r.ok) {
      setCodigo('');
      if (r.problema.status === 401 || r.problema.errors?.some((x) => x.path === 'code')) {
        setErroCampo(mensagemDe(r.problema));
        return campo.current?.focus();
      }
      return setErroGeral(mensagemDe(r.problema));
    }
    setCodigos(r.data.recovery_codes);
    aoGerar();
  }

  const titulo = codigos ? 'Guarde os códigos novos' : 'Gerar códigos novos';
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
        // Com os códigos na tela, clicar fora não fecha: eles não aparecem de novo.
        if (e.target === ref.current && !enviando && !codigos) fechar();
      }}
    >
      <form className="dialogo-form" onSubmit={(e) => disparar(gerar(e))} noValidate>
        <div className="dialogo-cab">
          <h2 id={`${ids}-t`} tabIndex={-1}>
            {titulo}
          </h2>
          <button className="btn btn--ghost btn--icon" type="button" onClick={fechar} aria-label="Fechar" disabled={enviando}>
            <Icone nome="x" />
          </button>
        </div>
        {codigos ? (
          <>
            <div className="dialogo-corpo">
              <p>
                Os códigos antigos deixaram de valer. Estes aparecem <b>uma vez só</b>: guarde num gerenciador de senhas ou em papel.
              </p>
              <div className="seg-codigos">
                <ListaCodigos codigos={codigos} />
              </div>
              <label className="check">
                <input type="checkbox" checked={guardei} onChange={(e) => setGuardei(e.target.checked)} /> Guardei os códigos num lugar seguro
              </label>
            </div>
            <div className="dialogo-acoes">
              <button className="btn btn--primary" type="button" disabled={!guardei} onClick={fechar}>
                Concluir
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="dialogo-corpo">
              {erroGeral && (
                <p className="dialogo-erro" role="alert">
                  <Icone nome="alert" pequeno />
                  <span>{erroGeral}</span>
                </p>
              )}
              <p>
                {avisoDosCodigos(restantes)}
                {restantes > 0 ? ' ' : ''}Digite o código do app para confirmar.
              </p>
              <div className="campo">
                <label htmlFor={`${ids}-cod`}>Código de 6 dígitos</label>
                <input
                  ref={campo}
                  className="input mono"
                  id={`${ids}-cod`}
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  pattern="[0-9]*"
                  maxLength={7}
                  placeholder="000000"
                  value={codigo}
                  onChange={(e) => setCodigo(e.target.value.replace(/\D/g, '').slice(0, 6))}
                  aria-invalid={erroCampo ? true : undefined}
                  aria-describedby={erroCampo ? `${ids}-cod-erro` : undefined}
                />
                {erroCampo && (
                  <p className="campo-erro" id={`${ids}-cod-erro`}>
                    {erroCampo}
                  </p>
                )}
              </div>
              <p className="dialogo-nota">
                <Icone nome="shield" pequeno />
                <span>Em seguida, os 10 códigos novos aparecem uma vez só, com copiar e baixar, como na ativação do app.</span>
              </p>
            </div>
            <div className="dialogo-acoes">
              <button className="btn" type="button" onClick={fechar} disabled={enviando}>
                Cancelar
              </button>
              <button className="btn btn--primary" type="submit" disabled={enviando} aria-busy={enviando}>
                {enviando ? 'Gerando…' : 'Gerar códigos novos'}
              </button>
            </div>
          </>
        )}
      </form>
    </dialog>
  );
}
