'use client';

import { usePathname } from 'next/navigation';
import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { api, chamar } from './api';
import { disparar } from './disparar';
import { useSessao } from './sessao';

// Quantos comentários pedem resposta, ao lado de "Comentários" no menu (A6 · Z11, parte 3c; P38): a mesma regra de
// "Pedem resposta" na tela, somadas as marcas da empresa com a função ligada. Busca ao entrar, a cada troca de tela e
// de tempos em tempos (a leitura dos comentários é de 15 em 15 minutos); a tela Comentários pede uma leitura nova
// quando a lista dela muda.

type Contador = { total: number | null; recarregar: () => void };

const ContadorContexto = createContext<Contador>({ total: null, recarregar: () => {} });
/** Um comentário novo pode chegar com a pessoa em outra tela. */
const ATUALIZAR_MS = 120_000;

export function useContadorComentarios(): Contador {
  return useContext(ContadorContexto);
}

export function ContadorComentariosProvider({ children }: { children: ReactNode }) {
  const { pode, empresa } = useSessao();
  const caminho = usePathname();
  const [total, setTotal] = useState<number | null>(null);
  const conta = Boolean(empresa) && pode('campanhas.ver');

  const buscar = useCallback(async () => {
    if (!conta) return setTotal(null);
    const r = await chamar(() => api.GET('/v1/comments/waiting'));
    // Sem resposta, o menu só fica sem atualizar o número: a tela Comentários mostra o erro com nova tentativa.
    if (r.ok) setTotal(r.data.asking);
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
