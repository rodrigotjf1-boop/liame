'use client';

import type { TrackingCheckResponse, TrackingLink } from '@liame/contracts';
import { useId, useState } from 'react';
import { Faixa } from '@/components/ui/faixa';
import { Icone } from '@/components/ui/icone';
import { dia } from '@/lib/formato';
import { classePlataforma, faixaRastreio, rotuloPlataforma } from './textos';

// A conferência dos anúncios ativos (protótipo P3): quantos estão sem os parâmetros do Liame e, na lista,
// o que fazer em cada um (os textos vêm do servidor). O Liame não mexe nos anúncios: mostra o que colar.

type Props = {
  check: TrackingCheckResponse;
  links: TrackingLink[];
  agora: Date;
  podeCriar: boolean;
  aoVerParametros: (link: TrackingLink) => void;
  aoCriarLink: (inicial: { campanha: string; anuncio: string }) => void;
};

export function FaixaRastreio({ check, links, agora, podeCriar, aoVerParametros, aoCriarLink }: Props) {
  const [aberta, setAberta] = useState(false);
  const id = useId();
  const f = faixaRastreio(check, agora);
  if (!f) return null;

  return (
    <>
      <Faixa
        tipo={f.tipo}
        icone={<Icone nome={f.icone} />}
        titulo={f.titulo}
        texto={f.texto}
        acao={
          f.lista ? (
            <button className="btn btn-alternar" type="button" aria-expanded={aberta} aria-controls={id} onClick={() => setAberta((a) => !a)}>
              {aberta ? 'Ocultar' : f.botao}
            </button>
          ) : undefined
        }
      />
      {f.lista && (
        <ul className="sem-rastreio" id={id} hidden={!aberta} aria-label="Anúncios ativos que precisam de atenção">
          {check.items.map((item) => {
            const sugerido = item.suggested_link_id ? links.find((l) => l.id === item.suggested_link_id) : undefined;
            return (
              <li key={`${item.connected_account_id}:${item.ad.id}`}>
                <span className={classePlataforma(item.provider)}>{rotuloPlataforma(item.provider)}</span>
                <span className="sr-txt">
                  <b>{item.title}</b>
                  <span>
                    Campanha {item.campaign.name} · visto desde {dia(item.first_seen_at, agora)} · {item.detail}
                  </span>
                  <span>{item.action}</span>
                </span>
                {item.status === 'sem_rastreio' &&
                  (sugerido ? (
                    <button className="btn btn--sm" type="button" aria-haspopup="dialog" onClick={() => aoVerParametros(sugerido)}>
                      Ver parâmetros
                    </button>
                  ) : podeCriar ? (
                    <button
                      className="btn btn--sm"
                      type="button"
                      aria-haspopup="dialog"
                      onClick={() => aoCriarLink({ campanha: item.campaign.id, anuncio: item.ad.id })}
                    >
                      Criar link
                    </button>
                  ) : null)}
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}
