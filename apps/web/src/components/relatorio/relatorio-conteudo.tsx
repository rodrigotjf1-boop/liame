'use client';

import type { MonthlyReport } from '@liame/contracts';
import Link from 'next/link';
import { Avatar } from '@/components/equipe/pecas';
import { BlocoExplicacao } from '@/components/explicar/bloco-explicacao';
import { DicaDosDesenhos, Selo } from '@/components/resultados/desenhos';
import { Bala } from '@/components/resumo/desenhos';
import { CampanhasDoPeriodo } from '@/components/revisao/campanhas-do-periodo';
import { dica, mudancaNoPeriodo, numerosDoPeriodo, type PeriodoDoDesenho } from '@/components/revisao/graficos';
import { LinhaDaMudanca } from '@/components/revisao/revisao-conteudo';
import { destinoDaDecisao } from '@/components/revisao/textos';
import { Icone } from '@/components/ui/icone';
import { semanasDoMes } from './graficos';
import {
  avisoDaLeituraDoMes,
  custoDoMes,
  envioDoRelatorio,
  equipeDoMes,
  mudancaDoMes,
  noMomento,
  nomeDoMes,
  notaDoCorte,
  periodoDoMes,
  semMesAnterior,
  verbaNaTela,
} from './textos';

// O corpo do "Relatório do mês" com o relatório já lido (mockups/prototipo-relatorio-mes.html, P24 aprovado em
// 21/10/2026): o desenho da revisão da semana com o mês (os números contra o mês anterior, a leitura, as campanhas e o
// que mudou), mais semana a semana, a verba do mês, o que a equipe fez e o que fica para o mês que vem. Separado da
// busca para ser desenhado igual no teste e no navegador. Nada é calculado aqui: o relatório é o que foi gerado no dia
// 1º. A verba e a equipe só vêm para quem vê a Verba do mês e Sua equipe (o servidor tira as duas dos outros).

type Props = {
  relatorio: MonthlyReport;
  podeVerContas: boolean;
  pode: (permissao: string) => boolean;
};

const SEM_ANTERIOR = 'Sem mês anterior para comparar: este é o primeiro mês com as vendas conectadas.';

