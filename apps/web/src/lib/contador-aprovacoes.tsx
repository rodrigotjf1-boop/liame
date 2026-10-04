'use client';

import { usePathname } from 'next/navigation';
import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { api, chamar } from './api';
import { disparar } from './disparar';
import { useSessao } from './sessao';

// Número de pedidos esperando aprovação, ao lado de "Aprovações" no menu. Só para quem pode aprovar (é a fila
// de quem decide). Busca ao entrar, a cada troca de tela e de tempos em tempos; a tela de Aprovações atualiza com
// o que acabou de ler.

type Contador = { total: number | null; definir: (n: number) => void; recarregar: () => void };

const ContadorContexto = createContext<Contador>({ total: null, definir: () => {}, recarregar: () => {} });
/** Um pedido novo pode chegar com a pessoa em outra tela. */
const ATUALIZAR_MS = 120_000;

export function useContadorAprovacoes(): Contador {
  return useContext(ContadorContexto);
}

export function ContadorAprovacoesProvider({ children }: { children: ReactNode }) {
  const { pode, empresa } = useSessao();
  const caminho = usePathname();
  const [total, setTotal] = useState<number | null>(null);
  const conta = Boolean(empresa) && pode('campanhas.ver') && pode('acoes.aprovar');

  const buscar = useCallback(async () => {
    if (!conta) return setTotal(null);
    const r = await chamar(() => api.GET('/v1/actions', { params: { query: { status: 'aguardando_aprovacao' } } }));
    // Sem resposta, o menu só fica sem o número: a tela de Aprovações mostra o erro com nova tentativa.
    if (r.ok) setTotal(r.data.items.length);
  }, [conta]);

  // O shell fica montado na navegação: a troca de tela também lê de novo (e recomeça a contagem do intervalo).
  useEffect(() => {
    disparar(buscar());
    if (!conta) return;
    const t = setInterval(() => disparar(buscar()), ATUALIZAR_MS);
    return () => clearInterval(t);
  }, [buscar, conta, caminho]);

  const definir = useCallback((n: number) => setTotal((atual) => (conta ? n : atual)), [conta]);
  const valor = useMemo<Contador>(() => ({ total, definir, recarregar: () => disparar(buscar()) }), [total, definir, buscar]);
  return <ContadorContexto.Provider value={valor}>{children}</ContadorContexto.Provider>;
}
