'use client';

import type { WeeklyReview } from '@liame/contracts';
import { plataforma } from '@/components/contas/textos';
import { Selo } from '@/components/resultados/desenhos';
import { SeloVeredito } from '@/components/resultados/pecas';
import { nomesDe } from '@/components/resultados/textos';
import { Icone } from '@/components/ui/icone';
import { inteiro, reaisDeMicros } from '@/lib/formato';
import { campanhasDaRevisao } from './graficos';
import { razao, vereditoDaSemana } from './textos';

// "O que cada campanha trouxe no caixa", da revisão da semana (P4, em gráficos desde 07/10/2026) e do relatório do mês
// (P24): as barras de cada campanha na mesma régua, o total e a tabela em "Ver a tabela". O que muda de uma tela para a
// outra vem nas props: o subtítulo, o nome da lista e o período ("na semana", "no mês").

type Props = {
  r: Pick<WeeklyReview, 'campaigns' | 'platform_only' | 'totals' | 'verdict'>;
  /** O id do título do cartão. */
  id: string;
  sub: string;
  /** "Campanhas da semana de 21/09 a 27/09" / "Campanhas de setembro": o nome da lista e da tabela, para quem ouve a tela. */
  lista: string;
  /** "na semana" / "no mês". */
  noPeriodo: string;
};

export function CampanhasDoPeriodo({ r, id, sub, lista, noPeriodo }: Props) {
  if (r.campaigns.length === 0 && r.platform_only.length === 0) return null;
  const total = r.totals.find((m) => m.kind === 'roas_confirmado');
  const totalDe = (kind: string) => r.totals.find((m) => m.kind === kind)?.now ?? null;
  const [investido, pedidos, receita] = [totalDe('investimento'), totalDe('pedidos_de_anuncios'), totalDe('receita_confirmada')];
  const vereditoTotal = vereditoDaSemana(r.verdict, Number(pedidos ?? 0), investido ?? '0');
  const campanhas = campanhasDaRevisao(r, noPeriodo);

  return (
    <article className="card" aria-labelledby={id}>
      <div className="card-cab">
        <div>
          <h2 id={id}>O que cada campanha trouxe no caixa</h2>
          <p className="card-sub">{sub}</p>
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
        <ul className="camp-rev" aria-label={lista}>
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
            <caption className="sr-only">{`${lista}: investimento, pedidos, receita, ROAS confirmado no caixa e resultado`}</caption>
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
                    <td>{veredito ? <SeloVeredito veredito={veredito} /> : <span className="eixo-nota">{c.orders === 0 ? `sem pedido ${noPeriodo}` : '—'}</span>}</td>
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
  );
}
