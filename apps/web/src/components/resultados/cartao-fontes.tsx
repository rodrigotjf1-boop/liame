'use client';

import Link from 'next/link';
import { Icone } from '@/components/ui/icone';
import { useDetalhes } from '@/lib/modo';
import { classeDoPonto } from './contexto-resultados';
import type { FaixaDoTopo } from './graficos';
import { BotaoDetalhes } from './pecas';
import type { Fonte } from './textos';

// "De onde vêm os números" (Pro): cada fonte, o que ela manda, o fuso e quando foi lida (A2-5). Fonte
// atrasada mostra o número com o selo da hora; o Regem não conectado aparece como tal.

function ListaDeFontes({ fontes }: { fontes: Fonte[] }) {
  return (
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
  );
}

export function CartaoFontes({ fontes }: { fontes: Fonte[] }) {
  return (
    <article className="card res-fontes" aria-labelledby="t-fontes">
      <div className="card-cab">
        <h2 id="t-fontes">De onde vêm os números</h2>
      </div>
      <ListaDeFontes fontes={fontes} />
      <p className="eixo-nota">A Meta e o Google são lidos uma vez por dia, de manhã. O Regem manda os pedidos ao longo do dia.</p>
    </article>
  );
}

/**
 * A faixa única do topo (protótipo de Resultados em gráficos): o que impede ou data os números, nos dois modos. Com
 * tudo em dia, o modo simples mostra uma linha discreta. "Ver detalhes" abre, ali mesmo, quando cada fonte foi lida
 * (no Pro, isso já está no cartão das fontes).
 */
export function FaixaDoTopoDosResultados({ faixa, fontes, podeVerContas }: { faixa: FaixaDoTopo; fontes: Fonte[]; podeVerContas: boolean }) {
  const d = useDetalhes();
  if (d.pro && faixa.soNoSimples) return null;
  return (
    <div className={`frescor frescor--${faixa.tom}`}>
      <div className="frescor-linha" role={faixa.tom === 'ok' ? undefined : 'status'}>
        <Icone nome={faixa.icone} />
        <p className="frescor-txt">
          <b>{faixa.titulo}</b> {faixa.texto}
        </p>
        {faixa.acao && podeVerContas && (
          <Link className={faixa.acao.principal ? 'btn btn--sm btn--primary' : 'btn btn--sm'} href="/contas">
            {faixa.acao.rotulo}
          </Link>
        )}
        {!d.pro && <BotaoDetalhes aberto={d.aberto} controla="frescor-det" aoAlternar={d.alternar} />}
      </div>
      <div className="frescor-det" id="frescor-det" hidden={d.pro || !d.aberto}>
        <ListaDeFontes fontes={fontes} />
        <p className="eixo-nota">{faixa.nota}</p>
      </div>
    </div>
  );
}
