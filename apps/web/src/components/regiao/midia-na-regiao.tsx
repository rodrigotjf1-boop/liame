import type { RegionOverviewResponse } from '@liame/contracts';
import Link from 'next/link';
import type { CSSProperties } from 'react';
import { Icone } from '@/components/ui/icone';
import { Numero } from './numero';
import { diaEMes, faixaDeHoras, inteiro, noBloco, plataformasDaMidia } from './textos-da-regiao';

// A mídia na região (plano da região, R4; P40, revisão R4 aprovada pela autorização da noite de 12/11/2026, D-RG-32 a
// D-RG-35): os cliques dos anúncios da marca por hora (Meta e Google) e, do Google, por cidade, nas 4 semanas completas
// até ontem. Sem dinheiro (o gasto fica em Resultados). Os números chegam só para quem vê Resultados (o servidor decide).

export function MidiaNaRegiao({ r, ids, mostraPro }: { r: RegionOverviewResponse; ids: string; mostraPro: boolean }) {
  if (r.paid_media_status === 'sem_endereco') return null;
  const m = r.paid_media;
  const titulo = `${ids}-midia`;
  const cab = (sub: string) => (
    <div className="rg-grupo-cab">
      <h3 id={titulo}>A mídia na região</h3>
      <p>{sub}</p>
    </div>
  );

  if (r.paid_media_status === 'sem_permissao') {
    return (
      <section className="rg-grupo" aria-labelledby={titulo}>
        {cab('os anúncios da marca')}
        <p className="rg-nota">
          <Icone nome="lock" pequeno />
          <span>Os números das campanhas ficam para quem vê Resultados. Peça ao dono a permissão, se precisar deles.</span>
        </p>
      </section>
    );
  }
  if (r.paid_media_status === 'sem_conta' || !m) {
    return (
      <section className="rg-grupo" aria-labelledby={titulo}>
        {cab('os anúncios da marca')}
        <p className="lite-frase">
          Com a conta de anúncios da Meta ou do Google conectada, esta parte mostra a hora em que os anúncios rendem cliques e, do Google, de que cidades vêm os cliques.
        </p>
        <p>
          <Link className="btn btn--sm" href="/contas">
            Conectar a conta de anúncios
          </Link>
        </p>
      </section>
    );
  }

  const plataformas = plataformasDaMidia(m.accounts);
  const sub = `os anúncios da marca (${plataformas}), 4 semanas até ontem (${diaEMes(m.to)})`;
  const lendo = m.accounts.every((a) => a.read_at === null);
  if (lendo || m.clicks === 0) {
    return (
      <section className="rg-grupo" aria-labelledby={titulo}>
        {cab(sub)}
        <p className="lite-frase">
          {lendo
            ? 'Lendo os anúncios: a primeira leitura das contas sai em alguns minutos, e depois uma vez por dia.'
            : `Nenhum clique nos anúncios da ${plataformas} de ${diaEMes(m.from)} a ${diaEMes(m.to)}.`}
        </p>
      </section>
    );
  }

  const max = Math.max(1, ...m.by_hour.map((h) => h.clicks));
  const com = m.by_hour.filter((h) => h.clicks > 0);
  const de = Math.min(...com.map((h) => h.hour));
  const ate = Math.max(...com.map((h) => h.hour));
  const horas = m.by_hour.filter((h) => h.hour >= de && h.hour <= ate);
  const rotuloEmTodas = horas.length <= 13;
  const b = m.ad_block;
  const descricao = `Cliques por hora nas 4 semanas: ${horas.map((h) => `${h.hour}h, ${h.clicks}`).join('; ')}.${b ? ` O bloco mais forte é ${faixaDeHoras(b.from_hour, b.to_hour)}.` : ''}`;
  const temGoogle = m.cities_status !== 'sem_google';

  return (
    <section className="rg-grupo" aria-labelledby={titulo}>
      {cab(sub)}
      <div className="rg-nums">
        <Numero
          valor={
            <>
              {inteiro(m.clicks)} <small>{m.clicks === 1 ? 'clique' : 'cliques'}</small>
            </>
          }
          obs={`de ${diaEMes(m.from)} a ${diaEMes(m.to)}, nos anúncios da ${plataformas}; ${inteiro(m.impressions)} impressões`}
          fonte={`${plataformas} · cliques por hora, no fuso das contas`}
          pro="ad_hour_daily · Meta: hourly_stats_aggregated_by_advertiser_time_zone · Google: segments.hour em customer"
          mostraPro={mostraPro}
        />
        {b && (
          <Numero
            valor={`${b.clicks_pct}%`}
            obs={`dos cliques caem ${faixaDeHoras(b.from_hour, b.to_hour)}, o bloco mais forte dos anúncios`}
            fonte="Conta do sistema com os cliques por hora"
            pro="a janela de até 4 horas seguidas com mais cliques"
            mostraPro={mostraPro}
          />
        )}
        {m.orders_block && (
          <Numero
            valor={`${m.orders_block.clicks_pct}%`}
            obs={`dos cliques caem ${faixaDeHoras(m.orders_block.from_hour, m.orders_block.to_hour)}, o bloco mais forte dos pedidos da loja`}
            fonte="Conta do sistema: os cliques por hora e os pedidos do Regem (A demanda da loja)"
            pro="o bloco mais forte dos pedidos (R3) × os cliques das mesmas horas"
            mostraPro={mostraPro}
          />
        )}
      </div>
      <div className="rg-duas">
        <div>
          <h4>Cliques por hora</h4>
          <ul className="rg-horas" role="img" aria-label={descricao} style={{ '--n': String(Math.max(1, horas.length)) } as CSSProperties}>
            {horas.map((h) => (
              <li className={`rg-hora${b && noBloco(h.hour, b.from_hour, b.to_hour) ? ' rg-hora--foco' : ''}`} key={h.hour}>
                <span className="rg-hora-trilho" aria-hidden="true">
                  <i style={{ '--v': `${(h.clicks / max) * 100}%` } as CSSProperties} />
                </span>
                <span className="num">{rotuloEmTodas || h.hour % 2 === 0 ? `${h.hour}h` : ''}</span>
              </li>
            ))}
          </ul>
        </div>
        <div>
          <h4>De onde vêm os cliques{temGoogle ? ' (Google)' : ''}</h4>
          {!temGoogle ? (
            <p className="lite-frase">A cidade dos cliques vem só do Google Ads: a Meta só informa o estado nos resultados de anúncio. Com o Google conectado, as cidades aparecem aqui.</p>
          ) : m.cities_status === 'lendo' ? (
            <p className="lite-frase">Lendo as cidades do Google: aparecem depois da primeira leitura da conta.</p>
          ) : m.cities.length === 0 ? (
            <p className="lite-frase">O Google ainda não informou a cidade dos cliques destas 4 semanas.</p>
          ) : (
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
          )}
        </div>
      </div>
      {temGoogle && m.cities.length > 0 && (
        <p className="rg-nota">
          <Icone nome="info" pequeno />
          <span>A cidade é a de onde a pessoa estava quando viu o anúncio, pelo Google. A Meta só informa o estado nos resultados, e o Liame não usa o estado.</span>
        </p>
      )}
      {m.orders_block && b && (
        <p className="rg-pico">
          <Icone nome="clock" pequeno />
          <span>
            <b>
              Os cliques se concentram {faixaDeHoras(b.from_hour, b.to_hour)}; os pedidos, {faixaDeHoras(m.orders_block.from_hour, m.orders_block.to_hour)}.
            </b>{' '}
            O plano de mídia põe a verba de pedido 1 hora antes do bloco dos pedidos.
          </span>
        </p>
      )}
    </section>
  );
}
