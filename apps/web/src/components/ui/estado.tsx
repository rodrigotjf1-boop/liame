import type { ReactNode } from 'react';
import { Icone, type NomeIcone } from './icone';

// Estado de tela (vazio, erro, sem permissão, tudo em dia): título, explicação e, quando houver, o que fazer.

export function Estado({
  icone,
  titulo,
  children,
  acao,
  perigo = false,
  ok = false,
}: {
  icone: NomeIcone;
  titulo: string;
  children: ReactNode;
  acao?: ReactNode;
  perigo?: boolean;
  /** Estado bom ("Tudo em dia"): ícone na cor de sucesso. */
  ok?: boolean;
}) {
  return (
    <div className="vazio">
      <span className={`vazio-ic${perigo ? ' vazio-ic--perigo' : ok ? ' vazio-ic--ok' : ''}`} aria-hidden="true">
        <Icone nome={icone} />
      </span>
      <h2 tabIndex={-1}>{titulo}</h2>
      <p>{children}</p>
      {acao}
    </div>
  );
}
