import type { ReactNode } from 'react';
import { Icone, type NomeIcone } from './icone';

// Estado de tela (vazio, erro, sem permissão): título, explicação e, quando houver, o que fazer.

export function Estado({
  icone,
  titulo,
  children,
  acao,
  perigo = false,
}: {
  icone: NomeIcone;
  titulo: string;
  children: ReactNode;
  acao?: ReactNode;
  perigo?: boolean;
}) {
  return (
    <div className="vazio">
      <span className={`vazio-ic${perigo ? ' vazio-ic--perigo' : ''}`} aria-hidden="true">
        <Icone nome={icone} />
      </span>
      <h2 tabIndex={-1}>{titulo}</h2>
      <p>{children}</p>
      {acao}
    </div>
  );
}
