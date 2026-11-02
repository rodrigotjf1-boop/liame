'use client';

import type { PasskeyAssertion } from '@liame/contracts';
import { type FormEvent, type ReactNode, type RefObject, useEffect, useId, useRef, useState } from 'react';
import { erroDoCodigo } from '@/components/aprovacoes/textos';
import { ConfirmarComChave } from '@/components/seguranca/confirmar-com-chave';
import { Icone } from '@/components/ui/icone';
import { useDialogo } from '@/components/ui/use-dialogo';
import { mensagemDe, type Problema } from '@/lib/api';
import type { Prova } from '@/lib/chave-de-acesso';
import { disparar } from '@/lib/disparar';
import { type FormasDeConfirmar, useFormasDeConfirmar } from '@/lib/sessao';

/** A resposta do pedido feito com a confirmação: deu certo, ou o problema da API. */
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
  enviar: (prova: Prova) => Promise<Resultado>;
  /** Depois de dar certo: o que o diálogo mostra no lugar do formulário (a desistência), ou nada (fecha). */
  concluido?: ReactNode;
  /** Como a pessoa confirma, no lugar da sessão (os testes de desenho). */
  confirmar?: FormasDeConfirmar;
};

/** A recusa do código, em palavras de gente; o resto, como a API disse. */
function textoDoProblema(p: Problema): { texto: string; noCodigo: boolean } {
  if (p.code === 'codigo-invalido') return { texto: 'Código incorreto ou já usado. Espere o próximo código do app e tente de novo.', noCodigo: true };
  if (p.status === 429) return { texto: 'Muitas tentativas com o código. Espere um pouco e tente de novo.', noCodigo: true };
  return { texto: mensagemDe(p), noCodigo: false };
}

// As ações que mudam o contrato pedem a confirmação de quem decide, como aprovar (D-A7-14): trocar de plano, cancelar e
// desistir. Quem tem chave de acesso confirma com ela primeiro (A7, W9, parte 9c3; D-A7-56); o código do app fica ao
// lado. O foco vai para a chave (ou o código) ao abrir e a cada recusa (V27, ERR-185).
export function DialogoComCodigo({ titulo, children, dica, rotulo, rotuloEnviando, perigo = false, semConfirmar = false, reserva, aoFechar, enviar, concluido, confirmar }: Props) {
  const { temApp, temChave } = useFormasDeConfirmar(confirmar);
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
    else if (temChave) ref.current?.querySelector<HTMLElement>('[data-foco]')?.focus();
    else campo.current?.focus();
  }, [focar, pronto, semConfirmar, temChave, ref]);

  async function mandar(prova: Prova) {
    setEnviando(true);
    setErro(null);
    const r = await enviar(prova);
    setEnviando(false);
    if (r.ok) {
      // Quem passa `concluido` mostra a confirmação no lugar do formulário (ela nasce na mesma volta do pedido, então o
      // valor de agora pode ainda ser vazio: vale ter recebido a propriedade).
      if (concluido !== undefined) setPronto(true);
      else fechar();
      return;
    }
    const p = textoDoProblema(r.problema);
    // A recusa da chave não é do campo do código.
    setErro('code' in prova ? p : { texto: p.texto, noCodigo: false });
    if (p.noCodigo && 'code' in prova) setCodigo('');
    setFocar((n) => n + 1);
  }

  async function confirmarComCodigo(e: FormEvent) {
    e.preventDefault();
    if (!temApp) return;
    const local = erroDoCodigo(codigo);
    if (local) {
      setErro({ texto: local, noCodigo: true });
      setFocar((n) => n + 1);
      return;
    }
    await mandar({ code: codigo });
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
      <form className="dialogo-form" onSubmit={(e) => disparar(confirmarComCodigo(e))} noValidate>
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
              {!semConfirmar && temChave && (
                <ConfirmarComChave
                  focoInicial
                  perigo={perigo}
                  rotulo={`${rotulo} com a chave`}
                  impedido={enviando}
                  alternativa={temApp ? 'use o código do app' : 'tente de novo'}
                  aoErro={(texto) => setErro({ texto, noCodigo: false })}
                  aoProvar={(passkey: PasskeyAssertion) => mandar({ passkey })}
                />
              )}
              {!semConfirmar && temApp && (
                <div className="campo codigo-app">
                  <label htmlFor={`${ids}-codigo`}>{temChave ? 'Ou o código do app autenticador' : 'Código do app autenticador'}</label>
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
              {!semConfirmar && !temApp && !temChave && (
                <p className="seg-txt">Para confirmar, ative o app autenticador ou crie uma chave de acesso em Segurança da conta.</p>
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
              {!semConfirmar && temApp && (
                <button
                  className={temChave ? (perigo ? 'btn btn--perigo' : 'btn') : perigo ? 'btn btn--perigo-cheio' : 'btn btn--primary'}
                  type="submit"
                  disabled={enviando}
                  aria-busy={enviando}
                >
                  {enviando ? rotuloEnviando : temChave ? `${rotulo} com o código` : rotulo}
                </button>
              )}
            </>
          )}
        </div>
      </form>
    </dialog>
  );
}
