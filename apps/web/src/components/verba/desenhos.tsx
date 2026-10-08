import { useId } from 'react';
import { Icone } from '@/components/ui/icone';
import type { DiasLidos, MesDesenhado, PlataformaDesenhada, VereditoDaVerba } from './graficos';

// Os desenhos do cartão do mês (mockups/prototipo-verba-graficos.html, aprovado em 07/10/2026). O valor está sempre
// escrito na tela (o número do gasto, os três quadros, a legenda do teto e a tabela dos dias); a dica do mouse só
// reforça, e cada desenho tem um rótulo para o leitor de tela.

/** O selo do mês e a linha do que ele quer dizer para quem pede mudança. */
export function SeloDaVerba({ veredito }: { veredito: VereditoDaVerba }) {
  return (
    <p className="verba-veredito">
      <span className={`st st--${veredito.classe}`}>
        <span className="dot" />
        {veredito.rotulo}
      </span>
      <span>{veredito.linha}</span>
    </p>
  );
}

/**
 * "O mês, dia a dia": a linha cheia é o gasto somado até o último dia lido; o tracejado, a previsão; o traço escuro, o
 * teto. As linhas esticam com a largura (o SVG não guarda proporção); os pontos, os rótulos e as áreas são HTML, para
 * não esticarem junto.
 */
export function GraficoDoMes({ mes }: { mes: MesDesenhado }) {
  // O recorte de cada faixa (abaixo e acima do teto) precisa de um nome próprio na página.
  const id = useId().replace(/[^a-zA-Z0-9_-]/g, '');
  const { teto } = mes;
  const tracos = (classe?: string) => (
    <>
      {mes.fio && <path className={classe} d={mes.fio} />}
      <path className={classe ? `prev ${classe}` : 'prev'} d={mes.previsao} />
    </>
  );
  return (
    <div className="mes-graf">
      <h3>O mês, dia a dia</h3>
      <div className="mes-leg" aria-hidden="true">
        {mes.legenda.lido && (
          <span>
            <i className="lg-lido" />
            {mes.legenda.lido}
          </span>
        )}
        <span>
          <i className="lg-prev" />
          {mes.legenda.previsto}
        </span>
        {mes.legenda.teto && (
          <span>
            <i className="lg-teto" />
            Teto do mês <b>{mes.legenda.teto}</b>
          </span>
        )}
        {mes.legenda.acima && (
          <span>
            <i className="lg-acima" />
            Acima do teto
          </span>
        )}
      </div>
      <div className="mes-caixa" style={{ ['--calha' as string]: `${mes.calha}px` }}>
        <div className="mes-plot" role="img" tabIndex={0} aria-label={mes.rotulo} style={{ ['--teto' as string]: `${teto?.y ?? 0}%` }}>
          <div className="mes-grade" aria-hidden="true">
            {mes.grade.map((y) => (
              <span key={y} style={{ top: `${y}%` }} />
            ))}
          </div>
          <div className="mes-eixo" aria-hidden="true">
            {mes.eixo.map((e) => (
              <span key={e.texto} className={e.doTeto ? 'do-teto' : undefined} style={{ top: `${e.y}%` }}>
                {e.texto}
              </span>
            ))}
          </div>
          {mes.areaLida && (
            <div className="mes-area mes-area--lido" style={{ clipPath: mes.areaLida }}>
              <i className="acima" />
              <i className="abaixo" />
            </div>
          )}
          <div className="mes-area mes-area--prev" style={{ clipPath: mes.areaPrevista }}>
            <i className="acima" />
            <i className="abaixo" />
          </div>
          <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
            {teto ? (
              <>
                <defs>
                  <clipPath id={`${id}-abaixo`}>
                    <rect x="-5" y={teto.y} width="110" height={110 - teto.y} />
                  </clipPath>
                  <clipPath id={`${id}-acima`}>
                    <rect x="-5" y="-10" width="110" height={teto.y + 10} />
                  </clipPath>
                </defs>
                <g clipPath={`url(#${id}-abaixo)`}>{tracos()}</g>
                <g clipPath={`url(#${id}-acima)`}>{tracos('acima')}</g>
              </>
            ) : (
              tracos()
            )}
          </svg>
          {mes.alvos.map((a) => (
            <span key={a.x} className="alvo" style={{ left: `${a.x}%`, width: `${a.largura}%` }} data-dica={a.dica} />
          ))}
          {teto && <span className="mes-teto" data-dica={teto.dica} />}
          {mes.pontoLido && (
            <span className={mes.pontoLido.acima ? 'mes-pt mes-pt--acima' : 'mes-pt'} style={{ left: `${mes.pontoLido.x}%`, top: `${mes.pontoLido.y}%` }} data-dica={mes.pontoLido.dica} />
          )}
          <span className={mes.pontoPrevisto.acima ? 'mes-pt mes-pt--prev mes-pt--acima' : 'mes-pt mes-pt--prev'} style={{ left: '100%', top: `${mes.pontoPrevisto.y}%` }} data-dica={mes.pontoPrevisto.dica} />
        </div>
        <div className="mes-dias" aria-hidden="true">
          {mes.marcas.map((m) => (
            <span key={m.x} style={{ left: `${m.x}%` }}>
              {m.texto}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

/** "Onde o gasto foi": uma barra por plataforma, na mesma régua, com o valor e a parte do gasto escritos ao lado. */
export function OndeOGastoFoi({ plataformas }: { plataformas: PlataformaDesenhada[] }) {
  return (
    <div className="vb-onde">
      <h3>Onde o gasto foi</h3>
      <ul className="vb-plats">
        {plataformas.map((p) => (
          <li key={p.provider}>
            <span className={p.classe ? `plat plat--${p.classe}` : 'plat'}>{p.nome}</span>
            <div className="vb-trilho" role="img" aria-label={p.rotulo}>
              <span className="gasto" style={{ width: `${p.gasto}%` }} data-dica={p.dicaGasto} />
              {p.aMais > 0 && <span className="previsto" style={{ left: `calc(${p.gasto}% + 2px)`, width: `max(0px, calc(${p.aMais}% - 2px))` }} data-dica={p.dicaPrevisto} />}
            </div>
            <p className="vb-valor">
              <b>{p.valor}</b>
              {p.parte && <span>{p.parte}</span>}
            </p>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** A tabela do desenho, fechada até alguém pedir: o gasto de cada dia e o que o mês somava até ali. */
export function TabelaDosDias({ dias }: { dias: DiasLidos }) {
  return (
    <details className="vb-dias-tabela">
      <summary>
        <Icone nome="chevron-down" />
        Ver o gasto de cada dia
      </summary>
      <div className="table-wrap">
        <table className="tabela tabela--compacta">
          <caption className="sr-only">{dias.legenda}</caption>
          <thead>
            <tr>
              <th scope="col">Dia</th>
              <th scope="col" className="n">
                Gasto no dia
              </th>
              <th scope="col" className="n">
                No mês até aqui
              </th>
            </tr>
          </thead>
          <tbody>
            {dias.linhas.map((d) => (
              <tr key={d.dia}>
                <th scope="row">
                  <span className="num">{d.dia}</span>
                  <span className="sub">{d.semana}</span>
                  {d.falta && <span className="sub">{d.falta}</span>}
                </th>
                <td className="n num">{d.gasto}</td>
                <td className="n num">{d.soma}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}
