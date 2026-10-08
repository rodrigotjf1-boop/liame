'use client';

import type { WeeklyReview } from '@liame/contracts';
import Link from 'next/link';
import { plataforma } from '@/components/contas/textos';
import { BlocoExplicacao } from '@/components/explicar/bloco-explicacao';
import { DicaDosDesenhos, Selo } from '@/components/resultados/desenhos';
import { SeloVeredito } from '@/components/resultados/pecas';
import { diaMes, nomesDe } from '@/components/resultados/textos';
import { Bala } from '@/components/resumo/desenhos';
import { Icone } from '@/components/ui/icone';
import { inteiro, reaisDeMicros } from '@/lib/formato';
import { campanhasDaRevisao, type MudancaDesenhada, mudancaDesenhada, numerosDaRevisao } from './graficos';
import { avisoDaLeitura, destinoDaDecisao, envioDaRevisao, momentoEscrito, razao, vereditoDaSemana } from './textos';

// O corpo da "Revisão da semana" com a revisão já lida (mockups/prototipo-explicar.html, P4): os números da
// semana, a leitura (o mesmo bloco do Explicar, fixo), o que cada campanha trouxe no caixa, o que melhorou,
// o que piorou e o que precisa de decisão. Separado da busca para ser desenhado igual no teste e no
// navegador. Nada é calculado aqui: a revisão é a que foi gerada na segunda-feira. Desde 07/10/2026 os números, as
// campanhas e o que mudou são desenhos (mockups/prototipo-revisao-graficos.html); a tabela fica em "Ver a tabela".

type Props = {
  revisao: WeeklyReview;
  podeVerContas: boolean;
  pode: (permissao: string) => boolean;
};

