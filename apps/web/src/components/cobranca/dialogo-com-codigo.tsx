'use client';

import { type FormEvent, type ReactNode, type RefObject, useEffect, useId, useRef, useState } from 'react';
import { erroDoCodigo } from '@/components/aprovacoes/textos';
import { Icone } from '@/components/ui/icone';
import { useDialogo } from '@/components/ui/use-dialogo';
import { mensagemDe, type Problema } from '@/lib/api';
import { disparar } from '@/lib/disparar';

/** A resposta do pedido feito com o código: deu certo, ou o problema da API. */
export type Resultado = { ok: true } | { ok: false; problema: Problema };

type Props = {
  titulo: string;
  /** O que a ação faz, acima do código. */
  children: ReactNode;
  /** A dica do campo: por que o código é pedido (D-A7-14). */
  dica: string;
  rotulo: string;
  rotuloEnviando: string;
  perigo?: boolean;
  /** Sem poder confirmar agora (o plano igual, na troca): o código e o botão ficam fora. */
  semConfirmar?: boolean;
  reserva: RefObject<HTMLElement | null>;
  aoFechar: () => void;
  enviar: (codigo: string) => Promise<Resultado>;
  /** Depois de dar certo: o que o diálogo mostra no lugar do formulário (a desistência), ou nada (fecha). */
  concluido?: ReactNode;
};

/** A recusa do código, em palavras de gente; o resto, como a API disse. */
function textoDoProblema(p: Problema): { texto: string; noCodigo: boolean } {
  if (p.code === 'codigo-invalido') return { texto: 'Código incorreto ou já usado. Espere o próximo código do app e tente de novo.', noCodigo: true };
  if (p.status === 429) return { texto: 'Muitas tentativas com o código. Espere um pouco e tente de novo.', noCodigo: true };
  return { texto: mensagemDe(p), noCodigo: false };
}

// As ações que mudam o contrato pedem o código do app autenticador, como aprovar (D-A7-14): trocar de plano, cancelar e
// desistir. O foco vai para o código ao abrir e a cada recusa (V27, ERR-185).
export function DialogoComCodigo({ titulo, children, dica, rotulo, rotuloEnviando, perigo = false, semConfirmar = false, reserva, aoFechar, enviar, concluido }: Props) {
  const campo = useRef<HTMLInputElement>(null);
  const fecharBt = useRef<HTMLButtonElement>(null);
  const feito = useRef<HTMLDivElement>(null);
  const { ref, fechar, devolverFoco } = useDialogo({ reserva });
  const ids = useId();
  const [codigo, setCodigo] = useState('');
  const [erro, setErro] = useState<{ texto: string; noCodigo: boolean } | null>(null);
  const [enviando, setEnviando] = useState(false);
  const [pronto, setPronto] = useState(false);
  const [focar, setFocar] = useState(1);
  useEffect(() => {
    if (pronto) feito.current?.focus();
    else if (semConfirmar) fecharBt.current?.focus();
    else campo.current?.focus();
  }, [focar, pronto, semConfirmar]);

  async function confirmar(e: FormEvent) {
    e.preventDefault();
    const local = erroDoCodigo(codigo);
    if (local) {
      setErro({ texto: local, noCodigo: true });
      setFocar((n) => n + 1);
      return;
    }
    setEnviando(true);
    setErro(null);
    const r = await enviar(codigo);
    setEnviando(false);
    if (r.ok) {
      // Quem passa `concluido` mostra a confirmação no lugar do formulário (ela nasce na mesma volta do pedido, então o
      // valor de agora pode ainda ser vazio: vale ter recebido a propriedade).
      if (concluido !== undefined) setPronto(true);
      else fechar();
      return;
    }
    const p = textoDoProblema(r.problema);
    setErro(p);
    if (p.noCodigo) setCodigo('');
    setFocar((n) => n + 1);
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
      onClick={(e) => {
        if (e.target === ref.current && !enviando) fechar();
      }}
    >
      <form className="dialogo-form" onSubmit={(e) => disparar(confirmar(e))} noValidate>
        <div className="dialogo-cab">
          <h2 id={`${ids}-t`}>{titulo}</h2>
          <button className="btn btn--ghost btn--icon" type="button" onClick={fechar} aria-label="Fechar" disabled={enviando}>
            <Icone nome="x" />
          </button>
        </div>
        <div className="dialogo-corpo">
          {pronto ? (
            <div className="protocolo" ref={feito} tabIndex={-1} role="status">
              {concluido}
            </div>
          ) : (
            <>
              {erro && !erro.noCodigo && (
                <p className="dialogo-erro" role="alert">
                  <Icone nome="alert" pequeno />
                  <span>{erro.texto}</span>
                </p>
              )}
              {children}
              {!semConfirmar && (
                <div className="campo codigo-app">
                  <label htmlFor={`${ids}-codigo`}>Código do app autenticador</label>
                  <span className="campo-dica" id={`${ids}-dica`}>
                    {dica}
                  </span>
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
                    aria-describedby={erro?.noCodigo ? `${ids}-dica ${ids}-erro` : `${ids}-dica`}
                    {...(erro?.noCodigo ? { 'aria-invalid': true as const } : {})}
                  />
                  {erro?.noCodigo && (
                    <span className="campo-erro" id={`${ids}-erro`} role="alert">
                      {erro.texto}
                    </span>
                  )}
                </div>
              )}
            </>
          )}
        </div>
        <div className="dialogo-acoes">
          {pronto ? (
            <button ref={fecharBt} className="btn btn--primary" type="button" onClick={fechar}>
              Fechar
            </button>
          ) : (
            <>
              <button ref={semConfirmar ? fecharBt : undefined} className="btn" type="button" onClick={fechar} disabled={enviando}>
                Voltar
              </button>
              {!semConfirmar && (
                <button className={perigo ? 'btn btn--perigo-cheio' : 'btn btn--primary'} type="submit" disabled={enviando} aria-busy={enviando}>
                  {enviando ? rotuloEnviando : rotulo}
                </button>
              )}
            </>
          )}
        </div>
      </form>
    </dialog>
  );
}
