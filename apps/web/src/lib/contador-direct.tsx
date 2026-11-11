'use client';

import { usePathname } from 'next/navigation';
import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { api, chamar } from './api';
import { disparar } from './disparar';
import { useSessao } from './sessao';

// Quantas conversas do Direct esperam resposta, ao lado de "Direct" no menu (A6 · Z12; P39): a mesma regra de "Esperam
// resposta" na tela, somadas as marcas da empresa em que o Liame mostra o Direct. Busca ao entrar, a cada troca de tela
// e de minuto em minuto (o Liame lê o Direct a cada minuto); a tela Direct pede uma leitura nova quando a lista dela muda.

/** `messenger`: alguma marca com o Messenger lido (A6, Z14): o menu diz "Direct e Messenger" (D-A6-120). */
type Contador = { total: number | null; messenger: boolean; recarregar: () => void };

const ContadorContexto = createContext<Contador>({ total: null, messenger: false, recarregar: () => {} });
/** Uma mensagem nova pode chegar com a pessoa em outra tela. */
const ATUALIZAR_MS = 60_000;

export function useContadorDirect(): Contador {
  return useContext(ContadorContexto);
}

export function ContadorDirectProvider({ children }: { children: ReactNode }) {
  const { pode, empresa } = useSessao();
  const caminho = usePathname();
  const [total, setTotal] = useState<number | null>(null);
  const [messenger, setMessenger] = useState(false);
  const conta = Boolean(empresa) && pode('campanhas.ver');

  const buscar = useCallback(async () => {
    if (!conta) return setTotal(null);
    const r = await chamar(() => api.GET('/v1/direct/waiting'));
    // Sem resposta, o menu só fica sem atualizar o número: a tela Direct mostra o erro com nova tentativa.
    if (!r.ok) return;
    setTotal(r.data.waiting);
    setMessenger(r.data.messenger);
  }, [conta]);

  // O shell fica montado na navegação: a troca de tela também lê de novo (e recomeça a contagem do intervalo).
  useEffect(() => {
    disparar(buscar());
    if (!conta) return;
    const t = setInterval(() => disparar(buscar()), ATUALIZAR_MS);
    return () => clearInterval(t);
  }, [buscar, conta, caminho]);

  const recarregar = useCallback(() => disparar(buscar()), [buscar]);
  const valor = useMemo<Contador>(() => ({ total, messenger, recarregar }), [total, messenger, recarregar]);
  return <ContadorContexto.Provider value={valor}>{children}</ContadorContexto.Provider>;
}
