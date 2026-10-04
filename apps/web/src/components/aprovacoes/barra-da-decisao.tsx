'use client';

import Link from 'next/link';
import { type FormEvent, type RefObject, useEffect, useRef, useState } from 'react';
import { Icone } from '@/components/ui/icone';
import { disparar } from '@/lib/disparar';
import { erroDoCodigo } from './textos';

// A barra da decisão, presa ao pé do pedido (protótipo aprovado): o código do app autenticador, Aprovar e Recusar
// com os motivos prontos. É a mesma para a ação e para o plano do Estrategista: aprovar pede o código agora
// (ADR-007) e vale só para o que está na tela (o hash); recusar pede um motivo e não pede código.

export type Decisao = { ok: true } | { ok: false; texto: string; noCodigo: boolean };

export function BarraDaDecisao({
  ids,
  temApp,
  campoCodigo,
  motivos,
  dica,
  aoAprovar,
  aoRecusar,
}: {
  /** Prefixo dos ids da barra (o erro, a dica e os motivos). */
  ids: string;
  /** A conta de quem vê tem o app autenticador ativo (sem ele, o servidor não deixa aprovar). */
  temApp: boolean;
  campoCodigo: RefObject<HTMLInputElement | null>;
  motivos: Array<{ valor: string; rotulo: string }>;
  dica: string;
  aoAprovar: (codigo: string) => Promise<Decisao>;
  aoRecusar: (motivo: string) => Promise<Decisao>;
}) {
  const primeiroMotivo = useRef<HTMLButtonElement>(null);
  const [codigo, setCodigo] = useState('');
  const [erro, setErro] = useState<{ texto: string; noCodigo: boolean } | null>(null);
  const [recusando, setRecusando] = useState(false);
  const [ocupado, setOcupado] = useState<'aprovar' | 'recusar' | null>(null);

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
    const invalido = erroDoCodigo(codigo);
    if (invalido) return setErro({ texto: invalido, noCodigo: true });
    setErro(null);
    setOcupado('aprovar');
    const r = await aoAprovar(codigo.trim());
    setOcupado(null);
    if (r.ok) return;
    if (r.noCodigo) setCodigo('');
    setErro(r);
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
      {temApp ? (
        <label className="ap-codigo">
          <span>Código do app</span>
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
      ) : (
        <p className="ap-sem-app">
          Para aprovar, ative o app autenticador em <Link href="/seguranca">Segurança da conta</Link>.
        </p>
      )}
      <button className="btn btn--primary ap-aprovar" type="submit" disabled={!temApp || ocupado !== null} aria-busy={ocupado === 'aprovar'}>
        <Icone nome="check" />
        {ocupado === 'aprovar' ? 'Aprovando…' : 'Aprovar'}
        <kbd className="kbd" aria-hidden="true">
          A
        </kbd>
      </button>
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
