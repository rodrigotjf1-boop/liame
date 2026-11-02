'use client';

import type { MemberResponse, OwnershipResponse } from '@liame/contracts';
import { type FormEvent, type RefObject, useId, useMemo, useRef, useState } from 'react';
import { Icone } from '@/components/ui/icone';
import { useDialogo } from '@/components/ui/use-dialogo';
import { api, chamar, mensagemDe } from '@/lib/api';
import { disparar } from '@/lib/disparar';
import { dataCompleta } from '@/lib/formato';
import { NIVEIS } from '@/lib/niveis';
import { CONTINUA, depoisDoAceite, motivoDeNaoPoder, oQuePassa, primeiroNome } from './propriedade-textos';

// "Transferir a propriedade" (P34 aprovado, gaveta em três passos; D-A7-59 a D-A7-61): para quem (só um Administrador
// com o app, de fora das agências; os outros aparecem com o motivo), o que muda e se o Dono fica, e confirmar com o
// código do app. O pedido vale 7 dias, e até o aceite nada muda.

type Props = {
  membros: MemberResponse[];
  propriedade: OwnershipResponse;
  empresa: string;
  reserva: RefObject<HTMLElement | null>;
  aoPedir: (r: OwnershipResponse) => void;
  /** "Convidar pessoa": a gaveta fecha e o convite abre (quem vai receber ainda não está na empresa). */
  aoConvidar: () => void;
  aoFechar: () => void;
};

const PASSOS = ['Para quem', 'O que muda', 'Confirmar'];

