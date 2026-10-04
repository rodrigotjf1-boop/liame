'use client';

import { usePathname } from 'next/navigation';
import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { buscarAvisos } from '@/components/atencao/buscar-avisos';
import { contadorDoMenu } from '@/components/atencao/textos';
import { disparar } from './disparar';
import { useSessao } from './sessao';

// Número de avisos (crítico + atenção; de mídia e, para quem vê as vendas, do ciclo fechado) ao lado de "Atenção" no menu. Busca ao entrar e a cada
// troca de tela; a tela de Atenção atualiza com o que acabou de ler, e as ações em Contas pedem uma nova leitura.

type Contador = { total: number | null; definir: (n: number) => void; recarregar: () => void };

const ContadorContexto = createContext<Contador>({ total: null, definir: () => {}, recarregar: () => {} });

export function useContadorAtencao(): Contador {
  return useContext(ContadorContexto);
}

export function ContadorAtencaoProvider({ children }: { children: ReactNode }) {
  const { pode, empresa } = useSessao();
  const caminho = usePathname();
  const [total, setTotal] = useState<number | null>(null);
  const podeVer = Boolean(empresa) && pode('campanhas.ver');
  const podeVerVendas = pode('vendas.ver');

  const buscar = useCallback(async () => {
    if (!podeVer) return setTotal(null);
    const r = await buscarAvisos(podeVerVendas);
    // Sem resposta, o menu só fica sem o número: a tela de Atenção mostra o erro com nova tentativa.
    if (r.ok) setTotal(contadorDoMenu(r.data.items));
  }, [podeVer, podeVerVendas]);

  // O shell fica montado na navegação: a troca de tela é a hora de ler de novo (um aviso pode ter chegado).
  useEffect(() => {
    disparar(buscar());
  }, [buscar, caminho]);

  const valor = useMemo<Contador>(() => ({ total, definir: setTotal, recarregar: () => disparar(buscar()) }), [total, buscar]);
  return <ContadorContexto.Provider value={valor}>{children}</ContadorContexto.Provider>;
}
