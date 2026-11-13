'use client';

import type { NewCampaignAudienceResponse } from '@liame/contracts';
import type { RefObject } from 'react';
import { Icone } from '@/components/ui/icone';
import { linhaDaEstimativa } from './campanha-nova-textos';

/** O que a gaveta sabe da estimativa agora: lendo, a resposta da rota ou a falha da leitura. */
export type EstimativaNaGaveta = NewCampaignAudienceResponse | 'lendo' | 'falhou';

type Props = { id: string; estimativa: EstimativaNaGaveta; km: number; loja: string; bairros?: number | null; aviso: RefObject<HTMLDivElement | null> };

/**
 * A estimativa de público no raio, debaixo de "Quem vê" (R6, parte 2; D-RG-50; protótipo P42, revisão R6). Com menos de
 * 1.000 pessoas, o aviso impede o pedido e recebe o foco quando a pessoa tenta pedir.
 */
export function EstimativaDoRaio({ id, estimativa, km, loja, bairros = null, aviso }: Props) {
  if (estimativa === 'lendo') {
    return (
      <p className="campo-dica cn-estimativa" id={id} role="status">
        {bairros === null ? 'Lendo a estimativa da Meta para este raio…' : 'Lendo a estimativa da Meta para os bairros marcados…'}
      </p>
    );
  }
  const l = linhaDaEstimativa(estimativa, km, loja, bairros);
  if (l.tom === 'pequeno') {
    return (
      <div className="pd-aviso pd-aviso--perigo cn-bloqueio cn-estimativa-aviso" id={id} role="alert" ref={aviso} tabIndex={-1}>
        <Icone nome="alert-circle" />
        <div>
          <b>{l.titulo}</b>
          <span>{l.texto}</span>
        </div>
      </div>
    );
  }
  return (
    <p className="campo-dica cn-estimativa" id={id} role="status">
      {l.tom === 'ok' && <Icone nome="user-plus" pequeno />}
      <span>
        {l.destaque && <b>{l.destaque}</b>}
        {l.texto}
      </span>
    </p>
  );
}
