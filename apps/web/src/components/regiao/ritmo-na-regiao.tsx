'use client';

import type { RegionRhythmResponse } from '@liame/contracts';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { linhasDoRitmoNaRegiao } from '@/components/aprovacoes/ritmo-textos';
import { Icone } from '@/components/ui/icone';
import { api, chamar } from '@/lib/api';
import { disparar } from '@/lib/disparar';
import { useSessao } from '@/lib/sessao';

// A linha do ritmo em Sua região › A semana que vem (plano da região, R7; D-RG-65): o ritmo que roda nesta semana e o
// que o Gestor de tráfego pediu para a que vem, com o caminho para Aprovações (é lá que se aprova, se acompanha e se
// para). A leitura é a da prévia (`GET /v1/region/rhythm`), só do banco. Sem ritmo nenhum (ou com a função desligada),
// nada aparece. A leitura que falha também não mostra nada: a linha é só um caminho, e o pedido e o ritmo continuam em
// Aprovações. Quem não vê as campanhas não lê.

type Refs = Pick<RegionRhythmResponse, 'running' | 'proposed'>;

export function RitmoNaRegiao({ brandId, unitId }: { brandId: string; unitId: string }) {
  const { pode } = useSessao();
  const ve = pode('campanhas.ver');
  const chave = `${brandId}:${unitId}`;
  const [lido, setLido] = useState<{ de: string; refs: Refs } | null>(null);
  const seq = useRef(0);

  // A resposta vale só para a loja de que veio (V64).
  useEffect(() => {
    if (!ve) return;
    const id = ++seq.current;
    disparar(
      (async () => {
        const r = await chamar(() => api.GET('/v1/region/rhythm', { params: { query: { brand_id: brandId, unit_id: unitId } } }));
        if (id === seq.current && r.ok) setLido({ de: `${brandId}:${unitId}`, refs: { running: r.data.running, proposed: r.data.proposed } });
      })(),
    );
  }, [ve, brandId, unitId]);

  if (!ve || !lido || lido.de !== chave) return null;
  const linhas = linhasDoRitmoNaRegiao(lido.refs);
  if (!linhas.length) return null;
  return (
    <ul className="rg-ritmo" aria-label="O ritmo da semana">
      {linhas.map((l) => (
        <li key={l.chave}>
          <Icone nome={l.icone} />
          <span>
            <b>{l.titulo}.</b> {l.texto}{' '}
            {l.href && (
              <Link className="link-bt" href={l.href}>
                Ver em Aprovações
              </Link>
            )}
          </span>
        </li>
      ))}
    </ul>
  );
}
