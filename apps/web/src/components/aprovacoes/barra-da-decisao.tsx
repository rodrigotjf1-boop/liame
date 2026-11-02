'use client';

import type { PasskeyAssertion } from '@liame/contracts';
import Link from 'next/link';
import { type FormEvent, type RefObject, useEffect, useRef, useState } from 'react';
import { ConfirmarComChave } from '@/components/seguranca/confirmar-com-chave';
import { Icone } from '@/components/ui/icone';
import type { Prova } from '@/lib/chave-de-acesso';
import { disparar } from '@/lib/disparar';
import { erroDoCodigo } from './textos';

// A barra da decisão, presa ao pé do pedido (protótipo aprovado): o código do app autenticador, Aprovar e Recusar
// com os motivos prontos. É a mesma para a ação e para o plano do Estrategista: aprovar pede a confirmação agora
// (ADR-007) e vale só para o que está na tela (o hash); recusar pede um motivo e não pede código. Quem tem chave de
// acesso (A7, W9, parte 9c3; P28; D-A7-56) aprova com ela primeiro; o código do app fica ao lado.

export type Decisao = { ok: true } | { ok: false; texto: string; noCodigo: boolean };

export function BarraDaDecisao({
  ids,
  temApp,
  temChave = false,
  campoCodigo,
  motivos,
  dica,
  aoAprovar,
  aoRecusar,
}: {
  /** Prefixo dos ids da barra (o erro, a dica e os motivos). */
  ids: string;
  /** A conta de quem vê tem o app autenticador ativo. */
  temApp: boolean;
  /** A conta de quem vê tem chave de acesso: ela vem primeiro. */
  temChave?: boolean;
  campoCodigo: RefObject<HTMLInputElement | null>;
  motivos: Array<{ valor: string; rotulo: string }>;
  dica: string;
  aoAprovar: (prova: Prova) => Promise<Decisao>;
  aoRecusar: (motivo: string) => Promise<Decisao>;
}) {
  const primeiroMotivo = useRef<HTMLButtonElement>(null);
  const [codigo, setCodigo] = useState('');
  const [erro, setErro] = useState<{ texto: string; noCodigo: boolean } | null>(null);
  const [recusando, setRecusando] = useState(false);
  const [ocupado, setOcupado] = useState<'aprovar' | 'recusar' | null>(null);
  const podeAprovar = temApp || temChave;

  useEffect(() => {
    if (recusando) primeiroMotivo.current?.focus();
  }, [recusando]);

  // Código recusado pelo servidor: o foco volta ao campo quando ele já está liberado de novo (durante o envio
  // o campo fica desativado, e campo desativado não recebe foco).
  useEffect(() => {
    if (erro?.noCodigo && ocupado === null) campoCodigo.current?.focus();
  }, [erro, ocupado, campoCodigo]);

  async function aprovar(e: FormEvent) {
    e.preventDefault();
    if (!temApp) return;
    const invalido = erroDoCodigo(codigo);
    if (invalido) return setErro({ texto: invalido, noCodigo: true });
    setErro(null);
    setOcupado('aprovar');
    const r = await aoAprovar({ code: codigo.trim() });
    setOcupado(null);
    if (r.ok) return;
    if (r.noCodigo) setCodigo('');
    setErro(r);
  }

  async function aprovarComChave(passkey: PasskeyAssertion) {
    setErro(null);
    setOcupado('aprovar');
    const r = await aoAprovar({ passkey });
    setOcupado(null);
    // A recusa da chave não é do campo do código: a frase fica, sem mexer no código digitado.
    if (!r.ok) setErro({ texto: r.texto, noCodigo: false });
  }

  async function recusar(motivo: string) {
    setErro(null);
    setOcupado('recusar');
    const r = await aoRecusar(motivo);
    setOcupado(null);
    if (!r.ok) setErro(r);
  }

  return (
    <form className="acoes-plano" onSubmit={(e) => disparar(aprovar(e))} noValidate>
      {erro && (
        <p className="campo-erro ap-erro" id={`${ids}-erro`} role="alert">
          {erro.texto}
        </p>
      )}
      {temChave && (
        <ConfirmarComChave
          rotulo="Aprovar com a chave"
          impedido={ocupado !== null}
          alternativa={temApp ? 'use o código do app' : 'tente de novo'}
          aoErro={(texto) => setErro({ texto, noCodigo: false })}
          aoProvar={aprovarComChave}
        />
      )}
      {temApp && (
        <label className="ap-codigo">
          <span>{temChave ? 'Ou o código do app' : 'Código do app'}</span>
          <input
            ref={campoCodigo}
            className="input mono"
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            placeholder="000000"
            value={codigo}
            onChange={(e) => {
              setCodigo(e.target.value.replace(/\D/g, ''));
              setErro(null);
            }}
            disabled={ocupado !== null}
            aria-invalid={erro?.noCodigo ? true : undefined}
            aria-describedby={erro ? `${ids}-erro` : `${ids}-dica`}
          />
        </label>
      )}
      {!podeAprovar && (
        <p className="ap-sem-app">
          Para aprovar, ative o app autenticador ou crie uma chave de acesso em <Link href="/seguranca">Segurança da conta</Link>.
        </p>
      )}
      {(temApp || !podeAprovar) && (
        <button
          className={`btn${temChave ? '' : ' btn--primary'} ap-aprovar`}
          type="submit"
          disabled={!temApp || ocupado !== null}
          aria-busy={ocupado === 'aprovar'}
        >
          <Icone nome="check" />
          {ocupado === 'aprovar' ? 'Aprovando…' : temChave ? 'Aprovar com o código' : 'Aprovar'}
          <kbd className="kbd" aria-hidden="true">
            A
          </kbd>
        </button>
      )}
      <button className="btn" type="button" aria-expanded={recusando} aria-controls={`${ids}-motivos`} onClick={() => setRecusando((x) => !x)} disabled={ocupado !== null}>
        <Icone nome="x" />
        Recusar
      </button>
      {temApp && (
        <p className="ap-dica" id={`${ids}-dica`}>
          {dica}
        </p>
      )}
      <div className="motivos" id={`${ids}-motivos`} hidden={!recusando} role="group" aria-label="Motivo da recusa">
        {motivos.map((m, i) => (
          <button key={m.valor} ref={i === 0 ? primeiroMotivo : undefined} className="chip-sug" type="button" onClick={() => disparar(recusar(m.valor))} disabled={ocupado !== null}>
            {m.rotulo}
          </button>
        ))}
      </div>
    </form>
  );
}
