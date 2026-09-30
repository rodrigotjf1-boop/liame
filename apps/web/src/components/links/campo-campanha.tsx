'use client';

import type { CouponCampaign } from '@liame/contracts';
import type { Ref } from 'react';
import { gruposDeCampanhas } from './textos';

// Campanha do cupom (ligar e informar): as ativas e pausadas da Meta e do Google Ads, por plataforma.

type Props = {
  id: string;
  valor: string;
  campanhas: CouponCampaign[];
  erro?: string;
  selectRef?: Ref<HTMLSelectElement>;
  aoMudar: (id: string) => void;
};

export function CampoCampanha({ id, valor, campanhas, erro, selectRef, aoMudar }: Props) {
  return (
    <div className="campo">
      <label htmlFor={id}>Campanha</label>
      <select
        ref={selectRef}
        className="input"
        id={id}
        value={valor}
        disabled={!campanhas.length}
        onChange={(e) => aoMudar(e.target.value)}
        aria-invalid={!!erro}
        aria-describedby={erro ? `${id}-erro` : !campanhas.length ? `${id}-dica` : undefined}
      >
        <option value="">Escolha a campanha</option>
        {gruposDeCampanhas(campanhas).map((g) => (
          <optgroup key={g.provider} label={g.titulo}>
            {g.campanhas.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
                {c.status === 'pausada' ? ' · pausada' : ''}
              </option>
            ))}
          </optgroup>
        ))}
      </select>
      {!campanhas.length && (
        <p className="campo-dica" id={`${id}-dica`}>
          Nenhuma campanha ativa ou pausada da Meta ou do Google Ads. Conecte a conta de anúncios em Contas conectadas.
        </p>
      )}
      {erro && (
        <p className="campo-erro" id={`${id}-erro`}>
          {erro}
        </p>
      )}
    </div>
  );
}
