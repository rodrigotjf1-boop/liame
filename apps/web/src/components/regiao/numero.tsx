import type { ReactNode } from 'react';

/** Um número de Sua região: o valor, o que ele é, a fonte e o detalhe técnico (só no Pro ou em "Ver detalhes"). */
export function Numero({ valor, obs, fonte, pro, classe, extra, mostraPro }: { valor: ReactNode; obs: ReactNode; fonte: string; pro?: string; classe?: string; extra?: ReactNode; mostraPro: boolean }) {
  return (
    <div className={`rg-num${classe ? ` ${classe}` : ''}`}>
      <p className="rg-num-v">{valor}</p>
      <p className="rg-num-o">{obs}</p>
      {extra}
      <p className="rg-num-f">{fonte}</p>
      {pro && mostraPro && <p className="rg-num-c">{pro}</p>}
    </div>
  );
}
