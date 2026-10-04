'use client';

import { type ReactNode, useEffect, useRef } from 'react';

/**
 * Confirmação na própria linha (o padrão das telas do app): o que vai acontecer, o botão que confirma e o que desiste.
 * O foco vai para o botão que confirma quando o bloco aparece (por `ref` e efeito: `autoFocus` não vale em nó que o
 * React reaproveita); quem desiste volta ao botão de origem (quem chama cuida disso).
 */
export function ConfirmaNaLinha({
  texto,
  rotulo,
  rotuloOcupado,
  voltar = 'Cancelar',
  ocupado,
  impedido = false,
  aoConfirmar,
  aoCancelar,
  children,
}: {
  texto: string;
  rotulo: string;
  rotuloOcupado: string;
  /** O rótulo de quem desiste ("Cancelar", ou "Manter" quando a ação em si é cancelar algo). */
  voltar?: string;
  ocupado: boolean;
  /** O que foi digitado ainda não pode ser enviado. */
  impedido?: boolean;
  aoConfirmar: () => void;
  aoCancelar: () => void;
  children?: ReactNode;
}) {
  const confirmar = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    confirmar.current?.focus();
  }, []);
  return (
    <span className="confirma-linha">
      <span className="confirma-txt">{texto}</span>
      {children}
      <button ref={confirmar} className="btn btn--sm btn--perigo-cheio" type="button" onClick={aoConfirmar} disabled={ocupado || impedido} aria-busy={ocupado}>
        {ocupado ? rotuloOcupado : rotulo}
      </button>
      <button className="btn btn--sm" type="button" onClick={aoCancelar} disabled={ocupado}>
        {voltar}
      </button>
    </span>
  );
}
