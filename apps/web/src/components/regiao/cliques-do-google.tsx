'use client';

import type { RegionOverviewResponse } from '@liame/contracts';
import { useState } from 'react';
import { Icone } from '@/components/ui/icone';
import { PAPEL } from './bairros-dos-pedidos';
import { inteiro } from './textos-da-regiao';

// De onde vêm os cliques do Google, por município ou por bairro (plano da região, R4, os bairros; P40, revisão aprovada
// pelo dono em 13/11/2026, D-RG-44 a D-RG-47). O município é o padrão; a escolha vale na tela aberta, sem guardar.

type Midia = NonNullable<RegionOverviewResponse['paid_media']>;

const cliques = (n: number) => `${inteiro(n)} ${n === 1 ? 'clique' : 'cliques'}`;

export function CliquesDoGoogle({ m, mostraPro }: { m: Midia; mostraPro: boolean }) {
  const [por, setPor] = useState<'municipio' | 'bairro'>('municipio');
  const d = m.districts;
  const podeBairro = m.cities_status === 'disponivel' && d !== null;
  return (
    <div>
      <div className="rg-cliques-cab">
        <h4>De onde vêm os cliques (Google)</h4>
        {podeBairro && (
          <div className="seg" role="group" aria-label="Ver os cliques por">
            <button type="button" aria-pressed={por === 'municipio'} onClick={() => setPor('municipio')}>
              Município
            </button>
            <button type="button" aria-pressed={por === 'bairro'} onClick={() => setPor('bairro')}>
              Bairro
            </button>
          </div>
        )}
      </div>
      {m.cities_status === 'lendo' ? (
        <p className="lite-frase">Lendo as cidades do Google: aparecem depois da primeira leitura da conta.</p>
      ) : por === 'bairro' && d ? (
        <PorBairro d={d} fora={m.outside_area} />
      ) : m.cities.length === 0 ? (
        <p className="lite-frase">O Google ainda não informou a cidade dos cliques destas 4 semanas.</p>
      ) : (
        <>
          <ul className="rg-cidades">
            {m.cities.map((c) => (
              <li key={c.id}>
                <span>
                  <b>{c.name}</b>
                  {mostraPro && <small>{c.full_name}</small>}
                </span>
                <span>
                  <b className="num">{inteiro(c.clicks)}</b> {c.clicks === 1 ? 'clique' : 'cliques'}, {c.clicks_pct}% dos cliques do Google
                </span>
              </li>
            ))}
          </ul>
          <p className="rg-nota">
            <Icone nome="info" pequeno />
            <span>A cidade é a de onde a pessoa estava quando viu o anúncio, pelo Google. A Meta só informa o estado nos resultados, e o Liame não usa o estado.</span>
          </p>
        </>
      )}
    </div>
  );
}

export function PorBairro({ d, fora }: { d: NonNullable<Midia['districts']>; fora: Midia['outside_area'] }) {
  const parte = d.city_clicks > 0 ? Math.round((d.located * 100) / d.city_clicks) : 0;
  const atacar = d.items.find((i) => i.kind === 'bairro' && i.role === 'atacar');
  const primeiroDeFora = d.items.find((i) => i.kind === 'bairro' && i.in_delivery_area === false);
  return (
    <>
      <p className="lite-frase">
        {d.located === 0
          ? `O Google ainda não localizou o bairro dos cliques no ${d.city}: ele só sabe a cidade.`
          : d.few
            ? `O Google localizou o bairro de só ${cliques(d.located)} dos ${inteiro(d.city_clicks)} no ${d.city}: é pouco para tirar conclusão. Nos outros, ele só sabe a cidade.`
            : `O Google localizou o bairro de ${inteiro(d.located)} dos ${cliques(d.city_clicks)} no ${d.city} (${parte}%). Nos outros, ele só sabe a cidade.`}
      </p>
      {d.items.length > 0 && (
        <ul className="rg-cidades">
          {d.items.map((i) => {
            const papel = i.role ? PAPEL[i.role] : null;
            return (
              <li key={`${i.kind}-${i.name}`}>
                <span>
                  <b>{i.name}</b>
                  {i.kind === 'cep' ? (
                    <small>o Google deu só o CEP</small>
                  ) : i.in_delivery_area === true ? (
                    <small>na área de entrega</small>
                  ) : i.in_delivery_area === false ? (
                    <small>fora da área de entrega</small>
                  ) : null}
                </span>
                <span>
                  {papel && <span className={papel.classe}>{papel.rotulo}</span>} <b className="num">{inteiro(i.clicks)}</b> {i.clicks === 1 ? 'clique' : 'cliques'}
                </span>
              </li>
            );
          })}
        </ul>
      )}
      {fora && !fora.has_area && (
        <p className="rg-nota">
          <Icone nome="info" pequeno />
          <span>Sem a área de entrega cadastrada na loja, o Liame não diz se o bairro está dentro ou fora dela.</span>
        </p>
      )}
      <p className="rg-nota">
        <Icone nome="info" pequeno />
        <span>O bairro é o lugar mais específico que o Google informa de quem viu o anúncio: o bairro, o distrito ou só o CEP. A Meta não informa bairro. O papel (atacar, defender, manter) é o de "Bairros para atacar e para defender".</span>
      </p>
      {!d.few && primeiroDeFora && (
        <p className="rg-pico">
          <Icone nome="map-pin" pequeno />
          <span>
            <b>
              {primeiroDeFora.name}, fora da área de entrega, recebeu {cliques(primeiroDeFora.clicks)}
              {atacar ? `; ${atacar.name}, um bairro para atacar, ${inteiro(atacar.clicks)}` : ''}.
            </b>{' '}
            O clique de fora da área é verba que não vira pedido: o plano de mídia mira o raio da loja.
          </span>
        </p>
      )}
    </>
  );
}