export function RevisaoConteudo({ revisao: r, podeVerContas, pode }: Props) {
  const envio = envioDaRevisao(r.email, r.timezone);
  const datas = `${diaMes(r.week.from)} a ${diaMes(r.week.to)}`;
  const total = r.totals.find((m) => m.kind === 'roas_confirmado');
  const totalDe = (kind: string) => r.totals.find((m) => m.kind === kind)?.now ?? null;
  const [investido, pedidos, receita] = [totalDe('investimento'), totalDe('pedidos_de_anuncios'), totalDe('receita_confirmada')];
  const vereditoTotal = vereditoDaSemana(r.verdict, Number(pedidos ?? 0), investido ?? '0');
  const numeros = numerosDaRevisao(r);
  const campanhas = campanhasDaRevisao(r);

  return (
    <div className="rev-sem">
      <div className="rev-topo">
        <Link className="btn btn--sm btn--ghost" href="/resultados">
          Voltar aos Resultados
        </Link>
        {envio && (
          <p className="rev-envio">
            <Icone nome="mail" pequeno />
            <span>{envio}</span>
          </p>
        )}
      </div>

      <div className="rev-nums" role="group" aria-label="Números da semana">
        {numeros.map((k) => (
          <div className="kpi" key={k.id}>
            <p className="kpi-rot">{k.rotulo}</p>
            <p className="kpi-val num">{k.valor}</p>
            {k.bala && <Bala bala={k.bala} />}
            {k.anterior === null ? (
              <p className="kpi-sub">sem semana anterior para comparar</p>
            ) : (
              <div className="stat-pe">
                {k.mudou && (
                  <p className={`stat-delta stat-delta--${k.mudou.tom}`}>
                    {k.mudou.seta && <Icone nome={k.mudou.seta === 'sobe' ? 'trend-up' : 'trend-down'} pequeno />}
                    <span>{k.mudou.texto}</span>
                  </p>
                )}
                <p className="bala-leg">
                  <i aria-hidden="true" />
                  <span>
                    semana anterior: <b className="num">{k.anterior}</b>
                  </span>
                </p>
              </div>
            )}
          </div>
        ))}
      </div>
      {numeros.some((k) => k.bala && k.bala.marca !== null) && (
        <p className="rev-chave" aria-hidden="true">
          <span>
            <i className="ch-barra" />
            esta semana
          </span>
          <span>
            <i className="ch-marca" />
            semana anterior
          </span>
        </p>
      )}

      <BlocoExplicacao
        id="revisao"
        estado={{ tipo: 'pronta', resposta: r.reading }}
        lia={r.reading.source === 'lia'}
        sobre="revisao"
        fixo
        titulos={{ lia: 'Leitura da semana, pela LIA', sistema: 'Leitura da semana, pelo sistema' }}
        quando={`gerada na ${momentoEscrito(r.generated_at, r.timezone)}`}
        aviso={avisoDaLeitura(r.reading)}
        podeVerContas={podeVerContas}
        acoes={
          <Link className="btn btn--sm" href="/resultados">
            Ver os Resultados
          </Link>
        }
      />

      {(r.campaigns.length > 0 || r.platform_only.length > 0) && (
        <article className="card" aria-labelledby="t-rev-camp">
          <div className="card-cab">
            <div>
              <h2 id="t-rev-camp">O que cada campanha trouxe no caixa</h2>
              <p className="card-sub">O que foi investido em cada uma e o que o Regem confirmou no caixa, na mesma régua.</p>
            </div>
            {campanhas.linhas.length > 0 && (
              <ul className="rev-legenda" aria-hidden="true">
                <li>
                  <i className="cor-c1" />
                  investido
                </li>
                <li>
                  <i className="cor-foco" />
                  confirmado no caixa
                </li>
              </ul>
            )}
          </div>
          {campanhas.linhas.length > 0 && (
            <ul className="camp-rev" aria-label={`Campanhas da semana de ${datas}`}>
              {campanhas.linhas.map((c) => (
                <li key={c.id}>
                  <div className="cl-nome">
                    <b>{c.nome}</b>
                    <span>{c.sub}</span>
                  </div>
                  <div className="par" role="img" aria-label={c.rotulo}>
                    <div className="par-linha">
                      <span>investido</span>
                      <b className="par-valor">{c.investido.valor}</b>
                      <div className="trilho">
                        <span className="barra barra--gasto" style={{ width: `${c.investido.largura}%` }} data-dica={c.investido.dica} />
                      </div>
                    </div>
                    <div className="par-linha">
                      <span>no caixa</span>
                      <b className="par-valor">{c.caixa.valor}</b>
                      <div className="trilho">{c.caixa.largura > 0 && <span className="barra" style={{ width: `${c.caixa.largura}%` }} data-dica={c.caixa.dica} />}</div>
                    </div>
                  </div>
                  {c.selo ? <Selo selo={c.selo} /> : <span className="veredito-vago" />}
                </li>
              ))}
            </ul>
          )}
          {campanhas.notas.map((nota) => (
            <p className="eixo-nota" key={nota}>
              {nota}
            </p>
          ))}
          <p className="rev-total">
            <span>
              <b>Total:</b> <span className="num">{investido === null ? '—' : reaisDeMicros(investido)}</span> investidos · <span className="num">{pedidos === null ? '—' : inteiro(pedidos)}</span> pedidos ·{' '}
              <span className="num">{receita === null ? '—' : reaisDeMicros(receita)}</span> no caixa · ROAS <span className="num">{razao(total?.now ?? null)}</span>
            </span>
            {vereditoTotal && <SeloVeredito veredito={vereditoTotal} />}
          </p>
          <details className="rev-tabela">
            <summary>
              <Icone nome="chevron-down" pequeno />
              Ver a tabela
            </summary>
            <div className="table-wrap">
              <table className="tabela">
                <caption className="sr-only">Campanhas da semana de {datas}: investimento, pedidos, receita, ROAS confirmado no caixa e resultado</caption>
                <thead>
                  <tr>
                    <th scope="col">Campanha</th>
                    <th scope="col" className="n">
                      Investido
                    </th>
                    <th scope="col" className="n">
                      Pedidos
                    </th>
                    <th scope="col" className="n">
                      Receita
                    </th>
                    <th scope="col" className="n">
                      ROAS caixa
                    </th>
                    <th scope="col">Resultado</th>
                  </tr>
                </thead>
                <tbody>
                  {r.campaigns.map((c) => {
                    const plat = plataforma(c.provider);
                    const veredito = vereditoDaSemana(c.verdict, c.orders, c.spend_micros);
                    return (
                      <tr key={c.campaign_id}>
                        <th scope="row">
                          {c.name}
                          <span className="camp-canal">
                            <span className={`plat plat--${plat.classe}`}>{plat.nome}</span>
                          </span>
                        </th>
                        <td className="n num">{reaisDeMicros(c.spend_micros)}</td>
                        <td className="n num">{inteiro(c.orders)}</td>
                        <td className="n num">{reaisDeMicros(c.revenue_micros)}</td>
                        <td className="n num forte">{razao(c.roas)}</td>
                        <td>{veredito ? <SeloVeredito veredito={veredito} /> : <span className="eixo-nota">{c.orders === 0 ? 'sem pedido na semana' : '—'}</span>}</td>
                      </tr>
                    );
                  })}
                  {r.platform_only.map((p) => (
                    <tr className="linha-plat" key={p.provider}>
                      <th scope="row">{nomesDe(p.provider).nome.replace(' Ads', '')} · sem campanha identificada</th>
                      <td className="n">—</td>
                      <td className="n num">{inteiro(p.orders)}</td>
                      <td className="n num">{p.revenue_micros === null ? '—' : reaisDeMicros(p.revenue_micros)}</td>
                      <td className="n">—</td>
                      <td>
                        <span className="eixo-nota">conta no total</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <th scope="row">Total</th>
                    <td className="n num">{investido === null ? '—' : reaisDeMicros(investido)}</td>
                    <td className="n num">{pedidos === null ? '—' : inteiro(pedidos)}</td>
                    <td className="n num">{receita === null ? '—' : reaisDeMicros(receita)}</td>
                    <td className="n num forte">{razao(total?.now ?? null)}</td>
                    <td>{vereditoTotal && <SeloVeredito veredito={vereditoTotal} />}</td>
                  </tr>
                </tfoot>
              </table>
            </div>
          </details>
        </article>
      )}

      <div className="rev-duas">
        <article className="card" aria-labelledby="t-rev-bom">
          <div className="card-cab">
            <h2 id="t-rev-bom">O que melhorou</h2>
          </div>
          {r.improved.length ? (
            <ul className="rev-lista rev-lista--g rev-lista--bom">
              {r.improved.map((m) => (
                <LinhaDaMudanca key={`${m.kind}-${m.campaign?.id ?? ''}`} icone="trend-up" mudanca={mudancaDesenhada(m, r)} />
              ))}
            </ul>
          ) : (
            <p className="rev-nada">Nada mudou para melhor sobre a semana anterior.</p>
          )}
        </article>
        <article className="card" aria-labelledby="t-rev-ruim">
          <div className="card-cab">
            <h2 id="t-rev-ruim">O que piorou</h2>
          </div>
          {r.worsened.length ? (
            <ul className="rev-lista rev-lista--g rev-lista--ruim">
              {r.worsened.map((m) => (
                <LinhaDaMudanca key={`${m.kind}-${m.campaign?.id ?? ''}`} icone="trend-down" mudanca={mudancaDesenhada(m, r)} />
              ))}
            </ul>
          ) : (
            <p className="rev-nada">Nada piorou sobre a semana anterior.</p>
          )}
        </article>
      </div>

      <article className="card" aria-labelledby="t-rev-dec">
        <div className="card-cab">
          <div>
            <h2 id="t-rev-dec">Precisa de decisão</h2>
            <p className="card-sub">O Liame aponta; quem decide é você. Nada muda nas campanhas por aqui.</p>
          </div>
        </div>
        {r.decisions.length ? (
          <ul className="rev-decisoes">
            {r.decisions.map((d, i) => {
              const destino = destinoDaDecisao(d, pode);
              return (
                <li key={`${d.kind}-${d.campaign_id ?? ''}-${i}`}>
                  <div>
                    <b>{d.title}</b>
                    <span>{d.detail}</span>
                  </div>
                  {destino && (
                    <Link className="btn btn--sm" href={destino.href}>
                      {destino.rotulo}
                    </Link>
                  )}
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="rev-nada">Nada pede decisão nesta semana.</p>
        )}
      </article>
      <DicaDosDesenhos />
    </div>
  );
}

/** Uma mudança da semana: o nome, de quanto para quanto e a barra desta semana com a marca de antes. */
function LinhaDaMudanca({ icone, mudanca: m }: { icone: 'trend-up' | 'trend-down'; mudanca: MudancaDesenhada }) {
  return (
    <li>
      <Icone nome={icone} />
      <div className="mud-topo">
        <span className="mud-nome">{m.nome}</span>
        <span className="mud-de-para">
          <span className="sr-only">de </span>
          {m.de}
          <span aria-hidden="true"> → </span>
          <span className="sr-only"> para </span>
          {m.para}
          {m.variacao && <small> {m.variacao}</small>}
        </span>
      </div>
      {m.bala && <Bala bala={m.bala} />}
    </li>
  );
}
