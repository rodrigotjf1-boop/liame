'use client';

import { useDetalhes } from '@/lib/modo';
import { BarraDividida } from './desenhos';
import type { RealLite } from './graficos';
import { BotaoDetalhes, TextoRico } from './pecas';
import type { CartaoCiclo as Dados } from './textos';

// No modo simples (protótipo de Resultados em gráficos, 07/10/2026): "Para onde foi cada real vendido", uma barra
// dividida em custo dos produtos, itens sem custo, anúncios e o que sobrou (ou faltou). No Pro (protótipo P1): "Do
// anúncio ao caixa", com os 8 números do período, que o modo simples abre em "Ver detalhes".

export function CartaoCiclo({ ciclo, lite, rotuloPeriodo, datas }: { ciclo: Dados; /** O desenho do modo simples. */ lite: RealLite; rotuloPeriodo: string; datas: string }) {
  const d = useDetalhes();
  return (
    <article className="card" aria-labelledby="t-ciclo">
      <div className="card-cab">
        <div>
          <h2 id="t-ciclo">{d.pro ? 'Do anúncio ao caixa' : 'Para onde foi cada real vendido'}</h2>
          {d.pro && (
            <p className="card-sub">
              {rotuloPeriodo} · {datas}
            </p>
          )}
        </div>
      </div>
      {!d.pro && (
        <div className="desenho-b">
          {lite.tipo === 'barra' ? <BarraDividida barra={lite.barra} /> : <div className="pilha pilha--vazia" aria-hidden="true" />}
          <p className="lite-frase">
            <TextoRico frase={lite.frase} />
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
