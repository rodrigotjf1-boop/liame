import { classeDoPonto } from './contexto-resultados';
import type { Fonte } from './textos';

// "De onde vêm os números" (Pro): cada fonte, o que ela manda, o fuso e quando foi lida (A2-5). Fonte
// atrasada mostra o número com o selo da hora; o Regem não conectado aparece como tal.

export function CartaoFontes({ fontes }: { fontes: Fonte[] }) {
  return (
    <article className="card res-fontes" aria-labelledby="t-fontes">
      <div className="card-cab">
        <h2 id="t-fontes">De onde vêm os números</h2>
      </div>
      <ul className="fontes">
        {fontes.map((f) => (
          <li key={f.id}>
            <span className={classeDoPonto(f)} aria-hidden="true" />
            <span className="fonte-txt">
              <b>{f.conta ? `${f.nome} · ${f.conta}` : f.nome}</b>
              <small>
                {f.oque}
                {f.fuso ? ` · ${f.fuso}` : ''}
              </small>
            </span>
            <span className={f.situacao === 'atraso' || f.situacao === 'problema' ? 'fonte-quando fonte-quando--atraso' : 'fonte-quando'}>{f.quando}</span>
          </li>
        ))}
      </ul>
      <p className="eixo-nota">A Meta e o Google são lidos uma vez por dia, de manhã. O Regem manda os pedidos ao longo do dia.</p>
    </article>
  );
}
