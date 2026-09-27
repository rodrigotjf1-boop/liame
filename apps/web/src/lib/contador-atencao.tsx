'use client';

import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { contadorDoMenu } from '@/components/atencao/textos';
import { api, chamar } from './api';
import { disparar } from './disparar';
import { useSessao } from './sessao';

// Número de avisos de mídia (crítico + atenção) ao lado de "Atenção" no menu. Busca uma vez por empresa;
// a tela de Atenção atualiza com o que acabou de ler, e as ações em Contas pedem uma nova leitura.

type Contador = { total: number | null; definir: (n: number) => void; recarregar: () => void };

const ContadorContexto = createContext<Contador>({ total: null, definir: () => {}, recarregar: () => {} });

export function useContadorAtencao(): Contador {
  return useContext(ContadorContexto);
}

export function ContadorAtencaoProvider({ children }: { children: ReactNode }) {
  const { pode, empresa } = useSessao();
  const [total, setTotal] = useState<number | null>(null);
  const podeVer = Boolean(empresa) && pode('campanhas.ver');

  const buscar = useCallback(async () => {
    if (!podeVer) return setTotal(null);
    const r = await chamar(() => api.GET('/v1/media/attention'));
    // Sem resposta, o menu só fica sem o número: a tela de Atenção mostra o erro com nova tentativa.
    if (r.ok) setTotal(contadorDoMenu(r.data.items));
  }, [podeVer]);

  useEffect(() => {
    disparar(buscar());
  }, [buscar]);

  const valor = useMemo<Contador>(() => ({ total, definir: setTotal, recarregar: () => disparar(buscar()) }), [total, buscar]);
  return <ContadorContexto.Provider value={valor}>{children}</ContadorContexto.Provider>;
}
