'use client';

import type { AgencyInvitableRole } from '@liame/contracts';
import { type FormEvent, type RefObject, useId, useRef, useState } from 'react';
import { Icone } from '@/components/ui/icone';
import { useDialogo } from '@/components/ui/use-dialogo';
import { api, chamar, mensagemDe, novaChave } from '@/lib/api';
import { disparar } from '@/lib/disparar';
import { DESC_PAPEL, PAPEL_CURTO } from './textos';

// "Convidar para a agência" (P27 aprovado, gaveta à direita; D-A7-51): o e-mail e o papel (Administrador ou Membro).

type Props = {
  ocupados: Set<string>;
  reserva: RefObject<HTMLElement | null>;
  aoConvidar: (aviso: string) => void;
  aoFechar: () => void;
};

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const PAPEIS: AgencyInvitableRole[] = ['agencia_admin', 'agencia_membro'];

export function GavetaConvidar({ ocupados, reserva, aoConvidar, aoFechar }: Props) {
  const ids = useId();
  const campoEmail = useRef<HTMLInputElement>(null);
  const { ref, fechar, devolverFoco } = useDialogo({ focoInicial: campoEmail, reserva });
  const chave = useRef(novaChave());
  const [email, setEmail] = useState('');
  const [papel, setPapel] = useState<AgencyInvitableRole>('agencia_membro');
  const [erroEmail, setErroEmail] = useState('');
  const [erroGeral, setErroGeral] = useState('');
  const [enviando, setEnviando] = useState(false);

  async function convidar(e: FormEvent) {
    e.preventDefault();
    setErroEmail('');
    setErroGeral('');
    const normalizado = email.trim().toLowerCase();
    const problema = !EMAIL.test(normalizado)
      ? 'Escreva um e-mail completo, como nome@agencia.com.br.'
      : ocupados.has(normalizado)
        ? 'Essa pessoa já está no time ou tem um convite esperando resposta.'
        : '';
    if (problema) {
      setErroEmail(problema);
      campoEmail.current?.focus();
      return;
    }
    setEnviando(true);
    const r = await chamar(() =>
      api.POST('/v1/agency/invitations', { headers: { 'Idempotency-Key': chave.current }, body: { email: normalizado, role: papel } }),
    );
    setEnviando(false);
    if (r.ok) {
      aoConvidar(`Convite enviado para ${normalizado}. Vale 7 dias.`);
      return fechar();
    }
    chave.current = novaChave();
    const doEmail = r.problema.errors?.find((x) => x.path === 'email');
    if (doEmail || r.problema.code === 'ja-esta-no-time') {
      setErroEmail(doEmail?.message ?? mensagemDe(r.problema));
      campoEmail.current?.focus();
    } else setErroGeral(mensagemDe(r.problema));
  }

  return (
    <dialog
      ref={ref}
      className="dialogo dialogo--lado"
      aria-labelledby={`${ids}-t`}
      onClose={() => {
        aoFechar();
        devolverFoco();
      }}
    >
      <form className="dialogo-form" onSubmit={(e) => disparar(convidar(e))} noValidate>
        <div className="dialogo-cab">
          <h2 id={`${ids}-t`}>Convidar para a agência</h2>
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
          <div className="campo">
            <label htmlFor={`${ids}-email`}>E-mail</label>
            <input
              ref={campoEmail}
              className="input"
              id={`${ids}-email`}
              type="email"
              autoComplete="off"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              aria-invalid={erroEmail ? true : undefined}
              aria-describedby={erroEmail ? `${ids}-email-erro` : undefined}
            />
            {erroEmail && (
              <p className="campo-erro" id={`${ids}-email-erro`}>
                {erroEmail}
              </p>
            )}
          </div>
          <fieldset className="campo">
            <legend>Papel na agência</legend>
            <div className="niveis">
              {PAPEIS.map((k) => (
                <label className="nivel-card" key={k}>
                  <input type="radio" name="papel-agencia" value={k} checked={papel === k} onChange={() => setPapel(k)} />
                  <span className="nivel-card-txt">
                    <b>{PAPEL_CURTO[k]}</b>
                    <span>{DESC_PAPEL[k]}</span>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>
          <p className="dialogo-nota">
            <Icone nome="info" pequeno />
            <span>
              O convite vale 7 dias e só para esse e-mail. A pessoa entra com o próprio login e o app autenticador, e não entra em nenhum cliente
              até você colocá-la.
            </span>
          </p>
        </div>
        <div className="dialogo-acoes">
          <button className="btn" type="button" onClick={fechar} disabled={enviando}>
            Cancelar
          </button>
          <button className="btn btn--primary" type="submit" disabled={enviando} aria-busy={enviando}>
            {enviando ? 'Enviando…' : 'Enviar o convite'}
          </button>
        </div>
      </form>
    </dialog>
  );
}
