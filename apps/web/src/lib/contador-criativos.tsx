'use client';

import { usePathname } from 'next/navigation';
import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { api, chamar } from './api';
import { disparar } from './disparar';
import { useSessao } from './sessao';

// Número de peças do Criativo que a pessoa pode aprovar agora, ao lado de "Criativos" no menu (A4 · P10): as que
// passaram na conferência, na empresa inteira. A barrada e a que o Criativo está refazendo não contam. É a fila de quem
// decide as peças (quem opera campanhas). Busca ao entrar, a cada troca de tela e de tempos em tempos; a tela de
// Criativos pede uma leitura nova quando a lista dela muda.

type Contador = { total: number | null; recarregar: () => void };

const ContadorContexto = createContext<Contador>({ total: null, recarregar: () => {} });
/** Uma peça pode ficar pronta com a pessoa em outra tela. */
const ATUALIZAR_MS = 120_000;

export function useContadorCriativos(): Contador {
  return useContext(ContadorContexto);
}

export function ContadorCriativosProvider({ children }: { children: ReactNode }) {
  const { pode, empresa } = useSessao();
  const caminho = usePathname();
  const [total, setTotal] = useState<number | null>(null);
  const conta = Boolean(empresa) && pode('campanhas.ver') && pode('campanhas.operar');

  const buscar = useCallback(async () => {
    if (!conta) return setTotal(null);
    const r = await chamar(() => api.GET('/v1/ad-pieces/waiting'));
    // Sem resposta, o menu só fica sem atualizar o número: a tela de Criativos mostra o erro com nova tentativa.
    if (r.ok) setTotal(r.data.ready);
  }, [conta]);

  // O shell fica montado na navegação: a troca de tela também lê de novo (e recomeça a contagem do intervalo).
  useEffect(() => {
    disparar(buscar());
    if (!conta) return;
    const t = setInterval(() => disparar(buscar()), ATUALIZAR_MS);
    return () => clearInterval(t);
  }, [buscar, conta, caminho]);

  const recarregar = useCallback(() => disparar(buscar()), [buscar]);
  const valor = useMemo<Contador>(() => ({ total, recarregar }), [total, recarregar]);
  return <ContadorContexto.Provider value={valor}>{children}</ContadorContexto.Provider>;
}