export function RelatorioConteudo({ relatorio: r, podeVerContas, pode }: Props) {
  const envio = envioDoRelatorio(r.email, r.timezone);
  const periodo = periodoDoMes(r);
  const mes = nomeDoMes(r.month.from);
  const numeros = numerosDoPeriodo(r.totals, periodo);
  const semanas = semanasDoMes(r);
  const corte = notaDoCorte(r.weeks);
  const primeiroMes = semMesAnterior(r);

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

      <div className="rev-nums" role="group" aria-label="Números do mês">
        {numeros.map((k) => (
          <div className="kpi" key={k.id}>
            <p className="kpi-rot">{k.rotulo}</p>
            <p className="kpi-val num">{k.valor}</p>
            {k.bala && <Bala bala={k.bala} />}
            {k.anterior === null ? (
              <p className="kpi-sub">sem mês anterior para comparar</p>
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
                    {periodo.dicaAntes}: <b className="num">{k.anterior}</b>
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
            {periodo.dicaAgora}
          </span>
          <span>
            <i className="ch-marca" />
            {periodo.dicaAntes}
          </span>
        </p>
      )}

      <BlocoExplicacao
        id="relatorio"
        estado={{ tipo: 'pronta', resposta: r.reading }}
        lia={r.reading.source === 'lia'}
        sobre="relatorio"
        fixo
        titulos={{ lia: 'Leitura do mês, pela LIA', sistema: 'Leitura do mês, pelo sistema' }}
        quando={`gerada ${noMomento(r.generated_at, r.timezone)}`}
        aviso={avisoDaLeituraDoMes(r.reading)}
        podeVerContas={podeVerContas}
        acoes={
          <Link className="btn btn--sm" href="/resultados">
            Ver os Resultados
          </Link>
        }
      />

      {semanas.length > 0 && (
        <article className="card" aria-labelledby="t-rm-semanas">
          <div className="card-cab">
            <div>
              <h2 id="t-rm-semanas">Semana a semana</h2>
              <p className="card-sub">O que foi investido em cada semana do mês e o que o Regem confirmou no caixa, na mesma régua.</p>
            </div>
            <Legenda />
          </div>
          <ul className="camp-rev" aria-label={`Semanas de ${mes}`}>
            {semanas.map((w) => (
              <li key={w.id}>
                <div className="cl-nome rm-sem-nome">
                  <b>{w.nome}</b>
                  <span>{w.sub}</span>
                  {w.revisao && (
                    <Link className="link-bt" href={w.revisao.href}>
                      {w.revisao.rotulo}
                    </Link>
                  )}
                </div>
                <div className="par" role="img" aria-label={w.rotulo}>
                  <div className="par-linha">
                    <span>investido</span>
                    <b className="par-valor">{w.investido.valor}</b>
                    <div className="trilho">
                      <span className="barra barra--gasto" style={{ width: `${w.investido.largura}%` }} data-dica={w.investido.dica} />
                    </div>
                  </div>
                  <div className="par-linha">
                    <span>no caixa</span>
                    <b className="par-valor">{w.caixa.valor}</b>
                    <div className="trilho">{w.caixa.largura > 0 && <span className="barra" style={{ width: `${w.caixa.largura}%` }} data-dica={w.caixa.dica} />}</div>
                  </div>
                </div>
                {w.selo ? <Selo selo={w.selo} /> : <span className="veredito-vago" />}
              </li>
            ))}
          </ul>
          {corte && <p className="eixo-nota rm-nota-corte">{corte}</p>}
        </article>
      )}

      <CampanhasDoPeriodo
        r={r}
        id="t-rm-camp"
        sub="O que foi investido em cada uma no mês e o que o Regem confirmou no caixa, na mesma régua."
        lista={`Campanhas de ${mes}`}
        noPeriodo="no mês"
      />

      <div className="rev-duas">
        <article className="card" aria-labelledby="t-rm-bom">
          <div className="card-cab">
            <h2 id="t-rm-bom">O que melhorou</h2>
          </div>
          <ListaDoQueMudou mudancas={r.improved} icone="trend-up" classe="rev-lista--bom" periodo={periodo} primeiroMes={primeiroMes} vazio={`Nada mudou para melhor sobre ${periodo.dicaAntes}.`} />
        </article>
        <article className="card" aria-labelledby="t-rm-ruim">
          <div className="card-cab">
            <h2 id="t-rm-ruim">O que piorou</h2>
          </div>
          <ListaDoQueMudou mudancas={r.worsened} icone="trend-down" classe="rev-lista--ruim" periodo={periodo} primeiroMes={primeiroMes} vazio={`Nada piorou sobre ${periodo.dicaAntes}.`} />
        </article>
      </div>

      {r.budget && <CartaoDaVerba verba={r.budget} mes={mes} periodo={periodo} podeDefinir={pode('orcamento.gerenciar')} />}
      {r.team && <CartaoDaEquipe equipe={r.team} mes={mes} />}

      <article className="card" aria-labelledby="t-rm-dec">
        <div className="card-cab">
          <div>
            <h2 id="t-rm-dec">Para o mês que vem</h2>
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
          <p className="rev-nada">Nada pede decisão para o mês que vem.</p>
        )}
      </article>
      <DicaDosDesenhos />
    </div>
  );
}

function Legenda() {
  return (
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
  );
}

type ListaProps = {
  mudancas: MonthlyReport['improved'];
  icone: 'trend-up' | 'trend-down';
  classe: string;
  periodo: PeriodoDoDesenho;
  primeiroMes: boolean;
  vazio: string;
};

/** "O que melhorou" ou "O que piorou" sobre o mês anterior; no primeiro mês, que não há com o que comparar. */
function ListaDoQueMudou({ mudancas, icone, classe, periodo, primeiroMes, vazio }: ListaProps) {
  if (primeiroMes) return <p className="rev-nada">{SEM_ANTERIOR}</p>;
  if (!mudancas.length) return <p className="rev-nada">{vazio}</p>;
  return (
    <ul className={`rev-lista rev-lista--g ${classe}`}>
      {mudancas.map((m) => (
        <LinhaDaMudanca key={`${m.kind}-${m.campaign?.id ?? ''}`} icone={icone} mudanca={mudancaNoPeriodo(m, periodo)} />
      ))}
    </ul>
  );
}

type VerbaProps = { verba: NonNullable<MonthlyReport['budget']>; mes: string; periodo: PeriodoDoDesenho; podeDefinir: boolean };

