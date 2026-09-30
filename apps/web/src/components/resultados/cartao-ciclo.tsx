'use client';

import { Fragment } from 'react';
import { Icone } from '@/components/ui/icone';
import { useDetalhes } from '@/lib/modo';
import { BotaoDetalhes, TextoRico } from './pecas';
import type { CartaoCiclo as Dados, Passo } from './textos';

// "Do anúncio ao caixa" (protótipo P1): no Lite, 3 passos (investiu → vendeu → sobrou) e uma frase; no
// Pro, os 8 números do período.

const TOM: Record<Passo['tom'], string> = { normal: '', foco: ' passo-lite--foco', ruim: ' passo-lite--ruim', neutro: ' passo-lite--neutro' };

export function CartaoCiclo({ ciclo, rotuloPeriodo, datas }: { ciclo: Dados; rotuloPeriodo: string; datas: string }) {
  const d = useDetalhes();
  return (
    <article className="card" aria-labelledby="t-ciclo">
      <div className="card-cab">
        <div>
          <h2 id="t-ciclo">Do anúncio ao caixa</h2>
          <p className="card-sub">
            {rotuloPeriodo} · {datas}
          </p>
        </div>
      </div>
      {!d.pro && (
        <div className="ciclo-lite">
          <div className="fluxo-lite" role="group" aria-label="Resumo do período">
            {ciclo.passos.map((p, i) => (
              <Fragment key={p.rotulo}>
                {i > 0 && (
                  <span className="fluxo-seta" aria-hidden="true">
                    <Icone nome="arrow-right" />
                  </span>
                )}
                <div className={`passo-lite${TOM[p.tom]}`}>
                  <span className="etapa-rot">{p.rotulo}</span>
                  <span className={p.texto ? 'etapa-val etapa-val--txt' : 'etapa-val num'}>{p.valor}</span>
                  {p.sub && <span className="etapa-sub">{p.sub}</span>}
                </div>
              </Fragment>
            ))}
          </div>
          <p className="lite-frase lite-frase--grande">
            <TextoRico frase={ciclo.frase} />
          </p>
        </div>
      )}
      {!d.pro && <BotaoDetalhes aberto={d.aberto} controla="ciclo-pro" aoAlternar={d.alternar} />}
      <div className="kpis" id="ciclo-pro" role="group" aria-label="Números do período" hidden={!d.mostraPro}>
        {ciclo.kpis.map((k) => (
          <div key={k.rotulo} className={k.atencao ? 'kpi kpi--atencao' : 'kpi'}>
            <p className="kpi-rot">{k.rotulo}</p>
            <p className={k.vazio ? 'kpi-val num kpi-val--vazio' : 'kpi-val num'}>{k.valor}</p>
            {k.sub && <p className="kpi-sub">{k.sub}</p>}
          </div>
        ))}
      </div>
    </article>
  );
}
