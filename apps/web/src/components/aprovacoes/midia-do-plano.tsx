'use client';

import type { PlanContent } from '@liame/contracts';
import type { ReactNode } from 'react';
import { Icone } from '@/components/ui/icone';
import { caminhoDoHorario, horaCurta, linhaDaLoja, NOME_DA_ETAPA, nomesDosDias, notaDosAneis, textoDoAnel } from './planos-textos';

type Midia = NonNullable<Extract<PlanContent, { kind: 'noventa_dias' }>['media_plan']>;

// O plano de mídia por região no plano de 90 dias (plano da região, R5; revisão P45 do P8): as etapas do funil com o
// criativo de cada uma (o Estrategista propõe) e, por loja, os anéis do raio com o dinheiro de cada um e os horários
// (contas do sistema). Nada é executado daqui: a campanha com raio é a R6.

export function MidiaDoPlano({ midia, texto }: { midia: Midia; texto: (path: string, bruto: string) => ReactNode }) {
  const topo = midia.stages.filter((e) => e.stage === 'reconhecimento' || e.stage === 'seguidores').reduce((t, e) => t + e.share, 0);
  return (
    <div className="secao">
      <p className="rotulo-marca">Plano de mídia por região</p>
      <p className="ap-midia-tit">Etapas do funil</p>
      <ul className="dias">
        {midia.stages.map((e, i) => (
          <li key={e.stage}>
            <span className="dia">
              {NOME_DA_ETAPA[e.stage]} · {e.share}%
            </span>
            <span>{texto(`media_plan.stages.${i}.creative`, e.creative)}</span>
          </li>
        ))}
      </ul>
      <p className="nota">
        <Icone nome="shield" />
        <span>
          Reconhecimento e seguidores somam {topo}% (o teto é 25%: o resto vai para pedido e conversa). A renda do bairro não vai ao Estrategista e nunca entra
          no texto do anúncio.
        </span>
      </p>
      {midia.stores.map((s, i) => (
        <div key={s.unit_id} className="ap-midia-loja">
          <p className="ap-midia-tit">{s.store}</p>
          <p className="ap-midia-sub">{linhaDaLoja(s)}</p>
          <p className="ap-midia-tit">Anéis</p>
          <ul className="dias">
            {s.rings.map((r) => {
              const a = textoDoAnel(r);
              return (
                <li key={r.ring}>
                  <span className="dia">{a.nome}</span>
                  <span>
                    <b>{a.parte}</b> · {a.resto}
                  </span>
                </li>
              );
            })}
          </ul>
          <p className="nota">
            <Icone nome="compass" />
            <span>{notaDosAneis(s)}</span>
          </p>
          <p className="ap-midia-tit">Horários</p>
          {s.hours.source === 'loja' ? (
            <ul className="dias">
              <li>
                <span className="dia">Dias fortes</span>
                <span>
                  <b>{nomesDosDias(s.hours.days)}:</b> {texto(caminhoDoHorario(i, 'days_share'), `${s.hours.days_share}%`)} dos pedidos.
                </span>
              </li>
              <li>
                <span className="dia">Horário</span>
                <span>
                  <b>
                    Das {horaCurta(s.hours.from)} às {horaCurta(s.hours.to)}:
                  </b>{' '}
                  {texto(caminhoDoHorario(i, 'hours_share'), `${s.hours.hours_share}%`)} dos pedidos. A verba de pedido começa às {horaCurta(s.hours.ads_from)}, 1 hora antes.
                </span>
              </li>
            </ul>
          ) : (
            <ul className="dias">
              <li>
                <span className="dia">Do setor</span>
                <span>
                  <b>
                    O jantar, de {nomesDosDias(s.hours.days)}, das {horaCurta(s.hours.from)} às {horaCurta(s.hours.to)}.
                  </b>{' '}
                  A verba de pedido começa às {horaCurta(s.hours.ads_from)}. É a referência do setor (iFood, imprensa), não um número da loja.
                </span>
              </li>
            </ul>
          )}
          <p className="nota">
            <Icone nome="clock" />
            <span>
              {s.hours.source === 'loja'
                ? 'Os horários saem dos pedidos da própria loja nas 4 semanas completas até ontem (Sua região › A demanda da loja).'
                : 'A loja ainda não tem 20 pedidos nas 4 semanas pelo Regem: vale a referência do setor até lá.'}
            </span>
          </p>
        </div>
      ))}
      <p className="nota">
        <Icone nome="info" />
        <span>Nada é executado por aqui: a campanha com raio nasce pausada e com a sua aprovação numa próxima entrega.</span>
      </p>
    </div>
  );
}
