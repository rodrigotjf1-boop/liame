'use client';

import type { WeeklyReview } from '@liame/contracts';
import Link from 'next/link';
import { BlocoExplicacao } from '@/components/explicar/bloco-explicacao';
import { DicaDosDesenhos } from '@/components/resultados/desenhos';
import { diaMes } from '@/components/resultados/textos';
import { Bala } from '@/components/resumo/desenhos';
import { Icone } from '@/components/ui/icone';
import { CampanhasDoPeriodo } from './campanhas-do-periodo';
import { type MudancaDesenhada, mudancaDesenhada, numerosDaRevisao } from './graficos';
import { avisoDaLeitura, destinoDaDecisao, envioDaRevisao, momentoEscrito } from './textos';

// O corpo da "Revisão da semana" com a revisão já lida (mockups/prototipo-explicar.html, P4): os números da
// semana, a leitura (o mesmo bloco do Explicar, fixo), o que cada campanha trouxe no caixa, o que melhorou,
// o que piorou e o que precisa de decisão. Separado da busca para ser desenhado igual no teste e no
// navegador. Nada é calculado aqui: a revisão é a que foi gerada na segunda-feira. Desde 07/10/2026 os números, as
// campanhas e o que mudou são desenhos (mockups/prototipo-revisao-graficos.html); a tabela fica em "Ver a tabela".
// O cartão das campanhas e a linha do que mudou são os mesmos do relatório do mês (P24).

type Props = {
  revisao: WeeklyReview;
  podeVerContas: boolean;
  pode: (permissao: string) => boolean;
};

export function RevisaoConteudo({ revisao: r, podeVerContas, pode }: Props) {
  const envio = envioDaRevisao(r.email, r.timezone);
  const datas = `${diaMes(r.week.from)} a ${diaMes(r.week.to)}`;
  const numeros = numerosDaRevisao(r);

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

      <CampanhasDoPeriodo
        r={r}
        id="t-rev-camp"
        sub="O que foi investido em cada uma e o que o Regem confirmou no caixa, na mesma régua."
        lista={`Campanhas da semana de ${datas}`}
        noPeriodo="na semana"
      />

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

/** Uma mudança do período (a semana ou o mês): o nome, de quanto para quanto e a barra deste período com a marca de antes. */
export function LinhaDaMudanca({ icone, mudanca: m }: { icone: 'trend-up' | 'trend-down'; mudanca: MudancaDesenhada }) {
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
