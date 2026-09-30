'use client';

import { createContext, type ReactNode, useCallback, useContext, useMemo, useState } from 'react';

// Modos de exibição Lite e Pro (D8; ux-modelo-interface §4.1): Lite = visão do dono, com o resto a um
// "Ver detalhes"; Pro = todos os números e tabelas. É preferência de exibição, não permissão (quem pode
// ver o quê é o servidor). Fica neste navegador (como o tema): conveniência, nunca dado de negócio.

export type Modo = 'lite' | 'pro';

export const CHAVE_MODO = 'liame:modo';

type ModoDaTela = {
  modo: Modo;
  /** Muda a cada troca de modo: o "Ver detalhes" aberto no Lite fecha (como no protótipo). */
  versao: number;
  definir: (m: Modo) => void;
};

const ModoContexto = createContext<ModoDaTela>({ modo: 'lite', versao: 0, definir: () => {} });

export function useModo(): ModoDaTela {
  return useContext(ModoContexto);
}

function modoGuardado(): Modo {
  try {
    return localStorage.getItem(CHAVE_MODO) === 'pro' ? 'pro' : 'lite';
  } catch {
    return 'lite';
  }
}

export function ModoProvider({ children, inicial }: { children: ReactNode; /** Só para teste: o modo de partida. */ inicial?: Modo }) {
  // O shell só aparece no navegador (depois da sessão), então o valor guardado já vale na primeira pintura.
  const [estado, setEstado] = useState<{ modo: Modo; versao: number }>(() => ({
    modo: inicial ?? (typeof window === 'undefined' ? 'lite' : modoGuardado()),
    versao: 0,
  }));

  const definir = useCallback((m: Modo) => {
    setEstado((e) => (e.modo === m ? e : { modo: m, versao: e.versao + 1 }));
    try {
      localStorage.setItem(CHAVE_MODO, m);
    } catch {
      // Navegador sem armazenamento: o modo vale só nesta visita.
    }
  }, []);

  const valor = useMemo(() => ({ ...estado, definir }), [estado, definir]);
  return <ModoContexto.Provider value={valor}>{children}</ModoContexto.Provider>;
}

/**
 * "Ver detalhes" de um cartão: no Lite abre o Pro ali mesmo (nada some no Lite); no Pro já está tudo
 * aberto. Trocar de modo fecha o que estava aberto.
 */
export function useDetalhes() {
  const { modo, versao } = useModo();
  const [abertoNa, setAbertoNa] = useState<number | null>(null);
  const aberto = abertoNa === versao;
  const pro = modo === 'pro';
  const alternar = useCallback(() => setAbertoNa(aberto ? null : versao), [aberto, versao]);
  return { pro, aberto, mostraPro: pro || aberto, alternar };
}
