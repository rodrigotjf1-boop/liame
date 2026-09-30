import type { ReactNode } from 'react';

// Faixa do topo de uma tela (protótipos aprovados de Contas e Resultados): ícone, o que aconteceu, o
// motivo e, quando houver, a ação. Perigo é anunciado na hora (alert); o resto, com educação (status).

export function Faixa({
  tipo,
  icone,
  titulo,
  texto,
  acao,
}: {
  tipo?: 'acao' | 'atencao' | 'perigo';
  icone: ReactNode;
  titulo: ReactNode;
  texto: ReactNode;
  acao?: ReactNode;
}) {
  return (
    <div className={`faixa${tipo ? ` faixa--${tipo}` : ''}`} role={tipo === 'perigo' ? 'alert' : 'status'}>
      <div className="faixa-ic" aria-hidden="true">
        {icone}
      </div>
      <div className="faixa-txt">
        <b>{titulo}</b>
        <span>{texto}</span>
      </div>
      {acao}
    </div>
  );
}
