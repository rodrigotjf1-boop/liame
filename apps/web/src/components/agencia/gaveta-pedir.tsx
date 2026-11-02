'use client';

import type { PartnerRole } from '@liame/contracts';
import { type FormEvent, type RefObject, useId, useRef, useState } from 'react';
import { Icone } from '@/components/ui/icone';
import { useDialogo } from '@/components/ui/use-dialogo';
import { api, chamar, mensagemDe, novaChave } from '@/lib/api';
import { disparar } from '@/lib/disparar';
import { NIVEIS } from '@/lib/niveis';
import { NIVEIS_DA_AGENCIA } from './textos';

// "Pedir acesso a um cliente" (P27 aprovado, gaveta à direita; D-A7-46): o e-mail do dono, o que o time vai fazer e
// uma mensagem. A resposta é a mesma exista ou não a conta: o Liame não diz se o e-mail tem conta.

type Props = {
  email: string;
  reserva: RefObject<HTMLElement | null>;
  aoEnviar: (aviso: string) => void;
  aoFechar: () => void;
};

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const LINK = /(https?:\/\/|www\.)/i;
const MSG_MAX = 300;

export function GavetaPedir({ email: inicial, reserva, aoEnviar, aoFechar }: Props) {
  const ids = useId();
  const campoEmail = useRef<HTMLInputElement>(null);
  const campoMsg = useRef<HTMLTextAreaElement>(null);
  const { ref, fechar, devolverFoco } = useDialogo({ focoInicial: campoEmail, reserva });
  const chave = useRef(novaChave());
  const [email, setEmail] = useState(inicial);
  const [nivel, setNivel] = useState<PartnerRole>('gestor');
  const [msg, setMsg] = useState('');
  const [erroEmail, setErroEmail] = useState('');
  const [erroMsg, setErroMsg] = useState('');
  const [erroGeral, setErroGeral] = useState('');
  const [enviando, setEnviando] = useState(false);

  async function enviar(e: FormEvent) {
    e.preventDefault();
    setErroEmail('');
    setErroMsg('');
    setErroGeral('');
    const normalizado = email.trim().toLowerCase();
    if (!EMAIL.test(normalizado)) {
      setErroEmail('Escreva um e-mail completo, como dono@empresa.com.br.');
      campoEmail.current?.focus();
      return;
    }
    if (LINK.test(msg)) {
      setErroMsg('A mensagem não pode ter link: ela vai no e-mail ao dono.');
      campoMsg.current?.focus();
      return;
    }
    setEnviando(true);
    const r = await chamar(() =>
      api.POST('/v1/agency/requests', {
        headers: { 'Idempotency-Key': chave.current },
        body: { owner_email: normalizado, requested_role: nivel, ...(msg.trim() ? { message: msg.trim() } : {}) },
      }),
    );
    setEnviando(false);
    if (r.ok) {
      aoEnviar('Pedido enviado. Se esse e-mail for do dono de uma empresa no Liame, ele recebe o pedido.');
      return fechar();
    }
    chave.current = novaChave();
    const doEmail = r.problema.errors?.find((x) => x.path === 'owner_email');
    const daMsg = r.problema.errors?.find((x) => x.path === 'message');
    if (doEmail) {
      setErroEmail(doEmail.message);
      campoEmail.current?.focus();
    } else if (daMsg) {
      setErroMsg(daMsg.message);
      campoMsg.current?.focus();
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
      <form className="dialogo-form" onSubmit={(e) => disparar(enviar(e))} noValidate>
        <div className="dialogo-cab">
          <h2 id={`${ids}-t`}>Pedir acesso a um cliente</h2>
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
            <label htmlFor={`${ids}-email`}>E-mail do dono da empresa</label>
            <span className="campo-dica" id={`${ids}-email-dica`}>
              O pedido vai para esse e-mail e aparece em Pessoas e acessos da empresa.
            </span>
            <input
              ref={campoEmail}
              className="input"
              id={`${ids}-email`}
              type="email"
              autoComplete="off"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              aria-invalid={erroEmail ? true : undefined}
              aria-describedby={`${ids}-email-dica${erroEmail ? ` ${ids}-email-erro` : ''}`}
            />
            {erroEmail && (
              <p className="campo-erro" id={`${ids}-email-erro`}>
                {erroEmail}
              </p>
            )}
          </div>
          <fieldset className="campo">
            <legend>O que o time da agência vai fazer</legend>
            <span className="campo-dica">É um pedido: o dono escolhe o nível e o limite de gasto quando aceita.</span>
            <div className="niveis">
              {NIVEIS_DA_AGENCIA.map((k) => (
                <label className="nivel-card" key={k}>
                  <input type="radio" name="nivel-pedido" value={k} checked={nivel === k} onChange={() => setNivel(k)} />
                  <span className="nivel-card-txt">
                    <b>{NIVEIS[k].nome}</b>
                    <span>{NIVEIS[k].desc}</span>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>
          <div className="campo">
            <label htmlFor={`${ids}-msg`}>
              Mensagem para o dono <span className="campo-dica">Opcional</span>
            </label>
            <textarea
              ref={campoMsg}
              className="input textarea"
              id={`${ids}-msg`}
              maxLength={MSG_MAX}
              value={msg}
              onChange={(e) => setMsg(e.target.value)}
              aria-invalid={erroMsg ? true : undefined}
              aria-describedby={`${ids}-msg-dica${erroMsg ? ` ${ids}-msg-erro` : ''}`}
            />
            <span className="campo-dica" id={`${ids}-msg-dica`}>
              Diga quem é a agência e o que vai fazer. Até {MSG_MAX} caracteres, sem link.
            </span>
            {erroMsg && (
              <p className="campo-erro" id={`${ids}-msg-erro`}>
                {erroMsg}
              </p>
            )}
          </div>
          <p className="dialogo-nota">
            <Icone nome="info" pequeno />
            <span>
              O pedido vale 7 dias. Se esse e-mail for do dono de uma empresa no Liame, ele recebe o pedido. Por segurança, o Liame não diz se o
              e-mail tem conta.
            </span>
          </p>
        </div>
        <div className="dialogo-acoes">
          <button className="btn" type="button" onClick={fechar} disabled={enviando}>
            Cancelar
          </button>
          <button className="btn btn--primary" type="submit" disabled={enviando} aria-busy={enviando}>
            {enviando ? 'Enviando…' : 'Enviar o pedido'}
          </button>
        </div>
      </form>
    </dialog>
  );
}