/** A verba do mês: o gasto do mês inteiro contra o teto, e o que o Liame mudou nas campanhas (como a Verba do mês mostrava). */
function CartaoDaVerba({ verba: b, mes, periodo, podeDefinir }: VerbaProps) {
  const v = verbaNaTela(b);
  return (
    <article className="card" aria-labelledby="t-rm-verba">
      <div className="card-cab">
        <div>
          <h2 id="t-rm-verba">A verba do mês</h2>
          <p className="card-sub">Tudo o que as contas conectadas gastaram em anúncios no mês, contra o teto que a empresa definiu.</p>
        </div>
      </div>
      <div className="rm-verba">
        <div className="rm-verba-topo">
          <p className="rm-verba-valor">
            {v.gasto} <small>{v.doTeto ?? 'gastos no mês'}</small>
          </p>
          {v.barra && (
            <span className={`st ${v.acima ? 'st--perigo' : 'st--concluido'}`}>
              <span className="dot" aria-hidden="true" />
              {v.acima ? 'Acima do teto' : 'Dentro do teto'}
            </span>
          )}
        </div>
        {v.barra ? (
          <>
            <div className="rm-teto" role="img" aria-label={v.falado ?? undefined}>
              <span className={`rm-teto-b${v.acima ? ' rm-teto-b--acima' : ''}`} style={{ width: `${v.barra.gasto}%` }} data-dica={dica(v.gasto, `gasto de ${periodo.agora}`)} />
              <span className="rm-teto-marca" style={{ left: `${v.barra.teto}%` }} data-dica={dica(v.teto ?? '', 'teto do mês')} />
            </div>
            <p className="rm-teto-leg" aria-hidden="true">
              <span>
                <i className="ch-gasto" />
                gasto do mês
              </span>
              <span>
                <i className="ch-teto" />
                teto do mês
              </span>
            </p>
            <p className="eixo-nota">{v.frase}</p>
          </>
        ) : (
          <p className="rev-nada">Esta empresa não tem teto do mês. Quem define é o Dono ou o Administrador, na Verba do mês; com o teto, o Liame não aprova aumento de verba que passe dele.</p>
        )}
        {v.atrasadas && <p className="eixo-nota">{v.atrasadas}</p>}
        <div className="rm-verba-mud">
          <h3 className="rotulo-marca">O que o Liame mudou nas campanhas em {mes}</h3>
          {b.changes.length ? (
            <ul className="rm-mudancas">
              {b.changes.map((m) => {
                const x = mudancaDoMes(m);
                return (
                  <li key={m.action_id}>
                    <Icone nome={x.icone} />
                    <div>
                      <b>{x.titulo}</b>
                      <span>{x.sub}</span>
                    </div>
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="rev-nada">O Liame não mudou nada nas campanhas em {mes}.</p>
          )}
        </div>
        <div className="rm-acoes">
          <Link className="btn btn--sm" href="/verba">
            {v.barra === null && podeDefinir ? 'Definir o teto do mês' : 'Ver a Verba do mês'}
          </Link>
        </div>
      </div>
    </article>
  );
}

/** O que a equipe fez: os números de Sua equipe no último dia do mês, e o custo de IA do mês. */
function CartaoDaEquipe({ equipe: t, mes }: { equipe: NonNullable<MonthlyReport['team']>; mes: string }) {
  const membros = equipeDoMes(t);
  const custo = custoDoMes(t);
  return (
    <article className="card" aria-labelledby="t-rm-equipe">
      <div className="card-cab">
        <div>
          <h2 id="t-rm-equipe">O que a equipe fez em {mes}</h2>
          <p className="card-sub">Os números de Sua equipe no último dia do mês. Os funcionários de IA só propõem; quem decide é você.</p>
        </div>
      </div>
      {membros.length ? (
        <ul className="rm-equipe">
          {membros.map((m) => (
            <li key={m.chave}>
              <Avatar icone={m.icone} />
              <div>
                <b>{m.nome}</b>
                <small>{m.cargo}</small>
                <p className="rm-feito">
                  {m.feito.map((f, i) => (
                    <span key={f.texto}>
                      {i > 0 && ' · '}
                      <span className="num">{f.valor}</span> {f.texto}
                    </span>
                  ))}
                </p>
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <p className="rev-nada">Nenhum funcionário de IA trabalhou em {mes}.</p>
      )}
      <p className="rm-custo">
        <span>
          <b>Custo de IA no mês:</b> <span className="num">{custo.valor}</span>
          {custo.doTeto && (
            <>
              {' · '}
              <span className="num">{custo.doTeto}</span> do teto do mês
            </>
          )}
        </span>
        <Link className="btn btn--sm" href="/equipe">
          Ver Sua equipe
        </Link>
      </p>
    </article>
  );
}
