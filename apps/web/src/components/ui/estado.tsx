import type { ReactNode } from 'react';
import { Icone, type NomeIcone } from './icone';

// Estado de tela (vazio, erro, sem permissão, tudo em dia): título, explicação e, quando houver, o que fazer.
// Dentro de um cartão que já tem título, o estado é compacto e o título dele desce um nível (h3).

export function Estado({
  icone,
  titulo,
  children,
  acao,
  perigo = false,
  ok = false,
  compacto = false,
}: {
  icone: NomeIcone;
  titulo: string;
  children: ReactNode;
  acao?: ReactNode;
  perigo?: boolean;
  /** Estado bom ("Tudo em dia"): ícone na cor de sucesso. */
  ok?: boolean;
  /** Dentro de um cartão (título h3, menos espaço). */
  compacto?: boolean;
}) {
  const Titulo = compacto ? 'h3' : 'h2';
  return (
    <div className={compacto ? 'vazio vazio--compacto' : 'vazio'}>
      <span className={`vazio-ic${perigo ? ' vazio-ic--perigo' : ok ? ' vazio-ic--ok' : ''}`} aria-hidden="true">
        <Icone nome={icone} />
      </span>
      <Titulo tabIndex={-1}>{titulo}</Titulo>
      <p>{children}</p>
      {acao}
    </div>
  );
}
