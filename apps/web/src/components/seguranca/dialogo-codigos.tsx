'use client';

import type { PasskeyAssertion } from '@liame/contracts';
import { type FormEvent, type RefObject, useEffect, useId, useRef, useState } from 'react';
import { Icone } from '@/components/ui/icone';
import { useDialogo } from '@/components/ui/use-dialogo';
import { api, chamar, mensagemDe } from '@/lib/api';
import { disparar } from '@/lib/disparar';
import { ConfirmarComChave } from './confirmar-com-chave';
import { ListaCodigos } from './lista-codigos';
import { avisoDosCodigos } from './textos';

// "Gerar códigos novos" (protótipo aprovado): confirma com a chave de acesso (primeiro, quando a pessoa tem; A7, W9,
// parte 9c1; D-A7-56) ou com o código do app (nunca com código de recuperação); os antigos deixam de valer na hora e os
// 10 novos aparecem uma vez só.

type Props = {
  restantes: number;
  temApp: boolean;
  temChave: boolean;
  reserva: RefObject<HTMLElement | null>;
  aoGerar: () => void;
  aoFechar: () => void;
};

export function DialogoCodigos({ restantes, temApp, temChave, reserva, aoGerar, aoFechar }: Props) {
  const campo = useRef<HTMLInputElement>(null);
  const { ref, fechar, devolverFoco } = useDialogo({ focoInicial: temChave ? undefined : campo, reserva });
  const ids = useId();
  const [codigo, setCodigo] = useState('');
  const [erroCampo, setErroCampo] = useState('');
  const [erroGeral, setErroGeral] = useState('');
  const [enviando, setEnviando] = useState(false);
  const [codigos, setCodigos] = useState<string[] | null>(null);
  const [guardei, setGuardei] = useState(false);

  // Com chave, o foco começa no botão dela (a chave vem primeiro). Depois de gerar, o foco vai para a lista nova (o
  // botão de concluir fica no fim).
  useEffect(() => {
    if (codigos) ref.current?.querySelector<HTMLElement>('h2')?.focus();
    else if (temChave) ref.current?.querySelector<HTMLElement>('[data-foco]')?.focus();
  }, [codigos, temChave, ref]);

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

  async function gerarComChave(passkey: PasskeyAssertion) {
    setErroCampo('');
    setErroGeral('');
    setEnviando(true);
    const r = await chamar(() => api.POST('/v1/me/mfa/recovery-codes', { body: { passkey } }));
    setEnviando(false);
    if (!r.ok) return setErroGeral(mensagemDe(r.problema));
    setCodigos(r.data.recovery_codes);
    aoGerar();
  }

  const titulo = codigos ? 'Guarde os códigos novos' : 'Gerar códigos novos';
  const comoConfirmar =
    temChave && temApp
      ? 'Confirme com a sua chave de acesso ou com o código do app.'
      : temChave
        ? 'Confirme com a sua chave de acesso.'
        : 'Digite o código do app para confirmar.';
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
                {restantes > 0 ? ' ' : ''}
                {comoConfirmar}
              </p>
              {temChave && (
                <ConfirmarComChave
                  focoInicial
                  impedido={enviando}
                  alternativa={temApp ? 'use o código do app' : 'tente outro aparelho com a sua chave'}
                  aoErro={setErroGeral}
                  aoProvar={gerarComChave}
                />
              )}
              {temApp && (
                <div className="campo">
                  <label htmlFor={`${ids}-cod`}>{temChave ? 'Ou o código de 6 dígitos do app' : 'Código de 6 dígitos'}</label>
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
              )}
              <p className="dialogo-nota">
                <Icone nome="shield" pequeno />
                <span>Em seguida, os 10 códigos novos aparecem uma vez só, com copiar e baixar, como na ativação do app.</span>
              </p>
            </div>
            <div className="dialogo-acoes">
              <button className="btn" type="button" onClick={fechar} disabled={enviando}>
                Cancelar
              </button>
              {temApp && (
                <button className={`btn${temChave ? '' : ' btn--primary'}`} type="submit" disabled={enviando} aria-busy={enviando}>
                  {enviando ? 'Gerando…' : temChave ? 'Gerar com o código' : 'Gerar códigos novos'}
                </button>
              )}
            </div>
          </>
        )}
      </form>
    </dialog>
  );
}