export function GavetaTransferir({ membros, propriedade, empresa, reserva, aoPedir, aoConvidar, aoFechar }: Props) {
  const ids = useId();
  const primeiro = useRef<HTMLInputElement>(null);
  const campoCodigo = useRef<HTMLInputElement>(null);
  const { ref, fechar, devolverFoco } = useDialogo({ focoInicial: primeiro, reserva });
  const [passo, setPasso] = useState(1);
  const [para, setPara] = useState<string | null>(null);
  const [fica, setFica] = useState(true);
  const [codigo, setCodigo] = useState('');
  const [erro, setErro] = useState('');
  const [enviando, setEnviando] = useState(false);
  const podem = useMemo(() => new Set(propriedade.candidates.map((c) => c.user_id)), [propriedade]);
  const opcoes = membros.filter((m) => m.user_id !== propriedade.owner.user_id);
  const escolhido = opcoes.find((m) => m.user_id === para) ?? null;
  // O foco começa na primeira pessoa que pode receber.
  const primeiroQuePode = opcoes.findIndex((m) => !motivoDeNaoPoder(m, podem));
  const nome = escolhido ? primeiroNome(escolhido.name) : '';
  const vence = new Date(Date.now() + 7 * 86_400_000).toISOString();

  async function seguir(e: FormEvent) {
    e.preventDefault();
    setErro('');
    if (passo === 1) {
      if (!escolhido) return setErro('Escolha quem vai receber a propriedade.');
      return setPasso(2);
    }
    if (passo === 2) {
      setPasso(3);
      setTimeout(() => campoCodigo.current?.focus(), 0);
      return;
    }
    if (!/^\d{6}$/.test(codigo.trim())) {
      setErro('Digite os 6 dígitos que o seu app mostra agora.');
      return campoCodigo.current?.focus();
    }
    setEnviando(true);
    const r = await chamar(() => api.POST('/v1/ownership/transfers', { body: { to_user_id: para!, old_owner_stays: fica, code: codigo.trim() } }));
    setEnviando(false);
    if (r.ok) {
      aoPedir(r.data);
      return fechar();
    }
    setErro(mensagemDe(r.problema));
    if (r.problema.code === 'codigo-invalido' || r.problema.status === 401) campoCodigo.current?.focus();
  }

  let corpo;
  if (passo === 1) {
    corpo = (
      <fieldset className="campo">
        <legend>Quem vai receber a propriedade</legend>
        <span className="campo-dica">Só um Administrador da {empresa}, que já entra com o app autenticador.</span>
        <div className="opcoes">
          {opcoes.map((m, i) => {
            const motivo = motivoDeNaoPoder(m, podem);
            return (
              <label className={`opcao${motivo ? ' opcao--nao' : ''}`} key={m.user_id}>
                <input
                  ref={i === primeiroQuePode ? primeiro : undefined}
                  type="radio"
                  name={`${ids}-para`}
                  value={m.user_id}
                  disabled={Boolean(motivo)}
                  checked={para === m.user_id}
                  onChange={() => setPara(m.user_id)}
                  aria-describedby={motivo ? `${ids}-m-${m.user_id}` : undefined}
                />
                <span className="opcao-txt">
                  <b>
                    {m.name} · {NIVEIS[m.role]?.nome ?? m.role}
                    {m.partner ? ` pela ${m.partner.agency_name}` : ''}
                  </b>
                  <span>{m.email}</span>
                  {motivo && (
                    <span className="opcao-motivo" id={`${ids}-m-${m.user_id}`}>
                      {motivo}
                    </span>
                  )}
                </span>
              </label>
            );
          })}
        </div>
        <p className="lite-frase">
          Quem vai receber ainda não está aqui?{' '}
          <button
            className="link-bt"
            type="button"
            aria-haspopup="dialog"
            onClick={() => {
              fechar();
              aoConvidar();
            }}
          >
            Convide como Administrador
          </button>{' '}
          e volte quando a pessoa entrar e ativar o app.
        </p>
      </fieldset>
    );
  } else if (passo === 2) {
    corpo = (
      <>
        <div className="prop-muda-grid">
          <div className="prop-muda">
            <h3>Passa para {nome}</h3>
            <ul>
              {oQuePassa(nome).map((t) => (
                <li key={t}>
                  <Icone nome="check-circle" pequeno />
                  <span>{t}</span>
                </li>
              ))}
            </ul>
          </div>
          <div className="prop-muda">
            <h3>Continua como está</h3>
            <ul>
              {CONTINUA.map((t) => (
                <li key={t}>
                  <Icone nome="check-circle" pequeno />
                  <span>{t}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
        <fieldset className="campo">
          <legend>E você, depois que {nome} aceitar?</legend>
          <div className="opcoes">
            <label className="opcao">
              <input type="radio" name={`${ids}-fica`} checked={fica} onChange={() => setFica(true)} />
              <span className="opcao-txt">
                <b>Fico como Administrador, sem a cobrança</b>
                <span>{nome} decide depois se você vê a cobrança, muda o seu nível ou tira o seu acesso.</span>
              </span>
            </label>
            <label className="opcao">
              <input type="radio" name={`${ids}-fica`} checked={!fica} onChange={() => setFica(false)} />
              <span className="opcao-txt">
                <b>Saio da {empresa}</b>
                <span>O seu acesso sai na hora do aceite.</span>
              </span>
            </label>
          </div>
        </fieldset>
      </>
    );
  } else {
    corpo = (
      <>
        <dl className="resumo-pedido">
          <div>
            <dt>Para</dt>
            <dd>
              {escolhido?.name} ({escolhido?.email})
            </dd>
          </div>
          <div>
            <dt>Você, depois do aceite</dt>
            <dd>{depoisDoAceite(fica, empresa)}</dd>
          </div>
          <div>
            <dt>O pedido vale até</dt>
            <dd className="num">{dataCompleta(vence)}</dd>
          </div>
        </dl>
        <p className="lite-frase">
          {nome} recebe um e-mail e o pedido no Liame, e aceita com o código do app. Até lá, nada muda, e você cancela quando quiser.
        </p>
        <div className="campo">
          <label htmlFor={`${ids}-cod`}>Código do app autenticador</label>
          <input
            ref={campoCodigo}
            className="input num"
            id={`${ids}-cod`}
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            value={codigo}
            onChange={(e) => setCodigo(e.target.value.replace(/\D/g, ''))}
            aria-describedby={`${ids}-cod-dica`}
          />
          <span className="campo-dica" id={`${ids}-cod-dica`}>
            O código de 6 dígitos que o seu app mostra agora.
          </span>
        </div>
      </>
    );
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
      <form className="dialogo-form" onSubmit={(e) => disparar(seguir(e))} noValidate>
        <div className="dialogo-cab">
          <h2 id={`${ids}-t`}>Transferir a propriedade</h2>
          <button className="btn btn--ghost btn--icon" type="button" onClick={fechar} aria-label="Fechar" disabled={enviando}>
            <Icone nome="x" />
          </button>
        </div>
        <div className="dialogo-corpo">
          <ol className="prop-passos" aria-label="Passos">
            {PASSOS.map((p, i) => (
              <li key={p} aria-current={i + 1 === passo ? 'step' : undefined}>
                <span className="n">{i + 1}</span>
                {p}
              </li>
            ))}
          </ol>
          {erro && (
            <p className="dialogo-erro" role="alert">
              <Icone nome="alert" pequeno />
              <span>{erro}</span>
            </p>
          )}
          {corpo}
        </div>
        <div className="dialogo-acoes">
          {passo === 1 ? (
            <button className="btn" type="button" onClick={fechar} disabled={enviando}>
              Cancelar
            </button>
          ) : (
            <button className="btn" type="button" onClick={() => setPasso((p) => p - 1)} disabled={enviando}>
              Voltar
            </button>
          )}
          <button className="btn btn--primary" type="submit" disabled={enviando}>
            {passo < 3 ? 'Continuar' : enviando ? 'Enviando…' : 'Enviar o pedido'}
          </button>
        </div>
      </form>
    </dialog>
  );
}
