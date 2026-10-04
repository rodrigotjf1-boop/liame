'use client';

import type { ExplanationNumber, PlanContent, PlanMarkedText } from '@liame/contracts';
import type { ReactNode } from 'react';
import { TextoDaExplicacao } from '@/components/explicar/bloco-explicacao';
import { Icone } from '@/components/ui/icone';
import { diaDaPauta, diaDoCalendario, quandoDaOferta, tabelaDaVerba, trechosDo } from './planos-textos';

// O que o plano do Estrategista propõe, pelo tipo (protótipo P8): o plano de 90 dias (objetivos, mês a mês, verba
// por canal e calendário comercial), a pauta da semana (dia a dia) e a oferta (o que, quando, onde, o texto do
// anúncio, o cupom e como medir). Os números dos textos são botões que levam à fonte, como no Explicar.

export function CorpoDoPlano({ content, marked, numbers, aoTocar }: { content: PlanContent; marked: PlanMarkedText[]; numbers: ExplanationNumber[]; aoTocar: (n: number) => void }) {
  const texto = (path: string, bruto: string): ReactNode => <TextoDaExplicacao trechos={trechosDo(marked, path, bruto)} numeros={numbers} aoTocar={aoTocar} />;

  if (content.kind === 'pauta') {
    return (
      <div className="secao">
        <p className="rotulo-marca">Dia a dia</p>
        <ul className="dias">
          {content.days.map((d, i) => (
            <li key={d.day}>
              <span className="dia">{diaDaPauta(d.day)}</span>
              <span>{texto(`days.${i}.item`, d.item)}</span>
            </li>
          ))}
        </ul>
      </div>
    );
  }

  if (content.kind === 'oferta') {
    const linhas: Array<[string, ReactNode]> = [
      ['Oferta', texto('offer', content.offer)],
      ['Quando', quandoDaOferta(content)],
      ['Onde', texto('where', content.where)],
      ['Texto do anúncio', <>“{texto('ad_text', content.ad_text)}”</>],
      ['Cupom', content.coupon_code ? `${content.coupon_code}, que já existe. Nenhum cupom novo.` : 'Sem cupom.'],
      ['Verba', 'Nenhuma verba nova.'],
      ['Como medir', texto('how_to_measure', content.how_to_measure)],
    ];
    return (
      <div className="secao">
        <p className="rotulo-marca">O plano</p>
        <div className="table-wrap">
          <table className="tabela plano-tabela">
            <caption className="sr-only">O que o plano propõe</caption>
            <tbody>
              {linhas.map(([rotulo, valor]) => (
                <tr key={rotulo}>
                  <th scope="row">{rotulo}</th>
                  <td>{valor}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    );
  }

  const verba = tabelaDaVerba(content.budget);
  return (
    <>
      <div className="secao">
        <p className="rotulo-marca">O que o plano quer, e como saber se deu certo</p>
        <ol className="afazer">
          {content.goals.map((g, i) => (
            <li key={i}>
              <span className="num" aria-hidden="true">
                {i + 1}
              </span>
              <span>
                <b>{texto(`goals.${i}.goal`, g.goal)}</b> Como saber: {texto(`goals.${i}.how_to_know`, g.how_to_know)}
              </span>
            </li>
          ))}
        </ol>
      </div>
      <div className="secao">
        <p className="rotulo-marca">Mês a mês</p>
        <ul className="dias">
          {content.months.map((m, i) => (
            <li key={i}>
              <span className="dia">{m.month}</span>
              <span>{texto(`months.${i}.plan`, m.plan)}</span>
            </li>
          ))}
        </ul>
      </div>
      <div className="secao">
        <p className="rotulo-marca">Verba por canal, por mês</p>
        <div className="table-wrap">
          <table className="tabela">
            <caption className="sr-only">Verba por canal, por mês: hoje e a proposta</caption>
            <thead>
              <tr>
                <th scope="col">Canal</th>
                <th scope="col" className="n">
                  Hoje
                </th>
                <th scope="col" className="n">
                  Proposta
                </th>
              </tr>
            </thead>
            <tbody>
              {verba.linhas.map((l) => (
                <tr key={l.canal}>
                  <th scope="row">{l.canal}</th>
                  <td className="n num ap-antes">{texto(l.caminho, l.hoje)}</td>
                  <td className="n num ap-depois">{l.proposta}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <th scope="row">Total</th>
                <td className="n num">{verba.total.hoje}</td>
                <td className="n num">{verba.total.proposta}</td>
              </tr>
            </tfoot>
          </table>
        </div>
        <p className="nota">
          <Icone nome="info" />
          <span>Hoje: o gasto dos últimos 7 dias completos levado para 30 dias. Mudar a verba é com quem cuida das campanhas: nada muda por aqui.</span>
        </p>
      </div>
      {content.dates.length > 0 && (
        <div className="secao">
          <p className="rotulo-marca">Calendário comercial</p>
          <ul className="dias">
            {content.dates.map((d, i) => (
              <li key={`${d.day}-${i}`}>
                <span className="dia">{diaDoCalendario(d.day)}</span>
                <span>
                  <b>{d.name}.</b> {texto(`dates.${i}.what`, d.what)}
                </span>
              </li>
            ))}
          </ul>
          <p className="nota">
            <Icone nome="calendar" />
            <span>As datas vêm da tabela de feriados e datas do varejo do Liame, não da memória da IA.</span>
          </p>
        </div>
      )}
    </>
  );
}
