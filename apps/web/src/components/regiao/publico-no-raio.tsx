'use client';

import type { NewCampaignAudienceResponse, StoreLocation } from '@liame/contracts';
import { useEffect, useRef, useState } from 'react';
import { api, chamar } from '@/lib/api';
import { disparar } from '@/lib/disparar';
import { useSessao } from '@/lib/sessao';
import { Numero } from './numero';
import { publicoNoRaio, raioDaEstimativa } from './textos-da-regiao';

// "Pessoas no raio, na Meta" em Sua região (plano da região, R6; D-RG-50): a estimativa de público que a gaveta da
// campanha nova já lê, agora ao lado dos números do Censo. Uma leitura por abertura da tela, só para quem vê as
// campanhas; a resposta vale para a loja e o raio de que veio (V64). Sem número, o cartão diz por quê.

export function PublicoNoRaio({ brandId, loja, mostraPro }: { brandId: string; loja: StoreLocation; mostraPro: boolean }) {
  const { pode } = useSessao();
  const ve = pode('campanhas.ver');
  const km = raioDaEstimativa(loja.delivery_radius_km);
  const chave = `${brandId}:${loja.unit_id}:${km}`;
  const [lido, setLido] = useState<{ de: string; e: NewCampaignAudienceResponse | 'falhou' } | null>(null);
  const seq = useRef(0);

  useEffect(() => {
    if (!ve) return;
    const id = ++seq.current;
    disparar(
      (async () => {
        const r = await chamar(() => api.GET('/v1/new-campaigns/audience-estimate', { params: { query: { brand_id: brandId, unit_id: loja.unit_id, radius_km: km } } }));
        if (id === seq.current) setLido({ de: `${brandId}:${loja.unit_id}:${km}`, e: r.ok ? r.data : 'falhou' });
      })(),
    );
  }, [ve, brandId, loja.unit_id, km]);

  if (!ve || !lido || lido.de !== chave) return null;
  const t = publicoNoRaio(lido.e, km);
  return <Numero {...(t.falta ? { classe: 'rg-num--falta' } : {})} valor={t.valor} obs={t.obs} fonte={t.fonte} {...(t.pro ? { pro: t.pro } : {})} mostraPro={mostraPro} />;
}
