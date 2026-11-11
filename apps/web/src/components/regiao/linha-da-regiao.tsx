'use client';

import type { StoreLocationsResponse } from '@liame/contracts';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Icone } from '@/components/ui/icone';
import { api, chamar } from '@/lib/api';
import { disparar } from '@/lib/disparar';
import { linhaDeMinhaMarca } from './textos';

// A parte Região de Minha marca ganha a linha das lojas no mapa e o botão que abre a página Região (P40, D-RG-11). Só
// com a função `regiao` liberada; sem ela (ou sem resposta), a parte fica como sempre foi.

export function LinhaDaRegiao({ brandId }: { brandId: string }) {
  const [dados, setDados] = useState<{ marca: string; r: StoreLocationsResponse } | null>(null);

  useEffect(() => {
    let vale = true;
    disparar(
      chamar(() => api.GET('/v1/region/stores', { params: { query: { brand_id: brandId } } })).then((r) => {
        if (vale && r.ok) setDados({ marca: brandId, r: r.data });
      }),
    );
    return () => {
      vale = false;
    };
  }, [brandId]);

  if (!dados || dados.marca !== brandId) return null;
  return <LinhaDaRegiaoVista dados={dados.r} brandId={brandId} />;
}

/** A linha já com os dados (também para os testes). */
export function LinhaDaRegiaoVista({ dados, brandId }: { dados: StoreLocationsResponse; brandId: string }) {
  const linha = linhaDeMinhaMarca(dados);
  if (!linha) return null;
  return (
    <>
      <p className="rg-mk-linha">
        <Icone nome="map-pin" pequeno />
        <span>{linha}</span>
      </p>
      <Link className="btn btn--sm" href={`/marca/regiao?marca=${brandId}`}>
        <Icone nome="map-pin" pequeno />
        Abrir a região
      </Link>
    </>
  );
}
