'use client';

import type { BrandResponse } from '@liame/contracts';
import { usePathname } from 'next/navigation';
import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { marcasAtivas, planosDasMarcas } from '@/components/aprovacoes/buscar-planos';
import { api, chamar } from './api';
import { disparar } from './disparar';
import { useSessao } from './sessao';

// Número de pedidos esperando decisão, ao lado de "Aprovações" no menu: as ações que esperam aprovação (para quem
// aprova ações) e os planos do Estrategista (para quem decide planos). É a fila de quem decide. Busca ao entrar, a
// cada troca de tela e de tempos em tempos; a tela de Aprovações atualiza com o que acabou de ler.

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
  const contaAcoes = Boolean(empresa) && pode('campanhas.ver') && pode('acoes.aprovar');
  const contaPlanos = Boolean(empresa) && pode('planos.decidir') && pode('vendas.ver') && pode('marcas.ver');
  const conta = contaAcoes || contaPlanos;
  /** As marcas mudam pouco: lidas uma vez por empresa (trocar de empresa remonta o provedor). */
  const marcas = useRef<BrandResponse[] | null>(null);

  const buscar = useCallback(async () => {
    if (!conta) return setTotal(null);
    const acoes = async (): Promise<number | null> => {
      if (!contaAcoes) return 0;
      const r = await chamar(() => api.GET('/v1/actions', { params: { query: { status: 'aguardando_aprovacao' } } }));
      return r.ok ? r.data.items.length : null;
    };
    const planos = async (): Promise<number | null> => {
      if (!contaPlanos) return 0;
      if (!marcas.current) {
        const m = await marcasAtivas();
        if (!m.ok) return null;
        marcas.current = m.data;
      }
      const r = await planosDasMarcas(marcas.current, 'pendente');
      return r.ok ? r.data.length : null;
    };
    const [a, p] = await Promise.all([acoes(), planos()]);
    // Sem resposta, o menu só fica sem atualizar o número: a tela de Aprovações mostra o erro com nova tentativa.
    if (a !== null && p !== null) setTotal(a + p);
  }, [conta, contaAcoes, contaPlanos]);

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
