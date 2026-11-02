'use client';

import type { OwnershipResponse, OwnershipTransfer } from '@liame/contracts';
import { type FormEvent, type RefObject, useId, useRef, useState } from 'react';
import { Icone } from '@/components/ui/icone';
import { useDialogo } from '@/components/ui/use-dialogo';
import { api, chamar, mensagemDe } from '@/lib/api';
import { disparar } from '@/lib/disparar';
import { useTermos } from '@/lib/entrada';
import { dataCompleta, quandoComHora } from '@/lib/formato';
import { CONTINUA, fraseDepoisDoAceite, oQuePassa, primeiroNome } from './propriedade-textos';

// "Aceitar a propriedade" (P34 aprovado; D-A7-60): o que passa para quem aceita e o que continua, o aceite dos Termos
// de Uso como dona e o código do app. Na hora do aceite, a conta passa a ser dela.

type Props = {
  pedido: OwnershipTransfer;
  empresa: string;
  reserva: RefObject<HTMLElement | null>;
  aoAceitar: (r: OwnershipResponse) => void;
  aoFechar: () => void;
};

export function GavetaAceitarPropriedade({ pedido: p, empresa, reserva, aoAceitar, aoFechar }: Props) {
  const ids = useId();
  const campoTermos = useRef<HTMLInputElement>(null);
  const campoCodigo = useRef<HTMLInputElement>(null);
  const { ref, fechar, devolverFoco } = useDialogo({ focoInicial: campoTermos, reserva });
  const { termos, problema: semTermos } = useTermos();
  const [aceito, setAceito] = useState(false);
  const [codigo, setCodigo] = useState('');
  const [erro, setErro] = useState('');
  const [enviando, setEnviando] = useState(false);
  const de = primeiroNome(p.from.name);

  async function aceitar(e: FormEvent) {
    e.preventDefault();
    setErro('');
    if (!termos) return setErro(semTermos ? mensagemDe(semTermos) : 'Os Termos ainda estão carregando. Tente de novo em instantes.');
    if (!aceito) {
      setErro('Para aceitar a propriedade, leia e aceite os Termos de Uso como dona da conta.');
      return campoTermos.current?.focus();
    }
    if (!/^\d{6}$/.test(codigo.trim())) {
      setErro('Digite os 6 dígitos que o seu app mostra agora.');
      return campoCodigo.current?.focus();
    }
    setEnviando(true);
    const r = await chamar(() =>
      api.POST('/v1/ownership/transfers/{id}/accept', { params: { path: { id: p.id } }, body: { code: codigo.trim(), terms_version: termos.version } }),
    );
    setEnviando(false);
    if (r.ok) {
      aoAceitar(r.data);
      return fechar();
    }
    setErro(mensagemDe(r.problema));
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
      <form className="dialogo-form" onSubmit={(e) => disparar(aceitar(e))} noValidate>
        <div className="dialogo-cab">
          <h2 id={`${ids}-t`}>Receber a propriedade da {empresa}</h2>
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
            {de} pediu {quandoComHora(p.created_at)}. O pedido vale até {dataCompleta(p.expires_at)}.
          </p>
          <div className="prop-muda-grid">
            <div className="prop-muda">
              <h3>Passa para você</h3>
              <ul>
                {oQuePassa(null).map((t) => (
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
          <p className="aviso-seg aviso-seg--atencao">
            <b>{fraseDepoisDoAceite(de, p.old_owner_stays, empresa)}.</b>
            <span>
              {p.old_owner_stays
                ? `Depois de aceitar, você muda o nível de ${de} ou tira o acesso quando quiser.`
                : `O acesso de ${de} sai na hora do aceite.`}
            </span>
          </p>
          <label className="check">
            <input ref={campoTermos} type="checkbox" checked={aceito} onChange={(e) => setAceito(e.target.checked)} disabled={enviando} />
            <span>
              Li e aceito os{' '}
              {termos ? (
                <a href={termos.terms_url} target="_blank" rel="noreferrer">
                  Termos de Uso
                </a>
              ) : (
                'Termos de Uso'
              )}{' '}
              como dona da conta da {empresa}.
            </span>
          </label>
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
        </div>
        <div className="dialogo-acoes">
          <button className="btn" type="button" onClick={fechar} disabled={enviando}>
            Voltar
          </button>
          <button className="btn btn--primary" type="submit" disabled={enviando}>
            {enviando ? 'Aceitando…' : 'Aceitar a propriedade'}
          </button>
        </div>
      </form>
    </dialog>
  );
}
